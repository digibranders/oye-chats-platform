"""bot_domain_installs: per-(bot, domain) install records

``Bot.widget_last_origin`` holds one hostname and overwrites it, so a chatbot
running on five sites reported whichever called most recently — and the
two-per-hour heartbeat throttle meant even that could be an hour stale. It also
could not express the two states the install card most needs: a domain where
the snippet is ABSENT (passive data cannot distinguish that from "nobody
visited today") and a domain running a DIFFERENT chatbot's widget (which is
attributed to that bot and never mentions this one).

The column is left in place rather than dropped. It is still the cheapest read
for "where did the last bootstrap come from", the bootstrap still writes it, and
removing it would break the existing card in the window between this migration
and the deploy that stops reading it.

Revision ID: 9c4d31e07b52
Revises: 7b1c4e2af903
Create Date: 2026-08-31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "9c4d31e07b52"
down_revision: str | Sequence[str] | None = "7b1c4e2af903"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema.

    Guarded on existence, like 7b1c4e2af903 before it. ``app/main.py`` calls
    ``Base.metadata.create_all`` at import, so any process that imports the app
    against a not-yet-migrated database creates this table itself — a local
    ``--reload`` server picking up the new model is enough. The guard makes the
    migration idempotent rather than leaving `alembic upgrade head` to fail on a
    table that is already correct.
    """
    bind = op.get_bind()
    if "bot_domain_installs" in set(sa.inspect(bind).get_table_names()):
        return

    op.create_table(
        "bot_domain_installs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("bot_id", sa.Integer(), nullable=False),
        # Bare hostname as `origin_check.extract_hostname` returns it: lower
        # case, no scheme, no port. 253 is the DNS maximum.
        sa.Column("hostname", sa.String(length=253), nullable=False),
        sa.Column("observed_first_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("observed_last_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("probe_status", sa.String(length=16), nullable=True),
        sa.Column("probe_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("probe_bot_key", sa.String(length=64), nullable=True),
        sa.Column("probe_detail", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["bot_id"], ["bots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        # The upsert target. Both producers write through
        # `ON CONFLICT (bot_id, hostname)`, so this constraint is what keeps a
        # busy site from inserting a row per page view.
        sa.UniqueConstraint("bot_id", "hostname", name="uq_bot_domain_install"),
        sa.CheckConstraint(
            "probe_status IS NULL OR probe_status IN ('installed', 'foreign', 'missing', 'unreachable')",
            name="chk_bot_domain_probe_status",
        ),
    )
    op.create_index("ix_bot_domain_installs_bot_id", "bot_domain_installs", ["bot_id"])


def downgrade() -> None:
    """Downgrade schema.

    Loses the per-domain history. Nothing else depends on it: enforcement is
    ``bots.allowed_domains`` and was never wired to this table, and the install
    card falls back to ``bots.widget_last_origin``, which this migration
    deliberately left intact.
    """
    op.drop_index("ix_bot_domain_installs_bot_id", table_name="bot_domain_installs")
    op.drop_table("bot_domain_installs")
