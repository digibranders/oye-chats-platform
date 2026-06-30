"""add resolution loop columns to platform_feedback

Platform Feedback Resolution & Status Loop — lets a superadmin triage and
resolve customer-submitted feedback, and lets the submitting client see the
status + written response back in the app. Adds ``status`` (default ``open``),
``admin_response``, ``resolved_at`` and ``resolved_by``; backfills existing
rows to ``open`` via the server default and indexes ``status`` for filtering.

Revision ID: b3c8d1e4f7a9
Revises: f2d4b6a8c0e1
Create Date: 2026-06-30 17:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3c8d1e4f7a9"
down_revision: str | Sequence[str] | None = "f2d4b6a8c0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "platform_feedback",
        sa.Column("status", sa.String(length=20), nullable=False, server_default="open"),
    )
    op.add_column(
        "platform_feedback",
        sa.Column("admin_response", sa.Text(), nullable=True),
    )
    op.add_column(
        "platform_feedback",
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "platform_feedback",
        sa.Column("resolved_by", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_platform_feedback_resolved_by_clients",
        "platform_feedback",
        "clients",
        ["resolved_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_platform_feedback_status",
        "platform_feedback",
        ["status"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_platform_feedback_status", table_name="platform_feedback")
    op.drop_constraint(
        "fk_platform_feedback_resolved_by_clients",
        "platform_feedback",
        type_="foreignkey",
    )
    op.drop_column("platform_feedback", "resolved_by")
    op.drop_column("platform_feedback", "resolved_at")
    op.drop_column("platform_feedback", "admin_response")
    op.drop_column("platform_feedback", "status")
