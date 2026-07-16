"""baseline schema

Squashed baseline for the new-pricing relaunch: collapses the entire prior
migration history (106 revisions) into one starting point. The DDL lives in the
sibling ``b6c86b4c8434_baseline_schema.sql`` — a cycle-safe ``pg_dump`` of the
schema defined by ``app.db.models`` (tables first, then foreign keys, so the
mutually-dependent tables clients/subscriptions/affiliates/bots load cleanly).

Data seeding (plans, pricing_config, super-admin) is NOT done here — it lives in
``scripts/seed_*.py`` and runs after migration (see ``scripts/reset_and_seed.sh``).

Revision ID: b6c86b4c8434
Revises:
Create Date: 2026-07-16
"""

from collections.abc import Sequence
from pathlib import Path

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b6c86b4c8434"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SQL_FILE = Path(__file__).with_name("b6c86b4c8434_baseline_schema.sql")


def upgrade() -> None:
    """Create the full schema from the baseline DDL (extensions + tables + FKs + indexes)."""
    sql = _SQL_FILE.read_text()
    op.get_bind().exec_driver_sql(sql)


def downgrade() -> None:
    """Drop everything this baseline created — but keep ``alembic_version`` so
    alembic can still record the downgrade (dropping the whole schema would take
    its own bookkeeping table with it)."""
    op.execute(
        """
        DO $$
        DECLARE r RECORD;
        BEGIN
          FOR r IN (SELECT tablename FROM pg_tables
                    WHERE schemaname = 'public' AND tablename <> 'alembic_version') LOOP
            EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
          END LOOP;
          FOR r IN (SELECT t.typname FROM pg_type t
                    JOIN pg_namespace n ON n.oid = t.typnamespace
                    WHERE n.nspname = 'public' AND t.typtype = 'e') LOOP
            EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
          END LOOP;
        END $$;
        """
    )
