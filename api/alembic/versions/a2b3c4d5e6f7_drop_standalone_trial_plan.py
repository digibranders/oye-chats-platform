"""Roll back the standalone 'trial' plan; trials now ride on Starter / Standard.

The earlier migration seeded a dedicated ``trial`` plan and made it the
default for new signups. Product decision reversed: the 14-day free
trial is now triggered when a customer clicks Starter or Standard, not
on registration. Those plans already carry ``trial_days=14``, so no
schema change is needed for the new flow — only the seed must move.

Changes:

* DELETE the ``trial`` plan row. Safe because no production subscription
  ever pointed at it (the earlier migration shipped to this dev DB only;
  any prod rollout did it together with this revert).
* Restore ``is_default = true`` on the ``free`` plan so brand-new clients
  land on the free tier (500 credits, no trial) and can opt in to a trial
  by picking Starter / Standard.
* ``data_retention_until`` column + its partial indexes stay — the trial
  expiry cron in PR4 still needs them regardless of which plan the
  trial subscription points at.

Revision ID: a2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-06-11
"""

from alembic import op

revision = "a2b3c4d5e6f7"
down_revision = "f1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Restore the default before removing ``trial`` so ``get_default_plan``
    # never returns NULL between the two statements.
    op.execute("UPDATE plans SET is_default = true WHERE slug = 'free'")
    op.execute("UPDATE plans SET is_default = false WHERE slug = 'trial'")
    # Hide ``trial`` from every plan-listing surface even if the row can't
    # be deleted (e.g. a dev DB has stale test subscriptions pointing at
    # it). ``is_active = false`` keeps existing rows valid but excludes
    # the plan from pricing pages and the start-trial endpoint.
    op.execute("UPDATE plans SET is_active = false WHERE slug = 'trial'")
    # Defensive: only delete the trial plan if nobody is subscribed to it.
    # Should always be true in production (no real rollout pre-revert);
    # this guard prevents a FK constraint failure on dev DBs that did
    # exercise the seed end-to-end.
    op.execute(
        """
        DELETE FROM plans
        WHERE slug = 'trial'
          AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE subscriptions.plan_id = plans.id)
        """
    )


def downgrade() -> None:
    # Re-seed the trial plan with the same shape the previous migration
    # used so a forward redeploy is exactly reversible.
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
    op.execute("UPDATE plans SET is_default = false WHERE slug != 'trial'")
    op.execute("UPDATE plans SET is_default = true WHERE slug = 'trial'")
