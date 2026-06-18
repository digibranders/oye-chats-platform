"""Live chat state machine — queue table, routing config, fallback metadata.

Adds the schema needed by the state-aware live chat availability service:

* ``bots.live_chat_routing_strategy`` — least_busy | round_robin | first_available
* ``bots.live_chat_queue_timeout_seconds`` — visitor wait before offline-form fallback
* ``bots.live_chat_max_queue_size`` — reject queue entries past this cap
* ``operators.is_accepting_chats`` — manual DND toggle (separate from is_online)
* ``offline_messages.transcript`` — full chat history captured at form submit
* ``offline_messages.fallback_reason`` — why the form appeared (no_operators, ...)
* ``live_chat_queue`` — persistent queue (so we can recover across restarts)

Backfill is opinionated: existing bots get the new "least_busy" strategy, a
20-second queue timeout (lines up with the spec), and a 10-entry max queue.
Existing operators are marked as accepting chats so live chat keeps working
without admin intervention.

Revision ID: b1f2a3c4d5e6
Revises: a2c3e4f5b6d7
Create Date: 2026-06-18
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "b1f2a3c4d5e6"
down_revision = "a2c3e4f5b6d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── bots: routing + queue config ───────────────────────────────────────
    op.add_column(
        "bots",
        sa.Column(
            "live_chat_routing_strategy",
            sa.String(),
            nullable=False,
            server_default="least_busy",
        ),
    )
    op.add_column(
        "bots",
        sa.Column(
            "live_chat_queue_timeout_seconds",
            sa.Integer(),
            nullable=False,
            server_default="20",
        ),
    )
    op.add_column(
        "bots",
        sa.Column(
            "live_chat_max_queue_size",
            sa.Integer(),
            nullable=False,
            server_default="10",
        ),
    )

    # ── operators: manual availability toggle ──────────────────────────────
    op.add_column(
        "operators",
        sa.Column(
            "is_accepting_chats",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )

    # ── offline_messages: transcript + reason for context ──────────────────
    op.add_column(
        "offline_messages",
        sa.Column("transcript", JSONB(), nullable=True),
    )
    op.add_column(
        "offline_messages",
        sa.Column("fallback_reason", sa.String(), nullable=True),
    )

    # ── live_chat_queue table (FIFO, recoverable across restarts) ──────────
    op.create_table(
        "live_chat_queue",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "session_id",
            sa.String(),
            sa.ForeignKey("chat_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "bot_id",
            sa.Integer(),
            sa.ForeignKey("bots.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "enqueued_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("dequeued_at", sa.DateTime(timezone=True), nullable=True),
        # assigned | timeout | abandoned | bot_returned
        sa.Column("dequeue_reason", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_live_chat_queue_bot_id_dequeued_at",
        "live_chat_queue",
        ["bot_id", "dequeued_at"],
    )
    op.create_index(
        "ix_live_chat_queue_session_id",
        "live_chat_queue",
        ["session_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_live_chat_queue_session_id", table_name="live_chat_queue")
    op.drop_index("ix_live_chat_queue_bot_id_dequeued_at", table_name="live_chat_queue")
    op.drop_table("live_chat_queue")

    op.drop_column("offline_messages", "fallback_reason")
    op.drop_column("offline_messages", "transcript")

    op.drop_column("operators", "is_accepting_chats")

    op.drop_column("bots", "live_chat_max_queue_size")
    op.drop_column("bots", "live_chat_queue_timeout_seconds")
    op.drop_column("bots", "live_chat_routing_strategy")
