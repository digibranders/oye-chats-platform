"""B6: the renewal cron must keep a month-end billing anchor (real Postgres).

``task_renew_due_subscriptions`` rolled the period with
``add_months(current_period_end, n)``. The first time a 31st anchor crossed
February the day was clamped to the 28th, and because the clamped value became
the input for the next roll it never recovered: the customer was billed three
days early, forever, and the credit period drifted with it.
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
    reason="renewal-anchor test needs a reachable Postgres at DB_URL",
)

_JAN_31 = datetime(2026, 1, 31, 12, 0, tzinfo=UTC)
_FEB_28 = datetime(2026, 2, 28, 12, 0, tzinfo=UTC)
_MAR_31 = datetime(2026, 3, 31, 12, 0, tzinfo=UTC)


def _make_due_sub(db, tag: str, *, period_start: datetime, period_end: datetime) -> Subscription:
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
        current_period_start=period_start,
        current_period_end=period_end,
    )
    db.add(sub)
    db.flush()
    # Gateway rows renew only against payment evidence (F2).
    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=sub.id,
            amount_cents=399900,
            currency="inr",
            status="paid",
            kind="plan_charge",
            razorpay_payment_id=f"pay_{tag}",
            paid_at=period_end,
        )
    )
    db.commit()
    return sub


@contextmanager
def _session_cm(session):
    yield session


def test_february_clamp_is_re_expanded_in_march(db, monkeypatch):
    # The subscription is anchored on the 31st and its current period was
    # already clamped to Feb 28 by the previous roll.
    sub = _make_due_sub(db, "anchor31", period_start=_JAN_31, period_end=_FEB_28)

    import app.db.session as db_session

    monkeypatch.setattr(db_session, "get_session", lambda: _session_cm(db))

    assert asyncio.run(tasks.task_renew_due_subscriptions({})) == 1

    db.refresh(sub)
    assert sub.current_period_start == _FEB_28
    assert sub.current_period_end == _MAR_31, "a 31st anchor must not stay stuck on the 28th"


def test_a_genuine_month_day_anchor_is_left_alone(db, monkeypatch):
    sub = _make_due_sub(
        db,
        "anchor15",
        period_start=datetime(2026, 1, 15, 12, 0, tzinfo=UTC),
        period_end=datetime(2026, 2, 15, 12, 0, tzinfo=UTC),
    )

    import app.db.session as db_session

    monkeypatch.setattr(db_session, "get_session", lambda: _session_cm(db))

    assert asyncio.run(tasks.task_renew_due_subscriptions({})) == 1

    db.refresh(sub)
    assert sub.current_period_end == datetime(2026, 3, 15, 12, 0, tzinfo=UTC)
