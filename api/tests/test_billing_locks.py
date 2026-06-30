"""Per-client billing advisory lock — remediation H1 (real Postgres).

Subscription/trial mutations (start-trial, change-plan, seats, cancel) read the
client's subscription then write, with no row lock. Concurrent requests can both
pass the read-side checks and double-grant credits or clobber each other's
writes. ``lock_client_for_billing`` serializes a client's billing mutations with
a transaction-scoped Postgres advisory lock.

Uses the shared ``pg_engine`` / ``db`` fixtures (conftest). Skips without DB_URL.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.models import Client, Plan
from app.services import plan_service

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="billing-lock tests need a reachable Postgres at DB_URL",
)

_LOCK_SQL = text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))")


def test_billing_lock_is_exclusive_then_released_on_commit(pg_engine):
    """A held lock blocks another session on the same key; commit releases it."""
    s1 = Session(pg_engine)
    s2 = Session(pg_engine)
    try:
        plan_service.lock_client_for_billing(s1, 4242)

        held = s2.execute(_LOCK_SQL, {"k": "oyechats:billing:4242"}).scalar()
        assert held is False  # s1 holds it → second acquirer is refused

        s1.commit()  # transaction-scoped lock released here

        freed = s2.execute(_LOCK_SQL, {"k": "oyechats:billing:4242"}).scalar()
        assert freed is True
    finally:
        s1.close()
        s2.rollback()
        s2.close()


def test_billing_lock_keys_are_per_client(pg_engine):
    """Different clients lock independently (no false contention)."""
    s1 = Session(pg_engine)
    s2 = Session(pg_engine)
    try:
        plan_service.lock_client_for_billing(s1, 1)
        other = s2.execute(_LOCK_SQL, {"k": "oyechats:billing:2"}).scalar()
        assert other is True  # different client key → not blocked
    finally:
        s1.rollback()
        s1.close()
        s2.rollback()
        s2.close()


def test_start_trial_acquires_billing_lock(db, monkeypatch):
    client = Client(name="c", email="lock@e.com", api_key="lk", hashed_password="h")
    db.add(client)
    db.flush()
    plan = Plan(
        name="Starter",
        slug="starter-lock",
        monthly_price_cents=3999,
        credits_per_month=1000,
        trial_days=14,
        is_active=True,
    )
    db.add(plan)
    db.commit()

    seen = []
    original = plan_service.lock_client_for_billing
    monkeypatch.setattr(
        plan_service,
        "lock_client_for_billing",
        lambda session, cid: (seen.append(cid), original(session, cid))[1],
    )

    plan_service.start_trial(db, client.id, "starter-lock")
    assert seen == [client.id]


def test_assign_default_plan_acquires_billing_lock(db, monkeypatch):
    client = Client(name="c2", email="lock2@e.com", api_key="lk2", hashed_password="h")
    db.add(client)
    db.flush()
    # A default plan must exist for assignment.
    db.add(Plan(name="Free", slug="free", monthly_price_cents=0, credits_per_month=200, trial_days=0, is_default=True))
    db.commit()

    seen = []
    original = plan_service.lock_client_for_billing
    monkeypatch.setattr(
        plan_service,
        "lock_client_for_billing",
        lambda session, cid: (seen.append(cid), original(session, cid))[1],
    )

    plan_service.assign_default_plan_to_client(db, client.id)
    assert seen == [client.id]
