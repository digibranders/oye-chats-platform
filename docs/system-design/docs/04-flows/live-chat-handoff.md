# Live chat handoff

> **Audience:** New engineers · **Read time:** 6 min · **Last updated:** 2026-08-31

## TL;DR

Visitor requests a human → session moves `bot → waiting` → operator accepts → `live` → bidirectional WebSocket messaging → the operator finishes, and which state that lands in depends on **which** action they took: `/close` returns the conversation to the bot (`status='bot'`), `/resolve` marks it done (`status='closed'`). Outside business hours or with no operators online, the path forks to an offline form.

**Topology matters here.** nginx routes `/ws/` to `oyechats-ws.service`, a dedicated single-worker process on `127.0.0.1:8001`, while `oyechats-api.service` runs `WEB_CONCURRENCY=2`. So `ConnectionManager`'s in-process socket maps are **permanently empty on the API process that raises a handoff**; every fan-out has to union local sockets with Redis presence and deliver over the Redis backplane. The backplane is gated by `WS_BACKPLANE_ENABLED`, which the WS unit pins `true` but which the deploy writes as `${WS_BACKPLANE_ENABLED:-false}` into the API process's `.env` — so it is a per-environment fact, not a given.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor V as Visitor
    box rgb(224,242,254) Visitor side
      participant W as Widget
    end
    box rgb(254,243,199) API + WS (SEPARATE PROCESSES)
      participant API as FastAPI :8000
      participant WS as ws_routes :8001
      participant LCM as live_chat_service
      participant BP as Redis backplane
    end
    box rgb(220,252,231) Data
      participant DB as Postgres
    end
    box rgb(252,231,243) Operator + async
      actor Op as Operator
      participant Worker as ARQ
      participant Brevo
    end

    V->>W: clicks "Talk to a human"
    W->>API: POST /operators/handoff (X-Bot-Key, session_id, reason, lead form)
    API->>DB: UPDATE chat_sessions SET status='waiting', handoff_reason=...
    API->>DB: UPSERT lead_info
    API->>DB: INSERT chat_audit_logs (action='handoff_requested')
    API->>Worker: enqueue task_send_email("handoff") if email_on_handoff
    Worker-->>Brevo: notify operator group

    API->>BP: fan out queue_update (local sockets ∪ Redis presence)
    BP-->>WS: deliver to whichever process holds the operator socket

    Note over W,WS: Visitor opens WS
    W->>WS: GET /ws/chat/{session_id}?bot_key=...
    WS->>LCM: register visitor connection

    Note over Op,WS: Operator listening
    Op->>WS: GET /ws/operator?api_key=... (legacy alias /ws/agent)
    WS->>LCM: register operator connection + Redis presence
    LCM-->>Op: { type: "queue_update" } snapshot

    alt Operator accepts (REST, not a WS frame)
        Op->>API: POST /operators/accept/{session_id} (X-Operator-Key)
        API->>DB: transition waiting → live; assigned_operator_id
        API->>DB: INSERT chat_audit_logs (action='accepted')
        API->>BP: operator_joined → visitor; queue_update → other operators
        loop messaging
            V->>WS: { type: "message", content }
            WS->>DB: INSERT chat_messages (role=user)
            WS->>BP: relay to the operator's process
            Op->>WS: { type: "message", content }
            WS->>DB: INSERT chat_messages (role=operator)
            WS->>BP: relay to the visitor's process
        end
        alt back to the bot
            Op->>API: POST /operators/close/{session_id}
            API->>DB: transition live → bot (audit action='closed')
        else done / resolved
            Op->>API: POST /operators/resolve/{session_id}
            API->>DB: transition live → closed (audit action='resolved')
        end
        API->>BP: chat_ended → visitor; fire_webhook('chat_closed')
    else No operators / offline
        WS-->>V: offline state
        V->>WS: { type: "submit_offline_form" }
        WS->>DB: INSERT offline_messages (status='new')
        WS->>Worker: enqueue offline-message push / email
        Worker-->>Brevo: notify owner email
    else Visitor leaves the queue or ends the chat
        V->>WS: { type: "leave_queue" } or { type: "visitor_end_chat" }
        WS->>DB: transition waiting|live → bot (CAS on expected_current)
    else Queue timeout
        Note over LCM: live_chat_queue_timeout_seconds
        LCM->>DB: CAS waiting → bot (audit action='timeout')
        Note over LCM: a LOST CAS means somebody else already moved the session;<br/>the timeout must NOT tell the visitor "unavailable"
    end
```

## State machine

See the dedicated page: [Chat session FSM](/05-state-machines/chat-session).

## WebSocket endpoints

| Path | Who | Auth |
|---|---|---|
| `GET /ws/chat/{session_id}?bot_key=…` | Visitor (widget) | public `bot_key` query param |
| `GET /ws/operator?api_key=…` | Operator | `operator_api_key` query param |
| `GET /ws/agent?api_key=…` | Operator (legacy alias) | same |

## WebSocket message types

Inbound frames actually dispatched in `ws_routes.py` — accept, transfer, close and resolve are **REST**, not WS frames:

| Socket | Type | Purpose |
|---|---|---|
| both | `ping` → `pong` | Liveness |
| both | `message` | Send a chat message |
| both | `file` | Send an attachment (shares the message queue so it can't overtake) |
| both | `typing` | Typing indicator |
| both | `read_receipt` | Mark read |
| visitor | `stopped_typing` | Clear the indicator |
| visitor | `status_check` | Re-sync session state after a reconnect |
| visitor | `submit_offline_form` | Offline capture |
| visitor | `leave_queue` | Give up waiting (`waiting → bot`) |
| visitor | `visitor_end_chat` | End a live chat (`live → bot`) |
| operator | `heartbeat` | Refresh the 60s Redis presence key |
| operator | `set_availability` | Accepting / not accepting chats |
| operator | `close_chat` | Close from the socket (`live → bot`) |

Operator actions that change assignment go through REST on the API process: `POST /operators/accept/{id}`, `/transfer/{id}`, `/close/{id}`, `/resolve/{id}`, `/cancel-handoff/{id}`, plus `GET /operators/queue`.

## Key files

| File | Role |
|---|---|
| [`api/app/api/ws_routes.py`](../../../../api/app/api/ws_routes.py) | WebSocket route, message dispatch, rate limit |
| [`api/app/services/live_chat_service.py`](../../../../api/app/services/live_chat_service.py) | `ConnectionManager` — per-process socket maps, unioned with Redis presence for every fan-out |
| [`api/app/services/ws_backplane.py`](../../../../api/app/services/ws_backplane.py) | Cross-process delivery over Redis pub/sub (`ws:operator:{id}`, `ws:session:{id}`), gated by `WS_BACKPLANE_ENABLED` |
| [`api/app/services/session_state_machine.py`](../../../../api/app/services/session_state_machine.py) | The only sanctioned status writer — CAS via `expected_current`, one audit row per transition |
| [`api/app/services/live_chat_queue_service.py`](../../../../api/app/services/live_chat_queue_service.py) · [`operator_presence_service.py`](../../../../api/app/services/operator_presence_service.py) | Redis-backed queue and presence |
| [`api/systemd/oyechats-ws.service`](../../../../api/systemd/oyechats-ws.service) · [`api/nginx/oyechats-locations.conf`](../../../../api/nginx/oyechats-locations.conf) | The `/ws/` process split |
| [`api/app/api/operator_routes.py`](../../../../api/app/api/operator_routes.py) | Handoff endpoint, operator login, assignment |
| [`api/app/api/offline_message_routes.py`](../../../../api/app/api/offline_message_routes.py) | Offline form |
| [`platform/widget/src/components/HandoffForm.jsx`](../../../../widget/src/components/HandoffForm.jsx) | Pre-handoff lead capture |
| [`platform/widget/src/components/LiveChatMode.jsx`](../../../../widget/src/components/LiveChatMode.jsx) | Visitor live-chat UI |
| [`app/src/features/inbox/InboxPage.tsx`](../../../../app/src/features/inbox/InboxPage.tsx) · [`useOperatorSocket.ts`](../../../../app/src/features/inbox/useOperatorSocket.ts) | Operator console + its `/ws/operator` client |

## Configurable timeouts (per bot)

| Setting | Default | Effect |
|---|---|---|
| `operator_timeout_seconds` | 600 | Inactivity → auto-close |
| `live_chat_queue_timeout_seconds` | per bot | How long a visitor waits before the queue gives up |
| `live_chat_max_queue_size` | per bot | Queue admission cap |
| `live_chat_routing_strategy` | per bot | How a waiting visitor is matched to an operator |
| `visitor_disconnect_timeout` | 120 | Grace period before auto-close on visitor drop |
| `operator_disconnect_timeout` | 60 | Grace period before re-queue on operator drop |
| `business_hours` | per-day map | Outside hours → offline path |

## Rate limiting

- Visitors: 30 messages/min/connection
- Operators: 60 messages/min/connection
- Enforced inside the WS handler with a sliding window stored on the connection object

## Failure modes

- **Operator disconnects mid-chat** → grace period, then the session is released; audit logged with `action='timeout'`.
- **Visitor closes tab** → `visitor_disconnect_timeout` (default 120s), then `_mark_session_closed` transitions the session back to `bot` (audit `visitor_disconnected`) — *not* to `closed`.
- **Stale queue-timeout task** → the timeout handler honours the compare-and-swap result and only tells the visitor "unavailable" when its own CAS won. Before that, across two processes a chat that had been live for ~110s was torn down at t+120s by a timer belonging to the earlier `waiting` state.
- **Backplane off or Redis down** → delivery silently degrades to local sockets only. On the API process those maps are empty, so a handoff notifies nobody: the operator sees "Waiting (0)" beside a sidebar badge of 1. Publishes are best-effort by design and never fail the request, which is exactly why this failure is quiet.
- **Both Postgres and Redis up but worker down** → handoff still works (no async dependencies); only emails are delayed.

## Why this matters

Live chat is the largest subsystem in the codebase. Most bugs in this flow trace back to one of three places: (a) the transitions, which must go through `session_state_machine.transition_session` with an `expected_current` CAS rather than a direct status write; (b) cross-process delivery, where anything that iterates a per-process dict reaches nobody in production; (c) cross-tenant safety in `ws_routes.py`. The FSM page has the formal state diagram.
