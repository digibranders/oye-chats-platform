"""Drop the annual discount from 30% → 20% on Starter and Standard.

Product decision: tighten the annual incentive so the per-month figure
on the modal stays closer to the monthly headline. Marketing displays
the annual rate as a clean integer ``$/mo`` (Starter $15, Standard $39)
and the annual total as ``$/mo × 12``, so the database stores those
clean totals to keep the arithmetic visible to skeptical customers:

  Starter:   $19 / mo  → $180 / yr  (= $15/mo × 12, ~21.0% off)
  Standard:  $49 / mo  → $468 / yr  (= $39/mo × 12, ~20.4% off)

Both effective discounts round to "20% off" for marketing copy purposes
— the ``annual_discount_percent`` column carries that headline value.
Using clean integers (over the mathematically precise $182.40 / $470.40)
avoids a "marketing says $180, checkout charges $182.40" mismatch when
a customer compares the pricing page with the invoice.

Idempotent on values already at these figures (UPDATE writes the same
numbers). Free / Enterprise are untouched — they have no annual price.

Revision ID: a3b4c5d6e7f8
Revises: f2a3b4c5d6e7
Create Date: 2026-06-16
"""

from alembic import op

revision = "a3b4c5d6e7f8"
down_revision = "f2a3b4c5d6e7"
branch_labels = None
depends_on = None


_STARTER_ANNUAL = 18000  # $15/mo annual × 12 — matches marketing pricing.ts
_STANDARD_ANNUAL = 46800  # $39/mo annual × 12 — matches marketing pricing.ts
_NEW_DISCOUNT_PCT = 20

_PREV_STARTER_ANNUAL = 15960
_PREV_STANDARD_ANNUAL = 41160
_PREV_DISCOUNT_PCT = 30


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE plans SET
            annual_price_cents = {_STARTER_ANNUAL},
            annual_discount_percent = {_NEW_DISCOUNT_PCT}
        WHERE slug = 'starter'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            annual_price_cents = {_STANDARD_ANNUAL},
            annual_discount_percent = {_NEW_DISCOUNT_PCT}
        WHERE slug = 'standard'
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        UPDATE plans SET
            annual_price_cents = {_PREV_STARTER_ANNUAL},
            annual_discount_percent = {_PREV_DISCOUNT_PCT}
        WHERE slug = 'starter'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            annual_price_cents = {_PREV_STANDARD_ANNUAL},
            annual_discount_percent = {_PREV_DISCOUNT_PCT}
        WHERE slug = 'standard'
        """
    )
