"""Web and Expo push are independent transports.

Two defects motivated the split, and both are easy to reintroduce:

1. ``PUSH_ENABLED`` was derived purely from VAPID web-push keys, yet the
   fan-out helpers early-returned on it, so dropping VAPID silently killed
   *mobile* push, which needs no local key material at all.

2. Dispatch skipped any operator holding a WebSocket, treating "connected" as
   "watching a dashboard". A mobile client keeps its socket open while
   backgrounded, so it looked present and received nothing. Presence must mute
   a *transport* (web push, already covered by the in-page toast), never the
   recipient.

These tests use fake sessions rather than Postgres so they also guard the logic
in environments without a database.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services import push_service


class _Result:
    """Minimal stand-in for a SQLAlchemy Result."""

    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return list(self._rows)

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None


class _Session:
    """Returns the same canned rows for every query, which is enough: the code
    under test decides *whether* to run each query, and that is what we assert.
    """

    def __init__(self, rows):
        self._rows = rows

    def execute(self, _stmt):
        return _Result(self._rows)


def _capture(monkeypatch):
    """Record what each transport was handed, without sending anything."""
    seen: dict[str, list] = {"web": [], "expo": []}

    def fake_web(_session, subs, _payload, *, tag=None, ttl=None):
        seen["web"] = list(subs)
        return len(subs)

    def fake_expo(_session, tokens, _payload):
        seen["expo"] = list(tokens)
        return len(tokens)

    monkeypatch.setattr(push_service, "_send_push_to_rows", fake_web)
    monkeypatch.setattr(push_service, "_send_expo_pushes_to_rows", fake_expo)
    return seen


def test_operator_gets_both_transports_by_default(monkeypatch):
    seen = _capture(monkeypatch)
    session = _Session([SimpleNamespace(id=1)])

    push_service.send_push_to_operator(session, 7, {"title": "hi"})

    assert seen["web"], "web push must still be sent by default"
    assert seen["expo"], "expo push must still be sent by default"


def test_connected_operator_keeps_expo_but_not_web(monkeypatch):
    """The regression that left mobile silent.

    A connected operator has an in-page toast, so web push is redundant, but a
    browser toast is invisible on a phone, so Expo must still fire.
    """
    seen = _capture(monkeypatch)
    session = _Session([SimpleNamespace(id=1)])

    push_service.send_push_to_operator(session, 7, {"title": "hi"}, web=False)

    assert seen["web"] == [], "web push must be suppressed for a connected operator"
    assert seen["expo"], "expo push must NOT be suppressed by WebSocket presence"


def test_expo_can_be_muted_without_touching_web(monkeypatch):
    seen = _capture(monkeypatch)
    session = _Session([SimpleNamespace(id=1)])

    push_service.send_push_to_operator(session, 7, {"title": "hi"}, expo=False)

    assert seen["web"], "web push must be unaffected when expo is suppressed"
    assert seen["expo"] == []


def test_web_push_disabled_does_not_disable_expo(monkeypatch):
    """The original bug: one VAPID-derived flag gated both transports."""
    monkeypatch.setattr(push_service, "WEB_PUSH_ENABLED", False)
    monkeypatch.setattr(push_service, "EXPO_PUSH_ENABLED", True)

    ok, status = push_service.send_push_to_subscription(
        "https://push.example.com/sub", "p256dh", "auth", {"title": "hi"}
    )
    assert ok is False, "web push must be inert without VAPID"

    sent: dict = {}

    def fake_post(_url, json=None, timeout=None):
        sent["messages"] = json
        return SimpleNamespace(status_code=200, json=lambda: {"data": [{"status": "ok"}]})

    monkeypatch.setattr(push_service.httpx, "post", fake_post)

    delivered = push_service._send_expo_pushes_to_rows(
        _Session([]), [SimpleNamespace(id=1, token="ExponentPushToken[x]", last_used_at=None)], {"body": "hi"}
    )

    assert delivered == 1, "expo push must work with VAPID absent"
    assert sent["messages"], "expo request must have been attempted"


def test_expo_disabled_flag_skips_the_http_call(monkeypatch):
    monkeypatch.setattr(push_service, "EXPO_PUSH_ENABLED", False)

    def explode(*_a, **_k):  # pragma: no cover - must never run
        raise AssertionError("expo HTTP call attempted while disabled")

    monkeypatch.setattr(push_service.httpx, "post", explode)

    delivered = push_service._send_expo_pushes_to_rows(
        _Session([]), [SimpleNamespace(id=1, token="ExponentPushToken[x]", last_used_at=None)], {"body": "hi"}
    )
    assert delivered == 0


def test_owner_opt_out_is_honoured():
    """``send_push_to_client`` is a real delivery path for small teams, so the
    owner's prefs must be consulted the same way an operator's are."""
    muted = _Session([{"push": {"enabled": False}}])
    assert push_service.client_wants_push(muted, 1, "handoff_request") is False

    per_event = _Session([{"push": {"events": {"handoff_request": False}}}])
    assert push_service.client_wants_push(per_event, 1, "handoff_request") is False
    assert push_service.client_wants_push(per_event, 1, "chat_transferred") is True

    # Absent prefs mean opted in, the convention used throughout push_service.
    assert push_service.client_wants_push(_Session([None]), 1, "handoff_request") is True
