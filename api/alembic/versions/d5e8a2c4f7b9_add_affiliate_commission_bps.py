"""Affiliate commission percentage (per affiliate, super-admin editable).

Adds ``affiliates.commission_bps`` — the commission this affiliate earns,
stored in basis points (1 bps = 0.01%, so 2500 = 25.00%). Basis points
keep the value as a pure integer for safe math; the UI accepts whole-
percent input (e.g. 20) and the route layer multiplies by 100.

No backfill — every existing affiliate defaults to ``0`` (no commission),
matching v1's "money-free" semantics. The super-admin explicitly sets a
non-zero value when they decide to pay out.

Revision ID: d5e8a2c4f7b9
Revises: c7d9e2b4f1a8
Create Date: 2026-06-09
"""

import sqlalchemy as sa

from alembic import op

revision = "d5e8a2c4f7b9"
down_revision = "c7d9e2b4f1a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable + server_default=0 → metadata-only ALTER, no row rewrite.
    op.add_column(
        "affiliates",
        sa.Column(
            "commission_bps",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.create_check_constraint(
        "chk_affiliate_commission_bps_range",
        "affiliates",
        "commission_bps >= 0 AND commission_bps <= 10000",
    )


def downgrade() -> None:
    op.drop_constraint(
        "chk_affiliate_commission_bps_range",
        "affiliates",
        type_="check",
    )
    op.drop_column("affiliates", "commission_bps")
