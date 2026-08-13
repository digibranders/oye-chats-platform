"""merge bot_answer_links and credit_attributed_bot heads

Both ``a9fc12693ff6`` (credit_ledger.attributed_bot_id) and ``c9e2a4f7b1d3``
(bots.answer_links) branched off ``e4c2a8b17f65``, leaving two heads. This is a
no-op merge that rejoins them into a single head so ``alembic upgrade head``
resolves again. No schema changes of its own.

Revision ID: 69d32b38c742
Revises: a9fc12693ff6, c9e2a4f7b1d3
Create Date: 2026-08-13
"""

from collections.abc import Sequence

revision: str = "69d32b38c742"
down_revision: str | Sequence[str] | None = ("a9fc12693ff6", "c9e2a4f7b1d3")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """No-op: this revision only merges two heads."""


def downgrade() -> None:
    """No-op: reverting the merge simply re-exposes the two heads."""
