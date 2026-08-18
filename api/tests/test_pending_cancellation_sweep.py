"""Deferred gateway cancellation, the sweep, and the guards around it.

``POST /subscriptions/cancel`` no longer cancels at Razorpay. It records the
customer's intent (``cancel_at_period_end``) and leaves the mandate live so
reactivating stays free and instant; ``task_execute_pending_cancellations``
issues the irreversible cancel a couple of days before the period ends.

That trade only holds if three things are true, and each is asserted here:

* the sweep actually fires, exactly once, and only inside the lead window;
* the renewal cron never hands a cancel-pending subscription a fresh month of
  credits while it waits (its status stays ``active`` the whole time, so
  without an explicit filter it matched);
* if the sweep is late enough that Razorpay renews anyway, the charge webhook
  catches it, cancels immediately and withholds the grant. Bounding the worst
  case at one cycle instead of an open-ended subscription.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, Plan, Subscription
from app.worker import tasks

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="pending-cancellation sweep tests need a reachable Postgres at DB_URL",
)


def _make_sub(
    db,
    tag: str,
    *,
    period_end: datetime,
    cancel_at_period_end: bool = True,
    gateway_cancel_executed_at: datetime | None = None,
    status: str = "active",
) -> Subscription:
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
        status=status,
        payment_provider="razorpay",
        razorpay_subscription_id=f"sub_{tag}",
        billing_cycle="monthly",
        cancel_at_period_end=cancel_at_period_end,
        gateway_cancel_executed_at=gateway_cancel_executed_at,
        current_period_start=period_end - timedelta(days=30),
        current_period_end=period_end,
    )
    db.add(sub)
    db.commit()
    return sub


@contextmanager
def _cm(session):
    yield session


def _route_session(monkeypatch, db) -> None:
    import app.db.session as db_session

    monkeypatch.setattr(db_session, "get_session", lambda: _cm(db))


# ── The sweep ─────────────────────────────────────────────────────────────────


def test_sweep_cancels_only_inside_the_lead_window(db, monkeypatch):
    """A cancellation 20 days out must stay reversible; one 1 day out must not.

    Cancelling early is the whole bug: Razorpay has no un-cancel, so every day
    the sweep runs ahead of schedule is a day the customer loses the option to
    change their mind for free.
    """
    due = _make_sub(db, "sweep-due", period_end=datetime.now(UTC) + timedelta(days=1))
    far = _make_sub(db, "sweep-far", period_end=datetime.now(UTC) + timedelta(days=20))
    _route_session(monkeypatch, db)

    cancelled: list[str] = []
    import app.services.razorpay_service as rzp

    monkeypatch.setattr(rzp, "cancel_subscription", lambda sub, **kw: cancelled.append(sub.razorpay_subscription_id))

    count = asyncio.run(tasks.task_execute_pending_cancellations({}))

    assert count == 1
    assert cancelled == ["sub_sweep-due"]
    db.refresh(due)
    db.refresh(far)
    assert due.gateway_cancel_executed_at is not None
    assert far.gateway_cancel_executed_at is None


def test_sweep_cancels_at_cycle_end_not_immediately(db, monkeypatch):
    """The customer paid through ``current_period_end`` and keeps access until
    then, so the gateway cancel must be ``cancel_at_cycle_end=1``. Cancelling
    immediately would void service they already own."""
    _make_sub(db, "sweep-atend", period_end=datetime.now(UTC) + timedelta(days=1))
    _route_session(monkeypatch, db)

    seen: list[bool] = []
    import app.services.razorpay_service as rzp

    monkeypatch.setattr(rzp, "cancel_subscription", lambda sub, **kw: seen.append(kw["at_period_end"]))

    asyncio.run(tasks.task_execute_pending_cancellations({}))

    assert seen == [True]


def test_sweep_is_idempotent(db, monkeypatch):
    """Re-running the cron must not issue a second cancel, the marker is the
    guard, and Razorpay would reject (or worse, act on) a repeat."""
    _make_sub(db, "sweep-idem", period_end=datetime.now(UTC) + timedelta(days=1))
    _route_session(monkeypatch, db)

    calls: list[str] = []
    import app.services.razorpay_service as rzp

    monkeypatch.setattr(rzp, "cancel_subscription", lambda sub, **kw: calls.append(sub.razorpay_subscription_id))

    first = asyncio.run(tasks.task_execute_pending_cancellations({}))
    second = asyncio.run(tasks.task_execute_pending_cancellations({}))

    assert (first, second) == (1, 0)
    assert len(calls) == 1


def test_sweep_ignores_subscriptions_that_were_never_cancelled(db, monkeypatch):
    """Period end alone is not a reason to cancel. That's a renewal."""
    _make_sub(
        db,
        "sweep-active",
        period_end=datetime.now(UTC) + timedelta(hours=6),
        cancel_at_period_end=False,
    )
    _route_session(monkeypatch, db)

    import app.services.razorpay_service as rzp

    calls: list[str] = []
    monkeypatch.setattr(rzp, "cancel_subscription", lambda sub, **kw: calls.append("x"))

    assert asyncio.run(tasks.task_execute_pending_cancellations({})) == 0
    assert calls == []


def test_sweep_skips_a_row_resume_un_cancelled_under_the_lock(db, monkeypatch):
    """The sweep/resume race.

    Both mutate the same row, so the sweep takes the same advisory lock every
    billing mutation takes and re-reads under it. If ``/resume`` cleared the
    cancellation between the sweep's SELECT and its turn at the lock, cancelling
    anyway would kill a mandate the customer just chose to keep, and the row
    would sit there promising a renewal that never comes.
    """
    sub = _make_sub(db, "sweep-raced", period_end=datetime.now(UTC) + timedelta(days=1))
    _route_session(monkeypatch, db)

    import app.services.razorpay_service as rzp

    calls: list[str] = []
    monkeypatch.setattr(rzp, "cancel_subscription", lambda s, **kw: calls.append("cancelled"))

    # Simulate resume winning the race: it commits the un-cancel after the
    # sweep's SELECT but before the sweep reaches this row.
    from app.services import plan_service

    def _lock_then_resume_wins(session, client_id):
        session.query(type(sub)).filter_by(id=sub.id).update({"cancel_at_period_end": False})
        session.commit()

    monkeypatch.setattr(plan_service, "lock_client_for_billing", _lock_then_resume_wins)

    assert asyncio.run(tasks.task_execute_pending_cancellations({})) == 0
    assert calls == [], "must not cancel a mandate the customer just kept"
    db.refresh(sub)
    assert sub.gateway_cancel_executed_at is None


def test_sweep_isolates_a_failing_gateway_cancel(db, monkeypatch):
    """One unreachable mandate must not abort the rest of the run, and the
    failed row must keep its NULL marker so the next run retries it."""
    bad = _make_sub(db, "sweep-bad", period_end=datetime.now(UTC) + timedelta(days=1))
    good = _make_sub(db, "sweep-good", period_end=datetime.now(UTC) + timedelta(days=1))
    _route_session(monkeypatch, db)

    import app.services.razorpay_service as rzp

    def _cancel(sub, **kw):
        if sub.razorpay_subscription_id == "sub_sweep-bad":
            raise rzp.RazorpayBillingError("gateway down")

    monkeypatch.setattr(rzp, "cancel_subscription", _cancel)

    count = asyncio.run(tasks.task_execute_pending_cancellations({}))

    assert count == 1
    db.refresh(bad)
    db.refresh(good)
    assert bad.gateway_cancel_executed_at is None, "must retry next run"
    assert good.gateway_cancel_executed_at is not None


# ── The renewal cron must not pay out to a cancelled subscription ─────────────


def test_renewal_cron_skips_cancel_pending_subscriptions(db, monkeypatch):
    """A cancel-pending row keeps ``status='active'`` until Razorpay's cancelled
    webhook lands at cycle end. Without an explicit filter this cron matched it
    and handed out a full free month of credits, then rolled the period forward
    on a subscription that will never be paid for again."""
    cancelling = _make_sub(db, "renew-cancelling", period_end=datetime.now(UTC) - timedelta(hours=2))
    renewing = _make_sub(
        db,
        "renew-normal",
        period_end=datetime.now(UTC) - timedelta(hours=2),
        cancel_at_period_end=False,
    )
    # Gateway rows renew only against payment evidence (F2).
    from app.db.models import Invoice

    db.add(
        Invoice(
            client_id=renewing.client_id,
            subscription_id=renewing.id,
            amount_cents=399900,
            currency="inr",
            status="paid",
            kind="plan_charge",
            razorpay_payment_id="pay_renew_normal",
            paid_at=renewing.current_period_end,
        )
    )
    db.commit()
    _route_session(monkeypatch, db)

    import app.services.credit_service as credit_service

    granted: list[int] = []

    def _grant(session, sub, period_end):
        granted.append(sub.id)
        return True

    monkeypatch.setattr(credit_service, "grant_subscription_period_once", _grant)

    renewed = asyncio.run(tasks.task_renew_due_subscriptions({}))

    assert renewed == 1
    assert granted == [renewing.id]
    db.refresh(cancelling)
    # Its period must NOT roll forward either. That would relabel the plan as
    # ending a month later than the customer was told.
    assert cancelling.current_period_end < datetime.now(UTC)
