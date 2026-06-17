"""Add email OTP verification columns to clients.

Adds three columns used by the OTP email verification flow:
* ``clients.is_verified``         — False until the user enters their OTP
* ``clients.email_otp``           — 6-digit code, cleared on use or resend
* ``clients.email_otp_expires_at`` — 15-minute window, nullable

Backfill: all existing clients are marked is_verified=True so they are
not asked to verify on next login.

Revision ID: a1c2e3f4b5d6
Revises: b4c5d6e7f8a9
Create Date: 2026-06-17
"""

import sqlalchemy as sa

from alembic import op

revision = "a1c2e3f4b5d6"
down_revision = "b4c5d6e7f8a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("is_verified", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("clients", sa.Column("email_otp", sa.String(), nullable=True))
    op.add_column("clients", sa.Column("email_otp_expires_at", sa.DateTime(timezone=True), nullable=True))

    # Backfill: existing accounts bypass verification.
    op.execute("UPDATE clients SET is_verified = TRUE")


def downgrade() -> None:
    op.drop_column("clients", "email_otp_expires_at")
    op.drop_column("clients", "email_otp")
    op.drop_column("clients", "is_verified")
