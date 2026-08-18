"""Onboarding "seed question" generation with answerability verification.

The Build Studio's Prove step shows a couple of one-tap sample questions so a
brand-new bot demonstrates itself immediately. The hard requirement (per the
onboarding redesign) is that a seeded question must NEVER produce a weak or
"I don't know" answer, a bad first answer damages trust more than no sample.

So this is a two-stage pipeline:
  1. GENERATE candidates from the bot's auto-extracted company context (LLM).
  2. VERIFY each candidate is actually answerable by running the SAME retrieval
     the live bot uses, with a tighter distance cut than normal chat. Only
     questions with strong content backing survive.

Anything uncertain is dropped; an empty result is expected and fine (the UI
falls back to a plain open input).
"""

from __future__ import annotations

import logging

from app.db.models import Bot
from app.db.repository import count_documents_for_bot, search_similar_documents
from app.ingestion.embedder import embed_chunks
from app.services.llm_service import generate_seed_questions

logger = logging.getLogger(__name__)

# Answerability cut. Tighter than the live-chat retrieval default (0.78 cosine
# distance) so we only ever surface a question with a genuinely on-topic chunk
# behind it. High precision matters more than recall here.
_VERIFY_MAX_DISTANCE = 0.60
_VERIFY_MIN_CHUNKS = 1
_MAX_SEED_QUESTIONS = 3


def _is_answerable(session, *, bot_id: int | None, client_id: int | None, question: str) -> bool:
    """True when retrieval surfaces a strongly on-topic chunk for ``question``."""
    try:
        embs = embed_chunks([question])
    except Exception as exc:  # embedding outage / rate-limit debt. Treat as unverifiable
        logger.warning("seed-question verify embed failed (%s)", type(exc).__name__)
        return False
    query_embedding = embs[0] if embs else None
    if query_embedding is None:
        return False
    results = search_similar_documents(
        session,
        client_id=client_id,
        query_embedding=query_embedding,
        k=_VERIFY_MIN_CHUNKS,
        bot_id=bot_id,
        max_distance=_VERIFY_MAX_DISTANCE,
    )
    return len(results or []) >= _VERIFY_MIN_CHUNKS


def build_seed_questions(session, bot: Bot) -> list[str]:
    """Generate + verify up to 3 answerable seed questions for ``bot``.

    Returns ``[]`` when the bot has no indexed content, generation fails, or
    nothing passes verification. Callers should treat ``[]`` as "show only the
    open input", never as an error.
    """
    bot_id = bot.id
    client_id = getattr(bot, "client_id", None)

    # No indexed content → nothing is answerable → no seeds.
    if count_documents_for_bot(session, bot_id=bot_id, client_id=client_id) <= 0:
        return []

    candidates = generate_seed_questions(
        getattr(bot, "company_name", None),
        getattr(bot, "company_description", None),
        metadata={"generation_name": "seed-questions", "bot_id": bot_id},
    )
    if not candidates:
        return []

    verified: list[str] = []
    for question in candidates:
        if _is_answerable(session, bot_id=bot_id, client_id=client_id, question=question):
            verified.append(question)
            if len(verified) >= _MAX_SEED_QUESTIONS:
                break

    logger.info(
        "seed_questions bot_id=%s candidates=%d verified=%d",
        bot_id,
        len(candidates),
        len(verified),
    )
    return verified
