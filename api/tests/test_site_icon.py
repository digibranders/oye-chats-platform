"""On-demand website-icon endpoint (`POST /bots/{bot_id}/site-icon`).

DB-free: the bot lookup and the favicon pipeline are both mocked, so these run
anywhere and exercise the route's own logic — website presence, the async fetch
bridge, PNG normalisation, and the status codes — rather than Postgres or the
network. The extractor and the logo pipeline have their own suites.
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api import bot_routes
from app.api.auth import get_current_client_or_operator
from app.core.rate_limit import limiter


@contextmanager
def _session_ctx():
    # The bot lookup is mocked, so the session object itself is never touched.
    yield object()


def _app(monkeypatch, *, website):
    monkeypatch.setattr(bot_routes, "get_session", _session_ctx)
    monkeypatch.setattr(bot_routes, "_require_bot_management_access", lambda auth: None)
    monkeypatch.setattr(
        bot_routes,
        "_get_workspace_bot",
        lambda session, bot_id, client_id: SimpleNamespace(id=bot_id, website=website, bot_key="bot-x"),
    )
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(bot_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "client_id": 1,
        "operator_id": None,
    }
    return TestClient(app)


def test_site_icon_requires_a_website(monkeypatch):
    resp = _app(monkeypatch, website=None).post("/bots/7/site-icon")
    assert resp.status_code == 400
    assert "website" in resp.json()["detail"].lower()


def test_site_icon_returns_png_when_found(monkeypatch):
    monkeypatch.setattr(
        "app.services.favicon_extractor.fetch_favicon_image",
        AsyncMock(return_value=b"raw-icon-bytes"),
    )
    monkeypatch.setattr("app.services.r2_service.process_image_for_logo", lambda data: b"\x89PNG-processed")

    resp = _app(monkeypatch, website="https://acme.com").post("/bots/7/site-icon")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.headers["cache-control"] == "no-store"
    assert resp.content == b"\x89PNG-processed"


def test_site_icon_404_when_no_icon_found(monkeypatch):
    monkeypatch.setattr(
        "app.services.favicon_extractor.fetch_favicon_image",
        AsyncMock(return_value=None),
    )
    resp = _app(monkeypatch, website="https://acme.com").post("/bots/7/site-icon")
    assert resp.status_code == 404


def test_site_icon_422_when_pipeline_rejects(monkeypatch):
    monkeypatch.setattr(
        "app.services.favicon_extractor.fetch_favicon_image",
        AsyncMock(return_value=b"raw-icon-bytes"),
    )
    monkeypatch.setattr("app.services.r2_service.process_image_for_logo", lambda data: None)
    resp = _app(monkeypatch, website="https://acme.com").post("/bots/7/site-icon")
    assert resp.status_code == 422
