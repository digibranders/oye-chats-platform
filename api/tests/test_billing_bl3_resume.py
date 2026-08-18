"""BL-3 - /subscriptions/cancel and /resume must be truthful (real Postgres).

``cancel_at_period_end`` is a reversible customer INTENT; the irreversible
Razorpay cancel is a separate FACT recorded by ``gateway_cancel_executed_at``.
Everything in this module turns on keeping those two apart.

**Mode 1, the mandate is still live** (``gateway_cancel_executed_at IS NULL``).
``/cancel`` no longer touches Razorpay, so a customer who changes their mind
before ``task_execute_pending_cancellations`` runs is un-cancelled by clearing a
flag: no checkout, no payment, no lost credits. ``/resume`` still confirms
liveness with the gateway first, the local marker is not proof, and promising a
renewal that silently never comes is the exact BL-3 lie this module guards.

**Mode 2, the mandate is already dead.** Razorpay has NO un-cancel for an
at-cycle-end cancellation, so ``/resume`` must re-authorise: mint a FRESH
subscription for the same plan/cycle (tagging the predecessor via
``prev_razorpay_subscription_id``) and return ``mandate_action:
"reauthorise_required"`` plus the checkout payload. It must NOT return "resumed
successfully" without a real gateway state change, and it must pass
``start_at = current_period_end`` so the replacement first charges when the paid
period runs out instead of billing a second overlapping cycle immediately.

Uses the shared ``db`` fixture (conftest). Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, Plan, Subscription

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="BL-3 resume tests need a reachable Postgres at DB_URL",
)


# ── Builders ──────────────────────────────────────────────────────────────────


def _make_client(db, *, email: str) -> Client:
    client = Client(
        name="c",
        email=email,
        api_key=email,
        hashed_password="h",
        # Wave 1.3: /resume Mode 2 now runs the shared pre-charge gates, so
        # the fixture carries a complete Rule 46 buyer identity.
        legal_name="C Pvt Ltd",
        billing_address={"line1": "1 Lane", "city": "Mumbai", "postal_code": "400001"},
        billing_state_code="27",
        billing_country="IN",
    )
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str, price_cents: int = 399900, credits: int = 1000) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=price_cents,
        annual_price_cents=price_cents * 10,
        monthly_price_usd_cents=price_cents,
        credits_per_month=credits,
        included_operator_seats=1,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_inr_monthly",
        razorpay_plan_id_annual=f"plan_{slug}_inr_annual",
    )
    db.add(plan)
    db.flush()
    return plan


def _make_sub(
    db,
    client: Client,
    plan: Plan,
    *,
    razorpay_subscription_id: str | None,
    cancel_at_period_end: bool = True,
    billing_cycle: str = "monthly",
    status: str = "active",
    bot_id: int | None = None,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
    gateway_cancelled: bool = True,
) -> Subscription:
    """A cancel-pending subscription.

    ``gateway_cancelled`` defaults True. I.e. the irreversible Razorpay cancel
    has already been issued. Because that is the state the re-authorisation
    path exists for. Pass False to build the far more common Mode 1 row, where
    the customer has cancelled but the mandate is still live.
    """
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot_id,
        status=status,
        payment_provider="razorpay",
        razorpay_subscription_id=razorpay_subscription_id,
        billing_cycle=billing_cycle,
        cancel_at_period_end=cancel_at_period_end,
        canceled_at=datetime(2026, 1, 5, tzinfo=UTC) if cancel_at_period_end else None,
        cancel_reason="too expensive" if cancel_at_period_end else None,
        gateway_cancel_executed_at=(
            datetime(2026, 1, 5, tzinfo=UTC) if (cancel_at_period_end and gateway_cancelled) else None
        ),
        current_period_start=period_start or datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=period_end or datetime(2026, 1, 31, tzinfo=UTC),
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


@contextmanager
def _session_cm(session):
    yield session


def _app(client):
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    # subscription_routes aliases get_current_client_strict as get_current_client,
    # so the dependency object to override is get_current_client_strict.
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return app, subscription_routes


# ── Cancel records intent; it does not touch the gateway ──────────────────────


def test_cancel_leaves_the_mandate_live_for_the_rest_of_the_period(db):
    """Cancelling 26 days before period end must not touch Razorpay.

    The old behaviour issued ``cancel_at_cycle_end=1`` on click. Razorpay has no
    un-cancel, so from that instant the customer could only "reactivate" by
    buying a whole new mandate, which then billed immediately, a second time,
    for days they already owned. Recording intent locally keeps that reversible.
    """
    client = _make_client(db, email="cancel-defer@e.com")
    plan = _make_plan(db, slug="std-cancel-defer")
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_cancel_defer",
        cancel_at_period_end=False,
        period_start=datetime.now(UTC) - timedelta(days=4),
        period_end=datetime.now(UTC) + timedelta(days=26),
    )
    sub.seat_addon_subscription_id = "sub_seats_defer"
    sub.seat_addon_quantity = 2
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.cancel_subscription") as gateway_cancel,
        patch("app.services.razorpay_service.cancel_seat_addon") as seat_cancel,
    ):
        resp = api.post("/subscriptions/cancel", json={"reason": "too expensive"})

    assert resp.status_code == 200, resp.text
    gateway_cancel.assert_not_called()
    # Paid seats survive too. Cancelling used to strip them on click while the
    # plan itself kept running to period end.
    seat_cancel.assert_not_called()

    db.refresh(sub)
    assert sub.cancel_at_period_end is True
    assert sub.gateway_cancel_executed_at is None, "the sweep owns the gateway call"
    assert sub.seat_addon_quantity == 2


def test_cancel_voids_an_in_flight_reactivation_checkout(db):
    """Razorpay leaves a ``created`` subscription authorizable indefinitely.

    A customer who opened a reactivation checkout, walked away, then cancelled
    could click that stale link weeks later, its activation webhook would mint
    a fresh active subscription and restart billing after they explicitly said
    stop. Cancelling has to void it.
    """
    client = _make_client(db, email="cancel-voids-checkout@e.com")
    plan = _make_plan(db, slug="std-cancel-voids")
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_cancel_voids",
        cancel_at_period_end=False,
        period_start=datetime.now(UTC) - timedelta(days=4),
        period_end=datetime.now(UTC) + timedelta(days=26),
    )
    sub.upgrade_pending_subscription_id = "sub_stale_checkout"
    sub.upgrade_pending_plan_id = plan.id
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.cancel_subscription_by_id") as void_checkout,
    ):
        resp = api.post("/subscriptions/cancel", json={})

    assert resp.status_code == 200, resp.text
    void_checkout.assert_called_once_with("sub_stale_checkout")

    db.refresh(sub)
    assert sub.upgrade_pending_subscription_id is None
    assert sub.upgrade_pending_plan_id is None


def test_cancel_survives_a_failure_voiding_the_stale_checkout(db):
    """Best-effort: the cancellation the customer asked for must not fail
    because a dead checkout wouldn't tidy up."""
    client = _make_client(db, email="cancel-void-fails@e.com")
    plan = _make_plan(db, slug="std-cancel-void-fails")
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_void_fails",
        cancel_at_period_end=False,
        period_start=datetime.now(UTC) - timedelta(days=4),
        period_end=datetime.now(UTC) + timedelta(days=26),
    )
    sub.upgrade_pending_subscription_id = "sub_stale_dead"
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.cancel_subscription_by_id",
            side_effect=RuntimeError("gateway 500"),
        ),
    ):
        resp = api.post("/subscriptions/cancel", json={})

    assert resp.status_code == 200, resp.text
    db.refresh(sub)
    assert sub.cancel_at_period_end is True
    assert sub.upgrade_pending_subscription_id is None


def test_cancel_inside_the_lead_window_still_stops_the_renewal(db):
    """Cancelling on the last day leaves no room for the daily sweep, so the
    gateway call has to happen inline or Razorpay debits the next cycle."""
    client = _make_client(db, email="cancel-lastday@e.com")
    plan = _make_plan(db, slug="std-cancel-lastday")
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_cancel_lastday",
        cancel_at_period_end=False,
        period_start=datetime.now(UTC) - timedelta(days=29),
        period_end=datetime.now(UTC) + timedelta(hours=6),
    )
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.cancel_subscription") as gateway_cancel,
    ):
        resp = api.post("/subscriptions/cancel", json={})

    assert resp.status_code == 200, resp.text
    gateway_cancel.assert_called_once()
    assert gateway_cancel.call_args.kwargs["at_period_end"] is True

    db.refresh(sub)
    assert sub.gateway_cancel_executed_at is not None


# ── BL-3: resume re-authorises instead of lying ────────────────────────────────


def test_resume_reauthorises_when_gateway_mandate_cancelled(db):
    """A sub whose gateway mandate was cancelled at-cycle-end → /resume must
    return ``reauthorise_required`` (NOT "resumed successfully") and mint a fresh
    Razorpay subscription tagging the predecessor id."""
    client = _make_client(db, email="bl3-reauth@e.com")
    plan = _make_plan(db, slug="std-bl3-reauth")
    _make_sub(db, client, plan, razorpay_subscription_id="sub_old_bl3", billing_cycle="monthly")
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={
                "provider": "razorpay",
                "subscription_id": "sub_new_bl3",
                "short_url": "https://rzp.io/i/reauth",
                "key_id": "key_test",
            },
        ) as create_sub,
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Truthful re-auth response. Mirrors cancel_scheduled_change_endpoint.
    assert body["mandate_action"] == "reauthorise_required"
    assert body.get("status") == "reauthorise_required"
    # The fresh gateway subscription payload is surfaced for checkout.
    checkout = body.get("checkout") or {}
    assert checkout.get("short_url") == "https://rzp.io/i/reauth"

    # A REAL gateway state change happened: create_subscription was called for
    # the same plan/cycle, tagging the predecessor for retirement at activation.
    create_sub.assert_called_once()
    _, kwargs = create_sub.call_args
    assert kwargs["extra_notes"] == {"prev_razorpay_subscription_id": "sub_old_bl3"}


def test_resume_after_sweep_defers_first_charge_to_the_paid_period_end(db):
    """The money bug. A replacement minted with no ``start_at`` starts at Razorpay
    immediately and captures a full second cycle for days the customer already
    paid for. ``/resume`` must pass ``start_at = current_period_end``.

    And because a deferred start never resets the plan allowance, there is
    nothing to roll over. ``upgrade_credit_pending_cents`` must stay 0 rather
    than queueing a duplicate re-grant on top of credits that were never wiped.
    """
    client = _make_client(db, email="bl3-startat@e.com")
    plan = _make_plan(db, slug="std-bl3-startat")
    paid_through = datetime.now(UTC) + timedelta(days=26)
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_old_startat",
        period_start=datetime.now(UTC) - timedelta(days=4),
        period_end=paid_through,
    )
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_startat", "short_url": "u"},
        ) as create_sub,
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 200, resp.text
    _, kwargs = create_sub.call_args
    assert kwargs["start_at"] == int(paid_through.timestamp())

    body = resp.json()
    assert body["first_charge_at"] == paid_through.date().isoformat()
    # The customer is told when they'll actually be billed, not just that a
    # mandate is needed.
    assert paid_through.date().isoformat() in body["message"]

    db.refresh(sub)
    assert sub.upgrade_credit_pending_cents == 0


def test_resume_with_no_paid_time_left_snapshots_credits_for_rollover(db):
    """The mirror case: when the period has already elapsed there is nothing to
    defer to, so the replacement bills now and its activation resets the plan
    allowance. That reset would silently destroy unused credits, so ``/resume``
    must snapshot them the way the upgrade path does."""
    client = _make_client(db, email="bl3-rollover@e.com")
    plan = _make_plan(db, slug="std-bl3-rollover")
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_old_rollover",
        period_start=datetime(2026, 1, 1, tzinfo=UTC),
        period_end=datetime(2026, 1, 31, tzinfo=UTC),  # long past
    )
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.transition_service.remaining_plan_credits", return_value=4200),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_rollover", "short_url": "u"},
        ) as create_sub,
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 200, resp.text
    _, kwargs = create_sub.call_args
    # A past period end must NOT be sent as start_at (Razorpay rejects it).
    assert kwargs["start_at"] == int(datetime(2026, 1, 31, tzinfo=UTC).timestamp())
    assert resp.json()["first_charge_at"] is None

    db.refresh(sub)
    assert sub.upgrade_credit_pending_cents == 4200


def test_resume_per_bot_names_the_bot_so_the_right_row_is_retired(db):
    """A per-bot subscription resumed through the account-level mint left the
    activation sweep looking for the ACCOUNT row (``bot_id IS NULL``). It never
    retired the per-bot row, so the customer ended up with two live mandates and
    a "won't renew" banner that could never clear. The notes must name the bot."""
    from app.db.models import Bot

    client = _make_client(db, email="bl3-perbot@e.com")
    plan = _make_plan(db, slug="std-bl3-perbot")
    bot = Bot(client_id=client.id, name="Agent A", bot_key="bot-bl3-perbot")
    db.add(bot)
    db.flush()
    _make_sub(db, client, plan, razorpay_subscription_id="sub_old_perbot", bot_id=bot.id)
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_perbot", "short_url": "u"},
        ) as create_sub,
    ):
        resp = api.post("/subscriptions/resume", json={"bot_id": bot.id})

    assert resp.status_code == 200, resp.text
    _, kwargs = create_sub.call_args
    notes = kwargs["extra_notes"]
    assert notes["oyechats_bot_id"] == str(bot.id)
    assert notes["purpose"] == "per_bot_subscription"
    assert notes["prev_razorpay_subscription_id"] == "sub_old_perbot"


# ── Mode 1: the mandate is still live, so reactivating costs nothing ───────────


def test_resume_before_the_sweep_clears_the_flag_without_any_checkout(db):
    """The common case after the deferred-cancel change: the customer cancelled,
    the sweep hasn't run, the mandate is untouched at Razorpay. Reactivating must
    be a flag flip, no fresh subscription, no checkout, no payment."""
    client = _make_client(db, email="bl3-live@e.com")
    plan = _make_plan(db, slug="std-bl3-live")
    period_end = datetime.now(UTC) + timedelta(days=20)
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_live_bl3",
        period_end=period_end,
        gateway_cancelled=False,
    )
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.is_subscription_live", return_value=True) as live,
        patch("app.services.razorpay_service.create_subscription") as create_sub,
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mandate_action"] == "none"
    assert body["status"] == "resumed"
    assert body["renews_on"] == period_end.date().isoformat()

    live.assert_called_once_with("sub_live_bl3")
    create_sub.assert_not_called()

    db.refresh(sub)
    assert sub.cancel_at_period_end is False
    assert sub.canceled_at is None
    assert sub.cancel_reason is None


def test_resume_falls_back_to_reauth_when_the_gateway_contradicts_the_marker(db):
    """The marker says the mandate is live but Razorpay disagrees, the customer
    cancelled from Razorpay's own email, or a sweep half-completed. Clearing the
    flag here would promise a renewal that never happens, so we self-heal the
    marker and re-authorise instead."""
    client = _make_client(db, email="bl3-contradict@e.com")
    plan = _make_plan(db, slug="std-bl3-contradict")
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_dead_bl3",
        period_end=datetime.now(UTC) + timedelta(days=10),
        gateway_cancelled=False,
    )
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.is_subscription_live", return_value=False),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_contra", "short_url": "u"},
        ) as create_sub,
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 200, resp.text
    assert resp.json()["mandate_action"] == "reauthorise_required"
    create_sub.assert_called_once()

    db.refresh(sub)
    # Self-healed, so the sweep won't try to cancel an already-dead mandate.
    assert sub.gateway_cancel_executed_at is not None
    # Still on the cancellation track until the customer actually re-authorises.
    assert sub.cancel_at_period_end is True


def test_resume_refuses_to_guess_when_the_gateway_is_unreachable(db):
    """A network blip is not evidence the mandate is live. Rather than clear the
    flag on a guess, /resume surfaces a 502 and changes nothing."""
    from app.services.razorpay_service import RazorpayBillingError

    client = _make_client(db, email="bl3-unreachable@e.com")
    plan = _make_plan(db, slug="std-bl3-unreachable")
    sub = _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_unreachable_bl3",
        period_end=datetime.now(UTC) + timedelta(days=10),
        gateway_cancelled=False,
    )
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.is_subscription_live",
            side_effect=RazorpayBillingError("gateway down"),
        ),
        patch("app.services.razorpay_service.create_subscription") as create_sub,
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 502, resp.text
    create_sub.assert_not_called()

    db.refresh(sub)
    assert sub.cancel_at_period_end is True
    assert sub.gateway_cancel_executed_at is None


def test_resume_never_returns_false_resumed_successfully(db):
    """Regression: the reauth path must NEVER emit the old lying
    "resumed successfully" message, and must NOT silently clear the local
    cancel flags (which would hide the still-cancelled gateway mandate)."""
    client = _make_client(db, email="bl3-nolie@e.com")
    plan = _make_plan(db, slug="std-bl3-nolie")
    sub = _make_sub(db, client, plan, razorpay_subscription_id="sub_old_nolie")
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_nolie", "short_url": "u"},
        ),
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 200, resp.text
    assert "resumed successfully" not in resp.text.lower()

    # The local flags are NOT cleared to a false "active, not cancelling" state:
    # the gateway mandate is still dead until the customer re-authorises, so the
    # row must not pretend the cancellation was undone.
    db.refresh(sub)
    assert sub.cancel_at_period_end is True


def test_resume_double_submit_reuses_pending_checkout_no_second_mint(db):
    """Finding H1: a sequential double /resume must NOT mint a second Razorpay
    subscription (two authorized mandates → double charge). The second call
    reuses the in-flight checkout via rebuild_upgrade_checkout."""
    client = _make_client(db, email="bl3-idem@e.com")
    plan = _make_plan(db, slug="std-bl3-idem")
    sub = _make_sub(db, client, plan, razorpay_subscription_id="sub_old_idem")
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_idem", "short_url": "u1"},
        ) as create_sub,
        patch(
            "app.services.razorpay_service.rebuild_upgrade_checkout",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_idem", "short_url": "u1-reused"},
        ) as rebuild,
        # The reuse path now asks the gateway whether the pending mandate has
        # already been PAID before it considers reusing or re-minting. Unpaid
        # here, the paid case has its own test below.
        patch("app.services.razorpay_service.checkout_already_paid", return_value=False),
    ):
        first = api.post("/subscriptions/resume", json={})
        # The first call must persist the pending marker for the guard to see.
        db.refresh(sub)
        assert sub.upgrade_pending_subscription_id == "sub_new_idem"
        assert sub.upgrade_pending_plan_id == plan.id
        second = api.post("/subscriptions/resume", json={})

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    # Exactly ONE fresh Razorpay subscription is ever minted across both calls.
    create_sub.assert_called_once()
    # The second call reused the in-flight checkout instead of minting again.
    rebuild.assert_called_once()
    assert second.json()["mandate_action"] == "reauthorise_required"
    assert (second.json().get("checkout") or {}).get("short_url") == "u1-reused"


def test_resume_refuses_to_re_mint_over_an_already_paid_reauth(db):
    """The /resume twin of the reported defect.

    Mode 2 mints a fresh mandate because Razorpay has no un-cancel, and it
    re-minted whenever ``rebuild_upgrade_checkout`` returned ``None``, which it
    does for a mandate the customer has ALREADY authorised and paid exactly as
    it does for an abandoned one. A customer who re-authorised and then clicked
    Reactivate again (the emailed re-auth link is clickable twice) would get a
    second chargeable mandate.
    """
    from app.core.middleware import subscription_activation_conflict_handler
    from app.services import razorpay_service

    client = _make_client(db, email="bl3-paid-reauth@e.com")
    plan = _make_plan(db, slug="std-bl3-paid-reauth")
    sub = _make_sub(db, client, plan, razorpay_subscription_id="sub_old_paid_reauth")
    sub.upgrade_pending_subscription_id = "sub_reauth_paid"
    sub.upgrade_pending_plan_id = plan.id
    db.commit()

    app, subscription_routes = _app(client)
    app.add_exception_handler(razorpay_service.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.create_subscription") as create_sub,
        patch("app.services.razorpay_service.rebuild_upgrade_checkout") as rebuild,
        patch("app.services.razorpay_service.checkout_already_paid", return_value=True),
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["payment_captured"] is True
    assert not create_sub.called
    assert not rebuild.called
    db.refresh(sub)
    # The marker survives, the activation still has to consume it.
    assert sub.upgrade_pending_subscription_id == "sub_reauth_paid"


def test_resume_rejects_when_not_scheduled_for_cancellation(db):
    """A sub with no pending cancellation → 400 (nothing to resume). No gateway
    subscription is minted."""
    client = _make_client(db, email="bl3-notcancelling@e.com")
    plan = _make_plan(db, slug="std-bl3-active")
    _make_sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_active_bl3",
        cancel_at_period_end=False,
    )
    db.commit()

    app, subscription_routes = _app(client)
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.create_subscription") as create_sub,
    ):
        resp = api.post("/subscriptions/resume", json={})

    assert resp.status_code == 400, resp.text
    create_sub.assert_not_called()
