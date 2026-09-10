"""Index chat_audit_logs.session_id, and age out the two unbounded event tables.

The audit log has eleven write paths and two readers, and both readers filter
on ``session_id``. It had a primary key and two foreign keys and no index, so
the per-session audit view and the queue-summary wait-time reconstruction were
both sequential scans that grow with every escalated conversation.

Revision ID: b1000012auditindex
Revises: b1000011failedemails
"""

from __future__ import annotations

from alembic import op

revision: str = "b1000012auditindex"
down_revision: str | None = "b1000011failedemails"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Alembic runs the whole migration in one transaction, and a plain CREATE
    # INDEX holds a SHARE lock on the table for the length of the build, so
    # widget event flushes on ``visitor_events`` and the qualification worker
    # on ``bant_signals`` would have queued behind it. CONCURRENTLY takes no
    # lock that blocks writers, but it cannot run inside a transaction, so
    # each build gets its own autocommit block. IF NOT EXISTS keeps a re-run
    # after a failed (INVALID) build from erroring; drop the invalid index by
    # hand before re-running in that case.
    #
    # A concurrent build still takes SHARE UPDATE EXCLUSIVE, so it can wait
    # behind an autovacuum or another DDL; the timeout makes a deploy fail
    # fast instead of hanging there. Session-level SET, not SET LOCAL: there
    # is no transaction inside the autocommit block for LOCAL to bind to.
    with op.get_context().autocommit_block():
        op.execute("SET lock_timeout = '5s'")
        op.create_index(
            "ix_chat_audit_logs_session_id",
            "chat_audit_logs",
            ["session_id"],
            if_not_exists=True,
            postgresql_concurrently=True,
        )
        # The retention sweep added alongside this deletes by ``created_at``.
        op.create_index(
            "ix_visitor_events_created_at",
            "visitor_events",
            ["created_at"],
            if_not_exists=True,
            postgresql_concurrently=True,
        )
        op.create_index(
            "ix_bant_signals_created_at",
            "bant_signals",
            ["created_at"],
            if_not_exists=True,
            postgresql_concurrently=True,
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("SET lock_timeout = '5s'")
        op.drop_index(
            "ix_bant_signals_created_at",
            table_name="bant_signals",
            if_exists=True,
            postgresql_concurrently=True,
        )
        op.drop_index(
            "ix_visitor_events_created_at",
            table_name="visitor_events",
            if_exists=True,
            postgresql_concurrently=True,
        )
        op.drop_index(
            "ix_chat_audit_logs_session_id",
            table_name="chat_audit_logs",
            if_exists=True,
            postgresql_concurrently=True,
        )
