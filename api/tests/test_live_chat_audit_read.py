"""ChatAuditLog is written on every live-chat state transition and read by
nothing — this is the first read path."""

import pytest

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


@pytest.fixture
def app_with_router():
    from fastapi import FastAPI

    from app.api.live_chat_audit_routes import router

    app = FastAPI()
    app.include_router(router)
    return app


def test_returns_the_session_s_transitions_oldest_first(db, app_with_router):
    from fastapi.testclient import TestClient

    from app.api.auth import get_current_client_or_operator
    from app.db.models import ChatAuditLog, ChatSession, Client

    client_row = Client(name="Audit Co", email="audit@test.example", api_key="key-audit")
    db.add(client_row)
    db.flush()
    session = ChatSession(id="sess-audit-1", client_id=client_row.id, status="closed")
    db.add(session)
    db.add_all(
        [
            ChatAuditLog(session_id=session.id, action="handoff_requested"),
            ChatAuditLog(session_id=session.id, action="accepted"),
            ChatAuditLog(session_id=session.id, action="closed"),
        ]
    )
    db.commit()

    app_with_router.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "client_id": client_row.id,
    }
    resp = TestClient(app_with_router).get(f"/chat/sessions/{session.id}/audit")

    assert resp.status_code == 200
    actions = [row["action"] for row in resp.json()["entries"]]
    assert actions == ["handoff_requested", "accepted", "closed"]


def test_refuses_a_session_belonging_to_another_client(db, app_with_router):
    from fastapi.testclient import TestClient

    from app.api.auth import get_current_client_or_operator
    from app.db.models import ChatSession, Client

    owner = Client(name="Owner Co", email="owner@test.example", api_key="key-owner")
    stranger = Client(name="Stranger Co", email="stranger@test.example", api_key="key-stranger")
    db.add_all([owner, stranger])
    db.flush()
    session = ChatSession(id="sess-audit-2", client_id=owner.id, status="closed")
    db.add(session)
    db.commit()

    app_with_router.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "client_id": stranger.id,
    }
    resp = TestClient(app_with_router).get(f"/chat/sessions/{session.id}/audit")

    assert resp.status_code == 404
