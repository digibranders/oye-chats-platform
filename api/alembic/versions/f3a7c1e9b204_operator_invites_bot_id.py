"""operator_invites.bot_id — invites are bot-scoped

Operators are strictly bot-scoped: ``operators.bot_id`` is NOT NULL, so an
Operator can only be created for a specific bot. An invite exists to create an
Operator on acceptance, therefore it must record which bot — and the whole
stack already assumes it does:

* the invite modal sends ``bot_id`` (``createOperatorInvite`` in the app),
* ``CreateInviteRequest.bot_id`` is required and ``InviteView.bot_id`` is
  returned (the Members list filters invites by the selected bot),
* ``invite_service.create_invite`` validates the bot belongs to the workspace
  and stores it, ``accept_invite`` reads ``invite.bot_id`` to build the
  ``Operator``, and seat limits are counted per-bot.

The one thing missing was the column. ``operator_invites`` was born (baseline
schema ``b6c86b4c8434``) without it, and the bot-scoping code was added later
without a matching model column or migration — so ``create_invite`` raised
``TypeError: 'bot_id' is an invalid keyword argument`` at runtime and no invite
could ever be created. This adds the column, its index, and its FK.

NOT NULL, no server default: every invite is bot-scoped and there is no
sensible default bot. This is safe because ``create_invite`` — the only writer
of this table — has never once succeeded (it always raised before insert), so
the table holds no rows to backfill. On a fresh database (the CI migration
check, and every real deploy of this feature) the ``ADD COLUMN`` runs against
an empty table. If some deployment were found to hold legacy rows, this
migration failing loudly is the correct, non-destructive outcome: a human then
decides the backfill rather than the migration inventing a bot.

Index and FK names match what Postgres derives for the model's ``index=True`` /
unnamed ``ForeignKey``, so a database built by ``Base.metadata.create_all()``
(app startup) and one built by this migration converge — and the idempotent
guard skips the DDL when startup already created the column.

Revision ID: f3a7c1e9b204
Revises: e1f2a3b4c5d6
Create Date: 2026-08-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

# revision identifiers, used by Alembic.
revision: str = "f3a7c1e9b204"
down_revision: str | Sequence[str] | None = "e1f2a3b4c5d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "operator_invites"
COLUMN = "bot_id"
INDEX = "ix_operator_invites_bot_id"
# Matches the name Postgres derives for an unnamed FK, so a table built by
# ``create_all`` and one built by this migration end up with the same object.
FK = "operator_invites_bot_id_fkey"


def _has_column() -> bool | None:
    """Whether ``operator_invites`` already has the column, or None when offline.

    House standard (see ``a9fc12693ff6``): in ``--sql`` offline mode there is no
    bind to inspect, so the statements are emitted unconditionally. Online, the
    guard matters because ``app/main.py`` calls ``Base.metadata.create_all()``
    at startup — a database first created from the current models already has
    the column/index/FK, and a bare ``add_column`` would fail the deploy on it.
    """
    if context.is_offline_mode():
        return None
    return COLUMN in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if _has_column():
        return
    op.add_column(TABLE, sa.Column(COLUMN, sa.Integer(), nullable=False))
    op.create_index(INDEX, TABLE, [COLUMN])
    op.create_foreign_key(FK, TABLE, "bots", [COLUMN], ["id"], ondelete="CASCADE")


def downgrade() -> None:
    if _has_column() is False:
        return
    op.drop_constraint(FK, TABLE, type_="foreignkey")
    op.drop_index(INDEX, table_name=TABLE)
    op.drop_column(TABLE, COLUMN)
