"""Add pricing, subscription, usage, invoice, and payment method tables.

Revision ID: a1b2c3d4e5f6
Revises: 0f74e2e215f6
Create Date: 2026-04-13
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision = "a1b2c3d4e5f6"
down_revision = "0f74e2e215f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── Plans ──
    op.create_table(
        "plans",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "pricing_model",
            sa.String(),
            server_default="per_operator",
            nullable=False,
        ),
        sa.Column("monthly_price_cents", sa.Integer(), server_default="0", nullable=False),
        sa.Column("annual_price_cents", sa.Integer(), server_default="0", nullable=False),
        sa.Column("annual_discount_percent", sa.Integer(), server_default="30", nullable=False),
        sa.Column("trial_days", sa.Integer(), server_default="14", nullable=False),
        sa.Column(
            "limits",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default='{"ai_messages": 250, "url_scans": 50, "live_chat_messages": 0, "email_summaries": 0, "email_notifications": 0, "knowledge_pages": 50, "storage_mb": 5, "chat_history_days": 7}',
            nullable=False,
        ),
        sa.Column(
            "features",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default='{"live_chat": false, "bant": false, "branding_removable": false, "api_access": false, "webhooks": false, "sso": false, "advanced_analytics": false, "custom_sla": false, "dedicated_csm": false, "whitelabel": false}',
            nullable=False,
        ),
        sa.Column("overage_rate_cents", sa.Integer(), server_default="0", nullable=False),
        sa.Column("stripe_product_id", sa.String(), nullable=True),
        sa.Column("stripe_monthly_price_id", sa.String(), nullable=True),
        sa.Column("stripe_annual_price_id", sa.String(), nullable=True),
        sa.Column("razorpay_plan_id_monthly", sa.String(), nullable=True),
        sa.Column("razorpay_plan_id_annual", sa.String(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_plans_slug"), "plans", ["slug"], unique=True)

    # ── Subscriptions ──
    op.create_table(
        "subscriptions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("plan_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), server_default="trialing", nullable=False),
        sa.Column("billing_cycle", sa.String(), server_default="monthly", nullable=False),
        sa.Column("operator_quantity", sa.Integer(), server_default="1", nullable=False),
        sa.Column("current_period_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("trial_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("trial_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("canceled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.Column(
            "cancel_at_period_end",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
        sa.Column("payment_provider", sa.String(), server_default="stripe", nullable=False),
        sa.Column("stripe_subscription_id", sa.String(), nullable=True),
        sa.Column("stripe_customer_id", sa.String(), nullable=True),
        sa.Column("razorpay_subscription_id", sa.String(), nullable=True),
        sa.Column("razorpay_customer_id", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["plan_id"], ["plans.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_subscriptions_client_id"), "subscriptions", ["client_id"])
    op.create_index(
        op.f("ix_subscriptions_stripe_subscription_id"),
        "subscriptions",
        ["stripe_subscription_id"],
        unique=True,
    )
    op.create_index(
        op.f("ix_subscriptions_stripe_customer_id"),
        "subscriptions",
        ["stripe_customer_id"],
    )
    op.create_index(
        op.f("ix_subscriptions_razorpay_subscription_id"),
        "subscriptions",
        ["razorpay_subscription_id"],
        unique=True,
    )
    op.create_index(
        op.f("ix_subscriptions_razorpay_customer_id"),
        "subscriptions",
        ["razorpay_customer_id"],
    )
    # Partial unique index: only one active/trialing subscription per client
    op.create_index(
        "ix_subscriptions_client_active",
        "subscriptions",
        ["client_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('active', 'trialing', 'past_due')"),
    )

    # ── Usage Records ──
    op.create_table(
        "usage_records",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("plan_id", sa.Integer(), nullable=True),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ai_messages_used", sa.Integer(), server_default="0", nullable=False),
        sa.Column("ai_messages_limit", sa.Integer(), server_default="0", nullable=False),
        sa.Column("live_chat_messages_used", sa.Integer(), server_default="0", nullable=False),
        sa.Column("live_chat_messages_limit", sa.Integer(), server_default="0", nullable=False),
        sa.Column("url_scans_used", sa.Integer(), server_default="0", nullable=False),
        sa.Column("url_scans_limit", sa.Integer(), server_default="0", nullable=False),
        sa.Column("email_summaries_used", sa.Integer(), server_default="0", nullable=False),
        sa.Column("email_summaries_limit", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "email_notifications_used",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "email_notifications_limit",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column("bots_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("operators_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("storage_used_mb", sa.Integer(), server_default="0", nullable=False),
        sa.Column("storage_limit_mb", sa.Integer(), server_default="0", nullable=False),
        sa.Column("overage_messages", sa.Integer(), server_default="0", nullable=False),
        sa.Column("overage_amount_cents", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["plan_id"], ["plans.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_usage_records_client_id"), "usage_records", ["client_id"])
    op.create_index(
        "ix_usage_records_client_period",
        "usage_records",
        ["client_id", "period_start"],
        unique=True,
    )

    # ── Invoices ──
    op.create_table(
        "invoices",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("subscription_id", sa.Integer(), nullable=True),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(), server_default="usd", nullable=False),
        sa.Column("status", sa.String(), server_default="pending", nullable=False),
        sa.Column("stripe_invoice_id", sa.String(), nullable=True),
        sa.Column("razorpay_payment_id", sa.String(), nullable=True),
        sa.Column("invoice_url", sa.String(), nullable=True),
        sa.Column("pdf_url", sa.String(), nullable=True),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=True),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["subscription_id"], ["subscriptions.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_invoices_client_id"), "invoices", ["client_id"])
    op.create_index(
        op.f("ix_invoices_stripe_invoice_id"),
        "invoices",
        ["stripe_invoice_id"],
        unique=True,
    )
    op.create_index(
        op.f("ix_invoices_razorpay_payment_id"),
        "invoices",
        ["razorpay_payment_id"],
        unique=True,
    )

    # ── Payment Methods ──
    op.create_table(
        "payment_methods",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("last4", sa.String(4), nullable=True),
        sa.Column("brand", sa.String(), nullable=True),
        sa.Column("expiry_month", sa.Integer(), nullable=True),
        sa.Column("expiry_year", sa.Integer(), nullable=True),
        sa.Column("is_default", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("stripe_payment_method_id", sa.String(), nullable=True),
        sa.Column("razorpay_token_id", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_payment_methods_client_id"), "payment_methods", ["client_id"])
    op.create_index(
        op.f("ix_payment_methods_stripe_payment_method_id"),
        "payment_methods",
        ["stripe_payment_method_id"],
        unique=True,
    )
    op.create_index(
        op.f("ix_payment_methods_razorpay_token_id"),
        "payment_methods",
        ["razorpay_token_id"],
        unique=True,
    )

    # ── Seed default plans ──
    op.execute(
        """
        INSERT INTO plans (name, slug, description, pricing_model, monthly_price_cents, annual_price_cents, annual_discount_percent, trial_days, limits, features, overage_rate_cents, is_active, is_default, sort_order)
        VALUES
        (
            'Free', 'free', 'Get started with AI chatbot basics',
            'per_operator', 0, 0, 0, 0,
            '{"ai_messages": 250, "url_scans": 50, "live_chat_messages": 0, "email_summaries": 0, "email_notifications": 0, "knowledge_pages": 50, "storage_mb": 5, "chat_history_days": 7}',
            '{"live_chat": false, "bant": false, "branding_removable": false, "api_access": false, "webhooks": false, "sso": false, "advanced_analytics": false, "custom_sla": false, "dedicated_csm": false, "whitelabel": false}',
            0, true, true, 0
        ),
        (
            'Starter', 'starter', 'For growing businesses with live chat needs',
            'per_operator', 1900, 15900, 30, 14,
            '{"ai_messages": 1000, "url_scans": 250, "live_chat_messages": 500, "email_summaries": 250, "email_notifications": 250, "knowledge_pages": 500, "storage_mb": 100, "chat_history_days": 30}',
            '{"live_chat": true, "bant": false, "branding_removable": false, "api_access": false, "webhooks": true, "sso": false, "advanced_analytics": false, "custom_sla": false, "dedicated_csm": false, "whitelabel": false}',
            0, true, false, 1
        ),
        (
            'Standard', 'standard', 'Advanced AI with BANT qualification and priority support',
            'per_operator', 3400, 28500, 30, 14,
            '{"ai_messages": 4000, "url_scans": 1000, "live_chat_messages": 2000, "email_summaries": 1000, "email_notifications": 1000, "knowledge_pages": 2000, "storage_mb": 500, "chat_history_days": -1}',
            '{"live_chat": true, "bant": true, "branding_removable": true, "api_access": true, "webhooks": true, "sso": false, "advanced_analytics": true, "custom_sla": false, "dedicated_csm": false, "whitelabel": false}',
            0, true, false, 2
        ),
        (
            'Enterprise', 'enterprise', 'Custom solution with dedicated support and SLA',
            'custom', 0, 0, 0, 0,
            '{"ai_messages": -1, "url_scans": -1, "live_chat_messages": -1, "email_summaries": -1, "email_notifications": -1, "knowledge_pages": -1, "storage_mb": -1, "chat_history_days": -1}',
            '{"live_chat": true, "bant": true, "branding_removable": true, "api_access": true, "webhooks": true, "sso": true, "advanced_analytics": true, "custom_sla": true, "dedicated_csm": true, "whitelabel": true}',
            0, true, false, 3
        )
        """
    )


def downgrade() -> None:
    op.drop_table("payment_methods")
    op.drop_table("invoices")
    op.drop_table("usage_records")
    op.drop_table("subscriptions")
    op.drop_table("plans")
