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
        handle_operator_deactivated=AsyncMock(return_value=0),
    )
    monkeypatch.setattr(operator_routes, "manager", stub)
    return stub


class _RecordingSocket:
    """Minimal stand-in for a Starlette ``WebSocket``.

    Records the frames written to it and the close code, which is all the
    manager ever does to a socket on this path.
    """

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.close_code: int | None = None

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.close_code = code


@pytest.fixture()
def real_manager(monkeypatch):
    """Give the route a REAL ``ConnectionManager`` instead of the async stub.

    The stub above can only prove that *some* coroutine was awaited, which is
    exactly how the queue bug survived review: the route re-queued the sessions
    in SQL, the manager's own queue never heard about it, and an
    ``assert_awaited_once_with`` was green either way. A fresh instance (not the
    module singleton) keeps the in-memory state per-test.
    """
    from app.api import operator_routes
    from app.services.live_chat_service import ConnectionManager

    mgr = ConnectionManager()
    monkeypatch.setattr(operator_routes, "manager", mgr)
    return mgr


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


def test_no_op_update_does_not_touch_seats_or_sockets(db, monkeypatch, _stub_manager):
    """Re-sending the value the row already holds is not a transition.

    Asserting only "no socket was dropped" cannot fail: without the
    ``request.is_active != operator.is_active`` guard a no-op ``True`` takes the
    *reactivation* branch, which never disconnects anything. What the guard
    actually saves is the seat check and the entitlements-cache bust, so those
    are what this asserts — same shape as
    ``test_pausing_invalidates_the_entitlements_cache``.
    """
    from app.services import invite_service, plan_entitlements_service

    client, bot = _workspace(db, "noop", operator_seats=2)
    op = _operator(db, client, bot, "noop")
    db.commit()

    seat_checks: list[tuple[int, int]] = []
    invalidated: list[int] = []
    monkeypatch.setattr(
        invite_service,
        "_require_seat_available",
        lambda session, client_id, bot_id=None: seat_checks.append((client_id, bot_id)),
    )
    monkeypatch.setattr(plan_entitlements_service, "invalidate", invalidated.append)

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": True}).status_code == 200

    assert seat_checks == [], "a no-op must not burn a SELECT ... FOR UPDATE seat check"
    assert invalidated == [], "a no-op must not churn the entitlements cache"
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


def test_live_sessions_move_to_waiting_not_bot(db, real_manager):
    """A live visitor must land back in the queue so another operator can pick
    them up, not be dropped onto the AI (which is what ``delete_operator``
    does, because there the row is about to vanish).

    Runs against the real manager: the re-queue is the manager's job now, so a
    stub would assert nothing about where the visitor ended up.
    """
    client, bot = _workspace(db, "live", operator_seats=2)
    op = _operator(db, client, bot, "live")
    db.flush()
    live = ChatSession(id="sess-live-1", bot_id=bot.id, client_id=client.id, status="live", assigned_operator_id=op.id)
    db.add(live)
    db.commit()

    real_manager.assignments["sess-live-1"] = op.id
    real_manager._operator_client_ids[op.id] = client.id  # noqa: SLF001

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": False}).status_code == 200

    db.expire_all()
    refreshed = db.get(ChatSession, "sess-live-1")
    assert refreshed.status == "waiting"
    assert refreshed.assigned_operator_id is None


def test_deactivation_hands_the_visitor_to_the_real_queue(db, real_manager):
    """The visitor must be re-queued in the *live* manager, not only in SQL.

    The bug: the route flipped the rows to ``waiting`` and committed, then asked
    the manager to clean up. The manager looks its sessions up by
    ``status == 'live'``, found none, and so never appended the session to
    ``waiting_queue`` nor dropped ``assignments``. Result: a session marked
    ``waiting`` in the database that no operator is ever offered, still pointing
    at the deactivated operator in memory, and a visitor who is never told
    anything — until the process restarts.
    """
    client, bot = _workspace(db, "requeue", operator_seats=2)
    op = _operator(db, client, bot, "requeue")
    other = _operator(db, client, bot, "requeue-other")
    db.flush()
    live = ChatSession(
        id="sess-requeue-1",
        bot_id=bot.id,
        client_id=client.id,
        status="live",
        assigned_operator_id=op.id,
    )
    db.add(live)
    db.commit()

    visitor_ws = _RecordingSocket()
    operator_ws = _RecordingSocket()
    other_ws = _RecordingSocket()
    real_manager.visitor_connections["sess-requeue-1"] = visitor_ws
    real_manager.operator_connections[op.id] = operator_ws
    real_manager.operator_connections[other.id] = other_ws
    real_manager.assignments["sess-requeue-1"] = op.id
    real_manager._operator_client_ids[op.id] = client.id  # noqa: SLF001

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": False}).status_code == 200

    db.expire_all()
    refreshed = db.get(ChatSession, "sess-requeue-1")
    assert refreshed.status == "waiting"
    assert refreshed.assigned_operator_id is None

    assert "sess-requeue-1" in real_manager.waiting_queue, "the session must be offerable again"
    assert "sess-requeue-1" not in real_manager.assignments, "must not still point at the removed operator"

    statuses = [f for f in visitor_ws.sent if f.get("type") == "status"]
    assert statuses, "the visitor must be told they are back in the queue"
    assert statuses[-1]["status"] == "waiting"

    assert any(f.get("type") == "queue_update" for f in other_ws.sent), (
        "the remaining operator must be offered the freed conversation"
    )


def test_deactivation_closes_the_operator_socket(db, real_manager):
    """An open socket outlives the seat.

    Nothing in the operator WS handlers re-reads ``is_active``, so a deactivated
    operator whose connection is merely forgotten server-side can still accept
    queued chats and send messages. The socket has to be closed, on a terminal
    code so the console does not reconnect-loop against a key that no longer
    authenticates.
    """
    from app.services.live_chat_service import ConnectionManager

    client, bot = _workspace(db, "socket", operator_seats=2)
    op = _operator(db, client, bot, "socket")
    db.commit()

    operator_ws = _RecordingSocket()
    real_manager.operator_connections[op.id] = operator_ws
    real_manager._operator_client_ids[op.id] = client.id  # noqa: SLF001

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": False}).status_code == 200

    assert operator_ws.close_code == ConnectionManager.DEACTIVATED_CLOSE_CODE
    assert op.id not in real_manager.operator_connections


def test_deactivation_does_not_wait_out_the_disconnect_grace_period(db, real_manager):
    """No 60s countdown: an inactive operator cannot reconnect, so there is
    nothing to wait for and every second of waiting is a stranded visitor.

    Guards against a regression to ``disconnect_operator_and_broadcast``, which
    only schedules ``_operator_disconnect_timeout``.
    """
    client, bot = _workspace(db, "grace", operator_seats=2)
    op = _operator(db, client, bot, "grace")
    db.commit()

    real_manager.operator_connections[op.id] = _RecordingSocket()
    real_manager._operator_client_ids[op.id] = client.id  # noqa: SLF001

    tc = TestClient(_build_app(_client_auth(client.id)))
    assert tc.patch(f"/operators/{op.id}", json={"is_active": False}).status_code == 200

    assert real_manager._operator_disconnect_tasks == {}, (  # noqa: SLF001
        "deactivation must act now, not schedule a grace-period task"
    )
    assert op.id not in real_manager._operator_client_ids  # noqa: SLF001


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
