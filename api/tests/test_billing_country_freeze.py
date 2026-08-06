"""Wave 1.1 (P0-2): billing_country is a tax fact — frozen under a live mandate.

``supply_kind`` classifies every invoice from ``Client.billing_country``, and the
customer could rewrite it at will via ``PUT /billing-details``: clear the GSTIN,
set ``US``, and every subsequent INR-settled renewal becomes a zero-rated LUT
export — self-declared GST leakage on a live domestic mandate.

Three defenses, tested here:

1. **Freeze**: while any subscription in the active set carries a Razorpay
   mandate, a ``billing_country`` change that would alter the tax
   classification 409s (``billing_country_locked``). Rail change = churn event;
   genuine relocations go through the audited superadmin override.
2. **Superadmin override**: writes the new country and an ``audit_logs`` row.
3. **Invoice-side backstop**: ``finalize_invoice`` refuses to classify an
   INR-settled charge as an export unless the account has ever been charged in
   a foreign currency — the refused row stays unnumbered and surfaces in
   reconciliation instead of being filed as a zero-rated supply.

Plus the bidirectional geo signal: a foreign billing claim from an IN-detected
request is now flagged and persisted, not just the IN-claim/foreign-IP case.
"""

import os
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config
from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.db.models import AuditLog, Client, Invoice, Plan, Subscription
from app.services import invoice_service
from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _mk(db, monkeypatch, **client_kw):
    defaults = {
        "name": "Acme",
        "email": "country-freeze@test.example",
        "api_key": "key-country-freeze",
        "legal_name": "Acme Pvt Ltd",
    }
    defaults.update(client_kw)
    client = Client(**defaults)
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    # CI has no Razorpay keys (local .env does): pin the provider gate ON so
    # these tests exercise the billing logic, not the deploy environment.
    monkeypatch.setattr(subscription_routes, "RAZORPAY_ENABLED", True)
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: None)
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.include_router(subscription_routes.credits_router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app), client


def _plan(db) -> Plan:
    plan = Plan(
        name="Standard",
        slug="std-country-freeze",
        monthly_price_cents=94900,
        annual_price_cents=910800,
        credits_per_month=10_000,
        included_operator_seats=2,
        is_active=True,
        # Wave 4b gates top-ups on the plan flag; these tests are about the
        # COUNTRY freeze, so the fixture plan allows top-ups.
        features={"topup_allowed": True},
    )
    db.add(plan)
    db.flush()
    return plan


def _mandated_sub(db, client, plan, *, status="active", rzp_id="sub_freeze_live") -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status=status,
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id=rzp_id,
    )
    db.add(sub)
    db.flush()
    return sub


# ── 1. The freeze ────────────────────────────────────────────────────────────


def test_country_change_locked_under_live_mandate(db, monkeypatch):
    api, client = _mk(db, monkeypatch, billing_country="IN")
    _mandated_sub(db, client, _plan(db))

    res = api.put("/subscriptions/billing-details", json={"billing_country": "US"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "billing_country_locked"
    db.refresh(client)
    assert client.billing_country == "IN"


def test_first_time_set_to_foreign_locked_under_live_mandate(db, monkeypatch):
    # NULL country classifies as domestic; setting US under a live INR mandate
    # is the same export flip as IN→US and must be equally locked.
    api, client = _mk(db, monkeypatch, billing_country=None)
    _mandated_sub(db, client, _plan(db))

    res = api.put("/subscriptions/billing-details", json={"billing_country": "US"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "billing_country_locked"


def test_noop_and_null_to_in_writes_allowed_under_mandate(db, monkeypatch):
    # Writing the same classification is not a change: IN→IN and NULL→IN keep
    # the supply domestic, so the customer can still complete their billing
    # details after subscribing.
    api, client = _mk(db, monkeypatch, billing_country=None)
    _mandated_sub(db, client, _plan(db))

    res = api.put("/subscriptions/billing-details", json={"billing_country": "IN"})
    assert res.status_code == 200, res.text
    db.refresh(client)
    assert client.billing_country == "IN"

    res = api.put("/subscriptions/billing-details", json={"billing_country": "IN"})
    assert res.status_code == 200, res.text


def test_country_change_allowed_without_gateway_mandate(db, monkeypatch):
    # Manual/comped rows carry no mandate; a canceled Razorpay row is not in
    # the active set. Neither locks the field.
    api, client = _mk(db, monkeypatch, billing_country="IN")
    plan = _plan(db)
    manual = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="manual",
        razorpay_subscription_id=None,
    )
    canceled = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="canceled",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_freeze_dead",
        canceled_at=datetime.now(UTC),
    )
    db.add_all([manual, canceled])
    db.flush()

    res = api.put("/subscriptions/billing-details", json={"billing_country": "US"})
    assert res.status_code == 200, res.text
    db.refresh(client)
    assert client.billing_country == "US"


def test_gstin_clear_and_flip_in_one_request_locked(db, monkeypatch):
    # The exact P0-2 attack: clear the GSTIN (the only pin) and set US in a
    # single request while the INR mandate is live.
    api, client = _mk(db, monkeypatch, billing_country="IN", gstin="27AAPFU0939F1ZV", billing_state_code="27")
    _mandated_sub(db, client, _plan(db))

    res = api.put("/subscriptions/billing-details", json={"gstin": None, "billing_country": "US"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "billing_country_locked"
    db.refresh(client)
    assert client.billing_country == "IN"
    assert client.gstin == "27AAPFU0939F1ZV"  # nothing about the request applied


def test_past_due_mandate_still_locks(db, monkeypatch):
    # Dunning does not unfreeze tax facts — the mandate is still live at the
    # gateway and can still charge.
    api, client = _mk(db, monkeypatch, billing_country="IN")
    _mandated_sub(db, client, _plan(db), status="past_due")

    res = api.put("/subscriptions/billing-details", json={"billing_country": "AE"})
    assert res.status_code == 409, res.text


# ── 2. Superadmin override ───────────────────────────────────────────────────


def test_superadmin_override_writes_country_and_audits(db, monkeypatch):
    from app.api import superadmin_routes_v2
    from app.api.auth import get_superadmin

    customer = Client(
        name="Reloc",
        email="relocated@test.example",
        api_key="key-relocated",
        billing_country="IN",
    )
    admin = Client(
        name="Admin",
        email="admin-freeze@test.example",
        api_key="key-admin-freeze",
        is_superadmin=True,
    )
    db.add_all([customer, admin])
    db.flush()
    _mandated_sub(db, customer, _plan(db))

    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    api = TestClient(app)

    res = api.post(
        f"/superadmin/clients/{customer.id}/billing-country",
        json={"country": "US", "reason": "Customer relocated to the US; mandate re-point scheduled"},
    )
    assert res.status_code == 200, res.text
    db.refresh(customer)
    assert customer.billing_country == "US"

    audit = (
        db.query(AuditLog)
        .filter(AuditLog.action == "client.billing_country.override")
        .order_by(AuditLog.id.desc())
        .first()
    )
    assert audit is not None
    assert str(audit.target_id) == str(customer.id)


def test_superadmin_override_requires_reason(db, monkeypatch):
    from app.api import superadmin_routes_v2
    from app.api.auth import get_superadmin

    customer = Client(name="R2", email="r2@test.example", api_key="key-r2", billing_country="IN")
    admin = Client(name="A2", email="a2@test.example", api_key="key-a2", is_superadmin=True)
    db.add_all([customer, admin])
    db.flush()

    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    api = TestClient(app)

    res = api.post(f"/superadmin/clients/{customer.id}/billing-country", json={"country": "US", "reason": ""})
    assert res.status_code == 422


# ── 3. Bidirectional geo signal ──────────────────────────────────────────────


def test_geo_mismatch_detail_is_bidirectional():
    from app.api.subscription_routes import _geo_mismatch_detail

    # Existing direction: domestic claim, specific foreign detection.
    assert _geo_mismatch_detail("IN", "US") is not None
    # New direction: foreign claim (zero-rated export) from an IN-detected
    # request — the P0-2 leakage signal.
    assert _geo_mismatch_detail("US", "IN") is not None
    # Agreement and unknown detection are not suspicious.
    assert _geo_mismatch_detail("IN", "IN") is None
    assert _geo_mismatch_detail("US", "US") is None
    assert _geo_mismatch_detail("IN", None) is None
    assert _geo_mismatch_detail("US", None) is None
    # Foreign↔different-foreign is a curiosity, not a tax signal.
    assert _geo_mismatch_detail("US", "GB") is None


def test_geo_mismatch_persisted_on_billing_details_flip(db, monkeypatch):
    # A foreign country accepted at /billing-details (no mandate → allowed)
    # while the request geo-resolves to IN stamps the persistent flag.
    api, client = _mk(db, monkeypatch, billing_country="IN")
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda _req: "IN")

    res = api.put("/subscriptions/billing-details", json={"billing_country": "US"})
    assert res.status_code == 200, res.text
    db.refresh(client)
    assert client.geo_mismatch_at is not None
    assert "US" in (client.geo_mismatch_detail or "")


# ── 4. Invoice-side export backstop ──────────────────────────────────────────


@pytest.fixture
def invoicing_on(monkeypatch):
    monkeypatch.setattr(config, "INVOICING_V2_ENABLED", True)


def _seller(db):
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)


def test_inr_export_refused_without_foreign_charge_history(db, invoicing_on):
    _seller(db)
    buyer = Client(
        name="FlipCo",
        email="flip@test.example",
        api_key="key-flip",
        billing_country="US",  # claims export…
    )
    db.add(buyer)
    db.flush()
    inv = Invoice(
        client_id=buyer.id,
        amount_cents=94900,
        currency="inr",  # …but has only ever been charged rupees
        status="paid",
        paid_at=datetime(2026, 8, 1, tzinfo=UTC),
    )
    db.add(inv)
    db.flush()

    assert invoice_service.finalize_invoice(db, inv) is False
    assert inv.invoice_number is None  # unnumbered → reconciliation surfaces it


def test_inr_export_allowed_with_foreign_charge_history(db, invoicing_on):
    _seller(db)
    buyer = Client(
        name="GenuineIntl",
        email="genuine@test.example",
        api_key="key-genuine",
        billing_country="US",
    )
    db.add(buyer)
    db.flush()
    # A real USD charge on record — this account genuinely bills foreign.
    prior = Invoice(
        client_id=buyer.id,
        amount_cents=1900,
        currency="usd",
        status="paid",
        paid_at=datetime(2026, 7, 1, tzinfo=UTC),
        inr_amount_minor=160000,
    )
    inr_inv = Invoice(
        client_id=buyer.id,
        amount_cents=94900,
        currency="inr",
        status="paid",
        paid_at=datetime(2026, 8, 1, tzinfo=UTC),
    )
    db.add_all([prior, inr_inv])
    db.flush()

    assert invoice_service.finalize_invoice(db, inr_inv) is True
    assert inr_inv.invoice_number is not None


def test_domestic_inr_invoice_unaffected(db, invoicing_on):
    _seller(db)
    buyer = Client(
        name="DomesticCo",
        email="domestic@test.example",
        api_key="key-domestic",
        billing_country="IN",
        billing_state_code="27",
    )
    db.add(buyer)
    db.flush()
    inv = Invoice(
        client_id=buyer.id,
        amount_cents=94900,
        currency="inr",
        status="paid",
        paid_at=datetime(2026, 8, 1, tzinfo=UTC),
    )
    db.add(inv)
    db.flush()

    assert invoice_service.finalize_invoice(db, inv) is True


def test_bot_scoped_mandate_locks_the_freeze(db, monkeypatch):
    # The freeze deliberately has NO bot_id filter: a client whose only live
    # mandate is per-bot must not be able to flip the account's tax country.
    from app.db.models import Bot

    api, client = _mk(db, monkeypatch, billing_country="IN")
    plan = _plan(db)
    bot = Bot(client_id=client.id, name="B", bot_key="bot-freeze-scope")
    db.add(bot)
    db.flush()
    sub = _mandated_sub(db, client, plan, rzp_id="sub_freeze_bot")
    sub.bot_id = bot.id
    db.flush()

    res = api.put("/subscriptions/billing-details", json={"billing_country": "US"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "billing_country_locked"


def test_checkout_country_persist_honours_the_freeze(db, monkeypatch):
    # Review finding: the checkout persist write bypassed the freeze for
    # per-bot-mandate holders (the already-subscribed guard is account-scoped,
    # the freeze is not). /checkout {billing_country} must 409 the same way
    # PUT does — and mint nothing.
    from unittest.mock import patch

    from app.db.models import Bot

    api, client = _mk(
        db,
        monkeypatch,
        billing_country="IN",
        billing_address={"line1": "1 Lane", "city": "Mumbai", "postal_code": "400001"},
        billing_state_code="27",
    )
    monkeypatch.setattr(subscription_routes, "INTL_PAYMENTS_ENABLED", True)
    plan = _plan(db)
    bot = Bot(client_id=client.id, name="B", bot_key="bot-freeze-checkout")
    db.add(bot)
    db.flush()
    sub = _mandated_sub(db, client, plan, rzp_id="sub_freeze_perbot")
    sub.bot_id = bot.id
    db.flush()

    with patch("app.services.razorpay_service.create_subscription") as mint:
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
        )
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "billing_country_locked"
    assert not mint.called
    db.refresh(client)
    assert client.billing_country == "IN"


def test_topup_country_persist_honours_the_freeze(db, monkeypatch):
    # Reverse direction: a stored-US client with a live mandate must not flip
    # US→IN through the top-up side door.
    api, client = _mk(
        db,
        monkeypatch,
        billing_country="US",
        billing_address={"line1": "1 Infinite Loop", "city": "Cupertino", "postal_code": "95014"},
    )
    _mandated_sub(db, client, _plan(db), rzp_id="sub_freeze_topup")

    res = api.post("/credits/topup", json={"amount": 500, "billing_country": "IN"})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["reason"] == "billing_country_locked"
    db.refresh(client)
    assert client.billing_country == "US"


def test_superadmin_override_readonly_role_gets_403(db, monkeypatch):
    from app.api import superadmin_routes_v2
    from app.api.auth import get_superadmin

    customer = Client(name="R3", email="r3@test.example", api_key="key-r3", billing_country="IN")
    readonly = Client(
        name="RO",
        email="ro@test.example",
        api_key="key-ro",
        is_superadmin=True,
        superadmin_role="readonly",
    )
    db.add_all([customer, readonly])
    db.flush()

    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: readonly
    api = TestClient(app)

    res = api.post(
        f"/superadmin/clients/{customer.id}/billing-country",
        json={"country": "US", "reason": "attempted by readonly"},
    )
    assert res.status_code == 403, res.text
    db.refresh(customer)
    assert customer.billing_country == "IN"


def test_superadmin_override_refuses_foreign_country_with_gstin(db, monkeypatch):
    from app.api import superadmin_routes_v2
    from app.api.auth import get_superadmin

    customer = Client(
        name="G",
        email="g@test.example",
        api_key="key-g",
        billing_country="IN",
        gstin="27AAPFU0939F1ZV",
    )
    admin = Client(name="A3", email="a3@test.example", api_key="key-a3", is_superadmin=True)
    db.add_all([customer, admin])
    db.flush()

    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    api = TestClient(app)

    res = api.post(
        f"/superadmin/clients/{customer.id}/billing-country",
        json={"country": "US", "reason": "relocation with GSTIN still set"},
    )
    assert res.status_code == 422, res.text
    db.refresh(customer)
    assert customer.billing_country == "IN"
