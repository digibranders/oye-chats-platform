"""Mock LLM + embeddings server for OyeChats load testing (Phase 8 / 8A).

Speaks just enough of the OpenAI and Gemini REST protocols that LiteLLM (and the
app's Gemini embedding client) talk to THIS server instead of a paid provider.
The app is pointed here purely via env overrides — NO application code changes:

    OPENAI_API_BASE = http://127.0.0.1:9099/v1      # chat + moderation
    OPENAI_API_KEY  = sk-mock-loadtest              # any non-empty string
    GEMINI_EMBED_URL = http://127.0.0.1:9099/v1beta # batchEmbedContents
    GOOGLE_API_KEY  = mock-loadtest                 # any non-empty string

Implements:
  * POST /v1/chat/completions        (streaming SSE + non-streaming)
  * POST /v1/moderations             (always not-flagged)
  * POST /v1beta/models/{m}:batchEmbedContents  (deterministic 768-d vectors)
  * GET  /healthz                    (readiness probe used by the bring-up script)

Latency is configurable so you can separate app/DB bottlenecks from provider
latency. Precedence: per-request header  >  env default.
  MOCK_LLM_TTFT_MS     time to first token   (default 300)
  MOCK_LLM_LATENCY_MS  total generation time (default 1200)
  MOCK_LLM_TOKENS      streamed token count  (default 60)
Per-request overrides (so k6 can sweep latency without a restart):
  x-mock-ttft-ms, x-mock-latency-ms, x-mock-tokens

Deterministic: identical inputs + latency settings -> identical output, so
benchmarks are repeatable. Run:
  DYLD_FALLBACK_LIBRARY_PATH= .venv/bin/python -m uvicorn server:app --port 9099
(see runner/start-mock-stack.sh which wires everything up).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="oyechats-mock-llm")

_DEF_TTFT_MS = int(os.getenv("MOCK_LLM_TTFT_MS", "300"))
_DEF_LATENCY_MS = int(os.getenv("MOCK_LLM_LATENCY_MS", "1200"))
_DEF_TOKENS = int(os.getenv("MOCK_LLM_TOKENS", "60"))
_EMBED_DIM = int(os.getenv("EMBED_DIMENSIONS", "768"))

# A fixed reply, chunked into pseudo-tokens. Deterministic on purpose.
_REPLY = (
    "Thanks for your question. Based on the information available, here is a concise, "
    "helpful answer that a real assistant would stream back token by token so the "
    "widget can render it progressively while generation continues."
).split(" ")


def _resolve(header_val: str | None, default: int) -> int:
    if header_val:
        try:
            return max(0, int(header_val))
        except ValueError:
            pass
    return default


def _deterministic_vector(text: str, dim: int) -> list[float]:
    """Stable pseudo-embedding from a hash of the text. Not L2-normalised — the
    app L2-normalises the ``values`` it receives, so raw floats are fine."""
    h = hashlib.sha256(text.encode("utf-8")).digest()
    # Expand the 32-byte digest into `dim` floats in [-1, 1], deterministically.
    out: list[float] = []
    seed = int.from_bytes(h, "big")
    for _ in range(dim):
        seed = (seed * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        out.append(((seed >> 11) / float(1 << 53)) * 2.0 - 1.0)
    return out


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "oyechats-mock-llm"}


@app.post("/v1/moderations")
async def moderations(request: Request):
    body = await request.json()
    inp = body.get("input", "")
    n = len(inp) if isinstance(inp, list) else 1
    results = [
        {
            "flagged": False,
            "categories": {},
            "category_scores": {},
        }
        for _ in range(n)
    ]
    return {"id": "modr-mock", "model": body.get("model", "text-moderation-mock"), "results": results}


@app.post("/v1beta/models/{model_path:path}")
async def gemini_batch_embed(model_path: str, request: Request):
    """Handles .../models/{model}:batchEmbedContents. FastAPI captures the whole
    `{model}:batchEmbedContents` tail in model_path."""
    body = await request.json()
    reqs = body.get("requests", [])
    embeddings = []
    for r in reqs:
        try:
            text = r["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError):
            text = ""
        dim = int(r.get("outputDimensionality", _EMBED_DIM))
        embeddings.append({"values": _deterministic_vector(text, dim)})
    return {"embeddings": embeddings}


def _completion_id() -> str:
    return "chatcmpl-mock"


@app.post("/v1/chat/completions")
async def chat_completions(
    request: Request,
    x_mock_ttft_ms: str | None = Header(default=None),
    x_mock_latency_ms: str | None = Header(default=None),
    x_mock_tokens: str | None = Header(default=None),
):
    body = await request.json()
    model = body.get("model", "gpt-mock")
    stream = bool(body.get("stream", False))

    ttft = _resolve(x_mock_ttft_ms, _DEF_TTFT_MS) / 1000.0
    total = _resolve(x_mock_latency_ms, _DEF_LATENCY_MS) / 1000.0
    n_tokens = _resolve(x_mock_tokens, _DEF_TOKENS) or 1
    tokens = (_REPLY * ((n_tokens // len(_REPLY)) + 1))[:n_tokens]

    created = int(time.time())

    if not stream:
        # Non-streaming: sleep the whole generation time, then return once.
        await asyncio.sleep(total)
        text = " ".join(tokens)
        return JSONResponse(
            {
                "id": _completion_id(),
                "object": "chat.completion",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 40,
                    "completion_tokens": n_tokens,
                    "total_tokens": 40 + n_tokens,
                },
            }
        )

    async def event_stream():
        # First-token delay.
        await asyncio.sleep(ttft)
        # Spread remaining tokens across (total - ttft).
        remaining = max(total - ttft, 0.0)
        per_token = remaining / max(n_tokens - 1, 1)
        for i, tok in enumerate(tokens):
            chunk = {
                "id": _completion_id(),
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {"index": 0, "delta": {"content": (tok + " ")}, "finish_reason": None}
                ],
            }
            yield f"data: {json.dumps(chunk)}\n\n"
            if i < n_tokens - 1:
                await asyncio.sleep(per_token)
        final = {
            "id": _completion_id(),
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        yield f"data: {json.dumps(final)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
