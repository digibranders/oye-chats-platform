"""referral redemption caps/expiry + invite commission pool

Remediation C3 + NV4:
  * ``referral_codes.max_redemptions`` / ``redeemed_count`` / ``valid_until``
    — cap a code's lifetime redemptions and add an expiry so a leaked code is
    no longer an unbounded, never-expiring discount liability.
  * ``affiliate_invites.commission_bps`` — carry the super-admin's intended
    commission pool through the magic-link accept path (invited affiliates
    were landing at 0% and could create no earning code).

Revision ID: e1c3a5f7b9d2
Revises: c7a2f4e9b1d3
Create Date: 2026-06-30 15:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e1c3a5f7b9d2"
down_revision: str | Sequence[str] | None = "c7a2f4e9b1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("referral_codes", sa.Column("max_redemptions", sa.Integer(), nullable=True))
    op.add_column(
        "referral_codes",
        sa.Column("redeemed_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "referral_codes",
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "chk_referral_redemption_counts",
        "referral_codes",
        "redeemed_count >= 0 AND (max_redemptions IS NULL OR max_redemptions >= 0)",
    )

    op.add_column(
        "affiliate_invites",
        sa.Column("commission_bps", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("affiliate_invites", "commission_bps")
    op.drop_constraint("chk_referral_redemption_counts", "referral_codes", type_="check")
    op.drop_column("referral_codes", "valid_until")
    op.drop_column("referral_codes", "redeemed_count")
    op.drop_column("referral_codes", "max_redemptions")
