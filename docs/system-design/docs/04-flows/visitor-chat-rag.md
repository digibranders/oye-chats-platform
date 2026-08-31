# Visitor chat (RAG)

> **Audience:** New engineers · CTO · **Read time:** 6 min · **Last updated:** 2026-08-31

## TL;DR

The most-trafficked flow in the system. Visitor asks a question → API authenticates the bot → hybrid (vector + keyword) search over **that bot's** documents, fused by reciprocal rank fusion → CRAG relevance gate (**on by default**) → optional rerank → assemble context with chat history → LiteLLM streams response (OpenAI primary, Gemini fallback) → BANT extraction and a groundedness judge kick off in the background after the stream closes. It is the largest flow in the system.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor V as Visitor
    box rgb(224,242,254) Browser
      participant W as Widget
    end
    box rgb(254,243,199) Edge + API
      participant N as Nginx
      participant API as FastAPI
      participant Auth as auth.py
      participant Repo as repository
    end
    box rgb(220,252,231) Data
      participant DB as Postgres + pgvector
      participant Cache as Redis
    end
    box rgb(252,231,243) AI providers
      participant LiteLLM
      participant LLM as OpenAI / Gemini
    end
    box rgb(237,233,254) Async + observability
      participant BG as thread pool (in-process)
      participant LF as Langfuse
    end

    V->>W: types question
    W->>N: POST /chat/stream (X-Bot-Key, session_id, message)
    N->>API: forward (no buffering, 300s timeout)
    API->>Auth: get_current_bot()
    Auth->>Cache: bot_key cache lookup
    Cache-->>Auth: bot row (or DB miss → DB)
    Auth-->>API: Bot
    API->>Repo: ensure_chat_session(bot_id, session_id)
    Repo->>DB: SELECT or INSERT chat_sessions
    Repo-->>API: ChatSession
    API->>Repo: append user message
    Repo->>DB: INSERT chat_messages (role=user)

    Note over API,DB: Hybrid retrieval
    par vector arm
        API->>Repo: search_similar_documents(bot_id, embedding, k=15)
        Repo->>DB: SELECT ... ORDER BY embedding <=> :q
    and keyword arm
        API->>Repo: search_keyword_documents(bot_id, query, k=15)
        Repo->>DB: SELECT ... ts_rank(search_vector, plainto_tsquery('english', :q))
    end
    API->>API: reciprocal_rank_fusion(vector, keyword) → top k

    opt RELEVANCE_GATE_ENABLED (default true; skipped for non-English)
        API->>LiteLLM: gate_score(query, chunks)
        LiteLLM->>LLM: gate model call (runtime_config.get_gate_model())
        LLM-->>API: score 0..1
        API->>API: all below RELEVANCE_THRESHOLD → refuse, persist with is_unanswered
    end

    opt RERANK_ENABLED
        API->>API: FlashRank cross-encoder rerank → top RERANK_TOP_N
    end

    API->>API: build context (chunks + chat history + system prompt)
    API->>LiteLLM: completion(model=gpt-5.4-mini, fallbacks=[gemini-2.5-flash], stream=true)
    LiteLLM->>LLM: streaming chat completion
    LLM-->>LiteLLM: SSE chunks
    LiteLLM-->>API: chunks
    API-->>N: SSE chunks (data: ...)
    N-->>W: SSE chunks (no buffering)
    W-->>V: render markdown live

    Note over API,LF: After stream closes
    LiteLLM->>LF: trace event with trace_id
    API->>Repo: append bot message + trace_id
    Repo->>DB: INSERT chat_messages (role=bot)

    Note over API,BG: Background work — submit_background(), NOT ARQ
    API->>BG: _background_bant_extraction(session_id, message_id)
    BG->>LiteLLM: extract BANT signals from latest turn
    LiteLLM-->>BG: { dimension, value, confidence }
    BG->>DB: INSERT bant_signals + UPDATE chat_sessions scores/tier
    alt tier transitioned (e.g., MQL→SAL)
        BG->>BG: fire_webhook(tier_transition) → ARQ task_deliver_webhook
        BG->>BG: enqueue task_send_email("qualified") if email_on_qualified
    end
    API->>BG: _background_groundedness_check(question, answer, chunks)
    BG->>LF: groundedness_check safety-net metric (verdict is NOT acted on)
```

## Key files

| File | Role |
|---|---|
| [`api/app/api/chat_routes.py`](../../../../api/app/api/chat_routes.py) | `POST /chat/stream` |
| [`api/app/services/rag_service.py`](../../../../api/app/services/rag_service.py) | Hybrid search + context assembly |
| [`api/app/services/llm_service.py`](../../../../api/app/services/llm_service.py) | LiteLLM wrapper |
| [`api/app/db/repository.py`](../../../../api/app/db/repository.py) | `hybrid_search`, `ensure_chat_session` |
| [`api/app/services/qualification_service.py`](../../../../api/app/services/qualification_service.py) | BANT extraction prompts + parsing |
| [`api/app/services/rag_service.py`](../../../../api/app/services/rag_service.py) | `_background_bant_extraction` (`:2924`) and `_background_groundedness_check` (`:2902`) — both dispatched with `submit_background`, **not** ARQ |
| [`api/app/core/thread_pool.py`](../../../../api/app/core/thread_pool.py) | The shared 3-worker pool that runs them |
| [`api/app/services/relevance_gate.py`](../../../../api/app/services/relevance_gate.py) | CRAG scope gate |
| [`api/app/services/groundedness_gate.py`](../../../../api/app/services/groundedness_gate.py) | Post-answer hallucination judge (observability only) |

## Why hybrid retrieval (vs pure vector)

Vector cosine alone misses keyword matches that have weak semantic similarity but are an exact answer ("Order #12345 shipping status"). The TSVECTOR side guarantees keyword recall; the vector side guarantees semantic recall. The two arms are separate queries run in parallel ([`repository.search_similar_documents` / `search_keyword_documents`](../../../../api/app/db/repository.py)) and merged by `reciprocal_rank_fusion` in `rag_service.py` — there is no single "hybrid_search" SQL statement.

**Caveat that matters in production:** the keyword arm is pinned to the `'english'` text-search config and uses `plainto_tsquery`, which ANDs every extracted lexeme. A non-English question therefore contributes near-zero keyword hits, so a non-English session is effectively **vector-only** (verified in `api/tests/test_cross_lingual_retrieval.py`; the degradation is total, not partial). The vector arm compensates with a relaxed `CROSS_LINGUAL_MAX_DISTANCE`, and the relevance gate and reranker are both bypassed for non-English because they are English-tuned.

## Variants & toggles

| Path | Default | Effect |
|---|---|---|
| `CAG_LITE_THRESHOLD=20` | on | Bots with ≤20 chunks **skip retrieval** (Cache-Augmented Generation lite — passes all chunks as context) |
| `RELEVANCE_GATE_ENABLED` | **on** (default `true`) | CRAG-style relevance scoring; if all chunks score below `RELEVANCE_THRESHOLD` (0.55, per-bot override `bots.relevance_threshold`) the bot refuses instead of hallucinating. Skipped for non-English sessions |
| `RERANK_ENABLED` | off | FlashRank cross-encoder rerank. The chat path passes `top_n=15` explicitly, so `RERANK_TOP_N=5` does **not** apply here |
| `MODERATION_ENABLED` | on | `omni-moderation-latest` pre-check on visitor input, plus an output-side check on the generated answer. Fails open on a moderation-service outage |
| `GROUNDEDNESS_CHECK_ENABLED` | on | Post-answer groundedness judge. **Observability only** — it runs after the answer has streamed and its verdict is logged, never enforced |

## Credit cost

- 1 credit per AI message (default; the `pricing_config` key is `credit_cost.ai_chat`, and the ledger `reason` enum value is `ai_chat`).
- Deducted **at start** of stream so the visitor doesn't get a partial response with no charge. A generation that fails is signalled explicitly by the stream's status dict, which both suppresses the QA-cache write and triggers the refund — before that fix every failure branch yielded an error *string*, so the error was billed, persisted as the answer, and cached for an hour.
- If balance is 0, request returns 402 and the widget shows a friendly "credits depleted, contact admin" message.

## Failure modes

- **OpenAI 429 / 500** → LiteLLM falls over to Gemini transparently; visitor sees no error.
- **Both LLMs down** → 502; widget retries once with exponential backoff before showing "Sorry, having trouble — try again".
- **DB hybrid search slow** → mitigated by `bot_id` index on `documents`; if pgvector index degrades, `REINDEX` is in [runbooks](../../../runbooks/2026-04-27-rag-retrieval-fix.md).
- **Langfuse outage** → tracing is fire-and-forget; doesn't block the response.

## Why this matters

This is the **product**. Latency, cost, and quality of this flow are the three numbers the CTO should watch:

1. **Latency** — p50 / p95 of `/chat/stream` (target p95 < 5s to first token).
2. **Cost** — OpenAI tokens per message (≤ ~1500 input + 300 output).
3. **Quality** — thumbs feedback ratio, `chat_messages.is_unanswered` rate, `bant_score` distribution, and the `groundedness_check` counters on `GET /superadmin/safety-net-metrics`.

If any regress, this page is the map for where to look.
