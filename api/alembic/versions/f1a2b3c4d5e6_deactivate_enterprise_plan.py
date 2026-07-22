"""deactivate the enterprise plan

Removes the "Enterprise" tier from the product. The plan row is DEACTIVATED
(``is_active = false``) rather than deleted so any historical ``subscriptions``
rows that still reference ``plans.id`` keep their foreign key intact — a
deactivated plan disappears from every public listing (``/subscriptions/plans``
and the entitlements resolver both filter on ``is_active``) without breaking
referential integrity.

Idempotent: matches ``slug = 'enterprise'`` and is a no-op on a database where
the plan was already removed or never seeded.

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
