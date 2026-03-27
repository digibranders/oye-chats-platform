"""add password reset fields

Revision ID: f6237d8fa1db
Revises: 0002
Create Date: 2026-03-27 13:08:58.481299

"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'f6237d8fa1db'
down_revision: str | Sequence[str] | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('clients', sa.Column('reset_otp', sa.String(), nullable=True))
    op.add_column('clients', sa.Column('reset_otp_expires_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('clients', 'reset_otp_expires_at')
    op.drop_column('clients', 'reset_otp')
