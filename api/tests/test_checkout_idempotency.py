"""Wave 1.4: first-checkout idempotency + ReferralConversion at payment time.

Two related holes in ``POST /checkout``:

* **Re-click minted a second mandate.** ``lock_client_for_billing`` serialises
  concurrent calls, but a SEQUENTIAL re-submit (double-clicked button, two
  tabs, a re-opened modal) minted a fresh authorizable Razorpay subscription
  each time; a customer who authorised two got two live mandates. /resume and
  the upgrade path already solved this (finding H1) by recording the in-flight
  checkout and reusing it — first checkout now does the same via
  ``clients.pending_checkout_*``, verified against the gateway through
  ``rebuild_upgrade_checkout`` (gateway state, not a TTL, decides staleness).

* **ReferralConversion was recorded at checkout-create.** An abandoned
  checkout (never authorised, never charged) still accrued the affiliate a
  conversion row. The insert now happens in the ``subscription.charged``
  handler — actual money — from a snapshot carried in the subscription notes,
  with a unique-per-client constraint making webhook replays and later cycles
  no-ops.
"""

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.db.models import Affiliate, Client, Plan, ReferralCode, ReferralConversion, Subscription
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _plan(db, slug="std-idem", monthly=94900) -> Plan:
    plan = Plan(
        name="Standard",
        slug=slug,
        monthly_price_cents=monthly,
        annual_price_cents=monthly * 10,
        credits_per_month=10_000,
        included_operator_seats=2,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_m",
        razorpay_plan_id_annual=f"plan_{slug}_a",
    )
    db.add(plan)
    db.flush()
    return plan


def _mk(db, monkeypatch, **client_kw):
    defaults = {
        "name": "Acme",
        "email": "idem@test.example",
        "api_key": "key-idem",
        "legal_name": "Acme Pvt Ltd",
        "billing_address": {"line1": "1 Lane", "city": "Mumbai", "postal_code": "400001"},
        "billing_state_code": "27",
        "billing_country": "IN",
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
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    return TestClient(app, raise_server_exceptions=True), client


def _mint_payload(sub_id="sub_idem_1"):
    return {"subscription_id": sub_id, "key_id": "rzp_test", "provider": "razorpay"}


@pytest.fixture(autouse=True)
def _pending_mandate_is_unpaid():
    """Default every test here to an UNPAID in-flight mandate — the reuse path
    now asks the gateway ``checkout_already_paid`` first, and the PAID case is
    covered in test_change_plan_checkout_idempotency."""
    with patch.object(rzp, "checkout_already_paid", return_value=False):
        yield


# ── Sequential re-checkout reuses the in-flight subscription ─────────────────


def test_double_checkout_reuses_pending_subscription(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db)
    body = {"plan_id": plan.id, "billing_cycle": "monthly"}

    with (
        patch("app.services.razorpay_service.create_subscription", return_value=_mint_payload()) as mint,
        patch("app.services.razorpay_service.rebuild_upgrade_checkout", return_value=_mint_payload()) as rebuild,
    ):
        first = api.post("/subscriptions/checkout", json=body)
        second = api.post("/subscriptions/checkout", json=body)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["subscription_id"] == first.json()["subscription_id"]
    assert mint.call_count == 1  # the whole point: one authorizable mandate
    assert rebuild.called
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_idem_1"
    assert client.pending_checkout_plan_id == plan.id


def test_checkout_for_a_different_plan_mints_fresh(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan_a = _plan(db, slug="std-idem-a")
    plan_b = _plan(db, slug="std-idem-b")

    with (
        patch(
            "app.services.razorpay_service.create_subscription",
            side_effect=[_mint_payload("sub_idem_a"), _mint_payload("sub_idem_b")],
        ) as mint,
        patch("app.services.razorpay_service.cancel_superseded_checkout", return_value="created") as cancel,
    ):
        first = api.post("/subscriptions/checkout", json={"plan_id": plan_a.id, "billing_cycle": "monthly"})
        second = api.post("/subscriptions/checkout", json={"plan_id": plan_b.id, "billing_cycle": "monthly"})

    assert first.status_code == 200 and second.status_code == 200
    assert mint.call_count == 2
    # The superseded mandate is left authorizable at Razorpay unless it is
    # explicitly killed — a customer could authorise the abandoned plan-A
    # checkout later and be billed for a plan they walked away from.
    cancel.assert_called_once_with("sub_idem_a")
    db.refresh(client)
    # The marker follows the LATEST in-flight checkout.
    assert client.pending_checkout_subscription_id == "sub_idem_b"
    assert client.pending_checkout_plan_id == plan_b.id


def test_dead_pending_checkout_is_replaced(db, monkeypatch):
    # The pending sub is no longer authorizable at the gateway → rebuild
    # returns None → re-mint and replace the marker (never strand the customer
    # on a dead checkout).
    api, client = _mk(db, monkeypatch)
    plan = _plan(db)
    client.pending_checkout_subscription_id = "sub_idem_dead"
    client.pending_checkout_plan_id = plan.id
    client.pending_checkout_cycle = "monthly"
    client.pending_checkout_at = datetime.now(UTC) - timedelta(hours=2)
    db.flush()

    with (
        patch("app.services.razorpay_service.create_subscription", return_value=_mint_payload("sub_idem_new")) as mint,
        patch("app.services.razorpay_service.rebuild_upgrade_checkout", return_value=None),
        patch("app.services.razorpay_service.cancel_superseded_checkout", return_value="expired") as cancel,
    ):
        res = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})

    assert res.status_code == 200, res.text
    assert res.json()["subscription_id"] == "sub_idem_new"
    assert mint.call_count == 1
    # "Not reusable" and "dead" are different facts — only the second makes a
    # fresh mint safe, so the gateway status is checked before minting.
    cancel.assert_called_once_with("sub_idem_dead")
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_idem_new"


def test_activation_clears_the_pending_marker(db, monkeypatch):
    client = Client(
        name="A",
        email="idem-act@test.example",
        api_key="key-idem-act",
        pending_checkout_subscription_id="sub_idem_act",
        pending_checkout_plan_id=1,
        pending_checkout_cycle="monthly",
        pending_checkout_at=datetime.now(UTC),
    )
    db.add(client)
    plan = _plan(db, slug="std-idem-act")
    db.flush()

    now = datetime.now(UTC)
    payload = {
        "subscription": {
            "entity": {
                "id": "sub_idem_act",
                "notes": {
                    "oyechats_client_id": str(client.id),
                    "oyechats_plan_id": str(plan.id),
                    "billing_cycle": "monthly",
                },
                "current_start": int(now.timestamp()),
                "current_end": int((now + timedelta(days=30)).timestamp()),
                "quantity": 1,
            }
        }
    }
    rzp._handle_subscription_activated(db, payload)
    db.flush()
    db.refresh(client)
    assert client.pending_checkout_subscription_id is None
    assert client.pending_checkout_plan_id is None


# ── ReferralConversion at payment time ───────────────────────────────────────


def _attributed_client(db, monkeypatch, **kw):
    owner = Client(name="AffOwner", email="aff-idem@test.example", api_key="key-aff-idem")
    db.add(owner)
    db.flush()
    affiliate = Affiliate(client_id=owner.id, commission_bps=1500)
    db.add(affiliate)
    db.flush()
    code = ReferralCode(
        code="IDEM15",
        affiliate_id=affiliate.id,
        affiliate_commission_bps=1500,
        customer_discount_bps=0,
        active=True,
    )
    db.add(code)
    db.flush()
    api, client = _mk(db, monkeypatch, referral_code_id=code.id, **kw)
    return api, client, code, affiliate


def test_abandoned_checkout_creates_no_conversion_row(db, monkeypatch):
    api, client, _code, _aff = _attributed_client(db, monkeypatch)
    plan = _plan(db)
    with patch("app.services.razorpay_service.create_subscription", return_value=_mint_payload()) as mint:
        res = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 200, res.text
    assert mint.called
    # Checkout minted, customer never paid: NO conversion.
    assert db.query(ReferralConversion).filter_by(client_id=client.id).count() == 0


def test_charged_webhook_records_conversion_once(db, monkeypatch):
    _api, client, code, affiliate = _attributed_client(db, monkeypatch)
    plan = _plan(db, slug="std-idem-conv")
    now = datetime.now(UTC)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_idem_conv",
        current_period_start=now - timedelta(days=30),
        current_period_end=now,
        last_granted_period_end=now,
    )
    db.add(sub)
    db.flush()

    charged = {
        "subscription": {
            "entity": {
                "id": "sub_idem_conv",
                "notes": {
                    "oyechats_client_id": str(client.id),
                    "oyechats_plan_id": str(plan.id),
                    # The snapshot the checkout now parks in the notes.
                    "oyechats_ref_code_id": str(code.id),
                    "oyechats_ref_affiliate_id": str(affiliate.id),
                    "oyechats_ref_commission_bps": "1500",
                    "oyechats_ref_discount_bps": "0",
                },
                "current_start": int(now.timestamp()),
                "current_end": int((now + timedelta(days=30)).timestamp()),
                "quantity": 1,
            }
        },
        "payment": {"entity": {"id": "pay_idem_conv", "amount": 94900, "currency": "INR"}},
    }
    with patch.object(rzp, "_ensure_subscription_charge_invoice", return_value=None):
        rzp._handle_subscription_charged(db, charged)
        db.flush()
        rows = db.query(ReferralConversion).filter_by(client_id=client.id).all()
        assert len(rows) == 1
        assert rows[0].referral_code_id == code.id
        assert rows[0].affiliate_id == affiliate.id
        assert rows[0].commission_bps == 1500

        # Replay / next cycle: the unique-per-client constraint makes it a no-op.
        charged["payment"]["entity"]["id"] = "pay_idem_conv_2"
        rzp._handle_subscription_charged(db, charged)
        db.flush()
        assert db.query(ReferralConversion).filter_by(client_id=client.id).count() == 1


def test_checkout_parks_referral_snapshot_in_notes(db, monkeypatch):
    api, _client, code, affiliate = _attributed_client(db, monkeypatch)
    plan = _plan(db, slug="std-idem-notes")
    with patch("app.services.razorpay_service.create_subscription", return_value=_mint_payload()) as mint:
        res = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 200, res.text
    notes = mint.call_args.kwargs.get("extra_notes") or {}
    assert notes.get("oyechats_ref_code_id") == str(code.id)
    assert notes.get("oyechats_ref_affiliate_id") == str(affiliate.id)
    assert notes.get("oyechats_ref_commission_bps") == "1500"


def test_checkout_different_cycle_mints_fresh(db, monkeypatch):
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-idem-cycle")
    with (
        patch(
            "app.services.razorpay_service.create_subscription",
            side_effect=[_mint_payload("sub_idem_m"), _mint_payload("sub_idem_a")],
        ) as mint,
        patch("app.services.razorpay_service.cancel_superseded_checkout", return_value="created") as cancel,
    ):
        first = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})
        second = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "annual"})
    assert first.status_code == 200 and second.status_code == 200
    assert mint.call_count == 2
    cancel.assert_called_once_with("sub_idem_m")
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_idem_a"


def test_checkout_country_change_never_reuses_wrong_rail(db, monkeypatch):
    # Click 1 confirms IN (INR pending). Click 2 confirms US (no live mandate,
    # so the change is legitimate). Reusing the INR checkout would hand a
    # stored-US account an INR mandate — the divergence Wave 1.2 kills — so
    # the country is part of the reuse key and a fresh USD mint happens.
    monkeypatch.setattr(subscription_routes, "INTL_PAYMENTS_ENABLED", True)
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-idem-country")
    with (
        patch(
            "app.services.razorpay_service.create_subscription",
            side_effect=[_mint_payload("sub_idem_inr"), _mint_payload("sub_idem_usd")],
        ) as mint,
        patch("app.services.razorpay_service.cancel_superseded_checkout", return_value="created") as cancel,
    ):
        first = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "IN"},
        )
        second = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "US"},
        )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert mint.call_count == 2
    cancel.assert_called_once_with("sub_idem_inr")
    db.refresh(client)
    assert client.pending_checkout_country == "US"
    assert client.pending_checkout_subscription_id == "sub_idem_usd"


def test_rebuild_failure_is_a_502_not_a_sibling_mint(db, monkeypatch):
    # A gateway fetch failure is not evidence the pending sub is dead. Never
    # guess: 502 and let the customer retry, instead of minting a sibling
    # mandate against a possibly-live authorizable one.
    api, client = _mk(db, monkeypatch)
    plan = _plan(db, slug="std-idem-502")
    client.pending_checkout_subscription_id = "sub_idem_flaky"
    client.pending_checkout_plan_id = plan.id
    client.pending_checkout_cycle = "monthly"
    client.pending_checkout_country = "IN"
    db.flush()
    with (
        patch("app.services.razorpay_service.create_subscription") as mint,
        patch(
            "app.services.razorpay_service.rebuild_upgrade_checkout",
            side_effect=rzp.RazorpayBillingError("gateway timeout"),
        ),
    ):
        res = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})
    assert res.status_code == 502, res.text
    assert not mint.called
    db.refresh(client)
    assert client.pending_checkout_subscription_id == "sub_idem_flaky"  # marker intact


def test_dangling_referral_snapshot_never_fails_the_payment_handler(db):
    # Affiliates/codes are hard-deletable; the ids frozen in gateway notes can
    # dangle. The insert must be savepoint-guarded — an FK error here would
    # dead-letter the whole subscription.charged event on every retry.
    client = Client(name="D", email="idem-dangle@test.example", api_key="key-idem-dangle")
    db.add(client)
    db.flush()
    rzp._record_referral_conversion_from_notes(
        db,
        client.id,
        {
            "oyechats_ref_code_id": "999999",
            "oyechats_ref_affiliate_id": "999999",
            "oyechats_ref_commission_bps": "1500",
            "oyechats_ref_discount_bps": "0",
        },
    )
    # The surrounding transaction must still be usable (savepoint rolled back,
    # not the session) and nothing was inserted.
    assert db.query(ReferralConversion).filter_by(client_id=client.id).count() == 0
    assert db.query(Client).filter_by(id=client.id).one() is not None
