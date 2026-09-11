"""``POST /operators/handoff``: an operator with only the mobile app is reachable.

With nobody on a socket (``all_offline`` or ``no_operators``), the route promotes
the handoff from the offline form to a real queue when push can still wake
someone in the workspace. It asked ``operator_push_subscriptions`` (web push)
alone, but ``task_dispatch_handoff_push`` also sends Expo push to the mobile
app. A workspace whose operators only use the app therefore got the offline
form, and nobody was alerted while they waited.

Runs against Postgres so the ownership query is exercised for real: a token
counts when it belongs to an operator of the workspace or to its owner, and
never when it belongs to another workspace.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.operator_routes import router as operator_router
from app.db.models import Bot, ChatSession, Client, Operator, OperatorExpoPushToken, OperatorPushSubscription
from app.services import live_chat_availability_service as availsvc

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture
def enqueued(monkeypatch) -> list[str]:
    """Every side effect of the handoff stubbed out; the job names enqueued are recorded."""
    from app.api import operator_routes
    from app.services import email_service, notification_service, webhook_service
    from app.services.notification_broadcaster import broadcaster

    jobs: list[str] = []
    monkeypatch.setattr(operator_routes, "manager", SimpleNamespace(request_handoff=AsyncMock()))
    monkeypatch.setattr(operator_routes.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: True)
    monkeypatch.setattr(availsvc, "invalidate", lambda *a, **k: None)
    monkeypatch.setattr("app.worker.enqueue.enqueue_sync", lambda name, *a, **k: jobs.append(name))
    monkeypatch.setattr(webhook_service, "fire_webhook", lambda *a, **k: None)
    monkeypatch.setattr(email_service, "get_notification_recipients", lambda *a, **k: [])
    monkeypatch.setattr(notification_service, "notify_handoff_request", lambda *a, **k: None)
    # Nobody has the dashboard open, so push is the only way to reach anyone.
    monkeypatch.setattr(broadcaster, "connection_count", lambda _client_id: 0)
    getattr(operator_routes, "_handoff_dedupe", {}).clear()
    return jobs


def _workspace(db, suffix: str) -> SimpleNamespace:
    client = Client(name=f"WS {suffix}", email=f"owner@{suffix}.test", api_key=f"key-{suffix}", hashed_password="h")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key=f"bot-{suffix}", name="Bot")
    db.add(bot)
    db.flush()
    operator = Operator(
        client_id=client.id, bot_id=bot.id, name="Op", email=f"op@{suffix}.test", operator_api_key=f"opkey-{suffix}"
    )
    db.add(operator)
    db.flush()
    session_id = f"s-{suffix}"
    db.add(ChatSession(id=session_id, client_id=client.id, bot_id=bot.id, status="bot"))
    db.commit()
    return SimpleNamespace(
        client_id=client.id,
        operator_id=operator.id,
        session_id=session_id,
        bot=SimpleNamespace(id=bot.id, client_id=client.id, bot_key=bot.bot_key, name=bot.name),
    )


def _handoff(world, monkeypatch, state: availsvc.LiveChatState = availsvc.LiveChatState.ALL_OFFLINE) -> dict:
    verdict = availsvc.LiveChatAvailability(
        state=state, suggested_action=availsvc.SuggestedAction.OFFLINE_FORM, message_key=state.value
    )
    monkeypatch.setattr(availsvc, "resolve_live_chat_state", lambda *a, **k: verdict)
    app = FastAPI()
    app.include_router(operator_router)
    app.dependency_overrides[get_current_bot] = lambda: world.bot
    resp = TestClient(app).post("/operators/handoff", json={"session_id": world.session_id})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _status(db, session_id: str) -> str:
    db.expire_all()
    return db.get(ChatSession, session_id).status


def _expo_token(token: str, *, operator_id: int | None = None, client_id: int | None = None) -> OperatorExpoPushToken:
    return OperatorExpoPushToken(token=f"ExponentPushToken[{token}]", operator_id=operator_id, client_id=client_id)


@pytest.mark.parametrize("state", [availsvc.LiveChatState.ALL_OFFLINE, availsvc.LiveChatState.NO_OPERATORS])
def test_an_operator_with_only_the_mobile_app_gets_the_visitor_queued(db, monkeypatch, enqueued, state):
    world = _workspace(db, "mobile-op")
    db.add(_expo_token("mobile-op", operator_id=world.operator_id))
    db.commit()

    body = _handoff(world, monkeypatch, state)

    assert body["suggested_action"] == "wait"
    assert _status(db, world.session_id) == "waiting"
    assert "task_dispatch_handoff_push" in enqueued


def test_an_owner_with_only_the_mobile_app_gets_the_visitor_queued(db, monkeypatch, enqueued):
    """``task_dispatch_handoff_push`` also pushes the owner's own devices."""
    world = _workspace(db, "mobile-owner")
    db.add(_expo_token("mobile-owner", client_id=world.client_id))
    db.commit()

    body = _handoff(world, monkeypatch)

    assert body["suggested_action"] == "wait"
    assert _status(db, world.session_id) == "waiting"
    assert "task_dispatch_handoff_push" in enqueued


def test_a_browser_push_subscription_still_gets_the_visitor_queued(db, monkeypatch, enqueued):
    world = _workspace(db, "web-op")
    db.add(
        OperatorPushSubscription(
            operator_id=world.operator_id, endpoint="https://push.example/web-op", p256dh="key", auth="auth"
        )
    )
    db.commit()

    body = _handoff(world, monkeypatch)

    assert body["suggested_action"] == "wait"
    assert "task_dispatch_handoff_push" in enqueued


def test_a_phone_in_another_workspace_does_not_count(db, monkeypatch, enqueued):
    world = _workspace(db, "quiet")
    other = _workspace(db, "elsewhere")
    db.add(_expo_token("elsewhere-op", operator_id=other.operator_id))
    db.add(_expo_token("elsewhere-owner", client_id=other.client_id))
    db.commit()

    body = _handoff(world, monkeypatch)

    assert body["suggested_action"] == "offline_form"
    assert body["fallback_reason"] == "all_offline"
    assert _status(db, world.session_id) == "bot"
    assert enqueued == []


def test_with_no_push_at_all_the_visitor_gets_the_offline_form(db, monkeypatch, enqueued):
    world = _workspace(db, "no-push")

    body = _handoff(world, monkeypatch)

    assert body["suggested_action"] == "offline_form"
    assert _status(db, world.session_id) == "bot"
    assert enqueued == []
