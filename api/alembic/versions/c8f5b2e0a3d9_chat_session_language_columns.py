"""add chat_sessions language columns for multilingual feature

Adds language state columns to chat_sessions: language_code, locale,
language_source, language_confidence, language_locked, and language_changed_at.

Revision ID: c8f5b2e0a3d9
Revises: b7e4a1c9d2f8
Create Date: 2026-08-22
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

# revision identifiers, used by Alembic.
revision: str = "c8f5b2e0a3d9"
down_revision: str | Sequence[str] | None = "b7e4a1c9d2f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "chat_sessions"

# Column NAMES only. The sa.Column objects themselves are built fresh inside
# upgrade() by _new_columns(): op.add_column() attaches the Column it is given
# to a Table, and a Column instance can only ever be attached to one. Holding
# them in a module-level dict meant a second upgrade() in the same process
# (upgrade -> downgrade -> upgrade, which is how the migration is tested) died
# with "Column object 'language_code' already assigned to Table 'chat_sessions'".
COLUMN_NAMES = (
    "language_code",
    "locale",
    "language_source",
    "language_confidence",
    "language_locked",
    "language_changed_at",
)


def _new_columns() -> dict[str, sa.Column]:
    """Fresh, unbound Column objects. Never cache these at module level."""
    return {
        "language_code": sa.Column("language_code", sa.String(16), nullable=True),
        "locale": sa.Column("locale", sa.String(32), nullable=True),
        "language_source": sa.Column("language_source", sa.String(32), nullable=True),
        "language_confidence": sa.Column("language_confidence", sa.Float(), nullable=True),
        "language_locked": sa.Column(
            "language_locked",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        "language_changed_at": sa.Column(
            "language_changed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    }


def _columns() -> set[str] | None:
    """Column names of ``chat_sessions``, or None in offline (``--sql``) mode."""
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    existing = _columns()
    for name, col in _new_columns().items():
        if existing is None or name not in existing:
            op.add_column(TABLE, col)


def downgrade() -> None:
    existing = _columns()
    for name in COLUMN_NAMES:
        if existing is None or name in existing:
            op.drop_column(TABLE, name)
