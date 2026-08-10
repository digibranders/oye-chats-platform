"""Add email_verification + company_name to the credit_reason enum

Two new metered enrichment actions bill against the credit ledger:

* ``email_verification`` — Reoon power-mode email check, charged once per
  background lead enrichment (Standard + Professional plans).
* ``company_name`` — IP → company / firmographic lookup (Visitor Intelligence),
  charged once per resolved visitor (Professional only).

Both write ``CreditLedger`` deduction rows, so the native PostgreSQL enum
``credit_reason`` must learn the two labels before the app can insert them.

``ALTER TYPE ... ADD VALUE`` is transactional on PostgreSQL 12+ as long as the
new label is not *used* in the same transaction (it isn't here — only the enum
grows). ``IF NOT EXISTS`` makes the upgrade idempotent so it is safe to re-run.

PostgreSQL has no ``DROP VALUE``; the downgrade is intentionally a no-op — an
orphaned enum label is harmless and removing it would fail if any ledger row
already references it.

Revision ID: f5a1c2b3d4e6
Revises: a7f3c1e94b26
Create Date: 2026-08-10

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f5a1c2b3d4e6"
down_revision: str | Sequence[str] | None = "a7f3c1e94b26"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW_VALUES = ("email_verification", "company_name")


def upgrade() -> None:
    bind = op.get_bind()
    # SQLite (throwaway test fixtures) models the column as plain VARCHAR — the
    # enum type does not exist there, so there is nothing to alter.
    if bind.dialect.name != "postgresql":
        return
    for value in _NEW_VALUES:
        op.execute(f"ALTER TYPE credit_reason ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value; leaving the label in place is
    # harmless. No-op by design.
    pass
