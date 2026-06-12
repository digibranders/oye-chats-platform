"""Restrict the 14-day free trial to the Starter plan.

Product decision: only Starter offers a free trial. Standard customers
either pay upfront or upgrade from an existing Starter trial. The CTA
machinery already keys off ``Plan.trial_days`` (the modal's
``canStartTrial`` predicate, the ``start_trial`` backend service, the
trial-expiry cron), so flipping Standard's ``trial_days`` to ``0``
removes the trial path everywhere at once — no frontend code change
needed, no orphan flags to clean up.

Existing Standard trials in flight are unaffected: the cron filters on
``Subscription.status``, not on the plan's current ``trial_days``.

Revision ID: c4d5e6f7a8b9
Revises: b3c4d5e6f7a8
Create Date: 2026-06-11
"""

from alembic import op

revision = "c4d5e6f7a8b9"
down_revision = "b3c4d5e6f7a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE plans SET trial_days = 0 WHERE slug = 'standard'")


def downgrade() -> None:
    op.execute("UPDATE plans SET trial_days = 14 WHERE slug = 'standard'")
