"""add manual_field_overrides to bots (crawl auto-fill lock)

Records which auto-fillable fields (``company_name``, ``company_description``,
``brand_tone``) the customer edited by hand so the website crawl stops
clobbering them. A field listed in this array is locked; fields not listed are
refreshed on each crawl. Managed in ``bot_routes.update_bot`` and honored in
``crawl_orchestrator``.

Revision ID: b3d1c5e7a9f2
Revises: a1e2v3ent4s5
Create Date: 2026-07-09 13:20:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3d1c5e7a9f2"
down_revision: str | Sequence[str] | None = "a1e2v3ent4s5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "bots",
        sa.Column(
            "manual_field_overrides",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("bots", "manual_field_overrides")
