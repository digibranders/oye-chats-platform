"""Add credit-based billing system: credit_ledger, pricing_config, processed_webhooks.

Adds plan-level credit allowances and operator-seat add-on pricing to plans,
introduces the credit_ledger as the single source of truth for credit balances
(FIFO consumption with optional 12-month expiry on top-ups), and adds a
key/value pricing_config table that lets the super admin tune credit costs and
top-up packs without code changes.

Drops the legacy `usage_records` counter table — replaced by event-sourced
ledger. Keeps `plans.limits` / `plans.features` JSONB columns in place as
read-only legacy until Phase 10 cleanup.

Revision ID: c1d2e3f4a5b6
Revises: a8b9c0d1e2f3
Create Date: 2026-04-27
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision = "c1d2e3f4a5b6"
down_revision = "a8b9c0d1e2f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # NOTE: this migration is purely additive — it does NOT drop `usage_records`
    # or remove `plans.limits` / `plans.features`. Those are retained until Phase
    # 10 (cleanup) so that the legacy usage_service can keep functioning while
    # hot paths are migrated incrementally to credit_service.

    # ── Plan: add credit-based fields ──
    op.add_column(
        "plans",
        sa.Column("credits_per_month", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "plans",
        sa.Column("included_operator_seats", sa.Integer(), server_default="1", nullable=False),
    )
    op.add_column(
        "plans",
        sa.Column("extra_seat_price_cents", sa.Integer(), server_default="1500", nullable=False),
    )

    # ── Subscription: track purchased seat count (above the included number) ──
    # Reuses the existing `operator_quantity` column to represent total seats
    # held by the customer (= included + extras). No new column needed.

    # ── credit_reason ENUM ──
    credit_reason = postgresql.ENUM(
        "plan_grant",
        "topup",
        "ai_chat",
        "url_scan",
        "email_send",
        "manual_adjust",
        "refund",
        "expiry",
        name="credit_reason",
    )
    credit_reason.create(op.get_bind(), checkfirst=True)

    # ── credit_ledger ──
    op.create_table(
        "credit_ledger",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("client_id", sa.Integer(), nullable=False),
        # Signed delta: positive for grants, negative for deductions/expiries.
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column(
            "reason",
            postgresql.ENUM(
                "plan_grant",
                "topup",
                "ai_chat",
                "url_scan",
                "email_send",
                "manual_adjust",
                "refund",
                "expiry",
                name="credit_reason",
                create_type=False,
            ),
            nullable=False,
        ),
        # For deductions: foreign reference (chat_message_id, document_id, etc.).
        sa.Column("reference_id", sa.Integer(), nullable=True),
        # For deductions: which grant entry this consumption was allocated against (FIFO).
        # For expiries: the topup grant being expired.
        sa.Column("grant_id", sa.Integer(), nullable=True),
        # Only set on top-up grants (NULL for plan_grant / manual_adjust).
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["grant_id"], ["credit_ledger.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["clients.id"], ondelete="SET NULL"),
    )
    op.create_index(
        "ix_credit_ledger_client_created",
        "credit_ledger",
        ["client_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_credit_ledger_topup_expiry",
        "credit_ledger",
        ["expires_at"],
        postgresql_where=sa.text("expires_at IS NOT NULL AND delta > 0"),
    )
    op.create_index("ix_credit_ledger_grant_id", "credit_ledger", ["grant_id"])
    op.create_index("ix_credit_ledger_reference_id", "credit_ledger", ["reference_id"])

    # ── pricing_config (key/value, super-admin tunable) ──
    op.create_table(
        "pricing_config",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["updated_by"], ["clients.id"], ondelete="SET NULL"),
    )

    # ── processed_webhooks (idempotency for Stripe/Razorpay replays) ──
    op.create_table(
        "processed_webhooks",
        sa.Column("event_id", sa.Text(), primary_key=True),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column(
            "processed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_processed_webhooks_provider", "processed_webhooks", ["provider"])

    # ── Seed pricing config ──
    op.execute(
        """
        INSERT INTO pricing_config (key, value) VALUES
            ('credit_cost.ai_chat',     '1'::jsonb),
            ('credit_cost.url_scan',    '3'::jsonb),
            ('credit_cost.email_send',  '1'::jsonb),
            ('seat_price_cents',        '1500'::jsonb),
            ('topup_expiry_months',     '12'::jsonb),
            ('low_balance_warn_pct',    '20'::jsonb),
            ('kill_switch',             'false'::jsonb),
            ('topup_packs', '[
                {"usd":  20, "credits":  2000, "bonus_pct":  0,  "stripe_price_id": null, "razorpay_plan_id": null},
                {"usd":  50, "credits":  5500, "bonus_pct": 10, "stripe_price_id": null, "razorpay_plan_id": null},
                {"usd": 100, "credits": 12000, "bonus_pct": 20, "stripe_price_id": null, "razorpay_plan_id": null, "badge": "Best value"},
                {"usd": 250, "credits": 32500, "bonus_pct": 30, "stripe_price_id": null, "razorpay_plan_id": null}
            ]'::jsonb)
        """
    )

    # ── Reseed plans with credit-based values (in-place updates keep existing IDs) ──
    # Free
    op.execute(
        """
        UPDATE plans SET
            monthly_price_cents = 0,
            annual_price_cents = 0,
            credits_per_month = 500,
            included_operator_seats = 1,
            extra_seat_price_cents = 1500,
            features = jsonb_set(features, '{live_chat}', 'false'::jsonb)
        WHERE slug = 'free'
        """
    )
    # Starter
    op.execute(
        """
        UPDATE plans SET
            monthly_price_cents = 1900,
            annual_price_cents = 15900,
            credits_per_month = 2000,
            included_operator_seats = 1,
            extra_seat_price_cents = 1500,
            features = jsonb_set(features, '{live_chat}', 'true'::jsonb)
        WHERE slug = 'starter'
        """
    )
    # Standard — note: plan was previously $34/mo; new pricing is $57/mo per the plan
    op.execute(
        """
        UPDATE plans SET
            monthly_price_cents = 5700,
            annual_price_cents = 48000,
            credits_per_month = 10000,
            included_operator_seats = 2,
            extra_seat_price_cents = 1500,
            features = jsonb_set(jsonb_set(features, '{live_chat}', 'true'::jsonb), '{bant}', 'true'::jsonb)
        WHERE slug = 'standard'
        """
    )
    # Enterprise — credits left at 0 (custom; super admin manually grants)
    op.execute(
        """
        UPDATE plans SET
            credits_per_month = 0,
            included_operator_seats = 0,
            extra_seat_price_cents = 1500
        WHERE slug = 'enterprise'
        """
    )


def downgrade() -> None:
    # Drop credit-system tables
    op.drop_index("ix_processed_webhooks_provider", table_name="processed_webhooks")
    op.drop_table("processed_webhooks")
    op.drop_table("pricing_config")
    op.drop_index("ix_credit_ledger_reference_id", table_name="credit_ledger")
    op.drop_index("ix_credit_ledger_grant_id", table_name="credit_ledger")
    op.drop_index("ix_credit_ledger_topup_expiry", table_name="credit_ledger")
    op.drop_index("ix_credit_ledger_client_created", table_name="credit_ledger")
    op.drop_table("credit_ledger")
    op.execute("DROP TYPE IF EXISTS credit_reason")

    # Revert Plan columns
    op.drop_column("plans", "extra_seat_price_cents")
    op.drop_column("plans", "included_operator_seats")
    op.drop_column("plans", "credits_per_month")
