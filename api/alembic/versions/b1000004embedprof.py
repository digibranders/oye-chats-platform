"""Embedding profiles: record how every vector was made, per chunk and per bot.

Before this, nothing in the schema said which model, dimension or task type
produced ``documents.embedding``. Every row was implicitly "whatever the
embedder does today", so changing the embedder (a new model, or Gemini's
asymmetric retrieval task types) could not be rolled out at all: the first
re-embedded chunk would have been ranked against un-migrated neighbours from
a different vector space, and the bulk re-embed task selected rows by
``embedding IS NULL`` on a NOT NULL column, so it did nothing.

``documents.embedding_profile``
    The profile the row's ``embedding`` was made under. Vector search compares
    a query only against chunks whose profile matches the bot's.

``bots.embedding_profile``
    The profile the bot's queries and its newly ingested chunks are embedded
    under. The migration task re-embeds a bot's chunks and flips this once
    every chunk is on the new profile, so a bot is always entirely on one
    profile as far as search is concerned.

Both columns default, server-side, to the LEGACY profile
(``gemini-embedding-001/768/v1``: 768-dim, no task type), which is exactly
what every existing row was embedded with. The ORM default for NEW rows is
the current profile (see ``app/core/embedding_profiles.py``), so a bot created
after this deploy ingests with retrieval task types from its first chunk.

No index: the per-bot filter rides the existing ``(bot_id, is_active)``
btree, and the migration scans one bot at a time.

Revision ID: b1000004embedprof
Revises: b1000003pricing
Create Date: 2026-09-07

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000004embedprof"
down_revision: str | None = "b1000003pricing"
branch_labels: None = None
depends_on: None = None

# Frozen here on purpose: a migration must not import application constants
# that may have moved on by the time it runs.
_LEGACY_PROFILE = "gemini-embedding-001/768/v1"


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column("embedding_profile", sa.String(length=48), nullable=False, server_default=_LEGACY_PROFILE),
    )
    op.add_column(
        "documents",
        sa.Column("embedding_profile", sa.String(length=48), nullable=False, server_default=_LEGACY_PROFILE),
    )


def downgrade() -> None:
    op.drop_column("documents", "embedding_profile")
    op.drop_column("bots", "embedding_profile")
