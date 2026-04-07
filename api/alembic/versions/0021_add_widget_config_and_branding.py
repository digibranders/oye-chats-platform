"""Add widget_config and branding customization columns.

Revision ID: 0021_widget_config_branding
Revises: 0020_add_widget_messages
Create Date: 2026-04-06 15:15:00.000000

"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision = "0021_widget_config_branding"
down_revision = "0020_add_widget_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add widget_config JSONB column for timing/thresholds/advanced settings
    op.add_column(
        "bots",
        sa.Column(
            "widget_config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default='{"welcome_exit_duration_ms": 350, "greeting_delay_ms": 3000, "typing_timeout_ms": 2000, "frustration_window_ms": 30000, "frustration_threshold_messages": 3, "max_reconnect_attempts": 15, "max_reconnect_delay_ms": 30000, "heartbeat_visible_ms": 25000, "heartbeat_hidden_ms": 50000, "handoff_auto_submit_delay_ms": 300}',
        ),
    )

    # Add branding text column
    op.add_column(
        "bots", sa.Column("branding_text", sa.String(length=255), nullable=False, server_default="Powered by OyeChats")
    )

    # Add branding URL column
    op.add_column(
        "bots", sa.Column("branding_url", sa.String(length=255), nullable=False, server_default="https://oyechats.com")
    )


def downgrade() -> None:
    # Drop widget_config column
    op.drop_column("bots", "widget_config")
    # Drop branding columns
    op.drop_column("bots", "branding_text")
    op.drop_column("bots", "branding_url")
