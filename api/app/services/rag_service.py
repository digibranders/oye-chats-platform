import contextlib
import json
import logging

from app.core.langfuse_client import get_langfuse
from app.core.thread_pool import submit_background
from app.db.models import Bot, ChatSession
from app.db.repository import (
    add_chat_message,
    ensure_chat_session,
    get_chat_history,
    get_lead_info_by_session,
    search_keyword_documents,
    search_similar_documents,
    update_session_bant,
)
from app.db.session import get_session
from app.ingestion.embedder import embed_chunks, embed_chunks_async
from app.services.email_service import send_qualified_lead_email
from app.services.llm_service import (
    generate_response,
    generate_response_stream,
)

logger = logging.getLogger(__name__)


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


def _background_bant_extraction(session_id, cid, bid, history_context, question, answer, current_bant, bot):
    """Fire-and-forget BANT extraction. Opens its own DB session."""
    try:
        extracted = extract_bant_from_conversation(history_context, question, answer, current_bant)
        bant_updates = {
            "bant_need": extracted.get("need"),
            "bant_timeline": extracted.get("timeline"),
            "bant_authority": extracted.get("authority"),
            "bant_budget": extracted.get("budget"),
        }
        with get_session() as session:
            update_session_bant(session, session_id, client_id=cid, bant_data=bant_updates, bot_id=bid)

            # Check if lead just became fully qualified → trigger email
            if (
                all(bant_updates.get(k) for k in ("bant_need", "bant_budget", "bant_authority", "bant_timeline"))
                and bot
                and getattr(bot, "notification_email", None)
                and getattr(bot, "email_on_qualified", False)
            ):
                lead_info = get_lead_info_by_session(session, session_id)
                contact = None
                if lead_info:
                    contact = {
                        "name": lead_info.name,
                        "email": lead_info.email,
                        "phone": lead_info.phone,
                        "company": lead_info.company,
                    }
                send_qualified_lead_email(bot.notification_email, bot.name, bant_updates, contact)

            session.commit()
    except Exception as e:
        logger.warning(f"Background BANT extraction failed (non-breaking): {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Hybrid RAG Prompt Builder
# ─────────────────────────────────────────────────────────────────────────────


def build_hybrid_prompt(
    client,  # Accepts Client or Bot object — both have .name and .system_prompt
    question: str,
    context_text: str,
    history_context: str,
    bant_state: dict = None,
    bant_enabled: bool = True,
) -> str:
    """
    Construct the Hybrid RAG system prompt that:
      1. Prioritises retrieved KB context (PRIMARY DIRECTIVE).
      2. Falls back to general knowledge for small-talk / off-topic queries
         without ever outputting "I don't know" error messages (HYBRID FALLBACK).
      3. Smoothly pivots general-knowledge answers back to the KB domain (THE PIVOT).
      4. Never invents specific capabilities, pricing, or policies absent from the
         retrieved context (BOUNDARIES).
    """

    # Format BANT state for prompt
    bs = bant_state or {}
    bant_need = bs.get("need") or "Not yet identified"
    bant_timeline = bs.get("timeline") or "Not yet identified"
    bant_authority = bs.get("authority") or "Not yet identified"
    bant_budget = bs.get("budget") or "Not yet identified"

    qualification_section = ""
    if bant_enabled:
        qualification_section = f"""
5. LEAD QUALIFICATION (SUBTLE & SECONDARY):
Your PRIMARY job is answering the user's question. However, if the user's message shows genuine buying intent (they are actively evaluating, comparing options, asking about implementation, pricing, or timelines — NOT just browsing for general information), you may SUBTLY weave ONE qualifying question at the end of your helpful answer.

Rules for qualification:
- NEVER prioritize qualification over answering the question. The answer always comes first.
- Only ask a qualifying question if the user shows GENUINE buying signals (not just using words like "service" or "cost" in an informational context).
- Ask about only ONE missing field per response. Never ask multiple qualifying questions.
- Frame questions naturally as part of the conversation, not as a survey or checklist.
  - For Need: "What specific challenge are you looking to solve?"
  - For Timeline: "Do you have a timeline in mind for getting started?"
  - For Authority: "Who else on your team would be involved in this decision?"
  - For Budget: "To recommend the right option, do you have a budget range in mind?"
- If all four fields below are already filled, do NOT ask any qualifying questions. Instead, naturally suggest next steps like scheduling a demo or speaking with the team.
- If the user is clearly just seeking information (e.g., "what do you do?", "tell me about your services"), answer helpfully WITHOUT any qualifying questions.

CURRENT QUALIFICATION STATE:
- Need: {bant_need}
- Timeline: {bant_timeline}
- Authority: {bant_authority}
- Budget: {bant_budget}
"""

    hybrid_system_prompt = f"""
SYSTEM ROLE:
You are a helpful, professional, and conversational customer support assistant for **{client.name}**. Your primary goal is to provide users with accurate, easy-to-read information about our services without ever sounding overly aggressive, jargon-heavy, or "salesy."

Please adhere strictly to the following rules:

1. CONCISENESS & SCANNABILITY:
- Never output long, dense paragraphs or "walls of text."
- Always use bullet points when listing 3 or more services, features, or options.
- When using bullet points, list ONLY the main point or item name. Do NOT add descriptions, colons, dashes, or explanations after each bullet point. Keep each bullet to a few words maximum.
- Keep your answers brief and directly address the user's specific question.
- Provide a high-level summary first; wait for the user to ask before providing a deep dive.
- Use **bold** (markdown) to highlight important keywords, names, service names, numbers, or key phrases in your responses so users can quickly scan and find the most relevant information.

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

    # Heuristic: skip LLM rewrite for self-contained questions
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


def extract_bant_from_conversation(history_context: str, question: str, bot_answer: str, current_bant: dict) -> dict:
    """
    Lightweight LLM call to extract BANT data from the conversation.
    Returns updated bant dict. On any failure, returns current_bant unchanged.
    Uses generate_response which auto-instruments with Langfuse via LiteLLM callbacks.
    """
    try:
        need = current_bant.get("need") or "null"
        timeline = current_bant.get("timeline") or "null"
        authority = current_bant.get("authority") or "null"
        budget = current_bant.get("budget") or "null"

        extraction_prompt = f"""Analyze this conversation and extract BANT qualification data.

CONVERSATION HISTORY:
{history_context}

LATEST EXCHANGE:
User: {question}
Bot: {bot_answer}

CURRENT BANT STATE:
- Need: {need}
- Timeline: {timeline}
- Authority: {authority}
- Budget: {budget}

INSTRUCTIONS:
- If the user revealed their business need or problem, update "need".
- If the user mentioned when they want to implement, update "timeline".
- If the user mentioned who else is involved in the decision, update "authority".
- If the user mentioned budget or price range, update "budget".
- Carry forward any existing non-null values unless the user explicitly changed them.
- Return null for fields where no information has been gathered yet.
- Return ONLY valid JSON: {{"need": string|null, "timeline": string|null, "authority": string|null, "budget": string|null}}"""

        resp_text = generate_response(
            extraction_prompt,
            metadata={"generation_name": "bant-extraction"},
        )
        clean_json = resp_text.strip()
        if clean_json.startswith("```json"):
            clean_json = clean_json.split("```json")[-1].split("```")[0].strip()
        elif clean_json.startswith("```"):
            clean_json = clean_json.split("```")[1].split("```")[0].strip()

        return json.loads(clean_json)
    except Exception as e:
        logger.warning(f"BANT extraction failed (non-breaking): {e}")
        return current_bant


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
    # Determine owner IDs
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

    # Initialize Langfuse trace via context manager
    lf = get_langfuse()

    def _run_pipeline():
        with get_session() as session:
            # Resolve bot object for email notifications
            bot = session.query(Bot).get(bid) if bid else (client if isinstance(client, Bot) else None)

            # 1. Fetch BANT state
            ensure_chat_session(session, session_id, client_id=cid, bot_id=bid, location=location, device=device)
            chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
            current_bant = {
                "need": chat_session.bant_need if chat_session else None,
                "timeline": chat_session.bant_timeline if chat_session else None,
                "authority": chat_session.bant_authority if chat_session else None,
                "budget": chat_session.bant_budget if chat_session else None,
            }

            # 2. Get Session History
            history = get_chat_history(session, session_id, client_id=cid, limit=5, bot_id=bid)

            # 3. Contextual Query Re-writing
            search_query = rewrite_query(session_id, question, history)

            # 4. Embed Query
            query_embedding = embed_chunks([search_query])[0]

            # 5. Save User Message & Retrieve Documents
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
                session, client_id=cid, query_embedding=query_embedding, k=5, bot_id=bid
            )
            keyword_results = search_keyword_documents(session, client_id=cid, query=question, k=5, bot_id=bid)

            # Merge with Reciprocal Rank Fusion and rerank
            final_results = reciprocal_rank_fusion(vector_results, keyword_results)
            final_results = _trim_results(final_results)

            # 6. Format Context & History
            context_parts = []
            for i, doc in enumerate(final_results, 1):
                context_parts.append(f"[Source {i}] {doc.document_name}\nContent:\n{doc.content}\n")
            context_text = "\n---\n".join(context_parts) if context_parts else "No relevant documents found."

            history_context = "\n".join([f"{m.role}: {m.content}" for m in history])

            # 7. Build Hybrid RAG Prompt (with BANT state)
            is_bant_enabled = getattr(client, "bant_enabled", True)
            prompt = build_hybrid_prompt(
                client, question, context_text, history_context, bant_state=current_bant, bant_enabled=is_bant_enabled
            )

            # 8. Generate Response (LiteLLM auto-traces via callback)
            answer = generate_response(
                prompt,
                metadata={"generation_name": "rag-generation", "context_chunks": len(final_results)},
            )
            bot_msg = add_chat_message(session, session_id, client_id=cid, role="bot", content=answer, bot_id=bid)

            # Store trace_id for feedback linking
            if lf and hasattr(bot_msg, "trace_id"):
                with contextlib.suppress(Exception):
                    bot_msg.trace_id = lf.get_current_trace_id()

            session.commit()

            # 9. Fire-and-forget BANT extraction in bounded thread pool (saves 1-3s)
            if is_bant_enabled:
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
                )

            return {
                "answer": answer,
                "sources": [doc.document_name for doc in final_results],
                "session_id": session_id,
                "message_id": bot_msg.id,
            }

    # Wrap entire pipeline in a Langfuse trace context if enabled
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
    # Determine owner IDs
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
        # Resolve bot object for email notifications
        bot = session.query(Bot).get(bid) if bid else (client if isinstance(client, Bot) else None)

        # 1. Fetch BANT state
        ensure_chat_session(session, session_id, client_id=cid, bot_id=bid, location=location, device=device)
        chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
        current_bant = {
            "need": chat_session.bant_need if chat_session else None,
            "timeline": chat_session.bant_timeline if chat_session else None,
            "authority": chat_session.bant_authority if chat_session else None,
            "budget": chat_session.bant_budget if chat_session else None,
        }

        # 2. Get History
        history = get_chat_history(session, session_id, client_id=cid, limit=5, bot_id=bid)

        # 3. Contextual Query Re-writing
        search_query = rewrite_query(session_id, question, history)

        # 4. Embed & Retrieve (async to avoid blocking event loop)
        query_embedding = (await embed_chunks_async([search_query]))[0]
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
            session, client_id=cid, query_embedding=query_embedding, k=5, bot_id=bid
        )
        keyword_results = search_keyword_documents(session, client_id=cid, query=search_query, k=5, bot_id=bid)

        # Merge with Reciprocal Rank Fusion and rerank
        final_results = reciprocal_rank_fusion(vector_results, keyword_results)
        final_results = _trim_results(final_results)
        sources = [doc.document_name for doc in final_results]

        # 4. Yield Metadata
        yield f"METADATA:{json.dumps({'session_id': session_id, 'sources': sources})}\n"

        # 5. Format Context
        context_text = (
            "\n---\n".join(
                [f"[Source {i}] {doc.document_name}\nContent:\n{doc.content}" for i, doc in enumerate(final_results, 1)]
            )
            if final_results
            else "No relevant documents found."
        )
        history_context = "\n".join([f"{m.role}: {m.content}" for m in history])

        # 6. Build Hybrid RAG Prompt (with BANT state)
        is_bant_enabled = getattr(client, "bant_enabled", True)
        prompt = build_hybrid_prompt(
            client, question, context_text, history_context, bant_state=current_bant, bant_enabled=is_bant_enabled
        )
        logger.info(f"Hybrid RAG stream prompt built | Context chunks: {len(final_results)}")

        # 7. Stream and Accumulate (LiteLLM auto-traces via callback)
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

        # 8. Finalize (Save to DB)
        bot_msg = add_chat_message(session, session_id, client_id=cid, role="bot", content=full_answer, bot_id=bid)

        # Store trace_id for feedback linking
        lf = get_langfuse()
        if lf and hasattr(bot_msg, "trace_id"):
            with contextlib.suppress(Exception):
                bot_msg.trace_id = lf.get_current_trace_id()

        session.commit()

        # 9. Fire-and-forget BANT extraction in bounded thread pool (saves 1-3s)
        if is_bant_enabled:
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
            )

        # 10. Yield final metadata including message_id
        yield f"\nFINAL_METADATA:{json.dumps({'message_id': bot_msg.id})}\n"

        logger.info(f"Hybrid RAG stream finished for session: {session_id}")
