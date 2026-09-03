"""Parity tests for the per-test database reset in ``conftest.py``.

``reset_database`` must leave the database exactly as ``TRUNCATE <every table>
RESTART IDENTITY CASCADE`` did: no rows anywhere and every owned sequence back
at its start. Covered here: the fast path (rows deleted with foreign-key
enforcement off, only the used sequences restarted), the two cases a naive
"truncate the non-empty tables" reset gets wrong (an INSERT that was rolled
back or deleted has still advanced its sequence), the TRUNCATE fallback, and
the wiring of the ``db`` fixture itself.
"""

import os

import pytest
from sqlalchemy import text

from app.db.models import Bot, Client
from tests.conftest import dirty_tables, reset_database, used_sequences

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _add_client(db, n: int = 1) -> Client:
    client = Client(name=f"C{n}", email=f"c{n}@e.com", api_key=f"k{n}", hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _add_bot(db, client: Client) -> Bot:
    bot = Bot(client_id=client.id, bot_key=f"bot-{client.id}", name="B", is_legacy_pooled=False)
    db.add(bot)
    db.flush()
    return bot


def _count(db, table: str) -> int:
    return db.execute(text(f'SELECT count(*) FROM "{table}"')).scalar_one()


def test_clean_database_reports_nothing_to_reset(db):
    assert dirty_tables(db) == set()
    assert used_sequences(db) == set()


def test_reset_clears_rows_across_a_foreign_key_and_restarts_identities(db, fk_checks_switchable):
    client = _add_client(db)
    _add_bot(db, client)
    db.commit()
    assert dirty_tables(db) == {"clients", "bots"}
    assert used_sequences(db) == {"clients_id_seq", "bots_id_seq"}

    reset_database(db, fk_checks_switchable=fk_checks_switchable)

    assert dirty_tables(db) == set()
    assert used_sequences(db) == set()
    assert _count(db, "clients") == 0
    assert _count(db, "bots") == 0
    client = _add_client(db, n=2)
    assert client.id == 1
    assert _add_bot(db, client).id == 1


def test_rolled_back_insert_still_restarts_its_sequence(db, fk_checks_switchable):
    _add_client(db)
    db.rollback()
    assert dirty_tables(db) == set()
    assert used_sequences(db) == {"clients_id_seq"}

    reset_database(db, fk_checks_switchable=fk_checks_switchable)

    assert used_sequences(db) == set()
    assert _add_client(db, n=2).id == 1


def test_deleted_rows_still_restart_their_sequence(db, fk_checks_switchable):
    client = _add_client(db)
    db.commit()
    db.delete(client)
    db.commit()
    assert dirty_tables(db) == set()
    assert used_sequences(db) == {"clients_id_seq"}

    reset_database(db, fk_checks_switchable=fk_checks_switchable)

    assert used_sequences(db) == set()
    assert _add_client(db, n=2).id == 1


def test_truncate_fallback_produces_the_same_state(db):
    client = _add_client(db)
    _add_bot(db, client)
    db.commit()

    reset_database(db, fk_checks_switchable=False)

    assert dirty_tables(db) == set()
    assert used_sequences(db) == set()
    client = _add_client(db, n=2)
    assert client.id == 1
    assert _add_bot(db, client).id == 1


def test_fast_path_leaves_foreign_key_enforcement_on_afterwards(db, fk_checks_switchable):
    if not fk_checks_switchable:
        pytest.skip("the fast path needs a superuser role")
    _add_client(db)
    db.commit()
    reset_database(db, fk_checks_switchable=True)

    assert db.execute(text("SHOW session_replication_role")).scalar_one() == "origin"
    with pytest.raises(Exception, match="violates foreign key constraint"):
        db.execute(text("INSERT INTO bots (client_id, bot_key, name, is_legacy_pooled) VALUES (999, 'b', 'B', false)"))
        db.commit()
    db.rollback()


# The two tests below depend on running in this order, which pytest guarantees
# within a file unless a reordering plugin is installed (none is). Together they
# prove the ``db`` fixture's teardown actually runs the reset.


def test_db_fixture_teardown_part_one_writes_rows(db):
    client = _add_client(db)
    _add_bot(db, client)
    db.commit()
    assert _count(db, "clients") == 1


def test_db_fixture_teardown_part_two_starts_clean(db):
    assert dirty_tables(db) == set()
    assert used_sequences(db) == set()
    assert _add_client(db).id == 1
