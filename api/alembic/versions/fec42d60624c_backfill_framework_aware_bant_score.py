"""Backfill framework-aware bant_score/bant_tier for existing chat_sessions (BR-01).

Before this, ``bant_score``/``bant_tier`` were computed by summing exactly
four hardcoded columns named after BANT's own dimensions (need/timeline/
authority/budget). For any ``ChatSession`` whose bot runs a non-BANT
framework (MEDDIC/CHAMP/GPCTBA+C&I), those columns were never written — only
the framework-agnostic ``dimension_scores`` JSONB was — so every such session
was stuck at ``bant_score=0``/``bant_tier="unqualified"`` regardless of how
much real qualification data ``dimension_scores`` actually held.

The application-code fix (``rag_service._background_bant_extraction``) now
computes these via ``qualification_service.calculate_composite_score``, which
is framework-aware. This migration is a one-time data backfill so existing
rows reflect that same (now-correct) computation immediately, instead of only
updating on the next new message in each session.

Uses the current ``qualification_service`` composite-score logic directly
(rather than duplicating its preset weights/thresholds here) since the intent
is "recompute every existing row with today's correct formula" — the same
contract as ``calculate_composite_score`` itself.

Revision ID: fec42d60624c
Revises: 785a60ae37b8
Create Date: 2026-07-08
"""

from types import SimpleNamespace

import sqlalchemy as sa

from alembic import op

revision = "fec42d60624c"
down_revision = "785a60ae37b8"
branch_labels = None
depends_on = None

_BATCH_SIZE = 500


def upgrade() -> None:
    from app.services.qualification_service import calculate_composite_score, get_framework_config, get_tier

    bind = op.get_bind()

    bot_rows = bind.execute(sa.text("SELECT id, bant_config FROM bots")).fetchall()
    framework_config_by_bot_id = {
        row.id: get_framework_config(SimpleNamespace(bant_config=row.bant_config)) for row in bot_rows
    }

    session_rows = bind.execute(
        sa.text(
            "SELECT id, bot_id, dimension_scores FROM chat_sessions "
            "WHERE dimension_scores IS NOT NULL AND dimension_scores != '{}'::jsonb"
        )
    ).fetchall()

    update_stmt = sa.text("UPDATE chat_sessions SET bant_score = :score, bant_tier = :tier WHERE id = :id")

    for i in range(0, len(session_rows), _BATCH_SIZE):
        batch = session_rows[i : i + _BATCH_SIZE]
        for row in batch:
            config = framework_config_by_bot_id.get(row.bot_id)
            if config is None:
                continue
            score = calculate_composite_score(row.dimension_scores or {}, config)
            tier = get_tier(score, thresholds=config.get("thresholds"))
            bind.execute(update_stmt, {"score": score, "tier": tier, "id": row.id})


def downgrade() -> None:
    # Recomputation is deterministic and non-destructive to any other column —
    # there is nothing meaningful to revert to (the pre-migration values were
    # simply wrong for non-BANT frameworks). No-op.
    pass
