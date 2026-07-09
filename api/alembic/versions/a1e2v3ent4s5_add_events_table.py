"""Add events table for structured event/webinar extraction.

Backs the Tier 2 date-question routing in ``rag_service``: instead of asking
the LLM to compare crawled date strings against ``today``, event questions
now run a plain SQL query against typed ``starts_at`` values. Idempotent
upsert on ``(bot_id, source_url, title)`` keeps re-crawls from duplicating
rows; ``last_seen_at`` drives the stale-event pruning job.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

revision: str = "a1e2v3ent4s5"
down_revision: str | Sequence[str] | None = "fec42d60624c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Idempotency guard: in dev environments the ``events`` table may already
    # exist (SQLAlchemy ``Base.metadata.create_all`` invoked by a test fixture
    # against the dev DB, or a prior partial migration run). Detect and skip
    # both the table and its indexes rather than aborting the whole upgrade
    # with ``DuplicateTable`` — the schema below matches the ORM model and
    # was safe to create either way.
    bind = op.get_bind()
    inspector = inspect(bind)
    if inspector.has_table("events"):
        existing_indexes = {ix["name"] for ix in inspector.get_indexes("events")}
        for name, cols in (
            ("ix_events_bot_id", ["bot_id"]),
            ("ix_events_bot_starts_at", ["bot_id", "starts_at"]),
            ("ix_events_bot_last_seen_at", ["bot_id", "last_seen_at"]),
        ):
            if name not in existing_indexes:
                op.create_index(name, "events", cols)
        return

    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "bot_id",
            sa.Integer(),
            sa.ForeignKey("bots.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("url", sa.String(), nullable=True),
        sa.Column("location", sa.String(), nullable=True),
        sa.Column("source_url", sa.String(), nullable=False),
        sa.Column(
            "source_chunk_id",
            sa.Integer(),
            sa.ForeignKey("documents.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "extracted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "bot_id",
            "source_url",
            "title",
            name="uq_events_bot_source_title",
        ),
    )
    op.create_index("ix_events_bot_id", "events", ["bot_id"])
    op.create_index(
        "ix_events_bot_starts_at",
        "events",
        ["bot_id", "starts_at"],
    )
    op.create_index(
        "ix_events_bot_last_seen_at",
        "events",
        ["bot_id", "last_seen_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_events_bot_last_seen_at", table_name="events")
    op.drop_index("ix_events_bot_starts_at", table_name="events")
    op.drop_index("ix_events_bot_id", table_name="events")
    op.drop_table("events")
