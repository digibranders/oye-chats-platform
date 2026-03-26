"""added multiple bots

Revision ID: 7416036ea87e
Revises: 20a1e88dddcd
Create Date: 2026-03-20 15:53:25.978246

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '7416036ea87e'
down_revision: Union[str, Sequence[str], None] = '20a1e88dddcd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: create bots table, add bot_id FKs, add max_bots."""

    # 1. Create the bots table FIRST (before anything references it)
    op.create_table(
        'bots',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('client_id', sa.Integer(), sa.ForeignKey('clients.id', ondelete='CASCADE'), nullable=False),
        sa.Column('bot_key', sa.String(), nullable=False),
        sa.Column('name', sa.String(), server_default='AI Assistant'),
        sa.Column('system_prompt', sa.Text(), nullable=True),
        sa.Column('website', sa.String(), nullable=True),
        sa.Column('bot_logo', sa.Text(), nullable=True),
        sa.Column('launcher_name', sa.String(), server_default='Have Questions?'),
        sa.Column('launcher_logo', sa.Text(), nullable=True),
        sa.Column('primary_color', sa.String(), server_default='#ba68c8'),
        sa.Column('background_color', sa.String(), server_default='#ffffff'),
        sa.Column('header_color', sa.String(), server_default='#3A0CA3'),
        sa.Column('recommended_colors', postgresql.JSONB(), nullable=True),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_bots_bot_key', 'bots', ['bot_key'], unique=True)
    op.create_index('ix_bots_client_id', 'bots', ['client_id'])

    # 2. Add bot_id FK to chat_sessions, make client_id nullable
    op.add_column('chat_sessions', sa.Column('bot_id', sa.Integer(), nullable=True))
    op.alter_column('chat_sessions', 'client_id',
               existing_type=sa.INTEGER(),
               nullable=True)
    op.create_foreign_key('fk_chat_sessions_bot_id', 'chat_sessions', 'bots', ['bot_id'], ['id'], ondelete='CASCADE')

    # 3. Add max_bots to clients
    op.add_column('clients', sa.Column('max_bots', sa.Integer(), server_default='1', nullable=False))

    # 4. Add bot_id FK to documents, make client_id nullable
    op.add_column('documents', sa.Column('bot_id', sa.Integer(), nullable=True))
    op.alter_column('documents', 'client_id',
               existing_type=sa.INTEGER(),
               nullable=True)
    op.create_foreign_key('fk_documents_bot_id', 'documents', 'bots', ['bot_id'], ['id'], ondelete='CASCADE')


def downgrade() -> None:
    """Downgrade schema: drop bots table, remove bot_id FKs, remove max_bots."""

    # Remove FK and column from documents
    op.drop_constraint('fk_documents_bot_id', 'documents', type_='foreignkey')
    op.alter_column('documents', 'client_id',
               existing_type=sa.INTEGER(),
               nullable=False)
    op.drop_column('documents', 'bot_id')

    # Remove max_bots from clients
    op.drop_column('clients', 'max_bots')

    # Remove FK and column from chat_sessions
    op.drop_constraint('fk_chat_sessions_bot_id', 'chat_sessions', type_='foreignkey')
    op.alter_column('chat_sessions', 'client_id',
               existing_type=sa.INTEGER(),
               nullable=False)
    op.drop_column('chat_sessions', 'bot_id')

    # Drop bots table last
    op.drop_index('ix_bots_client_id', table_name='bots')
    op.drop_index('ix_bots_bot_key', table_name='bots')
    op.drop_table('bots')
