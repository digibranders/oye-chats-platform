"""Keep ``bots.qualification_flow`` for one more release.

This revision used to drop the column. Nothing reads or writes it, but the
release running in production when this migrates still maps it, and
``deploy-api.yml`` runs ``alembic upgrade head`` before it restarts the API.
SQLAlchemy selects every mapped column, so between the migration and the
restart every ``SELECT`` on ``bots`` (every chat turn, every widget load)
would have failed with ``UndefinedColumn``. The pre-restart rollback keeps the
schema forward-migrated, so a failed deploy would have left it that way.

The drop moves to the release after the one that stops mapping the column.
This revision stays in the chain because two later revisions depend on it;
``upgrade`` re-adds the column where an earlier build of this file already
dropped it, so a development database migrated in between heals itself.

Revision ID: b1000010dropqualflow
Revises: b1000009pricingkb
Create Date: 2026-09-09

"""

from __future__ import annotations

from alembic import op

revision: str = "b1000010dropqualflow"
down_revision: str | None = "b1000009pricingkb"
branch_labels: None = None
depends_on: None = None

# ``bots`` is read on every chat request; fail fast rather than queue reads
# behind a blocked ALTER.
_LOCK_TIMEOUT = "3s"


def upgrade() -> None:
    op.execute(f"SET LOCAL lock_timeout = '{_LOCK_TIMEOUT}'")
    op.execute("ALTER TABLE bots ADD COLUMN IF NOT EXISTS qualification_flow JSONB")


def downgrade() -> None:
    # The column exists on both sides of this revision now; nothing to undo.
    pass
