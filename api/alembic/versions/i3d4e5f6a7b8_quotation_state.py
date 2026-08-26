"""add chat_sessions.quotation_state

Adds a nullable JSONB column tracking a visitor's progress through the
quotation flow (service selection → per-service questions → quantities →
final quote). NULL == "idle" (never activated); once the trigger fires the
column is written on every step and cleared to a terminal ``complete`` /
``skipped`` status when the visitor finishes or opts out.

Revision ID: i3d4e5f6a7b8
Revises: h2c3d4e5f6a7
Create Date: 2026-08-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "i3d4e5f6a7b8"
down_revision: str | Sequence[str] | None = "h2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("quotation_state", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_sessions", "quotation_state")
