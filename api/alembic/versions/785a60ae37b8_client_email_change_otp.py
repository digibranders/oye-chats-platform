"""add pending_email + email_change_otp columns to clients

Backs the verified email-change flow: /client/change-email/request stores
the new address in ``pending_email`` and mails an OTP to it, and
/client/change-email/confirm only promotes it to ``email`` once that OTP is
verified. Mirrors the existing ``reset_otp`` / ``reset_otp_expires_at`` pair.

Revision ID: 785a60ae37b8
Revises: f6c3b1d9a8e4
Create Date: 2026-07-07 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "785a60ae37b8"
down_revision: str | Sequence[str] | None = "f6c3b1d9a8e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("clients", sa.Column("pending_email", sa.String(), nullable=True))
    op.add_column("clients", sa.Column("email_change_otp", sa.String(), nullable=True))
    op.add_column("clients", sa.Column("email_change_otp_expires_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("clients", "email_change_otp_expires_at")
    op.drop_column("clients", "email_change_otp")
    op.drop_column("clients", "pending_email")
