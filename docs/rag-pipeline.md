# RAG Pipeline & Document Ingestion

This document covers OyeChat's Retrieval-Augmented Generation pipeline — from document upload through to LLM response generation.

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
│  Question → Hybrid Search → Context Build → LLM → Stream Back  │
│              (vector + keyword)  (+ history)   (+ BANT)         │
└─────────────────────────────────────────────────────────────────┘
```

## Document Ingestion

### Entry Points

Documents enter the system through two routes:

1. **File Upload** — `POST /upload` accepts PDF, DOCX, and TXT files
2. **Web Crawl** — `POST /crawl` uses Playwright to scrape a website

Both converge on the same core ingestion function: `_ingest_document()` in `api/app/ingestion/pipeline.py`.

### Step 1: Extraction

File type handlers in `api/app/ingestion/extraction.py`:

| Format | Handler | Output |
|--------|---------|--------|
| PDF | `load_pdf()` via pypdf | Text + page-level metadata |
| DOCX | `load_docx()` via python-docx | Text + section headers |
| TXT/MD | `load_txt()` | Plain text |

Web-crawled pages arrive as pre-extracted text from Playwright's `page.inner_text()`.

### Step 2: Cleaning

The `cleaner.py` module normalizes extracted text by removing excessive whitespace, fixing encoding issues, and stripping boilerplate noise.

### Step 3: Deduplication

A SHA-256 hash is computed over the cleaned text. If a document with the same `file_hash` already exists for the bot, ingestion is skipped. This prevents re-processing identical uploads.

### Step 4: Chunking

Text is split into semantic chunks using recursive character splitting from `langchain-text-splitters`.

**Default parameters** (configurable via environment variables):

| Parameter | Default | Env Variable |
|-----------|---------|-------------|
| Chunk size | 2,000 characters | `CHUNK_SIZE` |
| Chunk overlap | 300 characters | `CHUNK_OVERLAP` |

Each chunk retains metadata from extraction: page numbers, section headers, and source document name. The chunking logic lives in `api/app/ingestion/chunking.py`.

### Step 5: Embedding

Chunks are embedded using OpenAI's `text-embedding-3-small` model, producing 1536-dimensional vectors.

**Implementation details** (`api/app/ingestion/embedder.py`):
- Batch processing: up to 512 chunks per API call
- Async wrapper available: `embed_chunks_async()` for non-blocking operation
- Model is configured via `EMBEDDING_MODEL` in config

### Step 6: Storage

Each chunk is stored as a `Document` row in PostgreSQL with:
- `content` — the text chunk
- `embedding` — 1536-dim vector (pgvector `Vector(1536)` column)
- `search_vector` — PostgreSQL TSVECTOR for full-text keyword search
- `metadata_info` — JSONB with page numbers, section, source URL
- `file_hash` — SHA-256 for deduplication
- `bot_id` — links the chunk to its owner bot

### Web Crawling

The crawler (`api/app/services/crawler_service.py`) uses Playwright with Chromium:

| Setting | Value |
|---------|-------|
| Max pages | 50 |
| Max depth | 3 |
| Concurrency | 5 |
| Page timeout | 20 seconds |
| robots.txt | Respected |

Each crawled page is processed as a separate "document" through the ingestion pipeline.

## Query Pipeline

When a visitor sends a message, the RAG pipeline in `api/app/services/rag_service.py` executes:

### Step 1: Hybrid Search

OyeChat uses Reciprocal Rank Fusion (RRF) to combine two search strategies:

**Vector Search:**
- Embeds the user's question using the same `text-embedding-3-small` model
- Performs approximate nearest neighbor search over the bot's document embeddings
- Returns the top N most semantically similar chunks

**Keyword Search:**
- Converts the question into a tsquery
- Searches the `search_vector` (TSVECTOR) column using PostgreSQL full-text search
- Returns the top N lexically matching chunks

**Fusion:**
The `reciprocal_rank_fusion()` function merges both result sets, assigning a combined score that balances semantic relevance with keyword precision. This hybrid approach captures both meaning-based and exact-match results.

### Step 2: Context Assembly

The `build_hybrid_prompt()` function constructs the final LLM prompt:

1. **System Prompt** — the bot's custom system prompt (set in admin dashboard)
2. **Retrieved Context** — top chunks from hybrid search, formatted with source attribution
3. **Chat History** — recent messages from the session for conversational continuity
4. **BANT Instructions** — if BANT is enabled, subtle qualification prompts are woven in

### Step 3: LLM Generation

The assembled prompt is sent to the LLM via LiteLLM (`api/app/services/llm_service.py`):

- **Default Model:** Configured via `LLM_MODEL` env var (e.g., `openai/gpt-5-mini`)
- **Streaming:** `generate_response_stream()` yields text chunks for SSE
- **Non-streaming:** `generate_response()` returns the complete response
- **Tracing:** Every call is auto-instrumented by Langfuse via LiteLLM callbacks

### Step 4: BANT Extraction (Background)

If the bot has `bant_enabled = true`, a fire-and-forget task analyzes the conversation for sales qualification signals:

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
| `LLM_MODEL` | `openai/gpt-5-mini` | LiteLLM model identifier |
| `OPENAI_API_KEY` | — | Required for embeddings and OpenAI LLMs |
| `CHUNK_SIZE` | `2000` | Characters per chunk |
| `CHUNK_OVERLAP` | `300` | Overlap between adjacent chunks |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | OpenAI embedding model |

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
| BANT service | `api/app/services/sdr_service.py` |
| Web crawler | `api/app/services/crawler_service.py` |
| Document DB queries | `api/app/db/repository.py` |
