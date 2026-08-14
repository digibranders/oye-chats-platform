"""``/subscriptions/verify-razorpay-subscription`` must not 500 on a constraint
it can predict.

Prod client 18 held two in-flight mandates for one month. When the second one's
activation tried to materialise, it collided with the first active row:

    IntegrityError: duplicate key value violates unique constraint
    "ix_subscriptions_client_legacy_active"

and that reached the customer as a raw 500, mid-checkout, seconds after their
money moved. Two changes, both pinned here:

* ``_handle_subscription_activated`` now takes the per-client billing advisory
  lock before it reads anything, so the second activation waits for the first to
  commit and then retires it through the sibling sweep instead of racing it;
* the endpoint translates a collision on either active-subscription index into
  ``SubscriptionActivationConflict`` — a structured, customer-safe 409 that says
  the payment DID arrive, following the ``PlanNotCheckoutable`` pattern (the
  operator instruction lives in ``ops_detail`` and is logged, never returned).

Any OTHER ``IntegrityError`` must still blow up: dressing a real bug in
reassuring language is worse than the 500.
"""

import os
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app.api import subscription_routes
from app.api.auth import get_current_client_strict
from app.core.middleware import subscription_activation_conflict_handler
from app.db.models import Client, Plan, Subscription
from app.services import plan_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _integrity_error(constraint: str) -> IntegrityError:
    """An IntegrityError shaped like psycopg's, with a structured constraint name."""
    orig = SimpleNamespace(
        diag=SimpleNamespace(constraint_name=constraint),
        __str__=lambda self: f'duplicate key value violates unique constraint "{constraint}"',
    )
    return IntegrityError("INSERT INTO subscriptions ...", {}, orig)


def _api(db, monkeypatch):
    client = Client(name="C18", email="verifyconflict@test.example", api_key="key-verifyconflict")
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    # Registered on the real app in main.py; the inline app needs it too or the
    # refusal would surface as an unhandled 500 and the test would pass for the
    # wrong reason.
    app.add_exception_handler(rzp.SubscriptionActivationConflict, subscription_activation_conflict_handler)
    return TestClient(app, raise_server_exceptions=False), client


_BODY = {
    "razorpay_payment_id": "pay_conflict",
    "razorpay_subscription_id": "sub_conflict",
    "razorpay_signature": "sig",
}


# ── The 500 becomes a structured 409 ────────────────────────────────────────


@pytest.mark.parametrize(
    "constraint",
    ["ix_subscriptions_client_legacy_active", "ix_subscriptions_client_bot_active"],
)
def test_active_scope_collision_is_a_structured_409_not_a_500(db, monkeypatch, constraint):
    api, _client = _api(db, monkeypatch)
    with (
        patch.object(rzp, "verify_subscription_payment_signature"),
        patch.object(rzp, "reconcile_subscription_from_razorpay", side_effect=_integrity_error(constraint)),
    ):
        res = api.post("/subscriptions/verify-razorpay-subscription", json=_BODY)

    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert detail["reason"] == "subscription_activation_conflict"
    # The payer's first question is "did my money vanish?" — answer it.
    assert detail["payment_captured"] is True
    assert "payment went through" in detail["message"].lower()
    # The operator instruction is logged, never returned.
    body = res.text
    assert constraint not in body
    assert "audit_duplicate_gateway_subscriptions" not in body


def test_an_unrelated_integrity_error_is_not_dressed_up_as_a_conflict(db, monkeypatch):
    """A unique-payment-id or FK violation is a real bug. Re-raise it."""
    api, _client = _api(db, monkeypatch)
    with (
        patch.object(rzp, "verify_subscription_payment_signature"),
        patch.object(
            rzp,
            "reconcile_subscription_from_razorpay",
            side_effect=_integrity_error("uq_invoices_razorpay_payment_id"),
        ),
    ):
        res = api.post("/subscriptions/verify-razorpay-subscription", json=_BODY)

    assert res.status_code == 500, res.text


# ── The predicate behind it ─────────────────────────────────────────────────


def test_active_subscription_conflict_reads_the_structured_constraint_name():
    exc = _integrity_error("ix_subscriptions_client_legacy_active")
    assert rzp.active_subscription_conflict(exc) == "ix_subscriptions_client_legacy_active"
    assert rzp.active_subscription_conflict(_integrity_error("some_other_index")) is None


def test_active_subscription_conflict_falls_back_to_the_message():
    """Not every driver populates ``diag``; the message still carries the name."""
    exc = IntegrityError(
        "INSERT INTO subscriptions ...",
        {},
        Exception('duplicate key value violates unique constraint "ix_subscriptions_client_bot_active"'),
    )
    assert rzp.active_subscription_conflict(exc) == "ix_subscriptions_client_bot_active"


def test_the_conflict_keeps_the_operator_detail_out_of_the_customer_sentence():
    exc = rzp.SubscriptionActivationConflict(
        razorpay_subscription_id="sub_x",
        client_id=18,
        constraint="ix_subscriptions_client_legacy_active",
    )
    assert "sub_x" not in str(exc)
    assert "constraint" not in str(exc).lower()
    assert "sub_x" in exc.ops_detail and "ix_subscriptions_client_legacy_active" in exc.ops_detail
    # Deliberately NOT a gateway fault: the broad RazorpayBillingError handlers
    # would call this a 502 "try again", which it is not.
    assert not isinstance(exc, rzp.RazorpayBillingError)


# ── Activation serialises per client ────────────────────────────────────────


def test_activation_takes_the_billing_lock_before_reading_state(db):
    """The race that produced the collision: two activations each swept against a
    snapshot without the other's row. The lock is what makes the second one wait."""
    client = Client(name="L", email="verifylock@test.example", api_key="key-verifylock")
    db.add(client)
    plan = Plan(name="P", slug="std-verifylock", monthly_price_cents=94900, credits_per_month=10, is_active=True)
    db.add(plan)
    db.flush()

    calls: list[int] = []
    with patch.object(plan_service, "lock_client_for_billing", side_effect=lambda _s, cid: calls.append(cid)):
        rzp._handle_subscription_activated(
            db,
            {
                "subscription": {
                    "entity": {
                        "id": "sub_verifylock",
                        "notes": {"oyechats_client_id": str(client.id), "oyechats_plan_id": str(plan.id)},
                        "quantity": 1,
                    }
                }
            },
        )
    assert calls == [client.id]


def test_a_second_mandate_supersedes_the_first_instead_of_colliding(db):
    """With the lock held, the sweep is what resolves the scope: the older active
    row is cancelled and the new one inserted — no constraint violation."""
    client = Client(name="S", email="verifysweep@test.example", api_key="key-verifysweep")
    db.add(client)
    plan = Plan(name="P", slug="std-verifysweep", monthly_price_cents=94900, credits_per_month=10, is_active=True)
    db.add(plan)
    db.flush()
    first = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_verifysweep_1",
    )
    db.add(first)
    db.flush()

    rzp._handle_subscription_activated(
        db,
        {
            "subscription": {
                "entity": {
                    "id": "sub_verifysweep_2",
                    "notes": {"oyechats_client_id": str(client.id), "oyechats_plan_id": str(plan.id)},
                    "quantity": 1,
                }
            }
        },
    )
    db.flush()

    db.refresh(first)
    assert first.status == "canceled"
    second = db.query(Subscription).filter_by(client_id=client.id, razorpay_subscription_id="sub_verifysweep_2").one()
    assert second.status == "active"
