"""bot: widget_installed_at (install detection)

Stamped once, the first time a bot's embedded widget bootstraps
``GET /bots/settings/public`` from a real external site (not the dashboard
preview / demo / localhost). Drives the "widget installed" step in the
Dashboard setup checklist without a user self-report. Nullable, no backfill —
existing bots read as "not detected yet" until their widget is next loaded.

Revision ID: b7d1e4a92c60
Revises: e3c9a17f2b64
Create Date: 2026-07-13 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7d1e4a92c60"
down_revision: str | Sequence[str] | None = "e3c9a17f2b64"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("bots", sa.Column("widget_installed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("bots", "widget_installed_at")
