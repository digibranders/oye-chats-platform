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


def test_queue_row_visibility_is_scoped_to_client():
    """The queue's tenant/department rules, asserted without a database.

    The operator queue is now derived from ``ChatSession.status == 'waiting'``
    rather than an in-process list (see ``_visible_queue_for_operator``), so the
    old version of this test — which seeded ``waiting_queue`` and the sidecar
    dicts — was exercising storage that no longer backs the feature. The rules
    it guards are unchanged and are what matter, so they are asserted directly
    on the pure predicate instead of through a query.
    """
    visible = ConnectionManager._queue_row_is_visible

    # A client-2 session must never be visible to a client-1 operator (F03).
    assert visible(session_client_id=2, session_dept=None, operator_client_id=1, operator_dept=None) is False
    # ...and must be visible to its own tenant.
    assert visible(session_client_id=2, session_dept=None, operator_client_id=2, operator_dept=None) is True
    # An operator whose workspace is unknown sees nothing — fail closed.
    assert visible(session_client_id=2, session_dept=None, operator_client_id=None, operator_dept=None) is False
    # A session with no client_id stays visible, as it did in the in-memory
    # implementation, which only skipped on a positive mismatch.
    assert visible(session_client_id=None, session_dept=None, operator_client_id=1, operator_dept=None) is True
    # Department filtering is unchanged: either side unset means no filter.
    assert visible(session_client_id=1, session_dept=7, operator_client_id=1, operator_dept=7) is True
    assert visible(session_client_id=1, session_dept=7, operator_client_id=1, operator_dept=9) is False
    assert visible(session_client_id=1, session_dept=7, operator_client_id=1, operator_dept=None) is True


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
