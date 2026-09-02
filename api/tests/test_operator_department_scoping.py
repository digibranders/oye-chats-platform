# Regression test for unvalidated ``department_id`` on the operator write
# routes.
#
# ``POST /operators/create`` and ``PATCH /operators/{id}`` both validate
# ``bot_id`` against the caller's workspace, then write ``department_id``
# straight through. A caller could therefore bind an operator to another
# tenant's department row. Nothing cross-tenant is READ back (department lists
# and queue filters are all client_id-scoped), so the damage is a silently
# broken queue filter rather than an isolation break, but the write must be
# validated the same way ``bot_id`` is.
#
# Harness mirrors tests/test_crawl_endpoint_bot_ledger_credits.py: bare
# FastAPI app + router + dependency overrides + a fake session.
from contextlib import contextmanager
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import operator_routes
from app.api.auth import get_current_client_or_operator
from app.api.operator_routes import router
from app.db.models import Bot, Department, Operator
from app.services.plan_entitlements_service import UNLIMITED

CLIENT_ID = 1
OWN_BOT = 10
FOREIGN_BOT = 11
OWN_DEPARTMENT = 30
FOREIGN_DEPARTMENT = 31
OPERATOR_ID = 5


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value

    def scalar_one(self):
        return self._value

    def scalar(self):
        return self._value


class _FakeSession:
    """Answers the entity lookups both write routes issue.

    Every row here belongs to ``CLIENT_ID``; a select carrying a different
    ``client_id`` bind, or an id outside the owned sets, resolves to None, which
    is exactly what the real workspace-scoped query would do.
    """

    def __init__(self):
        self.operator = SimpleNamespace(
            id=OPERATOR_ID,
            client_id=CLIENT_ID,
            bot_id=OWN_BOT,
            name="Existing Operator",
            email="existing@example.com",
            role="operator",
            department_id=None,
            linked_client_id=None,
            is_active=True,
            is_online=False,
            supported_languages=[],
            avatar_url=None,
            max_concurrent_chats=3,
            notification_preferences=None,
        )
        self.added: list[object] = []
        self.commits = 0

    def execute(self, stmt):
        entity = stmt.column_descriptions[0].get("entity")
        params = stmt.compile().params
        row_id = params.get("id_1")
        scoped_to_caller = params.get("client_id_1") == CLIENT_ID
        if entity is Bot:
            found = scoped_to_caller and row_id == OWN_BOT
            return _FakeResult(SimpleNamespace(id=row_id, client_id=CLIENT_ID) if found else None)
        if entity is Department:
            found = scoped_to_caller and row_id == OWN_DEPARTMENT
            return _FakeResult(SimpleNamespace(id=row_id, client_id=CLIENT_ID) if found else None)
        if entity is Operator:
            # Create path: duplicate-email probe (no id bind) finds nothing.
            # Update path: the row being edited, looked up by id.
            if row_id is None:
                return _FakeResult(None)
            found = scoped_to_caller and row_id == OPERATOR_ID
            return _FakeResult(self.operator if found else None)
        # Aggregate count (existing departments in the workspace). A non-zero
        # answer keeps the create path off its auto-"General" branch.
        return _FakeResult(1)

    def add(self, obj):
        self.added.append(obj)

    def flush(self):
        return None

    def commit(self):
        self.commits += 1

    def refresh(self, obj):
        if getattr(obj, "id", None) is None:
            obj.id = 99


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(monkeypatch) -> tuple[TestClient, _FakeSession]:
    session = _FakeSession()
    monkeypatch.setattr(operator_routes, "get_session", lambda: _session_ctx(session))
    monkeypatch.setattr("app.services.plan_service.enforce_feature", lambda db, client_id, feature: None)
    monkeypatch.setattr(
        operator_routes,
        "resolve_operator_seat_entitlements",
        lambda db, client_id, bot_id: SimpleNamespace(limit_for=lambda name: UNLIMITED, plan_slug="standard"),
    )
    monkeypatch.setattr(operator_routes, "get_password_hash", lambda raw: f"hashed:{raw}")

    async def _noop_update_department(operator_id, department_id):
        return None

    monkeypatch.setattr(operator_routes.manager, "update_operator_department", _noop_update_department)
    monkeypatch.setattr(operator_routes.plan_entitlements_service, "invalidate", lambda client_id: None)

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": SimpleNamespace(id=CLIENT_ID),
        "client_id": CLIENT_ID,
        "operator_id": None,
    }
    return TestClient(app), session


def _create_payload(**overrides) -> dict:
    payload = {
        "name": "New Operator",
        "email": "new@example.com",
        "password": "Passw0rd123",
        "bot_id": OWN_BOT,
    }
    payload.update(overrides)
    return payload


# ── POST /operators/create ───────────────────────────────────────────────────


def test_create_accepts_own_department(monkeypatch):
    client, session = _build_app(monkeypatch)

    resp = client.post("/operators/create", json=_create_payload(department_id=OWN_DEPARTMENT))

    assert resp.status_code == 200, resp.text
    assert resp.json()["department_id"] == OWN_DEPARTMENT
    assert [op.department_id for op in session.added] == [OWN_DEPARTMENT]


def test_create_rejects_foreign_department(monkeypatch):
    """Same error shape the foreign-bot guard already uses."""
    client, session = _build_app(monkeypatch)

    resp = client.post("/operators/create", json=_create_payload(department_id=FOREIGN_DEPARTMENT))

    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Department not found in this workspace."
    assert session.added == []


def test_create_accepts_null_department(monkeypatch):
    client, session = _build_app(monkeypatch)

    resp = client.post("/operators/create", json=_create_payload())

    assert resp.status_code == 200, resp.text
    assert resp.json()["department_id"] is None


def test_create_still_rejects_foreign_bot(monkeypatch):
    client, _session = _build_app(monkeypatch)

    resp = client.post("/operators/create", json=_create_payload(bot_id=FOREIGN_BOT))

    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Bot not found in this workspace."


# ── PATCH /operators/{operator_id} ───────────────────────────────────────────


def test_update_accepts_own_department(monkeypatch):
    client, session = _build_app(monkeypatch)

    resp = client.patch(f"/operators/{OPERATOR_ID}", json={"department_id": OWN_DEPARTMENT})

    assert resp.status_code == 200, resp.text
    assert session.operator.department_id == OWN_DEPARTMENT


def test_update_rejects_foreign_department(monkeypatch):
    client, session = _build_app(monkeypatch)

    resp = client.patch(f"/operators/{OPERATOR_ID}", json={"department_id": FOREIGN_DEPARTMENT})

    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == "Department not found in this workspace."
    assert session.operator.department_id is None


def test_update_without_department_leaves_it_untouched(monkeypatch):
    client, session = _build_app(monkeypatch)
    session.operator.department_id = OWN_DEPARTMENT

    resp = client.patch(f"/operators/{OPERATOR_ID}", json={"max_concurrent_chats": 7})

    assert resp.status_code == 200, resp.text
    assert session.operator.department_id == OWN_DEPARTMENT
    assert session.operator.max_concurrent_chats == 7
