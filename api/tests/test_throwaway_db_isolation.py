"""Two suite runs on one Postgres must not destroy each other's databases.

Every DB-backed fixture in this suite DROPs its throwaway database before it
CREATEs it, and ``conftest.pg_engine`` drops with ``(FORCE)``, which terminates
whatever is connected. While those names were fixed, a second run started while
the first was in flight took the first run's database away mid-test: the older
run reported a single ``server closed the connection unexpectedly`` at whatever
test it happened to be on, under ``-x`` that is one failure at an arbitrary
position, and the very next run passed. It reads exactly like a flaky test.

``tests/throwaway_db.py`` puts the pid in the name so the runs cannot meet.
These tests hold that property, and hold the cleanup to only ever removing the
leftovers of runs that are gone.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, make_url, text

from tests.throwaway_db import _MAX_IDENTIFIER_BYTES, drop_stale, throwaway_db_name

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_SUFFIX = "_isolationtest"
# ``throwaway_db_name`` never produces a non-positive pid, so the cleanup treats
# one as abandoned by definition. That makes it a stable stand-in for "a run
# that is gone" without racing a real pid that could be recycled mid-test.
_DEAD_PID = 0


def _admin():
    base = make_url(os.environ["DB_URL"])
    return create_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT"), base.database or "postgres"


def test_the_name_belongs_to_this_process_alone():
    name = throwaway_db_name("oyechats", _SUFFIX)
    assert name == f"oyechats{_SUFFIX}_{os.getpid()}"
    assert name != throwaway_db_name("oyechats", "_other")


def test_an_over_long_name_is_refused_rather_than_silently_truncated():
    """Postgres truncates a >63-byte identifier with only a NOTICE, and two
    runs whose names differ after the cut would land on one database again."""
    base = "b" * _MAX_IDENTIFIER_BYTES
    with pytest.raises(ValueError, match="longer than Postgres allows"):
        throwaway_db_name(base, _SUFFIX)


def test_cleanup_removes_an_abandoned_database_and_spares_a_live_one():
    admin, base_db = _admin()
    abandoned = f"{base_db}{_SUFFIX}_{_DEAD_PID}"
    live = throwaway_db_name(base_db, _SUFFIX)  # this process: still running
    unrelated = f"{base_db}{_SUFFIX}_keepme"  # no pid tag, not ours to drop
    try:
        with admin.connect() as conn:
            for name in (abandoned, live, unrelated):
                conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
                conn.exec_driver_sql(f'CREATE DATABASE "{name}"')

            drop_stale(conn, base_db, _SUFFIX)

            surviving = set(
                conn.execute(
                    text("SELECT datname FROM pg_database WHERE datname LIKE :like"),
                    {"like": f"{base_db}{_SUFFIX}%"},
                ).scalars()
            )
        assert abandoned not in surviving, "a database left by a dead run was not cleaned up"
        assert live in surviving, "cleanup would have pulled the database out of a run that is still going"
        assert unrelated in surviving, "cleanup touched a name it did not create"
    finally:
        with admin.connect() as conn:
            for name in (abandoned, live, unrelated):
                conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        admin.dispose()


def test_no_fixture_still_hardcodes_a_database_name():
    """``oyechats_migration_test`` and ``oyechats_widget_heartbeat_migration_test``
    ignored ``DB_URL`` entirely, so two runs collided on them even when they were
    deliberately pointed at different databases."""
    import pathlib

    root = pathlib.Path(__file__).parent
    offenders = []
    for path in sorted([*root.rglob("test_*.py"), *root.rglob("conftest.py")]):
        source = path.read_text()
        if "CREATE DATABASE" in source and "throwaway_db_name" not in source:
            offenders.append(path.name)
    assert offenders == [], f"these build a throwaway database without throwaway_db_name: {offenders}"
