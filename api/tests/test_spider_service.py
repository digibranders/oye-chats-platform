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
# needs those apart. Company_profile_service writes to a cross-tenant cache,
# so conflating them lets one expired key blacklist every domain it sees, with
# an exponential backoff compounding it to 90 days.


@pytest.mark.asyncio
async def test_fetch_html_outcome_reports_a_target_404_as_answered(monkeypatch):
    """Spider reports the TARGET's status in the per-page `status` field, and
    returns 200 for the call itself. That is the only channel that carries
    evidence about the target."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"url": "https://gone.test", "content": None, "status": 404}])

    outcome = await spider_service.fetch_html_outcome("https://gone.test", _client=_mock_client(handler))
    assert outcome.content is None
    assert outcome.answered is True, "the target itself said 404; that is the target's problem"


@pytest.mark.asyncio
async def test_a_bare_404_on_the_scrape_endpoint_is_ours(monkeypatch):
    """A 404 on POST /scrape means the endpoint moved, not that the target is
    gone. Treating it as the target's fault would blacklist every domain the
    platform sees the moment SPIDER_API_URL goes stale."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    outcome = await spider_service.fetch_html_outcome("https://fine.test", _client=_mock_client(handler))
    assert outcome.answered is False


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 307, 400, 401, 402, 403, 408, 429, 451, 500, 502, 503])
async def test_fetch_html_outcome_reports_spiders_own_failures_as_unanswered(monkeypatch, status):
    """Expired key, exhausted quota, Spider down, Spider's own fetch timing
    out. None of these are evidence about the target."""
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
    simpler signature, the outcome variant is additive, not a replacement."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"url": "https://acme.test", "content": "<html>hi</html>"}])

    assert await spider_service.fetch_html("https://acme.test", _client=_mock_client(handler)) == "<html>hi</html>"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("body", "why"),
    [
        ("<html>a proxy error page</html>", "unparseable body, a WAF or captive portal, not the target"),
        ("[]", "Spider returned no page object at all"),
        ('{"error": "insufficient credits"}', "a 200-wrapped billing error is ours"),
    ],
)
async def test_a_200_that_carries_no_page_object_is_not_evidence(monkeypatch, body, why):
    """`answered` is fail-CLOSED. A 200 alone proves nothing: it has to carry a
    parseable page whose upstream status the target itself produced."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "application/json"})

    outcome = await spider_service.fetch_html_outcome("https://fine.test", _client=_mock_client(handler))
    assert outcome.answered is False, why


@pytest.mark.asyncio
@pytest.mark.parametrize("upstream", [500, 502, 503, 504, 403, 429, None])
async def test_an_empty_page_with_a_non_target_upstream_status_is_not_evidence(monkeypatch, upstream):
    """A 5xx means the target is broken TODAY, not absent. `_scrape_one` in
    this same module retries exactly this condition three times, it must not
    become a permanent verdict somewhere else. 403 is usually the target's WAF
    refusing Spider, which must not blacklist a real company."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"url": "https://x.test", "content": "", "status": upstream}])

    outcome = await spider_service.fetch_html_outcome("https://x.test", _client=_mock_client(handler))
    assert outcome.answered is False


@pytest.mark.asyncio
async def test_an_empty_page_with_upstream_200_is_treated_as_transient(monkeypatch):
    """`_scrape_one` documents 200-with-empty-content as "usually a transient
    upstream 5xx; worth a retry". Same evidence, same conclusion."""
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"url": "https://x.test", "content": "", "status": 200}])

    outcome = await spider_service.fetch_html_outcome("https://x.test", _client=_mock_client(handler))
    assert outcome.answered is False


@pytest.mark.asyncio
async def test_a_spider_5xx_is_ours_even_when_it_carries_a_page_payload(monkeypatch):
    """Pins the status guard itself.

    Without the `2xx only` check the code still behaves for a bare error
    response (an empty body parses to no page, and fail-closed catches it),
    but a Spider 5xx that echoes a cached page envelope would be read as the
    target's own 404 and blacklist a live domain.
    """
    monkeypatch.setattr(spider_service, "SPIDER_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json=[{"url": "https://live.test", "content": None, "status": 404}])

    outcome = await spider_service.fetch_html_outcome("https://live.test", _client=_mock_client(handler))
    assert outcome.answered is False, "a Spider-side 503 was read as the target's 404"
