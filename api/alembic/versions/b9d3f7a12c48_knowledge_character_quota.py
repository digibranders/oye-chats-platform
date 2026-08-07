"""knowledge_character_quota — per-account KB size cap (chars-based).

Adds:
  * ``clients.kb_characters_used`` — running BigInteger counter of *cleaned
    pre-chunk* characters ingested into the account's knowledge base across
    every bot. Enforced against ``plan.limits.knowledge_characters`` in the
    ingestion pipeline. Backfilled from ``documents.source_char_count`` in
    the same migration so existing accounts start with an accurate baseline.
  * ``documents.source_char_count`` — character count of the SOURCE document
    (post-clean, pre-chunk), replicated on every chunk of that source. Used
    to decrement the client counter on delete, and to recompute it from
    source-of-truth when drift is suspected. Nullable — pre-migration rows
    stay NULL and are treated as 0.

The plan-side limit (``plan.limits.knowledge_characters``) lives in the
existing JSONB column and needs no schema change. ``scripts/seed_plans.py``
carries the per-tier default values.

Revision ID: b9d3f7a12c48
Revises: c4a9e2f7b8d1
Create Date: 2026-08-07
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b9d3f7a12c48"
down_revision: str | Sequence[str] | None = "c4a9e2f7b8d1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "clients",
        sa.Column(
            "kb_characters_used",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "documents",
        sa.Column("source_char_count", sa.Integer(), nullable=True),
    )

    # Backfill: pre-existing documents have no per-source char count on disk.
    # Approximate the source's char count as ``length(content)`` on the FIRST
    # chunk of each source (by ``id``) — safest available proxy without
    # re-running extraction. Later re-ingests overwrite this with the real
    # cleaned-source length. Same value is written to every chunk of a source
    # so the DISTINCT-based decrement query stays correct.
    op.execute(
        """
        WITH first_chunk AS (
            SELECT DISTINCT ON (
                COALESCE(bot_id, -1),
                COALESCE(client_id, -1),
                document_name
            )
                id,
                bot_id,
                client_id,
                document_name,
                length(content) AS approx_len
            FROM documents
            ORDER BY
                COALESCE(bot_id, -1),
                COALESCE(client_id, -1),
                document_name,
                id
        )
        UPDATE documents d
        SET source_char_count = fc.approx_len
        FROM first_chunk fc
        WHERE d.document_name = fc.document_name
          AND COALESCE(d.bot_id, -1) = COALESCE(fc.bot_id, -1)
          AND COALESCE(d.client_id, -1) = COALESCE(fc.client_id, -1)
          AND d.source_char_count IS NULL;
        """
    )

    # Backfill the per-client counter from the (now populated) per-source
    # totals. DISTINCT ON collapses replicated chunk rows to one row per
    # source before summing so the counter matches what an ingest would
    # have written at the time.
    op.execute(
        """
        WITH per_source AS (
            SELECT DISTINCT ON (
                client_id,
                COALESCE(bot_id, -1),
                document_name
            )
                client_id,
                COALESCE(source_char_count, 0) AS chars
            FROM documents
            WHERE client_id IS NOT NULL
            ORDER BY
                client_id,
                COALESCE(bot_id, -1),
                document_name,
                id
        ),
        totals AS (
            SELECT client_id, COALESCE(SUM(chars), 0) AS total
            FROM per_source
            GROUP BY client_id
        )
        UPDATE clients c
        SET kb_characters_used = totals.total
        FROM totals
        WHERE c.id = totals.client_id;
        """
    )


def downgrade() -> None:
    op.drop_column("documents", "source_char_count")
    op.drop_column("clients", "kb_characters_used")
