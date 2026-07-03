"""BL-2 + BL-4 remediation — re-auth model for UPI plan changes (real Postgres).

Razorpay's Update Subscription API is blocked for UPI mandates, so plan changes
must cancel+recreate+re-authorize. The design decision is the "re-auth model":
the OLD mandate stays live until the NEW subscription authorizes, and the old is
retired only at the new sub's activation webhook via a REAL gateway cancel.

Covered here:

* BL-4 guard — a client with an active Razorpay subscription that hits
  ``/checkout`` again is rejected with 409 (directed to ``/change-plan``); no
  second Razorpay subscription / UPI mandate is minted.
* Sibling gateway-cancel — when ``subscription.activated`` fires for a new sub,
  the predecessor sibling (active, has a razorpay id) is cancelled AT THE
  GATEWAY (``at_period_end=False``), not merely flipped to canceled locally.
  The just-activated row is never cancelled.
* BL-2 abandonment — the paid upgrade path must NOT hard-cancel the old mandate
  before the new one authorizes. An abandoned checkout modal leaves the customer
  on the OLD active plan with rollover credits intact.

Uses the shared ``pg_engine`` / ``db`` fixtures (conftest). Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, Plan, Subscription

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="BL-2/BL-4 billing tests need a reachable Postgres at DB_URL",
)


# ── Builders ──────────────────────────────────────────────────────────────────


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str, price_cents: int, credits: int = 1000) -> Plan:
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
    status: str = "active",
) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status=status,
        payment_provider="razorpay",
        razorpay_subscription_id=razorpay_subscription_id,
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def _activation_payload(*, razorpay_sub_id: str, client_id: int, plan_id: int, prev_sub_id: str | None = None) -> dict:
    notes: dict[str, str] = {"oyechats_client_id": str(client_id), "oyechats_plan_id": str(plan_id)}
    if prev_sub_id is not None:
        notes["prev_razorpay_subscription_id"] = prev_sub_id
    return {
        "subscription": {
            "entity": {
                "id": razorpay_sub_id,
                "notes": notes,
                "current_start": int(datetime(2026, 1, 1, tzinfo=UTC).timestamp()),
                "current_end": int(datetime(2026, 1, 31, tzinfo=UTC).timestamp()),
                "quantity": 1,
                "customer_id": "cust_test",
            }
        }
    }


@contextmanager
def _session_cm(session):
    yield session


# ── BL-4: already-subscribed guard on /checkout ────────────────────────────────


def test_checkout_blocks_when_already_subscribed_via_razorpay(db):
    """A client with an active Razorpay sub hitting /checkout again → 409, and
    ``create_subscription`` is NOT called (no second mandate minted)."""
    from app.api import auth, subscription_routes

    client = _make_client(db, email="bl4-blocked@e.com")
    std = _make_plan(db, slug="std-bl4", price_cents=399900)
    pro = _make_plan(db, slug="pro-bl4", price_cents=799900)
    _make_sub(db, client, std, razorpay_subscription_id="sub_existing_bl4", status="active")
    db.commit()

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch("app.services.razorpay_service.create_subscription") as create_sub,
    ):
        resp = api.post("/subscriptions/checkout", json={"plan_id": pro.id, "billing_cycle": "monthly"})

    assert resp.status_code == 409, resp.text
    assert "change-plan" in resp.text
    create_sub.assert_not_called()


def test_checkout_allowed_for_first_purchase(db):
    """No existing (non-terminal) sub → checkout proceeds to create_subscription."""
    from app.api import auth, subscription_routes

    client = _make_client(db, email="bl4-first@e.com")
    pro = _make_plan(db, slug="pro-bl4-first", price_cents=799900)
    db.commit()

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_first"},
        ) as create_sub,
    ):
        resp = api.post("/subscriptions/checkout", json={"plan_id": pro.id, "billing_cycle": "monthly"})

    assert resp.status_code == 200, resp.text
    create_sub.assert_called_once()


def test_checkout_not_blocked_by_terminal_sub(db):
    """A canceled/expired sub must NOT block a fresh first purchase."""
    from app.api import auth, subscription_routes

    client = _make_client(db, email="bl4-terminal@e.com")
    std = _make_plan(db, slug="std-bl4-term", price_cents=399900)
    pro = _make_plan(db, slug="pro-bl4-term", price_cents=799900)
    _make_sub(db, client, std, razorpay_subscription_id="sub_dead_bl4", status="canceled")
    db.commit()

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(db)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *a, **k: None),
        patch(
            "app.services.razorpay_service.create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_term"},
        ) as create_sub,
    ):
        resp = api.post("/subscriptions/checkout", json={"plan_id": pro.id, "billing_cycle": "monthly"})

    assert resp.status_code == 200, resp.text
    create_sub.assert_called_once()


# ── Shared: sibling gateway-cancel at activation ───────────────────────────────


def test_activation_gateway_cancels_old_sibling(db):
    """subscription.activated for a NEW sub retires the OLD sibling at the gateway
    (at_period_end=False), flips it canceled locally, and does NOT cancel the
    just-activated row."""
    from app.services import razorpay_service as rzp

    client = _make_client(db, email="sibling@e.com")
    std = _make_plan(db, slug="std-sib", price_cents=399900)
    pro = _make_plan(db, slug="pro-sib", price_cents=799900)
    old = _make_sub(db, client, std, razorpay_subscription_id="sub_old_sib", status="active")
    db.commit()

    fake = MagicMock()
    payload = _activation_payload(
        razorpay_sub_id="sub_new_sib",
        client_id=client.id,
        plan_id=pro.id,
        prev_sub_id="sub_old_sib",
    )

    with patch.object(rzp, "_get_razorpay", return_value=fake):
        rzp._handle_subscription_activated(db, payload)
    db.commit()

    # Gateway cancel was issued for the OLD sub id at_period_end=False (cancel_at_cycle_end=0).
    cancel_calls = fake.subscription.cancel.call_args_list
    assert len(cancel_calls) == 1, cancel_calls
    assert cancel_calls[0].args[0] == "sub_old_sib"
    assert cancel_calls[0].kwargs["data"] == {"cancel_at_cycle_end": 0}

    db.refresh(old)
    assert old.status == "canceled"

    new = db.query(Subscription).filter_by(razorpay_subscription_id="sub_new_sib").one()
    assert new.status == "active"


def test_activation_gateway_cancel_failure_does_not_abort(db):
    """A failing sibling gateway-cancel must not abort the activation — the new
    sub is still created and the old is still flipped canceled locally."""
    from app.services import razorpay_service as rzp

    client = _make_client(db, email="sibling-fail@e.com")
    std = _make_plan(db, slug="std-sibfail", price_cents=399900)
    pro = _make_plan(db, slug="pro-sibfail", price_cents=799900)
    old = _make_sub(db, client, std, razorpay_subscription_id="sub_old_sibfail", status="active")
    db.commit()

    fake = MagicMock()
    fake.subscription.cancel.side_effect = RuntimeError("gateway 500")
    payload = _activation_payload(
        razorpay_sub_id="sub_new_sibfail",
        client_id=client.id,
        plan_id=pro.id,
        prev_sub_id="sub_old_sibfail",
    )

    with patch.object(rzp, "_get_razorpay", return_value=fake):
        rzp._handle_subscription_activated(db, payload)
    db.commit()

    db.refresh(old)
    assert old.status == "canceled"
    new = db.query(Subscription).filter_by(razorpay_subscription_id="sub_new_sibfail").one()
    assert new.status == "active"


# ── BL-2: upgrade defers the old-mandate cancel ────────────────────────────────


def test_upgrade_does_not_immediately_gateway_cancel_old(db):
    """execute_paid_upgrade must NOT hard-cancel the old mandate before the new
    one authorizes. An abandoned modal leaves the customer on the OLD active
    plan with rollover credits stashed intact."""
    from app.services import credit_service, razorpay_service, transition_service

    client = _make_client(db, email="bl2@e.com")
    std = _make_plan(db, slug="std-bl2", price_cents=399900, credits=1000)
    pro = _make_plan(db, slug="pro-bl2", price_cents=799900, credits=5000)
    old = _make_sub(db, client, std, razorpay_subscription_id="sub_old_bl2", status="active")
    db.flush()
    # Give the client some unused plan credits to roll over.
    credit_service.grant_for_subscription(db, old)
    db.commit()

    fake = MagicMock()
    with (
        patch.object(razorpay_service, "_get_razorpay", return_value=fake),
        patch.object(
            razorpay_service,
            "create_subscription",
            return_value={"provider": "razorpay", "subscription_id": "sub_new_bl2"},
        ),
    ):
        transition_service.execute_paid_upgrade(db, client, old, pro, "monthly")
    db.commit()

    # No gateway cancel of the old mandate happened during the upgrade call.
    fake.subscription.cancel.assert_not_called()

    # Abandoned modal: no activation webhook fired → old sub still active.
    db.refresh(old)
    assert old.status == "active"
    # Rollover credits were snapshotted onto the old row, not lost.
    assert old.upgrade_credit_pending_cents == 1000
