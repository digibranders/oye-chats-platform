"""Convert pricing to INR primary, add currency column to plans.

OyeChats targets Indian customers first (UPI is non-negotiable for Indian
SMB SaaS). This migration:

  * Adds ``plans.currency`` (default ``'INR'``).
  * Re-prices the seed plans in INR — values stored in *paise* in
    ``monthly_price_cents`` / ``annual_price_cents`` so the existing column
    layout doesn't change. (The column name is a misnomer in the INR world,
    but renaming would touch too many call sites; we treat the unit as the
    smallest denomination of whatever currency is on the plan.)
  * Replaces ``pricing_config.topup_packs`` with INR-priced packs.
  * Sets ``seat_price_cents`` to the INR equivalent (₹1,199 = 119900 paise).

Existing test data with USD pricing is wiped — we're still in development
and there are no live customers. New seed data:

  Free:        ₹0 / 500 credits / 1 seat
  Starter:     ₹1,499 / 2,000 credits / 1 seat
  Standard:    ₹4,499 / 10,000 credits / 2 seats
  Enterprise:  custom

  Top-ups: ₹1,599 → 2,000  | ₹3,999 → 5,500 (+10%)
           ₹7,999 → 12,000 (+20%, "Best value")
           ₹19,999 → 32,500 (+30%)

Revision ID: d2e3f4a5b6c7
Revises: c1d2e3f4a5b6
Create Date: 2026-04-27
"""

import sqlalchemy as sa

from alembic import op

revision = "d2e3f4a5b6c7"
down_revision = "c1d2e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add currency column to plans
    op.add_column(
        "plans",
        sa.Column("currency", sa.String(length=3), server_default="INR", nullable=False),
    )

    # Re-price plans in INR (paise stored in *_cents columns)
    op.execute(
        """
        UPDATE plans SET
            currency = 'INR',
            monthly_price_cents = 0,
            annual_price_cents = 0,
            credits_per_month = 500,
            included_operator_seats = 1,
            extra_seat_price_cents = 119900,
            description = 'Start exploring AI-powered chat'
        WHERE slug = 'free'
        """
    )
    op.execute(
        """
        UPDATE plans SET
            currency = 'INR',
            monthly_price_cents = 149900,
            annual_price_cents = 1259000,
            annual_discount_percent = 30,
            trial_days = 14,
            credits_per_month = 2000,
            included_operator_seats = 1,
            extra_seat_price_cents = 119900,
            description = 'For growing teams with live chat needs'
        WHERE slug = 'starter'
        """
    )
    op.execute(
        """
        UPDATE plans SET
            currency = 'INR',
            monthly_price_cents = 449900,
            annual_price_cents = 3779000,
            annual_discount_percent = 30,
            trial_days = 14,
            credits_per_month = 10000,
            included_operator_seats = 2,
            extra_seat_price_cents = 119900,
            description = 'Full AI + BANT sales intelligence'
        WHERE slug = 'standard'
        """
    )
    op.execute(
        """
        UPDATE plans SET
            currency = 'INR',
            credits_per_month = 0,
            included_operator_seats = 0,
            extra_seat_price_cents = 119900,
            description = 'Custom credits, dedicated support'
        WHERE slug = 'enterprise'
        """
    )

    # Replace top-up packs and seat price in pricing_config with INR values.
    # Top-up pack ``usd`` field is renamed conceptually to "amount" — the
    # numeric value is now in the configured currency (INR by default).
    op.execute(
        """
        UPDATE pricing_config
        SET value = '119900'::jsonb
        WHERE key = 'seat_price_cents'
        """
    )
    op.execute(
        """
        UPDATE pricing_config
        SET value = '[
            {"amount":   1599, "currency": "INR", "credits":  2000, "bonus_pct":  0,
             "stripe_price_id": null, "razorpay_plan_id": null},
            {"amount":   3999, "currency": "INR", "credits":  5500, "bonus_pct": 10,
             "stripe_price_id": null, "razorpay_plan_id": null},
            {"amount":   7999, "currency": "INR", "credits": 12000, "bonus_pct": 20,
             "stripe_price_id": null, "razorpay_plan_id": null, "badge": "Best value"},
            {"amount":  19999, "currency": "INR", "credits": 32500, "bonus_pct": 30,
             "stripe_price_id": null, "razorpay_plan_id": null}
        ]'::jsonb
        WHERE key = 'topup_packs'
        """
    )

    # Add display-only configuration for the currency symbol so the admin and
    # landing don't have to hardcode it. New keys; harmless if missing.
    op.execute(
        """
        INSERT INTO pricing_config (key, value) VALUES
            ('billing.currency', '"INR"'::jsonb),
            ('billing.currency_symbol', '"₹"'::jsonb),
            ('billing.default_provider', '"razorpay"'::jsonb)
        ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_at = now()
        """
    )


def downgrade() -> None:
    # Revert seed prices to USD-cents (matching c1d2e3f4a5b6 values).
    op.execute(
        "DELETE FROM pricing_config WHERE key IN ('billing.currency', 'billing.currency_symbol', 'billing.default_provider')"
    )
    op.execute(
        """
        UPDATE pricing_config
        SET value = '1500'::jsonb
        WHERE key = 'seat_price_cents'
        """
    )
    op.execute(
        """
        UPDATE pricing_config
        SET value = '[
            {"usd":  20, "credits":  2000, "bonus_pct":  0,  "stripe_price_id": null, "razorpay_plan_id": null},
            {"usd":  50, "credits":  5500, "bonus_pct": 10, "stripe_price_id": null, "razorpay_plan_id": null},
            {"usd": 100, "credits": 12000, "bonus_pct": 20, "stripe_price_id": null, "razorpay_plan_id": null, "badge": "Best value"},
            {"usd": 250, "credits": 32500, "bonus_pct": 30, "stripe_price_id": null, "razorpay_plan_id": null}
        ]'::jsonb
        WHERE key = 'topup_packs'
        """
    )
    op.execute(
        "UPDATE plans SET monthly_price_cents = 0, annual_price_cents = 0, extra_seat_price_cents = 1500 WHERE slug = 'free'"
    )
    op.execute(
        "UPDATE plans SET monthly_price_cents = 1900, annual_price_cents = 15900, extra_seat_price_cents = 1500 WHERE slug = 'starter'"
    )
    op.execute(
        "UPDATE plans SET monthly_price_cents = 5700, annual_price_cents = 48000, extra_seat_price_cents = 1500 WHERE slug = 'standard'"
    )
    op.execute("UPDATE plans SET extra_seat_price_cents = 1500 WHERE slug = 'enterprise'")
    op.drop_column("plans", "currency")
