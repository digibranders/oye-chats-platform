"""Backfill chat_sessions.bot_id for legacy single-bot-client orphans.

Pre-multi-bot rollout, ``chat_sessions`` rows were created with ``bot_id IS
NULL`` and ``client_id`` set. The new ``ensure_chat_session`` rejects any
row with ``bot_id`` mismatch (including NULL) for the requesting bot,
which would otherwise turn into HTTP 404s for active visitors mid-session.

This migration claims orphan sessions for clients that have **exactly one
bot** — the mapping is unambiguous. Multi-bot clients with orphan rows are
left untouched: those sessions surface as 404 on next touch and the widget
regenerates a fresh ``session_id``. Acceptable tradeoff to preserve the
ownership boundary.

Downgrade is intentionally a no-op: there is no way to know which rows
were originally NULL once they have been claimed, and reverting to NULL
would re-introduce the original bug for any session that has since been
referenced under the new code path.

Revision ID: e7b1f2c4d8a9
Revises: d2e3f4a5b6c7
Create Date: 2026-04-28
"""

from alembic import op

revision = "e7b1f2c4d8a9"
down_revision = "d2e3f4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE chat_sessions cs
        SET    bot_id = b.id
        FROM   bots b
        WHERE  cs.bot_id IS NULL
          AND  cs.client_id IS NOT NULL
          AND  cs.client_id = b.client_id
          AND  (
              SELECT COUNT(*)
              FROM   bots b2
              WHERE  b2.client_id = cs.client_id
          ) = 1;
        """
    )


def downgrade() -> None:
    # Intentional no-op — see module docstring.
    pass
