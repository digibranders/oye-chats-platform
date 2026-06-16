"""Switch plan pricing to USD-cents and re-price Standard + extra-seat.

OyeChats now displays USD-only (``/subscriptions/geo`` returns
``display_currency: 'USD'`` for every visitor as of the same release).
Continuing to store plan rows in INR-paise meant the Billing page —
which uses ``fmtCurrency(amountMinor, currency)`` with the resolved
display currency — was rendering the raw paise value behind a ``$``
sign: a ``₹4,499`` standard plan was showing as ``$4499``. The fix is
to store amounts in the unit the UI displays.

This migration:

  * Sets ``plans.currency = 'USD'`` on every plan row.
  * Re-prices each plan in USD-cents. Standard becomes $49/mo (annual
    $411.60 at the existing 30% discount). Starter stays at $19/mo
    (annual $159.60). Free / Enterprise keep ``$0`` headline prices.
  * Drops the extra-seat add-on to $5/mo across all plans.
  * Syncs ``pricing_config.seat_price_cents`` so the seat-add flow
    (Razorpay / Stripe) reads the same number the UI shows.

Annual prices use ``floor(monthly * 0.70 * 12)`` to keep the per-month
displayed figure clean. Top-up packs are intentionally not touched —
they're a separate product config and the user only asked about plans.

Razorpay plan IDs already issued against the previous gateway-side
amounts continue charging those amounts until the billing team mints
new Razorpay plans at the new headline pricing and stores the new ids
on the row. That's an operational follow-up, not in scope here.

Revision ID: e1f2a3b4c5d6
Revises: c3a4b5d6e7f8
Create Date: 2026-06-16
"""

from alembic import op

revision = "e1f2a3b4c5d6"
down_revision = "c3a4b5d6e7f8"
branch_labels = None
depends_on = None


# New headline pricing (USD-cents).
_FREE_MONTHLY = 0
_FREE_ANNUAL = 0
_STARTER_MONTHLY = 1900  # $19/mo
_STARTER_ANNUAL = 15960  # $159.60/yr (= $19 * 0.70 * 12)
_STANDARD_MONTHLY = 4900  # $49/mo
_STANDARD_ANNUAL = 41160  # $411.60/yr (= $49 * 0.70 * 12)
_ENTERPRISE_MONTHLY = 0
_ENTERPRISE_ANNUAL = 0
_SEAT_USD_CENTS = 500  # $5/mo extra-seat add-on

# Previous values (INR-paise, set by ``d2e3f4a5b6c7_inr_pricing``) — kept
# inline so downgrade is exact and auditable without re-reading the
# previous migration.
_PREV_FREE_SEAT = 119900
_PREV_STARTER_MONTHLY = 149900
_PREV_STARTER_ANNUAL = 1259000
_PREV_STANDARD_MONTHLY = 449900
_PREV_STANDARD_ANNUAL = 3779000
_PREV_SEAT_PAISE = 119900


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'USD',
            monthly_price_cents = {_FREE_MONTHLY},
            annual_price_cents  = {_FREE_ANNUAL},
            extra_seat_price_cents = {_SEAT_USD_CENTS}
        WHERE slug = 'free'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'USD',
            monthly_price_cents = {_STARTER_MONTHLY},
            annual_price_cents  = {_STARTER_ANNUAL},
            extra_seat_price_cents = {_SEAT_USD_CENTS}
        WHERE slug = 'starter'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'USD',
            monthly_price_cents = {_STANDARD_MONTHLY},
            annual_price_cents  = {_STANDARD_ANNUAL},
            extra_seat_price_cents = {_SEAT_USD_CENTS}
        WHERE slug = 'standard'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'USD',
            monthly_price_cents = {_ENTERPRISE_MONTHLY},
            annual_price_cents  = {_ENTERPRISE_ANNUAL},
            extra_seat_price_cents = {_SEAT_USD_CENTS}
        WHERE slug = 'enterprise'
        """
    )
    op.execute(
        f"""
        UPDATE pricing_config
        SET value = '{_SEAT_USD_CENTS}'::jsonb
        WHERE key = 'seat_price_cents'
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'INR',
            monthly_price_cents = 0,
            annual_price_cents  = 0,
            extra_seat_price_cents = {_PREV_FREE_SEAT}
        WHERE slug = 'free'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'INR',
            monthly_price_cents = {_PREV_STARTER_MONTHLY},
            annual_price_cents  = {_PREV_STARTER_ANNUAL},
            extra_seat_price_cents = {_PREV_SEAT_PAISE}
        WHERE slug = 'starter'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'INR',
            monthly_price_cents = {_PREV_STANDARD_MONTHLY},
            annual_price_cents  = {_PREV_STANDARD_ANNUAL},
            extra_seat_price_cents = {_PREV_SEAT_PAISE}
        WHERE slug = 'standard'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            currency = 'INR',
            monthly_price_cents = 0,
            annual_price_cents  = 0,
            extra_seat_price_cents = {_PREV_SEAT_PAISE}
        WHERE slug = 'enterprise'
        """
    )
    op.execute(
        f"""
        UPDATE pricing_config
        SET value = '{_PREV_SEAT_PAISE}'::jsonb
        WHERE key = 'seat_price_cents'
        """
    )
