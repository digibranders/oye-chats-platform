"""deactivate the enterprise plan

Removes the "Enterprise" tier from the product. The plan row is DEACTIVATED
(``is_active = false``) rather than deleted so any historical ``subscriptions``
rows that still reference ``plans.id`` keep their foreign key intact.

What ``is_active = false`` actually does, precisely — this is the basis on which
anyone reasons about deactivating a tier, so it must not overstate:

* It removes the plan from the public LISTINGS. ``plan_service.get_active_plans``
  filters on ``is_active``, and both ``GET /subscriptions/plans`` and
  ``GET /public/pricing-catalog`` (the feed oyechats.com/pricing renders) are
  built from it.
* It also makes the plan unquotable and unbuyable: ``/subscriptions/checkout/quote``
  and ``POST /subscriptions/checkout`` both reject an inactive plan outright.
* It does NOT change what an existing subscriber is entitled to. The entitlements
  resolver does not filter on ``is_active`` — ``plan_entitlements_service``
  resolves the plan with an unfiltered ``db_session.get(Plan, subscription.plan_id)``
  (and falls back to an unfiltered ``slug == 'free'`` lookup), by design: a
  paying customer on a retired tier keeps the tier they bought.

Historical note: the Enterprise tier was re-introduced as an agency tier on
2026-08-12 and is a live, listed part of the catalogue again. This migration is
therefore a historical record of the 2026-07-22 removal, not a current statement
about the product. It stays in the chain because migrations are append-only, and
it is harmless on a fresh database (see below).

Idempotent: matches ``slug = 'enterprise'`` and is a no-op on a database where
the plan was already removed or never seeded. On a WIPED database it matches
zero rows — the baseline schema seeds no plan rows — and ``scripts/seed_plans.py``
then inserts Enterprise listed. That is deliberate under the current policy: a
paid tier with no gateway plan id stays listed and degrades to contact-sales
rather than disappearing. The seed writes ``is_active`` only on INSERT, never on
UPDATE, so on any database where this migration DID match a row, the
deactivation survives every subsequent reseed.

Revision ID: f1a2b3c4d5e6
Revises: d3f7a1b9c2e4
Create Date: 2026-07-22
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f1a2b3c4d5e6"
down_revision: str | Sequence[str] | None = "d3f7a1b9c2e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(sa.text("UPDATE plans SET is_active = false WHERE slug = 'enterprise'"))


def downgrade() -> None:
    # Best-effort restore: re-activate the row if it still exists. If the plan
    # was hard-deleted after this migration ran, downgrade is simply a no-op.
    op.execute(sa.text("UPDATE plans SET is_active = true WHERE slug = 'enterprise'"))
