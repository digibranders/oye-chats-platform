from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_client_or_operator
from app.api.bot_routes import public_router, router
from app.db.models import BotGrowthEvent


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value


class _ExecuteResult:
    def __init__(self, value):
        self._value = value

    def scalars(self):
        return _ScalarResult(self._value)


@contextmanager
def _session_context(session):
    yield session


def _build_test_client():
    app = FastAPI()
    app.include_router(public_router)
    app.include_router(router)
    return app


class TestBotDemoRoutes:
    def test_demo_page_returns_html_and_tracks_open(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        added = []
        session.add.side_effect = added.append
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert 'data-bot-key="bot-demo123"' in response.text
        assert "Sales Assistant" in response.text
        assert len(added) == 1
        assert isinstance(added[0], BotGrowthEvent)
        assert added[0].event_type == "demo_link_opened"
        assert added[0].bot_id == 7
        session.commit.assert_called_once()

    def test_demo_page_returns_404_for_unknown_bot(self, monkeypatch):
        from app.api import bot_routes

        session = MagicMock()
        session.execute.return_value = _ExecuteResult(None)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-missing")

        assert response.status_code == 404
        session.add.assert_not_called()
        session.commit.assert_not_called()

    def test_demo_share_click_requires_auth(self):
        client = TestClient(_build_test_client())
        response = client.post("/bots/7/demo-share-click")
        assert response.status_code == 401

    def test_demo_share_click_tracks_event_for_workspace_user(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(id=7, name="Sales Assistant", client_id=9)
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        added = []
        session.add.side_effect = added.append
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        app = _build_test_client()
        app.dependency_overrides[get_current_client_or_operator] = lambda: {
            "type": "client",
            "entity": SimpleNamespace(id=9),
            "client_id": 9,
            "operator_id": None,
        }

        client = TestClient(app)
        response = client.post("/bots/7/demo-share-click")

        assert response.status_code == 200
        assert response.json() == {"success": True, "event_type": "demo_share_clicked"}
        assert len(added) == 1
        assert isinstance(added[0], BotGrowthEvent)
        assert added[0].event_type == "demo_share_clicked"
        assert added[0].bot_id == 7
        session.commit.assert_called_once()

    def test_preview_with_url_returns_iframe_html(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        added = []
        session.add.side_effect = added.append
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=https://example.com")

        assert response.status_code == 200
        assert "<iframe" in response.text
        assert 'data-bot-key="bot-demo123"' in response.text
        assert "Sales Assistant" in response.text
        assert "Preview" in response.text
        assert len(added) == 1
        assert added[0].event_type == "demo_link_opened"

    def test_preview_without_url_returns_hero(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123")

        assert response.status_code == 200
        assert "Interactive Demo" in response.text
        assert "<iframe" not in response.text

    def test_preview_rejects_javascript_url(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=javascript:alert(1)")

        assert response.status_code == 400
        assert "http or https" in response.json()["detail"]

    def test_preview_with_edit_flag_injects_bootstrap(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda _url: True)

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=https://example.com&edit=1")

        assert response.status_code == 200
        assert "window.__OYECHATS_PREVIEW_MODE__=true" in response.text
        assert "<iframe" in response.text

    def test_preview_without_edit_flag_omits_bootstrap(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))
        monkeypatch.setattr(bot_routes, "_check_iframe_allowed", lambda _url: True)

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=https://example.com")

        assert response.status_code == 200
        assert "__OYECHATS_PREVIEW_MODE__" not in response.text

    def test_hero_page_with_edit_flag_injects_bootstrap(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="https://example.com",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?edit=1")

        assert response.status_code == 200
        assert "<iframe" not in response.text
        assert "window.__OYECHATS_PREVIEW_MODE__=true" in response.text

    def test_preview_rejects_empty_netloc(self, monkeypatch):
        from app.api import bot_routes

        bot = SimpleNamespace(
            id=7,
            bot_key="bot-demo123",
            name="Sales Assistant",
            website="",
            is_active=True,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        session.add.side_effect = lambda x: None
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_context(session))

        client = TestClient(_build_test_client())
        response = client.get("/demo/bot-demo123?url=http://")

        assert response.status_code == 400
        assert "Invalid URL" in response.json()["detail"]
