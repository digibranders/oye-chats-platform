# Credit-Aware Crawl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before crawling, show the user how many pages the site has vs. what their credits can afford, and let them pick a page count (capped at affordable) and an order, then crawl exactly that slice.

**Architecture:** Reuse the existing `POST /crawl/discover` (page discovery) + `credit_service` (cost/balance). Discovery already returns a flat list of URL strings, so **ordering is a frontend sort** of that list (shallow = by URL path-depth, as-discovered = list order). The backend gains one capability — fetch an explicit `ordered_urls` list → `batch_web_ingestion` — reusing the atomic per-page billing that already stops cleanly on insufficient credits. The normal (fits-budget) crawl path is untouched.

**Tech Stack:** FastAPI · ARQ · httpx · Spider.cloud provider (with Playwright fallback) · pytest · React/Vite (lint+build, no JS test runner).

**Design spec:** `docs/superpowers/specs/2026-07-01-credit-aware-crawl-design.md`

**Refinement vs spec:** The spec proposed a backend `crawl_order` enum. During planning we found `discover_website_urls` returns plain URL strings and `/crawl/discover` already runs discovery — so ordering is done frontend-side by sorting the returned list, and the backend only needs an `ordered_urls` param. Simpler, fewer moving parts, same UX.

---

## Pre-flight

- [ ] On branch `development` (`git branch --show-current` → `development`).
- [ ] Backend commands run from `api/` using `.venv/bin/python -m pytest ... --no-cov` (local `uv run` is unreliable here; `.venv` binaries work). Frontend from `app/`.

## File Structure

**Backend (modify):**
- `api/app/api/document_routes.py` — `/crawl/discover` response gains credit math + `urls`; `/crawl` accepts `ordered_urls`.
- `api/app/schemas/client.py` — `CrawlRequest.ordered_urls`; new `CrawlDiscoverResponse` fields.
- `api/app/services/spider_service.py` — add `fetch_urls()` (scrape an explicit list).
- `api/app/services/crawl_provider.py` — add `fetch_urls()` dispatch + fallback.
- `api/app/services/crawler_service.py` — add `fetch_urls()` (Playwright fallback, reuses `crawl_single_http`).
- `api/app/services/crawl_orchestrator.py` — `run_full_crawl` branches to fetch-list when `ordered_urls` given.
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
from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_discover_returns_credit_math(async_client, standard_client_auth_headers):
    """/crawl/discover must return cost_per_page, balance, max_affordable_pages,
    credits_required_full, exceeds_balance, and the urls list."""
    fake_urls = [f"https://acme.test/p{i}" for i in range(30)]  # 30 pages
    with patch("app.services.url_discovery.discover_website_urls", return_value=fake_urls), \
         patch("app.services.credit_service.get_credit_cost", return_value=5), \
         patch("app.services.credit_service.get_balance", return_value=100):  # 100 cr -> 20 pages
        resp = await async_client.post(
            "/crawl/discover", json={"url": "https://acme.test"},
            headers=standard_client_auth_headers,
        )
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

> **Fixture note:** `async_client` and `standard_client_auth_headers` — reuse the patterns in `api/tests/conftest.py`. If a Standard-plan auth fixture does not exist, add one there mirroring the existing client-auth fixture, assigning the Standard plan. Inspect `conftest.py` first and follow its exact style.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_crawl_discover_credits.py -v --no-cov`
Expected: FAIL — response lacks `cost_per_page` (KeyError on assertion).

- [ ] **Step 3: Add credit math to the discover endpoint**

In `api/app/api/document_routes.py`, replace the final `return {...}` of `crawl_discover_endpoint` with:

```python
        from app.services import credit_service

        cost_per_page = credit_service.get_credit_cost(db, "url_scan")
        balance = credit_service.get_balance(db, client_id)
        per_page = max(int(cost_per_page), 1)
        max_affordable_pages = int(balance) // per_page
        credits_required_full = total * cost_per_page

    return {
        "url": discover_request.url,
        "total_found": total,
        "capped": total >= discovery_cap,
        "plan_max": plan_max,
        "urls": urls if total else [],
        "cost_per_page": cost_per_page,
        "balance": balance,
        "max_affordable_pages": max_affordable_pages,
        "credits_required_full": credits_required_full,
        "exceeds_balance": credits_required_full > balance,
    }
```

> Note: `credit_service.get_credit_cost` / `get_balance` take the `db` session, so this block must run inside the existing `with get_session() as db:` context (the same one that resolves `plan`). Move the credit lookups into that block and keep the discovery call where it is; `urls` is already in scope from the discovery step.

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

### Task 3: Provider dispatch + Playwright fallback for `fetch_urls`

**Files:**
- Modify: `api/app/services/crawler_service.py` (add `fetch_urls` using existing `crawl_single_http`)
- Modify: `api/app/services/crawl_provider.py` (add `fetch_urls` dispatch + fallback)
- Test: `api/tests/test_crawl_provider_fetch_urls.py` (create)

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
async def test_fetch_urls_falls_back_to_playwright(monkeypatch):
    monkeypatch.setattr(crawl_provider, "CRAWL_PROVIDER", "spider")
    monkeypatch.setattr(crawl_provider, "SPIDER_FALLBACK_TO_PLAYWRIGHT", True)

    async def boom(urls, **kw):
        raise CrawlerError("down")

    async def fake_pw(urls, **kw):
        return {"results": [{"url": urls[0], "content": "pw"}], "recommended_colors": [],
                "discovered_total": len(urls), "queue_remaining": 0}

    monkeypatch.setattr(crawl_provider, "_spider_fetch_urls", boom)
    monkeypatch.setattr(crawl_provider, "_playwright_fetch_urls", fake_pw)
    data = await crawl_provider.fetch_urls(["https://a.test/x"], use_js=False, client_id=1)
    assert data["results"][0]["content"] == "pw"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && .venv/bin/python -m pytest tests/test_crawl_provider_fetch_urls.py -v --no-cov`
Expected: FAIL — `crawl_provider` has no attribute `fetch_urls`.

- [ ] **Step 3a: Add `fetch_urls` to `crawler_service.py` (Playwright fallback)**

Add to `api/app/services/crawler_service.py` (reuses the existing single-page HTTP fetch `crawl_single_http`; confirm its exact signature near line 755 before wiring — it takes `(session, url, depth, semaphore, page_timeout, h2t)` and returns a page dict with `url`/`content`):

```python
async def fetch_urls(
    urls: list[str],
    *,
    use_js: bool = False,
    client_id: int | None = None,
) -> dict:
    """Fetch an explicit URL list with the local crawler (fallback path).

    Uses the HTTP fetch for each URL. Preserves order; drops empty pages.
    """
    import asyncio

    import aiohttp
    import html2text

    if not urls:
        return {"results": [], "recommended_colors": [], "discovered_total": 0, "queue_remaining": 0}

    semaphore = asyncio.Semaphore(3)
    h2t = html2text.HTML2Text()
    h2t.ignore_links = False
    results: list[dict] = []
    async with aiohttp.ClientSession() as session:
        fetched = await asyncio.gather(
            *[crawl_single_http(session, u, 0, semaphore, 20, h2t) for u in urls],
            return_exceptions=True,
        )
    for page in fetched:
        if isinstance(page, dict) and page.get("url") and page.get("content"):
            results.append({"url": page["url"], "content": page["content"]})
    return {
        "results": results,
        "recommended_colors": [],
        "discovered_total": len(urls),
        "queue_remaining": 0,
    }
```

> Before implementing, open `crawler_service.py` and confirm the real `crawl_single_http` signature and the html2text/aiohttp setup already used there (there is an existing `h2t` construction around the Phase-2 fallback). Match that exact usage rather than the illustrative version above if it differs.

- [ ] **Step 3b: Add `fetch_urls` dispatch to `crawl_provider.py`**

Append to `api/app/services/crawl_provider.py`:

```python
from app.services.crawler_service import fetch_urls as _playwright_fetch_urls
from app.services.spider_service import fetch_urls as _spider_fetch_urls


async def fetch_urls(urls: list[str], **kwargs) -> dict:
    """Dispatch an explicit ordered-URL fetch to the configured provider.

    Mirrors ``crawl_website`` dispatch (Spider primary, Playwright fallback).
    """
    if CRAWL_PROVIDER == "spider":
        try:
            return await _spider_fetch_urls(urls, **kwargs)
        except CrawlerError:
            if not SPIDER_FALLBACK_TO_PLAYWRIGHT:
                raise
            logger.warning("Spider fetch_urls failed (%d urls) — falling back to Playwright", len(urls), exc_info=True)
            return await _playwright_fetch_urls(urls, **kwargs)
    return await _playwright_fetch_urls(urls, **kwargs)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && .venv/bin/python -m pytest tests/test_crawl_provider_fetch_urls.py -v --no-cov`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add api/app/services/crawler_service.py api/app/services/crawl_provider.py api/tests/test_crawl_provider_fetch_urls.py
git commit -m "feat(crawl): provider fetch_urls dispatch with Playwright fallback"
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
```

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

Everything downstream (`valid_pages`, `batch_web_ingestion` with `cost_per_page`, brand extraction, orphan sweep) is unchanged — the fetch-list path reuses the identical ingest+billing.

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
- Headline: `Found {total_found} pages · full crawl = {credits_required_full} credits · you have {balance} (max {max_affordable_pages} pages)`.
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
