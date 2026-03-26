"""add_avatar_type

Revision ID: a1b2c3d4e5f6
Revises: 6933223caf67
Create Date: 2026-03-24 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '6933223caf67'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('bots', sa.Column('avatar_type', sa.String(), server_default='upload', nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('bots', 'avatar_type')
