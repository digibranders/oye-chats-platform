"""Phase 0 guardrails for the live-chat process split.

WHY THESE EXIST
---------------
``gunicorn.conf.py`` pins ``workers = 1`` because ``ConnectionManager``
(``app/services/live_chat_service.py``) keeps visitor and operator sockets in
in-process dictionaries. Nothing in the suite notices what breaks when that pin is
lifted, and the load harness cannot help: every scenario in
``load-tests/scenarios/`` drives SSE and opens no WebSocket at all.

So these run against TWO SEPARATE API PROCESSES sharing one Postgres and one
Redis, and assert the behaviour the split has to preserve.

    test_operator_message_reaches_visitor_on_other_process   EXPECTED FAIL today
    test_offline_message_reaches_operator_on_other_process    EXPECTED FAIL today
    test_accept_claim_is_atomic_across_processes              PASSES today

The third is a characterisation test, not a bug hunt. Both accept paths already
claim the session with ``UPDATE ... WHERE status='waiting' RETURNING id`` and
reject the loser with 409, so integrity is correct across any number of
processes. It exists so that moving assignment state to Redis cannot quietly
replace that atomic claim with a check-then-set.

RUNNING THEM
------------
    export LC_NODE_A=http://192.168.252.2:8001
    export LC_NODE_B=http://192.168.252.4:8001
    export LC_BOT_KEY=bot-loadtest-000000
    export LC_OPERATOR_KEY=lt_operator_key_deterministic_0001
    export DB_URL=postgresql://ubuntu@192.168.252.3:5432/oyechats_loadtest
    uv run pytest tests/test_live_chat_cross_process.py -v

Without LC_NODE_A/LC_NODE_B the module skips, so CI stays green.

A NOTE ON SETUP, LEARNED THE HARD WAY
-------------------------------------
``status='waiting'`` is not a state a test can reliably drive through the API.
``POST /operators/handoff`` branches on live presence: with no operator online it
returns ``suggested_action: offline_form`` and leaves the session in ``bot``; with
one online it auto-routes straight to ``live``. ``waiting`` only occurs in the
narrow window where an operator is online but not routable. So the accept test
establishes its precondition directly in the database, the precondition is not
what is under test, the atomicity of the claim is.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid

import httpx
import pytest

pytestmark = pytest.mark.skipif(
    not (os.getenv("LC_NODE_A") and os.getenv("LC_NODE_B")),
    reason="needs two API processes on a shared data tier (set LC_NODE_A and LC_NODE_B)",
)

NODE_A = os.getenv("LC_NODE_A", "")
NODE_B = os.getenv("LC_NODE_B", "")
BOT_KEY = os.getenv("LC_BOT_KEY", "bot-loadtest-000000")
OPERATOR_KEY = os.getenv("LC_OPERATOR_KEY", "lt_operator_key_deterministic_0001")
# The WS handler runs the same origin whitelist as HTTP and rejects a missing
# hostname (4403); localhost is auto-allowed outside production.
ORIGIN = os.getenv("LC_WS_ORIGIN", "http://localhost")
RECV_TIMEOUT = float(os.getenv("LC_RECV_TIMEOUT", "8"))


def _client_ip() -> str:
    """A fresh client IP per call.

    Operator endpoints are rate-limited per IP. Without this, running the module
    a few times in a row starts returning 429 and the assertions fail for a
    reason unrelated to what they test. The load scenarios rotate the header for
    exactly the same reason; this is load shaping, not a limit bypass.
    """
    n = uuid.uuid4().int
    return f"10.{(n >> 16) % 240}.{(n >> 8) % 256}.{n % 254 + 1}"


def _operator_headers() -> dict[str, str]:
    return {"X-Operator-Key": OPERATOR_KEY, "X-Forwarded-For": _client_ip()}


def _ws_url(base: str, path: str) -> str:
    return base.replace("http://", "ws://").replace("https://", "wss://") + path


async def _recv_until(sock, predicate, timeout: float = RECV_TIMEOUT):
    """Read frames until ``predicate(payload)`` holds, or time out.

    These sockets carry housekeeping traffic (status, pong, roster updates), so a
    test must never assume the frame it wants is the next one.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    seen: list[dict] = []
    while loop.time() < deadline:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            raw = await asyncio.wait_for(sock.recv(), timeout=remaining)
        except Exception:  # noqa: BLE001  a timeout or a closed socket both just end the read loop
            break
        try:
            payload = json.loads(raw)
        except (ValueError, TypeError):
            continue
        seen.append(payload)
        if predicate(payload):
            return payload, seen
    return None, seen


async def _new_session(base: str) -> str:
    """Create a real chat session by taking one bot turn, and return its id."""
    sid = f"xproc_{uuid.uuid4().hex[:12]}"
    async with httpx.AsyncClient(timeout=60) as http:
        r = await http.post(
            f"{base}/chat/stream",
            headers={"X-Bot-Key": BOT_KEY, "X-Forwarded-For": f"10.13.{uuid.uuid4().int % 254}.7"},
            json={"question": "hello", "session_id": sid},
        )
    assert r.status_code == 200, f"could not create a session: {r.status_code} {r.text[:200]}"
    return sid


async def _request_human(base: str, sid: str) -> dict:
    """Ask for a human. Returns the routing decision so a test can assert on it."""
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post(
            f"{base}/operators/handoff",
            headers={"X-Bot-Key": BOT_KEY, "X-Forwarded-For": _client_ip()},
            json={"session_id": sid},
        )
    assert r.status_code == 200, f"handoff failed: {r.status_code} {r.text[:200]}"
    return r.json()


def _db_engine():
    db_url = os.getenv("DB_URL")
    if not db_url:
        pytest.skip("set DB_URL to run this test")
    from sqlalchemy import create_engine

    return create_engine(db_url)


def _session_state(sid: str) -> tuple[str | None, int | None]:
    from sqlalchemy import text

    engine = _db_engine()
    try:
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT status, assigned_operator_id FROM chat_sessions WHERE id = :sid"),
                {"sid": sid},
            ).first()
    finally:
        engine.dispose()
    return (row[0], row[1]) if row else (None, None)


async def _ensure_live(base: str, sid: str) -> None:
    """Guarantee the session is ``live`` with an operator assigned.

    This precondition is load-bearing and easy to get wrong. The operator's
    ``message`` handler drops the frame silently unless
    ``chat_session.status == 'live'`` (``ws_routes.py`` ~line 145), so a test that
    skips this asserts nothing about delivery, it just observes a dropped frame
    for the wrong reason.

    Depending on live presence, ``/operators/handoff`` either auto-routes straight
    to ``live`` or leaves the session short of it, so accept explicitly when needed.
    """
    status, assignee = _session_state(sid)
    if status != "live":
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.post(
                f"{base}/operators/accept/{sid}",
                headers=_operator_headers(),
            )
        if r.status_code not in (200, 409):
            pytest.skip(f"could not bring the session to 'live' (accept -> {r.status_code}): {r.text[:160]}")
        status, assignee = _session_state(sid)

    if status != "live" or assignee is None:
        pytest.skip(
            f"session {sid} is status={status!r} assignee={assignee!r}, not a live assigned chat. "
            "the delivery assertion would be meaningless"
        )


@pytest.fixture(autouse=True)
def _release_operator_capacity():
    """Close chats these tests leave behind, before and after each test.

    An operator has a ``max_concurrent_chats`` ceiling (5 by default). Every test
    here accepts a chat and never closes it, so after a handful of runs the
    seeded operator sits at capacity and the API answers *every* accept with
    ``429 Operator already at max capacity``, which looks exactly like a rate
    limit and has nothing to do with what is being asserted. Left unfixed it
    would poison this module permanently on any shared environment.

    Only sessions this module creates (``xproc_%``) are touched.
    """
    from sqlalchemy import text

    def _close_leaked():
        db_url = os.getenv("DB_URL")
        if not db_url:
            return
        from sqlalchemy import create_engine

        engine = create_engine(db_url)
        try:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "UPDATE chat_sessions SET status='closed', assigned_operator_id=NULL "
                        "WHERE id LIKE 'xproc\\_%' ESCAPE '\\' AND status IN ('live','waiting')"
                    )
                )
        finally:
            engine.dispose()

    _close_leaked()
    yield
    _close_leaked()


@pytest.mark.asyncio
async def test_operator_message_reaches_visitor_on_other_process():
    """An operator on node B must reach a visitor whose socket lives on node A.

    EXPECTED TO FAIL until the WS endpoints run in a single process (or a
    backplane lands).

    Both halves of the routing state are process-local. ``visitor_connections``
    on node A holds the only socket to this visitor, and ``assignments``. Read at
    ``live_chat_service.py:263`` and ``:956`` to choose a delivery target. Is
    populated on whichever process handled the accept. Node B therefore has
    neither the socket nor the assignment, and drops the message with no error.
    """
    import websockets

    sid = await _new_session(NODE_A)

    # Visitor socket on node A; operator socket on node B, so the handoff has a
    # human to route to and the two halves of the conversation are in different
    # processes, the whole point of the test.
    async with (
        websockets.connect(
            _ws_url(NODE_A, f"/ws/chat/{sid}"),
            additional_headers={"X-Bot-Key": BOT_KEY, "Origin": ORIGIN},
        ) as visitor,
        websockets.connect(
            _ws_url(NODE_B, "/ws/operator"),
            subprotocols=[f"operator-key.{OPERATOR_KEY}"],
            additional_headers={"Origin": ORIGIN},
        ) as operator,
    ):
        await _recv_until(operator, lambda p: bool(p.get("type")), 4)

        decision = await _request_human(NODE_A, sid)
        if decision.get("state") == "all_offline":
            pytest.skip("handoff saw no online operator. Presence had not propagated; re-run, or raise LC_RECV_TIMEOUT")
        # The operator's message handler drops frames unless the chat is live and
        # assigned, so establish that before asserting on delivery.
        await _ensure_live(NODE_B, sid)

        marker = f"from-node-b-{uuid.uuid4().hex[:8]}"
        await operator.send(json.dumps({"type": "message", "session_id": sid, "content": marker}))

        got, seen = await _recv_until(visitor, lambda p: marker in json.dumps(p))

    assert got is not None, (
        f"Visitor on node A never received the operator's message from node B (marker {marker}).\n"
        "This is the cross-process delivery gap the split must close: the visitor "
        "socket is held in node A's ConnectionManager and the assignment lives in "
        "whichever process accepted, so node B has nowhere to deliver and drops the "
        "message silently.\n"
        f"Frames the visitor did see: {json.dumps(seen)[:600]}"
    )


@pytest.mark.asyncio
async def test_offline_message_reaches_operator_on_other_process():
    """An offline-message notification must reach an operator on another process.

    EXPECTED TO FAIL today, and this one loses the notification outright rather
    than merely delaying it.

    ``offline_message_routes.py:188`` fans out by iterating the LOCAL socket table::

        for operator_id in list(manager.operator_connections.keys()):
            await manager._send_to_operator(operator_id, notification)

    so a submission handled by a process holding no operator sockets notifies
    nobody. The Web Push fallback right below it does not cover the gap, because it
    deliberately skips operators "currently on WS" using *Redis* presence, which
    correctly reports this operator as online. Neither channel fires.

    The fix pattern already exists in this repo: ``worker/tasks.py`` hit exactly
    this bug, moved to ``get_online_operator_ids()``, and left a comment explaining
    that a fresh ``manager`` in another process has an always-empty
    ``operator_connections``. This call site was never updated.
    """
    import websockets

    async with websockets.connect(
        _ws_url(NODE_A, "/ws/operator"),
        subprotocols=[f"operator-key.{OPERATOR_KEY}"],
        additional_headers={"Origin": ORIGIN},
    ) as operator:
        await _recv_until(operator, lambda p: bool(p.get("type")), 4)

        marker = f"xproc-{uuid.uuid4().hex[:8]}"
        async with httpx.AsyncClient(timeout=30) as http:
            submitted = await http.post(
                f"{NODE_B}/offline-messages",
                json={
                    "bot_key": BOT_KEY,
                    "name": "Phase0 CrossProcess",
                    "email": "phase0@example.invalid",
                    "message": f"cross-process notification probe {marker}",
                },
            )
        assert submitted.status_code == 200, f"submit failed: {submitted.status_code} {submitted.text[:200]}"

        got, seen = await _recv_until(
            operator,
            lambda p: p.get("type") == "offline_message_received" or marker in json.dumps(p),
        )

    assert got is not None, (
        "Operator connected to node A never received the offline-message notification "
        "submitted to node B.\n"
        "offline_message_routes fans out over its own process's "
        "manager.operator_connections, which is empty on the handling process, and the "
        "Web Push fallback skips this operator because Redis presence correctly says "
        "they are online. The notification is lost on both channels.\n"
        "Fix pattern already in-repo: use get_online_operator_ids(), as worker/tasks.py does.\n"
        f"Frames the operator did see: {json.dumps(seen)[:600]}"
    )


@pytest.mark.asyncio
async def test_connect_request_is_visible_from_another_process():
    """A visitor's poll must see a connect-request raised on another process.

    An operator asks to join a chat; the widget then polls REST until the visitor
    accepts or declines. The operator's POST and the visitor's GET are separate
    HTTP requests that can land on different processes, so while the record lived
    in a per-process dict the poll asked a process that had never heard of it,
    got ``{"pending": false}``, and the popup simply never appeared. Nothing
    errored, the request evaporated.

    Fails before the record moved to shared storage; passes after.
    """
    sid = await _new_session(NODE_A)

    async with httpx.AsyncClient(timeout=30) as http:
        created = await http.post(
            f"{NODE_A}/operators/connect-request/{sid}",
            headers=_operator_headers(),
        )
        if created.status_code not in (200, 201):
            pytest.skip(f"could not raise a connect-request (-> {created.status_code}): {created.text[:160]}")

        # The visitor polls the OTHER process.
        polled = await http.get(
            f"{NODE_B}/chat/connect-request/{sid}",
            headers={"X-Bot-Key": BOT_KEY, "X-Forwarded-For": _client_ip()},
        )

    assert polled.status_code == 200, f"poll failed: {polled.status_code} {polled.text[:200]}"
    body = polled.json()
    assert body.get("pending") is True, (
        "The visitor's poll on node B did not see the connect-request raised on node A.\n"
        "While this record lived in a per-process dict the popup never appeared for any "
        "deployment with more than one process, and nothing logged an error.\n"
        f"Node B returned: {json.dumps(body)[:300]}"
    )


@pytest.mark.asyncio
async def test_accept_claim_is_atomic_across_processes():
    """Exactly one claim may win, even when two processes race.

    PASSES TODAY, deliberately. Both accept paths run::

        UPDATE chat_sessions SET status='live', assigned_operator_id=:op
         WHERE id=:sid AND status='waiting' RETURNING id

    reject the loser with 409, and write the ChatAuditLog row in the same
    transaction. The in-process ``asyncio.Lock`` contributes nothing across
    processes and is not what provides this guarantee.

    Characterisation test: it exists so that moving assignment state to Redis
    cannot quietly replace the atomic claim with a check-then-set and reintroduce
    double-assignment.
    """
    from sqlalchemy import text

    sid = await _new_session(NODE_A)

    # Force the precondition directly: 'waiting' is not reliably reachable through
    # the API (see the module docstring), and it is not what is under test.
    engine = _db_engine()
    try:
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE chat_sessions SET status='waiting', assigned_operator_id=NULL WHERE id = :sid"),
                {"sid": sid},
            )

        async with httpx.AsyncClient(timeout=30) as http:
            a, b = await asyncio.gather(
                http.post(f"{NODE_A}/operators/accept/{sid}", headers=_operator_headers()),
                http.post(f"{NODE_B}/operators/accept/{sid}", headers=_operator_headers()),
                return_exceptions=True,
            )

        statuses = sorted(r.status_code for r in (a, b) if isinstance(r, httpx.Response))
        assert statuses, f"both accept calls errored: {a!r} {b!r}"
        assert 200 in statuses, f"nobody won the accept race: {statuses}"

        with engine.connect() as conn:
            assignees = [
                x
                for x in conn.execute(
                    text("SELECT DISTINCT assigned_operator_id FROM chat_sessions WHERE id = :sid"),
                    {"sid": sid},
                )
                .scalars()
                .all()
                if x is not None
            ]
            accepted_rows = conn.execute(
                text("SELECT count(*) FROM chat_audit_logs WHERE session_id = :sid AND action = 'accepted'"),
                {"sid": sid},
            ).scalar_one()
    finally:
        engine.dispose()

    assert len(assignees) <= 1, f"session ended with more than one assignee: {assignees}"
    assert accepted_rows == 1, (
        f"expected exactly one 'accepted' audit row for a single successful claim, found "
        f"{accepted_rows} (statuses were {statuses}). More than one means the atomic "
        "UPDATE ... WHERE status='waiting' guard was bypassed, the invariant this test exists to hold."
    )
