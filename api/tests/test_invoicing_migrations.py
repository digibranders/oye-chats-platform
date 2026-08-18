"""Exercise the invoicing migrations against a throwaway database.

The shared ``db`` fixture builds the schema with ``Base.metadata.create_all``,
which validates the ORM model but NOT the Alembic DDL, so a column present in
the model but forgotten in a migration (or a type/length mismatch) would pass
every other test and only surface on a real ``alembic upgrade head`` in prod.
This test closes that gap for the Phase 1 invoicing migrations by running the
full chain up and back down on an isolated database.
"""

import os

import pytest
from sqlalchemy import create_engine, inspect, text

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_TMP_DB = "oyechats_migration_test"


def _server_url(db_url: str) -> str:
    return db_url.rsplit("/", 1)[0]


def test_invoicing_migrations_roundtrip(monkeypatch):
    from alembic.config import Config

    import app.config as app_config
    from alembic import command

    base_url = os.environ["DB_URL"]
    server = _server_url(base_url)
    admin = create_engine(f"{server}/postgres", isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {_TMP_DB}"))
        conn.execute(text(f"CREATE DATABASE {_TMP_DB}"))

    tmp_url = f"{server}/{_TMP_DB}"
    # Early migrations create pgvector columns, so the extension must exist
    # before the chain runs (the main DB already has it).
    tmp_admin = create_engine(tmp_url, isolation_level="AUTOCOMMIT")
    with tmp_admin.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    tmp_admin.dispose()
    try:
        # env.py reads app.config.DB_URL at run time. Point the whole chain at
        # the throwaway DB.
        monkeypatch.setattr(app_config, "DB_URL", tmp_url)
        # Build the Config WITHOUT the ini file so env.py's
        # ``fileConfig(config.config_file_name)`` is skipped. Otherwise it
        # reconfigures global logging (disable_existing_loggers) and pollutes
        # other tests' log capture.
        cfg = Config()
        cfg.set_main_option("script_location", "alembic")

        command.upgrade(cfg, "head")

        eng = create_engine(tmp_url)
        insp = inspect(eng)

        client_cols = {c["name"] for c in insp.get_columns("clients")}
        assert {
            "legal_name",
            "gstin",
            "billing_address",
            "billing_country",
            "billing_state_code",
            "billing_email",
        } <= client_cols

        inv_cols = {c["name"]: c for c in insp.get_columns("invoices")}
        assert {
            "invoice_number",
            "invoice_type",
            "seller_snapshot",
            "buyer_snapshot",
            "place_of_supply",
            "taxable_value_minor",
            "cgst_minor",
            "sgst_minor",
            "igst_minor",
            "total_tax_minor",
            "credit_note_of_id",
            "razorpay_invoice_id",
            "irn",
            "signed_qr",
        } <= set(inv_cols)
        # Widened to 20 for numbering headroom (F2).
        assert inv_cols["invoice_number"]["type"].length == 20
        assert "invoice_counters" in insp.get_table_names()
        eng.dispose()

        # Reversibility: the full chain must unwind cleanly.
        command.downgrade(cfg, "base")
    finally:
        with admin.connect() as conn:
            conn.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :db AND pid <> pg_backend_pid()"
                ),
                {"db": _TMP_DB},
            )
            conn.execute(text(f"DROP DATABASE IF EXISTS {_TMP_DB}"))
        admin.dispose()
