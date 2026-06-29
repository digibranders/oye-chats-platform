"""Convert plan prices from USD-cents to INR-paise.

Background
----------
Migrations e1f2a3b4c5d6 and f2a3b4c5d6e7 stored plan prices in USD-cents
(e.g. 1900 for $19/mo) with ``currency = 'USD'``. The subsequent seed
migration d3e4f5a6b7c8 preserved those USD-cent values.

This created two bugs:

1. ``/subscriptions/checkout/quote`` for Indian visitors treats
   ``plan.monthly_price_cents`` directly as paise (the minor unit of INR),
   so the Starter plan displayed as ₹19 instead of ₹1,799.

2. Razorpay subscriptions are created using ``plan.razorpay_plan_id_monthly/
   annual`` — the actual charge amount is defined in the Razorpay dashboard
   plan, not our DB. But the display prices must match those Razorpay plan
   amounts (INR paise) so the checkout quote and plan picker are accurate.

This migration:
* Sets ``currency = 'INR'`` on all plan rows.
* Re-prices plans in INR-paise at the verified mid-market rate of ₹94.67/$1
  (June 25, 2026 — source: exchangerates.org.uk / Federal Reserve H.10).
* Uses psychological pricing rounded to the nearest ₹1 below a clean number.
* Annual prices are monthly × 12 × 0.80 (20% annual discount).
* Extra seat add-on updated to ₹499/mo (≈$5).
* ``pricing_config.seat_price_cents`` synced to the same paise value.

Razorpay dashboard plans must be created (or updated) to match these
exact amounts. After creating them, populate ``razorpay_plan_id_monthly``
and ``razorpay_plan_id_annual`` on each plan row via the super-admin panel
or the ``scripts/set_razorpay_plan_ids.py`` helper.

Revision ID: a9b8c7d6e5f4
Revises:     f7e6d5c4b3a2
Create Date: 2026-06-25
"""

import sqlalchemy as sa

from alembic import op

revision = "a9b8c7d6e5f4"
down_revision = "f7e6d5c4b3a2"
branch_labels = None
depends_on = None

# ── INR paise values (1 rupee = 100 paise) ────────────────────────────────
#
# Rate used: ₹94.67 / $1  (mid-market, June 25 2026)
#
# Starter monthly:  $19 × 94.67 = ₹1,798.73 → ₹1,799
# Starter annual:   ₹1,799 × 12 × 0.80 = ₹17,270  → ₹17,299  (saves ₹4,289)
# Standard monthly: $49 × 94.67 = ₹4,638.83 → ₹4,599  (psychological)
# Standard annual:  ₹4,599 × 12 × 0.80 = ₹44,150  → ₹44,099  (saves ₹11,089)
# Extra seat:       $5  × 94.67 = ₹473.35  → ₹499

_STARTER_MONTHLY_PAISE = 179900  # ₹1,799
_STARTER_ANNUAL_PAISE = 1729900  # ₹17,299
_STANDARD_MONTHLY_PAISE = 459900  # ₹4,599
_STANDARD_ANNUAL_PAISE = 4409900  # ₹44,099
_SEAT_PAISE = 49900  # ₹499

# Previous USD-cent values (for downgrade)
_PREV_STARTER_MONTHLY = 1900
_PREV_STARTER_ANNUAL = 18240
_PREV_STANDARD_MONTHLY = 4900
_PREV_STANDARD_ANNUAL = 47040
_PREV_SEAT_USD_CENTS = 500


def upgrade() -> None:
    conn = op.get_bind()

    # Free plan — price stays zero, just update currency.
    conn.execute(
        sa.text(
            "UPDATE plans SET currency = 'INR', "
            "monthly_price_cents = 0, annual_price_cents = 0, "
            "extra_seat_price_cents = :seat WHERE slug = 'free'"
        ),
        {"seat": _SEAT_PAISE},
    )

    # Starter
    conn.execute(
        sa.text(
            "UPDATE plans SET currency = 'INR', "
            "monthly_price_cents = :mo, annual_price_cents = :yr, "
            "extra_seat_price_cents = :seat WHERE slug = 'starter'"
        ),
        {"mo": _STARTER_MONTHLY_PAISE, "yr": _STARTER_ANNUAL_PAISE, "seat": _SEAT_PAISE},
    )

    # Standard
    conn.execute(
        sa.text(
            "UPDATE plans SET currency = 'INR', "
            "monthly_price_cents = :mo, annual_price_cents = :yr, "
            "extra_seat_price_cents = :seat WHERE slug = 'standard'"
        ),
        {"mo": _STANDARD_MONTHLY_PAISE, "yr": _STANDARD_ANNUAL_PAISE, "seat": _SEAT_PAISE},
    )

    # Enterprise — price stays zero / custom.
    conn.execute(
        sa.text(
            "UPDATE plans SET currency = 'INR', "
            "monthly_price_cents = 0, annual_price_cents = 0, "
            "extra_seat_price_cents = :seat WHERE slug = 'enterprise'"
        ),
        {"seat": _SEAT_PAISE},
    )

    # Sync the seat add-on pricing_config row so the Razorpay seat-checkout
    # path reads the same paise value the plan rows show in the UI.
    # NOTE: ``_SEAT_PAISE`` is an int constant, so f-string interpolation here
    # is injection-safe — and it avoids the ``:param::jsonb`` bind+cast clash
    # that SQLAlchemy's text() parser mis-reads. Mirrors the sibling
    # e1f2a3b4c5d6 / f2a3b4c5d6e7 migrations' literal-cast pattern.
    conn.execute(
        sa.text(
            f"UPDATE pricing_config SET value = '{_SEAT_PAISE}'::jsonb, updated_at = NOW() "
            "WHERE key = 'seat_price_cents'"
        )
    )


def downgrade() -> None:
    conn = op.get_bind()

    conn.execute(
        sa.text(
            "UPDATE plans SET currency = 'USD', "
            "monthly_price_cents = 0, annual_price_cents = 0, "
            "extra_seat_price_cents = :seat WHERE slug = 'free'"
        ),
        {"seat": _PREV_SEAT_USD_CENTS},
    )

    conn.execute(
        sa.text(
            "UPDATE plans SET currency = 'USD', "
            "monthly_price_cents = :mo, annual_price_cents = :yr, "
            "extra_seat_price_cents = :seat WHERE slug = 'starter'"
        ),
        {"mo": _PREV_STARTER_MONTHLY, "yr": _PREV_STARTER_ANNUAL, "seat": _PREV_SEAT_USD_CENTS},
    )

    conn.execute(
        sa.text(
            "UPDATE plans SET currency = 'USD', "
            "monthly_price_cents = :mo, annual_price_cents = :yr, "
            "extra_seat_price_cents = :seat WHERE slug = 'standard'"
        ),
        {"mo": _PREV_STANDARD_MONTHLY, "yr": _PREV_STANDARD_ANNUAL, "seat": _PREV_SEAT_USD_CENTS},
    )

    conn.execute(
        sa.text(
            "UPDATE plans SET currency = 'USD', "
            "monthly_price_cents = 0, annual_price_cents = 0, "
            "extra_seat_price_cents = :seat WHERE slug = 'enterprise'"
        ),
        {"seat": _PREV_SEAT_USD_CENTS},
    )

    conn.execute(
        sa.text(
            f"UPDATE pricing_config SET value = '{_PREV_SEAT_USD_CENTS}'::jsonb, updated_at = NOW() "
            "WHERE key = 'seat_price_cents'"
        )
    )
