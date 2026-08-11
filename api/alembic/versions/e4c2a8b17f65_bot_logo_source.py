"""add bots.bot_logo_source (avatar provenance)

Records who last wrote a bot's avatar: NULL (nobody ever has), "manual" (the
customer, by uploading one or by removing one), or "derived" (the crawl, from
the site's favicon).

Exists because `bot_logo IS NULL` answers the wrong question. It cannot tell an
agent nobody has touched from one whose owner deliberately deleted the picture
— both are an empty slot — so the favicon step re-derived the avatar the
customer had just removed, and there was no way for them to say "no". The
derivation now runs only while this column is NULL.

Nullable with no server default on purpose: NULL is a real, meaningful state
here (never set), not a placeholder for one. Existing rows therefore read as
"nobody has set this", which is right for an agent that never had an avatar and
harmless for one that has — a non-empty `bot_logo` short-circuits the crawl's
avatar step before this column is consulted.

Revision ID: e4c2a8b17f65
Revises: b3d9f1a7c2e5
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

revision: str = "e4c2a8b17f65"
down_revision: str | Sequence[str] | None = "b3d9f1a7c2e5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "bots"
COLUMN = "bot_logo_source"


def _columns() -> set[str] | None:
    """Column names of ``bots``, or None in offline (``--sql``) mode.

    Offline guard is the house standard (see ``b3d9f1a7c2e5``): in ``--sql``
    mode there is no bind to inspect, so the statement is emitted regardless.
    """
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    existing = _columns()
    if existing is None or COLUMN not in existing:
        op.add_column(TABLE, sa.Column(COLUMN, sa.String(), nullable=True))


def downgrade() -> None:
    existing = _columns()
    if existing is None or COLUMN in existing:
        op.drop_column(TABLE, COLUMN)
