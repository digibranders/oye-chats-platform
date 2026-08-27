"""add bots.demo_screenshot_* (hosted demo page backdrop)

The hosted demo page (``GET /demo/{bot_key}``) could only ever show a generic
hero page, because the alternative on offer was framing the customer's live
site and roughly 40% of sites forbid that outright (``X-Frame-Options`` or a
CSP ``frame-ancestors``). These four columns hold a screenshot of the
customer's OWN site, captured on the worker during training, which the demo
page serves as its backdrop with the real widget live on top. A headless
capture is subject to neither header, so this works for every customer rather
than for the minority whose site happens to allow framing.

``demo_screenshot_source_url`` is stored alongside the timestamp on purpose:
``bots.website`` can change after a capture, and comparing the two is what
distinguishes "this screenshot is of the site they still have" from "this is
their previous site". A timestamp alone cannot answer that.

Nullable, no server default, no backfill. NULL on ``demo_screenshot_status``
is a real state ("never attempted"), and every existing bot is exactly that
until its next training run or an explicit recapture. Rendering falls back to
the hero page whenever there is no usable capture, so no row needs seeding for
the route to behave.

``ADD COLUMN ... NULL`` with no default is a catalog-only change on PostgreSQL
11+: no table rewrite, no per-row work, so this is safe on a large ``bots``
table under load.

Revision ID: b5e9d1c47a30
Revises: a4d7f2c91b06
Create Date: 2026-08-27
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

revision: str = "b5e9d1c47a30"
down_revision: str | Sequence[str] | None = "a4d7f2c91b06"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "bots"
# Built lazily per call: a ``sa.Column`` object binds to the table it is added
# to, so one shared instance cannot be reused across upgrade/downgrade.
COLUMN_TYPES: tuple[tuple[str, object], ...] = (
    ("demo_screenshot_url", sa.String()),
    ("demo_screenshot_captured_at", sa.DateTime(timezone=True)),
    ("demo_screenshot_source_url", sa.String()),
    ("demo_screenshot_status", sa.String()),
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
