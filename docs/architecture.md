# Architecture Overview

## System Map

OyeChats is a monorepo containing four applications that together deliver an embeddable AI chatbot platform.

```
oye-chats/
├── platform/
│   ├── api/          → FastAPI REST API + RAG pipeline       (port 8000)
│   ├── widget/       → Embeddable chat widget IIFE bundle    (port 5173 dev / 4173 preview)
│   ├── admin/        → React admin dashboard SPA             (port 5174)
│   └── docs/         → This documentation
└── landing/          → Next.js marketing site                (port 3000)
```

## Application Responsibilities

### Backend API (`api/`)

The central nervous system. Handles all business logic, data persistence, and AI orchestration.

- **Framework:** FastAPI 0.115+ with SQLAlchemy 2.0 ORM
- **Database:** PostgreSQL 16 with pgvector extension for vector similarity search
- **LLM Orchestration:** LiteLLM abstraction layer (supports OpenAI, Gemini, and others)
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **Document Processing:** pypdf, python-docx for extraction; langchain-text-splitters for chunking
- **Web Crawling:** Playwright (Chromium) for scraping customer websites
- **Cloud Storage:** Cloudflare R2 (S3-compatible) for document and chat-file storage
- **Observability:** Langfuse (LLM traces) + Sentry (error tracking)

### Chat Widget (`widget/`)

A self-contained JavaScript bundle that customers embed on their websites.

- **Output:** IIFE script `oyechats-widget.js` + sibling stylesheet `oyechats-widget.css`
- **Stack:** React 19, Vite 7, Tailwind CSS 4
- **Isolation:** Bundles its own React instance — no conflicts with the host page
- **Communication:** REST API calls with SSE streaming for real-time responses

### Admin Dashboard (`admin/`)

The management interface where customers configure their bots.

- **Stack:** React 19, Vite 8, React Router 7, Recharts (analytics), react-colorful (theming)
- **Features:** Bot CRUD, document management, analytics dashboards, live chat operator tools

### Landing Page (`../landing/`)

Marketing site at oyechats.com.

- **Stack:** Next.js 16, React 19, Tailwind CSS v4

## End-to-End Data Flow

### Customer Onboarding

```
1. Customer signs up         → POST /auth/register → Client record created
2. Creates a bot             → POST /bots → Bot record with unique bot_key
3. Uploads documents         → POST /upload → Extraction → Chunking → Embedding → pgvector
   OR crawls a URL           → POST /crawl → Playwright scrape → same pipeline
4. Copies embed script       → From admin dashboard
5. Pastes into website       → <script src="cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx">
```

### Visitor Chat Flow

```
1. Visitor loads page        → Widget script executes, reads data-bot-key
2. Widget fetches settings   → GET /bots/settings/public (colors, logo, system prompt)
3. Visitor asks question     → POST /chat/stream with X-Bot-Key header
4. Backend runs RAG:
   a. Hybrid search          → Vector similarity + keyword (TSVECTOR) over bot's documents
   b. Context assembly       → Top chunks + chat history + system prompt
   c. LLM generation         → LiteLLM → streaming SSE response
   d. BANT extraction        → Background sales qualification (if enabled)
5. Response streams back     → Widget renders markdown in real-time
6. Message stored            → ChatMessage record with Langfuse trace_id
```

### Live Chat Handoff

```
1. Visitor requests handoff  → POST /operators/handoff
2. Session status changes    → bot → waiting → live
3. Operator matched          → Round-robin assignment from available operators
4. Real-time messaging       → WebSocket connection (/ws)
5. If no operator available  → Offline message queued
```

## Authentication Model

OyeChats uses two separate auth mechanisms for its two client types:

| Client Type | Header | Value | Used By |
|-------------|--------|-------|---------|
| Admin/Operator | `X-API-Key` | Client or Operator API key | Admin dashboard, operator tools |
| Widget (Visitor) | `X-Bot-Key` | Bot's public key (e.g., `bot-6a427d4529b9`) | Embedded chat widget |

The backend resolves identities through FastAPI dependency injection:
- `get_current_bot(request)` — resolves a Bot from `X-Bot-Key` (or legacy `X-API-Key`)
- `get_current_client_or_operator(request)` — resolves a Client or Operator from `X-API-Key`, returning `{"type": "client"|"operator", "entity": ..., "client_id": int}`

## Rate Limiting

Rate limiting is implemented via `slowapi`:
- **Chat endpoints:** 30 requests/minute per bot key
- **Per-endpoint limits:** Configurable via `@limiter.limit()` decorator

## Middleware Stack

The FastAPI application applies middleware in the following order:

1. **CORS** — Dynamic origins based on `APP_ENV` (dev allows `localhost:*`; prod reads `CORS_ORIGINS`)
2. **Timeout** — 60-second request timeout; exempts streaming paths (`/chat/stream`, `/crawl`, `/ws`)
3. **Rate Limiter** — slowapi integration for per-endpoint throttling
4. **Sentry** — Optional error tracking (requires `SENTRY_DSN`)

## Observability

### Langfuse (LLM Tracing)

Every LLM call is traced through Langfuse via LiteLLM's auto-callback mechanism. Trace IDs are stored on `ChatMessage.trace_id`, enabling end-to-end debugging from a user question to the exact LLM call.

- **Opt-in:** Requires `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY`
- **Feedback Loop:** Widget feedback (thumbs up/down) is linked back to traces

### Sentry (Error Tracking)

Runtime errors are captured by Sentry with automatic endpoint tagging.

- **Opt-in:** Requires `SENTRY_DSN`
- **Sample Rates:** 10% traces, 10% profiles (configurable)
- **Widget:** Also has optional Sentry via `VITE_SENTRY_DSN`

## Technology Stack Summary

| Layer | Technology | Version |
|-------|-----------|---------|
| LLM | LiteLLM (OpenAI/Gemini) | 1.82+ |
| Embeddings | OpenAI text-embedding-3-small | 1536-dim |
| Vector DB | PostgreSQL + pgvector | 16 / 0.3 |
| Backend | FastAPI + SQLAlchemy + Alembic | 0.115+ / 2.0 |
| Frontend | React + Vite + Tailwind CSS | 19 / 7-8 / 4 |
| Web Scraping | Playwright (Chromium) | — |
| Cloud Storage | Cloudflare R2 (S3-compatible) | — |
| Observability | Langfuse + Sentry | — |
| Package Mgmt | uv (Python) + npm (JS) | — |
