"""Cross-tenant isolation for the live-chat ConnectionManager (audit F03).

The manager keeps process-global state shared by every tenant. Before this fix,
``_should_notify_operator`` filtered only by department (``None`` by default), so
a handoff on tenant B notified tenant A's operators, and the queue/roster
broadcasts exposed tenant B's visitor PII + operator roster to tenant A.

Every session-scoped notification must be partitioned by ``client_id``:
an operator may only ever be notified about, or see in their queue/roster,
sessions and operators belonging to their own workspace.
"""

import asyncio

from app.services.live_chat_service import ConnectionManager


def test_should_notify_operator_is_scoped_to_session_client():
    m = ConnectionManager()
    m._operator_client_ids = {10: 1, 20: 2}  # op 10 → client 1, op 20 → client 2

    # A client-2 session must notify only client-2 operators.
    assert m._should_notify_operator(20, None, session_client_id=2) is True
    assert m._should_notify_operator(10, None, session_client_id=2) is False
    # Operator whose client is unknown → fail closed (never notify).
    assert m._should_notify_operator(999, None, session_client_id=2) is False


def test_notify_operator_queue_hides_other_tenant_sessions():
    m = ConnectionManager()
    m._operator_client_ids = {10: 1, 20: 2}

    sid = "sess-client2"
    m.waiting_queue.append(sid)
    m._session_client_ids[sid] = 2
    m._session_departments[sid] = None
    m._session_metadata[sid] = {"name": "Bob", "reason": "help", "bot_id": 5, "bot_name": "B2"}

    captured: dict[int, dict] = {}

    async def fake_send(operator_id, data):
        captured[operator_id] = data

    m._send_to_operator = fake_send

    asyncio.run(m._notify_operator_queue(10))  # client-1 operator
    asyncio.run(m._notify_operator_queue(20))  # client-2 operator

    # Client-1 operator must not see client-2's queued visitor (no PII leak).
    assert captured[10]["waiting"] == []
    assert captured[10]["count"] == 0
    # Client-2 operator sees their own queued session.
    assert [w["session_id"] for w in captured[20]["waiting"]] == [sid]


def test_broadcast_operators_update_is_scoped_to_client():
    m = ConnectionManager()
    m._operator_client_ids = {10: 1, 20: 2}
    m._operator_names = {10: "Alice", 20: "Bob"}
    m.operator_connections = {10: object(), 20: object()}  # both "connected"

    sent: dict[int, dict] = {}

    async def fake_send(operator_id, data):
        sent[operator_id] = data

    m._send_to_operator = fake_send

    asyncio.run(m.broadcast_operators_update())

    # Each operator sees only their own workspace's roster.
    assert {o["operator_id"] for o in sent[10]["operators"]} == {10}
    assert {o["operator_id"] for o in sent[20]["operators"]} == {20}
