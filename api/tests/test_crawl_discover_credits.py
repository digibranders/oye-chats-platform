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

    # Skip the SSRF DNS resolution check in the request validator (hermetic test).
    monkeypatch.setattr("app.schemas.client._is_public_hostname", lambda h: True)
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
    # 100 credits -> 20 affordable pages; bot_id must be threaded through.
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
