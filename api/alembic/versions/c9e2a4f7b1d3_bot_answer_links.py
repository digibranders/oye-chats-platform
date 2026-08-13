"""add bots.answer_links (smart keyword→URL links)

Backs the "Smart links" card in the admin Experience → Services & copy tab: an
admin-defined ``list[{"keyword": str, "url": str}]`` that lets the bot hyperlink
a keyword in its answers to the right page (e.g. "pricing" → the pricing page).

Independent of ``bots.services`` — smart links only add hyperlinks, they never
restrict the bot's answer scope. Nullable with no server default: NULL means
"no smart links configured", which is the correct, behaviour-preserving state
for every existing bot.

Revision ID: c9e2a4f7b1d3
Revises: e4c2a8b17f65
Create Date: 2026-08-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import context, op

revision: str = "c9e2a4f7b1d3"
down_revision: str | Sequence[str] | None = "e4c2a8b17f65"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "bots"
COLUMN = "answer_links"


def _columns() -> set[str] | None:
    """Column names of ``bots``, or None in offline (``--sql``) mode.

    Offline guard is the house standard (see ``e4c2a8b17f65``): in ``--sql``
    mode there is no bind to inspect, so the statement is emitted regardless.
    """
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    existing = _columns()
    if existing is None or COLUMN not in existing:
        op.add_column(TABLE, sa.Column(COLUMN, postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    existing = _columns()
    if existing is None or COLUMN in existing:
        op.drop_column(TABLE, COLUMN)
