"""Add fixed USD price columns to plans; re-anchor top-up packs to USD.

Background
----------
OyeChats bills Indian customers in INR via Razorpay (fixed plans) and will
bill international customers in USD via Stripe. Per the dual-currency design
(billing plan ADR D2/D3), each plan stores TWO independent fixed prices:

  * ``monthly_price_cents`` / ``annual_price_cents``  — INR paise (Razorpay)
  * ``monthly_price_usd_cents`` / ``annual_price_usd_cents`` — USD cents (Stripe)

Neither is derived from the other at runtime — no live FX in the charge or
display path. The reference rate ₹94.67/$1 (25 Jun 2026) was used once to set
the INR columns; the USD columns are the fixed headline ($19 / $49).

This migration:
  * Adds three nullable USD-cent columns to ``plans``.
  * Seeds the USD headline for Starter ($19/mo, $182/yr) and Standard
    ($49/mo, $470/yr); seat add-on $5. Free / Enterprise stay $0.
  * Re-anchors ``pricing_config.topup_packs`` so the charged INR matches the
    USD headline at ₹94.67 ($19=₹1,799, $49=₹4,599, $99=₹8,999, $249=₹22,999),
    keeping top-ups consistent with the subscription plans.

Revision ID: b1c2d3e4f5a6
Revises: a9b8c7d6e5f4
Create Date: 2026-06-25
"""

import sqlalchemy as sa

from alembic import op

revision = "b1c2d3e4f5a6"
down_revision = "a9b8c7d6e5f4"
branch_labels = None
depends_on = None


# Fixed USD headlines (cents).
_STARTER_USD_MONTHLY = 1900  # $19
_STARTER_USD_ANNUAL = 18200  # $182
_STANDARD_USD_MONTHLY = 4900  # $49
_STANDARD_USD_ANNUAL = 47000  # $470
_SEAT_USD = 500  # $5


def upgrade() -> None:
    op.add_column("plans", sa.Column("monthly_price_usd_cents", sa.Integer(), nullable=True))
    op.add_column("plans", sa.Column("annual_price_usd_cents", sa.Integer(), nullable=True))
    op.add_column("plans", sa.Column("extra_seat_price_usd_cents", sa.Integer(), nullable=True))

    op.execute(
        f"""
        UPDATE plans SET
            monthly_price_usd_cents = {_STARTER_USD_MONTHLY},
            annual_price_usd_cents  = {_STARTER_USD_ANNUAL},
            extra_seat_price_usd_cents = {_SEAT_USD}
        WHERE slug = 'starter'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            monthly_price_usd_cents = {_STANDARD_USD_MONTHLY},
            annual_price_usd_cents  = {_STANDARD_USD_ANNUAL},
            extra_seat_price_usd_cents = {_SEAT_USD}
        WHERE slug = 'standard'
        """
    )
    op.execute(
        f"""
        UPDATE plans SET
            monthly_price_usd_cents = 0,
            annual_price_usd_cents  = 0,
            extra_seat_price_usd_cents = {_SEAT_USD}
        WHERE slug IN ('free', 'enterprise')
        """
    )

    # Re-anchor top-up packs to USD at ₹94.67 so the charged INR matches the
    # USD headline and the subscription plans. ``amount`` is INR rupees (the
    # gateway-native unit the backend forwards), ``display_amount`` is the USD
    # headline rendered in the modal.
    #
    # Use exec_driver_sql (raw DBAPI execution) rather than op.execute/text():
    # the JSON literal contains ``"key":value`` colons that SQLAlchemy's text()
    # would mis-parse as ``:value`` bind parameters. Raw execution sends the
    # statement straight to psycopg2 with no bind-param parsing. The JSON
    # contains no ``%`` so psycopg2's own paramstyle is not triggered.
    op.get_bind().exec_driver_sql(
        """
        UPDATE pricing_config SET value = '[
            {"amount":1799,"currency":"INR","display_amount":19,"display_currency":"USD","credits":2000,"bonus_pct":0,"stripe_price_id":null,"razorpay_plan_id":null},
            {"amount":4599,"currency":"INR","display_amount":49,"display_currency":"USD","credits":5500,"bonus_pct":10,"stripe_price_id":null,"razorpay_plan_id":null},
            {"amount":8999,"currency":"INR","display_amount":99,"display_currency":"USD","credits":12000,"bonus_pct":20,"stripe_price_id":null,"razorpay_plan_id":null,"badge":"Best value"},
            {"amount":22999,"currency":"INR","display_amount":249,"display_currency":"USD","credits":32500,"bonus_pct":30,"stripe_price_id":null,"razorpay_plan_id":null}
        ]'::jsonb,
        updated_at = now()
        WHERE key = 'topup_packs'
        """
    )


def downgrade() -> None:
    op.drop_column("plans", "extra_seat_price_usd_cents")
    op.drop_column("plans", "annual_price_usd_cents")
    op.drop_column("plans", "monthly_price_usd_cents")
    # topup_packs intentionally left at the USD-anchored values — reverting the
    # column additions does not invalidate the corrected pack prices, and the
    # previous (₹84-rate) values were the bug this release fixes.
