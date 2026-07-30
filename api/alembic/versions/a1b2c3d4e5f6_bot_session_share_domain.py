"""bot session_share_domain

Adds an opt-in cross-subdomain session-sharing domain to ``bots``:

  - session_share_domain  VARCHAR NULL

When set to a registrable domain (e.g. ``example.com``), the embedded widget
mirrors the visitor's session id into a cookie scoped to that parent domain, so
a conversation started on ``example.com`` continues on ``academy.example.com``.
NULL/empty keeps the default per-origin behaviour. Read via ``BotResponse`` and
the public ``/bots/settings/public`` payload; written via ``PATCH /bots/{id}``.

Revision ID: a1b2c3d4e5f6
Revises: f1a2b3c4d5e6
Create Date: 2026-07-30
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("session_share_domain", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "session_share_domain")
