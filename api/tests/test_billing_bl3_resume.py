"""BL-3 remediation — /subscriptions/resume must be truthful (real Postgres).

Finding: ``/cancel`` issues the Razorpay gateway cancel IMMEDIATELY with
``cancel_at_cycle_end=1`` (``razorpay_service.cancel_subscription(sub,
at_period_end=True)``) BEFORE flipping the local ``cancel_at_period_end`` flag.
Razorpay has NO un-cancel / resume API for an at-cycle-end-cancelled
subscription, so the old ``/resume`` — which merely cleared the local flags and
returned ``"Subscription resumed successfully."`` with no gateway call — LIED:
the gateway still cancels at period end → involuntary churn.

The honest fix mirrors the sibling ``cancel_scheduled_change_endpoint``: because
the mandate is dead at the gateway, ``/resume`` cannot silently succeed. It must
re-authorise — mint a FRESH Razorpay subscription for the same plan/cycle
(tagging the predecessor via ``prev_razorpay_subscription_id``) and return
``mandate_action: "reauthorise_required"`` plus the checkout payload. It must
NOT return "resumed successfully" without a real gateway state change.

Uses the shared ``db`` fixture (conftest). Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime
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
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
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
) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status=status,
        payment_provider="razorpay",
        razorpay_subscription_id=razorpay_subscription_id,
        billing_cycle=billing_cycle,
        cancel_at_period_end=cancel_at_period_end,
        canceled_at=datetime(2026, 1, 5, tzinfo=UTC) if cancel_at_period_end else None,
        cancel_reason="too expensive" if cancel_at_period_end else None,
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
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
    # Truthful re-auth response — mirrors cancel_scheduled_change_endpoint.
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
