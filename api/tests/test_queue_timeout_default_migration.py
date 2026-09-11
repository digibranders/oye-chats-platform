"""The live chat queue timeout defaults to 60 seconds, for new bots and existing ones.

Product owner, 2026-09-11: 20 seconds was too short for an operator to come
back from another tab or open a push on their phone before the widget offered
"Leave a message". ``b1000014queuetimeout`` moves the column default to 60 and
lifts every bot still on the old default of 20; a bot someone set to any other
value keeps it.

The shared ``db`` fixture builds the schema with ``Base.metadata.create_all``
and never runs Alembic, so the migration is run here against a throwaway
database, the same harness as ``test_welcome_backfill_migration``.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, make_url, text

from app.db.models import Bot
from tests.throwaway_db import drop_stale, throwaway_db_name

_TMP_DB_SUFFIX = "_queue_timeout"
_PREVIOUS_REVISION = "b1000013welcomebackfill"
_REVISION = "b1000014queuetimeout"

_NEW_DEFAULT = 60
_OLD_DEFAULT = 20


class TestEveryDefaultIsSixtySeconds:
    def test_the_model_default_matches_the_migration(self):
        column = Bot.__table__.c.live_chat_queue_timeout_seconds
        assert column.default.arg == _NEW_DEFAULT
        assert column.server_default.arg == str(_NEW_DEFAULT)

    def test_the_websocket_push_fallback_matches_the_column(self):
        from app.api import ws_routes

        assert ws_routes.DEFAULT_QUEUE_TIMEOUT_SECONDS == _NEW_DEFAULT

    def test_the_bot_response_default_matches_the_column(self):
        from app.api.bot_routes import BotResponse

        assert BotResponse.model_fields["live_chat_queue_timeout_seconds"].default == _NEW_DEFAULT


def _server_url(db_url: str) -> str:
    return db_url.rsplit("/", 1)[0]


def _insert_bot(conn, bot_key: str, timeout: int | None) -> None:
    if timeout is None:
        conn.execute(text("INSERT INTO bots (client_id, bot_key) VALUES (1, :bot_key)"), {"bot_key": bot_key})
        return
    conn.execute(
        text("INSERT INTO bots (client_id, bot_key, live_chat_queue_timeout_seconds) VALUES (1, :bot_key, :timeout)"),
        {"bot_key": bot_key, "timeout": timeout},
    )


def _timeouts(conn) -> dict[str, int]:
    result = conn.execute(text("SELECT bot_key, live_chat_queue_timeout_seconds FROM bots"))
    return {row[0]: row[1] for row in result}


def _column_default(conn) -> str:
    return conn.execute(
        text(
            "SELECT column_default FROM information_schema.columns "
            "WHERE table_name = 'bots' AND column_name = 'live_chat_queue_timeout_seconds'"
        )
    ).scalar_one()


@pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")
def test_bots_on_the_old_default_move_to_sixty_and_custom_values_stay(monkeypatch):
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
                    "INSERT INTO clients (id, name, email, api_key, is_superadmin) "
                    "VALUES (1, 'Acme', 'owner@acme.example', 'key_queue_timeout', false)"
                )
            )
            # Created before the change and never edited: carries the old server default.
            _insert_bot(conn, "bot-untouched", None)
            # Saved from the console with the old default still in the field.
            _insert_bot(conn, "bot-saved-at-twenty", _OLD_DEFAULT)
            # Chosen by a customer. Left alone, shorter or longer.
            _insert_bot(conn, "bot-short", 10)
            _insert_bot(conn, "bot-long", 45)
        with eng.connect() as conn:
            assert _timeouts(conn)["bot-untouched"] == _OLD_DEFAULT

        command.upgrade(cfg, _REVISION)

        with eng.begin() as conn:
            assert _timeouts(conn) == {
                "bot-untouched": _NEW_DEFAULT,
                "bot-saved-at-twenty": _NEW_DEFAULT,
                "bot-short": 10,
                "bot-long": 45,
            }
            assert _column_default(conn) == str(_NEW_DEFAULT)
            _insert_bot(conn, "bot-created-after", None)
        with eng.connect() as conn:
            assert _timeouts(conn)["bot-created-after"] == _NEW_DEFAULT

        # Downgrade restores the old server default and leaves the data as it is.
        command.downgrade(cfg, _PREVIOUS_REVISION)
        with eng.begin() as conn:
            assert _column_default(conn) == str(_OLD_DEFAULT)
            assert _timeouts(conn)["bot-untouched"] == _NEW_DEFAULT
            _insert_bot(conn, "bot-created-on-rollback", None)

        # Upgrading again lifts the bot created while rolled back, and nothing else moves.
        command.upgrade(cfg, _REVISION)
        with eng.connect() as conn:
            timeouts = _timeouts(conn)
        assert timeouts["bot-created-on-rollback"] == _NEW_DEFAULT
        assert timeouts["bot-short"] == 10
        assert timeouts["bot-long"] == 45
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
