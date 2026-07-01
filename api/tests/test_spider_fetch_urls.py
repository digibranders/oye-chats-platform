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
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: False)

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
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: False)

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["url"].endswith("/bad"):
            return httpx.Response(200, json=[{"url": body["url"], "content": None}])
        return httpx.Response(200, json=[{"url": body["url"], "content": "ok"}])

    urls = ["https://acme.test/good", "https://acme.test/bad"]
    data = await spider_service.fetch_urls(urls, use_js=False, client_id=1, _client=_mock_client(handler))
    assert [p["url"] for p in data["results"]] == ["https://acme.test/good"]  # bad dropped


@pytest.mark.asyncio
async def test_fetch_urls_precancelled_returns_empty(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: True)

    called = {"http": False}

    def handler(request):  # pragma: no cover - must NOT be called
        called["http"] = True
        return httpx.Response(200, json=[])

    data = await spider_service.fetch_urls(
        ["https://acme.test/a"], use_js=False, client_id=7, _client=_mock_client(handler)
    )
    assert data["results"] == []
    assert called["http"] is False


@pytest.mark.asyncio
async def test_fetch_urls_missing_key_raises(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", None)
    with pytest.raises(CrawlerError):
        await spider_service.fetch_urls(["https://acme.test/a"], use_js=False, client_id=1)
