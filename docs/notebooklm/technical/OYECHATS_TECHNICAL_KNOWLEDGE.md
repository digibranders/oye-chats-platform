# OyeChats — Deep Technical Knowledge Base

*Audience: engineers, technical evaluators, CTOs conducting due diligence. This is a NotebookLM knowledge source on OyeChats' technical architecture. It is organized as a standalone architectural reference — system boundaries, data model, AI pipeline internals, security model, real-time systems, billing architecture, and known engineering trade-offs.*

*Evidence tags used throughout: **[T1]** = confirmed directly in source code during this review. **[T2]** = confirmed in first-party product/engineering docs (`docs/oyechats-technical-story.md`, root `CLAUDE.md`). **[T3]** = positioning/marketing framing, included only where it clarifies intent, not as a technical fact. **[VERIFY]** = could not be confirmed against code or docs in this review; flagged rather than guessed.*

---

## 1. System Overview

OyeChats is a multi-tenant SaaS platform that ingests a business's website and documents into a private, per-bot retrieval memory, then serves an embeddable AI chat widget that answers visitor questions grounded in that memory — with qualification scoring, human handoff, lead capture, and a credit-metered billing system layered underneath. **[T2]**

### The four surfaces / repos

| Surface | Directory | Port (dev) | Stack | Purpose |
|---|---|---|---|---|
| Backend API | `api/` | 8000 | FastAPI · SQLAlchemy 2.0 · PostgreSQL 16 + pgvector · LiteLLM · ARQ | REST + SSE + WebSocket; RAG; auth; ingestion; billing |
| Chat Widget | `widget/` | 5173 dev / 4173 preview | React 19 · Vite 7 · Tailwind v4 | Two-stage embed: a tiny loader IIFE the customer script-tags, plus lazily-imported ESM app chunks rendered into a shadow root |
| Admin Dashboard | `app/` | 5174 | React 19 · Vite 8 · React Router 7 · Recharts | Bot/knowledge/leads/billing management; live-chat operator console |
| Marketing Site | `../oyechats-website/` (sibling repo, not in this monorepo) | 3000 | Next.js 16 · React 19 · Tailwind v4 | Public site; reads live pricing from the platform API so published and charged price cannot drift |

**[T1/T2]** — confirmed in root `CLAUDE.md`'s architecture table and directory tree. Three apps live in this repo (`api/`, `widget/`, `app/`); the marketing site is a separate repository entirely.

> **Multilingual reality check.** The backend knows a longer list of locales, but the dashboard and the widget each ship exactly **two** UI dictionaries — English and Hindi (`app/src/i18n/locales/{en,hi}.ts`, `widget/src/i18n/locales/{en,hi}.js`) — and the language picker offers only locales with a shipped dictionary. Do not describe the product as multilingual beyond English and Hindi. **[T1]**

### Tech stack summary

| Layer | Technology | Notes |
|---|---|---|
| LLM (primary) | OpenAI `gpt-5.4-mini` | Routed via LiteLLM |
| LLM (fallback) | Google `gemini-2.5-flash` | Automatic fallback inside LiteLLM's router |
| Gate/enrichment LLM | `gemini-2.5-flash` | Relevance gate + optional chunk contextual enrichment |
| Embeddings | Google `gemini-embedding-001` | 768-dim, Matryoshka-truncated, client-side L2-normalized; batched **100 texts/call** via `batchEmbedContents`, 8-way concurrent. Quota is counted **per content item, not per HTTP call**, so batching saves round-trips, not quota; sustained throughput is capped by `EMBED_RPM_LIMIT` (default 2850). Model is now marked **Legacy** by Google; `gemini-embedding-2` is current (8192 input tokens vs 2048, auto-normalizes truncated dims) but its embedding space is **incompatible** — adopting it means re-embedding the whole corpus. |
| Vector DB | PostgreSQL 16 + pgvector | Hybrid: `Vector(768)` column + `TSVECTOR` column, same table |
| Backend framework | FastAPI, SQLAlchemy 2.0, Alembic | Python 3.11, `uv` for dependency management |
| Background queue | ARQ on Redis | Runs as `oyechats-worker.service` |
| Web scraping | Jina Reader (primary) + Spider.cloud (fallback) | `CRAWL_PROVIDER_PRIMARY` defaults to `"jina"` (`api/app/config.py:674`). Off-box/managed fetch — no local headless browser |
| File storage | Cloudflare R2 (S3-compatible) | `api/app/services/r2_service.py`. Env vars use the `R2_` prefix, with the legacy `B2_*` names still accepted as fallbacks — the module was renamed from `b2_service.py`, so older material naming that file is out of date |
| Email | Brevo (Sendinblue) | Transactional only |
| Payments | Razorpay | Single provider, INR-only rail as of this review |
| Rate limiting | SlowAPI on Redis | Per-route, keyed on bot+visitor together |
| Observability | Langfuse (two separate projects: Prod / Dev) + Sentry | |

**[T2]** — full table confirmed in root `CLAUDE.md` "Tech Stack" section.

---

## 2. Architecture: Request Flow, Widget to LLM and Back

1. **Embed (two stages).** The customer's page loads `<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx">`. That file is **not** the app — it is a deliberately tiny **loader IIFE** (`widget/src/loader.js`, built by `vite.loader.config.js`, budgeted at **8 KB gzipped** by `size-limit`). The loader locates its own `<script>` tag, reads `data-bot-key`, sets `window.OYECHATS_BOT_KEY`, exposes `window.OyeChats` as a stub-and-queue API so host-page code can call `.on('ready')`/`.open()`/`.identify()` before the app exists, honours `window.OYECHATS_ASYNC_INIT` for consent-gated installs, then fetches `<base>/app/manifest.json`, validates the hashed entry-chunk and stylesheet filenames against a strict pattern (so a tampered manifest cannot point the widget off-CDN), dynamic-imports the entry chunk and calls its `init()`. If boot fails it clears its cached promise so a later `OyeChats.init()` can retry without a page reload. **Stage 2** (`widget/src/app-entry.jsx`) creates `<div id="oyechats-widget-root">`, attaches the shadow root, injects the hashed stylesheet and mounts React (its own bundled copy). Chat, live chat, markdown, the lead/handoff/quotation forms, Sentry and every non-English locale are separate lazy chunks, so a visitor who never opens the widget pays only for the launcher. **[T1 — `widget/package.json` `size-limit` budgets; root `CLAUDE.md` "Widget Embedding"]**
2. **Isolation.** On first interaction the widget attaches a **shadow root** (`container.attachShadow({mode: 'open'})`) and renders its React tree into `#oyechats-shadow-inner` inside it, with its stylesheet injected as a `<link>` inside the same shadow root — confirmed in `widget/src/app-entry.jsx`. **[T1]** This guarantees the host page's CSS/JS can never leak in or out.
3. **Config fetch.** The widget requests the bot's public config (colors, avatar, welcome text, live-chat/lead-form toggles, business hours) using the `X-Bot-Key` header.
4. **Message send.** A visitor question posts to the chat route with `X-Bot-Key`. The backend resolves the bot via `get_current_bot` (`api/app/api/auth.py`), enforces the domain allowlist if configured, checks workspace suspension, and applies a rate limit bucketed on **bot key + visitor address together** (SlowAPI/Redis). **[T1/T2]**
5. **Persist first.** The visitor message is written to `chat_messages` before any expensive work runs, so a downstream failure never loses the question. **[T2]**
6. **Credit deduction.** A credit is taken under a per-account advisory lock *before* generation starts; a structural (not text-matched) refund fires if generation produces nothing. **[T2]**
7. **Fast-exit checks.** Name-collection flow, deterministic intent routing (greetings/identity), injection screening, and answer-cache lookup all run before retrieval — see §4. **[T2]**
8. **Retrieval.** `rag_service.py` runs hybrid search (vector + keyword) over that bot's `documents` rows, fuses results (reciprocal rank fusion), optionally reranks, and applies the relevance gate. **[T1]**
9. **Prompt assembly.** A layered system prompt is built (`build_hybrid_prompt` in `rag_service.py`, ~6,600-line file) — see §4.6 for the 7-layer structure confirmed directly in `response_style.py`'s docstring. **[T1]**
10. **Generation.** LiteLLM routes to the primary model (`gpt-5.4-mini`), falling back automatically to `gemini-2.5-flash` on failure; tokens stream back over SSE. **[T1/T2]**
11. **Stream sanitization.** A live sanitizer strips internal control markers (buffering across chunk boundaries) and runs an output-side prompt-leakage guard that truncates the stream if the model starts reproducing its system prompt. **[T2]**
12. **Post-generation repair.** Formatting repair, media-card whitelist validation, meeting/message card resolution, handoff-safety-net detection, and qualification-tag safety net all run after the stream closes, before the closing SSE frame — which is *always* sent even if the DB write fails. **[T2]**
13. **Fire-and-forget background work.** Qualification extraction, a groundedness audit (LLM-as-judge on the generated answer), and Langfuse tracing all run after the stream closes, never blocking the visitor's response. **Not on ARQ** — despite the platform having a Redis-backed queue, both hand off to a shared in-process thread pool via `core/thread_pool.submit_background` (`rag_service.py:7274`, `:7291`). The practical consequence, worth stating rather than glossing: this work is **non-durable**. An API restart between the stream closing and the extraction finishing loses that turn's qualification update silently — there is no retry and no dead-letter, which is exactly what ARQ would have provided. **[T1]**

---

## 3. Data Model

Confirmed directly against `api/app/db/models.py`, which declares **51 `__tablename__` values** (`grep -c __tablename__`). **[T1]** The groups below are the ones you will actually touch, not the full list; `models.py` is the single source of truth. Root `CLAUDE.md` now states 51 as well — an older "25 tables" figure in either document is superseded.

### Core
- **`clients`** (`Client`) — the account/workspace: email, hashed password, `api_key`, `max_bots`, `is_superadmin`, `is_bot_manager`.
- **`oauth_accounts`** (`OAuthAccount`) — linked social sign-in identities.
- **`bots`** (`Bot`) — a chatbot instance: `bot_key`, system prompt, colors/logos, business hours, `live_chat_enabled`, `bant_config` (JSONB). **There is no `Bot.qualification_framework` column** — the bot's chosen framework is read out of `bant_config` by `qualification_service._framework_name` (`models.py:361`, `qualification_service.py:577`). The `qualification_framework` *column* lives on `chat_sessions`, where it stamps which framework scored that conversation.
- **`documents`** (`Document`) — ingested passages: text + `Vector(768)` + `TSVECTOR`, source provenance, content fingerprint, active flag.
- **`lead_info`** (`LeadInfo`) — captured contact, 1:1 with a chat session.
- **`company_profile`** (`CompanyProfile`) — cached company-domain enrichment, reused across leads from the same company.
- **`meeting_bookings`** (`MeetingBooking`) — Calendly/Zcal/Cal.com booking confirmations.
- **`activation_events`** (`ActivationEvent`) — free-form onboarding funnel events (studio opened, widget installed, etc.).

### Conversation / live chat
- **`chat_sessions`** (`ChatSession`) — status enum `bot|waiting|live|closed`, qualification scores/tier, `qualification_framework` (the per-conversation stamp, `models.py:985`), `dimension_scores`, `last_probed_dimension`, visitor rating, `assigned_operator_id`.
- **`chat_messages`** (`ChatMessage`) — role `user|bot|operator|system`, `trace_id` for Langfuse correlation.
- **`operators`** (`Operator`) — team member: own `operator_api_key`, role `owner|admin|operator`, `max_concurrent_chats`.
- **`operator_invites`** (`OperatorInvite`) — pending workspace invitations.
- **`departments`** (`Department`) — operator grouping for routing/transfer.
- **`chat_audit_logs`** (`ChatAuditLog`) — immutable state-transition log.
- **`live_chat_queue`** (`LiveChatQueueEntry`) — durable FIFO queue entries.
- **`canned_responses`** (`CannedResponse`) — `/shortcut` snippets for operators.
- **`offline_messages`** (`OfflineMessage`) — forms submitted while no operator is available.

### Qualification
- **`bant_signals`** (`BANTSignal`) — append-only audit: dimension, `score_before`/`score_after`, source (`llm` or `cta_click`).
- **`visitor_events`** (`VisitorEvent`) — behavioral signals: page views, return visits, UTM.
- **`bot_growth_events`** (`BotGrowthEvent`) — per-bot business events.

### Billing (Razorpay, INR rail)
- **`plans`** (`Plan`) — tier definition: price, `credits_per_month`, included seats, feature flags, gateway plan IDs.
- **`promotions`** (`Promotion`) — time-boxed acquisition offers.
- **`subscriptions`** (`Subscription`) — status `trialing|active|past_due|canceled|paused|expired`.
- **`usage_records`** (`UsageRecord`) — per-period counters.
- **`invoices`** (`Invoice`) — issued tax invoices.
- **`invoice_counters`** (`InvoiceCounter`) — per-financial-year numbering series.
- **`payment_methods`** (`PaymentMethod`) — card/UPI/bank references.
- **`credit_ledger`** (`CreditLedger`) — append-only event-sourced ledger; FIFO top-up expiry via a self-referencing `grant_id` FK.
- **`pricing_config`** (`PricingConfig`) — super-admin-tunable key/value store (credit costs, kill switch).
- **`processed_webhooks`** (`ProcessedWebhook`) / **`failed_webhooks`** (`FailedWebhook`) — inbound gateway-event idempotency and dead-lettering.
- **`coupons`** (`Coupon`) — discount codes.

### Outbound integrations / platform
- **`webhooks`** (`Webhook`) — customer-registered endpoint: URL, secret, event filter.
- **`webhook_deliveries`** (`WebhookDelivery`) — per-attempt delivery log, 5-retry backoff schedule.
- **`llm_call_logs`** (`LLMCallLog`) — model cost/usage tracking.
- **`impersonation_tokens`** (`ImpersonationToken`) — short-lived super-admin impersonation grants.
- **`affiliates`** (`Affiliate`), **`referral_codes`** (`ReferralCode`), **`referral_clicks`** (`ReferralClick`) — affiliate program.
- **`audit_logs`** (`AuditLog`) — platform-wide immutable mutation log.

### Key relationships
`Client → Bot → Document`; `Bot → ChatSession → ChatMessage`; `Client → Operator → Department`; `Subscription → Invoice`; every credit movement writes a `CreditLedger` row keyed to `Client` and/or `Bot`. Every `documents` row carries both an `active` boolean and the owning `bot_id`; **every retrieval query in the system filters on both**, which is the single mechanism that both prevents cross-tenant leakage and implements the knowledge-deactivation-on-lapse behavior described in §7. **[T1/T2]**

---

## 4. RAG / AI Pipeline in Technical Depth

Primary source file: `api/app/services/rag_service.py` — **6,606 lines**, confirmed by direct read. **[T1]**

### 4.1 Ingestion path
Document upload or crawl → **extraction** (`extraction.py`: PDF via pypdf, DOCX via python-docx, plain text passthrough) → **cleaning** (`cleaner.py`: whitespace/encoding normalization, boilerplate stripping) → **chunking** (`chunking.py`: recursive splitting, default 1000 chars / 200 overlap, both env-configurable) → **embedding** (`embedder.py` / `gemini_embedding.py`) → **storage** (`repository.py`: PostgreSQL row with both a `Vector(768)` and a `TSVECTOR`). **[T1/T2]**

### 4.2 Embedding: model, dimensions, normalization
Confirmed directly in `api/app/ingestion/embedder.py`'s module docstring: **[T1]**
- Provider: Google `gemini-embedding-001`, single provider, no cross-model fallback — the docstring states explicitly that "mixing embedding models corrupts vector search."
- Output: 768-dim, **L2-normalized client-side** to match the pgvector column.
- Throughput: **batched, not one-per-request.** `gemini_embedding.py` calls the `batchEmbedContents` REST endpoint with up to `_MAX_BATCH` = **100 texts per call** (`api/app/services/gemini_embedding.py:55,92,180`) and fans batches out across `EMBED_CONCURRENCY` workers (default 8, `config.py:93`). The important subtlety, stated in that module's own docstring: **Gemini's quota is counted per content item, not per HTTP call**, so batching saves round-trips but not quota — sustained throughput is capped by `EMBED_RPM_LIMIT` (default 2850, `config.py:101`), not by batch size or worker count. This corrects an earlier revision of this document, which asserted "1 text per request — there is no batch embedding API," contradicting §1's own tech-stack table. **[T1]**
- Failure mode: on persistent embedding failure, `embed_chunks` **raises** rather than substituting a different model — ingestion retries via ARQ, and at *query* time the pipeline degrades to full-text-only search rather than failing the request.

### 4.3 Hybrid retrieval
Confirmed via function inventory in `rag_service.py`: **[T1]**
- `_vector_search()` — pgvector cosine/L2 similarity search, scoped by client/bot ID.
- `_keyword_search()` — PostgreSQL `TSVECTOR` full-text search, same scoping.
- `reciprocal_rank_fusion(vector_results, keyword_results, k=60)` — merges both ranked lists; passages ranked highly by *both* methods are rewarded over passages that only one method found.
- `_trim_results(results, top_k=15)` — fused set is trimmed to a fixed depth (deliberately flat rather than adaptive, per `docs/oyechats-technical-story.md`, for predictable per-query cost).
- Query-side resilience: `_zero_result_multi_query_fallback()` regenerates paraphrased queries if the first retrieval returns nothing; `rewrite_query()` expands pronoun/ellipsis-heavy follow-ups into self-contained queries using conversation history, with a timeout that falls back to the raw question rather than stalling the visitor.
- Query embeddings are cached (`_embed_query_cached` / `_embed_query_cached_async`), keyed on a normalized cache key (`_normalize_question_for_cache` strips smart quotes, whitespace, trailing punctuation) so paraphrased-but-identical questions don't pay for re-embedding.

### 4.4 CAG-lite (Cache-Augmented Generation, lite mode)
Confirmed in `config.py` line 552 and two call sites in `rag_service.py`: **[T1]**
```
CAG_LITE_THRESHOLD = 20   # env-configurable, default 20
```
If a bot's total chunk count is ≤ this threshold, retrieval is **skipped entirely** and all chunks are injected directly into the prompt — appropriate for small knowledge bases where "search" adds latency without adding precision. A code comment at line 1514 notes this interacts with prompt-size budgeting: large chunks + long history can still approach context limits even under CAG-lite, so the two budgets are not independent.

### 4.5 Relevance gating and reranking
- **Relevance gate** (`RELEVANCE_GATE_ENABLED`, on by default) — a fast Gemini call scores each retrieved passage against the question; if *every* passage scores below threshold, no answer is generated from that material — the pipeline returns a graceful pivot instead. Threshold is tunable per bot. **[T1/T2]**
- **Reranking** (`RERANK_ENABLED`, off by default) — imported from `app.services.reranker` (FlashRank cross-encoder per root `CLAUDE.md`); fails silently to the original fusion order on any error, so a reranker outage can never block an answer. **[T1/T2]**

### 4.6 Prompt layering — confirmed 7-layer structure
This is the most load-bearing spot-check in this document. `api/app/services/response_style.py`'s module docstring states the **exact** layer architecture of the assembled system prompt, verbatim: **[T1]**

```
Layer 1: Identity        → "You are the AI assistant for {display_name}"
Layer 2: Scope           → in-scope refusal + injection defence
Layer 3: Voice           → first-person / third-person / energy match
Layer 4: Knowledge rules → rule numbers 1-11 in build_hybrid_prompt
Layer 5: Reference info  → retrieved RAG context
Layer 6: Conversation    → recent message history
Layer 7: RESPONSE STYLE  → response_style.py itself — format, length, tone, follow-ups
```

Notable details from the same docstring:
- The `RESPONSE_STYLE_BLOCK` constant is **static text**, ~820 tokens, appended identically to every bot's prompt after layers 1–6. Because it never changes, OpenAI prompt caching gives ~100% hit rate on it after the first request per bot — incremental per-request cost is described as "negligible (< 0.5 cents per 1k turns at gpt-5.4-mini pricing)."
- Explicit maintenance protocol embedded in the docstring: any prompt-rule change should be validated by sampling the next 50 responses across ≥3 bots for regressions, and rule violations should be fixed by *tightening the specific rule*, not by adding new rules — with a stated ceiling ("models follow specific rules better than long ones") and a hard token budget of under 1000, "anything above starts hitting diminishing returns."
- The style block is delimiter-wrapped (`═══` rows) specifically so the model treats it as a self-contained unit and doesn't interleave platform-wide formatting rules with customer-specific business rules from the layers above.

This 7-layer view is the code's own internal accounting of `build_hybrid_prompt()`. The higher-level narrative in `docs/oyechats-technical-story.md` additionally itemizes date-hint injection, structured-event blocks, a media-catalog whitelist, and qualification instructions as further prompt content — those live inside Layers 4–6 above rather than as separate top-level layers; both descriptions are consistent, just at different granularity. **[T1/T2]**

### 4.7 LLM routing
LiteLLM routes to OpenAI `gpt-5.4-mini` as primary, with automatic fallback to Google `gemini-2.5-flash` on failure — confirmed in `api/app/services/llm_service.py` per root `CLAUDE.md`'s Key Files table and RAG pipeline diagram. **[T1/T2]** A separate, cheaper `gemini-2.5-flash` call handles the relevance gate and optional contextual chunk enrichment — distinct from the primary generation call.

### 4.8 Structured event extraction and date handling
A specialized side-pipeline (`_build_date_hints`, `_is_event_question`, `_build_events_context`, `_maybe_events_block` in `rag_service.py`) identifies event-shaped pages at ingestion via a cheap keyword filter, extracts them into typed dated records, and serves date-shaped questions ("when is your next workshop") from a precise structured lookup rather than asking the model to parse fuzzy prose dates at answer time. Stale events are pruned automatically. **[T1/T2]**

### 4.9 Groundedness auditing
`_background_groundedness_check()` runs after the answer streams — a judge model rates whether the answer's claims are actually supported by the retrieved passages. Confirmed as observability-only (does not block or alter the delivered answer); it is the only automated check on the generated prose itself, as opposed to checks on the retrieved inputs. **[T1/T2]**

---

## 5. Auth & Security Model

### 5.1 The four credential types
Confirmed directly in `api/app/api/auth.py` (1,646 lines) header constants and dependency docstrings: **[T1]**

| Header constant | Value | Resolves to | Notes |
|---|---|---|---|
| `API_KEY_NAME` | `X-API-Key` | `Client` (workspace owner/admin) | Strongest customer credential; only path that can reach billing or (if `is_superadmin`) the control tower |
| `BOT_KEY_NAME` | `X-Bot-Key` | `Bot` | Public by design, visible in page source; `get_current_bot` falls back to `X-API-Key` → client's default (first) bot for backward compatibility |
| `OPERATOR_KEY_NAME` | `X-Operator-Key` | `Operator` (scoped to one workspace) | `get_current_client` also accepts this and resolves it to the operator's *workspace* `Client` |
| `LEGACY_AGENT_KEY_NAME` | `X-Agent-Key` | Same as `X-Operator-Key` | Backward-compat alias during the agent→operator terminology rename |

Additional headers referenced in `auth.py`: `X-Workspace-Id` (paired with `X-API-Key` to let one human identity switch between workspaces they belong to) and `X-Impersonation-Token` (super-admin impersonation grants). **[T1]**

Key dependency functions and their documented scope, all confirmed by direct grep of `auth.py`:
- `get_current_client()` — `X-API-Key` primary, `X-Operator-Key`/`X-Agent-Key` fallback resolving to the operator's workspace.
- `get_current_client_strict()` — `X-API-Key` **only**; does not fall back to bot or operator keys. Docstring states this exists specifically "to exclude *operator* and *bot* keys" — this is the dependency super-admin and affiliate routes are gated on, so an operator key can never escalate into the control tower even inside a super-admin's own workspace.
- `get_current_operator()` — `X-Operator-Key` only.
- `get_current_client_or_operator()` — accepts either; used by routes both personas can reach (e.g., subscription status reads).
- `get_current_bot()` — `X-Bot-Key`, with `X-API-Key`-as-default-bot fallback and origin/domain-allowlist enforcement.

### 5.2 SSRF protections
Confirmed directly in `api/app/core/ssrf.py` (417 lines). This is a dedicated, shared module used by every server-side fetch whose target URL can be influenced by a customer or crawled content (sitemap discovery, preview HEAD checks, webhook delivery, favicon/brand-color fetches). **[T1]**

Mechanisms, verified in code:
- `validate_public_url()` — rejects non-http(s) schemes; resolves the hostname and rejects if **any** resolved address is private, loopback, link-local (explicitly including the `169.254.169.254` cloud metadata address), reserved, multicast, or unspecified. Fails closed on DNS resolution failure.
- **DNS-rebinding (TOCTOU) fix, documented as incident AR-42**: earlier code validated a URL once via `validate_public_url()`, then let the HTTP client (aiohttp) perform its *own separate* DNS resolution at connect time — an attacker-controlled DNS server could return a public IP at validation time and a private/metadata IP microseconds later at connect time. Fixed via `_resolve_pinned_public_ip()` + a custom `_PinnedResolver` that forces the actual TCP connection to the exact IP validated, for every redirect hop.
- **TLS verification is real**, not disabled for the pinned-IP trick: `_PinnedResolver` reports the true hostname alongside the pinned IP so SNI and certificate validation still check against the URL's hostname. A docstring explicitly calls out that pinning alone ("WHERE we connect") is independent of and does not substitute for TLS verification ("WHETHER the thing that answered is who the URL said it would be").
- **Redirects are manually followed and re-validated at every hop** (`fetch_text_safely`, `max_redirects=3`) rather than letting the HTTP client auto-follow — closes a redirect-to-internal bypass (documented as findings F07/F11 in the code's own audit references).
- **Response-size caps** (`DEFAULT_MAX_BYTES = 5 MiB`) enforced by streaming and aborting, not by buffering the whole body first (documented as finding F25 — a prior favicon fetcher bug buffered the entire body before checking size, making it unbounded in memory/time for a slow multi-gigabyte response).
- `fetch_bytes_safely()` — the binary-body variant used for favicons/images — **rejects** oversized bodies rather than truncating them, on the stated principle that "a truncated PNG is either undecodable or, worse, decodes to something the caller then stores."

### 5.3 Widget shadow-root isolation
Confirmed in `widget/src/app-entry.jsx`: the widget calls `container.attachShadow({ mode: 'open' })` and renders its entire React tree, plus its own `<link>` stylesheet, inside that shadow root under `#oyechats-shadow-inner`. **[T1]** This is what makes the widget collision-proof against arbitrary host-page CSS/JS, and — per root `CLAUDE.md` — is also why the "Powered by OyeChats" attribution link has to live as a plain `<a>` in the customer's *served HTML* rather than inside the widget's shadow DOM: the widget only mounts after a visitor clicks the launcher, so an in-widget badge is invisible to non-JS-executing crawlers, and the shadow root additionally hides it from any crawler that does run JS but doesn't pierce shadow DOM. **[T1/T2]**

### 5.4 Other confirmed defenses (from `docs/oyechats-technical-story.md`, Part 16, cross-referenced against code above)
- Tenant isolation via scoped queries on every lookup (defense in depth beyond the identifier alone).
- Prompt-injection screening on incoming visitor messages before generation.
- Bidirectional prompt-leak guards (sanitize on the way in; monitor and truncate the outbound stream if it starts reproducing the system prompt).
- Rate limiting bucketed on bot+visitor-address together — the story explicitly notes this depends on the real source address being non-spoofable, i.e., on all traffic transiting the edge/proxy correctly, calling this "a deployment invariant, not just a code property." **[T2]**
- Upload credentials scoped to a session the requester owns, server-enforced size ceiling, pinned content-type.
- Signed and time-bounded tokens for unsubscribe links, OAuth state, and impersonation tokens.
- Webhook idempotency: inbound events signature-verified and deduplicated by identity before processing.

---

## 6. Real-Time Systems

### 6.1 WebSocket live chat
`api/app/api/ws_routes.py` implements the bidirectional live-chat protocol. **[T1/T2]** Confirmed feature set from the technical narrative: messages/acks, typing indicators (both directions), read receipts, file transfer, operator-joined announcements, queue position updates, availability changes, visitor disconnect/reconnect, transfer notices, close notices, connect-request resolution, and heartbeats to keep the connection alive.

### 6.2 Session state machine
Every `ChatSession.status` is one of exactly four values — `bot`, `waiting`, `live`, `closed` — confirmed as the enum in `models.py`. Legal transitions (per the technical narrative, consistent with the audit-log table `chat_audit_logs` existing specifically to record them):
```
bot     → waiting   (visitor requests a human)
waiting → live      (operator accepts)
waiting → bot       (visitor cancels / wait times out / no operator available)
waiting → closed    (visitor leaves the queue)
live    → bot       (operator hands back to AI)
live    → closed    (conversation ends)
live    → waiting   (transfer to another operator/department)
closed  = terminal
```
Transitions are enforced centrally with row-level locking and a compare-and-swap guard; a failed CAS fails loudly rather than silently no-op-ing, because callers key real side effects (notifications, assignment) off the transition's success. **[T2]**

### 6.3 Routing — the module exists; nothing calls it
`live_chat_routing_service.py` implements three selectable strategies (**least-busy** default, **round-robin**, **first-available**) as a pure decision function: it selects and does nothing else, leaving assignment and notification to the caller. That description, taken from the module's own docstring, is what earlier revisions of this document reported. **[T2]**

It is dead code. `select_operator` (`api/app/services/live_chat_routing_service.py:85`) is the module's only entry point and has **no caller anywhere in `api/`** — a grep across the service and route layers returns the definition and its unit tests, nothing else. `Bot.live_chat_routing_strategy` is persisted and settable but read by nobody, so changing it has no effect. **[T1]**

What actually happens: `request_handoff` (`api/app/services/live_chat_service.py:885`) queues the session and fans a queue update out to every eligible operator (local sockets unioned with Redis presence, department-scoped where set), plus Web Push to each subscribed device. The first operator to accept wins under a race-safe lock. Assignment is **operator-pull, first-click-wins** — there is no server-side selection step. The admin dashboard documents the same conclusion in `app/src/features/agents/advanced/behaviour.config.ts:472-491`, which is why that settings page deliberately ships no control for the strategy. **[T1]**

### 6.4 ARQ background worker architecture
Runs as `oyechats-worker.service` on Redis. **[T1/T2]** Confirmed job entry point: `api/app/worker/tasks.py`. The worker executes both triggered jobs (crawl, ingestion, webhook delivery, push dispatch, email send) and clock-driven jobs. Confirmed clock schedule from the technical narrative (Part 12):

| Cadence | Job(s) |
|---|---|
| Every 30s | Retry pending outbound webhooks; emit worker heartbeat |
| Just after midnight | Billing train, strict order: execute pending cancellations → renew due subscriptions → grant promotional free-month credits → promote scheduled downgrades → expire old top-ups → expire past-due subscriptions → prune stale events → delete expired trial data |
| Every 15 min | Expire trials that have run out |
| Hourly, a few minutes past | Sweep bots whose auto-recrawl is due |
| Every 5 min | Render/upload/email newly finalized invoices |
| ~1 AM | Invoice anomaly sweep, then orphaned seat-add-on sweep |
| ~2 AM | Full gateway reconciliation (deliberately last, after everything else settles) |
| Mid-morning (customer-base working hours) | Trial reminders, promo pre-charge reminders, dunning cadence |
| Weekly, quiet hours | Prune processed-webhook records past retry horizon |

A local-dev-specific operational note (also recorded in prior project memory, `local-dev-runtime.md`): the ARQ worker must run with `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` set **directly on the python binary** (macOS SIP strips `DYLD_*` across `nohup`/`env`), or WeasyPrint cannot find Homebrew's pango library and invoice PDFs silently never render. Exactly one worker instance should run locally — duplicates race for the same Redis queue.

---

## 7. Billing Architecture

### 7.1 Credit ledger as event sourcing
Confirmed via the `CreditLedger` model (`credit_ledger` table) and the FIFO self-referencing `grant_id` foreign key. **[T1]** The design principle, per the technical narrative: credits are not a mutable counter column — every grant, deduction, refund, and expiry is a **separate immutable, signed row**; the balance is the sum. This is why the balance at any historical point is reconstructible and every movement is individually explainable — a property a simple counter cannot provide (no way to answer "why is the balance what it is" after the fact, no per-grant remaining-balance tracking, no safe concurrent mutation without losing history).

Deduction priority order (documented, consistent with the `grant_id` FK design): plan credits first (use-it-or-lose-it, reset on renewal) → top-ups by earliest expiry (FIFO) → manual adjustments last. Every mutation takes a per-account advisory lock to prevent overselling under concurrent conversations. **[T2]**

### 7.2 Razorpay integration
Single payment rail, INR-only per root `CLAUDE.md`'s billing table. The USD rail is now confirmed rather than assumed: `INTL_PAYMENTS_ENABLED` defaults to `false` (`api/app/config.py:428`) and the charge paths refuse instead of charging while it is off — top-up 409s `intl_usd_pending`, checkout 409s unless the flag puts it on the USD rail (`GET /subscriptions/geo` docstring, `api/app/api/subscription_routes.py:554`). USD is therefore **display-only**: a non-Indian customer is shown USD, and no INR debit can contradict it because no debit happens at all. **[T1]** Recurring payment is mandate-based (Razorpay's UPI/eMandate model), which per prior project memory constrains plan-change mechanics — the Update Subscription API is blocked for UPI/eMandate subscriptions, so plan changes go through cancel+recreate+re-authorization rather than an in-place update. `api/app/services/razorpay_service.py` is the confirmed integration module. **[T1/T2]**

### 7.3 Webhook idempotency (inbound, from Razorpay)
Confirmed via the `processed_webhooks` / `failed_webhooks` tables: every inbound gateway event is signature-verified and recorded by identity before processing, so replayed or duplicated events cannot double-grant credits or double-issue invoices. Events that fail processing are dead-lettered to `failed_webhooks` rather than dropped, and can be replayed manually from the control tower. Signature-verification failures are counted and alerted on. **[T1/T2]**

### 7.4 Reconciliation
A daily job (~2 AM, deliberately scheduled after the entire midnight billing train and invoice pipeline have settled) diffs Razorpay's view of captured payments against the platform's own invoice/credit-grant records. It is explicitly **report-only** — it proves the books rather than silently rewriting them. **[T2]**

### 7.5 Invoicing
Per-financial-year invoice numbering via the dedicated `invoice_counters` table; finalization is idempotent (an already-numbered invoice is never re-numbered) and finalized invoices are immutable — corrections are issued as credit notes, never edits. **[T2]**

---

## 8. Deployment & Infrastructure

Everything in this section is taken directly from root `CLAUDE.md`'s "Production Access" and "Development Commands" sections. **[T2]**

- **API server**: single DigitalOcean droplet (`root@159.223.45.213`, hostname `oyechats-api`, KVM-based).
- **Services on the box**: `oyechats-api.service` (Gunicorn, bound to `127.0.0.1:8000`), `oyechats-worker.service` (ARQ), `postgresql@16-main`, `nginx` (ports 80/443, terminates TLS and reverse-proxies to Gunicorn).
- **Health endpoints**: `GET /health`, `GET /health/live`, `GET /health/full`, all bound locally on `127.0.0.1:8000` (not directly internet-exposed — reached through nginx).
- **CDN**: Cloudflare R2 serves both the widget bundle (`cdn.oyechats.com/oyechats-widget.js`) and file storage.
- **CI/CD**: GitHub Actions — three named workflows confirmed: `ci.yml`, `deploy-api.yml`, `deploy-widget.yml`. Deployment triggers, staging environments, and rollback mechanics are **not detailed in the reviewed docs — [VERIFY]**.
- **Git workflow constraint** (process, not infra, but deployment-relevant): all development happens on a `development` branch; `main` is production and is only updated via GitHub PR merge, never direct push.
- **Production runtime has no conda environment** — it runs Python 3.11 with `uv`-managed dependencies directly under systemd. Conda (`oye` env) is a local-development-only convenience for isolating Python from system Python.
- **Database migrations**: Alembic (`uv run alembic upgrade head`).

Not confirmed / not present in the reviewed documentation: horizontal scaling story (single droplet implied but not stated as a permanent architecture decision), staging environment existence, load balancer, database read replicas, backup restore-testing cadence (a backup *script* — `api/scripts/backup.sh` — exists per the Key Files table, but its schedule/retention/restore-test policy is **[VERIFY]**).

---

## 9. Known Architectural Decisions & Trade-offs

Each of the following is drawn from an actual code comment, docstring, or explicit rationale encountered during this review — not inferred.

**Widget ships as a script tag, not an npm package — and the script tag is a loader, not the app.** The design goal stated in root `CLAUDE.md` is "works on any platform... anything with a `<body>` tag," matching the embed model of Intercom/Crisp/Drift rather than a framework-specific component library. The refinement worth stating precisely: the customer-facing file ships on *every page view of every customer site*, so it is kept to a loader budgeted at 8 KB gzipped, and the React app (its own bundled runtime included) is a code-split ESM import that only downloads when the widget is actually needed. The eager path — loader + entry + vendor — is budgeted at roughly 90 KB gzipped, and each further surface is its own lazy chunk. Enforced in CI by `npm run size`. **[T1 — `widget/package.json` `size-limit`]**

**Brand-color extraction needs a second, raw-HTML fetch — separate from the markdown-based crawl.** Directly from `brand_color_extractor.py`'s docstring: the crawl providers (Spider, Jina) return page bodies as **markdown**, which strips CSS and inline styles — the only signal available for a customer's palette. The module therefore performs one additional raw-HTML GET of the seed URL specifically to parse `<style>` blocks, inline `style=""`, `<meta name="theme-color">`, and SVG fill/stroke attributes. It is explicitly kept "cheap and deterministic: no LLM, no headless browser, one HTTP GET." **[T1]**

**No cross-model fallback for embeddings, unlike generation.** `embedder.py`'s docstring is explicit: LLM generation has a primary+fallback model pair, but embeddings deliberately do not — "mixing embedding models corrupts vector search" because two models would place the same semantic content at different vector-space coordinates, silently corrupting every future similarity search rather than failing loudly. On persistent failure the ingestion job **raises and retries** rather than substituting a different model. **[T1]**

**Credit ledger is event-sourced rather than a mutable counter.** Per the `credit_ledger` table design (append-only rows + self-referencing `grant_id` FK for FIFO top-up expiry) and the narrative rationale: a simple counter cannot explain *why* a balance is what it is after the fact, cannot support strict-priority multi-bucket deduction (plan credits → top-ups by expiry → manual adjustments) without losing the audit trail, and is harder to make safely concurrent. **[T1/T2]**

**SSRF defenses were iteratively hardened against a specific documented incident class (AR-42).** The `ssrf.py` docstring names this explicitly: an earlier version validated a URL once, then let aiohttp re-resolve DNS independently at connect time, opening a rebinding TOCTOU window. The fix — resolve once, pin the connection to that exact IP via a custom resolver — mirrors a pattern the outbound-webhook service (`webhook_service.py`) had already adopted, i.e., the SSRF hardening was propagated from one code path to another rather than invented fresh each time. **[T1]**

**Response-style formatting rules are isolated into their own prompt layer, deliberately kept under a strict token budget.** `response_style.py`'s docstring gives an explicit engineering rationale: style rules are "orthogonal to the business context — every bot benefits from the same formatting discipline regardless of industry, language, or vertical," and the file caps itself under ~1000 tokens on the stated belief that "models follow specific rules better than long ones" and that additional length "starts hitting diminishing returns and competes for attention with the upstream layers." **[T1]**

**Relevance gate and reranker are additive safety nets that degrade to a safe default, never a hard dependency.** Both are optional (env-flagged) and, on failure, fall back rather than error: the reranker falls back to original fusion order silently; the embedding query path falls back to keyword-only search if the meaning-embedding service is unavailable. This "graceful degradation over hard failure" pattern recurs across the codebase (also documented for presence-cache, routing-cursor, and company-lookup failures in the technical narrative). **[T1/T2]**

---

## 10. Evidence & Open [VERIFY] Items

### Spot-checks performed for this document (files read directly, not taken on faith from prior docs)
- `api/app/services/rag_service.py` (6,606 lines) — hybrid search, RRF, CAG-lite, query rewriting/caching, relevance gate wiring, structured events, groundedness check.
- `api/app/db/models.py` — full table inventory via `__tablename__` grep: **51 tables**. This replaces both the earlier "~38 mapped classes" estimate in this document and the "25 tables" summary figure; root `CLAUDE.md` now carries 51 too.
- `api/app/api/auth.py` (1,646 lines) — all four header constants, all `get_current_*` dependency docstrings, the `X-Workspace-Id`/`X-Impersonation-Token` mechanisms.
- `api/app/core/ssrf.py` (417 lines) — full read; SSRF guard, DNS-rebinding fix (AR-42), TLS verification pinning.
- `api/app/services/brand_color_extractor.py` — module docstring confirming the markdown-strips-CSS rationale.
- `api/app/services/response_style.py` — module docstring confirming the 7-layer prompt structure verbatim.
- `api/app/ingestion/embedder.py` — module docstring confirming embedding model, dimensionality, normalization, no-fallback policy.
- `widget/src/app-entry.jsx` — confirmed shadow-root attachment and render target.
- `api/app/config.py` — confirmed `CAG_LITE_THRESHOLD` default (20).

### Open [VERIFY] items — not confirmed in this review
- ~~**USD billing rail**~~ — **closed.** Confirmed in code: `INTL_PAYMENTS_ENABLED` defaults `false` (`api/app/config.py:428`); the USD rail exists, is display-only, and every USD charge path 409s while the flag is off (`api/app/api/subscription_routes.py:554`). INR/Razorpay is the sole live rail. **[T1]**
- **CI/CD pipeline internals**: the three GitHub Actions workflow filenames (`ci.yml`, `deploy-api.yml`, `deploy-widget.yml`) are confirmed to exist by name in root `CLAUDE.md`, but their trigger conditions, staging/rollback mechanics, and test-gating rules were not read in this pass — **[VERIFY]**.
- **Horizontal scaling / high availability**: only a single droplet and single Postgres instance are documented. Whether there is a standby database, load balancer, or multi-region plan is **[VERIFY]** — not stated as present or absent in the reviewed docs.
- **Backup restore-testing**: a backup script exists (`api/scripts/backup.sh`) but its cadence, retention window, and whether restores are periodically tested were not confirmed — **[VERIFY]**.
- **Reranker model identity**: root `CLAUDE.md` names FlashRank as the cross-encoder reranker; this document did not open `api/app/services/reranker.py` to independently confirm model choice or version — treat as **[T2]**, not **[T1]**.
- ~~**Exact current table count**~~ — **closed.** `grep -c __tablename__ api/app/db/models.py` returns **51**. **[T1]**
