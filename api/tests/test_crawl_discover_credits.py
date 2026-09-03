# Mirrors the harness in tests/test_document_routes.py: bare FastAPI app +
# router + dependency overrides + monkeypatched get_session. No async_client.
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import document_routes
from app.api.auth import (
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
    require_verified_email_for_workspace,
)
from app.api.document_routes import router
from app.services.plan_service import UNLIMITED


@contextmanager
def _session_ctx(session):
    yield session


def _build_app():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": SimpleNamespace(id=1),
        "client_id": 1,
        "operator_id": None,
    }
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None
    return app


def test_discover_returns_credit_math(monkeypatch):
    """/crawl/discover returns cost_per_page, (bot-scoped) balance,
    max_affordable_pages, credits_required_full, exceeds_balance, and urls."""
    fake_urls = [f"https://acme.test/p{i}" for i in range(30)]  # 30 pages

    # Skip the SSRF DNS resolution check in the request validator (hermetic test).
    monkeypatch.setattr("app.schemas.client._is_public_hostname", lambda h: True)
    monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(MagicMock()))
    monkeypatch.setattr("app.services.plan_service.get_client_plan", lambda db, cid: SimpleNamespace(name="Standard"))
    monkeypatch.setattr("app.services.plan_service.get_crawl_limits", lambda plan: {"max_crawl_pages": UNLIMITED})

    async def _fake_discover(url, max_urls, timeout):
        return fake_urls

    monkeypatch.setattr("app.services.url_discovery.discover_website_urls", _fake_discover)
    # The per-page price resolves through the plan entitlements now. Pinned to a
    # tier WITHOUT first_training_free, so this file keeps testing what it was
    # written for: a plan that charges. Relying on a MagicMock session to
    # incidentally yield "no features" would turn a charging test silently
    # free the day that resolution changes.
    monkeypatch.setattr(
        "app.services.plan_entitlements_service.get_entitlements",
        lambda client_id, session, **kwargs: SimpleNamespace(has_feature=lambda name: False, limit_for=lambda name: 0),
    )
    monkeypatch.setattr("app.services.credit_service.get_credit_cost", lambda db, action: 5)
    # 100 credits -> 20 affordable pages; bot_id must be threaded through.
    monkeypatch.setattr("app.services.credit_service.get_balance", lambda db, cid, bot_id=None: 100)

    resp = TestClient(_build_app()).post("/crawl/discover", json={"url": "https://acme.test"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_found"] == 30
    assert body["cost_per_page"] == 5
    assert body["balance"] == 100
    assert body["max_affordable_pages"] == 20  # 100 // 5
    assert body["credits_required_full"] == 150  # 30 * 5
    assert body["exceeds_balance"] is True  # 150 > 100
    assert body["urls"] == fake_urls


# ── The preview's time budget and its honesty about partial results ──────


def test_link_phase_budget_is_the_remainder_of_the_route_budget_with_a_floor():
    """Two 20 second phases in a row could take 40 against a route that
    promises about 20 and a browser that gives up at 30. The link phase gets
    whatever is left of one overall budget, never less than a floor that still
    lets it find something."""
    from app.api.document_routes import _link_phase_budget

    assert _link_phase_budget(elapsed=3.0) == pytest.approx(22.0)
    assert _link_phase_budget(elapsed=20.0) == pytest.approx(5.0)
    assert _link_phase_budget(elapsed=31.0) == pytest.approx(5.0)


def _wire_discover(monkeypatch, *, sitemap_urls, link_urls, link_truncated):
    from contextlib import contextmanager

    @contextmanager
    def _ctx(s):
        yield s

    seen: dict = {}
    monkeypatch.setattr("app.schemas.client._is_public_hostname", lambda h: True)
    monkeypatch.setattr(document_routes, "get_session", lambda: _ctx(MagicMock()))
    monkeypatch.setattr("app.services.plan_service.get_client_plan", lambda db, cid: SimpleNamespace(name="Standard"))
    monkeypatch.setattr("app.services.plan_service.get_crawl_limits", lambda plan: {"max_crawl_pages": UNLIMITED})
    monkeypatch.setattr(document_routes, "resolve_crawl_pricing", lambda db, cid, bid: (5, 0))
    monkeypatch.setattr("app.services.credit_service.get_balance", lambda db, cid, bot_id=None: 100)

    async def fake_sitemap(url, **kwargs):
        return list(sitemap_urls)

    async def fake_links(url, **kwargs):
        seen["link_timeout"] = kwargs.get("timeout")
        stats = kwargs.get("stats")
        if stats is not None and link_truncated:
            stats["truncated"] = True
        return list(link_urls)

    monkeypatch.setattr("app.services.url_discovery.discover_website_urls", fake_sitemap)
    monkeypatch.setattr("app.services.url_discovery.discover_via_links", fake_links)
    return seen


def test_a_deadline_truncated_link_scan_is_reported_as_capped(monkeypatch):
    seen = _wire_discover(
        monkeypatch,
        sitemap_urls=["https://acme.test"],
        link_urls=["https://acme.test", "https://acme.test/a", "https://acme.test/b"],
        link_truncated=True,
    )
    body = TestClient(_build_app()).post("/crawl/discover", json={"url": "https://acme.test"}).json()
    assert body["total_found"] == 3
    assert body["capped"] is True
    assert seen["link_timeout"] <= 25.0


def test_a_complete_link_scan_is_not_reported_as_capped(monkeypatch):
    _wire_discover(
        monkeypatch,
        sitemap_urls=["https://acme.test"],
        link_urls=["https://acme.test", "https://acme.test/a"],
        link_truncated=False,
    )
    body = TestClient(_build_app()).post("/crawl/discover", json={"url": "https://acme.test"}).json()
    assert body["capped"] is False
