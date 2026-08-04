"""client razorpay customer id

Adds ``clients.razorpay_customer_id`` — the Razorpay Customer that saved
payment instruments hang off. Tokens are addressed as
``/v1/customers/{id}/tokens``, so without a customer on the client row there is
no saved-card capability at all.

Distinct from ``subscriptions.razorpay_customer_id``, which is a passive mirror
scraped out of webhook payloads and is routinely NULL even on a live mandate.
This column is the one the application creates and owns.

Additive and backfill-free. UNIQUE is safe on existing data because every row
starts NULL and Postgres permits unlimited NULLs in a unique index.

Index built NON-concurrently on purpose: ``clients`` is a small table (single
digits in production today, and this is a per-account row, not per-event), so
the ACCESS EXCLUSIVE lock is momentary. The CONCURRENTLY path used for
``credit_ledger`` needs an autocommit block and leaves an INVALID index behind
if it fails mid-build — unjustified complexity at this table's size.

Revision ID: c540327852dc
Revises: f0b1b15caf1f
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c540327852dc"
down_revision: str | Sequence[str] | None = "f0b1b15caf1f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("razorpay_customer_id", sa.String(), nullable=True))
    op.create_index(
        op.f("ix_clients_razorpay_customer_id"),
        "clients",
        ["razorpay_customer_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_clients_razorpay_customer_id"), table_name="clients")
    op.drop_column("clients", "razorpay_customer_id")
