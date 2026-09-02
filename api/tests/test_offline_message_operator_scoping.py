# Regression test for the operator-to-bot collapse missing on the offline
# message mutation routes.
#
# ``GET /offline-messages`` collapses an operator session down to the single
# bot the operator is bound to, so a modified request cannot read a sibling
# bot's inbox. ``PATCH /offline-messages/{id}`` and
# ``DELETE /offline-messages/{id}`` only checked ``bot.client_id``, which stops
# cross-tenant access but lets an operator bound to bot A mark-read or
# permanently delete bot B's messages inside the same workspace.
#
# Harness mirrors tests/test_crawl_endpoint_bot_ledger_credits.py: bare
# FastAPI app + router + dependency overrides + a fake session.
from contextlib import contextmanager
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import offline_message_routes
from app.api.auth import get_current_client_or_operator
from app.api.offline_message_routes import router
from app.db.models import Bot, OfflineMessage

CLIENT_ID = 1
BOT_A = 10
BOT_B = 20
MSG_ON_A = 100
MSG_ON_B = 200


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeSession:
    """Resolves ``select(OfflineMessage)`` / ``select(Bot)`` by primary key.

    Dispatch is on the mapped entity plus the compiled ``id_1`` bind param, so
    the fake answers whatever order the route issues its two lookups in.
    """

    def __init__(self):
        self.messages = {
            MSG_ON_A: SimpleNamespace(id=MSG_ON_A, bot_id=BOT_A, status="new", read_at=None, replied_at=None),
            MSG_ON_B: SimpleNamespace(id=MSG_ON_B, bot_id=BOT_B, status="new", read_at=None, replied_at=None),
        }
        self.bots = {
            BOT_A: SimpleNamespace(id=BOT_A, client_id=CLIENT_ID),
            BOT_B: SimpleNamespace(id=BOT_B, client_id=CLIENT_ID),
        }
        self.deleted: list[object] = []
        self.commits = 0

    def execute(self, stmt):
        entity = stmt.column_descriptions[0].get("entity")
        row_id = stmt.compile().params.get("id_1")
        if entity is OfflineMessage:
            return _FakeResult(self.messages.get(row_id))
        if entity is Bot:
            return _FakeResult(self.bots.get(row_id))
        raise AssertionError(f"unexpected select against {entity!r}")

    def delete(self, obj):
        self.deleted.append(obj)

    def commit(self):
        self.commits += 1


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(monkeypatch, auth: dict) -> tuple[TestClient, _FakeSession]:
    session = _FakeSession()
    monkeypatch.setattr(offline_message_routes, "get_session", lambda: _session_ctx(session))

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: auth
    return TestClient(app), session


def _operator_auth(bot_id: int) -> dict:
    return {
        "type": "operator",
        "entity": SimpleNamespace(id=7, bot_id=bot_id, role="operator"),
        "client_id": CLIENT_ID,
        "operator_id": 7,
        "bot_id": bot_id,
    }


def _client_auth() -> dict:
    return {
        "type": "client",
        "entity": SimpleNamespace(id=CLIENT_ID),
        "client_id": CLIENT_ID,
        "operator_id": None,
    }


# ── PATCH ────────────────────────────────────────────────────────────────────


def test_operator_may_patch_message_on_their_own_bot(monkeypatch):
    client, session = _build_app(monkeypatch, _operator_auth(BOT_A))

    resp = client.patch(f"/offline-messages/{MSG_ON_A}", json={"status": "read"})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"success": True, "status": "read"}
    assert session.messages[MSG_ON_A].status == "read"


def test_operator_may_not_patch_sibling_bot_message(monkeypatch):
    """Same workspace, different bot. The operator's bound bot_id must win."""
    client, session = _build_app(monkeypatch, _operator_auth(BOT_A))

    resp = client.patch(f"/offline-messages/{MSG_ON_B}", json={"status": "read"})

    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "Access denied."
    assert session.messages[MSG_ON_B].status == "new"


def test_operator_without_bound_bot_may_not_patch(monkeypatch):
    """An operator row with a null bot_id has no inbox at all, matching the
    list route, which returns an empty page rather than the whole workspace."""
    client, session = _build_app(monkeypatch, _operator_auth(None))

    resp = client.patch(f"/offline-messages/{MSG_ON_A}", json={"status": "read"})

    assert resp.status_code == 403, resp.text
    assert session.messages[MSG_ON_A].status == "new"


def test_client_may_patch_any_bot_in_their_workspace(monkeypatch):
    client, session = _build_app(monkeypatch, _client_auth())

    for message_id in (MSG_ON_A, MSG_ON_B):
        resp = client.patch(f"/offline-messages/{message_id}", json={"status": "read"})
        assert resp.status_code == 200, resp.text
        assert session.messages[message_id].status == "read"


# ── DELETE ───────────────────────────────────────────────────────────────────


def test_operator_may_delete_message_on_their_own_bot(monkeypatch):
    client, session = _build_app(monkeypatch, _operator_auth(BOT_A))

    resp = client.delete(f"/offline-messages/{MSG_ON_A}")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"success": True}
    assert [m.id for m in session.deleted] == [MSG_ON_A]


def test_operator_may_not_delete_sibling_bot_message(monkeypatch):
    client, session = _build_app(monkeypatch, _operator_auth(BOT_A))

    resp = client.delete(f"/offline-messages/{MSG_ON_B}")

    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "Access denied."
    assert session.deleted == []


def test_operator_without_bound_bot_may_not_delete(monkeypatch):
    client, session = _build_app(monkeypatch, _operator_auth(None))

    resp = client.delete(f"/offline-messages/{MSG_ON_A}")

    assert resp.status_code == 403, resp.text
    assert session.deleted == []


def test_client_may_delete_any_bot_in_their_workspace(monkeypatch):
    client, session = _build_app(monkeypatch, _client_auth())

    for message_id in (MSG_ON_A, MSG_ON_B):
        assert client.delete(f"/offline-messages/{message_id}").status_code == 200
    assert sorted(m.id for m in session.deleted) == [MSG_ON_A, MSG_ON_B]
