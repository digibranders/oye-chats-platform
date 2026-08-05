"""invoice kind — clawback routing discriminator

Adds ``invoices.kind`` (plan_charge|seat|topup|withheld_charge, NULL=legacy).
A refund/dispute must reverse only what the refunded charge actually funded;
deriving that from ``subscription_id`` presence (P0-1) made seat add-on and
withheld-credit refunds claw back unrelated plan grants via the
most-recent-grant fallback.

Backfill is deliberately conservative — a row is stamped only where the
classification is certain, because a stamped row LOSES the legacy fallback:

  - kind='seat'  where description = 'Operator seat add-on'  (the dangerous
    class: subscription_id set, no grant ever funded)
  - kind='topup' where description LIKE 'Credits top-up — %%'
  - kind='plan_charge' where subscription_id is set AND a positive plan_grant
    ledger row is linked to the invoice (reference_id) — the linked-grant path
    works for these, so disabling the fallback is safe.

Everything else stays NULL and keeps today's heuristic + fallback.

Revision ID: a1f3c9d47e21
Revises: d8a4c1e07b62
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1f3c9d47e21"
down_revision: str | Sequence[str] | None = "d8a4c1e07b62"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("invoices", sa.Column("kind", sa.String(length=16), nullable=True))

    op.execute("UPDATE invoices SET kind = 'seat' WHERE description = 'Operator seat add-on'")
    # The em-dash literal matches the exact description the topup handler writes.
    op.execute("UPDATE invoices SET kind = 'topup' WHERE description LIKE 'Credits top-up — %'")
    op.execute(
        """
        UPDATE invoices i
           SET kind = 'plan_charge'
         WHERE i.kind IS NULL
           AND i.subscription_id IS NOT NULL
           AND EXISTS (
                SELECT 1
                  FROM credit_ledger cl
                 WHERE cl.reference_id = i.id
                   AND cl.reason = 'plan_grant'
                   AND cl.delta > 0
           )
        """
    )


def downgrade() -> None:
    op.drop_column("invoices", "kind")
