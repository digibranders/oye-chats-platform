"""Operator ↔ Bot one-to-one binding.

Adds ``bot_id`` (FK → bots.id, ON DELETE CASCADE, NOT NULL) to ``operators``
and ``operator_invites``. Each operator is now scoped to exactly one bot;
chats from other bots in the same workspace are never routed to them.

Backfill strategy for existing rows
-----------------------------------
For every operator / pending invite, we assign the workspace's **oldest**
bot (lowest ``bots.id`` per ``client_id``). If a client has zero bots we
delete the orphaned operator / invite outright — an operator with no bot
to serve has no meaningful assignment path anyway.

Post-backfill we set the column NOT NULL and add supporting indexes.

Revision ID: b1c7e9d3f2a5
Revises: a9c2f4e7b6d8
Create Date: 2026-07-13
"""

import sqlalchemy as sa

from alembic import op

revision = "b1c7e9d3f2a5"
down_revision = "a9c2f4e7b6d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── operators.bot_id ──
    op.add_column(
        "operators",
        sa.Column("bot_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_operators_bot_id",
        "operators",
        "bots",
        ["bot_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_operators_bot_id", "operators", ["bot_id"])

    # Backfill: each operator → oldest bot for that client.
    op.execute(
        """
        UPDATE operators o
        SET bot_id = sub.oldest_bot_id
        FROM (
            SELECT client_id, MIN(id) AS oldest_bot_id
            FROM bots
            GROUP BY client_id
        ) sub
        WHERE o.client_id = sub.client_id
          AND o.bot_id IS NULL
        """
    )

    # Any operator whose workspace has no bots at all — remove.  We also
    # null out any assigned_operator_id references so the FK CASCADE doesn't
    # take live chat sessions with it.
    op.execute(
        """
        UPDATE chat_sessions
        SET assigned_operator_id = NULL
        WHERE assigned_operator_id IN (
            SELECT id FROM operators WHERE bot_id IS NULL
        )
        """
    )
    op.execute("DELETE FROM operators WHERE bot_id IS NULL")

    op.alter_column("operators", "bot_id", nullable=False)

    # ── operator_invites.bot_id ──
    op.add_column(
        "operator_invites",
        sa.Column("bot_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_operator_invites_bot_id",
        "operator_invites",
        "bots",
        ["bot_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_operator_invites_bot_id", "operator_invites", ["bot_id"])

    # Backfill pending / accepted invites to the workspace's oldest bot.
    op.execute(
        """
        UPDATE operator_invites i
        SET bot_id = sub.oldest_bot_id
        FROM (
            SELECT client_id, MIN(id) AS oldest_bot_id
            FROM bots
            GROUP BY client_id
        ) sub
        WHERE i.client_id = sub.client_id
          AND i.bot_id IS NULL
        """
    )
    # Orphans (workspaces with no bots): drop them — they can't resolve to a
    # bot on acceptance.
    op.execute("DELETE FROM operator_invites WHERE bot_id IS NULL")

    op.alter_column("operator_invites", "bot_id", nullable=False)


def downgrade() -> None:
    op.drop_index("ix_operator_invites_bot_id", table_name="operator_invites")
    op.drop_constraint("fk_operator_invites_bot_id", "operator_invites", type_="foreignkey")
    op.drop_column("operator_invites", "bot_id")

    op.drop_index("ix_operators_bot_id", table_name="operators")
    op.drop_constraint("fk_operators_bot_id", "operators", type_="foreignkey")
    op.drop_column("operators", "bot_id")
