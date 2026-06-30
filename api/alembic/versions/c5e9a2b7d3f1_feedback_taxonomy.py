"""structured taxonomy for platform_feedback (type/area/severity/context/attachments)

Replaces the free-string ``category`` with a structured Type/Area/Severity
taxonomy, plus auto-captured ``context`` (page URL, app version, plan tier,
browser) and a multi-screenshot ``attachments`` array. The legacy ``category``
and ``attachment_url`` columns are kept for back-compat; ``type`` is backfilled
from ``category`` (bug→bug, feature→feature_request, everything else→other).

Revision ID: c5e9a2b7d3f1
Revises: b3c8d1e4f7a9
Create Date: 2026-06-30 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c5e9a2b7d3f1"
down_revision: str | Sequence[str] | None = "b3c8d1e4f7a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "platform_feedback",
        sa.Column("type", sa.String(length=20), nullable=False, server_default="other"),
    )
    op.add_column("platform_feedback", sa.Column("area", sa.String(length=20), nullable=True))
    op.add_column("platform_feedback", sa.Column("severity", sa.String(length=10), nullable=True))
    op.add_column("platform_feedback", sa.Column("context", JSONB(), nullable=True))
    op.add_column("platform_feedback", sa.Column("attachments", JSONB(), nullable=True))

    # Backfill type from the legacy category (lossless — category is retained).
    op.execute(
        """
        UPDATE platform_feedback
        SET type = CASE category
            WHEN 'bug' THEN 'bug'
            WHEN 'feature' THEN 'feature_request'
            ELSE 'other'
        END
        """
    )

    op.create_index("ix_platform_feedback_type", "platform_feedback", ["type"])
    op.create_index("ix_platform_feedback_area", "platform_feedback", ["area"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_platform_feedback_area", table_name="platform_feedback")
    op.drop_index("ix_platform_feedback_type", table_name="platform_feedback")
    op.drop_column("platform_feedback", "attachments")
    op.drop_column("platform_feedback", "context")
    op.drop_column("platform_feedback", "severity")
    op.drop_column("platform_feedback", "area")
    op.drop_column("platform_feedback", "type")
