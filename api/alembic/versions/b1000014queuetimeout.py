"""Default the live chat queue timeout to 60 seconds, and lift bots still on 20.

Product owner, 2026-09-11: 20 seconds was too short for an operator to come
back from another tab or open a push on their phone before the widget offered
"Leave a message". The same wait applies to a busy queue.

``bots.live_chat_queue_timeout_seconds`` is NOT NULL with a server default, so a
bot that never touched the setting holds exactly 20. A bot on any other value
was set by someone and keeps it. A customer who deliberately chose 20 cannot be
told apart from the default and moves to 60 as well; the console field lets
them set it back.

Revision ID: b1000014queuetimeout
Revises: b1000013welcomebackfill
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000014queuetimeout"
down_revision: str | None = "b1000013welcomebackfill"
branch_labels = None
depends_on = None

OLD_DEFAULT_SECONDS = 20
NEW_DEFAULT_SECONDS = 60

LIFT_OLD_DEFAULT_SQL = f"""
UPDATE bots
SET live_chat_queue_timeout_seconds = {NEW_DEFAULT_SECONDS}
WHERE live_chat_queue_timeout_seconds = {OLD_DEFAULT_SECONDS}
"""


def _set_server_default(seconds: int) -> None:
    op.alter_column(
        "bots",
        "live_chat_queue_timeout_seconds",
        existing_type=sa.Integer(),
        existing_nullable=False,
        server_default=str(seconds),
    )


def upgrade() -> None:
    # The UPDATE takes row locks. SET DEFAULT only changes the catalog, but it
    # takes an ACCESS EXCLUSIVE lock on bots, which blocks every read and write of
    # the table and is held until the transaction commits. So the UPDATE runs
    # first and the exclusive lock is taken last, for as short a time as
    # possible. Either lock can queue behind a long transaction on the table:
    # fail fast rather than stall the deploy, and every read waiting behind it.
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(LIFT_OLD_DEFAULT_SQL)
    _set_server_default(NEW_DEFAULT_SECONDS)


def downgrade() -> None:
    # Only the server default is restored: data is not reverted, as a lifted 60 cannot be told from a chosen one.
    _set_server_default(OLD_DEFAULT_SECONDS)
