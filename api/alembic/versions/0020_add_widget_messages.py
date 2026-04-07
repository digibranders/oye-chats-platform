"""Add widget_messages JSONB column for customizable widget text.

Revision ID: 0020_add_widget_messages
Revises: 0019_meeting_booking
Create Date: 2026-04-06 15:00:00.000000

"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision = "0020_add_widget_messages"
down_revision = "0019_meeting_booking"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add widget_messages JSONB column to bots table
    op.add_column(
        "bots",
        sa.Column(
            "widget_messages",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default='{"welcome_greeting": "Hi There, How can I help you today?", "welcome_suggestions": ["Our Services", "About us", "Contact us"], "input_placeholder": "Write a message...", "live_chat_label": "Live chat", "greeting_message": "Hi! Let us know if you have any questions.", "offline_message": "Team is currently unavailable", "rating_prompt": "How was your experience?", "end_chat_label": "End chat and return to AI"}',
        ),
    )


def downgrade() -> None:
    # Drop widget_messages column
    op.drop_column("bots", "widget_messages")
