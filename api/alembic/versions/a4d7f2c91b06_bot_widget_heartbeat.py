"""add bots.widget_last_seen_at + bots.widget_last_origin (widget heartbeat)

``widget_installed_at`` is stamped exactly once and never refreshed, so the
console can say "the widget was first seen on 3 June" and nothing else. It
cannot say whether the widget is still running, and the origin it was seen on
was computed and thrown away — which is the single most useful fact for an
allow-list support ticket.

These two columns close that gap. ``widget_last_seen_at`` is a heartbeat,
refreshed by ``GET /bots/settings/public`` under two Redis ``SET NX EX`` gates
on PER-BOT keys — an hourly refresh slot plus one allowance for a changed
origin, so at most 2 UPDATEs per bot per hour for any traffic pattern, and none
at all while Redis is unreachable. Neither key includes the hostname: the
endpoint's bot key is public and its ``Origin`` is attacker-supplied, so a
per-origin key would let a loop of forged origins buy one row write and one
hour-long Redis key per request. ``widget_last_origin`` is the hostname of that
bootstrap — browser-forgeable, therefore diagnostic only and never a gate.

Nullable, no server default, no backfill: NULL is a real state here ("not seen
since this shipped"), not a placeholder for one. An install stamped before this
revision reads NULL until its widget next bootstraps, which is exactly what we
know about it.

``ADD COLUMN ... NULL`` with no default is a catalog-only change on PostgreSQL
11+: no table rewrite, no per-row work, so this is safe on a large ``bots``
table under load.

Revision ID: a4d7f2c91b06
Revises: c2e8b41f07d9
Create Date: 2026-08-20
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

revision: str = "a4d7f2c91b06"
# Re-parented from ``c2e8b41f07d9`` onto the tip of the multilingual /
# quotation / branding chain, which production has already run. Both were
# authored against the same parent and left the tree with two heads; the chain
# is linearized rather than joined with a merge revision, matching how the
# quotation branch was reconciled. Nothing here depends on anything in that
# chain: it adds two independent nullable columns to ``bots``, so the only
# thing the move changes is the order they arrive in.
down_revision: str | Sequence[str] | None = "j4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "bots"
# Built lazily per call: a ``sa.Column`` object binds to the table it is added
# to, so one shared instance cannot be reused across upgrade/downgrade.
COLUMN_TYPES: tuple[tuple[str, object], ...] = (
    ("widget_last_seen_at", sa.DateTime(timezone=True)),
    ("widget_last_origin", sa.String()),
)


def _columns() -> set[str] | None:
    """Column names of ``bots``, or None in offline (``--sql``) mode.

    Offline guard is the house standard (see ``e4c2a8b17f65``): in ``--sql``
    mode there is no bind to inspect, so the statements are emitted regardless.
    """
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    existing = _columns()
    for name, type_ in COLUMN_TYPES:
        if existing is None or name not in existing:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    existing = _columns()
    for name, _type in reversed(COLUMN_TYPES):
        if existing is None or name in existing:
            op.drop_column(TABLE, name)
