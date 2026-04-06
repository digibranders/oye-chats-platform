import asyncio
import contextlib
import json
import logging
import re
from typing import Literal

import litellm
from pydantic import BaseModel, Field

from app.config import LLM_FALLBACKS, LLM_MODEL
from app.core.langfuse_client import get_langfuse
from app.core.thread_pool import submit_background
from app.db.models import BANTSignal, Bot, ChatSession
from app.db.repository import (
    add_chat_message,
    ensure_chat_session,
    get_chat_history,
    get_lead_info_by_session,
    search_keyword_documents,
    search_similar_documents,
)
from app.db.session import get_session
from app.ingestion.embedder import embed_chunks, embed_chunks_async
from app.services.email_service import send_qualified_lead_email
from app.services.intent_service import detect_handoff_intent
from app.services.lead_service import DEFAULT_BANT_CONFIG, get_bant_config, get_lead_tier
from app.services.llm_service import (
    generate_response,
    generate_response_stream,
)

logger = logging.getLogger(__name__)

_CTA_PATTERN = re.compile(r"\[CTA:(need|timeline|authority|budget)\]")


# ─────────────────────────────────────────────────────────────────────────────
# BANT Extraction — Pydantic schemas
# ─────────────────────────────────────────────────────────────────────────────


class BANTSignalExtraction(BaseModel):
    dimension: Literal["need", "timeline", "authority", "budget"]
    signal_text: str = Field(description="Exact quote from the user message that indicates this signal")
    extracted_value: str = Field(description="Structured summary of the signal")
    confidence: Literal["low", "medium", "high"] = Field(description="How confident the extraction is")
    score: int = Field(ge=0, le=25, description="Score 0-25 based on the provided rubric")


class BANTExtractionResult(BaseModel):
    signals: list[BANTSignalExtraction] = Field(
        default_factory=list, description="Only NEW signals from this exchange, empty list if none found"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _vector_search(cid: int | None, bid: int | None, query_embedding: list, k: int = 15) -> list:
    """Run vector similarity search in its own DB session (thread-safe)."""
    with get_session() as s:
        return search_similar_documents(s, client_id=cid, query_embedding=query_embedding, k=k, bot_id=bid)


def _keyword_search(cid: int | None, bid: int | None, query: str, k: int = 15) -> list:
    """Run full-text keyword search in its own DB session (thread-safe)."""
    with get_session() as s:
        return search_keyword_documents(s, client_id=cid, query=query, k=k, bot_id=bid)


def reciprocal_rank_fusion(vector_results, keyword_results, k=60):
    """Merge ranked lists using Reciprocal Rank Fusion (RRF).

    Args:
        vector_results: list of (Document, distance) tuples from vector search
        keyword_results: list of (Document, rank) tuples from keyword search
        k: RRF constant (default 60)

    Returns:
        list of Document objects sorted by combined RRF score
    """
    scores = {}
    docs = {}
    for rank, (doc, _dist) in enumerate(vector_results):
        scores[doc.id] = scores.get(doc.id, 0) + 1.0 / (k + rank + 1)
        docs[doc.id] = doc
    for rank, (doc, _rank_score) in enumerate(keyword_results):
        scores[doc.id] = scores.get(doc.id, 0) + 1.0 / (k + rank + 1)
        docs[doc.id] = doc
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [docs[doc_id] for doc_id, _ in ranked]


def _trim_results(results: list, top_k: int = 5) -> list:
    """Keep top-k results from RRF-ranked list."""
    return results[:top_k]


def _should_skip_bant_extraction(question: str, current_bant: dict) -> bool:
    """Return True if BANT extraction should be skipped to save LLM cost."""
    if len(question.strip()) < 10:
        return True
    scores = [
        current_bant.get("need_score", 0),
        current_bant.get("budget_score", 0),
        current_bant.get("authority_score", 0),
        current_bant.get("timeline_score", 0),
    ]
    return all(s >= 15 for s in scores)


def _build_bant_state(chat_session: ChatSession | None) -> dict:
    """Build a unified BANT state dict with both text values and scores."""
    if not chat_session:
        return {
            "need": None,
            "timeline": None,
            "authority": None,
            "budget": None,
            "need_score": 0,
            "budget_score": 0,
            "authority_score": 0,
            "timeline_score": 0,
        }
    return {
        "need": chat_session.bant_need,
        "timeline": chat_session.bant_timeline,
        "authority": chat_session.bant_authority,
        "budget": chat_session.bant_budget,
        "need_score": chat_session.bant_need_score or 0,
        "budget_score": chat_session.bant_budget_score or 0,
        "authority_score": chat_session.bant_authority_score or 0,
        "timeline_score": chat_session.bant_timeline_score or 0,
    }


# ─────────────────────────────────────────────────────────────────────────────
# BANT Extraction — LLM-powered with structured output
# ─────────────────────────────────────────────────────────────────────────────


def extract_bant_from_conversation(
    history_context: str, question: str, bot_answer: str, current_bant: dict, bant_config: dict | None = None
) -> list[dict]:
    """Extract BANT signals using structured LLM output. Returns list of signal dicts."""
    try:
        config = bant_config or DEFAULT_BANT_CONFIG
        dimensions = ["need", "timeline", "authority", "budget"]

        rubric_lines = []
        for dim in dimensions:
            dim_config = config.get(dim, {})
            if not dim_config.get("enabled", True):
                continue
            options = dim_config.get("options", [])
            options_str = ", ".join(f'"{o["label"]}" ({o["score"]} pts)' for o in options)
            current_score = current_bant.get(f"{dim}_score", 0)
            current_value = current_bant.get(dim) or "null"
            rubric_lines.append(
                f"- {dim.upper()}: Current={current_value} (score {current_score}/25). Rubric options: {options_str}"
            )

        rubric_text = "\n".join(rubric_lines)

        extraction_prompt = f"""Analyze this conversation and extract NEW BANT qualification signals.

CONVERSATION HISTORY:
{history_context}

LATEST EXCHANGE:
User: {question}
Bot: {bot_answer}

CURRENT BANT STATE AND SCORING RUBRIC:
{rubric_text}

INSTRUCTIONS:
- Only extract signals that are NEW in this latest exchange. Do not re-extract existing data.
- For each new signal, provide the exact user quote, a structured summary, confidence level, and a score (0-25) based on the rubric options above.
- Match the score to the closest rubric option that fits the user's statement.
- If no new signals are found, return an empty signals list.
- Only extract signals from the USER's messages, not the bot's responses."""

        response = litellm.completion(
            model=LLM_MODEL,
            messages=[
                {"role": "system", "content": "You are a BANT qualification signal extractor. Return structured JSON."},
                {"role": "user", "content": extraction_prompt},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "BANTExtractionResult",
                    "strict": True,
                    "schema": BANTExtractionResult.model_json_schema(),
                },
            },
            metadata={"generation_name": "bant-extraction-v2"},
            fallbacks=LLM_FALLBACKS,
        )

        resp_text = response.choices[0].message.content
        if not resp_text:
            return []

        result = BANTExtractionResult.model_validate_json(resp_text)
        return [s.model_dump() for s in result.signals]
    except Exception as e:
        logger.warning(f"BANT extraction failed (non-breaking): {e}")
        return []


def _background_bant_extraction(
    session_id, cid, bid, history_context, question, answer, current_bant, bot, bant_config, message_id
):
    """Fire-and-forget BANT extraction with evidence trail. Opens its own DB session."""
    try:
        signals = extract_bant_from_conversation(history_context, question, answer, current_bant, bant_config)
        if not signals:
            return

        config = bant_config or DEFAULT_BANT_CONFIG

        with get_session() as session:
            chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
            if not chat_session:
                return

            old_tier = chat_session.bant_tier or "unqualified"
            score_field_map = {
                "need": ("bant_need_score", "bant_need"),
                "timeline": ("bant_timeline_score", "bant_timeline"),
                "authority": ("bant_authority_score", "bant_authority"),
                "budget": ("bant_budget_score", "bant_budget"),
            }

            for signal in signals:
                dim = signal["dimension"]
                if dim not in score_field_map:
                    continue

                score_col, text_col = score_field_map[dim]
                current_score = getattr(chat_session, score_col, 0) or 0
                new_score = signal["score"]

                # Never downgrade scores
                if new_score <= current_score:
                    continue

                # Save evidence trail
                bant_signal = BANTSignal(
                    session_id=session_id,
                    message_id=message_id,
                    dimension=dim,
                    signal_text=signal["signal_text"],
                    extracted_value=signal["extracted_value"],
                    confidence=signal["confidence"],
                    score_before=current_score,
                    score_after=new_score,
                )
                session.add(bant_signal)

                # Update scores
                setattr(chat_session, score_col, new_score)
                setattr(chat_session, text_col, signal["extracted_value"])

            # Recalculate composite fields
            chat_session.bant_score = (
                (chat_session.bant_need_score or 0)
                + (chat_session.bant_budget_score or 0)
                + (chat_session.bant_authority_score or 0)
                + (chat_session.bant_timeline_score or 0)
            )

            thresholds = config.get("thresholds")
            chat_session.bant_tier = get_lead_tier(chat_session.bant_score, thresholds=thresholds)

            chat_session.dimensions_assessed = sum(
                1
                for s in [
                    chat_session.bant_need_score,
                    chat_session.bant_budget_score,
                    chat_session.bant_authority_score,
                    chat_session.bant_timeline_score,
                ]
                if (s or 0) > 0
            )

            from datetime import UTC, datetime

            chat_session.bant_last_updated = datetime.now(UTC)

            # Check tier transition → send notification
            new_tier = chat_session.bant_tier
            if new_tier == "sql" and old_tier != "sql" and bot:
                notification_email = getattr(bot, "notification_email", None)
                email_on_qualified = getattr(bot, "email_on_qualified", False)
                if notification_email and email_on_qualified:
                    lead_info = get_lead_info_by_session(session, session_id)
                    contact = None
                    if lead_info:
                        contact = {
                            "name": lead_info.name,
                            "email": lead_info.email,
                            "phone": lead_info.phone,
                            "company": lead_info.company,
                        }
                    bant_updates = {
                        "bant_need": chat_session.bant_need,
                        "bant_budget": chat_session.bant_budget,
                        "bant_authority": chat_session.bant_authority,
                        "bant_timeline": chat_session.bant_timeline,
                    }
                    send_qualified_lead_email(notification_email, bot.name, bant_updates, contact)

            session.commit()
    except Exception as e:
        logger.warning(f"Background BANT extraction failed (non-breaking): {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Hybrid RAG Prompt Builder
# ─────────────────────────────────────────────────────────────────────────────


def build_hybrid_prompt(
    client,
    question: str,
    context_text: str,
    history_context: str,
    bant_state: dict = None,
    bant_enabled: bool = True,
    bant_config: dict = None,
) -> str:
    """Construct the Hybrid RAG system prompt with BANT qualification support."""

    bs = bant_state or {}
    config = bant_config or DEFAULT_BANT_CONFIG
    conversation_order = config.get("conversation_order", ["need", "timeline", "authority", "budget"])

    qualification_section = ""
    if bant_enabled:
        # Build score-aware qualification state
        dim_labels = {"need": "Need", "timeline": "Timeline", "authority": "Authority", "budget": "Budget"}
        state_lines = []
        missing_dims = []
        for dim in conversation_order:
            score = bs.get(f"{dim}_score", 0)
            value = bs.get(dim) or "Not yet identified"
            state_lines.append(f"- {dim_labels.get(dim, dim)}: {value} (score: {score}/25)")
            if score < 15:
                missing_dims.append(dim)

        state_text = "\n".join(state_lines)

        # Build CTA instruction if any dimension has CTA enabled
        cta_dims = []
        for dim in missing_dims:
            dim_config = config.get(dim, {})
            if dim_config.get("cta_enabled", False):
                options = [o["label"] for o in dim_config.get("options", [])]
                cta_dims.append(f"  - {dim}: options = {options}")

        cta_instruction = ""
        if cta_dims:
            cta_lines = "\n".join(cta_dims)
            cta_instruction = f"""
CTA MARKER (INTERNAL — invisible to user):
If you ask a qualifying question, append the marker [CTA:dimension_name] at the very end
of your response (e.g., [CTA:timeline]). This marker will be stripped before showing to
the visitor. Only include ONE [CTA:] marker per response, only for CTA-enabled dimensions
that have not been fully assessed yet (score below 15). These are the eligible dimensions:
{cta_lines}
"""

        # Only suggest qualification if visitor has shown some engagement
        has_engagement = any(bs.get(f"{d}_score", 0) > 0 for d in conversation_order)
        engagement_gate = (
            "The visitor has shown engagement — you may ask ONE qualifying question."
            if has_engagement
            else "The visitor has not shown buying signals yet — focus on answering helpfully. Do NOT ask qualifying questions."
        )

        qualification_section = f"""
5. LEAD QUALIFICATION (SUBTLE & SECONDARY):
Your PRIMARY job is answering the user's question. {engagement_gate}

Rules for qualification:
- NEVER prioritize qualification over answering the question. Answer first.
- Ask about only ONE missing field per response. Never ask multiple questions.
- Frame questions naturally, not as a survey/checklist.
- Priority order for missing fields: {", ".join(d.upper() for d in conversation_order)}
- If all scores are above 0, do NOT ask qualifying questions. Suggest next steps.

CURRENT QUALIFICATION STATE:
{state_text}
{cta_instruction}"""

    handoff_section = """
6. HUMAN HANDOFF REQUESTS:
If the user explicitly asks to speak with a human, agent, support team, or representative:
- Respond warmly and briefly — 1-2 sentences only.
- Example: "Of course! Let me connect you with our team right away — they'll be happy to help."
- Do NOT continue trying to answer their original question or ask a follow-up question.
- Do NOT say you cannot help. Just acknowledge warmly and confirm they are being connected.
"""

    hybrid_system_prompt = f"""
SYSTEM ROLE:
You are a helpful, professional, and conversational customer support assistant for
**{client.name}**. Your primary goal is to provide accurate, easy-to-read
information about our services without sounding overly aggressive, jargon-heavy,
or "salesy."

Please adhere strictly to the following rules:

1. CONCISENESS & SCANNABILITY:
- Never output long, dense paragraphs or "walls of text."
- Always use bullet points when listing 3 or more services, features, or options.
- When using bullet points, list ONLY the main point or item name. Do NOT add
  descriptions, colons, dashes, or explanations after each bullet. Keep each
  bullet to a few words maximum.
- Keep your answers brief and directly address the user's specific question.
- Provide a high-level summary first; wait before providing a deep dive.
- Use **bold** (markdown) to highlight important keywords, names, service names,
  numbers, or key phrases in your responses so users can quickly scan.

2. TONE & PERSONALITY:
- Be polite, welcoming, and conversational.
- Avoid corporate buzzwords (e.g., "operational efficiency," "synergy"). Use plain, accessible language.
- Do not immediately push the user into a consultation or sales pitch. Keep the pressure low.

3. HANDLING KNOWLEDGE & CONTEXT:
- You will be provided with specific context or retrieved document chunks. Base your answers strictly on this provided information.
- If the answer to the user's question is not contained in the provided context, gracefully admit that you don't have that specific information and offer to connect them with a human team member. Do not hallucinate or guess.

4. CONVERSATION FLOW:
- Conclude your responses with a single, simple, and low-pressure follow-up question to keep the conversation natural (e.g., "Would you like to hear more about [Specific Service]?" or "Does that answer your question?").
- Do not ask the user to do heavy mental lifting (e.g., do not ask them to choose between 5 different complex options at once).
{qualification_section}
{handoff_section}
═══════════════════════════════════════════════════════
KNOWLEDGE BASE CONTEXT
═══════════════════════════════════════════════════════
{context_text}

═══════════════════════════════════════════════════════
CONVERSATION HISTORY
═══════════════════════════════════════════════════════
{history_context}

═══════════════════════════════════════════════════════
USER QUESTION: {question}
═══════════════════════════════════════════════════════
"""
    return hybrid_system_prompt


def rewrite_query(session_id: str, question: str, history: list) -> str:
    """Rewrite a follow-up question into a standalone search query using conversation history."""
    if not history or len(history) < 2:
        return question

    follow_up_signals = [
        "it",
        "that",
        "this",
        "they",
        "them",
        "those",
        "the same",
        "more about",
        "what about",
        "how about",
        "and the",
        "also",
    ]
    question_lower = question.lower()
    if not any(signal in question_lower for signal in follow_up_signals):
        return question

    history_text = "\n".join(f"{msg.role.upper()}: {msg.content}" for msg in history[-4:])

    rewrite_prompt = f"""Given the conversation history and a follow-up question, rewrite the follow-up question to be a standalone search query that captures the full context.

CONVERSATION HISTORY:
{history_text}

FOLLOW-UP QUESTION: {question}

Respond with ONLY the rewritten standalone query, nothing else."""

    try:
        rewritten = generate_response(rewrite_prompt, metadata={"generation_name": "query-rewrite"})
        return rewritten.strip() if rewritten and rewritten.strip() else question
    except Exception as e:
        logger.warning(f"Query rewrite failed, using original: {e}")
        return question


def _strip_cta_marker(text: str, bant_config: dict | None = None) -> tuple[str, dict | None]:
    """Strip [CTA:dimension] marker from response text and return CTA metadata if found."""
    match = _CTA_PATTERN.search(text)
    if not match:
        return text, None

    dimension = match.group(1)
    clean_text = _CTA_PATTERN.sub("", text).rstrip()

    config = bant_config or DEFAULT_BANT_CONFIG
    dim_config = config.get(dimension, {})
    if not dim_config.get("cta_enabled", False):
        return clean_text, None

    cta_prompt = dim_config.get("cta_prompt", "")
    options = [o["label"] for o in dim_config.get("options", [])]

    return clean_text, {"dimension": dimension, "prompt": cta_prompt, "options": options}


# ─────────────────────────────────────────────────────────────────────────────
# Standard (Non-Streaming) Pipeline
# ─────────────────────────────────────────────────────────────────────────────


def rag_pipeline(
    client,
    question: str,
    session_id: str = "default_session",
    location: str = None,
    device: str = None,
    bot_id: int = None,
):
    """
    Orchestrate the RAG flow with Chat Memory.
    Accepts Client or Bot object. If bot_id is provided, uses bot-scoped queries.
    Instrumented with Langfuse v4 when enabled.
    """
    if bot_id:
        cid = getattr(client, "client_id", None) if isinstance(client, Bot) else getattr(client, "id", None)
        bid = bot_id
    elif isinstance(client, Bot):
        cid = getattr(client, "client_id", None)
        bid = client.id
    else:
        cid = getattr(client, "id", None)
        bid = None
    logger.info(f"RAG pipeline started | session={session_id} | client_id={cid} | bot_id={bid}")

    lf = get_langfuse()

    def _run_pipeline():
        with get_session() as session:
            bot = session.query(Bot).get(bid) if bid else (client if isinstance(client, Bot) else None)

            ensure_chat_session(session, session_id, client_id=cid, bot_id=bid, location=location, device=device)
            chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
            current_bant = _build_bant_state(chat_session)

            history = get_chat_history(session, session_id, client_id=cid, limit=5, bot_id=bid)
            search_query = rewrite_query(session_id, question, history)
            query_embedding = embed_chunks([search_query])[0]

            add_chat_message(
                session,
                session_id,
                client_id=cid,
                role="user",
                content=question,
                location=location,
                device=device,
                bot_id=bid,
            )

            vector_results = search_similar_documents(
                session, client_id=cid, query_embedding=query_embedding, k=15, bot_id=bid
            )
            keyword_results = search_keyword_documents(session, client_id=cid, query=question, k=15, bot_id=bid)

            final_results = reciprocal_rank_fusion(vector_results, keyword_results)
            final_results = _trim_results(final_results)

            context_parts = []
            for i, doc in enumerate(final_results, 1):
                context_parts.append(f"[Source {i}] {doc.document_name}\nContent:\n{doc.content}\n")
            context_text = "\n---\n".join(context_parts) if context_parts else "No relevant documents found."
            history_context = "\n".join([f"{m.role}: {m.content}" for m in history])

            is_bant_enabled = getattr(client, "bant_enabled", True)
            bant_config = get_bant_config(bot) if is_bant_enabled else None

            prompt = build_hybrid_prompt(
                client,
                question,
                context_text,
                history_context,
                bant_state=current_bant,
                bant_enabled=is_bant_enabled,
                bant_config=bant_config,
            )

            answer = generate_response(
                prompt,
                metadata={"generation_name": "rag-generation", "context_chunks": len(final_results)},
            )

            # Strip CTA marker before saving
            answer, _cta = _strip_cta_marker(answer, bant_config)

            bot_msg = add_chat_message(session, session_id, client_id=cid, role="bot", content=answer, bot_id=bid)

            if lf and hasattr(bot_msg, "trace_id"):
                with contextlib.suppress(Exception):
                    bot_msg.trace_id = lf.get_current_trace_id()

            session.commit()

            if is_bant_enabled and not _should_skip_bant_extraction(question, current_bant):
                submit_background(
                    _background_bant_extraction,
                    session_id,
                    cid,
                    bid,
                    history_context,
                    question,
                    answer,
                    current_bant,
                    bot,
                    bant_config,
                    bot_msg.id,
                )

            return {
                "answer": answer,
                "sources": [doc.document_name for doc in final_results],
                "session_id": session_id,
                "message_id": bot_msg.id,
            }

    if lf:
        from langfuse import propagate_attributes

        with (
            propagate_attributes(
                user_id=str(cid) if cid else None,
                session_id=session_id,
                metadata={"bot_id": bid, "question": question, "device": device, "location": location},
                tags=["rag", f"bot:{bid}"] if bid else ["rag"],
            ),
            lf.start_as_current_observation(
                name="rag-pipeline",
                as_type="chain",
                input=question,
                metadata={"bot_id": bid, "session_id": session_id},
            ) as trace,
        ):
            result = _run_pipeline()
            trace.update(output=result.get("answer", ""))
            return result
    else:
        return _run_pipeline()


# ─────────────────────────────────────────────────────────────────────────────
# Streaming Pipeline (Hybrid Mode)
# ─────────────────────────────────────────────────────────────────────────────


async def rag_pipeline_stream(
    client,
    question: str,
    session_id: str = "default_session",
    location: str = None,
    device: str = None,
    bot_id: int = None,
):
    """
    Streaming version of the Hybrid RAG flow.
    Accepts Client or Bot object. If bot_id is provided, uses bot-scoped queries.
    Instrumented with Langfuse v4 when enabled.
    """
    if bot_id:
        cid = getattr(client, "client_id", None) if isinstance(client, Bot) else getattr(client, "id", None)
        bid = bot_id
    elif isinstance(client, Bot):
        cid = getattr(client, "client_id", None)
        bid = client.id
    else:
        cid = getattr(client, "id", None)
        bid = None
    logger.info(f"RAG stream started | client_id={cid} | bot_id={bid}")

    full_answer = ""
    with get_session() as session:
        bot = session.query(Bot).get(bid) if bid else (client if isinstance(client, Bot) else None)

        ensure_chat_session(session, session_id, client_id=cid, bot_id=bid, location=location, device=device)
        chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
        current_bant = _build_bant_state(chat_session)

        history = get_chat_history(session, session_id, client_id=cid, limit=5, bot_id=bid)

        handoff_task = asyncio.create_task(asyncio.to_thread(detect_handoff_intent, question))
        search_query = await asyncio.to_thread(rewrite_query, session_id, question, history)
        query_embedding = (await embed_chunks_async([search_query]))[0]

        try:
            suggest_handoff = await asyncio.wait_for(handoff_task, timeout=2.0)
        except TimeoutError:
            suggest_handoff = False
            logger.warning(f"Handoff intent detection timed out for session {session_id}")

        add_chat_message(
            session,
            session_id,
            client_id=cid,
            role="user",
            content=question,
            location=location,
            device=device,
            bot_id=bid,
        )

        vector_results, keyword_results = await asyncio.gather(
            asyncio.to_thread(_vector_search, cid, bid, query_embedding),
            asyncio.to_thread(_keyword_search, cid, bid, search_query),
        )

        final_results = reciprocal_rank_fusion(vector_results, keyword_results)
        final_results = _trim_results(final_results)
        sources = [doc.document_name for doc in final_results]

        yield f"METADATA:{json.dumps({'session_id': session_id, 'sources': sources})}\n"

        context_text = (
            "\n---\n".join(
                [f"[Source {i}] {doc.document_name}\nContent:\n{doc.content}" for i, doc in enumerate(final_results, 1)]
            )
            if final_results
            else "No relevant documents found."
        )
        history_context = "\n".join([f"{m.role}: {m.content}" for m in history])

        is_bant_enabled = getattr(client, "bant_enabled", True)
        bant_config = get_bant_config(bot) if is_bant_enabled else None

        prompt = build_hybrid_prompt(
            client,
            question,
            context_text,
            history_context,
            bant_state=current_bant,
            bant_enabled=is_bant_enabled,
            bant_config=bant_config,
        )
        logger.info(f"Hybrid RAG stream prompt built | Context chunks: {len(final_results)}")

        try:
            chunk_count = 0
            for chunk in generate_response_stream(
                prompt,
                metadata={"generation_name": "rag-stream-generation", "context_chunks": len(final_results)},
            ):
                if chunk:
                    chunk_count += 1
                    full_answer += chunk
                    yield chunk

            if chunk_count == 0:
                logger.warning(f"LLM returned zero chunks for session {session_id}")
                yield "I'm sorry, I couldn't generate a response. Please try again or ask something else."
                full_answer = "I'm sorry, I couldn't generate a response. Please try again or ask something else."
        except Exception as e:
            logger.error(f"Streaming prompt error: {e}")
            yield f" [Backend Error: {str(e)}]"

        # Strip CTA marker from response before saving
        full_answer, cta_data = _strip_cta_marker(full_answer, bant_config)

        bot_msg = add_chat_message(session, session_id, client_id=cid, role="bot", content=full_answer, bot_id=bid)

        lf = get_langfuse()
        if lf and hasattr(bot_msg, "trace_id"):
            with contextlib.suppress(Exception):
                bot_msg.trace_id = lf.get_current_trace_id()

        session.commit()

        if is_bant_enabled and not _should_skip_bant_extraction(question, current_bant):
            submit_background(
                _background_bant_extraction,
                session_id,
                cid,
                bid,
                history_context,
                question,
                full_answer,
                current_bant,
                bot,
                bant_config,
                bot_msg.id,
            )

        final_meta: dict = {"message_id": bot_msg.id}
        if suggest_handoff:
            final_meta["suggest_handoff"] = True
        if cta_data:
            final_meta["cta"] = cta_data
        yield f"\nFINAL_METADATA:{json.dumps(final_meta)}\n"

        logger.info(f"Hybrid RAG stream finished for session: {session_id}")
