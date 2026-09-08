"""Give the operator's lobby card a wait it can actually measure.

The lobby card escalates from accent to amber to danger as a visitor waits.
None of that ever ran in production: the operator websocket's ``queue_update``
rows carried no timestamp, so the card pinned itself to "just arrived" for
every visitor, forever, and the wait number never rendered at all.

``chat_sessions.waiting_since``
    Stamped whenever the session enters the waiting queue. Not ``created_at``,
    which records when the visitor opened the widget: somebody who talks to the
    bot for twenty minutes before asking for a human would arrive already
    overdue, and the escalation would mean nothing.

``chat_sessions.requeue_reason``
    ``handoff`` | ``transfer`` | ``operator_dropped``. An operator dropping
    their live chats re-queues them, which restarts the clock. This says why,
    so the card can tell the next operator that this visitor has already been
    let down once without the timer having to lie about it.

Both nullable, no backfill. Existing rows keep NULL and render exactly as they
do today, which is the right behaviour for a new column.

Revision ID: b1000007waitsince
Revises: b1000006platform
Create Date: 2026-09-08

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000007waitsince"
down_revision: str | None = "b1000006platform"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column("chat_sessions", sa.Column("waiting_since", sa.DateTime(timezone=True), nullable=True))
    op.add_column("chat_sessions", sa.Column("requeue_reason", sa.String(length=24), nullable=True))


def downgrade() -> None:
    op.drop_column("chat_sessions", "requeue_reason")
    op.drop_column("chat_sessions", "waiting_since")
