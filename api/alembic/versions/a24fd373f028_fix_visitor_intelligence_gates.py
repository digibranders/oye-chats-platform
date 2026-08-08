"""fix visitor intelligence gates: per-bot suppression, followup tracking

Post-implementation review of the initial visitor-intelligence migration
(ff97c9d21f8a) found two schema gaps that broke the manual follow-up
feature: the endpoint needed a cooldown timestamp + operator attribution
that didn't exist, and ``email_suppressions`` had no ``bot_id`` — making
suppression global across every customer instead of scoped per bot.

Revision ID: a24fd373f028
Revises: ff97c9d21f8a
Create Date: 2026-08-08 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a24fd373f028"
down_revision: str | Sequence[str] | None = "ff97c9d21f8a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # Gate 2 (cooldown-with-override) + operator attribution — the manual
    # follow-up endpoint referenced a non-existent `followup_sent` boolean
    # before this migration; these two columns are what it actually needs.
    op.add_column("lead_info", sa.Column("last_followup_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "lead_info",
        sa.Column(
            "followup_sent_by_operator_id",
            sa.Integer(),
            sa.ForeignKey("operators.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # email_suppressions was brand-new and unused in the prior migration
    # (the send endpoint that would have populated it was broken) — safe to
    # clear before adding a NOT NULL bot_id rather than attempt a backfill
    # with no way to know which bot an orphaned global row belonged to.
    op.execute("DELETE FROM email_suppressions")
    op.drop_index("ix_email_suppressions_email", table_name="email_suppressions")
    op.add_column(
        "email_suppressions",
        sa.Column("bot_id", sa.Integer(), sa.ForeignKey("bots.id", ondelete="CASCADE"), nullable=False),
    )
    op.create_index(op.f("ix_email_suppressions_bot_id"), "email_suppressions", ["bot_id"])
    op.create_unique_constraint("uq_email_suppressions_bot_email", "email_suppressions", ["bot_id", "email"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("uq_email_suppressions_bot_email", "email_suppressions", type_="unique")
    op.drop_index(op.f("ix_email_suppressions_bot_id"), table_name="email_suppressions")
    op.drop_column("email_suppressions", "bot_id")
    op.create_index(op.f("ix_email_suppressions_email"), "email_suppressions", ["email"], unique=True)
    op.drop_column("lead_info", "followup_sent_by_operator_id")
    op.drop_column("lead_info", "last_followup_sent_at")
