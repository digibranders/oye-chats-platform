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
    """Upgrade schema."""
    op.add_column("credit_ledger", sa.Column("idempotency_key", sa.String(), nullable=True))
    # Partial unique index: one deduction row per key. NULL keys are exempt, so
    # every existing per-request deduction is unaffected. A brief lock at build
    # time is acceptable at current volume; if that changes, build the
    # CONCURRENTLY variant out-of-band and stamp this revision.
    op.create_index(
        "uq_credit_ledger_idempotency_key",
        "credit_ledger",
        ["idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL AND delta < 0"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("uq_credit_ledger_idempotency_key", table_name="credit_ledger")
    op.drop_column("credit_ledger", "idempotency_key")
