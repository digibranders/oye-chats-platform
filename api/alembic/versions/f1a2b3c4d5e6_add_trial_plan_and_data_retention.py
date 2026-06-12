"""Free-trial plan + data-retention tracking.

Adds the data-retention column needed to safely warehouse a customer's
content after their trial expires, and seeds a dedicated ``trial`` plan
that becomes the default for new signups. Existing ``free`` keeps its
historical role but is no longer auto-assigned.

Changes:

* ``subscriptions.data_retention_until`` — when a trial expires without
  conversion the cron sets this to ``trial_end + 15 days``. A second cron
  hard-deletes the bot's documents, sessions, and uploads after that date.
  Nullable because active / paid subscriptions never set it.
* New ``trial`` plan — 14-day free trial, 750 credits, full Standard-tier
  feature set so the prospect experiences the real product (live chat,
  BANT, advanced analytics) rather than a stripped-down preview.
* ``is_default`` flips from ``free`` → ``trial`` so brand-new clients land
  on the trial flow. Pre-existing ``free`` subscribers are untouched.

The status string ``trial_expired`` is a new application-level value that
expiry-cron jobs (next PR) will write into ``subscriptions.status``. No
DB-level enum exists for status, so no schema change is needed for that.

Revision ID: f1a2b3c4d5e6
Revises: e3b7a5d8c2f1
Create Date: 2026-06-11
"""

import sqlalchemy as sa

from alembic import op

revision = "f1a2b3c4d5e6"
down_revision = "e3b7a5d8c2f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add the data-retention timestamp used by the trial-expiry cron.
    op.add_column(
        "subscriptions",
        sa.Column("data_retention_until", sa.DateTime(timezone=True), nullable=True),
    )
    # Partial index — only the rows the cron actually scans every hour.
    op.create_index(
        "ix_subscriptions_data_retention_until",
        "subscriptions",
        ["data_retention_until"],
        unique=False,
        postgresql_where=sa.text("status = 'trial_expired'"),
    )
    # Partial index supports the expiry cron's frequent
    # `WHERE status = 'trialing' AND trial_end < now()` scan.
    op.create_index(
        "ix_subscriptions_trial_end_active",
        "subscriptions",
        ["trial_end"],
        unique=False,
        postgresql_where=sa.text("status = 'trialing'"),
    )

    # 2. Seed the new ``trial`` plan — full Standard-tier feature parity so
    # prospects can evaluate the real product. Credits and message limits
    # are sized to a single attentive evaluation, not a free-forever tier.
    op.execute(
        """
        INSERT INTO plans (
            name, slug, description, pricing_model,
            monthly_price_cents, annual_price_cents, annual_discount_percent,
            trial_days, limits, features,
            overage_rate_cents, credits_per_month,
            included_operator_seats, extra_seat_price_cents,
            is_active, is_default, sort_order
        )
        VALUES (
            'Free Trial',
            'trial',
            '14-day free trial — full access to OyeChats with 750 credits.',
            'flat',
            0, 0, 0,
            14,
            '{"ai_messages": 750, "url_scans": 50, "live_chat_messages": 500, "email_summaries": 100, "email_notifications": 100, "knowledge_pages": 250, "storage_mb": 100, "chat_history_days": 30}',
            '{"live_chat": true, "bant": true, "branding_removable": false, "api_access": false, "webhooks": true, "sso": false, "advanced_analytics": true, "custom_sla": false, "dedicated_csm": false, "whitelabel": false}',
            0,
            750,
            1, 1500,
            true, false, 0
        )
        ON CONFLICT (slug) DO NOTHING
        """
    )

    # 3. Make ``trial`` the default plan. Only one row can carry
    # ``is_default = true`` in practice (enforced at the app layer); flip
    # the old default off first to keep ``get_default_plan()`` deterministic.
    op.execute("UPDATE plans SET is_default = false WHERE slug != 'trial'")
    op.execute("UPDATE plans SET is_default = true WHERE slug = 'trial'")


def downgrade() -> None:
    # Restore ``free`` as the default before removing ``trial`` so no
    # window exists where ``get_default_plan()`` returns NULL.
    op.execute("UPDATE plans SET is_default = true WHERE slug = 'free'")
    op.execute("DELETE FROM plans WHERE slug = 'trial'")

    op.drop_index(
        "ix_subscriptions_trial_end_active",
        table_name="subscriptions",
        postgresql_where=sa.text("status = 'trialing'"),
    )
    op.drop_index(
        "ix_subscriptions_data_retention_until",
        table_name="subscriptions",
        postgresql_where=sa.text("status = 'trial_expired'"),
    )
    op.drop_column("subscriptions", "data_retention_until")
