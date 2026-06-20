"""Add USD display fields to INR top-up packs.

Background: the modal needs to advertise headline USD prices ($19, $49,
$99, $249) for international parity with the marketing site, but the
gateway leg is still Razorpay-INR (USD is not enabled on the account
yet — see ``razorpay_service.create_topup_order``). So the same pack
row has to carry two things:

  * The gateway-native ``amount`` + ``currency`` (INR rupees), which the
    backend forwards to Razorpay unchanged.
  * The display-only ``display_amount`` + ``display_currency`` (USD),
    which the admin modal renders so the customer always sees "$19".

INR ↔ USD pairing (matches the existing ``d2e3f4a5b6c7_inr_pricing``
amounts — no actual repricing, just a display flip):

    $19  ↔ ₹1,599  →  2,000  credits
    $49  ↔ ₹3,999  →  5,500  credits  (+10% bonus)
    $99  ↔ ₹7,999  → 12,000  credits  (+20% bonus, Best value)
    $249 ↔ ₹19,999 → 32,500  credits  (+30% bonus)

Revision ID: a2c3e4f5b6d7
Revises: a1c2e3f4b5d6
Create Date: 2026-06-17
"""

from alembic import op

revision = "a2c3e4f5b6d7"
down_revision = "a1c2e3f4b5d6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE pricing_config
        SET value = '[
            {"amount":  1599, "currency": "INR",
             "display_amount":  19, "display_currency": "USD",
             "credits":  2000, "bonus_pct":  0,
             "stripe_price_id": null, "razorpay_plan_id": null},
            {"amount":  3999, "currency": "INR",
             "display_amount":  49, "display_currency": "USD",
             "credits":  5500, "bonus_pct": 10,
             "stripe_price_id": null, "razorpay_plan_id": null},
            {"amount":  7999, "currency": "INR",
             "display_amount":  99, "display_currency": "USD",
             "credits": 12000, "bonus_pct": 20,
             "stripe_price_id": null, "razorpay_plan_id": null,
             "badge": "Best value"},
            {"amount": 19999, "currency": "INR",
             "display_amount": 249, "display_currency": "USD",
             "credits": 32500, "bonus_pct": 30,
             "stripe_price_id": null, "razorpay_plan_id": null}
        ]'::jsonb,
        updated_at = now()
        WHERE key = 'topup_packs'
        """
    )


def downgrade() -> None:
    # Drop the display fields but keep the INR amounts intact — restores
    # the row to exactly what ``d2e3f4a5b6c7_inr_pricing`` wrote.
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
        ]'::jsonb,
        updated_at = now()
        WHERE key = 'topup_packs'
        """
    )
