"""add plan marketing and pricing content

Adds a ``marketing`` JSONB column to ``plans`` for public pricing-site display
copy (tagline, badge, CTA, highlight bullets, featured flag). Seeding four
``pricing_config`` rows that will drive the pricing page FAQ, feature matrix,
top-up pack catalogue, and credit-cost reference table.

Revision ID: d8db16e4aea3
Revises: a4b6c8d0e2f3
Create Date: 2026-06-30 19:35:23.003037
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d8db16e4aea3"
down_revision: str = "a4b6c8d0e2f3"
branch_labels = None
depends_on = None

_FAQ_KEY = "pricing_faq"
_MATRIX_KEY = "pricing_feature_matrix"
_TOPUP_KEY = "pricing_topup_packs"
_CREDIT_COST_KEY = "pricing_credit_costs"


def upgrade() -> None:
    op.add_column(
        "plans",
        sa.Column(
            "marketing",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
    )
    conn = op.get_bind()
    seeds = {_FAQ_KEY: "[]", _MATRIX_KEY: "[]", _TOPUP_KEY: "[]", _CREDIT_COST_KEY: "[]"}
    for key, value in seeds.items():
        conn.execute(
            sa.text(
                "INSERT INTO pricing_config (key, value) VALUES (:k, CAST(:v AS JSONB)) ON CONFLICT (key) DO NOTHING"
            ),
            {"k": key, "v": value},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for key in (_FAQ_KEY, _MATRIX_KEY, _TOPUP_KEY, _CREDIT_COST_KEY):
        conn.execute(sa.text("DELETE FROM pricing_config WHERE key = :k"), {"k": key})
    op.drop_column("plans", "marketing")
