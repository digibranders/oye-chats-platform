"""invoice cumulative refunded amount

Adds ``invoices.refunded_minor`` — the cumulative refunded amount (minor units)
across ALL refund events for a charge. The refund webhook accumulates each
event's amount (deduped on refund id) so an invoice fully refunded via several
PARTIAL refunds flips to ``status='refunded'`` instead of staying
``partially_refunded`` forever (finding #5).

  - refunded_minor  INTEGER NOT NULL DEFAULT 0

Backfill: existing rows default to 0. Any invoice already ``refunded`` /
``partially_refunded`` keeps its status; the column only drives FUTURE
partial→full transitions, so a 0 backfill is correct (a fully-refunded row is
already labelled ``refunded``).

Revision ID: d3f7a1b9c2e4
Revises: c7d1e9f2a3b4
Create Date: 2026-07-22
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3f7a1b9c2e4"
down_revision: str | Sequence[str] | None = "c7d1e9f2a3b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "invoices",
        sa.Column("refunded_minor", sa.Integer(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("invoices", "refunded_minor")
