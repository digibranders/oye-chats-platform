"""add bot_id to invoices (refund clawback scope)

Phase 1 / remediation C2 — records which ledger scope (per-bot ledger vs
client pool) a payment credited, so a refund claws credits back from the same
scope it granted them to.

Revision ID: b8e4d2f1a6c3
Revises: a7f3c9d1e2b4
Create Date: 2026-06-29 17:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b8e4d2f1a6c3"
down_revision: str | Sequence[str] | None = "a7f3c9d1e2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("invoices", sa.Column("bot_id", sa.Integer(), nullable=True))
    op.create_index("ix_invoices_bot_id", "invoices", ["bot_id"])
    op.create_foreign_key(
        "fk_invoices_bot_id_bots",
        "invoices",
        "bots",
        ["bot_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("fk_invoices_bot_id_bots", "invoices", type_="foreignkey")
    op.drop_index("ix_invoices_bot_id", table_name="invoices")
    op.drop_column("invoices", "bot_id")
