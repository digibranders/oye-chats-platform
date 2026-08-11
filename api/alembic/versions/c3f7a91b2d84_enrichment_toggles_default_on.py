"""Per-agent enrichment toggles, both defaulting ON

Adds ``bots.company_lookup_enabled`` and flips
``bots.email_verification_enabled`` to default ON.

## Why ON

Both switches gate METERED enrichment, and both previously defaulted OFF (or,
for company lookup, did not exist — the feature had no customer control at all,
only a super-admin kill switch and the plan gate).

Off-by-default is the wrong posture here: the customer is already paying for a
plan that includes these, so an OFF default leaves a paid feature invisible
until they happen to find a settings page. The useful control is an OFF switch
for someone who does not want the credits spent. Each toggle is one of three
independent gates — plan, super-admin kill switch, customer toggle — and all
three must pass before a credit is deducted.

Company lookup is additionally charged only when a company is actually
IDENTIFIED, so leaving it on costs nothing for the many visitors who resolve to
a consumer ISP.

## Why the UPDATE is safe

``email_verification_enabled`` was added one revision ago
(``a2c4e6f8b0d2``) and has never reached production — ``main`` is many commits
behind, and the production database is being wiped and reseeded before launch.
So no customer has deliberately switched it off; flipping existing rows cannot
override anyone's choice. It only affects dev and staging databases, where the
rows are test data.

Revision ID: c3f7a91b2d84
Revises: a2c4e6f8b0d2
Create Date: 2026-08-11

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

revision: str = "c3f7a91b2d84"
down_revision: str | Sequence[str] | None = "a2c4e6f8b0d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "bots"
NEW_COLUMN = "company_lookup_enabled"
EXISTING_COLUMN = "email_verification_enabled"


def _columns() -> set[str] | None:
    """Column names of ``bots``, or None in offline (``--sql``) mode.

    The offline guard is the house standard (see ``1da557cae107``) and the
    previous revision omitted it, which makes ``alembic upgrade --sql`` raise
    ``NoInspectionAvailable`` on a MockConnection and blocks DDL review. In
    offline mode we emit the statements unconditionally, which is the correct
    output for a SQL script.
    """
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    existing = _columns()

    # ``Base.metadata.create_all()`` runs at app startup, so on any environment
    # that has booted since the model landed the column is already there.
    if existing is None or NEW_COLUMN not in existing:
        op.add_column(
            TABLE,
            sa.Column(NEW_COLUMN, sa.Boolean(), nullable=False, server_default=sa.text("true")),
        )

    # Bring the older toggle's stored default in line with the model, and turn
    # it on for rows created while it defaulted off. Both are no-ops on a fresh
    # database; both matter on a dev DB that already ran the previous revision.
    if existing is None or EXISTING_COLUMN in existing:
        op.alter_column(TABLE, EXISTING_COLUMN, server_default=sa.text("true"))
        op.execute(f"UPDATE {TABLE} SET {EXISTING_COLUMN} = true WHERE {EXISTING_COLUMN} = false")


def downgrade() -> None:
    """Reverses the schema exactly. Does NOT restore per-row values.

    The UPDATE above is not reversible — the pre-migration true/false split is
    not recorded anywhere, and inventing one would be worse than leaving the
    column as it stands. The server_default and the added column both revert.
    """
    existing = _columns()

    if existing is None or EXISTING_COLUMN in existing:
        op.alter_column(TABLE, EXISTING_COLUMN, server_default=sa.text("false"))

    if existing is None or NEW_COLUMN in existing:
        op.drop_column(TABLE, NEW_COLUMN)
