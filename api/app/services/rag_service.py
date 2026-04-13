import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re

import litellm
from pydantic import BaseModel, Field
from sqlalchemy.orm import joinedload

from app.config import LLM_FALLBACKS, LLM_MODEL
from app.core.cache import QA_RESPONSE_TTL, cache_delete, cache_get, cache_set, qa_response_key
from app.core.langfuse_client import get_langfuse
from app.core.thread_pool import submit_background
from app.db.models import BANTSignal, Bot, ChatSession, MeetingBooking
from app.db.repository import (
    add_chat_message,
    count_documents_for_bot,
    ensure_chat_session,
    get_all_documents_for_bot,
    get_chat_history,
    get_lead_info_by_session,
    search_keyword_documents,
    search_similar_documents,
)
from app.db.session import get_session
from app.ingestion.embedder import embed_chunks, embed_chunks_async
from app.services.email_service import send_qualified_lead_email
from app.services.intent_service import detect_handoff_intent
from app.services.llm_service import generate_response, generate_response_stream
from app.services.qualification_service import get_framework_config, get_tier
from app.services.relevance_gate import check_relevance
from app.services.reranker import RERANK_ENABLED, rerank

logger = logging.getLogger(__name__)

# TTL for query-embedding cache (Phase 4B)
_EMBED_CACHE_TTL = 300  # 5 minutes — short; rewrites vary

_CTA_PATTERN = re.compile(r"\[CTA:([a-zA-Z0-9_]+)\]")

# Prompt injection guard — patterns that attempt to override the system prompt
_INJECTION_PATTERNS = re.compile(
    r"(ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context))|"
    r"(disregard\s+(all\s+)?(previous|prior|above|earlier))|"
    r"(override\s+(the\s+)?(system|all)\s+(prompt|instructions?))|"
    r"(you\s+are\s+now\s+(a\s+)?(?!assistant|support))|"
    r"(new\s+persona\s*:)|"
    r"(act\s+as\s+(?!a\s+support|a\s+helpful))|"
    r"(pretend\s+(you\s+are|to\s+be))|"
    r"(SYSTEM\s*:)|"
    r"(<<<|>>>|\[\[|\]\]|<\||\|>)",  # common injection delimiters
    re.IGNORECASE,
)
# Maximum chars accepted for a custom system prompt (validated at API boundary too)
_MAX_CUSTOM_PROMPT_CHARS = 2000


def _sanitize_system_prompt(prompt: str) -> str:
    """Strip prompt-injection attempts from a customer-supplied system prompt.

    This is a defence-in-depth measure.  The primary validation (max_length,
    field type) happens at the Pydantic model layer in bot_routes.py.

    Returns the sanitised prompt, or an empty string if the entire input is
    considered unsafe.
    """
    if not prompt:
        return ""
    prompt = prompt[:_MAX_CUSTOM_PROMPT_CHARS]
    if _INJECTION_PATTERNS.search(prompt):
        logger.warning("Prompt injection attempt detected in custom system prompt — field cleared.")
        return ""
    # Strip control characters and suspicious Unicode that could break prompt boundaries
    prompt = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", prompt)
    return prompt.strip()


# ─────────────────────────────────────────────────────────────────────────────
# BANT Extraction — Pydantic schemas
# ─────────────────────────────────────────────────────────────────────────────


class QualificationSignalExtraction(BaseModel):
    dimension: str
    signal_text: str = Field(description="Exact quote from the user message that indicates this signal")
    extracted_value: str = Field(description="Structured summary of the signal")
    confidence: str = Field(description="How confident the extraction is")
    score: int = Field(ge=0, le=25, description="Score 0-25 based on the provided rubric")


class QualificationExtractionResult(BaseModel):
    signals: list[QualificationSignalExtraction] = Field(
        default_factory=list, description="Only NEW signals from this exchange, empty list if none found"
    )


BANTSignalExtraction = QualificationSignalExtraction
BANTExtractionResult = QualificationExtractionResult


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


def _trim_results(results: list, top_k: int = 15) -> list:
    """Keep top-k results from RRF-ranked list.

    Default 15 provides a wider candidate pool for the downstream reranker.
    Without reranking, 15 is still passed to the LLM — the reranker (Phase 2B)
    is responsible for trimming to the final top_n before prompt assembly.
    """
    return results[:top_k]


# ─── Company-related query expansion ────────────────────────────────────────

_COMPANY_SYNONYMS = {"company", "organization", "agency", "firm", "business", "brand"}


def _expand_company_query(question: str, company_name: str | None) -> str:
    """Append the actual company name when the question uses generic company terms.

    This dramatically improves both vector and keyword search for identity
    questions like "what is this company about?" by adding the real name
    (e.g. "Fynix Digital") to the search query.
    """
    if not company_name:
        return question
    q_lower = question.lower()
    if any(term in q_lower for term in _COMPANY_SYNONYMS):
        return f"{question} {company_name}"
    return question


def _framework_dimensions(config: dict | None) -> list[str]:
    framework_config = config or {}
    order = framework_config.get("conversation_order") or []
    dims: list[str] = []
    for dim in order:
        if isinstance(framework_config.get(dim), dict):
            dims.append(dim)
    for key, value in framework_config.items():
        if key in {"framework", "thresholds", "conversation_order", "decay", "behavioral_config"}:
            continue
        if isinstance(value, dict) and key not in dims:
            dims.append(key)
    return dims


def _should_skip_bant_extraction(question: str, current_bant: dict, framework_config: dict | None = None) -> bool:
    """Return True if BANT extraction should be skipped to save LLM cost."""
    if len(question.strip()) < 10:
        return True
    dimensions = _framework_dimensions(framework_config) or ["need", "budget", "authority", "timeline"]
    scores = [int(current_bant.get(f"{dim}_score", 0) or 0) for dim in dimensions]
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
    state = {
        "need": chat_session.bant_need,
        "timeline": chat_session.bant_timeline,
        "authority": chat_session.bant_authority,
        "budget": chat_session.bant_budget,
        "need_score": chat_session.bant_need_score or 0,
        "budget_score": chat_session.bant_budget_score or 0,
        "authority_score": chat_session.bant_authority_score or 0,
        "timeline_score": chat_session.bant_timeline_score or 0,
    }
    if isinstance(chat_session.dimension_scores, dict):
        for dim, payload in chat_session.dimension_scores.items():
            if not isinstance(payload, dict):
                continue
            state[dim] = payload.get("value")
            state[f"{dim}_score"] = int(payload.get("score", 0) or 0)
    return state


# ─────────────────────────────────────────────────────────────────────────────
# BANT Extraction — LLM-powered with structured output
# ─────────────────────────────────────────────────────────────────────────────


def extract_qualification_signals(
    history_context: str, question: str, bot_answer: str, current_bant: dict, bant_config: dict | None = None
) -> list[dict]:
    """Extract BANT signals using structured LLM output. Returns list of signal dicts."""
    try:
        config = bant_config or get_framework_config(None)
        dimensions = _framework_dimensions(config)

        rubric_lines = []
        for dim in dimensions:
            dim_config = config.get(dim, {})
            if not dim_config.get("enabled", True):
                continue
            options = dim_config.get("options", [])
            if not options:
                continue
            max_score = max((int(o.get("score", 0)) for o in options), default=25)
            options_str = ", ".join(f'"{o["label"]}" ({o["score"]} pts)' for o in options)
            current_score = current_bant.get(f"{dim}_score", 0)
            current_value = current_bant.get(dim) or "null"
            rubric_lines.append(
                f"- {dim.upper()}: Current={current_value} (score {current_score}/{max_score}). Rubric options: {options_str}"
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
- If the user's message is a greeting, thank you, or small talk, return an empty signals list immediately.
- Only extract signals that are NEW in this latest exchange. Do not re-extract existing data.
- For each new signal, provide the exact user quote, a structured summary, confidence level, and a score (0-25) based on the rubric options above.
- Match the score to the closest rubric option that fits the user's statement.
- If no new signals are found, return an empty signals list.
- Only extract signals from the USER's messages, not the bot's responses."""

        response = litellm.completion(
            model=LLM_MODEL,
            messages=[
                {"role": "system", "content": "You are a qualification signal extractor. Return structured JSON."},
                {"role": "user", "content": extraction_prompt},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "QualificationExtractionResult",
                    "strict": True,
                    "schema": QualificationExtractionResult.model_json_schema(),
                },
            },
            metadata={"generation_name": "bant-extraction-v2"},
            fallbacks=LLM_FALLBACKS,
        )

        resp_text = response.choices[0].message.content
        if not resp_text:
            return []

        result = QualificationExtractionResult.model_validate_json(resp_text)
        return [s.model_dump() for s in result.signals]
    except Exception as e:
        logger.warning(f"BANT extraction failed (non-breaking): {e}")
        return []


def extract_bant_from_conversation(
    history_context: str, question: str, bot_answer: str, current_bant: dict, bant_config: dict | None = None
) -> list[dict]:
    """Backward-compatible alias."""
    return extract_qualification_signals(history_context, question, bot_answer, current_bant, bant_config)


def _background_bant_extraction(
    session_id, cid, bid, history_context, question, answer, current_bant, bot, bant_config, message_id
):
    """Fire-and-forget BANT extraction with evidence trail. Opens its own DB session."""
    try:
        signals = extract_qualification_signals(history_context, question, answer, current_bant, bant_config)
        if not signals:
            return

        config = bant_config or get_framework_config(bot)

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
            dimension_scores = dict(chat_session.dimension_scores or {})

            for signal in signals:
                dim = signal["dimension"]
                new_score = int(signal.get("score", 0) or 0)
                if new_score <= 0:
                    continue
                signal_value = signal.get("extracted_value") or ""
                dim_entry = dimension_scores.get(dim) if isinstance(dimension_scores.get(dim), dict) else {}
                current_score = int(dim_entry.get("score", 0) or 0)
                if dim in score_field_map:
                    score_col, _text_col = score_field_map[dim]
                    current_score = max(current_score, int(getattr(chat_session, score_col, 0) or 0))

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

                # Keep legacy BANT columns in sync for BANT-compatible dimensions
                if dim in score_field_map:
                    score_col, text_col = score_field_map[dim]
                    setattr(chat_session, score_col, new_score)
                    setattr(chat_session, text_col, signal_value)

                # Framework-agnostic score store
                dimension_scores[dim] = {"score": new_score, "value": signal_value}

            chat_session.dimension_scores = dimension_scores
            chat_session.qualification_framework = config.get("framework", "bant")

            # Recalculate composite fields
            chat_session.bant_score = (
                (chat_session.bant_need_score or 0)
                + (chat_session.bant_budget_score or 0)
                + (chat_session.bant_authority_score or 0)
                + (chat_session.bant_timeline_score or 0)
            )

            thresholds = config.get("thresholds")
            chat_session.bant_tier = get_tier(chat_session.bant_score, thresholds=thresholds)

            chat_session.dimensions_assessed = sum(
                1
                for payload in (dimension_scores or {}).values()
                if isinstance(payload, dict) and int(payload.get("score", 0) or 0) > 0
            )

            from datetime import UTC, datetime

            chat_session.bant_last_updated = datetime.now(UTC)

            # Check tier transition → send notification
            new_tier = chat_session.bant_tier
            if new_tier == "sql" and old_tier != "sql" and bot:
                from app.services.email_service import get_notification_recipients

                email_on_qualified = getattr(bot, "email_on_qualified", False)
                recipients = get_notification_recipients(bot, "qualified_lead") if email_on_qualified else []
                if recipients:
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
                    reply_to = getattr(bot, "reply_to_email", None)
                    for recipient in recipients:
                        send_qualified_lead_email(recipient, bot.name, bant_updates, contact, reply_to=reply_to)
                try:
                    from app.services.webhook_service import fire_webhook

                    fire_webhook(
                        bot.id,
                        "tier_transition",
                        {
                            "session_id": session_id,
                            "old_tier": old_tier,
                            "new_tier": new_tier,
                            "score": chat_session.bant_score,
                            "behavioral_score": getattr(chat_session, "behavioral_score", 0),
                        },
                    )
                except Exception as wh_err:
                    logger.warning(f"Webhook dispatch failed (non-blocking): {wh_err}")

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
    live_chat_enabled: bool = True,
    custom_system_prompt: str | None = None,
    brand_tone: str | None = None,
    company_name: str | None = None,
    company_description: str | None = None,
    bot_name: str | None = None,
) -> str:
    """Construct the Hybrid RAG system prompt with BANT qualification support."""

    bs = bant_state or {}
    config = bant_config or get_framework_config(None)
    conversation_order = config.get("conversation_order") or _framework_dimensions(config)

    qualification_section = ""
    if bant_enabled:
        # Build score-aware qualification state
        state_lines = []
        missing_dims = []
        for dim in conversation_order:
            dim_cfg = config.get(dim, {}) if isinstance(config.get(dim), dict) else {}
            options = dim_cfg.get("options") or []
            max_score = max((int(opt.get("score", 0)) for opt in options), default=25)
            assess_threshold = max(1, int(round(max_score * 0.6)))
            score = int(bs.get(f"{dim}_score", 0) or 0)
            value = bs.get(dim) or "Not yet identified"
            label = dim_cfg.get("label") or dim.replace("_", " ").title()
            state_lines.append(f"- {label}: {value} (score: {score}/{max_score})")
            if score < assess_threshold:
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
that have not been fully assessed yet. These are the eligible dimensions:
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

    if live_chat_enabled:
        handoff_section = """
LIVE SUPPORT: If the user asks to speak with a person, respond warmly in 1-2 sentences and confirm they're being connected. Say "our team" — never "human team". Don't answer their question after they ask for a person."""
        handoff_offer = "Offer to connect with a team member."
    else:
        handoff_section = """
SUPPORT REQUESTS: If the user asks for a person, warmly direct them to the contact form in the menu above. Say the team will follow up by email. Say "our team" — never "human team"."""
        handoff_offer = "Direct them to the contact form in the menu above."

    # Build optional sections (truncate to prevent prompt bloat)
    if custom_system_prompt:
        sanitized_prompt = _sanitize_system_prompt(custom_system_prompt)
        custom_prompt_section = f"\n\nCUSTOM INSTRUCTIONS:\n{sanitized_prompt[:1500]}" if sanitized_prompt else ""
    else:
        custom_prompt_section = ""
    tone_section = f"\n\nBRAND TONE: {brand_tone[:300]}" if brand_tone else ""

    # Resolve display name: prefer company_name over bot name
    display_name = company_name or client.name
    resolved_bot_name = bot_name or client.name

    # Build company context section if a description is available
    company_section = ""
    if company_description:
        company_section = f"\n\nCOMPANY CONTEXT:\n{company_description[:500]}"

    hybrid_system_prompt = f"""You are the AI assistant for **{display_name}**. You represent {display_name} and speak on its behalf.

VOICE:
- Use "I" when speaking as the assistant ("I'd be happy to help!"). Use "we", "our", "us" when speaking as the company ("We offer branding and development services").
- Never refer to {display_name} in the third person ("they", "them", "their").
- Your name is {resolved_bot_name} but you are NOT the company — **{display_name}** is the company you represent.
- When asked about the company, organization, agency, or "who are you", describe **{display_name}** using the information provided below.
- You are a confident, warm representative of this company — never a search interface or FAQ bot.
- Never expose internal limitations to visitors ("I don't have information", "no data available", "not in my knowledge base", "I don't have that information right now").
- When you lack specific details, be resourceful: share general truths about the company from the company context, pivot to what you DO know, and offer to connect the visitor with the team for specifics.
- Match the energy of whoever you're talking to — casual if they're casual, professional if they're formal.

Answer visitor questions using the information provided below.

RULES:
1. Answer ONLY what was specifically asked — nothing more. If asked about the CEO, mention only the CEO, not the entire team. Keep answers to 1-3 sentences. Up to 5 for complex topics. For listings (services, team, features), up to 150 words is acceptable. Never pad or repeat yourself.
2. Bullet points for 3+ items. Keep each bullet to a few words — no descriptions after bullets.
3. Bold only: **{display_name}**, product/service names, and prices. No other bold.
4. Tone: like a knowledgeable colleague replying in chat — friendly but direct. Never start with "Great question!", "Absolutely!", "I'd be happy to help!" or "Thank you for asking!". Never say "Based on the information provided". Just answer naturally.
5. Never say "I don't have that information" or "No information is available." You ARE the company — speak with confidence. When specific details are available in the reference information below, state them directly — name clients, list services, quote prices, whatever is there. Only when something is genuinely absent from the reference material should you pivot: share what you do know, and optionally {handoff_offer} Do NOT add a "connect with our team" offer to answers where you already have the information — only offer it when the reference material truly cannot answer the question.
6. Only ask a follow-up question if the user's query is genuinely ambiguous.
7. Use plain language. No corporate buzzwords like "operational efficiency" or "synergy".
8. Never mention internal terms like "knowledge base", "documents", "database", "context", or "sources" to visitors. Never tell visitors that information is "unavailable" or "not available right now" — always pivot to what you know and offer a path forward.{custom_prompt_section}{tone_section}{company_section}
{qualification_section}
{handoff_section}

═══════════════════════════════════════════════════════
REFERENCE INFORMATION
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

    config = bant_config or get_framework_config(None)
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
            bot = (
                session.query(Bot).options(joinedload(Bot.client)).get(bid)
                if bid
                else (client if isinstance(client, Bot) else None)
            )

            # Resolve company identity: prefer bot-level (auto-extracted from website)
            # over client-level (typed at registration)
            _company_name = None
            _company_desc = None
            _bot_name = None
            if bot:
                _bot_name = bot.name
                _company_desc = getattr(bot, "company_description", None)
                _company_name = getattr(bot, "company_name", None)
                if not _company_name and bot.client:
                    _company_name = bot.client.company_name

            ensure_chat_session(session, session_id, client_id=cid, bot_id=bid, location=location, device=device)

            # Save user message first (always persisted, even on cache hit)
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

            # ── Redis QA cache: check BEFORE expensive rewrite/embed/search ──
            _q_hash = hashlib.sha256(question.lower().strip().encode()).hexdigest()[:32]
            _cache_key = qa_response_key(bid, _q_hash) if bid else None
            if _cache_key:
                cached_qa = cache_get(_cache_key)
                if cached_qa:
                    # Detect handoff intent even on cache hit
                    _cached_handoff = detect_handoff_intent(question)
                    live_chat_on = getattr(bot, "live_chat_enabled", True) if bot else True

                    if _cached_handoff and live_chat_on:
                        # Handoff requested — invalidate cache and fall through
                        # so the LLM generates a proper handoff response.
                        cache_delete(_cache_key)
                        logger.info(f"QA cache invalidated (handoff detected) | bot_id={bid}")
                    else:
                        logger.info(f"QA cache hit | bot_id={bid} | session={session_id}")
                        bot_msg = add_chat_message(
                            session, session_id, client_id=cid, role="bot", content=cached_qa["answer"], bot_id=bid
                        )
                        session.commit()
                        return {
                            "answer": cached_qa["answer"],
                            "sources": cached_qa.get("sources", []),
                            "session_id": session_id,
                            "message_id": bot_msg.id,
                        }

            # Expensive steps: query rewriting (LLM call) + embedding (API call)
            chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
            current_bant = _build_bant_state(chat_session)
            history = get_chat_history(session, session_id, client_id=cid, limit=5, bot_id=bid)

            # ── CAG-lite: skip retrieval for small knowledge bases ──────────
            _cag_threshold = int(os.getenv("CAG_LITE_THRESHOLD", "20"))
            _total_chunks = count_documents_for_bot(session, bot_id=bid, client_id=cid) if bid or cid else 0
            _use_cag_lite = _cag_threshold > 0 and 0 < _total_chunks <= _cag_threshold

            # Detect handoff intent (run alongside retrieval steps)
            suggest_handoff = detect_handoff_intent(question)

            if _use_cag_lite:
                logger.info(f"CAG-lite mode: injecting all {_total_chunks} chunks (bot_id={bid})")
                final_results = get_all_documents_for_bot(session, bot_id=bid, client_id=cid)
                search_query = question  # no rewrite needed — full KB in context
            else:
                search_query = rewrite_query(session_id, question, history)
                search_query = _expand_company_query(search_query, _company_name)

                # ── Phase 4B: embedding cache ─────────────────────────────
                _emb_key = f"oyechats:emb:{bid or cid}:{hashlib.sha256(search_query.encode()).hexdigest()[:32]}"
                _cached_emb = cache_get(_emb_key)
                if _cached_emb and isinstance(_cached_emb, list):
                    query_embedding = _cached_emb
                else:
                    query_embedding = embed_chunks([search_query])[0]
                    cache_set(_emb_key, query_embedding, _EMBED_CACHE_TTL)

                vector_results = search_similar_documents(
                    session, client_id=cid, query_embedding=query_embedding, k=15, bot_id=bid
                )
                keyword_results = search_keyword_documents(session, client_id=cid, query=question, k=15, bot_id=bid)

                final_results = reciprocal_rank_fusion(vector_results, keyword_results)
                final_results = _trim_results(final_results)  # top 15 candidate pool
                if RERANK_ENABLED:
                    final_results = rerank(search_query, final_results)

            # ── Phase 4A: CRAG relevance gate ────────────────────────────
            _is_relevant, _gate_score = check_relevance(question, final_results, bot_id=bid, client_id=cid)
            if not _is_relevant:
                logger.info(
                    "Relevance gate fired | score=%.2f session=%s — returning off-topic response",
                    _gate_score,
                    session_id,
                )
                _cn = _company_name or "our company"
                return {
                    "answer": f"That's a bit outside what I can help with — I'm here to assist with everything related to {_cn}! Is there anything about our services, team, or how we work that I can help you with?",
                    "sources": [],
                    "session_id": session_id,
                    "message_id": None,
                }

            context_parts = []
            # Inject company identity so "about the company" queries always have context
            if _company_name:
                context_parts.append(f"[Company Identity] This chatbot represents {_company_name}.")
            for i, doc in enumerate(final_results, 1):
                # Truncate per-chunk to prevent prompt token overflow on large documents
                chunk_content = doc.content[:5000] + " [truncated]" if len(doc.content) > 5000 else doc.content
                context_parts.append(f"[Source {i}] {doc.document_name}\nContent:\n{chunk_content}\n")
            context_text = (
                "\n---\n".join(context_parts)
                if context_parts
                else "No detailed reference material on this specific topic. Use the company context, brand tone, and your role as a confident company representative to craft a helpful, natural answer. Do NOT tell the visitor that information is unavailable — share what you know and offer to connect them with the team for specifics."
            )
            history_context = "\n".join([f"{m.role}: {m.content}" for m in history])

            is_bant_enabled = getattr(client, "bant_enabled", True)
            bant_config = get_framework_config(bot) if is_bant_enabled else None

            prompt = build_hybrid_prompt(
                client,
                question,
                context_text,
                history_context,
                bant_state=current_bant,
                bant_enabled=is_bant_enabled,
                bant_config=bant_config,
                live_chat_enabled=getattr(bot, "live_chat_enabled", True) if bot else True,
                custom_system_prompt=getattr(bot, "system_prompt", None) if bot else None,
                brand_tone=getattr(bot, "brand_tone", None) if bot else None,
                company_name=_company_name,
                company_description=_company_desc,
                bot_name=_bot_name,
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

            if is_bant_enabled and not _should_skip_bant_extraction(question, current_bant, bant_config):
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

            live_chat_on = getattr(bot, "live_chat_enabled", True) if bot else True
            result = {
                "answer": answer,
                "sources": [doc.document_name for doc in final_results],
                "session_id": session_id,
                "message_id": bot_msg.id,
            }
            if suggest_handoff and live_chat_on:
                result["suggest_handoff"] = True

            # Cache the answer for identical future questions.
            # Skip caching when handoff was suggested — the response only
            # makes sense alongside the suggest_handoff flag.
            if _cache_key and not suggest_handoff:
                cache_set(_cache_key, {"answer": answer, "sources": result["sources"]}, QA_RESPONSE_TTL)

            return result

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
        bot = (
            session.query(Bot).options(joinedload(Bot.client)).get(bid)
            if bid
            else (client if isinstance(client, Bot) else None)
        )

        # Resolve company identity: prefer bot-level (auto-extracted from website)
        # over client-level (typed at registration)
        _company_name = None
        _company_desc = None
        _bot_name = None
        if bot:
            _bot_name = bot.name
            _company_desc = getattr(bot, "company_description", None)
            _company_name = getattr(bot, "company_name", None)
            if not _company_name and bot.client:
                _company_name = bot.client.company_name

        ensure_chat_session(session, session_id, client_id=cid, bot_id=bid, location=location, device=device)

        # Save user message first (always persisted, even on cache hit)
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

        # ── Redis QA cache: check BEFORE expensive rewrite/embed/search ──
        _q_hash = hashlib.sha256(question.lower().strip().encode()).hexdigest()[:32]
        _cache_key = qa_response_key(bid, _q_hash) if bid else None
        if _cache_key:
            cached_qa = cache_get(_cache_key)
            if cached_qa:
                # Run handoff detection even on cache hit so the widget can
                # trigger the handoff form when appropriate.
                _cached_handoff = await asyncio.to_thread(detect_handoff_intent, question)
                live_chat_on = getattr(bot, "live_chat_enabled", True) if bot else True

                if _cached_handoff and live_chat_on:
                    # Handoff requested — invalidate cache and fall through to
                    # the full pipeline so the LLM generates a proper handoff
                    # response with the suggest_handoff flag.
                    cache_delete(_cache_key)
                    logger.info(f"QA cache invalidated (handoff detected) | bot_id={bid}")
                else:
                    logger.info(f"QA stream cache hit | bot_id={bid} | session={session_id}")
                    cached_answer = cached_qa["answer"]
                    cached_sources = cached_qa.get("sources", [])
                    yield f"METADATA:{json.dumps({'session_id': session_id, 'sources': cached_sources})}\n"
                    yield cached_answer
                    bot_msg = add_chat_message(
                        session, session_id, client_id=cid, role="bot", content=cached_answer, bot_id=bid
                    )
                    session.flush()
                    _cached_msg_id = bot_msg.id
                    session.commit()
                    yield f"\nFINAL_METADATA:{json.dumps({'message_id': _cached_msg_id})}\n"
                    return

        # Expensive steps: handoff detection, query rewriting (LLM), embedding (API)
        chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
        current_bant = _build_bant_state(chat_session)
        history = get_chat_history(session, session_id, client_id=cid, limit=5, bot_id=bid)

        # ── CAG-lite: skip retrieval for small knowledge bases ──────────────
        _cag_threshold = int(os.getenv("CAG_LITE_THRESHOLD", "20"))
        _total_chunks = await asyncio.to_thread(count_documents_for_bot, session, bid, cid) if bid or cid else 0
        _use_cag_lite = _cag_threshold > 0 and 0 < _total_chunks <= _cag_threshold

        if _use_cag_lite:
            logger.info(f"CAG-lite stream mode: injecting all {_total_chunks} chunks (bot_id={bid})")
            final_results = await asyncio.to_thread(get_all_documents_for_bot, session, bid, cid)
            search_query = question
            suggest_handoff = await asyncio.to_thread(detect_handoff_intent, question)
        else:
            handoff_task = asyncio.create_task(asyncio.to_thread(detect_handoff_intent, question))
            search_query = await asyncio.to_thread(rewrite_query, session_id, question, history)
            search_query = _expand_company_query(search_query, _company_name)

            # ── Phase 4B: embedding cache (async path) ────────────────────
            _emb_key = f"oyechats:emb:{bid or cid}:{hashlib.sha256(search_query.encode()).hexdigest()[:32]}"
            _cached_emb = cache_get(_emb_key)
            if _cached_emb and isinstance(_cached_emb, list):
                query_embedding = _cached_emb
            else:
                query_embedding = (await embed_chunks_async([search_query]))[0]
                cache_set(_emb_key, query_embedding, _EMBED_CACHE_TTL)

            try:
                suggest_handoff = await asyncio.wait_for(handoff_task, timeout=2.0)
            except TimeoutError:
                suggest_handoff = False
                logger.warning(f"Handoff intent detection timed out for session {session_id}")

            vector_results, keyword_results = await asyncio.gather(
                asyncio.to_thread(_vector_search, cid, bid, query_embedding),
                asyncio.to_thread(_keyword_search, cid, bid, search_query),
            )

            final_results = reciprocal_rank_fusion(vector_results, keyword_results)
            final_results = _trim_results(final_results)  # top 15 candidate pool
            if RERANK_ENABLED:
                final_results = rerank(search_query, final_results)

        sources = [doc.document_name for doc in final_results]

        # ── Phase 4A: CRAG relevance gate (streaming path) ───────────────
        _is_relevant, _gate_score = await asyncio.to_thread(check_relevance, question, final_results, bid, cid)
        if not _is_relevant:
            logger.info(
                "Relevance gate fired | score=%.2f session=%s — returning off-topic response",
                _gate_score,
                session_id,
            )
            _cn = _company_name or "our company"
            yield f"METADATA:{json.dumps({'session_id': session_id, 'sources': []})}\n"
            yield f"That's a bit outside what I can help with — I'm here to assist with everything related to {_cn}! Is there anything about our services, team, or how we work that I can help you with?"
            return

        yield f"METADATA:{json.dumps({'session_id': session_id, 'sources': sources})}\n"

        # Build context with company identity injection
        context_parts = []
        if _company_name:
            context_parts.append(f"[Company Identity] This chatbot represents {_company_name}.")
        for i, doc in enumerate(final_results, 1):
            chunk_content = doc.content[:5000] + " [truncated]" if len(doc.content) > 5000 else doc.content
            context_parts.append(f"[Source {i}] {doc.document_name}\nContent:\n{chunk_content}\n")
        context_text = (
            "\n---\n".join(context_parts)
            if context_parts
            else "No detailed reference material on this specific topic. Use the company context, brand tone, and your role as a confident company representative to craft a helpful, natural answer. Do NOT tell the visitor that information is unavailable — share what you know and offer to connect them with the team for specifics."
        )
        history_context = "\n".join([f"{m.role}: {m.content}" for m in history])

        is_bant_enabled = getattr(client, "bant_enabled", True)
        bant_config = get_framework_config(bot) if is_bant_enabled else None

        prompt = build_hybrid_prompt(
            client,
            question,
            context_text,
            history_context,
            bant_state=current_bant,
            bant_enabled=is_bant_enabled,
            bant_config=bant_config,
            live_chat_enabled=getattr(bot, "live_chat_enabled", True) if bot else True,
            custom_system_prompt=getattr(bot, "system_prompt", None) if bot else None,
            brand_tone=getattr(bot, "brand_tone", None) if bot else None,
            company_name=_company_name,
            company_description=_company_desc,
            bot_name=_bot_name,
        )
        logger.info(f"Hybrid RAG stream prompt built | Context chunks: {len(final_results)}")

        _stream_error = False
        try:
            chunk_count = 0
            async for chunk in generate_response_stream(
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
            logger.error(f"Streaming prompt error ({type(e).__name__}): {e}", exc_info=True)
            yield " [I encountered an error. Please try again.]"
            _stream_error = True
            suggest_handoff = False  # Don't suggest handoff on errored/partial responses

        # Strip CTA marker from response before saving
        full_answer, cta_data = _strip_cta_marker(full_answer, bant_config)

        # Always yield FINAL_METADATA so the frontend never hangs waiting for it.
        # Build it inside a try/finally so even a DB failure sends the frame.
        bot_msg_id = None
        final_meta: dict = {}
        try:
            if not _stream_error or full_answer:
                bot_msg = add_chat_message(
                    session, session_id, client_id=cid, role="bot", content=full_answer, bot_id=bid
                )

                lf = get_langfuse()
                if lf and hasattr(bot_msg, "trace_id"):
                    with contextlib.suppress(Exception):
                        bot_msg.trace_id = lf.get_current_trace_id()

                # Flush first to execute the INSERT and populate bot_msg.id.
                # This lets us capture the id before commit so FINAL_METADATA
                # always carries message_id even if the commit later fails.
                session.flush()
                bot_msg_id = bot_msg.id
                session.commit()

                # Only cache a real LLM answer — never cache the zero-chunk
                # fallback string, which would poison the QA cache.
                # Also skip caching when handoff was suggested: the response
                # (e.g. "I'm connecting you…") only makes sense when
                # accompanied by the suggest_handoff flag in FINAL_METADATA.
                if _cache_key and full_answer and chunk_count > 0 and not suggest_handoff:
                    cache_set(_cache_key, {"answer": full_answer, "sources": sources}, QA_RESPONSE_TTL)

                if is_bant_enabled and not _should_skip_bant_extraction(question, current_bant, bant_config):
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
                        bot_msg_id,
                    )

                live_chat_on = getattr(bot, "live_chat_enabled", True) if bot else True
                final_meta = {"message_id": bot_msg_id} if bot_msg_id else {}
                if suggest_handoff and live_chat_on:
                    final_meta["suggest_handoff"] = True
                if cta_data:
                    final_meta["cta"] = cta_data
                if (
                    bot
                    and getattr(bot, "meeting_booking_enabled", False)
                    and getattr(bot, "calendly_url", None)
                    and (chat_session.bant_tier or "unqualified") == "sql"
                ):
                    has_booking = (
                        session.query(MeetingBooking)
                        .filter(MeetingBooking.session_id == session_id, MeetingBooking.bot_id == bid)
                        .first()
                        is not None
                    )
                    if not has_booking:
                        final_meta["show_booking"] = True
                        final_meta["calendly_url"] = bot.calendly_url
        except Exception as cleanup_err:
            logger.error(f"Post-stream cleanup failed for session {session_id}: {cleanup_err}", exc_info=True)
            with contextlib.suppress(Exception):
                session.rollback()
        finally:
            yield f"\nFINAL_METADATA:{json.dumps(final_meta)}\n"

        logger.info(f"Hybrid RAG stream finished for session: {session_id}")
