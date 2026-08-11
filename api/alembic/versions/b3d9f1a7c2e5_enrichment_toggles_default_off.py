"""enrichment toggles default OFF

Flips the two metered lead-enrichment toggles to default OFF, reversing the
intent of ``c3f7a91b2d84`` (which defaulted them ON). Product decision:
enrichment spends credits, so it is an explicit opt-in the customer turns on
when they want it, not a paid feature left running until they find the
settings page. Existing rows are reset to OFF so the new default is what
every agent shows until its owner opts in.

Revision ID: b3d9f1a7c2e5
Revises: d81b4e5c9a37
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

revision: str = "b3d9f1a7c2e5"
down_revision: str | Sequence[str] | None = "d81b4e5c9a37"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "bots"
COLUMNS = ("email_verification_enabled", "company_lookup_enabled")


def _columns() -> set[str] | None:
    """Column names of ``bots``, or None in offline (``--sql``) mode.

    Offline guard is the house standard (see ``c3f7a91b2d84``): in ``--sql``
    mode there is no bind to inspect, so we emit the statements unconditionally.
    """
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    existing = _columns()
    for col in COLUMNS:
        if existing is None or col in existing:
            op.alter_column(TABLE, col, server_default=sa.text("false"))
            op.execute(f"UPDATE {TABLE} SET {col} = false")


def downgrade() -> None:
    """Restores the ON server_default. Per-row values are NOT restored.

    The pre-migration true/false split is not recorded anywhere, so the
    row-level UPDATE above is one-way, matching the same caveat on the
    revision this reverses.
    """
    existing = _columns()
    for col in COLUMNS:
        if existing is None or col in existing:
            op.alter_column(TABLE, col, server_default=sa.text("true"))
