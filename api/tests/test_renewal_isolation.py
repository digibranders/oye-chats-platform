"""Per-row failure isolation in the subscription-renewal cron (audit F14).

``task_renew_due_subscriptions`` iterated every due subscription and committed
once at the end. Because ``get_session()`` rolls the whole session back on any
exception, a single bad subscription (e.g. a plan/ledger error in
``grant_subscription_period_once``) discarded the credit grants + period rolls
of every *other* subscription in the run — and the cron repeated the failure
daily. Each subscription must be isolated: a failure on one skips only that one.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest

from app.db.models import Client, Invoice, Plan, Subscription
from app.worker import tasks

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="renewal-isolation test needs a reachable Postgres at DB_URL",
)

_S = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
_E = datetime(2026, 1, 31, 12, 0, tzinfo=UTC)  # in the past → due for renewal


def _make_due_sub(db, tag: str) -> Subscription:
    client = Client(name=tag, email=f"{tag}@ex.com", api_key=f"key-{tag}", hashed_password="h")
    db.add(client)
    db.flush()
    plan = Plan(name="Std", slug=f"std-{tag}", monthly_price_cents=399900, credits_per_month=1000)
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id=f"sub_{tag}",
        billing_cycle="monthly",
        current_period_start=_S,
        current_period_end=_E,
    )
    db.add(sub)
    db.flush()
    # Gateway rows renew only against payment evidence (F2): a captured
    # invoice near the period boundary.
    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=sub.id,
            amount_cents=399900,
            currency="inr",
            status="paid",
            kind="plan_charge",
            razorpay_payment_id=f"pay_{tag}",
            paid_at=_E,
        )
    )
    db.commit()
    return sub


def test_one_bad_subscription_does_not_block_the_others(db, monkeypatch):
    s1 = _make_due_sub(db, "a")
    s2 = _make_due_sub(db, "b")  # this one's grant will blow up
    s3 = _make_due_sub(db, "c")

    # Route the cron's session to the throwaway test DB.
    @contextmanager
    def _fake_session():
        yield db

    import app.db.session as db_session
    import app.services.credit_service as credit_service

    monkeypatch.setattr(db_session, "get_session", _fake_session)

    def _grant(session, sub, period_end):
        if sub.id == s2.id:
            raise RuntimeError("simulated ledger error for s2")
        return True

    monkeypatch.setattr(credit_service, "grant_subscription_period_once", _grant)

    renewed = asyncio.run(tasks.task_renew_due_subscriptions({}))

    # s1 and s3 renewed independently despite s2 failing.
    assert renewed == 2
    for s in (s1, s3):
        db.refresh(s)
        assert s.current_period_end > _E, f"{s.razorpay_subscription_id} should have rolled forward"
    # s2 was rolled back — its period did not advance.
    db.refresh(s2)
    assert s2.current_period_end == _E
