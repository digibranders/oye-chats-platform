import httpx
import pytest

from app.services import jina_service


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_urls_returns_markdown_in_order(monkeypatch):
    def handler(request):
        return httpx.Response(200, text=f"# md for {request.url.path}")

    urls = ["https://acme.test/a", "https://acme.test/b"]
    data = await jina_service.fetch_urls(urls, client_id=1, _client=_client(handler))
    assert [p["url"] for p in data["results"]] == urls
    assert data["results"][0]["content"].startswith("# md")
    assert data["discovered_total"] == 2


@pytest.mark.asyncio
async def test_fetch_urls_drops_failures(monkeypatch):
    def handler(request):
        if request.url.path.endswith("/bad"):
            return httpx.Response(500, text="err")
        return httpx.Response(200, text="ok")

    data = await jina_service.fetch_urls(
        ["https://a.test/ok", "https://a.test/bad"], client_id=1, _client=_client(handler)
    )
    assert [p["url"] for p in data["results"]] == ["https://a.test/ok"]


@pytest.mark.asyncio
async def test_fetch_urls_drops_empty_body(monkeypatch):
    def handler(request):
        return httpx.Response(200, text="   ")

    data = await jina_service.fetch_urls(["https://a.test/x"], client_id=1, _client=_client(handler))
    assert data["results"] == []


@pytest.mark.asyncio
async def test_fetch_urls_empty_input():
    data = await jina_service.fetch_urls([], client_id=1)
    assert data == {
        "results": [],
        "recommended_colors": [],
        "discovered_total": 0,
        "queue_remaining": 0,
    }


@pytest.mark.asyncio
async def test_fetch_urls_sends_api_key_when_set(monkeypatch):
    monkeypatch.setattr(jina_service, "JINA_API_KEY", "jina-secret")
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("Authorization")
        seen["fmt"] = request.headers.get("X-Return-Format")
        return httpx.Response(200, text="ok")

    await jina_service.fetch_urls(["https://a.test/x"], client_id=1, _client=_client(handler))
    assert seen["auth"] == "Bearer jina-secret"
    assert seen["fmt"] == "markdown"
