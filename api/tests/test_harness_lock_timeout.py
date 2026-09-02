"""The test database refuses to wait forever on a lock.

The ``db`` fixture ends every test with ``TRUNCATE ... CASCADE`` on every
table, which needs an exclusive lock on each. Postgres waits for that lock
indefinitely by default, so a connection left holding a transaction by
something a test started (a background thread, an unclosed session) turned
the next test's teardown into a silent hang: no failure, no output, a CI job
cancelled by hand after half an hour. With a lock timeout the same situation
fails within seconds, on the test whose teardown could not proceed, with
"canceling statement due to lock timeout" in the report.
"""

from __future__ import annotations

from sqlalchemy import text


def test_test_engine_sets_a_lock_timeout(pg_engine):
    with pg_engine.connect() as conn:
        value = conn.execute(text("SHOW lock_timeout")).scalar_one()
    assert value == "30s"


def test_test_engine_sets_a_statement_timeout_under_the_test_timeout(pg_engine):
    """Any single statement is bounded below pytest-timeout's 120s per test,
    so a runaway query is reported as the query, not as a timed-out test."""
    with pg_engine.connect() as conn:
        value = conn.execute(text("SHOW statement_timeout")).scalar_one()
    assert value == "1min"
