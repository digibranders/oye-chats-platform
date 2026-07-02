"""Reduce Starter monthly credit allowance from 3,000 to 2,000.

Product/pricing update — brings the backend Starter plan row in line with
the marketing site (which has always advertised 2,000 credits, see
``oyechats-website/src/lib/pricing.ts``). The old 3,000 figure was seeded
by ``d3e4f5a6b7c8`` and never corrected; that mismatch surfaced in the
admin PlanModal where trialing customers were being shown "3,000 credits
/ month" for a plan the pricing page had already re-anchored at 2,000.

Updates BOTH the ``credits_per_month`` column (source for the credit
grant cron) AND the ``limits.credits`` JSON key inside ``limits``, so
every code path that reads either surface sees the same number.

The row is only touched when it still shows the old value — makes the
migration idempotent-ish for any environment that already has 2,000
(e.g. a dev DB whose seed was hand-edited).
"""

from alembic import op

revision = "a4c1e9f8b2d3"
down_revision = "199150a66c11"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE plans
           SET credits_per_month = 2000,
               limits = jsonb_set(limits, '{credits}', '2000'::jsonb, true)
         WHERE slug = 'starter'
           AND credits_per_month = 3000
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE plans
           SET credits_per_month = 3000,
               limits = jsonb_set(limits, '{credits}', '3000'::jsonb, true)
         WHERE slug = 'starter'
           AND credits_per_month = 2000
        """
    )
