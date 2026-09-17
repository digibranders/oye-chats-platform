"""Every existing bot gets a saved default recipient list.

Production audit, 2026-09-17: all eight bots had no recipients saved, so the
console showed an empty field while mail actually went to the owner through
the send-time fallback. ``b1000015recipientsbackfill``:

1. moves a legacy comma-separated ``notification_email`` into
   ``notification_emails.default`` (the resolver already read it right after
   the default list, so delivery does not change);
2. saves the owner's account email as the default list on every bot that still
   has none, which is where the fallback already sent that mail;
3. for Eventus (``bot-2cd622e21f80``) and the eval bot (``bot-7b18925d18a7``)
   saves gaurav@fynix.digital instead, as the product owner asked.

Per-event lists are never touched, and a saved default list is never replaced.
The shared ``db`` fixture never runs Alembic, so this runs the migration
against a throwaway database, like ``test_queue_timeout_default_migration``.
"""

from __future__ import annotations

import json
import os

import pytest
from sqlalchemy import create_engine, make_url, text

from tests.throwaway_db import drop_stale, throwaway_db_name

_TMP_DB_SUFFIX = "_recipients_backfill"
_PREVIOUS_REVISION = "b1000014queuetimeout"
_REVISION = "b1000015recipientsbackfill"

OWNER = "owner@acme.example"
NAMED = "gaurav@fynix.digital"


def _server_url(db_url: str) -> str:
    return db_url.rsplit("/", 1)[0]


def _insert_bot(conn, bot_key: str, *, emails: object = None, legacy: str | None = None, client_id: int = 1) -> None:
    conn.execute(
        text(
            "INSERT INTO bots (client_id, bot_key, notification_emails, notification_email) "
            "VALUES (:client_id, :bot_key, CAST(:emails AS jsonb), :legacy)"
        ),
        {
            "client_id": client_id,
            "bot_key": bot_key,
            "emails": None if emails is None else json.dumps(emails),
            "legacy": legacy,
        },
    )


def _routing(conn) -> dict[str, tuple[object, str | None]]:
    rows = conn.execute(text("SELECT bot_key, notification_emails, notification_email FROM bots"))
    return {row[0]: (row[1], row[2]) for row in rows}


@pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")
def test_every_bot_ends_with_the_address_its_mail_already_went_to(monkeypatch):
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
            conn.execute(
                text(
                    "INSERT INTO clients (id, name, email, api_key, is_superadmin) VALUES "
                    f"(1, 'Acme', ' {OWNER} ', 'key_backfill_1', false), "
                    "(2, 'Eventus', 'eventus@acme.example', 'key_backfill_2', false)"
                )
            )
            _insert_bot(conn, "bot-nothing")
            _insert_bot(conn, "bot-json-null", emails=None)
            conn.execute(text("UPDATE bots SET notification_emails = 'null'::jsonb WHERE bot_key = 'bot-json-null'"))
            _insert_bot(conn, "bot-empty-object", emails={})
            _insert_bot(conn, "bot-blank-default", emails={"default": ["", "  "]})
            _insert_bot(conn, "bot-saved-default", emails={"default": ["team@acme.example"]})
            _insert_bot(
                conn,
                "bot-events-only",
                emails={"qualified_lead": ["sales@acme.example"], "default": []},
            )
            _insert_bot(conn, "bot-legacy", legacy=" a@acme.example, ,b@acme.example ")
            _insert_bot(conn, "bot-legacy-blank", legacy="   ")
            _insert_bot(
                conn,
                "bot-legacy-and-default",
                emails={"default": ["team@acme.example"]},
                legacy="old@acme.example",
            )
            _insert_bot(conn, "bot-2cd622e21f80", client_id=2)
            _insert_bot(conn, "bot-7b18925d18a7")
            _insert_bot(conn, "bot-named-but-saved", emails={"default": ["kept@acme.example"]}, client_id=2)
            conn.execute(text("UPDATE bots SET bot_key = 'bot-2cd622e21f80-x' WHERE bot_key = 'bot-named-but-saved'"))

        command.upgrade(cfg, _REVISION)

        with eng.connect() as conn:
            routing = _routing(conn)
        assert routing == {
            "bot-nothing": ({"default": [OWNER]}, None),
            "bot-json-null": ({"default": [OWNER]}, None),
            "bot-empty-object": ({"default": [OWNER]}, None),
            "bot-blank-default": ({"default": [OWNER]}, None),
            "bot-saved-default": ({"default": ["team@acme.example"]}, None),
            "bot-events-only": ({"qualified_lead": ["sales@acme.example"], "default": [OWNER]}, None),
            "bot-legacy": ({"default": ["a@acme.example", "b@acme.example"]}, None),
            "bot-legacy-blank": ({"default": [OWNER]}, None),
            # A saved list already outranked the legacy field, so the legacy
            # value was never used; it stays where it is.
            "bot-legacy-and-default": ({"default": ["team@acme.example"]}, "old@acme.example"),
            "bot-2cd622e21f80": ({"default": [NAMED]}, None),
            "bot-7b18925d18a7": ({"default": [NAMED]}, None),
            "bot-2cd622e21f80-x": ({"default": ["kept@acme.example"]}, None),
        }

        # Downgrade keeps the data: nothing it could restore is distinguishable
        # from a list saved in the console afterwards.
        command.downgrade(cfg, _PREVIOUS_REVISION)
        with eng.connect() as conn:
            assert _routing(conn) == routing

        # Running it again changes nothing.
        command.upgrade(cfg, _REVISION)
        with eng.connect() as conn:
            assert _routing(conn) == routing
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
