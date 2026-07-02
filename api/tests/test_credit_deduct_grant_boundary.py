"""Multi-grant FIFO deduction regression (real Postgres).

A deduction that spans two grants writes TWO ledger rows in one flush.
SQLAlchemy batches that flush through its insertmanyvalues path, which binds
params as typed VARCHAR — with ``credit_ledger.reason`` declared as a plain
String the native PG ENUM column rejected the insert (DatatypeMismatch), the
page transaction rolled back, and — because the rollback preserved the grant
boundary — every subsequent deduction failed identically. Seen in prod
2026-07-02: 299 crawl pages silently skipped mid-crawl.

The fix types the model column as the native ``credit_reason`` enum. This
test drives the exact two-grant flush against a real Postgres; it skips when
no server is reachable at ``DB_URL`` (mirrors test_credit_service_clawback).
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, make_url, select
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.db.models import Base, Client, CreditLedger
from app.services import credit_service

_TEST_DB_SUFFIX = "_grantboundary"


def _server_url():
    raw = os.getenv("DB_URL")
    return make_url(raw) if raw else None


def _server_reachable(url) -> bool:
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 2})
        with engine.connect():
            pass
        engine.dispose()
        return True
    except Exception:
        return False


_BASE_URL = _server_url()

pytestmark = pytest.mark.skipif(
    _BASE_URL is None or not _server_reachable(_BASE_URL),
    reason="grant-boundary integration test needs a reachable Postgres at DB_URL",
)


@pytest.fixture(scope="module")
def pg_engine():
    test_db = (_BASE_URL.database or "postgres") + _TEST_DB_SUFFIX
    admin = create_engine(_BASE_URL.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}"')
        conn.exec_driver_sql(f'CREATE DATABASE "{test_db}"')
    admin.dispose()

    engine = create_engine(_BASE_URL.set(database=test_db))
    with engine.connect() as conn:
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS citext")
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
        conn.commit()
    Base.metadata.create_all(engine)
    # Prod's schema is alembic-managed: the column IS the native enum no
    # matter what the model says. Pin the test DB the same way so a model
    # regression back to String reproduces the DatatypeMismatch instead of
    # silently degrading this test to varchar-vs-varchar.
    with engine.connect() as conn:
        conn.exec_driver_sql(
            """
            DO $$ BEGIN
                CREATE TYPE credit_reason AS ENUM (
                    'plan_grant','topup','ai_chat','url_scan','email_send',
                    'manual_adjust','refund','expiry','document_upload');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$
            """
        )
        conn.exec_driver_sql(
            "ALTER TABLE credit_ledger ALTER COLUMN reason TYPE credit_reason USING reason::credit_reason"
        )
        conn.commit()
    yield engine
    engine.dispose()

    admin = create_engine(_BASE_URL.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}"')
    admin.dispose()


@pytest.fixture()
def db(pg_engine):
    # autoflush=False mirrors app.db.session.SessionLocal — it's a required
    # ingredient of the bug: with autoflush on, the balance query between the
    # two ledger adds flushes them one-by-one and the batched insert (the
    # failing statement) never happens.
    session = Session(pg_engine, autoflush=False)
    yield session
    session.rollback()
    names = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    session.execute(sa_text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
    session.commit()
    session.close()


def _mk_client(db) -> Client:
    c = Client(name="GB", email="gb@e.com", api_key="gb-key", hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _grant(db, client_id: int, amount: int) -> CreditLedger:
    row = CreditLedger(client_id=client_id, delta=amount, reason="plan_grant")
    db.add(row)
    db.flush()
    return row


def test_deduction_spanning_two_grants_writes_both_rows(db):
    """10 remaining in grant A + 90 in grant B, deduct 30 → two ledger rows
    flush together (the insertmanyvalues path that used to DatatypeMismatch)."""
    # Guard: the column must be the native enum (as in prod) or this test
    # silently degrades to varchar-vs-varchar and can't catch the regression.
    udt = db.execute(
        sa_text(
            "select udt_name from information_schema.columns where table_name='credit_ledger' and column_name='reason'"
        )
    ).scalar()
    assert udt == "credit_reason", f"test schema drifted: reason column is {udt}"

    client = _mk_client(db)
    grant_a = _grant(db, client.id, 10)
    grant_b = _grant(db, client.id, 90)
    db.commit()

    new_balance = credit_service.check_and_deduct(db, client.id, 30, reason="url_scan")
    db.commit()

    assert new_balance == 70
    rows = db.execute(select(CreditLedger).where(CreditLedger.delta < 0).order_by(CreditLedger.id)).scalars().all()
    assert [(r.grant_id, r.delta, r.reason) for r in rows] == [
        (grant_a.id, -10, "url_scan"),
        (grant_b.id, -20, "url_scan"),
    ]
    assert credit_service.get_balance(db, client.id) == 70


def test_repeated_deductions_after_boundary_keep_working(db):
    """The prod failure mode: after the boundary-straddling deduction, later
    single-grant deductions must keep succeeding."""
    client = _mk_client(db)
    _grant(db, client.id, 10)
    _grant(db, client.id, 90)
    db.commit()

    credit_service.check_and_deduct(db, client.id, 30, reason="url_scan")
    db.commit()
    for _ in range(3):
        credit_service.check_and_deduct(db, client.id, 5, reason="url_scan")
        db.commit()

    assert credit_service.get_balance(db, client.id) == 100 - 30 - 15
