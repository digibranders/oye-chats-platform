"""add translation columns for operator multilingual live chat (Phase 4)

Adds to chat_messages: source_language, translations.
Adds to operators:     preferred_locale, supported_languages.
Adds the ``translation`` label to the ``credit_reason`` enum.

``chat_messages.content`` remains the canonical original and is never written
again after insert; ``translations`` is derived data keyed by target language.

The enum label is not optional. Translation is credit-metered, so every
translated message writes a ``CreditLedger`` deduction with
``reason='translation'``. Without the label Postgres rejects the insert with
InvalidTextRepresentation, and because ``charge_for_translation`` deliberately
swallows every exception (a billing problem must never break live chat) the
failure is invisible: translation just silently never happens.

Revision ID: d1b4f7a2c9e6
Revises: c8f5b2e0a3d9
Create Date: 2026-08-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import context, op

# revision identifiers, used by Alembic.
revision: str = "d1b4f7a2c9e6"
down_revision: str | Sequence[str] | None = "c8f5b2e0a3d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MESSAGES_TABLE = "chat_messages"
OPERATORS_TABLE = "operators"

# Column NAMES only. The sa.Column objects themselves are built fresh inside
# upgrade() by the _new_*_columns() factories: op.add_column() attaches the
# Column it is given to a Table, and a Column instance can only ever be
# attached to one. Holding them in a module-level dict makes a second
# upgrade() in the same process (upgrade -> downgrade -> upgrade, which is how
# this migration is tested) die with "Column object 'source_language' already
# assigned to Table 'chat_messages'". Same trap as c8f5b2e0a3d9.
MESSAGE_COLUMN_NAMES = ("source_language", "translations")
OPERATOR_COLUMN_NAMES = ("preferred_locale", "supported_languages")


def _new_message_columns() -> dict[str, sa.Column]:
    """Fresh, unbound Column objects. Never cache these at module level."""
    return {
        "source_language": sa.Column("source_language", sa.String(16), nullable=True),
        "translations": sa.Column("translations", JSONB(), nullable=True),
    }


def _new_operator_columns() -> dict[str, sa.Column]:
    """Fresh, unbound Column objects. Never cache these at module level."""
    return {
        "preferred_locale": sa.Column("preferred_locale", sa.String(32), nullable=True),
        # NOT NULL with a server default so existing rows backfill to [] in the
        # same statement and Phase 5's routing filter never sees NULL.
        "supported_languages": sa.Column(
            "supported_languages",
            JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    }


def _columns(table: str) -> set[str] | None:
    """Column names of ``table``, or None in offline (``--sql``) mode."""
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    # SQLite (throwaway test fixtures) models the column as plain VARCHAR, so
    # the enum type does not exist there and there is nothing to alter.
    # ``ALTER TYPE ... ADD VALUE`` is transactional on PostgreSQL 12+ provided
    # the new label is not USED in the same transaction (it is not here, the
    # enum only grows). IF NOT EXISTS keeps the upgrade re-runnable. Follows
    # f5a1c2b3d4e6, which added the two enrichment labels the same way.
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE credit_reason ADD VALUE IF NOT EXISTS 'translation'")

    existing = _columns(MESSAGES_TABLE)
    for name, col in _new_message_columns().items():
        if existing is None or name not in existing:
            op.add_column(MESSAGES_TABLE, col)

    existing = _columns(OPERATORS_TABLE)
    for name, col in _new_operator_columns().items():
        if existing is None or name not in existing:
            op.add_column(OPERATORS_TABLE, col)


def downgrade() -> None:
    # PostgreSQL cannot drop an enum value, and an orphaned label is harmless,
    # so the `translation` label is deliberately left in place. Same stance as
    # f5a1c2b3d4e6.
    existing = _columns(OPERATORS_TABLE)
    for name in OPERATOR_COLUMN_NAMES:
        if existing is None or name in existing:
            op.drop_column(OPERATORS_TABLE, name)

    existing = _columns(MESSAGES_TABLE)
    for name in MESSAGE_COLUMN_NAMES:
        if existing is None or name in existing:
            op.drop_column(MESSAGES_TABLE, name)
