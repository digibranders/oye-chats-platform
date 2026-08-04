"""GET /subscriptions/payment-recovery — drives the app-wide past-due banner.

Read-only by construction: it resolves Razorpay's EXISTING hosted page and must
never mint a second mandate, which would double-charge a customer whose
original subscription is still recoverable.

Uses the shared ``db`` fixture (conftest) and the route-test wiring from
test_billing_bl3_resume.py. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Bot, Client, Plan, Subscription

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="needs a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _app(client):
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return app, subscription_routes


def _client(db, email):
    row = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(row)
    db.flush()
    return row


def _plan(db, slug):
    plan = Plan(
        name="Standard",
        slug=slug,
        monthly_price_cents=94900,
        annual_price_cents=910800,
        credits_per_month=6000,
        included_operator_seats=1,
        is_active=True,
    )
    db.add(plan)
    db.flush()
    return plan


def _sub(db, client, plan, *, status="past_due", days_ago=3, rzp_id="sub_pd", bot_id=None):
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot_id,
        status=status,
        payment_provider="razorpay",
        razorpay_subscription_id=rzp_id,
        billing_cycle="monthly",
        past_due_since=(datetime.now(UTC) - timedelta(days=days_ago)) if status == "past_due" else None,
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def _get(db, client, subscription_routes, url="/subscriptions/payment-recovery"):
    app, _ = _app(client)
    api = TestClient(app, raise_server_exceptions=False)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        return api.get(url)


def test_active_subscription_reports_not_past_due(db):
    from app.api import subscription_routes

    client = _client(db, "rec-active@e.com")
    plan = _plan(db, "std-rec-active")
    _sub(db, client, plan, status="active")
    db.commit()

    body = _get(db, client, subscription_routes).json()
    assert body["past_due"] is False
    assert body["recovery_url"] is None


def test_past_due_returns_link_and_days_left(db):
    from app.api import subscription_routes
    from app.services import dunning_service

    client = _client(db, "rec-pd@e.com")
    plan = _plan(db, "std-rec-pd")
    _sub(db, client, plan, days_ago=3)
    db.commit()

    link = dunning_service.RecoveryLink(recoverable=True, url="https://rzp.io/i/abc", gateway_status="halted")
    with patch.object(dunning_service, "get_recovery_link", return_value=link):
        body = _get(db, client, subscription_routes).json()

    assert body["past_due"] is True
    assert body["recoverable"] is True
    assert body["recovery_url"] == "https://rzp.io/i/abc"
    # PAYMENT_FAILED_GRACE_DAYS (7) - 3 elapsed.
    assert body["days_left"] == 4
    assert body["plan_name"] == "Standard"


def test_gateway_failure_reports_unknown_not_dead(db):
    """recoverable=None means 'we couldn't check'. Reporting False here would
    tell a paying customer their subscription is gone over a transient blip."""
    from app.api import subscription_routes
    from app.services import dunning_service

    client = _client(db, "rec-boom@e.com")
    plan = _plan(db, "std-rec-boom")
    _sub(db, client, plan)
    db.commit()

    with patch.object(dunning_service, "get_recovery_link", side_effect=dunning_service.DunningError("down")):
        body = _get(db, client, subscription_routes).json()

    assert body["past_due"] is True
    assert body["recoverable"] is None
    assert body["recovery_url"] is None
    assert body["days_left"] == 4


def test_terminal_gateway_state_reports_not_recoverable(db):
    from app.api import subscription_routes
    from app.services import dunning_service

    client = _client(db, "rec-term@e.com")
    plan = _plan(db, "std-rec-term")
    _sub(db, client, plan)
    db.commit()

    link = dunning_service.RecoveryLink(recoverable=False, url=None, gateway_status="cancelled")
    with patch.object(dunning_service, "get_recovery_link", return_value=link):
        body = _get(db, client, subscription_routes).json()

    assert body["past_due"] is True
    assert body["recoverable"] is False
    assert body["recovery_url"] is None


def test_agent_scope_falls_back_to_the_account_subscription(db):
    """The banner is app-wide. An agent with no subscription of its own must
    still surface the ACCOUNT's past-due state — otherwise selecting an agent
    in the switcher silently hides the warning (same class of bug as F1)."""
    from app.api import subscription_routes
    from app.services import dunning_service

    client = _client(db, "rec-scope@e.com")
    plan = _plan(db, "std-rec-scope")
    _sub(db, client, plan, days_ago=5)
    bot = Bot(client_id=client.id, bot_key="bot-rec-scope", name="Agent")
    db.add(bot)
    db.flush()
    db.commit()

    link = dunning_service.RecoveryLink(recoverable=True, url="https://rzp.io/i/abc", gateway_status="halted")
    with patch.object(dunning_service, "get_recovery_link", return_value=link):
        body = _get(db, client, subscription_routes, url=f"/subscriptions/payment-recovery?bot_id={bot.id}").json()

    assert body["past_due"] is True
    assert body["days_left"] == 2


def test_no_subscription_at_all_is_not_past_due(db):
    from app.api import subscription_routes

    client = _client(db, "rec-none@e.com")
    db.commit()

    body = _get(db, client, subscription_routes).json()
    assert body["past_due"] is False
    assert body["plan_name"] is None


# ── Episode lifecycle ────────────────────────────────────────────────────────
#
# Regression cover for the highest-impact defect found in review: nothing
# cleared `dunning_emails_sent` on rescue, so a customer who failed, recovered,
# and failed again matched every marker on the new episode and was silently
# suspended having received no email at all.


def test_rescue_clears_the_dunning_episode_so_a_later_failure_re_notifies(db):
    from app.services.dunning_service import due_email
    from app.services.razorpay_service import _clear_dunning_state, _enter_past_due

    client = _client(db, "rec-episode@e.com")
    plan = _plan(db, "std-rec-episode")
    sub = _sub(db, client, plan, status="active")

    # Episode 1: fails, day-0 email goes out.
    _enter_past_due(sub)
    assert due_email(0, sub.dunning_emails_sent) == "failed_0"
    sub.dunning_emails_sent = {"failed_0": "2026-08-01T00:00:00+00:00"}
    db.flush()
    assert due_email(0, sub.dunning_emails_sent) is None

    # Customer rescues the card.
    _clear_dunning_state(sub)
    sub.status = "active"
    db.flush()
    assert sub.past_due_since is None
    assert sub.dunning_emails_sent == {}

    # Episode 2, months later: must notify again, not inherit episode 1.
    _enter_past_due(sub)
    db.flush()
    assert sub.past_due_since is not None
    assert due_email(0, sub.dunning_emails_sent) == "failed_0"


def test_clear_dunning_state_is_idempotent_on_a_never_past_due_row(db):
    from app.services.razorpay_service import _clear_dunning_state

    client = _client(db, "rec-noop@e.com")
    plan = _plan(db, "std-rec-noop")
    sub = _sub(db, client, plan, status="active")

    _clear_dunning_state(sub)
    _clear_dunning_state(sub)
    db.flush()

    assert sub.past_due_since is None
    assert sub.dunning_emails_sent == {}
