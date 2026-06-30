"""round annual USD headline to clean per-month figures

Display-only change (see docs/billing/repricing-runbook.md): the annual USD
headline is shown as ``annual_price_usd_cents / 12`` ("/mo, billed annually").
The old totals produced $15.17 and $39.17; round them to clean $15 and $39:

    Starter  annual_price_usd_cents 18200 ($182, $15.17/mo) -> 18000 ($180, $15/mo)
    Standard annual_price_usd_cents 47000 ($470, $39.17/mo) -> 46800 ($468, $39/mo)

USD columns are headline/display only — subscriptions always charge INR via
Razorpay (``_resolve_provider`` returns "razorpay"), so the actual amount
billed is unchanged and no new Razorpay plans are required.

Revision ID: c7a2f4e9b1d3
Revises: d7f1a9c3e5b2
Create Date: 2026-06-30 10:15:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7a2f4e9b1d3"
down_revision: str | Sequence[str] | None = "d7f1a9c3e5b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# New rounded annual USD totals (cents). $15/mo and $39/mo billed annually.
_STARTER_USD_ANNUAL_NEW = 18000  # $180/yr -> $15.00/mo
_STANDARD_USD_ANNUAL_NEW = 46800  # $468/yr -> $39.00/mo

# Prior values, for a clean downgrade.
_STARTER_USD_ANNUAL_OLD = 18200  # $182/yr -> $15.17/mo
_STANDARD_USD_ANNUAL_OLD = 47000  # $470/yr -> $39.17/mo


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(f"UPDATE plans SET annual_price_usd_cents = {_STARTER_USD_ANNUAL_NEW} WHERE slug = 'starter'")
    op.execute(f"UPDATE plans SET annual_price_usd_cents = {_STANDARD_USD_ANNUAL_NEW} WHERE slug = 'standard'")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(f"UPDATE plans SET annual_price_usd_cents = {_STARTER_USD_ANNUAL_OLD} WHERE slug = 'starter'")
    op.execute(f"UPDATE plans SET annual_price_usd_cents = {_STANDARD_USD_ANNUAL_OLD} WHERE slug = 'standard'")
