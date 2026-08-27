"""A paid tier with no Razorpay plan id stays LISTED and degrades to contact-sales.

The policy this file pins, and why it is not the obvious one: "this environment
cannot charge for the tier" and "this tier must not be shown" are different
statements. Conflating them. Deriving ``plans.is_active`` from the gateway
wiring. Deletes the agency tier from ``GET /public/pricing-catalog``, the feed
oyechats.com/pricing renders, because a contact-sales tier needs no gateway plan
id to be *listed*. It also makes the graceful path unreachable: an inactive plan
is rejected by ``/checkout/quote`` and ``/checkout`` before either can answer
``inr_plan_unconfigured``.

So the wiring predicate (``plan_service.plan_checkout_is_wired``) is REPORTING
only, and the three surfaces it feeds must agree:

* the catalogue still lists the tier;
* the quote answers ``checkout_supported: false`` + ``inr_plan_unconfigured``
  + a contact-sales address;
* the charge path refuses in that same shape (``PlanNotCheckoutable`` → 409),
  rather than 400ing with the raw operator instruction it used to leak.

Route-level tests need Postgres (``DB_URL``) and are skipped without it; the
predicate, seed and gateway-wiring script tests are pure and always run.
"""

from __future__ import annotations

import contextlib
import os
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_plan_routes
from app.core.middleware import plan_not_checkoutable_handler
from app.db.models import Client, Plan
from app.services.plan_service import plan_checkout_is_wired
from app.services.razorpay_service import PlanNotCheckoutable
from scripts import seed_plans, set_razorpay_plan_ids

# ── The predicate itself ─────────────────────────────────────────────────────


def test_a_free_tier_is_wired_with_no_gateway_ids_at_all():
    """Nothing to charge, so nothing can be missing. Guards the seed's Free row,
    which carries no Razorpay plan id in any environment and must never be
    reported as a wiring gap."""
    assert plan_checkout_is_wired(is_free=True, razorpay_plan_id_monthly=None, razorpay_plan_id_annual=None) is True


def test_a_paid_tier_needs_both_inr_ids():
    assert (
        plan_checkout_is_wired(is_free=False, razorpay_plan_id_monthly="plan_m", razorpay_plan_id_annual="plan_a")
        is True
    )


@pytest.mark.parametrize(
    ("monthly", "annual", "label"),
    [
        ("plan_m", None, "monthly-only"),
        (None, "plan_a", "annual-only"),
        (None, None, "neither"),
    ],
)
def test_a_paid_tier_with_a_half_wired_rail_is_not_self_serve(monthly, annual, label):
    """Both cycles or none. The asymmetry matters: ``create_subscription`` picks
    the id for the cycle the buyer chose, so a monthly-only tier completes a
    monthly checkout and refuses the annual one. Reporting it as wired would
    describe a tier that is buyable on one toggle and dead on the other."""
    assert (
        plan_checkout_is_wired(is_free=False, razorpay_plan_id_monthly=monthly, razorpay_plan_id_annual=annual) is False
    ), label


def test_an_empty_string_id_is_not_an_id():
    """Razorpay ids are non-empty strings; a blank column is an unset column.
    ``bool("")`` is what makes this hold. Pinned so a future ``is not None``
    rewrite cannot quietly call a blank row wired."""
    assert plan_checkout_is_wired(is_free=False, razorpay_plan_id_monthly="", razorpay_plan_id_annual="plan_a") is False


# ── seed_plans.py: reports wiring, never writes is_active on an update ───────


def _seed_entry(slug: str, *, monthly: int, annual: int) -> dict:
    return {"slug": slug, "monthly_price_cents": monthly, "annual_price_cents": annual}


class _FakePlanRow:
    """Enough of a ``Plan`` for the seed's read path."""

    def __init__(self, **columns):
        self.__dict__.update(columns)


def test_a_brand_new_paid_row_is_reported_unwired():
    """The seed never writes gateway ids, so a row it creates cannot have any."""
    assert seed_plans._would_be_wired(_seed_entry("starter", monthly=59_900, annual=574_800), None) is False


def test_an_existing_row_is_read_for_its_ids():
    existing = _FakePlanRow(razorpay_plan_id_monthly="plan_m", razorpay_plan_id_annual="plan_a")
    assert seed_plans._would_be_wired(_seed_entry("starter", monthly=59_900, annual=574_800), existing) is True


def test_a_free_entry_is_wired_even_on_a_fresh_database():
    assert seed_plans._would_be_wired(_seed_entry("free", monthly=0, annual=0), None) is True


class _RecordingSession:
    """A session that yields ``rows`` and records what the seed adds/commits."""

    def __init__(self, rows: list[_FakePlanRow]):
        self._rows = rows
        self.added: list[object] = []
        self.committed = False

    def get(self, _model, _key):
        # No stored seller profile row → ``get_seller_profile`` uses its
        # defaults. The seed and the plan editor both read the GST rate now,
        # because the RBI e-mandate ceiling applies to the DEBITED amount
        # rather than to the stored base.
        return None

    def scalars(self, _stmt):
        rows = self._rows

        class _Result:
            def all(self):
                return rows

        return _Result()

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.committed = True


def _run_seed(monkeypatch, session: _RecordingSession, *, apply: bool) -> None:
    @contextlib.contextmanager
    def _fake_get_session():
        yield session

    monkeypatch.setattr(seed_plans, "get_session", _fake_get_session)
    assert seed_plans.run(apply=apply) == 0


def test_the_seed_does_not_reactivate_a_deliberately_deactivated_tier(monkeypatch, capsys):
    """The bug this replaces, in the opposite direction.

    ``seed_plans`` used to force ``is_active = True`` on every row, silently
    undoing migration ``f1a2b3c4d5e6`` on every ``reset_and_seed.sh`` run. The
    fix must not become "force it to the wiring predicate instead". That
    unlists a contact-sales tier. The seed simply does not write the column on a
    row that already exists, so a deactivation from ANY source (that migration,
    super-admin soft-delete, the plan editor) survives.
    """
    existing = [
        _FakePlanRow(
            slug=data["slug"],
            is_active=False,
            currency="INR",
            razorpay_plan_id_monthly=None,
            razorpay_plan_id_annual=None,
        )
        for data in seed_plans._PLANS
    ]
    session = _RecordingSession(existing)

    _run_seed(monkeypatch, session, apply=True)

    assert session.committed
    assert session.added == [], "the seed must update in place, not insert over existing slugs"
    assert all(row.is_active is False for row in existing), "a deliberate deactivation was overwritten"


def test_the_seed_lists_the_rows_it_creates(monkeypatch):
    """A row the seed creates has no history to respect, so it is listed, even
    with no gateway ids, because an unwired paid tier sells by contact-sales
    rather than not at all. This is what puts Enterprise back on the pricing
    page after a prod reseed."""
    session = _RecordingSession([])

    _run_seed(monkeypatch, session, apply=True)

    assert len(session.added) == len(seed_plans._PLANS)
    assert all(row.is_active is True for row in session.added)


def test_the_seed_names_the_tiers_that_are_not_self_serve(monkeypatch, capsys):
    """The off-sale summary is the signal worth keeping from the old policy,
    but it must describe checkout, not listing, or it re-teaches the conflation."""
    _run_seed(monkeypatch, _RecordingSession([]), apply=False)

    out = capsys.readouterr().out
    assert "CONTACT SALES, no Razorpay plan id" in out
    assert "Not self-serve in this environment: starter, standard, professional, enterprise" in out
    assert "stays LISTED" in out
    assert "free" not in out.split("Not self-serve in this environment:")[1].split("\n")[0]


# ── set_razorpay_plan_ids.py: _wired_after's sentinel handling ───────────────


def _wireable_row(**overrides) -> _FakePlanRow:
    columns = {
        "slug": "enterprise",
        "monthly_price_cents": 599_900,
        "annual_price_cents": 5_758_800,
        "razorpay_plan_id_monthly": "plan_m",
        "razorpay_plan_id_annual": "plan_a",
        "is_active": True,
    }
    columns.update(overrides)
    return _FakePlanRow(**columns)


def test_an_absent_column_falls_back_to_what_the_row_already_carries():
    """This run only writes the columns it was given; the rest keep their
    values. Without the fallback, setting just the monthly id would read the
    annual one as unset and report the tier as still contact-sales."""
    row = _wireable_row(razorpay_plan_id_monthly=None)

    assert set_razorpay_plan_ids._wired_after(row, {"razorpay_plan_id_monthly": "plan_m"}) is True


def test_the_clear_sentinel_resolves_to_none_not_to_the_stale_value():
    """``--enterprise-monthly null`` clears the id. The sentinel has to beat the
    row's current value or clearing an id would still report self-serve."""
    row = _wireable_row()

    assert set_razorpay_plan_ids._wired_after(row, {"razorpay_plan_id_monthly": set_razorpay_plan_ids._CLEAR}) is False


def test_an_empty_update_describes_the_row_as_it_stands():
    assert set_razorpay_plan_ids._wired_after(_wireable_row(), {}) is True
    assert set_razorpay_plan_ids._wired_after(_wireable_row(razorpay_plan_id_annual=None), {}) is False


def test_a_free_row_is_wired_regardless_of_ids():
    row = _wireable_row(monthly_price_cents=0, annual_price_cents=0, razorpay_plan_id_monthly=None)

    assert set_razorpay_plan_ids._wired_after(row, {}) is True


class _IdScriptSession:
    def __init__(self, rows):
        self._rows = rows
        self.committed = False

    def get(self, _model, _key):
        # No stored seller profile row → ``get_seller_profile`` uses its
        # defaults. The seed and the plan editor both read the GST rate now,
        # because the RBI e-mandate ceiling applies to the DEBITED amount
        # rather than to the stored base.
        return None

    def scalars(self, _stmt):
        rows = self._rows

        class _Result:
            def all(self):
                return rows

        return _Result()

    def commit(self):
        self.committed = True

    def rollback(self):
        pass


def _run_id_script(monkeypatch, session, *, apply: bool, **args) -> None:
    import argparse

    @contextlib.contextmanager
    def _fake_get_session():
        yield session

    monkeypatch.setattr(set_razorpay_plan_ids, "get_session", _fake_get_session)
    namespace = argparse.Namespace()
    for slug in set_razorpay_plan_ids._SLUGS:
        for suffix in set_razorpay_plan_ids._ALL_COLUMNS:
            setattr(namespace, f"{slug}_{suffix.replace('-', '_')}", None)
    for key, value in args.items():
        setattr(namespace, key, value)
    assert set_razorpay_plan_ids.run(namespace, apply=apply) == 0


def test_attaching_an_id_prints_the_checkout_transition_and_leaves_listing_alone(monkeypatch, capsys):
    """Attaching ids opens self-serve checkout. It is NOT a listing decision, so
    the script must not touch ``is_active`` in either direction, including on a
    tier a super admin deliberately unlisted."""
    row = _wireable_row(razorpay_plan_id_monthly=None, razorpay_plan_id_annual=None, is_active=False)
    session = _IdScriptSession([row])

    _run_id_script(
        monkeypatch,
        session,
        apply=True,
        enterprise_monthly="plan_new_m",
        enterprise_annual="plan_new_a",
    )

    out = capsys.readouterr().out
    assert "contact-sales → self-serve" in out
    assert row.razorpay_plan_id_monthly == "plan_new_m"
    assert row.is_active is False, "wiring the gateway must not re-list an unlisted tier"


def test_clearing_an_id_prints_the_reverse_transition_and_still_leaves_listing_alone(monkeypatch, capsys):
    row = _wireable_row()
    session = _IdScriptSession([row])

    _run_id_script(monkeypatch, session, apply=True, enterprise_monthly="null")

    out = capsys.readouterr().out
    assert "self-serve → contact-sales" in out
    assert row.razorpay_plan_id_monthly is None
    assert row.is_active is True, "clearing an id must not unlist the tier"


# ── The super-admin route warns, and does not block ──────────────────────────


def test_creating_a_listed_paid_plan_with_no_ids_warns():
    """``CreatePlanRequest.is_active`` defaults True and every ``razorpay_plan_id_*``
    defaults None, so the single most likely create publishes a tier nobody can
    buy. Under the listing policy that is survivable, not fatal, so it warns."""
    plan = Plan(
        name="Agency",
        slug="agency",
        currency="INR",
        monthly_price_cents=599_900,
        annual_price_cents=5_758_800,
        is_active=True,
    )

    warning = superadmin_plan_routes._checkout_wiring_warning(plan)

    assert warning is not None
    assert "monthly and annual" in warning
    assert "Contact sales" in warning


def test_a_half_wired_plan_names_only_the_missing_cycle():
    plan = Plan(
        name="Agency",
        slug="agency",
        currency="INR",
        monthly_price_cents=599_900,
        annual_price_cents=5_758_800,
        is_active=True,
        razorpay_plan_id_monthly="plan_m",
    )

    warning = superadmin_plan_routes._checkout_wiring_warning(plan)

    assert warning is not None
    assert "for annual billing" in warning


@pytest.mark.parametrize(
    ("kwargs", "why"),
    [
        ({"monthly_price_cents": 0, "annual_price_cents": 0}, "free tier has nothing to charge"),
        ({"is_active": False}, "not listed, so no visitor can reach the dead checkout"),
        ({"razorpay_plan_id_monthly": "plan_m", "razorpay_plan_id_annual": "plan_a"}, "fully wired"),
    ],
)
def test_no_wiring_warning_when_there_is_nothing_to_warn_about(kwargs, why):
    columns = {
        "name": "Agency",
        "slug": "agency",
        "currency": "INR",
        "monthly_price_cents": 599_900,
        "annual_price_cents": 5_758_800,
        "is_active": True,
    }
    columns.update(kwargs)

    assert superadmin_plan_routes._checkout_wiring_warning(Plan(**columns)) is None, why


def test_the_wiring_warning_travels_with_the_emandate_warnings():
    """One list, so ``create_plan`` and ``update_plan`` cannot drift on which
    advisories they return."""
    plan = Plan(
        name="Agency",
        slug="agency",
        currency="INR",
        monthly_price_cents=599_900,
        annual_price_cents=5_758_800,
        is_active=True,
    )

    class _NoSellerProfile:
        """Session stand-in: no profile row, so the default 18% applies."""

        def get(self, _model, _key):
            return None

    warnings = superadmin_plan_routes._plan_warnings(plan, _NoSellerProfile())

    assert any("Razorpay plan id" in w for w in warnings)
    assert any("e-mandate" in w.lower() for w in warnings), "the annual price is above the RBI AFA ceiling"


# ── The refusal contract: catalogue, quote and checkout agree ────────────────


pg_only = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="catalogue/quote/checkout route tests need a reachable Postgres at DB_URL",
)


@contextlib.contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(
        name="c",
        email=email,
        api_key=email,
        hashed_password="h",
        is_verified=True,
        legal_name="Test Buyer Pvt Ltd",
        billing_address={"line1": "1 MG Road", "city": "Pune", "postal_code": "411001"},
        billing_state_code="27",
        billing_country="IN",
    )
    db.add(client)
    db.flush()
    return client


def _make_unwired_plan(db, *, slug: str) -> Plan:
    """An Enterprise-shaped row exactly as a prod reseed leaves it: listed,
    priced, and with no Live Razorpay plan id on either cycle."""
    plan = Plan(
        name="Enterprise",
        slug=slug,
        monthly_price_cents=599_900,
        annual_price_cents=5_758_800,
        monthly_price_usd_cents=9_199,
        annual_price_usd_cents=91_188,
        credits_per_month=10_000,
        included_operator_seats=-1,
        is_active=True,
        sort_order=5,
    )
    db.add(plan)
    db.flush()
    return plan


def _api(db, client) -> TestClient:
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    # Registered on the real app in main.py; the inline app needs it too or the
    # refusal would surface as an unhandled 500 and this test would pass for the
    # wrong reason.
    app.add_exception_handler(PlanNotCheckoutable, plan_not_checkoutable_handler)
    return TestClient(app, raise_server_exceptions=False)


@pg_only
def test_an_unwired_paid_tier_is_still_on_the_public_pricing_catalog(db):
    """``get_active_plans`` is what ``GET /public/pricing-catalog``, the feed
    oyechats.com/pricing renders. Is built from. A contact-sales tier belongs
    on that page; deriving ``is_active`` from the gateway wiring took it off."""
    from app.services.plan_service import get_active_plans

    plan = _make_unwired_plan(db, slug="catalog-enterprise")
    db.commit()

    assert plan.slug in {p.slug for p in get_active_plans(db)}


@pg_only
def test_the_quote_for_an_unwired_tier_is_contact_sales(db):
    from app.api import subscription_routes

    client = _make_client(db, email="wiring-quote@e.com")
    plan = _make_unwired_plan(db, slug="quote-enterprise")
    db.commit()

    api = _api(db, client)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.get(f"/subscriptions/checkout/quote?plan_id={plan.id}&billing_cycle=monthly")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["checkout_supported"] is False
    assert body["reason"] == "inr_plan_unconfigured"
    assert body["contact_sales"] == "developer@oyechats.com"


@pg_only
def test_checkout_for_an_unwired_tier_refuses_in_the_quote_s_own_shape(db):
    """The defect the deactivation policy was actually reaching for.

    ``create_subscription`` raised a bare ``ValueError``, which ``/checkout``
    re-raised as a 400 whose customer-facing message was the operator
    instruction: "Create the plan in the Razorpay dashboard and set the id from
    super admin." The quote already degraded gracefully for the same plan, so
    the two surfaces contradicted each other. Now both answer
    ``inr_plan_unconfigured`` with the same contact-sales address.
    """
    from app.api import subscription_routes

    client = _make_client(db, email="wiring-checkout@e.com")
    plan = _make_unwired_plan(db, slug="checkout-enterprise")
    db.commit()

    api = _api(db, client)
    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch.object(subscription_routes, "RAZORPAY_ENABLED", True),
        patch.object(subscription_routes.razorpay_customer_service, "ensure_customer", return_value=None),
    ):
        res = api.post("/subscriptions/checkout", json={"plan_id": plan.id, "billing_cycle": "monthly"})

    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert detail["reason"] == "inr_plan_unconfigured"
    assert detail["contact_sales"] == "developer@oyechats.com"
    assert "Razorpay dashboard" not in detail["message"], "operator instruction leaked to the buyer"
    assert "contact sales" in detail["message"].lower()


def test_the_refusal_keeps_the_operator_instruction_out_of_the_customer_message():
    """``str(exc)`` is what every handler renders; ``ops_detail`` is what gets
    logged. Pinned separately because the two are one attribute apart."""
    exc = PlanNotCheckoutable(plan_name="Enterprise", billing_cycle="annual", currency="INR")

    assert "Razorpay" not in str(exc)
    assert "Razorpay dashboard" in exc.ops_detail
    assert exc.reason == "inr_plan_unconfigured"


def test_a_missing_usd_id_refuses_under_the_quote_s_usd_code():
    """The USD branch of the quote answers ``intl_usd_pending`` for a tier with
    no USD plan id, so the charge path must not invent a third code."""
    exc = PlanNotCheckoutable(plan_name="Enterprise", billing_cycle="monthly", currency="USD")

    assert exc.reason == "intl_usd_pending"
