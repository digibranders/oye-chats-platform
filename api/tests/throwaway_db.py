"""Names for the throwaway databases the DB-backed tests create and drop.

Every one of these sites DROPs its database before it CREATEs it, and the
``pg_engine`` fixture drops with ``(FORCE)``, which terminates whatever is
connected to it. Two suite runs sharing one Postgres therefore destroy each
other: the run that started first loses its database mid-test and reports a
single ``psycopg2.OperationalError: server closed the connection unexpectedly``
wherever it happened to be. Under ``-x`` that is one failed test at an
arbitrary position, on a suite that passes when the file is run on its own and
passes again on the very next run. It reads exactly like a flaky test and it is
not one, which is the worst shape a harness failure can take.

Two of the names ignored ``DB_URL`` altogether (``oyechats_migration_test``,
``oyechats_widget_heartbeat_migration_test``), so even runs deliberately
pointed at different databases collided on them.

The process id is what makes each run's databases its own. It also makes the
leftovers of a run that was killed before its teardown identifiable, which is
what ``drop_stale`` uses: a name whose pid is still alive belongs to a run that
is still going and is never touched.
"""

from __future__ import annotations

import os
import re

from sqlalchemy import text

_MAX_IDENTIFIER_BYTES = 63


def throwaway_db_name(base: str, suffix: str) -> str:
    """The throwaway database name this process may create, drop and recreate.

    ``base`` is the database named by ``DB_URL`` and ``suffix`` the per-fixture
    tag (``_pytest``, ``_afftest``, …). Callers that used a hardcoded name pass
    it as the suffix so their database still varies with ``DB_URL`` too.

    Raises:
        ValueError: when the name would exceed Postgres's 63-byte identifier
            limit. Postgres truncates a longer name and only emits a NOTICE, so
            two runs would silently share a database again, which is the whole
            failure this module exists to remove.
    """
    name = f"{base}{suffix}_{os.getpid()}"
    if len(name.encode()) > _MAX_IDENTIFIER_BYTES:
        raise ValueError(
            f"throwaway database name {name!r} is longer than Postgres allows "
            f"({_MAX_IDENTIFIER_BYTES} bytes); point DB_URL at a shorter database name"
        )
    return name


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        # ``kill(0, 0)`` signals the caller's own process group and ``kill(-n, 0)``
        # a group, neither of which is the question being asked. A name carrying
        # one cannot have come from ``throwaway_db_name``, so it is abandoned.
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Someone else's process, so it exists.
        return True
    return True


def drop_stale(admin_conn, base: str, suffix: str) -> None:
    """Drop this fixture's databases left behind by runs that are gone.

    Only names this module produced are considered, and only when the pid they
    carry is no longer a live process, so a run that is still going never loses
    its database. Best-effort: a database that cannot be dropped (a racing
    teardown got there first) is left for the next run.

    ``admin_conn`` must be an AUTOCOMMIT connection to a database other than
    the ones being dropped.
    """
    # The LIKE is only a prefilter (its unescaped underscores are single-char
    # wildcards, so it over-matches); the regex below is what decides.
    pattern = re.compile(rf"^{re.escape(base + suffix)}_(\d+)$")
    rows = admin_conn.execute(
        text("SELECT datname FROM pg_database WHERE datname LIKE :like"),
        {"like": f"{base}{suffix}_%"},
    ).scalars()
    for name in list(rows):
        match = pattern.match(name)
        if match is None or _pid_is_running(int(match.group(1))):
            continue
        try:
            admin_conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        except Exception:  # noqa: BLE001  another run's teardown beat us to it
            continue
