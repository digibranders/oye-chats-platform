"""clients.geo_mismatch_at/_detail — persistent billing-geo audit signal (Wave 1.1)

A billing-country claim that contradicts the server-side IP geo signal was only
ever WARN-logged, so the GST/FEMA review trail lived in log retention. These two
columns make the newest contradiction durable on the account itself, in both
directions: a domestic (IN) claim from a foreign-detected request, and — the
P0-2 leakage direction — a foreign (zero-rated export) claim from an
IN-detected request.

Revision ID: b7e2d5a91c34
Revises: f2b8c4d61e93
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b7e2d5a91c34"
down_revision: str | Sequence[str] | None = "f2b8c4d61e93"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("geo_mismatch_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("clients", sa.Column("geo_mismatch_detail", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("clients", "geo_mismatch_detail")
    op.drop_column("clients", "geo_mismatch_at")
