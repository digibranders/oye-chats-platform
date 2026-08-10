import json

import httpx
import pytest

from app.services import spider_service
from app.services.crawler_service import CrawlCancelled, CrawlerError


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
        return httpx.Response(
            200,
            json=[
                {"url": "https://acme.test", "content": "# Home", "status": 200},
                {"url": "https://acme.test/about", "content": "# About", "status": 200},
                {"url": "https://acme.test/dead", "content": None, "status": 500, "error": "blocked"},
            ],
        )

    data = await spider_service.crawl_website(
        "https://acme.test",
        max_pages=500,
        use_js=False,
        client_id=1,
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
        "https://acme.test",
        max_pages=10,
        use_js=True,
        client_id=1,
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
            "https://acme.test",
            max_pages=10,
            use_js=False,
            client_id=1,
            _client=_mock_client(handler),
        )


@pytest.mark.asyncio
async def test_missing_api_key_raises(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", None)
    with pytest.raises(CrawlerError):
        await spider_service.crawl_website(
            "https://acme.test",
            max_pages=10,
            use_js=False,
            client_id=1,
        )


@pytest.mark.asyncio
async def test_precancelled_crawl_raises(monkeypatch):
    """A cancel requested before start raises CrawlCancelled (clean ``cancelled``
    terminal state) without hitting Spider."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: True)

    called = {"http": False}

    def handler(request):  # pragma: no cover - must NOT be called
        called["http"] = True
        return httpx.Response(200, json=[])

    with pytest.raises(CrawlCancelled):
        await spider_service.crawl_website(
            "https://acme.test",
            max_pages=10,
            use_js=False,
            client_id=7,
            _client=_mock_client(handler),
        )
    assert called["http"] is False  # we never hit Spider once cancel is set


@pytest.mark.asyncio
async def test_logs_page_count_for_cost_tracking(monkeypatch, caplog):
    import logging

    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")
    monkeypatch.setattr(spider_service, "is_cancellation_requested", lambda cid: False)

    def handler(request):
        return httpx.Response(
            200,
            json=[
                {"url": "u1", "content": "a", "status": 200},
                {"url": "u2", "content": "b", "status": 200},
            ],
        )

    with caplog.at_level(logging.INFO):
        await spider_service.crawl_website(
            "https://acme.test",
            max_pages=10,
            use_js=True,
            client_id=9,
            _client=_mock_client(handler),
        )
    assert any("spider_cost" in r.message and "pages=2" in r.message for r in caplog.records)


# ── fetch_html_outcome: whose failure was it? ────────────────────────────────
#
# `fetch_html` returns None for a missing key, an expired key, a transport
# error AND a genuine 404. Any caller that PERSISTS "this URL yielded nothing"
# needs those apart — company_profile_service writes to a cross-tenant cache,
# so conflating them lets one expired key blacklist every domain it sees, with
# an exponential backoff compounding it to 90 days.


@pytest.mark.asyncio
async def test_fetch_html_outcome_reports_a_real_404_as_answered(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    outcome = await spider_service.fetch_html_outcome("https://gone.test", _client=_mock_client(handler))
    assert outcome.content is None
    assert outcome.answered is True, "Spider answered about the target; that is the target's problem"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 402, 403, 408, 429, 500, 502, 503])
async def test_fetch_html_outcome_reports_spiders_own_failures_as_unanswered(monkeypatch, status):
    """Expired key, exhausted quota, Spider down, Spider's own fetch timing
    out — none of these are evidence about the target."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status)

    outcome = await spider_service.fetch_html_outcome("https://fine.test", _client=_mock_client(handler))
    assert outcome.content is None
    assert outcome.answered is False, f"a Spider-side {status} was attributed to the target"


@pytest.mark.asyncio
async def test_fetch_html_outcome_reports_a_missing_key_as_unanswered(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "")

    outcome = await spider_service.fetch_html_outcome("https://fine.test")
    assert outcome == spider_service.ScrapeOutcome(content=None, answered=False)


@pytest.mark.asyncio
async def test_fetch_html_outcome_reports_a_transport_error_as_unanswered(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("spider unreachable")

    outcome = await spider_service.fetch_html_outcome("https://fine.test", _client=_mock_client(handler))
    assert outcome.answered is False


@pytest.mark.asyncio
async def test_fetch_html_outcome_returns_content_on_success(monkeypatch):
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["return_format"] == "html"
        return httpx.Response(200, json=[{"url": "https://acme.test", "content": "<html>hi</html>"}])

    outcome = await spider_service.fetch_html_outcome("https://acme.test", _client=_mock_client(handler))
    assert outcome == spider_service.ScrapeOutcome(content="<html>hi</html>", answered=True)


@pytest.mark.asyncio
async def test_fetch_html_still_returns_a_bare_string_for_its_existing_callers(monkeypatch):
    """The footer harvester is a log-only side channel and must keep its
    simpler signature — the outcome variant is additive, not a replacement."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"url": "https://acme.test", "content": "<html>hi</html>"}])

    assert await spider_service.fetch_html("https://acme.test", _client=_mock_client(handler)) == "<html>hi</html>"
