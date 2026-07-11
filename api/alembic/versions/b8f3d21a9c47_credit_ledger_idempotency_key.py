"""credit ledger: opt-in idempotency_key + partial unique index (finding H)

Adds a nullable, globally-unique idempotency token to credit_ledger and a
partial unique index over deduction rows that carry one. Legacy/per-request
deductions leave it NULL and are unaffected. See app/services/credit_service.py
(check_and_deduct) and docs/billing/2026-07-11-billing-remediation-plan.md.

Revision ID: b8f3d21a9c47
Revises: c4e2f6a8b1d3
Create Date: 2026-07-11 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b8f3d21a9c47"
down_revision: str | Sequence[str] | None = "c4e2f6a8b1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema.

    ``credit_ledger`` is an append-only, high-write table (one row per AI-chat
    deduction and per crawled page). A plain ``CREATE INDEX`` takes a SHARE lock
    that blocks every INSERT for the whole build — and because deploys migrate
    while the OLD app is still serving billing traffic, that would stall the
    hottest revenue path and exhaust the connection pool. So the column add
    (instant, metadata-only for a nullable column) runs transactionally, and the
    unique index is built ``CONCURRENTLY`` in an autocommit block (no long lock).
    A short ``lock_timeout`` makes the brief ShareUpdateExclusive acquisition fail
    fast rather than queue behind a long transaction.
    """
    op.add_column("credit_ledger", sa.Column("idempotency_key", sa.String(), nullable=True))
    with op.get_context().autocommit_block():
        op.execute("SET lock_timeout = '5s'")
        op.create_index(
            "uq_credit_ledger_idempotency_key",
            "credit_ledger",
            ["idempotency_key"],
            unique=True,
            postgresql_where=sa.text("idempotency_key IS NOT NULL AND delta < 0"),
            postgresql_concurrently=True,
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.get_context().autocommit_block():
        op.drop_index(
            "uq_credit_ledger_idempotency_key",
            table_name="credit_ledger",
            postgresql_concurrently=True,
        )
    op.drop_column("credit_ledger", "idempotency_key")
