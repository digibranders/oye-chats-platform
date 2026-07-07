"""merge auto-recrawl and chat_sessions index heads

Two migrations branched off the same parent ``c1e7a9d3f2b4`` in parallel:

* ``d1e7c9f4a3b6_auto_recrawl_bot_fields.py``
* ``f4a1c2d3e5b7_index_chat_sessions_client_id.py``

This empty merge revision unifies them so ``alembic upgrade head`` has a
single target again. No schema change — the ``down_revision`` tuple is
the whole point.

Revision ID: e5b8a2c9d7f4
Revises: d1e7c9f4a3b6, f4a1c2d3e5b7
Create Date: 2026-07-07 12:00:00.000000
"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "e5b8a2c9d7f4"
down_revision: str | Sequence[str] | None = ("d1e7c9f4a3b6", "f4a1c2d3e5b7")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema — no-op merge."""


def downgrade() -> None:
    """Downgrade schema — no-op merge."""
