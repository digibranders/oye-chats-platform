# Spider.cloud Crawl Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move web crawling off the app server by adding Spider.cloud as a drop-in crawl provider behind a feature flag, keeping the existing chunk → embed → store → credit pipeline unchanged.

**Architecture:** Introduce a `crawl_provider` seam. `run_full_crawl` currently calls `crawler_service.crawl_website` (local Playwright/Chromium subprocess). We add `spider_service.crawl_website` that calls Spider's HTTP API and returns the **exact same `crawl_data` shape** (`{"results": [{"url","content"}], "recommended_colors", "discovered_total", "queue_remaining"}`). A thin `crawl_provider.crawl_website` dispatches to Spider or Playwright based on env `CRAWL_PROVIDER`, with optional fallback to Playwright on Spider failure. Nothing downstream changes — credit deduction (`url_scan`, 5 credits/page), embedding (local FastEmbed), storage, brand extraction, and orphan sweep all keep working as-is.

**Tech Stack:** Python 3.11 · FastAPI · ARQ worker · `httpx` (already a dep) · pytest. HTTP mocking via `httpx.MockTransport` (no new dependency).

---

## Pre-flight (do once, not a code task)

- [ ] Confirm you are on the **`development`** branch (never `main`): `git branch --show-current` → must print `development`. If not: `git checkout development`.
- [ ] Confirm `httpx>=0.27.0` is in `api/pyproject.toml` (it is) and run `cd api && uv sync`.
- [ ] Obtain a Spider.cloud API key and top up a small test balance ($5–25). Keep it out of git.

---

## File Structure

**Create:**
- `api/app/services/spider_service.py` — Spider HTTP client + `crawl_website()` returning the crawl_data shape.
- `api/app/services/crawl_provider.py` — provider dispatch (Spider vs Playwright) + fallback.
- `api/tests/test_spider_service.py` — client mapping / error / timeout tests (MockTransport).
- `api/tests/test_crawl_provider.py` — dispatch + fallback tests.

**Modify:**
- `api/app/config.py` — Spider env vars.
- `api/app/services/crawl_orchestrator.py` — call `crawl_provider.crawl_website` instead of `crawler_service.crawl_website`.
- `api/tests/test_crawl_orchestrator_provider.py` — new test asserting orchestrator uses the provider (create).
- `api/.env.example` — document new env vars.
- `api/systemd/oyechats-worker.service` and `oyechats-api.service` — pass `SPIDER_API_KEY` / `CRAWL_PROVIDER` (documented, applied on server).
- `DEPLOYMENT.md` — new GitHub secret + env rows.

---

### Task 1: Spider configuration in `config.py`

**Files:**
- Modify: `api/app/config.py` (append to the "Directories & Crawler" section)
- Test: `api/tests/test_spider_config.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_spider_config.py
import importlib


def test_spider_defaults(monkeypatch):
    for k in ("CRAWL_PROVIDER", "SPIDER_API_KEY", "SPIDER_API_URL",
              "SPIDER_REQUEST_MODE", "SPIDER_TIMEOUT", "SPIDER_FALLBACK_TO_PLAYWRIGHT"):
        monkeypatch.delenv(k, raising=False)
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.CRAWL_PROVIDER == "playwright"          # safe default: no behavior change on deploy
    assert cfg.SPIDER_API_URL == "https://api.spider.cloud"
    assert cfg.SPIDER_TIMEOUT == 1600
    assert cfg.SPIDER_FALLBACK_TO_PLAYWRIGHT is True


def test_spider_enabled_via_env(monkeypatch):
    monkeypatch.setenv("CRAWL_PROVIDER", "spider")
    monkeypatch.setenv("SPIDER_API_KEY", "sk-test")
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.CRAWL_PROVIDER == "spider"
    assert cfg.SPIDER_API_KEY == "sk-test"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_spider_config.py -v`
Expected: FAIL with `AttributeError: module 'app.config' has no attribute 'CRAWL_PROVIDER'`

- [ ] **Step 3: Add the config block**

Append to `api/app/config.py` (after the existing Crawler defaults comment block):

```python
# ─────────────────────────────────────────────────────────────────────────────
# Crawl provider (Playwright self-host vs Spider.cloud managed API)
# ─────────────────────────────────────────────────────────────────────────────
# "playwright" (default, existing subprocess crawler) or "spider" (managed API).
CRAWL_PROVIDER = os.getenv("CRAWL_PROVIDER", "playwright").strip().lower()
SPIDER_API_KEY = os.getenv("SPIDER_API_KEY")
SPIDER_API_URL = os.getenv("SPIDER_API_URL", "https://api.spider.cloud").rstrip("/")
# Spider request engine: "http" (fast, no JS), "chrome" (JS render), "smart" (auto).
SPIDER_REQUEST_MODE = os.getenv("SPIDER_REQUEST_MODE", "smart").strip().lower()
# Per-crawl wall-clock budget (seconds). Mirrors CRAWL_SUBPROCESS_TIMEOUT.
SPIDER_TIMEOUT = int(os.getenv("SPIDER_TIMEOUT", "1600"))
# If Spider raises, fall back to the local Playwright crawler for that crawl.
SPIDER_FALLBACK_TO_PLAYWRIGHT = os.getenv(
    "SPIDER_FALLBACK_TO_PLAYWRIGHT", "true"
).strip().lower() in ("1", "true", "yes")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_spider_config.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add api/app/config.py api/tests/test_spider_config.py
git commit -m "feat(crawl): add Spider.cloud provider config (defaults to playwright)"
```

---

### Task 2: Spider API client — `spider_service.crawl_website`

**Files:**
- Create: `api/app/services/spider_service.py`
- Test: `api/tests/test_spider_service.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_spider_service.py
import json
import httpx
import pytest

from app.services import spider_service
from app.services.crawler_service import CrawlerError


def _mock_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_crawl_returns_results_shape(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/crawl"
        body = json.loads(request.content)
        assert body["url"] == "https://acme.test"
        assert body["limit"] == 500
        assert body["return_format"] == "markdown"
        assert request.headers["authorization"] == "Bearer sk-test"
        return httpx.Response(200, json=[
            {"url": "https://acme.test", "content": "# Home", "status": 200},
            {"url": "https://acme.test/about", "content": "# About", "status": 200},
            {"url": "https://acme.test/dead", "content": None, "status": 500, "error": "blocked"},
        ])

    data = await spider_service.crawl_website(
        "https://acme.test", max_pages=500, use_js=False, client_id=1,
        _client=_mock_client(handler),
    )
    urls = [p["url"] for p in data["results"]]
    assert urls == ["https://acme.test", "https://acme.test/about"]  # None-content dropped
    assert data["results"][0]["content"] == "# Home"
    assert data["discovered_total"] == 3
    assert data["queue_remaining"] == 0
    assert data["recommended_colors"] == []


@pytest.mark.asyncio
async def test_use_js_selects_chrome_engine(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "SPIDER_REQUEST_MODE", "smart")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = json.loads(request.content)["request"]
        return httpx.Response(200, json=[{"url": "u", "content": "x", "status": 200}])

    await spider_service.crawl_website(
        "https://acme.test", max_pages=10, use_js=True, client_id=1,
        _client=_mock_client(handler),
    )
    assert seen["request"] == "chrome"  # use_js overrides smart -> chrome


@pytest.mark.asyncio
async def test_http_error_raises_crawler_error(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": "insufficient balance"})

    with pytest.raises(CrawlerError):
        await spider_service.crawl_website(
            "https://acme.test", max_pages=10, use_js=False, client_id=1,
            _client=_mock_client(handler),
        )


@pytest.mark.asyncio
async def test_missing_api_key_raises(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", None)
    with pytest.raises(CrawlerError):
        await spider_service.crawl_website(
            "https://acme.test", max_pages=10, use_js=False, client_id=1,
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_spider_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.spider_service'`

- [ ] **Step 3: Implement `spider_service.py`**

```python
# api/app/services/spider_service.py
"""Spider.cloud crawl provider.

Calls Spider's managed crawl API and returns the SAME payload shape as
``crawler_service.crawl_website`` so ``crawl_orchestrator.run_full_crawl`` can
consume it unchanged:

    {"results": [{"url": str, "content": str}, ...],
     "recommended_colors": [],
     "discovered_total": int,
     "queue_remaining": int}

Browser rendering happens on Spider's infrastructure, so this path uses no
local Chromium — that is the whole point of the migration.
"""

import logging

import httpx

from app.config import (
    SPIDER_API_KEY,
    SPIDER_API_URL,
    SPIDER_REQUEST_MODE,
    SPIDER_TIMEOUT,
)
from app.services.crawler_service import CrawlerError

logger = logging.getLogger(__name__)


def _engine(use_js: bool) -> str:
    """Map our ``use_js`` flag onto Spider's ``request`` engine."""
    if use_js:
        return "chrome"          # force full JS render
    if SPIDER_REQUEST_MODE in ("http", "chrome", "smart"):
        return "http" if SPIDER_REQUEST_MODE == "smart" else SPIDER_REQUEST_MODE
    return "http"


async def crawl_website(
    url: str,
    *,
    max_pages: int | None = None,
    use_js: bool = False,
    client_id: int | None = None,
    max_depth: int | None = None,
    concurrency: int | None = None,
    _client: httpx.AsyncClient | None = None,
) -> dict:
    """Crawl ``url`` via Spider and return the orchestrator's crawl_data shape.

    ``concurrency`` is accepted for signature parity with the Playwright
    provider but is managed Spider-side, so it is not forwarded.
    """
    if not SPIDER_API_KEY:
        raise CrawlerError("SPIDER_API_KEY is not configured")

    payload: dict = {
        "url": url,
        "limit": int(max_pages) if max_pages else 0,   # 0 = Spider default cap
        "return_format": "markdown",
        "request": _engine(use_js),
        "readability": True,
        "store_data": False,
    }
    if max_depth:
        payload["depth"] = int(max_depth)

    headers = {
        "Authorization": f"Bearer {SPIDER_API_KEY}",
        "Content-Type": "application/json",
    }

    owns_client = _client is None
    client = _client or httpx.AsyncClient(timeout=SPIDER_TIMEOUT)
    try:
        resp = await client.post(f"{SPIDER_API_URL}/crawl", json=payload, headers=headers)
    except httpx.HTTPError as exc:
        raise CrawlerError(f"Spider request failed: {exc}") from exc
    finally:
        if owns_client:
            await client.aclose()

    if resp.status_code >= 400:
        raise CrawlerError(f"Spider returned {resp.status_code}: {resp.text[:300]}")

    try:
        pages = resp.json()
    except ValueError as exc:
        raise CrawlerError(f"Spider returned non-JSON body: {exc}") from exc
    if not isinstance(pages, list):
        raise CrawlerError(f"Spider returned unexpected payload type: {type(pages).__name__}")

    results = [
        {"url": p["url"], "content": p["content"]}
        for p in pages
        if isinstance(p, dict) and p.get("url") and p.get("content")
    ]
    logger.info(
        "Spider crawl %s: %d/%d pages with content (client=%s)",
        url, len(results), len(pages), client_id,
    )
    return {
        "results": results,
        "recommended_colors": [],       # Spider does not extract colors
        "discovered_total": len(pages),
        "queue_remaining": 0,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_spider_service.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add api/app/services/spider_service.py api/tests/test_spider_service.py
git commit -m "feat(crawl): add Spider.cloud client returning orchestrator crawl_data shape"
```

---

### Task 3: Provider dispatch + fallback — `crawl_provider.crawl_website`

**Files:**
- Create: `api/app/services/crawl_provider.py`
- Test: `api/tests/test_crawl_provider.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_crawl_provider.py
import pytest

from app.services import crawl_provider
from app.services.crawler_service import CrawlerError


@pytest.mark.asyncio
async def test_dispatches_to_playwright_by_default(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "playwright")
    called = {}

    async def fake_pw(url, **kw):
        called["pw"] = True
        return {"results": [{"url": url, "content": "pw"}], "recommended_colors": [],
                "discovered_total": 1, "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_playwright_crawl", fake_pw)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
    assert called.get("pw") is True
    assert data["results"][0]["content"] == "pw"


@pytest.mark.asyncio
async def test_dispatches_to_spider(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", False)

    async def fake_spider(url, **kw):
        return {"results": [{"url": url, "content": "spider"}], "recommended_colors": [],
                "discovered_total": 1, "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_crawl", fake_spider)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "spider"


@pytest.mark.asyncio
async def test_spider_failure_falls_back_to_playwright(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", True)

    async def boom_spider(url, **kw):
        raise CrawlerError("spider down")

    async def fake_pw(url, **kw):
        return {"results": [{"url": url, "content": "pw-fallback"}], "recommended_colors": [],
                "discovered_total": 1, "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)
    monkeypatch.setattr(crawl_provider, "_playwright_crawl", fake_pw)
    data = await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
    assert data["results"][0]["content"] == "pw-fallback"


@pytest.mark.asyncio
async def test_spider_failure_without_fallback_reraises(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", False)

    async def boom_spider(url, **kw):
        raise CrawlerError("spider down")

    monkeypatch.setattr(crawl_provider, "_spider_crawl", boom_spider)
    with pytest.raises(CrawlerError):
        await crawl_provider.crawl_website("https://a.test", max_pages=1, use_js=False, client_id=1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_crawl_provider.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.crawl_provider'`

- [ ] **Step 3: Implement `crawl_provider.py`**

```python
# api/app/services/crawl_provider.py
"""Selects the crawl backend (Playwright self-host vs Spider.cloud managed API).

``run_full_crawl`` imports ``crawl_website`` from here instead of directly from
``crawler_service``. Both backends return the identical crawl_data shape, so the
downstream ingest pipeline is provider-agnostic.
"""

import logging

from app.config import CRAWL_PROVIDER, SPIDER_FALLBACK_TO_PLAYWRIGHT
from app.services.crawler_service import CrawlerError
from app.services.crawler_service import crawl_website as _playwright_crawl
from app.services.spider_service import crawl_website as _spider_crawl

logger = logging.getLogger(__name__)


async def crawl_website(url: str, **kwargs) -> dict:
    """Dispatch to the configured crawl provider.

    ``kwargs`` are forwarded verbatim: ``max_pages``, ``use_js``, ``client_id``,
    ``max_depth``, ``concurrency``.
    """
    if CRAWL_PROVIDER == "spider":
        try:
            return await _spider_crawl(url, **kwargs)
        except CrawlerError:
            if not SPIDER_FALLBACK_TO_PLAYWRIGHT:
                raise
            logger.warning(
                "Spider crawl failed for %s — falling back to Playwright", url, exc_info=True
            )
            return await _playwright_crawl(url, **kwargs)
    return await _playwright_crawl(url, **kwargs)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_crawl_provider.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add api/app/services/crawl_provider.py api/tests/test_crawl_provider.py
git commit -m "feat(crawl): add provider dispatch with Spider->Playwright fallback"
```

---

### Task 4: Wire the orchestrator to the provider

**Files:**
- Modify: `api/app/services/crawl_orchestrator.py` (the import block near line 31, and the `crawl_website(...)` call inside `run_full_crawl`)
- Test: `api/tests/test_crawl_orchestrator_provider.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_crawl_orchestrator_provider.py
import pytest

import app.services.crawl_orchestrator as orch


@pytest.mark.asyncio
async def test_run_full_crawl_uses_provider(monkeypatch):
    """run_full_crawl must call crawl_provider.crawl_website, not the Playwright
    subprocess directly, and pass the crawled pages to batch_web_ingestion."""
    seen = {}

    async def fake_provider_crawl(url, **kw):
        seen["url"] = url
        return {"results": [{"url": url, "content": "hello world"}],
                "recommended_colors": [], "discovered_total": 1, "queue_remaining": 0}

    def fake_ingest(client_id, pages, **kw):
        seen["pages"] = pages
        return {"chunks": 1, "pages_charged": 1, "credits_deducted": 5}

    monkeypatch.setattr(orch, "crawl_website", fake_provider_crawl)
    monkeypatch.setattr(orch, "batch_web_ingestion", fake_ingest)
    monkeypatch.setattr(orch, "set_crawl_progress", lambda *a, **k: None)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)

    result = await orch.run_full_crawl(
        client_id=1, bot_id=None, url="https://acme.test", max_pages=10,
        use_js=False, replace_source=None, cost_per_page=5,
    )
    assert seen["url"] == "https://acme.test"
    assert seen["pages"] == [{"url": "https://acme.test", "content": "hello world"}]
    assert result["chunks"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_crawl_orchestrator_provider.py -v`
Expected: FAIL — `run_full_crawl` still imports `crawl_website` from `crawler_service`, so `monkeypatch.setattr(orch, "crawl_website", ...)` patches a name that the real subprocess path may bypass, or the assertion on `seen["url"]` fails because the real crawler runs. (If it errors on the subprocess, that also counts as fail.)

- [ ] **Step 3: Change the orchestrator import**

In `api/app/services/crawl_orchestrator.py`, find the import block (around line 31):

```python
from app.services.crawler_service import (
    CrawlCancelled,
    CrawlerError,
    crawl_website,
    release_crawl_lock,
    set_crawl_progress,
)
```

Replace it with (move `crawl_website` to the provider module; keep the rest from `crawler_service`):

```python
from app.services.crawl_provider import crawl_website
from app.services.crawler_service import (
    CrawlCancelled,
    CrawlerError,
    release_crawl_lock,
    set_crawl_progress,
)
```

Leave the `crawl_website(...)` call inside `run_full_crawl` exactly as-is — it already passes `max_pages`, `use_js`, `client_id`, `max_depth`, `concurrency`, all of which the provider forwards.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_crawl_orchestrator_provider.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Run the full crawl-related suite to confirm no regression**

Run: `cd api && uv run pytest tests/ -k "crawl or orchestrator or ingest" -v`
Expected: PASS (existing crawl/ingest tests still green — the Playwright default path is unchanged)

- [ ] **Step 6: Commit**

```bash
git add api/app/services/crawl_orchestrator.py api/tests/test_crawl_orchestrator_provider.py
git commit -m "feat(crawl): route orchestrator through crawl_provider seam"
```

---

### Task 5: Cancellation + coarse progress for the Spider path

**Context:** The Playwright path streams progress from a subprocess file and cancels via SIGTERM. Spider returns pages in one API call, so we (a) short-circuit before the call if the client already requested cancel, and (b) publish coarse progress (`running` → terminal handled by the orchestrator). This keeps the existing Cancel button honest without a subprocess.

**Files:**
- Modify: `api/app/services/spider_service.py`
- Test: `api/tests/test_spider_service.py` (add one test)

- [ ] **Step 1: Write the failing test (append to `test_spider_service.py`)**

```python
@pytest.mark.asyncio
async def test_precancelled_crawl_returns_empty(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: True)

    called = {"http": False}

    def handler(request):  # pragma: no cover - must NOT be called
        called["http"] = True
        return httpx.Response(200, json=[])

    data = await spider_service.crawl_website(
        "https://acme.test", max_pages=10, use_js=False, client_id=7,
        _client=_mock_client(handler),
    )
    assert data["results"] == []
    assert called["http"] is False   # we never hit Spider once cancel is set
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_spider_service.py::test_precancelled_crawl_returns_empty -v`
Expected: FAIL with `AttributeError: module 'app.services.spider_service' has no attribute 'is_cancellation_requested'`

- [ ] **Step 3: Add the pre-cancel check**

In `api/app/services/spider_service.py`, add to the imports:

```python
from app.services.crawler_service import CrawlerError, is_cancellation_requested
```

(remove the standalone `from app.services.crawler_service import CrawlerError` line — fold it into the line above.)

Then, at the top of `crawl_website`, right after the `SPIDER_API_KEY` check:

```python
    if client_id is not None and is_cancellation_requested(client_id):
        logger.info("Spider crawl aborted before start (cancel requested) client=%s", client_id)
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_spider_service.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add api/app/services/spider_service.py api/tests/test_spider_service.py
git commit -m "feat(crawl): honor cancel flag before issuing Spider request"
```

---

### Task 6: Secrets & deployment config

**Files:**
- Modify: `api/.env.example`
- Modify: `DEPLOYMENT.md`
- Modify: `api/systemd/oyechats-worker.service`, `api/systemd/oyechats-api.service`

- [ ] **Step 1: Document env vars in `api/.env.example`**

Append:

```
# ── Crawl provider ──────────────────────────────────────────────
# playwright (default) | spider
CRAWL_PROVIDER=playwright
SPIDER_API_KEY=
SPIDER_API_URL=https://api.spider.cloud
SPIDER_REQUEST_MODE=smart
SPIDER_TIMEOUT=1600
SPIDER_FALLBACK_TO_PLAYWRIGHT=true
```

- [ ] **Step 2: Add the systemd env lines (both units)**

In `api/systemd/oyechats-worker.service` and `oyechats-api.service`, under `[Service]`, add:

```
Environment=CRAWL_PROVIDER=spider
Environment=SPIDER_API_KEY=__SET_ON_SERVER__
Environment=SPIDER_REQUEST_MODE=smart
Environment=SPIDER_FALLBACK_TO_PLAYWRIGHT=true
```

> Do NOT commit the real key. On the droplet, place the key in the unit (or an `EnvironmentFile=`) and `systemctl daemon-reload`.

- [ ] **Step 3: Add the GitHub secret row to `DEPLOYMENT.md`**

In the "GitHub Actions Secrets → Platform Repo" table, add:

```
| `SPIDER_API_KEY` | Spider.cloud API key (managed crawl provider) |
| `CRAWL_PROVIDER` | `spider` to use managed crawling, else `playwright` |
```

- [ ] **Step 4: Commit**

```bash
git add api/.env.example DEPLOYMENT.md api/systemd/oyechats-worker.service api/systemd/oyechats-api.service
git commit -m "chore(crawl): document Spider env + deploy secrets"
```

---

### Task 7: Post-cutover worker tuning + cost logging

**Context:** With crawling offloaded, ARQ jobs are I/O-bound (no Chromium RAM), so `max_jobs` can rise. We also log per-crawl page counts so cost can be reconciled against the Spider bill.

**Files:**
- Modify: `api/app/worker/settings.py` (raise `WORKER_MAX_JOBS` default only after Spider is the live provider)
- Modify: `api/app/services/spider_service.py` (structured cost-signal log)
- Test: `api/tests/test_spider_service.py` (assert the cost log line)

- [ ] **Step 1: Write the failing test (append)**

```python
@pytest.mark.asyncio
async def test_logs_page_count_for_cost_tracking(monkeypatch, caplog):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: False)

    def handler(request):
        return httpx.Response(200, json=[
            {"url": "u1", "content": "a", "status": 200},
            {"url": "u2", "content": "b", "status": 200},
        ])

    import logging
    with caplog.at_level(logging.INFO):
        await spider_service.crawl_website(
            "https://acme.test", max_pages=10, use_js=True, client_id=9,
            _client=_mock_client(handler),
        )
    assert any("spider_cost" in r.message and "pages=2" in r.message for r in caplog.records)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_spider_service.py::test_logs_page_count_for_cost_tracking -v`
Expected: FAIL (no `spider_cost` log line yet)

- [ ] **Step 3: Add the cost-signal log**

In `spider_service.crawl_website`, replace the existing `logger.info("Spider crawl %s: ...")` line with:

```python
    logger.info(
        "Spider crawl %s: %d/%d pages with content (client=%s)",
        url, len(results), len(pages), client_id,
    )
    logger.info(
        "spider_cost client=%s engine=%s pages=%d discovered=%d",
        client_id, _engine(use_js), len(results), len(pages),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_spider_service.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Raise the worker job ceiling (guarded)**

In `api/app/worker/settings.py`, change the `max_jobs` default from `2` to `5` **only** once `CRAWL_PROVIDER=spider` is live in production (Chromium no longer runs on the box, so RAM no longer caps concurrency). Keep it env-overridable:

```python
    max_jobs = int(os.getenv("WORKER_MAX_JOBS", "5"))
```

> If rolling out gradually, leave this at 2 and set `WORKER_MAX_JOBS=5` via env on the server after cutover instead of editing the default.

- [ ] **Step 6: Commit**

```bash
git add api/app/services/spider_service.py api/app/worker/settings.py api/tests/test_spider_service.py
git commit -m "feat(crawl): log per-crawl page counts; raise worker max_jobs post-offload"
```

---

### Task 8: Rollout, verification & baseline checks (no code)

- [ ] **Step 1: Run the mandatory pre-completion checks (per CLAUDE.md)**

```bash
cd api
uv run ruff check .
uv run ruff format --check .
uv run pytest
```
Expected: lint ✓ · format ✓ · tests ✓. Fix anything red before proceeding.

- [ ] **Step 2: Calibrate real per-page cost with a staging test crawl**

With `CRAWL_PROVIDER=spider` and a funded key in a **staging/dev** env, crawl one representative tenant site (~500 pages). Read the Spider dashboard bill and confirm the effective $/1K matches the ~$0.15–0.48 estimate. Record the number.

- [ ] **Step 3: Canary in production**

On the droplet: set `SPIDER_API_KEY`, keep `CRAWL_PROVIDER=playwright` globally, then flip **one** internal test bot to Spider (temporary env or a per-crawl override) and run a real crawl. Confirm via `journalctl -u oyechats-worker -f`:
- `spider_cost ... pages=N` line appears,
- no Chromium processes spawn (`pgrep -c chrome` stays 0 during the crawl),
- pages ingest and credits deduct (`SELECT COUNT(*) FROM documents WHERE ...`).

- [ ] **Step 4: Cut over**

Set `CRAWL_PROVIDER=spider` + `WORKER_MAX_JOBS=5` on the droplet, `systemctl daemon-reload && systemctl restart oyechats-worker oyechats-api`. Keep `SPIDER_FALLBACK_TO_PLAYWRIGHT=true` for the first 2 weeks so any Spider incident silently falls back.

- [ ] **Step 5: Monitor for 48h**

Watch RAM (`free -h` stays well under 4 GB during concurrent crawls), the `spider_cost` logs, and the Spider balance burn-down. Confirm the OOM/worker-restart pattern is gone.

- [ ] **Step 6: (Later, separate PR) reclaim RAM**

Once Spider is stable for ~2 weeks and fallback hasn't fired, open a follow-up to drop Chromium/Playwright from the runtime image (`playwright install` step, browser binaries) to reclaim disk/RAM. Do NOT do this in the migration PR — the fallback needs Playwright present.

- [ ] **Step 7: Open the PR**

```bash
git push origin development
```
Create a PR `development → main` on GitHub for review/merge (never push to `main` directly).

---

## Self-Review notes (author)

- **Spec coverage:** provider seam (Tasks 2–4), config/flag (Task 1), cancellation parity (Task 5), secrets/deploy (Task 6), worker tuning + cost observability (Task 7), rollout/canary/fallback (Task 8). ✓
- **Type consistency:** `crawl_website(url, *, max_pages, use_js, client_id, max_depth, concurrency)` signature is identical across `spider_service`, `crawl_provider`, and the existing `crawler_service`; all return `{"results","recommended_colors","discovered_total","queue_remaining"}`. `batch_web_ingestion` consumes `[{"url","content"}]` — matched by `results`. ✓
- **No behavior change on deploy:** `CRAWL_PROVIDER` defaults to `playwright`; Spider only activates when explicitly set. Fallback flag defaults on. ✓
- **Credit system untouched:** `cost_per_page` (`url_scan` = 5 credits) still resolved at the route and applied in `batch_web_ingestion`. ✓
