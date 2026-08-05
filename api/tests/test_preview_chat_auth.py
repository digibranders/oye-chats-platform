"""B4: owner-preview chat auth.

A logged-in client can test *any of their own bots* from the dashboard Build
Studio via ``?preview=true&bot_id=`` + ``X-API-Key``:
  - the origin/allowed_domains check is bypassed (the caller is the authenticated
    owner, not an anonymous widget visitor),
  - a non-owner cannot preview someone else's bot (404),
  - non-preview requests fall through to ``get_current_bot`` unchanged,
  - preview replies are FREE (no ``ai_chat`` credit deduction) — proven by a
    credit-less client getting 200 instead of the 402 the paid path would raise.

Real-Postgres via the shared ``db`` fixture; skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.db.models import Bot, Client

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="preview-chat auth tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


@contextmanager
def _patch_session(db):
    from app.api import auth

    with patch.object(auth, "get_session", lambda: _session_cm(db)):
        yield True


def _make_client_bot(db, *, email, api_key, allowed_domains=None, domain_check=False):
    client = Client(name="Owner", email=email, api_key=api_key, hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(
        client_id=client.id,
        bot_key=f"bot-{api_key}",
        name="Preview Bot",
        system_prompt="",
        allowed_domains=allowed_domains or [],
        domain_check_enabled=domain_check,
    )
    db.add(bot)
    db.flush()
    db.commit()
    return client, bot


def test_owner_preview_resolves_bot_and_bypasses_origin(db):
    from app.api.auth import get_bot_for_chat

    _, bot = _make_client_bot(
        db,
        email="prev-owner@example.com",
        api_key="prev-owner-key",
        allowed_domains=["only-my-site.com"],
        domain_check=True,
    )
    with _patch_session(db):
        # domain_check_enabled=True + a non-matching allowlist, yet preview must
        # succeed — the origin check is intentionally skipped for the owner.
        result = get_bot_for_chat(
            request=None,
            preview=True,
            bot_id=bot.id,
            bot_key="",
            api_key="prev-owner-key",
            impersonation_token=None,
        )
    assert result.id == bot.id
    assert getattr(result, "_is_preview", False) is True


def test_preview_non_owner_gets_404(db):
    from app.api.auth import get_bot_for_chat

    _, bot = _make_client_bot(db, email="prev-a@example.com", api_key="prev-a-key")
    other = Client(name="Other", email="prev-b@example.com", api_key="prev-b-key", hashed_password="h")
    db.add(other)
    db.flush()
    db.commit()
    with _patch_session(db), pytest.raises(HTTPException) as exc:
        get_bot_for_chat(
            request=None,
            preview=True,
            bot_id=bot.id,
            bot_key="",
            api_key="prev-b-key",
            impersonation_token=None,
        )
    assert exc.value.status_code == 404


def test_non_preview_falls_through_to_get_current_bot():
    """preview=False must delegate to get_current_bot unchanged (no preview flag)."""
    from app.api import auth

    sentinel = object()
    with patch.object(auth, "get_current_bot", lambda request, bot_key, api_key: sentinel):
        result = auth.get_bot_for_chat(request="REQ", preview=False, bot_id=None, bot_key="k", api_key="a")
    assert result is sentinel


def test_preview_reply_is_free_for_credit_less_client(db):
    """A client with zero credits still gets a 200 preview reply — proving the
    ai_chat deduction (which would 402 on the paid path) is skipped."""
    from app.api import chat_routes
    from app.api.auth import get_bot_for_chat

    _, bot = _make_client_bot(db, email="prev-free@example.com", api_key="prev-free-key")
    bot._is_preview = True  # what get_bot_for_chat stamps for owner-preview

    app = FastAPI()
    app.include_router(chat_routes.router)
    app.dependency_overrides[get_bot_for_chat] = lambda: bot
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(chat_routes, "bot_subscription_status", lambda *a, **k: "active"),
        patch.object(
            chat_routes, "rag_pipeline", lambda *a, **k: {"answer": "Hi there", "sources": ["https://acme.com/x"]}
        ),
        patch.object(chat_routes, "submit_background", lambda *a, **k: None),
    ):
        res = api.post("/chat?preview=true&bot_id=1", json={"question": "What are your plans?"})

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["answer"] == "Hi there"
    assert body["sources"] == ["https://acme.com/x"]
