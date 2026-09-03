"""Audit A7: the widget branch of ``GET /chat/history/{session_id}`` must go
through ``get_current_bot``.

It used to resolve the bot with a local ``SELECT`` on ``bot_key``, which skipped
both guarantees the shared resolver provides: the bot's origin allowlist and the
owner's suspension / deactivation check. A suspended workspace's transcripts
stayed readable to anyone holding the (public) bot key.
"""

from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.chat_routes import router


def _app():
    app = FastAPI()
    app.include_router(router)
    return app


class TestHistoryWidgetAuth:
    def test_suspended_owner_is_rejected(self):
        tc = TestClient(_app(), raise_server_exceptions=False)

        def _suspended(*_args, **_kwargs):
            raise HTTPException(status_code=403, detail="account_suspended")

        with patch("app.api.chat_routes.get_current_bot", side_effect=_suspended):
            resp = tc.get("/chat/history/s-1", headers={"X-Bot-Key": "bot-public"})

        assert resp.status_code == 403
        assert resp.json()["detail"] == "account_suspended"

    def test_resolver_receives_the_bot_key_header(self):
        tc = TestClient(_app(), raise_server_exceptions=False)
        calls = []

        def _resolve(request, *, bot_key, api_key):
            calls.append((bot_key, api_key))
            return SimpleNamespace(id=7, client_id=3)

        # The query itself is out of scope here: stub the session factory so
        # the route fails past the resolver, and assert how it was called.
        with (
            patch("app.api.chat_routes.get_current_bot", side_effect=_resolve),
            patch("app.api.chat_routes.get_session", side_effect=RuntimeError("no db")),
        ):
            tc.get("/chat/history/s-1", headers={"X-Bot-Key": "bot-public"})

        assert calls == [("bot-public", None)]

    def test_missing_credentials_still_401(self):
        tc = TestClient(_app(), raise_server_exceptions=False)
        resp = tc.get("/chat/history/s-1")
        assert resp.status_code == 401
