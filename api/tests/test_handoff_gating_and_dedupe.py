"""``POST /operators/handoff``: what may be promoted to a queue, and how often.

Two defects, both reachable from a public bot key:

* **Push promotion ignored the state.** The branch that promotes an
  ``offline_form`` verdict into a real queue entry fired for ANY such verdict as
  soon as one push-subscription row existed, so ``feature_disabled``,
  ``out_of_hours`` and ``queue_full`` were all queued anyway. The bot's own
  ``live_chat_enabled`` toggle became decorative: the plan gate above it checks
  only the PLAN half (``is_live_chat_enabled_for_bot`` documents that callers
  must AND it with the toggle) and the state machine's answer was then ignored.
* **No idempotency.** The widget re-polls this endpoint every 15s while showing
  the offline form, and every call re-ran the whole fan-out: audit row, webhook,
  one email per configured recipient, a push dispatch, an escalation job and a
  bell notification. One visitor with a tab open produced roughly four of each
  per minute, indefinitely.

Driven by a MagicMock session (the same harness as
``test_handoff_tenant_isolation``), so no Postgres is required.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.operator_routes import router
from app.services import live_chat_availability_service as availsvc


class _ScalarOneResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


@contextmanager
def _session_context(session):
    yield session


def _app_with_bot(bot):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    return app


class Harness:
    """A wired-up ``/handoff`` with every side effect recorded, not performed."""

    def __init__(self):
        self.enqueued: list[tuple] = []
        self.webhooks: list[tuple] = []
        self.emails: list[str] = []
        self.notifications: list[str] = []
        self.handoffs: list[str] = []
        self.chat_session = SimpleNamespace(id="s1", bot_id=1, client_id=1, status="bot")
        self.db_bot = SimpleNamespace(
            id=1,
            client_id=1,
            name="Bot",
            operator_timeout_seconds=120,
            live_chat_queue_timeout_seconds=20,
            email_on_handoff=True,
            reply_to_email=None,
        )


@pytest.fixture
def harness(monkeypatch):
    from app.api import operator_routes
    from app.services import email_service, notification_service, webhook_service
    from app.worker import enqueue as enqueue_mod

    h = Harness()

    calls = {"n": 0}

    def _execute(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            return _ScalarOneResult(h.chat_session)
        if calls["n"] == 2:
            return _ScalarOneResult(h.db_bot)
        # Everything after is the push-subscriber probe: a MagicMock answers
        # every accessor truthily, which is exactly "a subscription exists".
        return MagicMock()

    session = MagicMock()
    session.execute.side_effect = _execute

    def _fresh_session():
        # One ``with get_session()`` per request, so this is the request boundary.
        calls["n"] = 0
        return _session_context(session)

    monkeypatch.setattr(operator_routes, "get_session", _fresh_session)
    monkeypatch.setattr(operator_routes, "get_lead_info_by_session", lambda *a, **k: None)
    monkeypatch.setattr(operator_routes.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: True)
    monkeypatch.setattr(availsvc, "invalidate", lambda *a, **k: None)
    monkeypatch.setattr(enqueue_mod, "enqueue_sync", lambda name, *a, **k: h.enqueued.append((name, *a)) or "job")
    monkeypatch.setattr(webhook_service, "fire_webhook", lambda *a, **k: h.webhooks.append(a))
    monkeypatch.setattr(email_service, "get_notification_recipients", lambda *a, **k: ["ops@example.com"])
    monkeypatch.setattr(
        email_service, "send_handoff_request_email", lambda recipient, *a, **k: h.emails.append(recipient)
    )
    monkeypatch.setattr(notification_service, "notify_handoff_request", lambda *a, **k: h.notifications.append("bell"))

    async def _request_handoff(session_id, *a, **k):
        h.handoffs.append((session_id, k.get("notify_operators", True)))

    monkeypatch.setattr(operator_routes.manager, "request_handoff", _request_handoff)
    # Per-process dedupe state must not leak between tests.
    getattr(operator_routes, "_handoff_dedupe", {}).clear()
    h.session = session
    return h


def _verdict(state: availsvc.LiveChatState, action=availsvc.SuggestedAction.OFFLINE_FORM):
    return availsvc.LiveChatAvailability(state=state, suggested_action=action, message_key=state.value)


def _post(harness, monkeypatch, verdict, session_id="s1"):
    monkeypatch.setattr(availsvc, "resolve_live_chat_state", lambda *a, **k: verdict)
    bot = SimpleNamespace(id=1, client_id=1, bot_key="bot-x", name="Bot")
    client = TestClient(_app_with_bot(bot))
    return client.post("/operators/handoff", json={"session_id": session_id})


# ── Defect 3: only the states push was built for may be promoted ─────────────


@pytest.mark.parametrize(
    "state",
    [
        availsvc.LiveChatState.FEATURE_DISABLED,
        availsvc.LiveChatState.OUT_OF_HOURS,
        availsvc.LiveChatState.QUEUE_FULL,
    ],
)
def test_a_hard_offline_verdict_is_never_promoted_to_a_queue_entry(harness, monkeypatch, state):
    resp = _post(harness, monkeypatch, _verdict(state))

    assert resp.status_code == 200
    body = resp.json()
    assert body["suggested_action"] == "offline_form"
    assert body["fallback_reason"] == state.value
    assert harness.chat_session.status != "waiting", f"{state.value} must not queue the visitor"
    assert harness.enqueued == []
    assert harness.emails == []
    assert harness.handoffs == []


@pytest.mark.parametrize(
    "state",
    [availsvc.LiveChatState.ALL_OFFLINE, availsvc.LiveChatState.NO_OPERATORS],
)
def test_a_reachable_workspace_is_still_promoted(harness, monkeypatch, state):
    """The promotion this branch exists for keeps working."""
    resp = _post(harness, monkeypatch, _verdict(state))

    assert resp.json()["suggested_action"] == "wait"
    assert harness.chat_session.status == "waiting"
    assert [name for name, *_ in harness.enqueued] == ["task_dispatch_handoff_push", "task_handoff_escalation"]


# ── Defect 5: the 15s re-poll must not re-fire the fan-out ───────────────────


def test_a_repeat_handoff_for_the_same_session_does_not_re_notify(harness, monkeypatch):
    verdict = _verdict(availsvc.LiveChatState.AVAILABLE, availsvc.SuggestedAction.ROUTE)

    first = _post(harness, monkeypatch, verdict)
    second = _post(harness, monkeypatch, verdict)
    third = _post(harness, monkeypatch, verdict)

    assert first.status_code == second.status_code == third.status_code == 200
    assert second.json()["status"] == "waiting"
    assert len(harness.webhooks) == 1
    assert harness.emails == ["ops@example.com"]
    assert harness.notifications == ["bell"]
    assert [name for name, *_ in harness.enqueued] == ["task_dispatch_handoff_push", "task_handoff_escalation"]
    # The queue bookkeeping still runs on every call (a visitor who cancels and
    # asks again inside the window must stay queued and still time out), but the
    # team is alerted exactly once.
    assert harness.handoffs == [("s1", True), ("s1", False), ("s1", False)]


def test_a_different_session_is_notified_normally(harness, monkeypatch):
    verdict = _verdict(availsvc.LiveChatState.AVAILABLE, availsvc.SuggestedAction.ROUTE)

    _post(harness, monkeypatch, verdict)
    harness.chat_session.id = "s2"
    _post(harness, monkeypatch, verdict, session_id="s2")

    assert len(harness.webhooks) == 2
    assert harness.emails == ["ops@example.com", "ops@example.com"]
