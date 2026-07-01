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
    assert [p["url"] for p in data["results"]] == urls  # order preserved
    assert data["results"][0]["content"] == "md:https://acme.test/a"
    assert data["discovered_total"] == 2


@pytest.mark.asyncio
async def test_fetch_urls_reports_on_page(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: False)

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        content = None if body["url"].endswith("/bad") else "ok"
        return httpx.Response(200, json=[{"url": body["url"], "content": content}])

    seen: list[tuple[str, bool]] = []
    urls = ["https://acme.test/a", "https://acme.test/bad"]
    await spider_service.fetch_urls(
        urls, client_id=1, on_page=lambda url, ok: seen.append((url, ok)), _client=_mock_client(handler)
    )
    # One callback per URL, with the ok flag reflecting whether content came back.
    assert dict(seen) == {"https://acme.test/a": True, "https://acme.test/bad": False}


@pytest.mark.asyncio
async def test_fetch_urls_on_page_error_does_not_abort(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: False)

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(200, json=[{"url": body["url"], "content": "ok"}])

    def boom(url, ok):
        raise RuntimeError("callback blew up")

    data = await spider_service.fetch_urls(
        ["https://acme.test/a"], client_id=1, on_page=boom, _client=_mock_client(handler)
    )
    assert [p["url"] for p in data["results"]] == ["https://acme.test/a"]  # crawl still succeeded


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
