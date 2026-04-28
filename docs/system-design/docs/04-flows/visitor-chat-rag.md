# Visitor chat (RAG)

> **Audience:** New engineers · CTO · **Read time:** 6 min · **Last updated:** 2026-04-28

## TL;DR

The most-trafficked flow in the system. Visitor asks a question → API authenticates the bot → hybrid (vector + keyword) search over **that bot's** documents → optional CRAG relevance gate → optional rerank → assemble context with chat history → LiteLLM streams response (OpenAI primary, Gemini fallback) → BANT extraction kicks off in the background after the stream closes. **Criticality 0.733 / 29 nodes** per the code-graph (the largest flow in the system).

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
      participant Worker as ARQ
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
    API->>Repo: hybrid_search(bot_id, query, top_k)
    Repo->>DB: SELECT ... ORDER BY 1 - (embedding <=> :q) DESC, ts_rank DESC
    DB-->>Repo: top chunks
    Repo-->>API: chunks

    opt RELEVANCE_GATE_ENABLED
        API->>LiteLLM: gate_score(query, chunks)
        LiteLLM->>LLM: gemini gate model call
        LLM-->>API: score 0..1
        API->>API: drop if < RELEVANCE_THRESHOLD (0.55)
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

    Note over API,Worker: Background BANT
    API->>Worker: enqueue _background_bant_extraction(session_id, message_id)
    Worker->>LiteLLM: extract BANT signals from latest turn
    LiteLLM-->>Worker: { dimension, value, confidence }
    Worker->>DB: INSERT bant_signals + UPDATE chat_sessions scores/tier
    alt tier transitioned (e.g., MQL→SAL)
        Worker->>Worker: enqueue task_deliver_webhook(tier_transition)
        Worker->>Worker: enqueue task_send_email("qualified") if email_on_qualified
    end
```

## Key files

| File | Role |
|---|---|
| [`api/app/api/chat_routes.py`](../../../api/app/api/chat_routes.py) | `POST /chat/stream` |
| [`api/app/services/rag_service.py`](../../../api/app/services/rag_service.py) | Hybrid search + context assembly |
| [`api/app/services/llm_service.py`](../../../api/app/services/llm_service.py) | LiteLLM wrapper |
| [`api/app/db/repository.py`](../../../api/app/db/repository.py) | `hybrid_search`, `ensure_chat_session` |
| [`api/app/services/qualification_service.py`](../../../api/app/services/qualification_service.py) | BANT extraction prompts + parsing |
| [`api/app/worker/tasks.py`](../../../api/app/worker/tasks.py) | `_background_bant_extraction` |

## Why hybrid retrieval (vs pure vector)

Vector cosine alone misses keyword matches that have weak semantic similarity but are an exact answer ("Order #12345 shipping status"). The TSVECTOR side guarantees keyword recall; the vector side guarantees semantic recall. The merge is in [`hybrid_search`](../../../api/app/db/repository.py).

## Variants & toggles

| Path | Default | Effect |
|---|---|---|
| `CAG_LITE_THRESHOLD=20` | on | Bots with ≤20 chunks **skip retrieval** (Cache-Augmented Generation lite — passes all chunks as context) |
| `RELEVANCE_GATE_ENABLED=false` | off | CRAG-style relevance scoring; if all chunks score below `RELEVANCE_THRESHOLD`, bot answers "I don't have that information" instead of hallucinating |
| `RERANK_ENABLED=false` | off | FlashRank cross-encoder rerank; reduces context to `RERANK_TOP_N=5` chunks |
| `MODERATION_ENABLED=true` | on | OpenAI moderation pre-check on user input |

## Credit cost

- 1 credit per AI message (default; tunable via `pricing_config.credit_cost.ai_message`).
- Deducted **at start** of stream so the visitor doesn't get a partial response with no charge.
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
3. **Quality** — thumbs feedback ratio + `bant_score` distribution.

If any regress, this page is the map for where to look.
