# RAG Pipeline & Document Ingestion

This document covers OyeChats' Retrieval-Augmented Generation pipeline — from document upload through to LLM response generation.

## Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     DOCUMENT INGESTION                          │
│                                                                 │
│  Upload/Crawl → Extract → Clean → Hash → Chunk → Embed → Store │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      QUERY PIPELINE                             │
│                                                                 │
│  Question → CAG-lite? → Hybrid Search → Gate → Rerank →        │
│             Context Build → LLM → Stream Back → Groundedness    │
│             (vector + keyword)   (+ history)    (audit only)    │
└─────────────────────────────────────────────────────────────────┘
```

## Document Ingestion

### Entry Points

Documents enter the system through two routes:

1. **File Upload** — `POST /ingest` accepts PDF, DOCX, TXT and MD files (multi-file, credit-metered per file)
2. **Web Crawl** — `POST /crawl` fetches a website over HTTP through Jina Reader / Spider.cloud

Both converge on the same core ingestion function: `_ingest_document()` in `api/app/ingestion/pipeline.py`.

### Step 1: Extraction

File type handlers in `api/app/ingestion/extraction.py`:

| Format | Handler | Output |
|--------|---------|--------|
| PDF | `load_pdf()` via pypdf | Text + page-level metadata |
| DOCX | `load_docx()` via python-docx | Text + section headers |
| TXT/MD | `load_txt()` | Plain text |

Web-crawled pages arrive as pre-extracted markdown/text from the crawl provider (Jina Reader or Spider.cloud). Nothing in the API drives a local browser.

### Step 2: Cleaning

The `cleaner.py` module normalizes extracted text by removing excessive whitespace, fixing encoding issues, and stripping boilerplate noise.

### Step 3: Deduplication

A SHA-256 hash is computed over the cleaned text after `_normalize_for_dedup_hash()` (which strips volatile detail such as dates). If a document with the same `file_hash` already exists for the bot, ingestion is skipped. This prevents re-processing identical uploads.

On the **crawl** path the match is scoped to `(owner, document_name)` rather than bot-wide. Bot-wide matching collided two pages that differed only by a date — on a templated events site only the first page was ever ingested, and the crawl still reported success. The upload path is unchanged.

### Step 4: Chunking

Text is split into semantic chunks using recursive character splitting from `langchain-text-splitters`.

**Default parameters** (configurable via environment variables):

| Parameter | Default | Env Variable |
|-----------|---------|-------------|
| Chunk size | 1,000 characters | `CHUNK_SIZE` |
| Chunk overlap | 200 characters | `CHUNK_OVERLAP` |

The env values are only the fallback. `chunking.py` reads `runtime_config.get_chunk_size()` / `get_chunk_overlap()` on every call, which resolve the super-admin-tunable `pricing_config` keys `rag.chunk_size` / `rag.chunk_overlap` first.

Each chunk retains metadata from extraction: page numbers, section headers, and source document name. The chunking logic lives in `api/app/ingestion/chunking.py`.

### Step 5: Embedding

Chunks are embedded using Google's `gemini-embedding-001` via the `batchEmbedContents` REST API, producing **768-dimensional** vectors (Matryoshka-truncated from the model's native width, then L2-normalized client-side).

**Implementation details** (`api/app/ingestion/embedder.py` → `api/app/services/gemini_embedding.py`):
- Batch processing: up to **100** texts per call (`_MAX_BATCH`, the `batchEmbedContents` hard limit)
- Batches run concurrently, bounded by `EMBED_CONCURRENCY` (default 8)
- Async wrapper available: `embed_chunks_async()` for non-blocking operation
- Model and width are configured via `GEMINI_EMBED_MODEL` and `EMBED_DIMENSIONS`; credentials come from `GOOGLE_API_KEY`
- There is **no local model and no cross-model fallback** — mixing embedding models corrupts vector search

> Gemini counts quota **per content item, not per HTTP call**, so batching saves round-trips rather than quota. Sustained throughput is capped by `EMBED_RPM_LIMIT` (default 2850).

### Step 6: Storage

Each chunk is stored as a `Document` row in PostgreSQL with:
- `content` — the text chunk
- `embedding` — 768-dim vector (pgvector `Vector(768)` column, `NOT NULL`)
- `search_vector` — PostgreSQL TSVECTOR for full-text keyword search
- `metadata_info` — JSONB with page numbers, section, source URL
- `file_hash` — SHA-256 for deduplication
- `bot_id` — links the chunk to its owner bot

### Web Crawling

Crawling is **HTTP-only — nothing drives Chromium.** Two hosted providers do the fetching, orchestrated by `crawl_orchestrator.run_full_crawl`:

| Concern | Where it lives |
|---|---|
| URL discovery (sitemap-first) | `api/app/services/url_discovery.py` |
| Provider selection + fallback | `api/app/services/crawl_provider.py` |
| Jina Reader fetch | `api/app/services/jina_service.py` |
| Spider.cloud fetch | `api/app/services/spider_service.py` |
| Progress, locks, cancellation (Redis) | `api/app/services/crawler_service.py` |

`CRAWL_PROVIDER_PRIMARY` decides which one is tried first and defaults to **`jina`**; the other becomes the fallback. The super-admin Models & RAG page overrides it at runtime via `pricing_config` (`crawl.provider_primary`).

Each crawled page is processed as a separate "document" through the ingestion pipeline. Pages are ingested in **waves as they arrive** (`CRAWL_INGEST_WAVE_PAGES`, default 25) rather than after the whole crawl finishes, so a large site becomes answerable within minutes.

**The binding cap is characters, not pages** (the plan's knowledge quota). A crawl that hits the quota stops early, and `result_payload` carries `pages_ingested`, `pages_failed`, `aborted` and `abort_reason` so the dashboard can say how many pages were actually indexed rather than how many were fetched.

## Query Pipeline

When a visitor sends a message, the RAG pipeline in `api/app/services/rag_service.py` executes:

### Step 0: CAG-lite — skip retrieval entirely for small bots

Before any search runs, the pipeline counts the bot's active chunks. If that count is at or below `CAG_LITE_THRESHOLD` (default **20**) it **skips retrieval altogether** and injects every chunk into the prompt. Retrieval over twenty chunks costs more than it recovers, and a brand-new bot is the case most likely to be embarrassed by a bad top-k. Set `CAG_LITE_THRESHOLD=0` to disable.

Everything from Step 1 to Step 1c below applies only to bots *above* the threshold.

### Step 1: Hybrid Search

OyeChats uses Reciprocal Rank Fusion (RRF) to combine two search strategies. Retrieval depth is a flat `k=15` on both the streaming and non-streaming paths — deliberately flat rather than adaptive, because cost predictability beats marginal recall.

**Vector Search:**
- Embeds the user's question using the same `gemini-embedding-001` model, at the same 768 dimensions
- Exact (not approximate) nearest-neighbour scan filtered by `bot_id` — see the tenancy note below
- Returns the top N most semantically similar chunks

**Keyword Search:**
- Converts the question into a tsquery
- Searches the `search_vector` (TSVECTOR) column using PostgreSQL full-text search
- Returns the top N lexically matching chunks

> **The keyword arm is pinned to the `'english'` text-search configuration** (`repository.py` — `to_tsvector('english', …)` at index time, `plainto_tsquery('english', …)` at query time). `plainto_tsquery` ANDs together every lexeme it extracts, so a non-English question — pure-script or code-switched alike — contributes near-zero hits against an English knowledge base. **Non-English conversations are effectively vector-only.** This is measured, not assumed: see `api/tests/test_cross_lingual_retrieval.py`. The English-tuned reranker and intent router are bypassed for the same reason, and the vector arm's distance ceiling is relaxed to `CROSS_LINGUAL_MAX_DISTANCE`.

**Fusion:**
The `reciprocal_rank_fusion()` function merges both result sets, rewarding passages that *both* methods ranked highly rather than concatenating two lists. If fusion returns nothing, a multi-query fallback rephrases the question several ways and retries. If the embedding service is unavailable the pipeline degrades to keyword-only rather than failing.

### Step 1b: Relevance gate (CRAG)

`RELEVANCE_GATE_ENABLED` — **default `true`**. A cheap LLM judge (`runtime_config.get_gate_model()`, Gemini Flash tier) scores the retrieved passages against the question. If *every* passage scores below threshold the gate fires and the pipeline **refuses to generate from irrelevant material**, returning a pivot instead. This is the control behind the product's "answers only from your knowledge base" guarantee.

> The module treats an **empty** `RELEVANCE_GATE_ENABLED=` as unset and falls back to the `true` default. This is load-bearing: `deploy-api.yml` once wrote the key unconditionally, systemd's `EnvironmentFile=` set it to `""`, and the gate ran disabled in production with nothing but the code's default suggesting otherwise (fixed in `ad7944a`).

Bypassed for non-English conversations — it is an English-tuned judge.

### Step 1c: Reranking (optional)

`RERANK_ENABLED` — **default `false`**. A FlashRank cross-encoder reorders the surviving passages. It is called with `top_n=_retrieval_k` rather than its own `RERANK_TOP_N=5` default, so list/count questions keep their full candidate set. It fails silently back to the fusion order, so it can never block an answer. Also bypassed for non-English.

### Step 2: Context Assembly

The prompt builder constructs the final LLM prompt in a **deliberate layer order**:

1. **Identity** — who this bot is and which company it represents
2. **The customer's own system prompt**, with a non-overridable clause. It sits **above** the SCOPE block: spliced in after the grounding rules (the position models weight most) a customer could switch grounding off in plain English. SCOPE's header reads "overrides everything above it and below it" for the same reason.
3. **Scope** — what the bot may and may not discuss
4. **Voice** — brand tone, free-typed or from a preset
5. **Response style** — length, formatting, one question per turn
6. **Retrieved context** — the surviving chunks with source attribution, wrapped in a `<<<DOCUMENT>>>` fence. Fence bytes are neutralised inside chunk content so crawled text cannot break out of data into prompt scaffolding.
7. **Date hints** and **structured events**, if the question looks date-shaped
8. **Media catalog** — a whitelist of the media that actually exists, so any card the model offers is real
9. **Chat history** — recent turns. Refused injection attempts are neutralised here rather than skipped at persistence time, which keeps the "the visitor question is always persisted" contract and the audit trail.
10. **Qualification instructions** — if the plan includes qualification and the bot has it enabled

### Step 3: LLM Generation

The assembled prompt is sent to the LLM via LiteLLM (`api/app/services/llm_service.py`):

- **Default Model:** Configured via `LLM_MODEL` env var (default: `openai/gpt-5.4-mini`), with automatic fallback to `gemini/gemini-2.5-flash`
- **Streaming:** `generate_response_stream()` yields text chunks for SSE
- **Non-streaming:** `generate_response()` returns the complete response
- **Tracing:** Every call is auto-instrumented by Langfuse via LiteLLM callbacks
- **Failure is signalled structurally, not by text.** The stream reports failure through an explicit status dict. Both the QA-cache write and the `generation_failed` refund key off that status, never off matching the answer text. Before this, every failure branch yielded an error *string*: `chunk_count` counted it, the cache guard passed, no refund ran, and a provider blip during "what are your prices?" served that error text to every later visitor asking the same question for an hour, with no LLM call (fixed in `0c6d04d`).
- **Cancellation is not loss.** `GeneratorExit` is a `BaseException`, so a bare `except Exception` missed a visitor closing the tab mid-stream and the transaction rolled back. The answer is persisted before the cancellation propagates.

### Step 3b: Groundedness check (observability only)

After the answer has already streamed, `groundedness_gate.check_groundedness()` runs fire-and-forget: an LLM judge rates whether the answer's claims are supported by the chunks it was generated from, and the verdict is logged as a `rag.metric` line.

**It is deliberately non-blocking and its verdict is discarded** — it never alters, refuses, or rewrites a delivered answer. Blocking on it would trade a bounded hallucination risk for a new one (a false-positive rewrite of a good answer) without the retry infrastructure to do that safely. Flags: `GROUNDEDNESS_CHECK_ENABLED` (default `true`), `GROUNDEDNESS_CHECK_SAMPLE_RATE` (default `1.0`), `GROUNDEDNESS_THRESHOLD` (default `0.5`). It judges **prose** answers only.

If you are looking for the control that actually *blocks* an ungrounded answer, that is the relevance gate in Step 1b, plus the empty-context refusal — not this.

### Step 4: BANT Extraction (Background)

If the bot has qualification enabled, a fire-and-forget task analyzes the conversation for sales qualification signals.

> **It is not an ARQ job.** It is dispatched with `core/thread_pool.submit_background` (`rag_service.py:7274`, `:8761`) onto a shared **3-thread-per-worker** pool. That makes it non-durable: a restart between the stream closing and the extraction finishing loses that turn's signals silently.

Dimensions scored:

- **Budget** — Has the visitor mentioned budget or pricing?
- **Authority** — Are they a decision-maker?
- **Need** — What problem are they trying to solve?
- **Timeline** — When do they need a solution?

BANT state is stored on the `ChatSession` and updated incrementally. When all four fields are populated, an email notification is triggered (if configured).

The BANT prompts are designed to be subtle — one question per turn, only when buying signals are detected, woven naturally into helpful answers.

### Step 5: Response Storage

After generation:
- A `ChatMessage` record is created with `role="bot"` and the Langfuse `trace_id`
- Source documents are included in the response metadata
- The session's `updated_at` timestamp is refreshed

## SSE Streaming Protocol

The streaming endpoint (`POST /chat/stream`) uses a custom SSE protocol:

```
METADATA:{"sources": ["pricing.pdf", "faq.txt"], "session_id": "sess_abc123"}
Here is information about our pricing...
We offer three tiers:
...
FINAL_METADATA:{"message_id": 456, "trace_id": "tr_xyz789"}
```

The widget's `sendMessageStream()` function in `widget/src/services/api.js` parses this stream, routing metadata to callbacks and text chunks to the UI renderer.

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `openai/gpt-5.4-mini` | LiteLLM model identifier (primary) |
| `OPENAI_API_KEY` | — | Required for the primary LLM. **Not** used for embeddings |
| `GOOGLE_API_KEY` | — | Required for embeddings, the Gemini LLM fallback, and both gate models |
| `CHUNK_SIZE` | `1000` | Characters per chunk (fallback; `pricing_config.rag.chunk_size` wins) |
| `CHUNK_OVERLAP` | `200` | Overlap between adjacent chunks (fallback; `pricing_config.rag.chunk_overlap` wins) |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Embedding model |
| `EMBED_DIMENSIONS` | `768` | Must match the `Vector(768)` column |
| `EMBED_CONCURRENCY` | `8` | Concurrent embed batches |
| `EMBED_RPM_LIMIT` | `2850` | Self-imposed request ceiling |
| `CAG_LITE_THRESHOLD` | `20` | Bots at or under this many chunks skip retrieval; `0` disables |
| `RELEVANCE_GATE_ENABLED` | `true` | CRAG relevance gate (blocking) |
| `RERANK_ENABLED` | `false` | FlashRank cross-encoder rerank |
| `GROUNDEDNESS_CHECK_ENABLED` | `true` | Post-answer groundedness audit (non-blocking) |
| `CRAWL_PROVIDER_PRIMARY` | `jina` | Which crawl provider is tried first; the other is the fallback |

## Key Files

| Purpose | Path |
|---------|------|
| Ingestion orchestrator | `api/app/ingestion/pipeline.py` |
| File extraction | `api/app/ingestion/extraction.py` |
| Text cleaning | `api/app/ingestion/cleaner.py` |
| Text chunking | `api/app/ingestion/chunking.py` |
| Embedding generation | `api/app/ingestion/embedder.py` |
| RAG query pipeline | `api/app/services/rag_service.py` |
| LLM service | `api/app/services/llm_service.py` |
| BANT service | `api/app/services/rag_service.py` (extraction) + `qualification_service.py` (frameworks) |
| Relevance gate (blocking) | `api/app/services/relevance_gate.py` |
| Groundedness gate (observability) | `api/app/services/groundedness_gate.py` |
| Reranker | `api/app/services/reranker.py` |
| Crawl orchestration | `api/app/services/crawl_orchestrator.py` |
| Crawl providers | `api/app/services/jina_service.py` · `spider_service.py` · `crawl_provider.py` |
| Crawl progress / locks (Redis) | `api/app/services/crawler_service.py` |
| Document DB queries | `api/app/db/repository.py` |
