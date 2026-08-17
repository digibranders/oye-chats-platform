# Live-Chat Process Split — Implementation Plan

**Status:** proposed
**Author:** engineering
**Date:** 2026-08-17
**Evidence base:** [`load-tests/results/SCALABILITY_SCOPE_2026-08-17.md`](../load-tests/results/SCALABILITY_SCOPE_2026-08-17.md)

---

## 1. The decision

Raise `WEB_CONCURRENCY` from 1 to 4 by moving the WebSocket endpoints into their own
single-worker process, instead of making `ConnectionManager` distributed.

**Measured payoff** (2 vCPU / 4 GB, background worker and crons running, mock provider):

| Metric | 1 worker (today) | 4 workers |
|---|---|---|
| Concurrent AI chats before shedding | ~10 | **~50** |
| Requests shed at 50 concurrent | **36.5%** | **0%** |
| Chat TTFB p95 at 30 concurrent | 8,027 ms | **434 ms** |
| Open widgets at ≤0.5% errors | 1,000 | **2,000** |

**Cost:** an estimated 2–3 engineer-weeks, phased, with each phase independently
shippable and revertible.

**Why this shape.** The obvious plan — distribute `ConnectionManager` across processes
via a Redis backplane — solves a problem we do not have. WebSocket volume is small and
will stay small: the widget opens a socket in exactly one place
(`widget/src/components/LiveChatMode.jsx`), only after a visitor is escalated to a human.
Concurrent sockets are therefore *escalated conversations plus connected operators*, which
is tens to low hundreds, and one process holds 2,000 of them at 2 ms round-trip for about
54 KB each. The problem is not that WebSockets need to scale. **The problem is that
WebSockets are holding the entire HTTP tier hostage at one worker.**

So: keep the sockets in one process, where they are already correct, and let everything
else scale. Defer the distributed backplane until WebSocket load actually demands it.

**Why now, honestly.** Production currently serves ~0.1 requests/second and the box is
almost idle. Nothing is on fire. This is pre-emptive capacity work, and its value is that
the *first* meaningful traffic growth hits a wall at roughly ten concurrent conversations —
a wall we can remove now, cheaply, while there is no pressure. If the roadmap has nothing
that would push chat concurrency past ~10 in the next two quarters, this can wait; that is
a product call, not an engineering one.

---

## 2. The constraint, precisely

`api/gunicorn.conf.py` pins `workers = 1`, and the docstring is explicit that this is
deliberate. The reason is `api/app/services/live_chat_service.py:1608`:

```python
manager = ConnectionManager()
```

a module-level singleton holding ~15 in-process dictionaries. Two of them —
`visitor_connections` and `operator_connections` — hold live `WebSocket` objects. A socket
is a TCP connection owned by exactly one process and **cannot** be shared, moved or
serialised. With two workers, a visitor and their operator can be accepted by different
processes; both sockets stay open and both sides go silent.

Everything else in that class is *coordination* state, which can move.

---

## 3. What makes this cheap: four existing seams

This is not a greenfield refactor. The codebase already contains most of what is needed.

**3.1 nginx already routes `/ws/` separately.**
`api/nginx/oyechats-locations.conf` has a dedicated `location /ws/` block with the upgrade
headers and an 86,400 s timeout already set. Pointing it at a different upstream is a
one-line change. The adjacent comment in `oyechats-api.conf` even anticipates the move.

**3.2 The cross-process notification seam already exists.**
`api/app/services/notification_broadcaster.py` holds the main loop via `bind_loop()` and
fans out with `asyncio.run_coroutine_threadsafe`, and it *already* handles
`self._main_loop is None` by degrading to "persisted; the next REST hydrate covers the gap".
That branch exists because the ARQ worker has no loop. Once the WS sockets live elsewhere,
every HTTP worker is in exactly that situation — so the degradation path is already
designed, and the work is to replace it with a Redis publish rather than invent it.

**3.3 Operator presence is already Redis-backed.**
`operator_presence_service.py` keeps heartbeats in Redis with a 60 s TTL and documents its
own Redis-down degradation. Any "is this operator online?" question already has a
process-independent answer.

**3.4 The waiting queue already treats Postgres as the source of truth.**
`live_chat_queue_service.py` uses Redis only as an index. Queue state does not need
inventing either.

---

## 4. The actual work surface

Every reference to `manager` from outside `ws_routes.py`, classified. This is the real
scope, and it is the part a plan usually gets wrong by hand-waving.

### Category A — fire-and-forget sends (→ publish)
`_send_to_operator`, `_notify_operator_queue`, `broadcast_qualified_bot_changed`,
`notify_connect_request_resolved`

Callers do not need a return value. Each becomes a Redis `PUBLISH`; the WS process
subscribes and writes to whichever local socket it owns. **Low risk.**

### Category B — connect-request lifecycle (→ Redis hash)
`create_connect_request`, `get_connect_request`, `clear_connect_request`
— **12 call sites**, 9 of them in `chat_routes.py`. The busiest surface.

Pure coordination state with a natural TTL. Moves to a Redis hash keyed by session.
**Low risk, mechanical, but touch-heavy — do it as its own change.**

### Category C — state mutations that also notify (→ Redis state + publish)
`accept_chat` (×3), `close_chat` (×3), `transfer_chat`, `request_handoff` (×2),
`update_operator_department`, `mark_operator_offline_now`, `record_bot_session_activity`

These change assignment state *and* tell both parties. State goes to Redis (or stays in
Postgres where the queue already does), the notification becomes a publish. **Medium
risk — this is where transition correctness lives; `ChatAuditLog` must still see exactly
one transition per event.**

### Category D — direct dictionary reads (→ Redis-backed lookups)
`waiting_queue` (×2), `_session_metadata` (×3), `_session_departments` (×3),
`get_present_bot_session_ids`, and — importantly — `operator_connections`, read from
`offline_message_routes.py` **and `worker/tasks.py`**.

That last one matters: the ARQ worker asks "is any operator connected?" to decide whether
to send a push notification. In a split topology the worker cannot see the WS process's
socket table, and a wrong answer here means either a missed notification or a duplicate
one to a visitor. **Route these through `operator_presence_service` (already Redis) rather
than the socket dict.**

### Category E — process-local by nature (leave alone)
`_timeout_tasks`, `_disconnect_tasks`, `_operator_disconnect_tasks`, `_cleanup_task`,
`_operator_message_queue`, `_accept_locks`.

**Correction to an earlier draft of this plan.** A previous version claimed `_accept_locks`
hid a double-accept race that would fire at N>1. **That is wrong, and the code is already
correct here.** Both accept paths — `POST /operators/accept/{session_id}`
(`operator_routes.py:1013`) and the takeover path around line 2390 — already claim the
session with an atomic conditional update:

```sql
UPDATE chat_sessions SET status='live', assigned_operator_id = :op
 WHERE id = :sid AND status = 'waiting' RETURNING id
```

A loser gets `None` back and is rejected with **409**, and the `ChatAuditLog` row is written
in the same transaction. So exactly one operator wins regardless of how many processes race,
and exactly one audit row is produced. The in-process `asyncio.Lock` is redundant
belt-and-braces, and the route comments already say so plainly: *"DB is authoritative."*

**The real N>1 hazard in this category is not double-assignment — it is stale routing.**
`self.assignments` is read to decide *which operator to deliver to*
(`live_chat_service.py:263, 956`, with pops at 313 and 853). If a chat was accepted on
process A, process B's dictionary has no entry, so a message that lands on B has no
destination and is silently dropped. That is a delivery bug, not an integrity bug — and it
is the same problem as Category A/D, solved by the same publish-and-shared-state work.

---

## 5. Phased delivery

Each phase is independently shippable and leaves the system correct. `WEB_CONCURRENCY`
stays at 1 until Phase 5 — nothing before it changes production behaviour.

| Phase | Scope | Est. | Risk |
|---|---|---|---|
| **0** | **Guardrails.** A two-process live-chat integration test: visitor on process A, operator on process B, asserting bidirectional delivery and correct transfer. These must **fail** on today's code — that is the proof they test the right thing. Plus a *characterisation* test asserting the atomic accept guard **holds** across processes (exactly one winner, one audit row, loser gets 409) — that one passes today and exists to keep it that way. | 3–4 d | none (test only) |
| **1** | **One-way publish path.** Redis channels `ws:session:{id}` and `ws:operator:{id}`. WS process runs one subscriber task and fans out to local sockets. Convert Category A. Behind `WS_BACKPLANE_ENABLED`, default off. | 3–4 d | low |
| **2** | **Connect-request state → Redis.** Category B, all 12 sites. | 2–3 d | low |
| **3** | **Presence and queue reads → Redis.** Category D. Point `worker/tasks.py` and `offline_message_routes.py` at `operator_presence_service`. | 3–4 d | medium |
| **4** | **Assignment state + transitions.** Category C: move `assignments` (the routing lookup) to Redis and convert the transition notifications to publishes. The DB claim already handles integrity, so this is about delivery and audit-log consistency, not the accept race. | 4–5 d | **medium** |
| **5** | **Split the process.** New systemd unit for a single-worker uvicorn serving `/ws/*`; nginx `location /ws/` → new upstream; raise `WEB_CONCURRENCY` to 4 **and re-tune the pool in the same change** (see §6.1). | 2–3 d | medium |
| **6** | **Soak and roll out.** 24 h staging soak with real WebSocket traffic, then production behind the flag. | 2–3 d | low |

**Total: 19–26 working days.** Phases 1–4 ship dark; the observable change is Phase 5.

---

## 6. Risks that will actually bite

### 6.1 The chat gate must be re-checked against the pool — every time
`chat_gate` is a per-process `asyncio.Semaphore` sized at 10, and it is deliberately
**below** the 15-connection pool so chat can never exhaust it. Two things break that:

- **N workers multiply it.** 4 workers = 40 in-flight chats against one Postgres, not 10.
- **Re-tuning the pool can invert the relationship.** During cluster testing we set the
  pool to 5 per worker while leaving the gate at 10. Under pure chat load the pool emptied,
  requests queued on the 30 s `pool_timeout`, and gunicorn's 120 s reaper killed workers —
  10 and 12 kills in 15 minutes, a restart loop, and a 34 s p95. Every obvious culprit
  looked innocent: the database sat **100% idle**, both app nodes at 96% idle, the host at
  a quarter of its load. It reads exactly like "scaling out made things worse".

**Action:** treat `gate < per-worker pool ceiling` as an invariant with a startup assertion,
and decide explicitly whether the gate becomes a Redis counter (global) or stays
per-process and is resized to `10/N`. **Recommendation: keep it per-process, size it
deliberately, assert the invariant at boot.** A distributed limiter is more machinery than
this needs.

### 6.2 The ARQ worker must stay a singleton
Its crons are not idempotent across processes: the webhook retry ladder would double-fire
and invoice rendering would race. App replicas ≥ 2, **worker replicas = 1**, permanently.
Worth an explicit comment in the unit file so nobody "scales" it later.

### 6.3 Uploads write local disk
`document_routes.py` writes to local storage. Multi-*worker* on one box is unaffected
(same filesystem). This becomes a real blocker only at multi-*host*, which this plan does
not attempt. Note it so it is not discovered during a later scale-out.

### 6.4 Redis pub/sub is at-most-once
A subscriber disconnected for a second loses those messages. **Acceptable**, because
`ChatMessage` rows are the source of truth and the widget re-hydrates on reconnect. Do
**not** reach for Redis Streams here — that buys consumer-group and trimming complexity
for durability Postgres already provides.

### 6.5 The load harness cannot catch any of this
Every existing scenario drives SSE, not WebSockets; `chat-concurrency.js` opens no sockets
at all. The multi-worker numbers quoted in §1 prove multi-worker is **fast**, not that live
chat is **correct**. Phase 0 exists precisely because our measurement tooling is blind here.

---

## 7. Verification

**Must pass before Phase 5 ships:**

1. **Cross-process delivery** — visitor on A, operator on B: message, typing indicator and
   read receipt land both ways.
2. **The accept guard still holds across processes** — two operators on two processes race
   the same waiting chat; exactly one wins, the loser gets 409, and `ChatAuditLog` contains
   exactly one transition. This passes today (the claim is an atomic conditional `UPDATE`);
   the test exists so a refactor cannot quietly remove it.
3. **Transfer across processes** — operator on A transfers to operator on B; the visitor
   socket, held on A, follows correctly.
4. **Presence truthfulness** — the ARQ worker's "is an operator connected?" answer matches
   reality when the socket lives in another process.
5. **Reconnect hydration** — kill the WS process mid-conversation; the widget reconnects
   and no message is lost from the transcript.
6. **Capacity regression** — re-run the chat-concurrency sweep and confirm ~50 concurrent at
   0% shed, and that `pg_total` stays inside the ceiling with the new pool sizing.

---

## 8. Rollout and rollback

- Ship Phases 1–4 dark behind `WS_BACKPLANE_ENABLED=false`. Each is a normal release.
- Phase 5 in a maintenance window: the WS process restart drops every open socket. Today a
  `systemctl restart` already does this mid-generation, so it is not a new failure mode —
  but the widget's reconnect path should be verified first.
- **Rollback is a config revert:** point `location /ws/` back at the single upstream and set
  `WEB_CONCURRENCY=1`. No migration, no data change, no code revert.
- Watch after rollout: `WORKER TIMEOUT` count (should be zero), `pg_total` against
  `max_connections`, `chat_gate.rejected_total`, and WS reconnect rate.

---

## 9. Explicitly not in scope

- **A distributed backplane across hosts.** One WS process is the design, not a stepping
  stone we are half-building. Revisit when concurrent sockets approach four figures.
- **Splitting Postgres onto its own host.** Measured separately; it buys ~2× and real
  durability, but it is independent of this work and should not be bundled.
- **Shared upload storage.** Needed for multi-host, not for multi-worker.
- **Replacing the chat gate with a distributed limiter.** See §6.1 — deliberately rejected
  as over-engineering for this step.

---

## 10. Decisions needed before Phase 1

1. **Is there roadmap pressure past ~10 concurrent chats in the next two quarters?** If not,
   this is worth scheduling but not prioritising. Pure product call.
2. **Gate sizing: per-process at `10/N`, or a Redis counter?** Recommendation: per-process,
   with a boot-time assertion that it sits below the pool ceiling.
3. **Do we keep `_accept_locks` at all?** The atomic Postgres claim already guarantees a
   single winner, so the in-process lock adds nothing across processes and only narrows a
   same-process window. Recommendation: keep it (it is harmless and cheap), but delete the
   comment implying it provides the guarantee — the `UPDATE ... WHERE status='waiting'` does.
4. **Do we take Phase 0 even if we defer the rest?** Recommendation: yes. Cross-process
   message delivery is genuinely broken today and nothing in the test suite would notice —
   every load scenario drives SSE and opens no sockets at all. Three days buys a gate that
   stops someone raising `WEB_CONCURRENCY` casually and shipping a silent live-chat outage.
