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


@pytest.mark.asyncio
async def test_logs_page_count_for_cost_tracking(monkeypatch, caplog):
    import logging

    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: False)

    def handler(request):
        return httpx.Response(200, json=[
            {"url": "u1", "content": "a", "status": 200},
            {"url": "u2", "content": "b", "status": 200},
        ])

    with caplog.at_level(logging.INFO):
        await spider_service.crawl_website(
            "https://acme.test", max_pages=10, use_js=True, client_id=9,
            _client=_mock_client(handler),
        )
    assert any("spider_cost" in r.message and "pages=2" in r.message for r in caplog.records)
