# Architecture Overview

Last verified against the source on 2026-08-20. Every claim below was checked
against the code, not carried over from a previous revision. If you change the
shape of the system, change this file in the same commit.

## System Map

The platform repo holds four applications. The marketing site lives in a
separate repository.

```
platform/
├── api/          FastAPI REST + SSE + WebSocket, RAG pipeline, ARQ worker  (8000)
├── widget/       Embeddable chat widget, IIFE bundle          (5173 dev / 4173 preview)
├── app/          React admin dashboard SPA                                 (5174)
├── docs/         This documentation
└── load-tests/   k6 scenarios and the capacity measurements quoted below

../oyechats-website/   Next.js marketing site, separate repo                (3000)
```

## Application Responsibilities

### Backend API (`api/`)

Business logic, persistence, and AI orchestration.

- **Framework:** FastAPI with SQLAlchemy 2.0, Alembic migrations
- **Database:** PostgreSQL 16 with pgvector. 51 ORM models
- **Cache, queue, backplane:** Redis. Backs ARQ, SlowAPI counters, and the
  WebSocket backplane
- **LLM:** LiteLLM router. Primary `openai/gpt-5.4-mini`, automatic fallback to
  `gemini/gemini-2.5-flash`
- **Embeddings:** Google `gemini-embedding-001`, **768 dimensions**, matching the
  `Vector(768)` column. Batched 100 texts per call
- **Document processing:** pypdf and python-docx for extraction, recursive
  splitting for chunking
- **Web crawling:** Spider.cloud primary, Jina Reader fallback. **HTTP only, no
  local browser.** Nothing drives Chromium
- **Storage:** Cloudflare R2, S3-compatible (`r2_service.py`)
- **Email:** Brevo, transactional
- **Payments:** Razorpay, INR, single rail
- **Observability:** Langfuse for LLM traces, Sentry for errors

### Background Worker (ARQ)

A separate process, not part of the API. It runs **20 cron jobs** plus queued
jobs: document ingestion, invoice PDF rendering, outbound webhook delivery with
retry, dunning, subscription renewal, and qualification extraction after a chat
stream closes.

It is a **singleton**. Two workers share one Redis queue and race for jobs, which
is how invoice PDFs once appeared only intermittently.

### Chat Widget (`widget/`)

A self-contained bundle customers embed with one script tag.

- **Output:** IIFE `oyechats-widget.js` plus a sibling stylesheet
- **Stack:** React 19, Vite 7, Tailwind CSS 4
- **Isolation:** bundles its own React, so it cannot conflict with the host page
- **Transport:** REST plus SSE for streaming answers, WebSocket for live chat

### Admin Dashboard (`app/`)

Where customers configure bots. React 19, Vite 8, React Router 7, Recharts.
Bot management, knowledge base, leads, billing, and the live-chat operator
console.

## End-to-End Data Flow

### Customer Onboarding

```
1. Sign up          POST /auth/register        Client record
2. Create a bot     POST /bots                 Bot record with a unique bot_key
3. Add knowledge    POST /upload               extract -> chunk -> embed -> pgvector
   or               POST /crawl                Spider.cloud or Jina -> same pipeline
4. Copy the embed snippet from the dashboard
5. Paste into the site:
   <script src="cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

Ingestion runs in the ARQ worker, not inline in the request.

### Visitor Chat

```
1. Widget reads data-bot-key from its own script tag
2. GET  /bots/settings/public          colors, logo, greeting
3. POST /chat/stream                   X-Bot-Key header
4. RAG:
   a. Hybrid search      vector similarity + TSVECTOR keyword, scoped to that bot
   b. CAG-lite           bots at or under CAG_LITE_THRESHOLD (20) chunks skip
                         retrieval entirely and inject every chunk
   c. Relevance gate     optional, off by default (RELEVANCE_GATE_ENABLED)
   d. Rerank             optional, off by default (RERANK_ENABLED, FlashRank)
   e. Context assembly   top chunks + history + system prompt
   f. Generation         LiteLLM, streamed as SSE
5. Widget renders markdown as tokens arrive
6. ChatMessage stored with a Langfuse trace_id
7. BANT or MEDDIC extraction runs in the worker AFTER the stream closes
```

### Live Chat Handoff

```
1. Visitor requests a human
2. Session status moves bot -> waiting -> live
3. An operator is assigned by the bot's routing strategy:
     least_busy   (default) fewest active chats, ties broken by a round-robin cursor
     round_robin  strict cursor advance regardless of load
     simple       first available
4. Messaging over WebSocket
5. No operator available, the visitor leaves an offline message
```

WebSocket endpoints: `/ws/chat/{session_id}` for visitors, `/ws/operator` for
operators, and `/ws/agent` as a compatibility alias from the agent-to-operator
rename.

## Authentication

Four personas, four headers, resolved by FastAPI dependencies in
`api/app/api/auth.py`.

| Persona | Header | Source |
|---|---|---|
| Customer, admin, super-admin | `X-API-Key` | issued at register/login |
| Widget visitor | `X-Bot-Key` | the public `data-bot-key` on the embed script |
| Operator | `X-Operator-Key` | `operators.operator_api_key` |
| Operator, legacy | `X-Agent-Key` | compatibility alias, same resolution |

Two further headers narrow an already-authenticated request rather than
establishing identity: `X-Workspace-Id` selects a workspace, and
`X-Impersonation-Token` carries a super-admin impersonation grant.

Dependencies: `get_current_bot`, `get_current_client`, `get_current_client_strict`,
`get_current_operator`, `get_current_client_or_operator`, `get_current_affiliate`.
Super-admin routes use `get_current_client_strict` plus an `is_superadmin` check
inside the route.

## Rate Limiting

SlowAPI, backed by Redis, applied as **per-route decorators** rather than a
middleware layer.

| Route | Limit | Key |
|---|---|---|
| `/chat/stream` | 30/minute | `{bot_key}:{ip}` |
| Admin routes | varies | `X-API-Key`, falling back to client IP |
| Default | varies | client IP |

The chat key is **per bot per visitor IP**, not per bot. One bot serves far more
than 30 requests a minute in aggregate; a single visitor is what gets capped.
Reading it as a per-tenant cap gets capacity planning wrong in both directions.

## Middleware Stack

Applied in this order:

1. **CORS.** Origins depend on `APP_ENV`. Development allows localhost,
   production reads `CORS_ORIGINS`
2. **Timeout.** 60s, exempting the streaming paths (`/chat/stream`, `/crawl`, `/ws`)
3. **Body size limit.** Caps request bodies before they reach a handler

Rate limiting is not in this stack; see above.

## Capacity and Limits

The constraint on this system is **database connections**, not request
throttling. Numbers measured on a 2 vCPU / 4 GB box, the production shape.

- **Pool:** `pool_size=5 + max_overflow=10 = 15` connections for a single API
  worker. Raising `WEB_CONCURRENCY` must **divide** that budget, not multiply it
- **Chat gate:** `CHAT_MAX_CONCURRENCY` (default 10) caps concurrent generations
  and **must stay below the pool ceiling**. Inverted, chat drains the pool,
  requests queue on `pool_timeout`, and gunicorn reaps workers while the database
  sits idle. It reads exactly like a database problem and sends you to the wrong
  tier
- **Streaming pins a connection** for the whole generation, so concurrent AI
  conversations, not requests per second, is the number that matters

Measured, one worker against the split topology:

| concurrent chats | 1 worker | 4 API workers + 1 WS process |
|---:|---|---|
| 20 | 2.77 rps, 3,977 ms | 4.40 rps, 495 ms |
| 30 | 3.13 rps, 8,511 ms, 3.2% shed | 6.67 rps, 679 ms, 0% shed |
| 50 | 4.90 rps, 10,686 ms, 38.1% shed | 9.70 rps, 2,191 ms, 0% shed |

**Why one worker today.** `ConnectionManager` holds sockets in per-process
dictionaries, so a visitor and their operator must land in the same process. That
pinned the whole API to `WEB_CONCURRENCY=1` for a constraint only WebSockets
imposed. The fix, a dedicated single-worker WebSocket process with a Redis
backplane between processes, is merged and **inert**: `WS_BACKPLANE_ENABLED`
defaults to false and `oyechats-ws.service` is not installed. See
[`live-chat-process-split-rollout.md`](live-chat-process-split-rollout.md).

**Vector search and tenancy.** Retrieval is filtered by `bot_id`. A single
approximate index spanning every tenant is a correctness hazard, not just a slow
path: under filtered ANN the post-filter can discard the entire candidate set and
return **zero rows**, and small tenants are hit hardest. Do not reintroduce one.
If a bot outgrows exact scan, partition by `bot_id` with a per-partition index,
and prove a *small* tenant still returns rows before shipping it.

## Observability

**Langfuse** traces every LLM call through LiteLLM's callback. Trace IDs are
stored on `ChatMessage.trace_id`, so a user question links to the exact call.
Widget thumbs up/down feed back to the trace. There are two separate projects,
production and development, and traces must not mix. Enabled when both keys are
present; `LANGFUSE_FORCE_DISABLE=true` is the kill switch, and it is the only one
that works, since the enabled flag is computed from the keys.

**Sentry** captures runtime errors with endpoint tagging. Opt-in via
`SENTRY_DSN`, sampling 10% of traces and profiles. The widget has its own
optional DSN.

**Health:** `/health` (database and Redis) for load balancer probes, `/health/live`,
and `/health/full`, which also checks the worker heartbeat and is the strict gate
the deploy uses.

## Technology Stack

| Layer | Technology |
|---|---|
| LLM primary | `openai/gpt-5.4-mini` via LiteLLM |
| LLM fallback | `gemini/gemini-2.5-flash` |
| Embeddings | Google `gemini-embedding-001`, 768-dim |
| Vector store | PostgreSQL 16 + pgvector, hybrid with TSVECTOR |
| Backend | FastAPI, SQLAlchemy 2.0, Alembic, Python 3.11 |
| Queue | ARQ on Redis |
| Frontend | React 19, Vite 7/8, Tailwind CSS 4 |
| Crawling | Spider.cloud primary, Jina Reader fallback, HTTP only |
| Storage | Cloudflare R2 |
| Email | Brevo |
| Payments | Razorpay, INR |
| Rate limiting | SlowAPI on Redis |
| Observability | Langfuse, Sentry |
| Dependencies | uv (Python), npm (JavaScript) |
