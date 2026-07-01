# Final Stack: Google Embedding + Jina Crawl Fallback + Old-Stack Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Google Gemini embeddings the sole embedding provider (768-dim, off-box), add Jina Reader as the PAYG crawl fallback for Spider, and remove the old stack (FastEmbed/bge-base, OpenAI-embed fallback, crawl4ai/Playwright local crawler).

**Architecture:** Embedding calls the Gemini `batchEmbedContents` REST endpoint via `httpx` using the existing `GOOGLE_API_KEY`, at `outputDimensionality=768` (L2-normalized), matching the existing `Vector(768)` column — no schema change. On embedding failure: ingestion relies on ARQ retry; query-time already degrades to full-text (verified in `rag_service`). Crawl stays Spider-primary; the fallback (previously a local Playwright recursive crawl) becomes **Jina Reader** (PAYG markdown) fed by the existing browser-free `url_discovery`. Then the local crawler + FastEmbed + their packages are deleted.

**Tech Stack:** FastAPI · ARQ · httpx · pgvector(768) · Gemini embeddings REST · Jina Reader · Spider.cloud.

**Fresh DB note:** prod DB is being reset — **no re-embed/migration of existing data is required**; set the fresh `Vector(768)` column and go.

---

## Pre-flight
- [ ] On `development` branch; `.venv` binaries for python/pytest (`.venv/bin/python -m pytest ... --no-cov`).
- [ ] Have `GOOGLE_API_KEY` (already in `.env` for the Gemini LLM) and a `JINA_API_KEY` (optional — Jina works keyless at 20 RPM; a key gives 500 RPM + the 10M free tokens).

## File Structure
**Create:**
- `api/app/services/gemini_embedding.py` — Gemini embeddings REST client (batch, 768-dim, normalized, retry).
- `api/app/services/jina_service.py` — Jina Reader `fetch_urls()` returning `{url, content}`.
- Tests: `test_gemini_embedding.py`, `test_jina_service.py`, `test_crawl_provider_jina_fallback.py`, `test_query_degrades_to_fulltext.py`.

**Modify:**
- `api/app/config.py` — `EMBED_PROVIDER=google` default + Gemini/Jina settings.
- `api/app/ingestion/embedder.py` — route to Google; drop FastEmbed + OpenAI-embed (cleanup task).
- `api/app/services/crawl_provider.py` — fallback → Jina (via `url_discovery`), remove `_playwright_crawl`.
- `api/.env.example`, `.github/workflows/deploy-api.yml` — Google/Jina env; drop Spider-fallback-to-playwright.
- **Cleanup (delete):** `api/app/services/crawler_script.py`; the subprocess-crawl parts of `crawler_service.py` (keep the Redis lock/progress/cancel helpers); `pyproject.toml` remove `fastembed`, `crawl4ai`, `playwright`, `playwright-stealth`.

---

### Task 1: Gemini embeddings config

**Files:** Modify `api/app/config.py` · Test `api/tests/test_embed_config.py` (create)

- [ ] **Step 1: Failing test**
```python
# api/tests/test_embed_config.py
import importlib


def test_embed_defaults(monkeypatch):
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: None)
    for k in ("EMBED_PROVIDER", "GEMINI_EMBED_MODEL", "EMBED_DIMENSIONS"):
        monkeypatch.delenv(k, raising=False)
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.EMBED_PROVIDER == "google"
    assert cfg.GEMINI_EMBED_MODEL == "gemini-embedding-001"
    assert cfg.EMBED_DIMENSIONS == 768


def teardown_module(module):
    import importlib

    import app.config as cfg
    importlib.reload(cfg)
```

- [ ] **Step 2: Run → FAIL** (`EMBED_PROVIDER` still `fastembed`).
Run: `cd api && .venv/bin/python -m pytest tests/test_embed_config.py -v --no-cov`

- [ ] **Step 3: Update `config.py` embedding block**
Replace the existing embeddings block with:
```python
# ── Embeddings ───────────────────────────────────────────────────────────────
# "google" (Gemini API, off-box) is the sole provider. Kept configurable so a
# self-hosted emergency path could be reintroduced, but there is no cross-model
# fallback (mixing embedding models corrupts vector search).
EMBED_PROVIDER = os.getenv("EMBED_PROVIDER", "google").strip().lower()
GEMINI_EMBED_MODEL = os.getenv("GEMINI_EMBED_MODEL", "gemini-embedding-001")
EMBED_DIMENSIONS = int(os.getenv("EMBED_DIMENSIONS", "768"))
GEMINI_EMBED_URL = os.getenv(
    "GEMINI_EMBED_URL", "https://generativelanguage.googleapis.com/v1beta"
).rstrip("/")
```
(Remove the old `FASTEMBED_MODEL` / `EMBED_MODEL` lines — the cleanup task deletes their consumers.)

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(embed): Gemini embedding config (google default, 768-dim)`.

---

### Task 2: Gemini embeddings client

**Files:** Create `api/app/services/gemini_embedding.py` · Test `api/tests/test_gemini_embedding.py`

- [ ] **Step 0: Verify the REST contract FIRST** (do this before coding — mirrors the Spider `/scrape` verify that saved us):
```bash
cd api
.venv/bin/python - <<'PY'
import httpx
key = [l.split('=',1)[1].strip() for l in open('.env') if l.startswith('GOOGLE_API_KEY=')][0]
url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents"
body = {"requests": [
    {"model": "models/gemini-embedding-001", "content": {"parts": [{"text": "hello world"}]}, "outputDimensionality": 768},
    {"model": "models/gemini-embedding-001", "content": {"parts": [{"text": "second"}]}, "outputDimensionality": 768},
]}
r = httpx.post(url, params={"key": key}, json=body, timeout=60)
print("status", r.status_code)
j = r.json()
print("keys", list(j.keys()))
embs = j.get("embeddings", [])
print("count", len(embs), "dim", len(embs[0]["values"]) if embs else "-")
PY
```
Confirm it returns `{"embeddings": [{"values": [...768...]}, ...]}`. If `gemini-embedding-001` errors, retry with `gemini-embedding-2` and update `GEMINI_EMBED_MODEL`. Adjust field names in Step 3 to match the confirmed response.

- [ ] **Step 1: Failing test**
```python
# api/tests/test_gemini_embedding.py
import httpx
import pytest

from app.services import gemini_embedding as ge


def _mock_client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_embeds_batch_768_normalized(monkeypatch):
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", "k")
    monkeypatch.setattr(ge, "EMBED_DIMENSIONS", 4)  # tiny for the test

    def handler(request):
        n = len(request.read().decode().split('"text"')) - 1  # count inputs
        return httpx.Response(200, json={"embeddings": [{"values": [3.0, 4.0, 0.0, 0.0]} for _ in range(n)]})

    out = ge.embed_texts(["a", "b"], _client=_mock_client(handler))
    assert len(out) == 2 and len(out[0]) == 4
    # 3-4-0-0 L2-normalized → 0.6, 0.8, 0, 0
    assert abs(out[0][0] - 0.6) < 1e-6 and abs(out[0][1] - 0.8) < 1e-6


def test_missing_key_raises(monkeypatch):
    monkeypatch.setattr(ge, "GOOGLE_API_KEY", None)
    with pytest.raises(RuntimeError):
        ge.embed_texts(["a"])
```

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Implement `gemini_embedding.py`**
```python
"""Google Gemini embeddings via the batchEmbedContents REST API (httpx).

Uses the existing GOOGLE_API_KEY (same key as the Gemini LLM fallback). Returns
768-dim L2-normalized vectors matching the pgvector column. No SDK dependency.
Below-native output_dimensionality requires client-side L2 normalization for
cosine similarity to behave, so we normalize here.
"""

import logging
import math
import time

import httpx

from app.config import EMBED_DIMENSIONS, GEMINI_EMBED_MODEL, GEMINI_EMBED_URL, GOOGLE_API_KEY

logger = logging.getLogger(__name__)

_MAX_BATCH = 100
_RETRY_ATTEMPTS = 5
_RETRY_BASE = 1.0
_RETRY_MAX = 30.0
_TIMEOUT = 60.0


def _l2_normalize(v: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v] if norm > 0 else v


def _embed_one_batch(client: httpx.Client, batch: list[str]) -> list[list[float]]:
    url = f"{GEMINI_EMBED_URL}/models/{GEMINI_EMBED_MODEL}:batchEmbedContents"
    body = {
        "requests": [
            {
                "model": f"models/{GEMINI_EMBED_MODEL}",
                "content": {"parts": [{"text": t}]},
                "outputDimensionality": EMBED_DIMENSIONS,
            }
            for t in batch
        ]
    }
    last: Exception | None = None
    for attempt in range(1, _RETRY_ATTEMPTS + 1):
        try:
            resp = client.post(url, params={"key": GOOGLE_API_KEY}, json=body, timeout=_TIMEOUT)
            if resp.status_code == 429 or resp.status_code >= 500:
                raise httpx.HTTPStatusError("retryable", request=resp.request, response=resp)
            resp.raise_for_status()
            embs = resp.json()["embeddings"]
            return [_l2_normalize(e["values"]) for e in embs]
        except (httpx.HTTPError, KeyError) as exc:
            last = exc
            if attempt == _RETRY_ATTEMPTS:
                break
            delay = min(_RETRY_BASE * (2 ** (attempt - 1)), _RETRY_MAX)
            logger.warning("Gemini embed transient error (%s) — retry %d/%d in %.1fs",
                           type(exc).__name__, attempt, _RETRY_ATTEMPTS, delay)
            time.sleep(delay)
    raise RuntimeError(f"Gemini embedding failed after {_RETRY_ATTEMPTS} attempts: {last}")


def embed_texts(texts: list[str], *, _client: httpx.Client | None = None) -> list[list[float]]:
    """Embed texts → 768-dim normalized vectors. Raises on persistent failure
    (ingestion relies on ARQ retry; query path degrades to full-text)."""
    if not texts:
        return []
    if not GOOGLE_API_KEY:
        raise RuntimeError("GOOGLE_API_KEY is not configured for embeddings")
    owns = _client is None
    client = _client or httpx.Client(timeout=_TIMEOUT)
    try:
        out: list[list[float]] = []
        for i in range(0, len(texts), _MAX_BATCH):
            out.extend(_embed_one_batch(client, texts[i : i + _MAX_BATCH]))
        return out
    finally:
        if owns:
            client.close()
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(embed): Gemini embeddings REST client (768-dim, normalized)`.

---

### Task 3: Route `embed_chunks` to Google

**Files:** Modify `api/app/ingestion/embedder.py` · Test `api/tests/test_embedder_routes_google.py`

- [ ] **Step 1: Failing test**
```python
# api/tests/test_embedder_routes_google.py
from app.ingestion import embedder


def test_embed_chunks_uses_google(monkeypatch):
    monkeypatch.setattr(embedder, "EMBED_PROVIDER", "google")
    called = {}

    def fake_embed(texts, **kw):
        called["texts"] = texts
        return [[0.1] * 768 for _ in texts]

    monkeypatch.setattr(embedder, "_google_embed", fake_embed)
    out = embedder.embed_chunks(["x", "y"])
    assert called["texts"] == ["x", "y"]
    assert len(out) == 2 and len(out[0]) == 768
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Replace the body of `embedder.py`** (drop FastEmbed/OpenAI; Google only):
```python
"""Embedding via Google Gemini (sole provider, off-box).

768-dim L2-normalized vectors matching the pgvector column. No local model, no
cross-model fallback (mixing models corrupts vector search). On persistent
failure embed_chunks raises: ingestion retries via ARQ; the query path degrades
to full-text search (see rag_service).
"""

import asyncio
import logging

from app.config import EMBED_PROVIDER
from app.services.gemini_embedding import embed_texts as _google_embed

logger = logging.getLogger(__name__)


def embed_chunks(chunk_content_list: list[str]) -> list[list[float]]:
    if not chunk_content_list:
        return []
    if EMBED_PROVIDER != "google":
        raise RuntimeError(f"Unsupported EMBED_PROVIDER={EMBED_PROVIDER!r} (only 'google' is supported)")
    return _google_embed(chunk_content_list)


async def embed_chunks_async(chunk_content_list: list[str]) -> list[list[float]]:
    """Async wrapper — runs the (sync httpx) embed call off the event loop."""
    return await asyncio.to_thread(embed_chunks, chunk_content_list)
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(embed): route embed_chunks to Google (drop FastEmbed/OpenAI)`.

---

### Task 4: Verify query-time full-text degradation

**Files:** Test only — `api/tests/test_query_degrades_to_fulltext.py`

- [ ] **Step 1: Write the test** (confirms the EXISTING behavior at `rag_service.py:~2440`/`3064`: embed failure → `query_embedding=None` → keyword-only search still returns results). Open `rag_service.py`, find the retrieval entry function, and assert that when `embed_chunks` raises, retrieval still returns keyword hits without raising. Mirror the existing test setup in `tests/` for rag_service (search for an existing rag_service test to copy fixtures).
```python
# api/tests/test_query_degrades_to_fulltext.py
# NOTE: adapt fixture setup to the existing rag_service tests. Intent:
from unittest.mock import patch


def test_embed_failure_falls_back_to_keyword(monkeypatch):
    import app.services.rag_service as rag
    monkeypatch.setattr(rag, "embed_chunks", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("embed down")))
    # keyword search returns a doc even with no embedding:
    monkeypatch.setattr(rag, "_keyword_search", lambda *a, **k: [{"content": "kw hit", "document_name": "d"}])
    monkeypatch.setattr(rag, "_vector_search", lambda *a, **k: [])
    # call the retrieval helper the codebase exposes (confirm its name), assert no raise + keyword hit present.
```

- [ ] **Step 2–4:** Run; if it fails because the degradation ISN'T actually wired at the entry point you tested, add a `try/except RuntimeError → query_embedding=None` around the `embed_chunks([search_query])` calls (lines ~2440 and ~3064 already do this — verify both retrieval paths, sync and async). **Step 5: Commit** `test(rag): query embedding failure degrades to full-text`.

---

### Task 5: Jina Reader crawl fallback

**Files:** Create `api/app/services/jina_service.py` · Modify `config.py` (add Jina settings) · Test `api/tests/test_jina_service.py`

- [ ] **Step 1: Config** — add to `config.py`:
```python
# ── Crawl fallback (Jina Reader, PAYG markdown) ──────────────────────────────
JINA_API_KEY = os.getenv("JINA_API_KEY")  # optional: raises RPM + unlocks free tokens
JINA_READER_URL = os.getenv("JINA_READER_URL", "https://r.jina.ai").rstrip("/")
JINA_FALLBACK_ENABLED = os.getenv("JINA_FALLBACK_ENABLED", "true").strip().lower() in ("1", "true", "yes")
JINA_FETCH_CONCURRENCY = int(os.getenv("JINA_FETCH_CONCURRENCY", "5"))
```

- [ ] **Step 2: Failing test**
```python
# api/tests/test_jina_service.py
import httpx
import pytest

from app.services import jina_service


def _mock(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_urls_returns_markdown(monkeypatch):
    def handler(request):
        assert request.url.path.endswith("acme.test/a") or request.url.path.endswith("acme.test/b")
        return httpx.Response(200, text="# Title\nbody")

    urls = ["https://acme.test/a", "https://acme.test/b"]
    data = await jina_service.fetch_urls(urls, client_id=1, _client=_mock(handler))
    assert [p["url"] for p in data["results"]] == urls
    assert data["results"][0]["content"].startswith("# Title")


@pytest.mark.asyncio
async def test_fetch_urls_drops_failures(monkeypatch):
    def handler(request):
        return httpx.Response(500) if request.url.path.endswith("/bad") else httpx.Response(200, text="ok")

    data = await jina_service.fetch_urls(["https://a.test/ok", "https://a.test/bad"], client_id=1, _client=_mock(handler))
    assert [p["url"] for p in data["results"]] == ["https://a.test/ok"]
```

- [ ] **Step 3: Implement `jina_service.py`**
```python
"""Jina Reader crawl fallback — fetch URLs as markdown via https://r.jina.ai/<url>.

PAYG, markdown-native. Returns the SAME {url, content} shape as spider_service so
it drops in behind crawl_provider. Single-page by design: multi-page coverage is
provided by url_discovery (browser-free) upstream.
"""

import asyncio
import logging

import httpx

from app.config import JINA_API_KEY, JINA_FETCH_CONCURRENCY, JINA_READER_URL

logger = logging.getLogger(__name__)
_TIMEOUT = 60.0


async def _fetch_one(client: httpx.AsyncClient, url: str, sem: asyncio.Semaphore) -> dict | None:
    headers = {"X-Return-Format": "markdown"}
    if JINA_API_KEY:
        headers["Authorization"] = f"Bearer {JINA_API_KEY}"
    async with sem:
        try:
            resp = await client.get(f"{JINA_READER_URL}/{url}", headers=headers)
        except httpx.HTTPError as exc:
            logger.warning("Jina fetch failed for %s: %s", url, exc)
            return None
    if resp.status_code >= 400 or not resp.text.strip():
        logger.warning("Jina fetch %s returned %s", url, resp.status_code)
        return None
    return {"url": url, "content": resp.text}


async def fetch_urls(urls: list[str], *, use_js: bool = False, client_id: int | None = None,
                     _client: httpx.AsyncClient | None = None) -> dict:
    """Fetch an explicit URL list as markdown. Preserves order; drops failures."""
    if not urls:
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}
    owns = _client is None
    client = _client or httpx.AsyncClient(timeout=_TIMEOUT)
    sem = asyncio.Semaphore(JINA_FETCH_CONCURRENCY)
    try:
        fetched = await asyncio.gather(*[_fetch_one(client, u, sem) for u in urls])
    finally:
        if owns:
            await client.aclose()
    results = [p for p in fetched if p]
    logger.info("jina_fallback client=%s pages=%d/%d", client_id, len(results), len(urls))
    return {"results": results, "recommended_colors": [], "discovered_total": len(urls), "queue_remaining": 0}
```
(`use_js` accepted for signature parity; Jina renders JS server-side automatically.)

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `feat(crawl): Jina Reader fallback adapter (PAYG markdown)`.

---

### Task 6: Wire Jina into `crawl_provider` (replace Playwright fallback)

**Files:** Modify `api/app/services/crawl_provider.py` · Test `api/tests/test_crawl_provider_jina_fallback.py`

- [ ] **Step 1: Failing test**
```python
# api/tests/test_crawl_provider_jina_fallback.py
import pytest

from app.services import crawl_provider
from app.services.crawler_service import CrawlerError


@pytest.mark.asyncio
async def test_crawl_website_falls_back_to_jina_via_discovery(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", True)

    async def boom(url, **kw):
        raise CrawlerError("spider down")

    async def fake_discover(url, **kw):
        return ["https://a.test/1", "https://a.test/2"]

    async def fake_jina(urls, **kw):
        return {"results": [{"url": u, "content": "md"} for u in urls], "recommended_colors": [],
                "discovered_total": len(urls), "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom)
    monkeypatch.setattr(crawl_provider, "_discover_urls", fake_discover)
    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=10, use_js=False, client_id=1)
    assert [p["url"] for p in data["results"]] == ["https://a.test/1", "https://a.test/2"]


@pytest.mark.asyncio
async def test_fetch_urls_falls_back_to_jina(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "JINA_FALLBACK_ENABLED", True)

    async def boom(urls, **kw):
        raise CrawlerError("down")

    async def fake_jina(urls, **kw):
        return {"results": [{"url": urls[0], "content": "md"}], "recommended_colors": [],
                "discovered_total": len(urls), "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", boom)
    monkeypatch.setattr(crawl_provider, "_jina_fetch_urls", fake_jina)
    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "md"
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Rewrite `crawl_provider.py`** — replace the recursive-Playwright fallback with Jina; remove the `_playwright_crawl` import:
```python
"""Selects the crawl backend. Spider primary; Jina Reader fallback.

Both return {url, content}. On Spider failure we fall back to Jina Reader (PAYG
markdown): for a recursive crawl we first discover URLs (browser-free) then Jina
each; for an explicit list we Jina it directly. No local browser is involved.
"""

import logging

from app.config import CRAWL_PROVIDER, JINA_FALLBACK_ENABLED, MAX_CRAWL_DEPTH_DEFAULT  # see note
from app.services.crawler_service import CrawlerError
from app.services.crawler_service import crawl_website as _spider_unused  # noqa: F401 (removed below)
from app.services.jina_service import fetch_urls as _jina_fetch_urls
from app.services.spider_service import crawl_website as _spider_crawl
from app.services.spider_service import fetch_urls as _spider_fetch_urls
from app.services.url_discovery import discover_website_urls as _discover_urls

logger = logging.getLogger(__name__)


async def crawl_website(url: str, **kwargs) -> dict:
    if CRAWL_PROVIDER == "spider":
        try:
            return await _spider_crawl(url, **kwargs)
        except CrawlerError:
            if not JINA_FALLBACK_ENABLED:
                raise
            logger.warning("Spider crawl failed for %s — falling back to Jina via discovery", url, exc_info=True)
            max_pages = kwargs.get("max_pages") or 0
            urls = await _discover_urls(url, max_urls=(max_pages or 1000), timeout=20.0)
            return await _jina_fetch_urls(urls, use_js=kwargs.get("use_js", False), client_id=kwargs.get("client_id"))
    # No non-spider provider remains; spider is the configured default.
    return await _spider_crawl(url, **kwargs)


async def fetch_urls(urls: list[str], **kwargs) -> dict:
    if CRAWL_PROVIDER == "spider":
        try:
            return await _spider_fetch_urls(urls, **kwargs)
        except CrawlerError:
            if not JINA_FALLBACK_ENABLED:
                raise
            logger.warning("Spider fetch_urls failed (%d urls) — falling back to Jina", len(urls), exc_info=True)
            return await _jina_fetch_urls(urls, **kwargs)
    return await _spider_fetch_urls(urls, **kwargs)
```
> Remove the `_spider_unused`/`MAX_CRAWL_DEPTH_DEFAULT` scaffolding lines — they're illustrative; keep only the real imports (`CRAWL_PROVIDER`, `JINA_FALLBACK_ENABLED`, `CrawlerError`, `_spider_crawl`, `_spider_fetch_urls`, `_jina_fetch_urls`, `_discover_urls`). Confirm `discover_website_urls`'s real signature (`url, max_urls, timeout`) before wiring.

- [ ] **Step 4: Run → PASS + regression** `.venv/bin/python -m pytest tests/ -k "crawl or provider or orchestrator" --no-cov -q`. **Step 5: Commit** `feat(crawl): Jina fallback in provider; drop Playwright fallback path`.

---

### Task 7: FINAL CLEANUP — remove the old stack

**Files:** Delete `api/app/services/crawler_script.py`; prune `crawler_service.py`; edit `pyproject.toml`; drop dead tests.

- [ ] **Step 1:** Confirm the local crawler is unreferenced at runtime:
```bash
cd api
grep -rnE "crawler_script|crawl4ai|from playwright|import playwright|fastembed|_fastembed|_openai_embed|FASTEMBED_MODEL" app/ | grep -v __pycache__
```
Every hit must be inside code being deleted in this task (or a comment). If `crawler_service.crawl_website` (the subprocess launcher) is referenced anywhere other than the old `crawl_provider` import we just removed, stop and reconcile.

- [ ] **Step 2:** Delete `api/app/services/crawler_script.py`. In `crawler_service.py`, remove `crawl_website` + its subprocess/`crawl4ai` helpers, **keeping** `CrawlerError`, `CrawlCancelled`, `is_cancellation_requested`, `acquire_crawl_lock`, `release_crawl_lock`, `set_crawl_progress`, `get_crawl_progress`, `request_cancellation` (all used by the Spider/Jina paths and routes).

- [ ] **Step 3:** `pyproject.toml` — remove `fastembed`, `crawl4ai`, `playwright`, `playwright-stealth`. Then:
```bash
cd api && VIRTUAL_ENV="$(pwd)/.venv" uv pip uninstall fastembed crawl4ai playwright playwright-stealth 2>&1 | tail
.venv/bin/python -c "import app.main; print('app.main imports OK')"
```

- [ ] **Step 4:** Delete now-dead tests referencing the removed code (e.g. any `test_crawler_script*`, FastEmbed/OpenAI-embed tests, and the old `test_crawl_provider_fetch_urls.py::test_fetch_urls_falls_back_to_recursive_crawl` which asserted the Playwright fallback — replaced by the Jina fallback test in Task 6). Run the full suite:
```bash
.venv/bin/python -m pytest -q
```
Fix any import errors from the deletions until green.

- [ ] **Step 5: Commit** `chore(cleanup): remove FastEmbed, crawl4ai, Playwright, and the local crawler`.

---

### Task 8: Env, deploy, checks, rollout (no new code)

- [ ] **Step 1:** `.env.example` — add `EMBED_PROVIDER=google`, `GEMINI_EMBED_MODEL=gemini-embedding-001`, `EMBED_DIMENSIONS=768`, `JINA_API_KEY=`, `JINA_FALLBACK_ENABLED=true`; remove `FASTEMBED_MODEL`, `CRAWL_PROVIDER=playwright` default note, `SPIDER_FALLBACK_TO_PLAYWRIGHT`.
- [ ] **Step 2:** `deploy-api.yml` — add `EMBED_PROVIDER`, `GEMINI_EMBED_MODEL`, `EMBED_DIMENSIONS`, `JINA_API_KEY`, `JINA_FALLBACK_ENABLED` to the env map + `envs:` list + the `.env` printf; remove the `SPIDER_FALLBACK_TO_PLAYWRIGHT` line (Jina fallback replaces it). `GOOGLE_API_KEY` is already wired.
- [ ] **Step 3:** GitHub secrets: `printf 'google' | gh secret set EMBED_PROVIDER`; set `JINA_API_KEY` (or leave keyless); confirm `GOOGLE_API_KEY` exists. Delete stale `SPIDER_FALLBACK_TO_PLAYWRIGHT` secret (`gh secret delete SPIDER_FALLBACK_TO_PLAYWRIGHT`).
- [ ] **Step 4: Baseline checks:** `cd api && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/python -m pytest -q` → lint ✓ · format ✓ · tests ✓.
- [ ] **Step 5: Local smoke:** restart API+worker; crawl a small site (Spider path) → confirm ingestion; temporarily set a bad `SPIDER_API_KEY` locally → confirm Jina fallback fires; confirm embeddings are 768-dim in pgvector (`SELECT vector_dims(embedding) FROM documents LIMIT 1;`).
- [ ] **Step 6:** Push `development`; open PR → `main`. On merge, deploy regenerates `.env` (Google embed + Jina fallback, no Playwright/FastEmbed) and `uv sync` installs the slimmer dep set.

---

## Self-Review
- **Spec coverage:** Google embedding (T1–T3), query degradation already-present (T4), Jina fallback (T5–T6), old-stack removal (T7), env/deploy/rollout (T8). ✓
- **Placeholders:** real code for the two new services + embedder; cleanup steps give exact files/greps to confirm before deleting. The `crawl_provider` illustrative imports are explicitly flagged to prune. ✓
- **Type consistency:** `fetch_urls(urls, *, use_js, client_id)` and the `{results, recommended_colors, discovered_total, queue_remaining}` shape are identical across `spider_service`, `jina_service`, `crawl_provider`; `embed_texts`/`embed_chunks` both return `list[list[float]]` at 768 dims. ✓
- **Fresh-DB:** no re-embed/migration tasks (per user); column already `Vector(768)`. ✓
- **No cross-model embedding fallback** (dimension/vector-space constraint respected): Google is sole embedder; resilience = ARQ retry (ingest) + full-text degrade (query). ✓
