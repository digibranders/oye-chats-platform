# Implementation Task: Migrate LLM from Gemini to GPT-5 Mini via LiteLLM SDK

## Background & Decisions Made

After a thorough research session comparing all major LLM providers, models, SDKs, and frameworks, the following decisions were finalized:

| Decision | Choice | Reason |
|----------|--------|--------|
| **LLM Model** | GPT-5 Mini (`openai/gpt-5-mini`) | 18% cheaper than current Gemini 2.5 Flash ($2.98 vs $3.63 per 1K turns), stronger reasoning for BANT qualification |
| **SDK** | LiteLLM (SDK only, NO proxy server) | Unified interface, future model switching by changing a string, built-in cost tracking, fallback routing, zero server overhead |
| **Observability** | Keep Langfuse (auto-integrated via LiteLLM callbacks) | LiteLLM auto-reports to Langfuse — delete manual observation wrappers |
| **Framework** | None (no LangChain/LangGraph needed) | Current custom RAG pipeline is clean and linear, framework would add complexity |
| **LangChain** | Keep `langchain-text-splitters` only | Only used for `RecursiveCharacterTextSplitter` in chunking — stable, small dependency |

## Pricing Reference

| Model | Input/1M tokens | Output/1M tokens | Cost per 1K chat turns |
|-------|----------------|------------------|----------------------|
| Gemini 2.5 Flash (current) | $0.30 | $2.50 | ~$3.63 |
| **GPT-5 Mini (target)** | **$0.25** | **$2.00** | **~$2.98** |
| Gemini 2.5 Flash-Lite (future fallback) | $0.10 | $0.40 | ~$0.97 |

## Current Architecture (What Exists Today)

The platform makes **3-4 LLM calls per chat turn**, all via `google-genai` SDK calling `gemini-2.5-flash`:

1. **Query rewriting** — rewrites follow-up questions into standalone search queries (`rag_service.py:rewrite_query()`)
2. **RAG response generation** — streaming response from retrieved context (`rag_service.py:rag_pipeline_stream()`)
3. **BANT extraction** — extracts sales qualification data from conversation (`rag_service.py:extract_bant_from_conversation()`)
4. **Intent detection** — detects sales intent in user queries (`intent_service.py:detect_sales_intent()`)
5. **SDR mode** — dedicated sales qualification flow with structured JSON output (`sdr_service.py`)

### Current LLM Features Used
- **Streaming** — `client.models.generate_content_stream()`
- **JSON structured output** — `response_mime_type: "application/json"` with `response_schema: SDRResponse` (Pydantic model) in `sdr_service.py:run_sdr_qualification()`
- **Langfuse manual wrappers** — `generate_response_observed()` and `generate_response_stream_observed()` in `llm_service.py` manually create Langfuse observation contexts
- **No function calling, no vision, no audio**

## Files That MUST Change

### 1. `api/app/config.py`
**Current:** Imports `GOOGLE_API_KEY`, sets `GEMINI_MODEL = "gemini-2.5-flash"`, validates Google API key
**Change to:** Import `OPENAI_API_KEY` from env, set `LLM_MODEL = "openai/gpt-5-mini"` (LiteLLM format), configure LiteLLM settings (Langfuse callback, optional fallback model). Remove Google API key config. Keep `GOOGLE_API_KEY` ONLY if it's used elsewhere (check crawler, etc.).

### 2. `api/app/services/llm_service.py` (MAJOR REWRITE)
**Current:** 178 lines. Uses `google.genai.Client` directly. Has 4 functions:
- `generate_response(prompt)` — non-streaming via `client.models.generate_content()`
- `generate_response_stream(prompt)` — streaming via `client.models.generate_content_stream()`
- `generate_response_observed(prompt)` — manual Langfuse wrapper around `generate_response()`
- `generate_response_stream_observed(prompt)` — manual Langfuse wrapper around `generate_response_stream()`

**Change to:** Replace with LiteLLM `completion()` and `completion()` with `stream=True`. The `_observed` wrappers can be **deleted entirely** because LiteLLM auto-reports to Langfuse via callback (`litellm.success_callback = ["langfuse"]`). The function signatures (`generate_response()`, `generate_response_stream()`) should stay the same so callers don't need changes, but internals switch to LiteLLM.

### 3. `api/app/services/sdr_service.py`
**Current:** Imports `google.genai` directly and creates its own client. Uses Gemini-specific structured output (`response_mime_type: "application/json"`, `response_schema: SDRResponse`).
**Change to:** Use LiteLLM `completion()` with OpenAI-style `response_format` for structured output. The `BANTState` and `SDRResponse` Pydantic models stay the same. Remove the direct `genai.Client` initialization. The `run_sdr_qualification()` function needs to switch from Gemini's `config={"response_mime_type": ..., "response_schema": ...}` to OpenAI's structured output format via LiteLLM.

### 4. `api/app/services/intent_service.py`
**Current:** Imports `google.genai` directly, creates its own client, has manual Langfuse observation wrapper.
**Change to:** Use the shared `generate_response()` from `llm_service.py` (which will use LiteLLM). Remove the direct `genai.Client`. Delete the manual Langfuse wrapper — LiteLLM handles it.

### 5. `api/app/core/langfuse_client.py`
**Current:** Provides `get_langfuse()` and `flush_langfuse()` utilities.
**Change to:** Simplify. LiteLLM's `litellm.success_callback = ["langfuse"]` handles automatic trace reporting. The `get_langfuse()` function is still needed for manual operations like `create_score()` (user feedback) in `chat_routes.py`. The `flush_langfuse()` is still needed for app shutdown. But the observation context managers used in `llm_service.py`, `intent_service.py`, and `rag_service.py` can be simplified or removed.

### 6. `api/app/services/rag_service.py`
**Current:** Uses `generate_response_observed()` and `generate_response_stream_observed()` from `llm_service.py`. Has manual Langfuse trace context for the full pipeline (`propagate_attributes`, `start_as_current_observation`).
**Change to:** Use the simplified `generate_response()` and `generate_response_stream()` (LiteLLM auto-traces via callback). The manual Langfuse pipeline trace wrapper (lines 347-368) can be simplified — LiteLLM will auto-trace each LLM call. Keep the `propagate_attributes` for session/user context if needed, but remove the manual observation spans.

### 7. `api/pyproject.toml`
**Current:** Has `google-genai>=1.0.0` as dependency.
**Change to:** Add `litellm==<pinned-version>` (pin exact version for supply chain safety). Remove `google-genai` dependency. Keep `langchain-text-splitters` and `langchain-core`.

### 8. `api/.env` / `api/.env.example`
**Current:** Has `GOOGLE_API_KEY=...`
**Change to:** Add `OPENAI_API_KEY=...`. Keep Langfuse env vars (they work automatically with LiteLLM's Langfuse callback). Remove `GOOGLE_API_KEY` if no longer used anywhere.

## Files That Should NOT Change

- `api/app/services/rag_service.py` — Pipeline logic stays the same, only the LLM call functions it imports change
- `api/app/ingestion/chunking.py` — Keep LangChain text splitter as-is
- `api/app/ingestion/embedder.py` — Keep FastEmbed as-is (embeddings are separate from LLM)
- `api/app/ingestion/pipeline.py` — No LLM calls here
- `api/app/db/models.py` — No changes needed
- `api/app/db/repository.py` — No changes needed
- `api/app/api/chat_routes.py` — Only change if `llm_service` function signatures change (they shouldn't)
- `widget/` — No changes needed
- `admin/` — No changes needed

## Key Implementation Details

### LiteLLM Setup (in config.py or llm_service.py)
```python
import litellm

# Model config
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-5-mini")

# Auto-report all LLM calls to Langfuse (reads LANGFUSE_* env vars automatically)
litellm.success_callback = ["langfuse"]
litellm.failure_callback = ["langfuse"]

# Optional: fallback model if OpenAI is down
# litellm.fallbacks = [{"openai/gpt-5-mini": ["gemini/gemini-2.5-flash"]}]
```

### LiteLLM Completion (replacing generate_response)
```python
from litellm import completion

def generate_response(prompt: str) -> str:
    response = completion(
        model=LLM_MODEL,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.choices[0].message.content
```

### LiteLLM Streaming (replacing generate_response_stream)
```python
def generate_response_stream(prompt: str):
    response = completion(
        model=LLM_MODEL,
        messages=[{"role": "user", "content": prompt}],
        stream=True,
    )
    for chunk in response:
        content = chunk.choices[0].delta.content
        if content:
            yield content
```

### LiteLLM Structured Output (replacing Gemini's response_schema in sdr_service.py)
```python
from litellm import completion

response = completion(
    model=LLM_MODEL,
    messages=[{"role": "user", "content": prompt}],
    response_format=SDRResponse,  # Pydantic model — OpenAI Structured Outputs
)
```

### Langfuse User Feedback (stays the same)
The `chat_routes.py` feedback endpoint still uses `get_langfuse()` → `lf.create_score()`. This doesn't change because it's not an LLM call — it's a scoring API call to Langfuse.

## What Gets Deleted

1. **`generate_response_observed()`** in `llm_service.py` — LiteLLM auto-traces
2. **`generate_response_stream_observed()`** in `llm_service.py` — LiteLLM auto-traces
3. **Manual Langfuse observation contexts** in `rag_service.py` (the `start_as_current_observation` wrappers around LLM calls)
4. **Manual Langfuse observation contexts** in `intent_service.py`
5. **Direct `genai.Client` initialization** in `sdr_service.py` and `intent_service.py`
6. **`google-genai` dependency** from `pyproject.toml`

## What Gets Simplified

1. **`llm_service.py`** — from 178 lines to ~40 lines (just `generate_response` and `generate_response_stream` using LiteLLM)
2. **`intent_service.py`** — remove direct SDK usage, use shared `generate_response()`
3. **`rag_service.py`** — remove manual Langfuse pipeline trace wrappers, calls remain the same
4. **`langfuse_client.py`** — keep only `get_langfuse()` (for feedback scoring) and `flush_langfuse()`

## Langfuse Review (Senior Engineer Audit)

As part of this migration, act as a **senior software engineer** and perform a thorough review of the existing Langfuse observability implementation across the entire codebase. Evaluate the current integration for:

1. **Correctness** — Are traces, spans, and generations being created properly? Are there orphaned traces or missing parent-child relationships?
2. **Completeness** — Are all LLM calls being traced? Are there any calls that bypass observability? Is token usage being captured accurately?
3. **Trace structure** — Should the RAG pipeline (query rewrite → retrieval → generation → BANT extraction) be grouped under a single parent trace? Is the current nesting correct?
4. **Metadata quality** — Is the right metadata being attached to traces (bot_id, session_id, user_id, device, location, chunk count, TTFT, latency)?
5. **Feedback scoring** — Is the user feedback (thumbs up/down) → Langfuse score pipeline working correctly? Is the trace_id being stored and linked properly?
6. **Cost tracking** — With LiteLLM's auto-reporting, is cost per call being sent to Langfuse? Is anything missing vs the current manual implementation?
7. **Performance** — Are Langfuse calls blocking the response stream? Should any calls be async/fire-and-forget?
8. **Error handling** — Does Langfuse failure gracefully degrade without affecting user experience?

After the review, fix any issues found and ensure the final Langfuse integration (via LiteLLM callbacks + any remaining manual calls) is production-grade. The goal is clean, complete observability with zero impact on response latency.

Key files to review: `api/app/core/langfuse_client.py`, `api/app/services/llm_service.py`, `api/app/services/rag_service.py`, `api/app/services/sdr_service.py`, `api/app/services/intent_service.py`, `api/app/api/chat_routes.py`

## Testing & Verification

1. **Unit test each LLM function** — `generate_response()`, `generate_response_stream()` return correct format
2. **Test streaming** — widget receives chunks via SSE correctly
3. **Test structured output** — SDR mode returns valid `SDRResponse` JSON
4. **Test BANT extraction** — returns valid JSON with need/timeline/authority/budget
5. **Test intent detection** — returns YES/NO correctly
6. **Test Langfuse integration** — traces appear in Langfuse dashboard with model name, token usage, cost
7. **Test user feedback** — thumbs up/down in widget creates Langfuse score
8. **Run existing tests** — `cd api && uv run pytest`
9. **Run lint** — `cd api && uv run ruff check .`
10. **Run format** — `cd api && uv run ruff format .`

## Environment Variables (Final State)

```env
# LLM (NEW)
OPENAI_API_KEY=sk-...
LLM_MODEL=openai/gpt-5-mini          # Optional, defaults in config.py

# Langfuse (UNCHANGED — LiteLLM reads these automatically)
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com

# REMOVED
# GOOGLE_API_KEY=...                  # No longer needed (unless used by crawler or other service)
```

## Async Performance Improvements (Part of This Migration)

While migrating the LLM layer, also fix these performance bottlenecks. No Celery or external task queue needed — use threading and FastAPI BackgroundTasks.

### Fix 1: Move Geolocation to Background (CRITICAL — saves 2-8s per chat)

**File:** `api/app/api/chat_routes.py` (lines 42-116)

**Problem:** Every `/chat` request makes up to 3 blocking `urllib.request.urlopen()` calls for IP geolocation BEFORE starting the RAG pipeline:
- `api.ipify.org` (2s timeout) — resolve public IP
- `ip-api.com` (3s timeout) — primary geolocation
- `ipinfo.io` (3s timeout) — fallback geolocation

Worst case: 8 seconds of blocking before the LLM even starts.

**Fix:** The visitor doesn't need their location resolved before getting an answer. Move geolocation to a fire-and-forget background thread:
```python
# Before: blocks 2-8 seconds
location = resolve_geolocation(ip_address)  # blocking HTTP calls
result = rag_pipeline(bot, question, location=location, ...)

# After: respond with IP immediately, resolve geo in background
import threading
threading.Thread(
    target=update_session_location,
    args=(session_id, ip_address),
    daemon=True,
).start()
result = rag_pipeline(bot, question, location=f"IP: {ip_address}", ...)
```

Create a helper function `update_session_location(session_id, ip_address)` that:
1. Resolves geolocation via the existing IP API calls
2. Updates the `ChatSession.location` field in the database
3. Runs in a daemon thread — fire and forget, no error propagation needed

### Fix 2: Move BANT Extraction to Background (MEDIUM — saves 1-3s per chat)

**File:** `api/app/services/rag_service.py` (lines 308-336 in `rag_pipeline()`, lines 495-523 in `rag_pipeline_stream()`)

**Problem:** After generating the RAG response, the pipeline makes ANOTHER full LLM call for BANT extraction. The user waits for this even though they never see the BANT result — it's internal lead qualification data.

**Fix:** Run BANT extraction in a background thread after sending the response:
```python
# Before: user waits for BANT extraction
answer = generate_response(prompt)
extracted = extract_bant_from_conversation(...)  # user waits 1-3s for this
session.commit()
return {"answer": answer, ...}

# After: return answer immediately, extract BANT in background
answer = generate_response(prompt)
bot_msg = add_chat_message(session, session_id, role="bot", content=answer, bot_id=bid)
session.commit()

# Fire-and-forget BANT extraction
threading.Thread(
    target=_background_bant_extraction,
    args=(session_id, cid, bid, history_context, question, answer, current_bant, bot),
    daemon=True,
).start()

return {"answer": answer, ...}
```

Create a helper `_background_bant_extraction()` that:
1. Opens its own DB session (cannot share sessions across threads)
2. Calls `extract_bant_from_conversation()`
3. Updates BANT state via `update_session_bant()`
4. Checks if lead is fully qualified → sends email
5. Handles errors gracefully (log and swallow — never crash the thread)

### Fix 3: Background Document Ingestion (MEDIUM — unblocks API)

**File:** `api/app/api/document_routes.py` (lines 101-142)

**Problem:** `/ingest` endpoint blocks for 10s-2min while processing files (extract → chunk → embed → store). The API worker can't serve other requests during this time.

**Fix:** Use FastAPI `BackgroundTasks` to process after responding:
```python
from fastapi import BackgroundTasks

@router.post("/ingest")
def ingest_documents(
    ...,
    background_tasks: BackgroundTasks,
):
    # Save files to disk immediately
    saved_files = save_uploaded_files(files)

    # Queue processing in background
    background_tasks.add_task(run_folder_ingestion, bot_id, ...)

    # Respond instantly
    return {"status": "processing", "message": "Documents are being processed"}
```

### Fix 4: Configure DB Connection Pool (TRIVIAL — prevents connection exhaustion)

**File:** `api/app/db/session.py` (line 11)

**Problem:** No pool configuration. Default is 5 connections + 10 overflow. Under load, this could exhaust connections.

**Fix:**
```python
engine = create_engine(
    DB_URL,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    pool_timeout=30,
)
```

### Fix 5: Wire Up Streaming Endpoint (MEDIUM — better UX)

**Problem:** `rag_pipeline_stream()` and `generate_sdr_stream()` exist as `async def` functions but NO route calls them. The widget hits `/chat` which uses synchronous `rag_pipeline()`. Users wait 3-10s for the complete response instead of seeing text appear word-by-word.

**Fix:** Create a `/chat/stream` endpoint that returns a `StreamingResponse` using `rag_pipeline_stream()`. This is the standard pattern for modern chatbots (like ChatGPT, Intercom, etc.).

**Note:** The streaming functions contain sync blocking calls inside async context (query rewrite, embedding, DB queries). When wiring up the endpoint, either:
- Use `asyncio.to_thread()` for the blocking calls, OR
- Keep the pre-streaming setup (query rewrite, search) synchronous and only stream the LLM response portion

### Summary of Async Fixes

| Fix | File | Impact | Effort |
|-----|------|--------|--------|
| Geolocation → background | `chat_routes.py` | **Saves 2-8s per chat** | Low |
| BANT → background | `rag_service.py` | **Saves 1-3s per chat** | Low |
| Ingestion → background | `document_routes.py` | **Unblocks API** | Low |
| DB pool config | `session.py` | **Prevents crashes at scale** | Trivial |
| Streaming endpoint | `chat_routes.py` + routes | **Better UX** | Medium |

**Combined impact on `/chat` latency:** From 10-22s → 2-5s (geolocation + BANT moved to background)

## RAG Pipeline Improvements

The current RAG pipeline has several weaknesses that reduce answer quality. Fix these alongside the LLM migration. No architectural changes needed — these are targeted improvements to existing code.

### Current RAG Flow (What Exists)
```
Query → LLM Rewrite (every time) → Embed → Vector Search (k=5, no threshold) + Keyword Search (k=5, no ranking)
→ Deduplicate by ID (no scoring) → Stuff all 10 chunks into prompt → LLM generates answer
```

### RAG Fix 1: Add Relevance Score Filtering to Vector Search (HIGH impact, LOW effort)

**File:** `api/app/db/repository.py` — `search_similar_documents()` (line 277-290)

**Problem:** Always returns 5 results even if the best match has 0.9 cosine distance (basically irrelevant). No minimum similarity threshold.

**Current code:**
```python
def search_similar_documents(session, client_id=None, query_embedding=None, k=5, bot_id=None):
    stmt = (
        select(Document)
        .where(_owner_filter(Document, bot_id, client_id))
        .order_by(Document.embedding.op("<->")(query_embedding))
        .limit(k)
    )
```

**Fix:** Add a similarity threshold and return the distance score:
```python
def search_similar_documents(session, client_id=None, query_embedding=None, k=5, bot_id=None, max_distance=0.8):
    distance = Document.embedding.op("<->")(query_embedding).label("distance")
    stmt = (
        select(Document, distance)
        .where(_owner_filter(Document, bot_id, client_id))
        .where(distance < max_distance)
        .order_by(distance)
        .limit(k)
    )
```

**Impact:** Stops sending irrelevant chunks to the LLM → fewer hallucinations, better answers.

### RAG Fix 2: Add Keyword Search Ranking with ts_rank (HIGH impact, LOW effort)

**File:** `api/app/db/repository.py` — `search_keyword_documents()` (line 262-274)

**Problem:** Uses `match()` but doesn't rank by relevance — returns matches in arbitrary order.

**Current code:**
```python
def search_keyword_documents(session, client_id=None, query="", k=5, bot_id=None):
    stmt = (
        select(Document)
        .filter(Document.search_vector.match(query, postgresql_regconfig="english"), ...)
        .limit(k)
    )
```

**Fix:** Add `ts_rank()` for proper relevance ranking:
```python
from sqlalchemy import func

def search_keyword_documents(session, client_id=None, query="", k=5, bot_id=None):
    rank = func.ts_rank(Document.search_vector, func.plainto_tsquery('english', query)).label('rank')
    stmt = (
        select(Document, rank)
        .where(Document.search_vector.match(query, postgresql_regconfig="english"))
        .where(_owner_filter(Document, bot_id, client_id))
        .order_by(rank.desc())
        .limit(k)
    )
```

### RAG Fix 3: Reciprocal Rank Fusion for Result Merging (MEDIUM impact, LOW effort)

**File:** `api/app/services/rag_service.py` — inside `rag_pipeline()` (lines 270-279)

**Problem:** Vector and keyword results are merged by simple dedup (`{doc.id: doc}`). Vector result #5 (barely relevant) is treated the same as vector result #1 (highly relevant). No scoring or weighting.

**Current code:**
```python
all_results = {doc.id: doc for doc in vector_results}
for doc in keyword_results:
    all_results[doc.id] = doc
final_results = list(all_results.values())
```

**Fix:** Implement Reciprocal Rank Fusion (RRF) — a proven algorithm for merging ranked lists:
```python
def reciprocal_rank_fusion(vector_results, keyword_results, k=60):
    scores = {}
    docs = {}
    for rank, doc in enumerate(vector_results):
        scores[doc.id] = scores.get(doc.id, 0) + 1.0 / (k + rank + 1)
        docs[doc.id] = doc
    for rank, doc in enumerate(keyword_results):
        scores[doc.id] = scores.get(doc.id, 0) + 1.0 / (k + rank + 1)
        docs[doc.id] = doc
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [docs[doc_id] for doc_id, _ in ranked]
```

**Impact:** Best results from both retrieval methods float to the top. Chunks relevant in BOTH vector and keyword search get the highest combined score.

### RAG Fix 4: Skip Unnecessary Query Rewrites (MEDIUM impact, LOW effort)

**File:** `api/app/services/rag_service.py` — `rewrite_query()` (line 125-147)

**Problem:** Every single question triggers an LLM call for query rewriting, even standalone questions like "What's your pricing?" that don't need rewriting. This wastes 500ms-2s + LLM cost on ~60-70% of queries.

**Current code:**
```python
def rewrite_query(session_id, question, history):
    if not history:
        return question
    # Always calls LLM if any history exists...
```

**Fix:** Only rewrite when the question is likely a follow-up:
```python
def rewrite_query(session_id, question, history):
    if not history or len(history) < 2:
        return question

    # Heuristic: skip rewrite for self-contained questions
    follow_up_signals = ["it", "that", "this", "they", "them", "those", "the same",
                         "more about", "what about", "how about", "and the", "also"]
    question_lower = question.lower()
    needs_rewrite = any(signal in question_lower for signal in follow_up_signals)

    if not needs_rewrite:
        return question

    # Only call LLM for actual follow-ups
    return _llm_rewrite(question, history)
```

**Impact:** Saves 1 LLM call (~500ms-2s + $0.0005) on the majority of queries.

### RAG Fix 5: Add Reranking After Retrieval (HIGH impact, MEDIUM effort)

**File:** `api/app/services/rag_service.py`, `api/pyproject.toml`

**Problem:** After retrieving up to 10 chunks, they all go straight to the LLM with equal weight. Some are highly relevant, some are noise. The LLM wastes context on low-quality chunks and may generate worse answers.

**Fix:** Add a cross-encoder reranker using FastEmbed (already a dependency):
```python
from fastembed.rerank.cross_encoder import TextCrossEncoder
reranker = TextCrossEncoder("Xenova/ms-marco-MiniLM-L-6-v2")

# After hybrid search, before building prompt:
reranked = reranker.rerank(
    query=question,
    documents=[doc.content for doc in final_results],
    top_k=5  # Only keep top 5 most relevant
)
final_results = [final_results[r["index"]] for r in reranked]
```

**Impact:** Sending 5 highly-relevant chunks instead of 10 mixed-quality chunks = better answers + fewer input tokens (cost savings of ~30-40% on input).

**Note:** Check if `fastembed` already includes the rerank module. If not, the cross-encoder model is small (~80MB) and runs locally with no API cost.

### RAG Fix 6: Better Context Formatting (LOW impact, LOW effort)

**File:** `api/app/services/rag_service.py` — context formatting (lines 282-285)

**Problem:** All chunks are formatted identically — the LLM has no signal about which chunks are most relevant.

**Current code:**
```python
context_parts.append(f"Document: {doc.document_name}\nContent:\n{doc.content}\n")
```

**Fix:** Add ordering signal:
```python
for i, doc in enumerate(final_results):
    context_parts.append(f"[Source {i+1}] Document: {doc.document_name}\nContent:\n{doc.content}\n")
```

### RAG Improvements NOT Recommended (For Now)

| Improvement | Why Skip |
|------------|---------|
| **GraphRAG** | Overkill — your queries are simple FAQ/support, not multi-hop reasoning. 100-500x more expensive to index. |
| **Better embedding model** | Requires re-embedding ALL existing documents + DB migration (`Vector(384)` → `Vector(768)`). Do this later as a separate project. |
| **Semantic chunking** | `RecursiveCharacterTextSplitter` is good enough. Semantic chunking adds LLM cost per chunk during ingestion. |
| **Custom separators** | The default separators (`\n\n`, `\n`, ` `, `""`) handle most document formats well. |

### Summary of RAG Fixes

| # | Fix | File | Impact | Effort |
|---|-----|------|--------|--------|
| 1 | Relevance score filtering | `repository.py` | **High** | Low |
| 2 | Keyword search ranking (`ts_rank`) | `repository.py` | **High** | Low |
| 3 | RRF result merging | `rag_service.py` | **Medium** | Low |
| 4 | Skip unnecessary query rewrites | `rag_service.py` | **Medium** | Low |
| 5 | Reranking (cross-encoder) | `rag_service.py` | **High** | Medium |
| 6 | Context formatting | `rag_service.py` | **Low** | Low |

**Apply the same fixes to both `rag_pipeline()` and `rag_pipeline_stream()` in `rag_service.py`.**

## Important Notes

- **Pin LiteLLM version** in `pyproject.toml` — e.g., `litellm==1.82.6` (exact pin, not `>=`). This is critical due to the recent supply chain attack on versions 1.82.7-1.82.8.
- **LiteLLM SDK only** — do NOT install the proxy (`litellm[proxy]`). Just `pip install litellm`.
- **Keep function signatures stable** — `generate_response(prompt)` and `generate_response_stream(prompt)` signatures should not change so `rag_service.py` and other callers don't need updates.
- **Test with OpenAI API key** — you need a valid `OPENAI_API_KEY` to test.
- **Fallback routing is optional** — can be added later if needed for reliability.
- **Check if `GOOGLE_API_KEY` is used by crawler** — `crawler_script.py` may use it. If so, keep the env var but remove it from LLM config.
