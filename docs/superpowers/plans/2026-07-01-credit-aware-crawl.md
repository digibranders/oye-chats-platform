# Credit-Aware Crawl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before crawling, show the user how many pages the site has vs. what their credits can afford, and let them pick a page count (capped at affordable) and an order, then crawl exactly that slice.

**Architecture:** Reuse the existing `POST /crawl/discover` (page discovery) + `credit_service` (cost/balance). Discovery already returns a flat list of URL strings, so **ordering is a frontend sort** of that list (shallow = by URL path-depth, as-discovered = list order). The backend gains one capability — fetch an explicit `ordered_urls` list → `batch_web_ingestion` — reusing the atomic per-page billing that already stops cleanly on insufficient credits. The normal (fits-budget) crawl path is untouched.

**Tech Stack:** FastAPI · ARQ · httpx · Spider.cloud provider (with Playwright fallback) · pytest · React/Vite (lint+build, no JS test runner).

**Design spec:** `docs/superpowers/specs/2026-07-01-credit-aware-crawl-design.md`

**Refinement vs spec:** The spec proposed a backend `crawl_order` enum. During planning we found `discover_website_urls` returns plain URL strings and `/crawl/discover` already runs discovery — so ordering is done frontend-side by sorting the returned list, and the backend only needs an `ordered_urls` param. Simpler, fewer moving parts, same UX.

**Revised after CTO review (2026-07-01):** fixes applied inline — (1) skip orphan-sweep on partial crawls to prevent data loss; (2) Playwright fallback reuses recursive `crawl_website` (the assumed `crawl_single_http`/`aiohttp` path was in the wrong module and used an undeclared dep); (3) discover balance is **bot-scoped**; (4) tests use the real `TestClient` + dependency-override harness (mirroring `tests/test_document_routes.py`); (5) `fetch_urls` honors the cancel flag; (6) discover credit lookups sit in the pre-discovery session block; (7) Task 2 verifies Spider's `/scrape` shape first; (8) discover rate-limit raised; (9) modal shows "capped" state.

---

## Pre-flight

- [ ] On branch `development` (`git branch --show-current` → `development`).
- [ ] Backend commands run from `api/` using `.venv/bin/python -m pytest ... --no-cov` (local `uv run` is unreliable here; `.venv` binaries work). Frontend from `app/`.

## File Structure

**Backend (modify):**
- `api/app/api/document_routes.py` — `/crawl/discover` response gains credit math + `urls`; `/crawl` accepts `ordered_urls`.
- `api/app/schemas/client.py` — `CrawlRequest.ordered_urls`; new `CrawlDiscoverResponse` fields.
- `api/app/services/spider_service.py` — add `fetch_urls()` (scrape an explicit list).
- `api/app/services/crawl_provider.py` — add `fetch_urls()` dispatch; fallback reuses recursive `crawl_website` (no new `crawler_service.fetch_urls`).
- `api/app/services/crawl_orchestrator.py` — `run_full_crawl` branches to fetch-list when `ordered_urls` given, **and skips the orphan-sweep on partial crawls**.
- `api/app/worker/tasks.py` — `task_crawl_and_ingest` passes `ordered_urls` through.

**Frontend (modify):**
- `app/src/pages/KnowledgeBase.jsx` — estimate modal.
- `app/src/services/api.js` — `discoverCrawlUrls` returns new fields; `startCrawl` accepts `orderedUrls`.

---

### Task 1: `/crawl/discover` returns credit math + URL list

**Files:**
- Modify: `api/app/api/document_routes.py` (the `return {...}` in `crawl_discover_endpoint`, ~line 553)
- Test: `api/tests/test_crawl_discover_credits.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_crawl_discover_credits.py
# Mirrors the harness in tests/test_document_routes.py: bare FastAPI app +
# router + dependency overrides + monkeypatched get_session. No async_client.
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import document_routes
from app.api.auth import get_current_client_or_operator, require_active_subscription_for_workspace
from app.api.document_routes import router
from app.services.plan_service import UNLIMITED


@contextmanager
def _session_ctx(session):
    yield session


def _build_app():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client", "entity": SimpleNamespace(id=1), "client_id": 1, "operator_id": None,
    }
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    return app


def test_discover_returns_credit_math(monkeypatch):
    """/crawl/discover returns cost_per_page, (bot-scoped) balance,
    max_affordable_pages, credits_required_full, exceeds_balance, and urls."""
    fake_urls = [f"https://acme.test/p{i}" for i in range(30)]  # 30 pages

    monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(MagicMock()))
    monkeypatch.setattr(
        "app.services.plan_service.get_client_plan", lambda db, cid: SimpleNamespace(name="Standard")
    )
    monkeypatch.setattr(
        "app.services.plan_service.get_crawl_limits", lambda plan: {"max_crawl_pages": UNLIMITED}
    )

    async def _fake_discover(url, max_urls, timeout):
        return fake_urls

    monkeypatch.setattr("app.services.url_discovery.discover_website_urls", _fake_discover)
    monkeypatch.setattr("app.services.credit_service.get_credit_cost", lambda db, action: 5)
    # 100 credits -> 20 affordable pages; assert bot_id is threaded through.
    monkeypatch.setattr(
        "app.services.credit_service.get_balance", lambda db, cid, bot_id=None: 100
    )

    resp = TestClient(_build_app()).post("/crawl/discover", json={"url": "https://acme.test"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_found"] == 30
    assert body["cost_per_page"] == 5
    assert body["balance"] == 100
    assert body["max_affordable_pages"] == 20          # 100 // 5
    assert body["credits_required_full"] == 150        # 30 * 5
    assert body["exceeds_balance"] is True             # 150 > 100
    assert body["urls"] == fake_urls
```

> **Harness note:** this exactly mirrors `tests/test_document_routes.py` (`_build_app` + `TestClient` + `monkeypatch.setattr(document_routes, "get_session", ...)`). The endpoint imports `plan_service`, `url_discovery`, and `credit_service` *inside* the function, so patch them on their source modules (as above). Open `test_document_routes.py` first and match its style.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_crawl_discover_credits.py -v --no-cov`
Expected: FAIL — response lacks `cost_per_page` (KeyError on assertion).

- [ ] **Step 3: Add credit math to the discover endpoint**

Two edits in `crawl_discover_endpoint`:

**(a)** Read the credit inputs **inside the existing pre-discovery `with get_session() as db:` block** (the one that resolves `plan`). Discovery runs *after* that block (a ~20s network call — do not hold a DB connection across it), so read the credit numbers first. Balance is **bot-scoped** (`bot_id` is already a param of this endpoint):

```python
    with get_session() as db:
        plan = plan_service.get_client_plan(db, client_id)
        crawl_limits = plan_service.get_crawl_limits(plan)
        plan_max = crawl_limits["max_crawl_pages"]
        # Credit inputs — read here, before the long discovery call.
        cost_per_page = credit_service.get_credit_cost(db, "url_scan")
        balance = credit_service.get_balance(db, client_id, bot_id=bot_id)
```
(add `from app.services import credit_service` to the local imports already present in this function.)

**(b)** After discovery, compute the derived values (pure arithmetic — no session) and return them. Also initialise `urls = []` before the `try` so the field is always safe:

```python
    per_page = max(int(cost_per_page), 1)
    max_affordable_pages = int(balance) // per_page
    credits_required_full = total * cost_per_page

    return {
        "url": discover_request.url,
        "total_found": total,
        "capped": total >= discovery_cap,
        "plan_max": plan_max,
        "urls": urls,
        "cost_per_page": cost_per_page,
        "balance": balance,
        "max_affordable_pages": max_affordable_pages,
        "credits_required_full": credits_required_full,
        "exceeds_balance": credits_required_full > balance,
    }
```

> Ensure `urls = []` is initialised before the `try:` that assigns it (on discovery failure `total` stays 0 and `urls` stays `[]`).

**(c)** Raise the discover rate limit — the new flow calls `/crawl/discover` before *every* crawl, so 30/hour will pinch a user onboarding several bots. Change the decorator on `crawl_discover_endpoint` from `@limiter.limit("30/hour", ...)` to `@limiter.limit("120/hour", ...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && .venv/bin/python -m pytest tests/test_crawl_discover_credits.py -v --no-cov`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/app/api/document_routes.py api/tests/test_crawl_discover_credits.py
git commit -m "feat(crawl): return credit math + url list from /crawl/discover"
```

---

### Task 2: Provider `fetch_urls` — scrape an explicit URL list

**Files:**
- Modify: `api/app/services/spider_service.py`
- Test: `api/tests/test_spider_fetch_urls.py` (create)

- [ ] **Step 0: Verify Spider's single-URL scrape contract (do this FIRST)**

The implementation below assumes `POST {SPIDER_API_URL}/scrape` with a JSON body returns a JSON **list** of page objects (`[{"url","content"}]`). Confirm the real endpoint path and response shape before coding, using the funded key already in `api/.env`:

```bash
cd api
.venv/bin/python - <<'PY'
import os, httpx
key = [l.split('=',1)[1].strip() for l in open('.env') if l.startswith('SPIDER_API_KEY=')][0]
r = httpx.post("https://api.spider.cloud/scrape",
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    json={"url": "https://example.com", "return_format": "markdown", "request": "http"}, timeout=60)
print("status", r.status_code); print("type", type(r.json()).__name__); print(str(r.json())[:400])
PY
```
If it returns an object (not a list), adjust `_scrape_one`'s parse line accordingly (`page = data if isinstance(data, dict) else (data[0] if data else None)`). If the endpoint name differs, use the confirmed one. Do not proceed until the shape is confirmed.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_spider_fetch_urls.py
import json

import httpx
import pytest

from app.services import spider_service
from app.services.crawler_service import CrawlerError


def _mock_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_urls_returns_results_in_order(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/scrape"
        body = json.loads(request.content)
        return httpx.Response(200, json=[{"url": body["url"], "content": f"md:{body['url']}"}])

    urls = ["https://acme.test/a", "https://acme.test/b"]
    data = await spider_service.fetch_urls(urls, use_js=False, client_id=1, _client=_mock_client(handler))
    assert [p["url"] for p in data["results"]] == urls          # order preserved
    assert data["results"][0]["content"] == "md:https://acme.test/a"
    assert data["discovered_total"] == 2


@pytest.mark.asyncio
async def test_fetch_urls_skips_failed_pages(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["url"].endswith("/bad"):
            return httpx.Response(200, json=[{"url": body["url"], "content": None}])
        return httpx.Response(200, json=[{"url": body["url"], "content": "ok"}])

    urls = ["https://acme.test/good", "https://acme.test/bad"]
    data = await spider_service.fetch_urls(urls, use_js=False, client_id=1, _client=_mock_client(handler))
    assert [p["url"] for p in data["results"]] == ["https://acme.test/good"]  # bad dropped


@pytest.mark.asyncio
async def test_fetch_urls_missing_key_raises(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", None)
    with pytest.raises(CrawlerError):
        await spider_service.fetch_urls(["https://acme.test/a"], use_js=False, client_id=1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_spider_fetch_urls.py -v --no-cov`
Expected: FAIL — `spider_service` has no attribute `fetch_urls`.

- [ ] **Step 3: Implement `fetch_urls` in `spider_service.py`**

Append to `api/app/services/spider_service.py`:

```python
import asyncio

_FETCH_CONCURRENCY = 5  # parallel scrape calls; Spider handles the render load


async def _scrape_one(
    client: httpx.AsyncClient, url: str, use_js: bool, sem: asyncio.Semaphore
) -> dict | None:
    """Scrape a single URL to markdown. Returns {url, content} or None on failure."""
    payload = {
        "url": url,
        "return_format": "markdown",
        "request": _engine(use_js),
        "readability": True,
        "store_data": False,
    }
    headers = {"Authorization": f"Bearer {SPIDER_API_KEY}", "Content-Type": "application/json"}
    async with sem:
        try:
            resp = await client.post(f"{SPIDER_API_URL}/scrape", json=payload, headers=headers)
        except httpx.HTTPError as exc:
            logger.warning("Spider scrape failed for %s: %s", url, exc)
            return None
    if resp.status_code >= 400:
        logger.warning("Spider scrape %s returned %s", url, resp.status_code)
        return None
    try:
        pages = resp.json()
    except ValueError:
        return None
    page = pages[0] if isinstance(pages, list) and pages else pages
    if isinstance(page, dict) and page.get("content"):
        return {"url": url, "content": page["content"]}
    return None


async def fetch_urls(
    urls: list[str],
    *,
    use_js: bool = False,
    client_id: int | None = None,
    _client: httpx.AsyncClient | None = None,
) -> dict:
    """Fetch an explicit, ordered list of URLs via Spider scrape → crawl_data shape.

    Preserves input order. Failed/empty pages are dropped (Spider bills $0 for
    them). Returns the same shape as ``crawl_website``.
    """
    if not SPIDER_API_KEY:
        raise CrawlerError("SPIDER_API_KEY is not configured")
    if not urls:
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}
    # Honor a cancel requested before we start spending (mirrors crawl_website).
    # is_cancellation_requested is already imported in spider_service.
    if client_id is not None and is_cancellation_requested(client_id):
        logger.info("Spider fetch_urls aborted before start (cancel requested) client=%s", client_id)
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}

    owns_client = _client is None
    client = _client or httpx.AsyncClient(timeout=SPIDER_TIMEOUT)
    sem = asyncio.Semaphore(_FETCH_CONCURRENCY)
    try:
        fetched = await asyncio.gather(*[_scrape_one(client, u, use_js, sem) for u in urls])
    finally:
        if owns_client:
            await client.aclose()

    results = [p for p in fetched if p]  # gather preserves order
    logger.info(
        "spider_cost client=%s engine=%s pages=%d discovered=%d mode=fetch_urls",
        client_id, _engine(use_js), len(results), len(urls),
    )
    return {
        "results": results,
        "recommended_colors": [],
        "discovered_total": len(urls),
        "queue_remaining": 0,
    }
```

> Move the `import asyncio` to the top-of-file import block (don't leave it mid-file); shown here for locality.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && .venv/bin/python -m pytest tests/test_spider_fetch_urls.py -v --no-cov`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add api/app/services/spider_service.py api/tests/test_spider_fetch_urls.py
git commit -m "feat(crawl): Spider fetch_urls — scrape an explicit ordered URL list"
```

---

### Task 3: Provider dispatch + fallback for `fetch_urls`

**Files:**
- Modify: `api/app/services/crawl_provider.py` (add `fetch_urls` dispatch; fallback reuses recursive `crawl_website`)
- Test: `api/tests/test_crawl_provider_fetch_urls.py` (create)

> **Why no `crawler_service.fetch_urls`:** the explicit per-URL fetch primitive (`crawl_single_http`) lives in `crawler_script.py` (the standalone subprocess) and uses `aiohttp`, which is **not a declared dependency**. Rather than import across that boundary or add a dep, the fallback reuses the fully-supported recursive `crawl_website(seed, max_pages=len(urls))`. It can't replay an arbitrary URL list, so order/exact-set isn't guaranteed in fallback — acceptable because the fallback only fires during a Spider outage.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_crawl_provider_fetch_urls.py
import pytest

from app.services import crawl_provider
from app.services.crawler_service import CrawlerError


@pytest.mark.asyncio
async def test_fetch_urls_uses_spider(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", False)

    async def fake_spider(urls, **kw):
        return {"results": [{"url": urls[0], "content": "s"}], "recommended_colors": [],
                "discovered_total": len(urls), "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", fake_spider)
    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "s"


@pytest.mark.asyncio
async def test_fetch_urls_falls_back_to_recursive_crawl(monkeypatch):
    """On Spider failure, fall back to a recursive crawl of the seed domain,
    capped at the number of requested URLs."""
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", True)
    seen = {}

    async def boom(urls, **kw):
        raise CrawlerError("down")

    async def fake_recursive(url, **kw):
        seen["seed"] = url
        seen["max_pages"] = kw.get("max_pages")
        return {"results": [{"url": url, "content": "pw"}], "recommended_colors": [],
                "discovered_total": 1, "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", boom)
    monkeypatch.setattr(crawl_provider, "_playwright_crawl", fake_recursive)
    data = await crawl_provider.fetch_urls(
        ["https://a.test/x", "https://a.test/y"], use_js=False, client_id=1
    )
    assert data["results"][0]["content"] == "pw"
    assert seen["seed"] == "https://a.test"   # origin of the first URL
    assert seen["max_pages"] == 2             # capped at len(urls)


@pytest.mark.asyncio
async def test_fetch_urls_reraises_without_fallback(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", False)

    async def boom(urls, **kw):
        raise CrawlerError("down")

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", boom)
    with pytest.raises(CrawlerError):
        await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_crawl_provider_fetch_urls.py -v --no-cov`
Expected: FAIL — `crawl_provider` has no attribute `fetch_urls`.

- [ ] **Step 3: Add `fetch_urls` dispatch to `crawl_provider.py`**

`_playwright_crawl` (= `crawler_service.crawl_website`) is already imported in `crawl_provider.py` from the Spider migration. Add the Spider fetch import and the dispatch:

```python
from urllib.parse import urlparse

from app.services.spider_service import fetch_urls as _spider_fetch_urls


async def fetch_urls(urls: list[str], **kwargs) -> dict:
    """Fetch an explicit ordered URL list.

    Spider scrapes the exact list in order. On a Spider outage we can't replay
    an arbitrary list with the recursive crawler, so we recursively crawl the
    seed domain capped at len(urls) — best-effort, order not guaranteed.
    """
    if CRAWL_PROVIDER == "spider":
        try:
            return await _spider_fetch_urls(urls, **kwargs)
        except CrawlerError:
            if not SPIDER_FALLBACK_TO_PLAYWRIGHT:
                raise
            logger.warning(
                "Spider fetch_urls failed (%d urls) — falling back to recursive crawl",
                len(urls), exc_info=True,
            )
    if not urls:
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}
    parsed = urlparse(urls[0])
    seed = f"{parsed.scheme}://{parsed.netloc}"
    return await _playwright_crawl(
        seed,
        max_pages=len(urls),
        use_js=kwargs.get("use_js", False),
        client_id=kwargs.get("client_id"),
    )
```

> Move `from urllib.parse import urlparse` to the top-of-file imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && .venv/bin/python -m pytest tests/test_crawl_provider_fetch_urls.py -v --no-cov`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add api/app/services/crawl_provider.py api/tests/test_crawl_provider_fetch_urls.py
git commit -m "feat(crawl): provider fetch_urls dispatch (Spider) with recursive-crawl fallback"
```

---

### Task 4: `/crawl` accepts `ordered_urls` (schema + orchestrator + route + billing)

**Files:**
- Modify: `api/app/schemas/client.py` (`CrawlRequest.ordered_urls`)
- Modify: `api/app/services/crawl_orchestrator.py` (`run_full_crawl` fetch-list branch)
- Modify: `api/app/worker/tasks.py` (`task_crawl_and_ingest` passes `ordered_urls`)
- Modify: `api/app/api/document_routes.py` (`/crawl` route: same-origin validation + safety cap + pass-through)
- Test: `api/tests/test_run_full_crawl_ordered_urls.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_run_full_crawl_ordered_urls.py
import pytest

import app.services.crawl_orchestrator as orch


@pytest.mark.asyncio
async def test_ordered_urls_uses_fetch_urls_not_recursive_crawl(monkeypatch):
    """When ordered_urls is provided, run_full_crawl must fetch exactly those
    URLs (via provider.fetch_urls) and NOT run the recursive crawl_website."""
    seen = {}

    async def fake_fetch_urls(urls, **kw):
        seen["urls"] = urls
        return {"results": [{"url": u, "content": f"c:{u}"} for u in urls],
                "recommended_colors": [], "discovered_total": len(urls), "queue_remaining": 0}

    async def fake_crawl_website(url, **kw):  # must NOT be called
        seen["recursive"] = True
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}

    def fake_ingest(client_id, pages, **kw):
        seen["pages"] = pages
        return {"chunks": len(pages), "pages_charged": len(pages), "credits_deducted": 5 * len(pages)}

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    monkeypatch.setattr(orch, "crawl_website", fake_crawl_website)
    monkeypatch.setattr(orch, "batch_web_ingestion", fake_ingest)
    monkeypatch.setattr(orch, "set_crawl_progress", lambda *a, **k: None)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)

    result = await orch.run_full_crawl(
        client_id=1, bot_id=None, url="https://acme.test", max_pages=2,
        use_js=False, replace_source=None, cost_per_page=5,
        ordered_urls=["https://acme.test/a", "https://acme.test/b"],
    )
    assert seen["urls"] == ["https://acme.test/a", "https://acme.test/b"]
    assert "recursive" not in seen                       # recursive path skipped
    assert result["chunks"] == 2


@pytest.mark.asyncio
async def test_partial_crawl_skips_orphan_sweep(monkeypatch):
    """A partial (ordered_urls) re-crawl with replace_source must NOT run the
    orphan sweep — otherwise it deletes pages outside the fetched slice."""
    from contextlib import contextmanager
    from unittest.mock import MagicMock

    del_session = MagicMock()

    @contextmanager
    def fake_session():
        yield del_session

    async def fake_fetch_urls(urls, **kw):
        return {"results": [{"url": u, "content": "c"} for u in urls],
                "recommended_colors": [], "discovered_total": len(urls), "queue_remaining": 0}

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    monkeypatch.setattr(orch, "batch_web_ingestion",
                        lambda cid, pages, **kw: {"chunks": len(pages), "pages_charged": len(pages),
                                                  "credits_deducted": 5 * len(pages)})
    monkeypatch.setattr(orch, "get_session", fake_session)
    monkeypatch.setattr(orch, "set_crawl_progress", lambda *a, **k: None)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)

    await orch.run_full_crawl(
        client_id=1, bot_id=None, url="https://acme.test", max_pages=1,
        use_js=False, replace_source="acme.test", cost_per_page=5,
        ordered_urls=["https://acme.test/a"],
    )
    # The sweep issues del_session.query(Document)...delete(); assert it never ran.
    del_session.query.assert_not_called()
```

> `bot_id=None` here so the brand/bot-persistence block (its own `get_session` use) is skipped, leaving the orphan sweep as the only `get_session` consumer — so `query.assert_not_called()` is a clean signal. Confirm this while implementing; if `run_full_crawl` gained another `get_session` call in the `bot_id=None` path, assert on the delete chain instead (`del_session.query.return_value.filter.return_value.delete.assert_not_called()`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_run_full_crawl_ordered_urls.py -v --no-cov`
Expected: FAIL — `run_full_crawl` has no `ordered_urls` param (TypeError).

- [ ] **Step 3a: Import `fetch_urls` in the orchestrator**

In `api/app/services/crawl_orchestrator.py`, change the provider import:

```python
from app.services.crawl_provider import crawl_website, fetch_urls
```

- [ ] **Step 3b: Add the `ordered_urls` branch to `run_full_crawl`**

In `run_full_crawl`'s signature add `ordered_urls: list[str] | None = None`. Then replace the `crawl_data = await crawl_website(...)` call with:

```python
        if ordered_urls:
            logger.info("Fetching %d explicit ordered URLs for client %s", len(ordered_urls), client_id)
            crawl_data = await fetch_urls(ordered_urls, use_js=use_js, client_id=client_id)
        else:
            crawl_data = await crawl_website(
                url,
                max_pages=max_pages,
                use_js=use_js,
                client_id=client_id,
                max_depth=max_depth,
                concurrency=concurrency,
            )
```

Everything downstream (`valid_pages`, `batch_web_ingestion` with `cost_per_page`, brand extraction) is unchanged — the fetch-list path reuses the identical ingest+billing.

**⚠️ Step 3b-guard (data-loss prevention): skip the orphan sweep on partial crawls.** The orphan sweep (currently `if replace_source and total_chunks > 0:`) deletes every stored page for the domain that isn't in `valid_pages`. On a partial `ordered_urls` crawl, `valid_pages` is only the affordable slice, so the sweep would **delete all the pages the user chose not to re-crawl this time**. Change the condition to also require a full crawl:

```python
        # Orphan sweep only makes sense for a FULL re-crawl. A partial
        # (ordered_urls) crawl intentionally fetches a subset, so sweeping
        # would delete pages the user still wants. Skip it in that case.
        if replace_source and total_chunks > 0 and not ordered_urls:
```

- [ ] **Step 3c: Add `ordered_urls` to the schema**

In `api/app/schemas/client.py`, inside `CrawlRequest`:

```python
    ordered_urls: list[str] | None = Field(
        default=None,
        description=(
            "Explicit, pre-ordered list of URLs to crawl (from a prior "
            "/crawl/discover, sorted client-side by the user's chosen order and "
            "truncated to the affordable count). When set, the recursive crawl is "
            "skipped and exactly these URLs are fetched in order."
        ),
    )
```

- [ ] **Step 3d: Thread `ordered_urls` through the worker task**

In `api/app/worker/tasks.py`, add `ordered_urls: list[str] | None = None` to `task_crawl_and_ingest`'s signature and pass `ordered_urls=ordered_urls` into `run_full_crawl(...)`.

- [ ] **Step 3e: Validate + cap in the `/crawl` route**

In `api/app/api/document_routes.py` `/crawl` handler, after credit pre-flight and before enqueuing, add same-origin validation + safety cap (prevents SSRF / cross-domain billing abuse):

```python
        ordered_urls = crawl_request.ordered_urls
        if ordered_urls:
            from urllib.parse import urlparse

            seed_host = urlparse(str(crawl_request.url)).netloc.lower().removeprefix("www.")
            same_origin = [
                u for u in ordered_urls
                if urlparse(u).netloc.lower().removeprefix("www.") == seed_host
            ]
            if not same_origin:
                raise HTTPException(status_code=400, detail={"error": "ordered_urls_off_domain"})
            # Never exceed what the pre-flight reserved credits for.
            ordered_urls = same_origin[:effective_max_pages]
```

Then include `ordered_urls=ordered_urls` in the `enqueue` call for `task_crawl_and_ingest` (match the existing enqueue kwargs style in this handler).

- [ ] **Step 4: Run test to verify it passes + regression**

Run: `cd api && .venv/bin/python -m pytest tests/test_run_full_crawl_ordered_urls.py -v --no-cov`
Expected: PASS
Run: `cd api && .venv/bin/python -m pytest tests/ -k "crawl or orchestrator or ingest" --no-cov -q`
Expected: PASS (no regression in existing crawl/ingest tests)

- [ ] **Step 5: Commit**

```bash
git add api/app/schemas/client.py api/app/services/crawl_orchestrator.py api/app/worker/tasks.py api/app/api/document_routes.py api/tests/test_run_full_crawl_ordered_urls.py
git commit -m "feat(crawl): crawl an explicit ordered_urls slice with same-origin guard"
```

---

### Task 5: Frontend estimate modal (count picker + order + live cost)

**Files:**
- Modify: `app/src/services/api.js` (`discoverCrawlUrls` returns new fields; `startCrawl` sends `ordered_urls`)
- Modify: `app/src/pages/KnowledgeBase.jsx` (estimate modal)

- [ ] **Step 1: Extend the API client**

In `app/src/services/api.js`, ensure `discoverCrawlUrls` returns the full response body (it already returns the parsed payload — confirm it surfaces `urls`, `cost_per_page`, `balance`, `max_affordable_pages`, `credits_required_full`, `exceeds_balance`). In the crawl-start function, add an optional `orderedUrls` arg that, when present, is sent as `ordered_urls` in the POST body.

- [ ] **Step 2: Add ordering helpers (pure functions, top of `KnowledgeBase.jsx`)**

```jsx
// Order the discovered URLs by the user's choice, then take the first `count`.
const ORDER_OPTIONS = [
  { key: 'shallow', label: 'Shallow-first (homepage & top pages first)' },
  { key: 'discovered', label: 'As discovered (site order)' },
];

const pathDepth = (u) => {
  try { return new URL(u).pathname.replace(/\/+$/, '').split('/').filter(Boolean).length; }
  catch { return 99; }
};

const orderUrls = (urls, order) => {
  if (order === 'shallow') {
    // stable sort by path depth; ties keep discovery order
    return urls.map((u, i) => [u, i]).sort((a, b) => pathDepth(a[0]) - pathDepth(b[0]) || a[1] - b[1]).map(([u]) => u);
  }
  return urls; // 'discovered' = as-is
};

const sliceForCrawl = (urls, order, count) => orderUrls(urls, order).slice(0, count);
```

- [ ] **Step 3: Wire the modal**

On "Scan", call `discoverCrawlUrls`. If `exceeds_balance` is true, open a modal (follow the existing modal/dialog pattern already used elsewhere in the app — reuse the shared Modal component; do not hand-roll a new dialog). Modal contents:
- Headline: `Found {total_found}{capped ? '+' : ''} pages · full crawl = {credits_required_full} credits · you have {balance} (max {max_affordable_pages} pages)`. When `capped` is true, append a subtle note "(site has more than {total_found} pages; showing the first {total_found})" so the number isn't misleading.
- Count control: a number input + range slider, `min={1}`, `max={max_affordable_pages}`, default `Math.min(total_found, max_affordable_pages)`. Clamp on change so it can never exceed `max_affordable_pages`.
- Order: a radio group over `ORDER_OPTIONS`, default `shallow`.
- Live cost line: `{count} pages × {cost_per_page} = {count * cost_per_page} credits`.
- Buttons:
  - **Start Crawl ({count})** → `startCrawl({ url, max_pages: count, ordered_urls: sliceForCrawl(urls, order, count), use_js })` then hand off to the existing `CrawlContext` progress flow.
  - **Top up** → navigate to `/billing`.
  - **Cancel** → close modal.
- If `max_affordable_pages === 0`: hide the count control + Start button; show only "You need credits to crawl" + **Top up**.
- If `!exceeds_balance`: skip the modal entirely and start the crawl exactly as today.

- [ ] **Step 4: Lint + build (no JS test runner)**

Run: `cd app && npm run lint`
Expected: no errors on changed files.
Run: `cd app && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual verification (preview)**

Run the widget/app preview and confirm: scanning a large site on a low-credit account opens the modal; the count slider clamps at `max_affordable_pages`; the live cost updates; "Start Crawl" begins a crawl that stops at the chosen count; a well-funded account sees no modal.

- [ ] **Step 6: Commit**

```bash
git add app/src/services/api.js app/src/pages/KnowledgeBase.jsx
git commit -m "feat(crawl): pre-crawl estimate modal — credit warning, count picker, order"
```

---

### Task 6: Pre-completion checks + rollout (no new code)

- [ ] **Step 1: Backend baseline checks (per CLAUDE.md)**

```bash
cd api
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/python -m pytest -q
```
Expected: lint ✓ · format ✓ · tests ✓. Fix anything red before proceeding.

- [ ] **Step 2: Frontend baseline checks**

```bash
cd app
npm run lint
npm run build
```
Expected: lint ✓ · build ✓.

- [ ] **Step 3: Manual end-to-end sanity**

On a Standard account with low credits, scan a large site → confirm modal math matches `credits = pages × 5`, crawl the chosen slice, verify credits deducted == pages ingested × 5 (check `CreditLedger`), and that a partial crawl stops cleanly.

- [ ] **Step 4: Ship**

```bash
git push origin development
```
Open a PR `development → main`; the user merges. No new env/secrets required (feature is pure app logic on top of existing crawl + credit systems).

---

## Self-Review

- **Spec coverage:** C1 discover credit math → Task 1. C2/C3 ordering + explicit-list fetch → Tasks 2–4 (refined: ordering is a frontend sort; backend takes `ordered_urls`). C4 estimate modal → Task 5. Error handling (0 credits, site grew, JS cap, discover fail, Free plan) → Task 4 route cap + Task 5 modal branches + existing atomic billing. Testing → per-task + Task 6. ✓
- **Placeholder scan:** every code step has concrete code; where an existing signature must be matched (`crawl_single_http`, conftest fixtures, enqueue kwargs, shared Modal), the step says to open the file and match it — no invented APIs. ✓
- **Type consistency:** `fetch_urls(urls, *, use_js, client_id)` identical across `spider_service`, `crawler_service`, `crawl_provider`, and `run_full_crawl`'s call; all return `{results, recommended_colors, discovered_total, queue_remaining}`; `batch_web_ingestion` consumes `[{url, content}]` — matched. `ordered_urls` name consistent from schema → route → task → orchestrator. ✓
- **Scope:** single feature on top of existing crawl+credit systems; one plan. ✓
- **CTO-review fixes incorporated:** (1) orphan-sweep skipped on partial crawls + test [Task 4]; (2) fallback reuses recursive `crawl_website`, no `crawl_single_http`/`aiohttp` [Task 3]; (3) bot-scoped balance [Task 1]; (4) real `TestClient`+override harness [all backend tests]; (5) `fetch_urls` cancel pre-check [Task 2]; (6) credit lookups in the pre-discovery session block [Task 1]; (7) verify Spider `/scrape` shape first [Task 2 Step 0]; (8) discover rate limit 30→120/hour [Task 1]; (9) capped-site modal copy [Task 5]. ✓
