"""``PATCH /operators/{id}`` with ``is_active`` — soft deactivate / reactivate.

The point of this endpoint versus ``DELETE /operators/{id}``:
``ChatSession.assigned_operator_id`` is ``ON DELETE SET NULL``, so deleting an
operator row erases "who handled this chat" from every historical conversation
in the workspace. Deactivating frees the seat and keeps the history.

Runs against the real-Postgres ``db`` fixture: the seat gate takes a
``SELECT ... FOR UPDATE`` lock and the entitlements resolver reads live
subscription + operator rows, neither of which a mock would exercise.
"""

import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_client_or_operator
from app.api.operator_routes import router as operator_router
from app.db.models import Bot, ChatSession, Client, Operator, Plan, Subscription
from app.services.plan_entitlements_service import get_entitlements

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


# ── Fixtures / helpers ───────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _stub_manager(monkeypatch):
    """Replace the live-chat ConnectionManager with async stubs.

    The real ``disconnect_operator_and_broadcast`` spawns a grace-period
    ``asyncio`` task that outlives the TestClient's event loop. The stub keeps
    the assertions about *which* manager calls happen and leaves no dangling
    task behind.
    """
    from app.api import operator_routes

    stub = SimpleNamespace(
        update_operator_department=AsyncMock(),
        disconnect_operator_and_broadcast=AsyncMock(),
    )
    monkeypatch.setattr(operator_routes, "manager", stub)
    return stub


def _build_app(auth: dict) -> FastAPI:
    app = FastAPI()
    app.include_router(operator_router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: auth
    return app


def _client_auth(client_id: int) -> dict:
    return {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
        "linked_client_id": None,
    }


def _operator_auth(client_id: int, operator_id: int, role: str = "admin") -> dict:
    return {
        "type": "operator",
        "entity": SimpleNamespace(id=operator_id, role=role, client_id=client_id),
        "client_id": client_id,
        "operator_id": operator_id,
        "linked_client_id": None,
    }


def _workspace(db, suffix: str, *, operator_seats: int):
    """A client + bot + active Standard-like subscription with N operator seats."""
    client = Client(
        name=f"WS {suffix}",
        email=f"{suffix}@deactivation.test",
        api_key=f"key-{suffix}",
        hashed_password="h",
    )
    db.add(client)
    db.flush()

    bot = Bot(client_id=client.id, bot_key=f"bot-{suffix}", name=f"Bot {suffix}", is_legacy_pooled=False)
    db.add(bot)
    db.flush()

    plan = db.query(Plan).filter(Plan.slug == "standard-seats").one_or_none()
    if plan is None:
        plan = Plan(
            name="Standard",
            slug="standard-seats",
            monthly_price_cents=459900,
            currency="INR",
            limits={"operators": 10, "bots": 5, "documents": 100, "leads": -1, "credits": 10000},
            features={"live_chat": True},
            included_operator_seats=0,
            is_active=True,
        )
        db.add(plan)
        db.flush()

    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        operator_quantity=operator_seats,
    )
    db.add(sub)
    db.flush()
    return client, bot


def _operator(db, client, bot, suffix: str, *, is_active: bool = True, role: str = "operator") -> Operator:
    op = Operator(
        client_id=client.id,
        bot_id=bot.id,
        name=f"Op {suffix}",
        email=f"op-{suffix}@deactivation.test",
        operator_api_key=f"opkey-{suffix}",
        hashed_password="h",
        role=role,
        is_active=is_active,
    )
    db.add(op)
    db.flush()
    return op


# ── Seat accounting ──────────────────────────────────────────────────────────


def test_deactivation_frees_a_seat(db):
    client, bot = _workspace(db, "seat", operator_seats=2)
    keep = _operator(db, client, bot, "keep")
    drop = _operator(db, client, bot, "drop")
    db.commit()

    before = get_entitlements(client.id, db, include_usage=True)
    assert before.limit_for("operators") == 2
    assert before.usage["operators"] == 2

    tc = TestClient(_build_app(_client_auth(client.id)))
    resp = tc.patch(f"/operators/{drop.id}", json={"is_active": False})
    assert resp.status_code == 200, resp.text

    db.expire_all()
    after = get_entitlements(client.id, db, include_usage=True)
    assert after.usage["operators"] == 1, "the freed seat must show up immediately"
    assert db.get(Operator, drop.id).is_active is False
    assert db.get(Operator, keep.id).is_active is True


def test_deactivation_invalidates_the_entitlements_cache(db, monkeypatch):
    """The silent failure this guards: without the invalidation the freed seat
    stays hidden for the cache TTL and the customer is told to upgrade for a
    seat they just freed."""
    client, bot = _workspace(db, "cache", operator_seats=2)
    _operator(db, client, bot, "cache-a")
    drop = _operator(db, client, bot, "cache-b")
    db.commit()

    calls: list[int] = []
    from app.services import plan_entitlements_service

    monkeypatch.setattr(plan_entitlements_service, "invalidate", lambda cid: calls.append(cid))

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{drop.id}", json={"is_active": False}).status_code == 200
    assert calls == [client.id]


def test_no_op_update_does_not_touch_seats_or_sockets(db, _stub_manager):
    """Re-sending the value the row already holds is not a transition."""
    client, bot = _workspace(db, "noop", operator_seats=2)
    op = _operator(db, client, bot, "noop")
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": True}).status_code == 200

    _stub_manager.disconnect_operator_and_broadcast.assert_not_awaited()
    db.expire_all()
    assert db.get(Operator, op.id).is_active is True


# ── Reactivation is seat-gated ───────────────────────────────────────────────


def test_reactivation_past_the_ceiling_is_refused(db):
    client, bot = _workspace(db, "ceiling", operator_seats=1)
    _operator(db, client, bot, "ceiling-active")
    parked = _operator(db, client, bot, "ceiling-parked", is_active=False)
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    resp = tc.patch(f"/operators/{parked.id}", json={"is_active": True})

    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["error"] == "seat_limit_reached"

    db.expire_all()
    assert db.get(Operator, parked.id).is_active is False


def test_reactivation_within_the_ceiling_succeeds(db):
    client, bot = _workspace(db, "within", operator_seats=2)
    _operator(db, client, bot, "within-active")
    parked = _operator(db, client, bot, "within-parked", is_active=False)
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    resp = tc.patch(f"/operators/{parked.id}", json={"is_active": True})
    assert resp.status_code == 200, resp.text

    db.expire_all()
    assert db.get(Operator, parked.id).is_active is True
    assert get_entitlements(client.id, db, include_usage=True).usage["operators"] == 2


# ── In-flight and historical conversations ───────────────────────────────────


def test_live_sessions_move_to_waiting_not_bot(db, _stub_manager):
    """A live visitor must land back in the queue so another operator can pick
    them up, not be dropped onto the AI (which is what ``delete_operator``
    does, because there the row is about to vanish)."""
    client, bot = _workspace(db, "live", operator_seats=2)
    op = _operator(db, client, bot, "live")
    db.flush()
    live = ChatSession(id="sess-live-1", bot_id=bot.id, client_id=client.id, status="live", assigned_operator_id=op.id)
    db.add(live)
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": False}).status_code == 200

    db.expire_all()
    refreshed = db.get(ChatSession, "sess-live-1")
    assert refreshed.status == "waiting"
    assert refreshed.assigned_operator_id is None
    _stub_manager.disconnect_operator_and_broadcast.assert_awaited_once_with(op.id)


def test_deactivation_also_takes_the_operator_offline(db, _stub_manager):
    """A deactivated operator must not keep occupying a paid seat.

    ``ws_routes``'s concurrent-operator cap counts ``Operator.is_online`` with
    no ``is_active`` filter, so an operator left marked online after being
    deactivated still fills a seat — and can refuse a legitimate teammate's
    connect with ``seat_limit``. Nothing clears the flag later either:
    ``disconnect_operator_and_broadcast`` only drops the in-process socket
    reference, and a deactivated operator cannot reconnect to set it again.
    """
    client, bot = _workspace(db, "online-flag", operator_seats=2)
    op = _operator(db, client, bot, "online-flag")
    op.is_online = True
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": False}).status_code == 200

    db.expire_all()
    stored = db.get(Operator, op.id)
    assert stored.is_active is False
    assert stored.is_online is False, "a deactivated operator must not still hold a seat"


def test_historical_assignment_survives_deactivation(db):
    """The whole reason this is not a DELETE: a closed conversation must still
    say who handled it."""
    client, bot = _workspace(db, "history", operator_seats=2)
    op = _operator(db, client, bot, "history")
    db.flush()
    closed = ChatSession(
        id="sess-closed-1",
        bot_id=bot.id,
        client_id=client.id,
        status="closed",
        assigned_operator_id=op.id,
    )
    db.add(closed)
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": False}).status_code == 200

    db.expire_all()
    refreshed = db.get(ChatSession, "sess-closed-1")
    assert refreshed.status == "closed"
    assert refreshed.assigned_operator_id == op.id
    assert db.get(Operator, op.id) is not None


# ── Self-guard ───────────────────────────────────────────────────────────────


def test_operator_cannot_deactivate_themselves(db):
    client, bot = _workspace(db, "self", operator_seats=2)
    admin = _operator(db, client, bot, "self-admin", role="admin")
    db.commit()

    tc = TestClient(_build_app(_operator_auth(client.id, admin.id, role="admin")))
    resp = tc.patch(f"/operators/{admin.id}", json={"is_active": False})

    assert resp.status_code == 400
    assert "your own account" in resp.json()["detail"]

    db.expire_all()
    assert db.get(Operator, admin.id).is_active is True


def test_owner_cannot_deactivate_their_own_self_operator_row(db):
    """The owner's self-operator row has its own exit, ``DELETE /me/self-operator``."""
    client, bot = _workspace(db, "selfop", operator_seats=2)
    self_op = _operator(db, client, bot, "selfop", role="owner")
    self_op.linked_client_id = client.id
    db.commit()

    auth = _client_auth(client.id)
    auth["linked_client_id"] = client.id
    tc = TestClient(_build_app(auth))
    resp = tc.patch(f"/operators/{self_op.id}", json={"is_active": False})

    assert resp.status_code == 400
    db.expire_all()
    assert db.get(Operator, self_op.id).is_active is True


# ── Reads need no change ─────────────────────────────────────────────────────


def test_list_operators_still_returns_deactivated_rows(db):
    """``list_operators`` never filtered on ``is_active`` and already returns
    it, so the console can render a 'deactivated' seat with no read change."""
    client, bot = _workspace(db, "listing", operator_seats=2)
    op = _operator(db, client, bot, "listing")
    db.commit()

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": False}).status_code == 200

    listed = tc.get("/operators").json()["operators"]
    assert [row["id"] for row in listed] == [op.id]
    assert listed[0]["is_active"] is False


def test_deactivating_an_operator_from_another_workspace_404s(db):
    client_a, bot_a = _workspace(db, "tenant-a", operator_seats=2)
    client_b, bot_b = _workspace(db, "tenant-b", operator_seats=2)
    victim = _operator(db, client_b, bot_b, "victim")
    db.commit()

    tc = TestClient(_build_app(_client_auth(client_a.id)))
    assert tc.patch(f"/operators/{victim.id}", json={"is_active": False}).status_code == 404

    db.expire_all()
    assert db.get(Operator, victim.id).is_active is True
