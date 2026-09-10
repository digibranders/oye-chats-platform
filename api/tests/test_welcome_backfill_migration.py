"""Run ``b1000013welcomebackfill`` against rows a real deployment would hold.

The shared ``db`` fixture builds the schema with ``Base.metadata.create_all``
and never runs Alembic, so a data migration is exercised nowhere else. This
brings a throwaway database to the revision just before the backfill, seeds
bots in each state the migration must tell apart, runs the chain to head, and
checks every row. Same harness as ``test_invoicing_migrations``.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, make_url, text

from tests.throwaway_db import drop_stale, throwaway_db_name

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_TMP_DB_SUFFIX = "_welcome_backfill"
_PREVIOUS_REVISION = "b1000012auditindex"
_REVISION = "b1000013welcomebackfill"

SEEDED_TITLE = "Hi there 👋"
SEEDED_SUBTITLE = "How can we help you today?"
SEEDED_JSONB_GREETING = "Hi There, How can I help you today?"

LONG_GREETING = "G" * 250
LONG_SUBTITLE = "S" * 600


def _server_url(db_url: str) -> str:
    return db_url.rsplit("/", 1)[0]


def _seed(conn) -> None:
    conn.execute(
        text(
            "INSERT INTO clients (id, name, email, api_key, is_superadmin) "
            "VALUES (1, 'Acme', 'owner@acme.example', 'key_welcome_backfill', false)"
        )
    )
    rows = [
        # Typed both before the fix; columns untouched. Both copy.
        ("bot-typed", '{"welcome_greeting": "Welcome to Acme!", "welcome_subtitle": "Ask us anything"}', None, None),
        # Typed values longer than the API accepts. Copied and cut.
        (
            "bot-long",
            f'{{"welcome_greeting": "  {LONG_GREETING}  ", "welcome_subtitle": "{LONG_SUBTITLE}"}}',
            None,
            None,
        ),
        # Column already customised through the fixed console. Left alone.
        ("bot-custom", '{"welcome_greeting": "Old words", "welcome_subtitle": "Old subtitle"}', "New title", "New sub"),
        # Never typed anything: the JSONB carries only its own seeded greeting.
        ("bot-untouched", f'{{"welcome_greeting": "{SEEDED_JSONB_GREETING}"}}', None, None),
        # Blank string and a non-string value are not a greeting.
        ("bot-blank", '{"welcome_greeting": "   ", "welcome_subtitle": 42}', None, None),
        # Only the subtitle was typed. The title keeps its default.
        ("bot-subtitle-only", '{"welcome_subtitle": "We reply in minutes"}', None, None),
    ]
    for bot_key, messages, title, subtitle in rows:
        columns = ["client_id", "bot_key", "widget_messages"]
        values = ["1", ":bot_key", "CAST(:messages AS jsonb)"]
        params: dict[str, object] = {"bot_key": bot_key, "messages": messages}
        if title is not None:
            columns.append("welcome_title")
            values.append(":title")
            params["title"] = title
        if subtitle is not None:
            columns.append("welcome_subtitle")
            values.append(":subtitle")
            params["subtitle"] = subtitle
        conn.execute(
            text(f"INSERT INTO bots ({', '.join(columns)}) VALUES ({', '.join(values)})"),
            params,
        )


def _read(conn) -> dict[str, tuple[str, str, dict]]:
    result = conn.execute(text("SELECT bot_key, welcome_title, welcome_subtitle, widget_messages FROM bots"))
    return {row[0]: (row[1], row[2], row[3]) for row in result}


def test_welcome_backfill_copies_only_stranded_customer_text(monkeypatch):
    from alembic.config import Config

    import app.config as app_config
    from alembic import command

    base_url = os.environ["DB_URL"]
    server = _server_url(base_url)
    base_db = make_url(base_url).database or "postgres"
    tmp_db = throwaway_db_name(base_db, _TMP_DB_SUFFIX)
    admin = create_engine(f"{server}/postgres", isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        drop_stale(conn, base_db, _TMP_DB_SUFFIX)
        conn.execute(text(f"DROP DATABASE IF EXISTS {tmp_db}"))
        conn.execute(text(f"CREATE DATABASE {tmp_db}"))

    tmp_url = f"{server}/{tmp_db}"
    tmp_admin = create_engine(tmp_url, isolation_level="AUTOCOMMIT")
    with tmp_admin.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    tmp_admin.dispose()
    eng = None
    try:
        monkeypatch.setattr(app_config, "DB_URL", tmp_url)
        cfg = Config()
        cfg.set_main_option("script_location", "alembic")

        command.upgrade(cfg, _PREVIOUS_REVISION)

        eng = create_engine(tmp_url)
        with eng.begin() as conn:
            _seed(conn)
        with eng.connect() as conn:
            before = _read(conn)
        # The seeded columns are what the rows start with, so the migration's
        # "still the default" clause is being tested against real defaults.
        assert before["bot-typed"][:2] == (SEEDED_TITLE, SEEDED_SUBTITLE)

        command.upgrade(cfg, _REVISION)

        with eng.connect() as conn:
            after = _read(conn)

        assert after["bot-typed"][:2] == ("Welcome to Acme!", "Ask us anything")

        title, subtitle, _ = after["bot-long"]
        assert title == "G" * 200
        assert subtitle == "S" * 500

        assert after["bot-custom"][:2] == ("New title", "New sub")
        assert after["bot-untouched"][:2] == (SEEDED_TITLE, SEEDED_SUBTITLE)
        assert after["bot-blank"][:2] == (SEEDED_TITLE, SEEDED_SUBTITLE)
        assert after["bot-subtitle-only"][:2] == (SEEDED_TITLE, "We reply in minutes")

        # The JSONB is left exactly as it was: the copy drops nothing.
        for key, (_, _, messages) in after.items():
            assert messages == before[key][2]

        # Downgrade is a documented no-op; the columns keep what was copied.
        command.downgrade(cfg, _PREVIOUS_REVISION)
        with eng.connect() as conn:
            assert _read(conn) == after

        # And running it again copies nothing more (the columns are no longer
        # at their defaults), so a re-run on a deployed database is safe.
        command.upgrade(cfg, _REVISION)
        with eng.connect() as conn:
            assert _read(conn) == after
    finally:
        if eng is not None:
            eng.dispose()
        with admin.connect() as conn:
            conn.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :db AND pid <> pg_backend_pid()"
                ),
                {"db": tmp_db},
            )
            conn.execute(text(f"DROP DATABASE IF EXISTS {tmp_db}"))
        admin.dispose()
