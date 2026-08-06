"""client signup_promo_code (link-exclusive promo attribution)

Adds ``clients.signup_promo_code`` — the campaign code captured at signup from a
promotion link's ``?code=``. Makes the launch offer link-exclusive: only
accounts that arrived through the campaign link qualify (matched against
``promotions.code`` in promotion_service). NULL = organic signup → normal price.

Additive, nullable, backfill-free: every existing account reads as "no promo
code", which is correct.

Revision ID: e7a4c2f19d80
Revises: d3f1a9c07b21
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e7a4c2f19d80"
down_revision: str | Sequence[str] | None = "d3f1a9c07b21"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("signup_promo_code", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("clients", "signup_promo_code")
