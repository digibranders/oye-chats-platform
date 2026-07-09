"""Responsive crawl cancellation.

Before this fix `CrawlCancelled` was defined and caught but never raised, so a
Stop click only flipped the UI label — the crawl ran to natural completion. Now
the providers raise `CrawlCancelled` at each page/wave checkpoint (short-circuiting
not-yet-started fetches), and it propagates through `crawl_provider` WITHOUT
triggering a fallback re-crawl. These tests lock that behavior in.
"""

import asyncio

import pytest

from app.services import crawl_provider, jina_service, spider_service
from app.services.crawler_service import CrawlCancelled


def _counter_cancel():
    """Return a cancel predicate that is False on the first call (pre-flight
    guard) and True on every call after (per-page short-circuit)."""
    state = {"n": 0}

    def _pred(_client_id):
        state["n"] += 1
        return state["n"] > 1

    return _pred


# ── Spider ───────────────────────────────────────────────────────────────────


def test_spider_fetch_urls_preflight_cancel_raises(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "k")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda _c: True)
    with pytest.raises(CrawlCancelled) as ei:
        asyncio.run(spider_service.fetch_urls(["https://a.com/1"], client_id=1))
    assert ei.value.partial_result["results"] == []


def test_spider_crawl_website_preflight_cancel_raises(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "k")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda _c: True)
    with pytest.raises(CrawlCancelled):
        asyncio.run(spider_service.crawl_website("https://a.com", client_id=1))


def test_spider_fetch_urls_midflight_shortcircuits(monkeypatch):
    """A cancel after start skips every not-yet-started fetch and raises with
    the pages scraped so far — it does NOT fetch the rest of the batch."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "k")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", _counter_cancel())
    scraped = {"n": 0}

    async def _fake_scrape(*_a, **_k):
        scraped["n"] += 1
        return {"url": "x", "content": "y"}

    monkeypatch.setattr(spider_service, "_scrape_one", _fake_scrape)
    with pytest.raises(CrawlCancelled) as ei:
        asyncio.run(spider_service.fetch_urls(["u1", "u2", "u3"], client_id=1))
    assert scraped["n"] == 0  # every page short-circuited, none fetched
    assert ei.value.partial_result["results"] == []


def test_spider_fetch_urls_no_cancel_returns_results(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "k")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda _c: False)

    async def _fake_scrape(_client, url, _use_js, _sem):
        return {"url": url, "content": "hi"}

    monkeypatch.setattr(spider_service, "_scrape_one", _fake_scrape)
    out = asyncio.run(spider_service.fetch_urls(["u1", "u2"], client_id=1))
    assert len(out["results"]) == 2


# ── Jina ─────────────────────────────────────────────────────────────────────


def test_jina_fetch_urls_preflight_cancel_raises(monkeypatch):
    monkeypatch.setattr(jina_service, "is_cancellation_requested", lambda _c: True)
    with pytest.raises(CrawlCancelled) as ei:
        asyncio.run(jina_service.fetch_urls(["https://a.com/1"], client_id=1))
    assert ei.value.partial_result["results"] == []


def test_jina_fetch_urls_midflight_shortcircuits(monkeypatch):
    monkeypatch.setattr(jina_service, "is_cancellation_requested", _counter_cancel())
    fetched = {"n": 0}

    async def _fake_fetch(*_a, **_k):
        fetched["n"] += 1
        return {"url": "x", "content": "y"}

    monkeypatch.setattr(jina_service, "_fetch_one", _fake_fetch)
    with pytest.raises(CrawlCancelled):
        asyncio.run(jina_service.fetch_urls(["u1", "u2"], client_id=1))
    assert fetched["n"] == 0


# ── Provider layer: cancel must NOT trigger a fallback re-crawl ───────────────


def test_provider_fetch_urls_propagates_cancel_without_fallback(monkeypatch):
    called = {"fallback": False}

    async def _cancel_primary(_urls, **_kw):
        raise CrawlCancelled({"results": [], "recommended_colors": []})

    async def _fallback(_urls, **_kw):
        called["fallback"] = True
        return {"results": [], "recommended_colors": []}

    monkeypatch.setattr(crawl_provider, "_provider_order", lambda: ("jina", "spider"))
    monkeypatch.setattr(crawl_provider, "_fetcher", lambda p: _cancel_primary if p == "jina" else _fallback)

    with pytest.raises(CrawlCancelled):
        asyncio.run(crawl_provider.fetch_urls(["u1", "u2"], client_id=1))
    assert called["fallback"] is False  # cancel is not a provider failure
