"""Lock BANT qualification behind the Standard tier — flip ``features.bant``
to false on the Starter plan.

Product decision (2026-07): BANT qualification (score gauge, N/B/A/T
dimension chips, evidence trail, "Chatting with AI" panel) becomes a
Standard-and-above feature. Starter and Free customers see locked columns
with an "Upgrade to Standard" CTA instead. Rationale: BANT is the highest
signal-to-price feature in the product and the clearest reason to move
from Starter → Standard; it also runs an extra LLM extraction per turn,
so gating it recovers real per-conversation compute on the lower tier.

Historically the Starter plan row was seeded with ``features.bant = true``
(see ``d3e4f5a6b7c8_seed_plans_canonical_matrix.py``). This migration flips
that single JSONB key. Free stays at ``false`` (unchanged). Standard and
Enterprise stay at ``true`` (unchanged) so paying tiers keep the feature.

Idempotent — uses ``jsonb_set`` with ``create_missing=true`` so it's safe
against dev DBs where a super admin has already hand-edited the flag or
removed the key entirely.

Cache note: ``plan_entitlements_service`` caches resolved entitlements in
Redis with a 60s TTL. Existing Starter customers will keep seeing BANT
for up to 60 seconds after this migration lands, then their next request
re-resolves and locks the feature. No manual cache flush needed.

Revision ID: a4d7f2c8e5b1
Revises: f4a2b8e1c9d3
Create Date: 2026-07-13
"""

from alembic import op

revision = "a4d7f2c8e5b1"
down_revision = "f4a2b8e1c9d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Flip ``features.bant`` to ``false`` on the Starter plan row.

    Free/Standard/Enterprise are deliberately not touched — their BANT
    entitlement is already correct in the seed and any deviation there
    would be a hand-edit we shouldn't clobber.
    """
    op.execute(
        """
        UPDATE plans
           SET features = jsonb_set(
                   COALESCE(features, '{}'::jsonb),
                   '{bant}',
                   'false'::jsonb,
                   true
               )
         WHERE slug = 'starter'
        """
    )


def downgrade() -> None:
    """Restore ``features.bant = true`` on the Starter plan row.

    Matches the canonical seed in ``d3e4f5a6b7c8_seed_plans_canonical_matrix``.
    """
    op.execute(
        """
        UPDATE plans
           SET features = jsonb_set(
                   COALESCE(features, '{}'::jsonb),
                   '{bant}',
                   'true'::jsonb,
                   true
               )
         WHERE slug = 'starter'
        """
    )
