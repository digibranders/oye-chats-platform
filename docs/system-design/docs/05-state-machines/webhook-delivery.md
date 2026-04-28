# Webhook delivery FSM

> **Audience:** New engineers · **Read time:** 3 min · **Last updated:** 2026-04-28

## TL;DR

Each row in `webhook_deliveries` is a state machine: **`pending` → `delivering` → `delivered`** on success, or **`retrying`** with backoff up to 5 attempts before terminal **`dead`**. Manual retry from the admin UI re-enters the chain.

## Diagram

```mermaid
stateDiagram-v2
    [*] --> pending: event emitted<br/>by webhook_service.emit()

    pending --> delivering: ARQ task_deliver_webhook starts
    delivering --> delivered: 2xx response
    delivering --> retrying: non-2xx, timeout, or DNS error<br/>(attempt < 5)<br/>set next_retry_at
    delivering --> dead: attempt == 5<br/>(final failure)

    retrying --> delivering: task_process_webhook_retries finds<br/>next_retry_at <= now()

    dead --> pending: admin clicks "Retry" in UI<br/>(attempt counter resets to 1)

    delivered --> [*]
```

## Backoff schedule

```mermaid
flowchart LR
    classDef try fill:#e0e7ff,stroke:#4f46e5,color:#312e81
    classDef dead fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d,stroke-width:2px

    A1["attempt 1<br/>0s"]:::try
    A2["attempt 2<br/>+30s"]:::try
    A3["attempt 3<br/>+2 min"]:::try
    A4["attempt 4<br/>+10 min"]:::try
    A5["attempt 5<br/>+1 hr"]:::try
    Dead["dead<br/>(manual retry only)"]:::dead

    A1 -- "non-2xx" --> A2 -- "non-2xx" --> A3 -- "non-2xx" --> A4 -- "non-2xx" --> A5 -- "non-2xx" --> Dead
```

Total elapsed time before `dead`: ~1h 12m 30s.

## Audit trail

The `webhook_deliveries` row is the audit record itself — `attempt`, `status`, `response_code`, `response_body`, `next_retry_at` all live there. There is no separate audit table.

## Key files

| File | Role |
|---|---|
| [`api/app/services/webhook_service.py`](../../../api/app/services/webhook_service.py) | Emit + retry policy + signature |
| [`api/app/worker/tasks.py`](../../../api/app/worker/tasks.py) | `task_deliver_webhook` + `task_process_webhook_retries` |
| [`platform/app/src/pages/Webhooks.jsx`](../../../app/src/pages/Webhooks.jsx) | UI to view + manually retry |

## Why this matters

The FSM is intentionally simple — every cell in a row tells you exactly where in its life a delivery is. Customer support questions like "why did our CRM not get this lead?" are one SQL query: `SELECT * FROM webhook_deliveries WHERE event_type='lead_captured' AND created_at > ...`.
