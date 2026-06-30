"""Per-period subscription grant idempotency — remediation H4 (real Postgres).

The renewal grant in ``subscription.charged`` used a fragile 24h time-window
heuristic to avoid double-granting the first cycle. We replace it with an
explicit per-period marker (``Subscription.last_granted_period_end``): the
plan's credits are granted at most once per distinct billing period, regardless
of event timing, ordering, or replays. This also completes H1's "grant
idempotent per period".
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Client, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="renewal-grant tests need a reachable Postgres at DB_URL",
)

S1 = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
E1 = datetime(2026, 1, 31, 12, 0, tzinfo=UTC)
E2 = datetime(2026, 2, 28, 12, 0, tzinfo=UTC)


def _make_sub(db, last_granted=None):
    client = Client(name="c", email="h4@e.com", api_key="h4", hashed_password="h")
    db.add(client)
    db.flush()
    plan = Plan(name="Std", slug="std-h4", monthly_price_cents=399900, credits_per_month=1000)
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_h4",
        current_period_start=S1,
        current_period_end=E1,
        last_granted_period_end=last_granted,
    )
    sub.plan = plan
    db.add(sub)
    db.commit()
    return client, sub


def _charged(sub_id, period_end, period_start=None, payment_id=None):
    ent = {"id": sub_id, "current_end": int(period_end.timestamp())}
    if period_start is not None:
        ent["current_start"] = int(period_start.timestamp())
    payload = {"subscription": {"entity": ent}}
    if payment_id is not None:
        payload["payment"] = {"entity": {"id": payment_id, "amount": 399900, "currency": "INR"}}
    return payload


def test_grant_subscription_period_is_idempotent_per_period(db):
    _client, sub = _make_sub(db, last_granted=None)

    assert rzp._grant_subscription_period(db, sub, E1) is True
    assert sub.last_granted_period_end == E1

    # Same period again → no grant.
    assert rzp._grant_subscription_period(db, sub, E1) is False

    # New period → grant.
    assert rzp._grant_subscription_period(db, sub, E2) is True
    assert sub.last_granted_period_end == E2


def test_charged_grants_once_per_period(db, monkeypatch):
    _client, sub = _make_sub(db, last_granted=E1)  # activation already granted E1

    calls = []
    original = credit_service.grant_for_subscription
    monkeypatch.setattr(
        rzp.credit_service,
        "grant_for_subscription",
        lambda session, subscription, reference_id=None: (
            calls.append(subscription.id),
            original(session, subscription, reference_id=reference_id),
        )[1],
    )

    # Charged for the already-granted period E1 → no grant.
    rzp._handle_subscription_charged(db, _charged("sub_h4", E1, period_start=S1))
    db.commit()
    assert calls == []

    # Charged for a NEW period E2 → grants once; marker advances.
    rzp._handle_subscription_charged(db, _charged("sub_h4", E2, payment_id="pay_e2"))
    db.commit()
    assert len(calls) == 1
    db.refresh(sub)
    assert sub.last_granted_period_end == E2

    # Replay of the E2 charge (distinct payment, same period) → still one grant.
    rzp._handle_subscription_charged(db, _charged("sub_h4", E2, payment_id="pay_e2_dup"))
    db.commit()
    assert len(calls) == 1
