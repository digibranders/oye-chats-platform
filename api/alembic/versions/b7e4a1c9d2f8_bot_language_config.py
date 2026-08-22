"""add bots.language_config for multilingual feature

Backs the language configuration for bots: default locale, supported locales,
auto-detection toggle, visitor language switch toggle, and operator translation toggle.

Defaults to enabled=false, default_locale="en-IN", supported_locales=["en-IN"],
ensuring complete backward compatibility for all existing bots.

Revision ID: b7e4a1c9d2f8
Revises: e8bf7678526d
Create Date: 2026-08-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import context, op

# revision identifiers, used by Alembic.
revision: str = "b7e4a1c9d2f8"
down_revision: str | Sequence[str] | None = "e8bf7678526d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "bots"
COLUMN = "language_config"


def _columns() -> set[str] | None:
    """Column names of ``bots``, or None in offline (``--sql``) mode."""
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    existing = _columns()
    if existing is None or COLUMN not in existing:
        op.add_column(
            TABLE,
            sa.Column(
                COLUMN,
                postgresql.JSONB(),
                nullable=False,
                server_default=sa.text(
                    "'{\"enabled\": false, \"default_locale\": \"en-IN\", "
                    "\"supported_locales\": [\"en-IN\"], \"auto_detect\": true, "
                    "\"allow_visitor_language_switch\": false, "
                    "\"operator_translation_enabled\": false}'::jsonb"
                ),
            ),
        )


def downgrade() -> None:
    existing = _columns()
    if existing is None or COLUMN in existing:
        op.drop_column(TABLE, COLUMN)
