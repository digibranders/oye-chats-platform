"""add auto-recrawl fields to bots + enable feature flag on standard/enterprise

Standard and Enterprise plans get a weekly auto-recrawl of every URL that
was previously ingested for the bot. The Bot table gains:

* ``recrawl_enabled``        — customer toggle (false by default)
* ``next_recrawl_at``        — when the hourly sweep should enqueue this bot
* ``last_recrawl_at``        — completion timestamp of the most recent run
* ``last_recrawl_status``    — ``success`` | ``partial`` | ``failed`` | ``empty``
* ``last_recrawl_summary``   — JSONB payload the admin card renders back

The partial index on ``next_recrawl_at`` (where ``recrawl_enabled = true``)
keeps the hourly sweep query O(due-bots) rather than O(all-bots).

Also flips ``auto_recrawl = true`` in ``plans.features`` for the ``standard``
and ``enterprise`` slugs so ``has_feature("auto_recrawl")`` gates through
the existing entitlements pipeline without any super-admin console edit.

Revision ID: d1e7c9f4a3b6
Revises: c1e7a9d3f2b4
Create Date: 2026-07-03 15:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d1e7c9f4a3b6"
down_revision: str | Sequence[str] | None = "c1e7a9d3f2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "bots",
        sa.Column(
            "recrawl_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "bots",
        sa.Column("next_recrawl_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "bots",
        sa.Column("last_recrawl_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "bots",
        sa.Column("last_recrawl_status", sa.String(), nullable=True),
    )
    op.add_column(
        "bots",
        sa.Column(
            "last_recrawl_summary",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    # Partial index keeps the hourly sweep read cheap: it only scans rows
    # where the customer opted in, not the whole ``bots`` table.
    op.create_index(
        "ix_bots_next_recrawl_due",
        "bots",
        ["next_recrawl_at"],
        postgresql_where=sa.text("recrawl_enabled = true"),
    )

    # Turn on the entitlement on Standard + Enterprise plan rows. ``jsonb_set``
    # preserves every other flag the super admin may already have edited.
    op.execute(
        "UPDATE plans "
        "SET features = jsonb_set(features, '{auto_recrawl}', 'true'::jsonb, true) "
        "WHERE slug IN ('standard', 'enterprise')"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("UPDATE plans SET features = features - 'auto_recrawl' WHERE slug IN ('standard', 'enterprise')")
    op.drop_index("ix_bots_next_recrawl_due", table_name="bots")
    op.drop_column("bots", "last_recrawl_summary")
    op.drop_column("bots", "last_recrawl_status")
    op.drop_column("bots", "last_recrawl_at")
    op.drop_column("bots", "next_recrawl_at")
    op.drop_column("bots", "recrawl_enabled")
