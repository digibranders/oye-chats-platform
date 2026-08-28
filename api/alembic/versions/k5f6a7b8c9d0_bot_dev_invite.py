"""record who the install snippet was emailed to, and when

The Deploy page's "Email this to my developer" was a ``mailto:`` link. It
handed the briefing to the operating system and lost sight of it, so the
product could not say whether anything was ever sent, and the green tick beside
the button meant "you clicked" and reset on reload.

Two columns on ``bots`` make the send a fact:

* ``dev_invite_email`` - the last address the briefing went to.
* ``dev_invite_sent_at`` - when it went.

Per bot, because the snippet is per bot. Only the most recent send is kept: the
console confirms before re-sending to the SAME address, so the last recipient is
the only value it compares against. NULL on both means never sent, and there is
no backfill - a customer who used the old mailto link left no record to restore.

Revision ID: k5f6a7b8c9d0
Revises: b5e9d1c47a30
Create Date: 2026-08-27
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "k5f6a7b8c9d0"
down_revision: str | Sequence[str] | None = "b5e9d1c47a30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("dev_invite_email", sa.String(), nullable=True))
    op.add_column("bots", sa.Column("dev_invite_sent_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "dev_invite_sent_at")
    op.drop_column("bots", "dev_invite_email")
