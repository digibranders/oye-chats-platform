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
    # CONCURRENTLY cannot run inside a transaction, and alembic wraps the
    # migration in one. This table is small enough on every current deployment
    # that a plain CREATE INDEX is a sub-second exclusive lock, and the short
    # lock_timeout means a deploy fails fast rather than queuing writers behind
    # a lock it cannot get.
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("CREATE INDEX IF NOT EXISTS ix_chat_audit_logs_session_id ON chat_audit_logs (session_id)")
    # The retention sweep added alongside this deletes by ``created_at``.
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute("CREATE INDEX IF NOT EXISTS ix_visitor_events_created_at ON visitor_events (created_at)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_bant_signals_created_at ON bant_signals (created_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_bant_signals_created_at")
    op.execute("DROP INDEX IF EXISTS ix_visitor_events_created_at")
    op.execute("DROP INDEX IF EXISTS ix_chat_audit_logs_session_id")
