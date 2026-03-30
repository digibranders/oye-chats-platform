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

## Important Notes

- **Pin LiteLLM version** in `pyproject.toml` — e.g., `litellm==1.82.6` (exact pin, not `>=`). This is critical due to the recent supply chain attack on versions 1.82.7-1.82.8.
- **LiteLLM SDK only** — do NOT install the proxy (`litellm[proxy]`). Just `pip install litellm`.
- **Keep function signatures stable** — `generate_response(prompt)` and `generate_response_stream(prompt)` signatures should not change so `rag_service.py` and other callers don't need updates.
- **Test with OpenAI API key** — you need a valid `OPENAI_API_KEY` to test.
- **Fallback routing is optional** — can be added later if needed for reliability.
- **Check if `GOOGLE_API_KEY` is used by crawler** — `crawler_script.py` may use it. If so, keep the env var but remove it from LLM config.
