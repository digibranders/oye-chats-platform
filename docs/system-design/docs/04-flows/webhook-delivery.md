# Webhook delivery

> **Audience:** New engineers · **Read time:** 4 min · **Last updated:** 2026-04-28

## TL;DR

Five outbound event types (`tier_transition`, `lead_captured`, `handoff_requested`, `chat_closed`, `meeting_booked`) → enqueued to ARQ → POSTed with HMAC-SHA256 signature → 5-attempt retry chain at 30s / 2m / 10m / 1h / 4h backoffs → final status `delivered` or `dead`. All deliveries logged in `webhook_deliveries`.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    box rgb(224,242,254) Producers
      participant Producer as event source
    end
    box rgb(254,243,199) Webhook pipeline
      participant Svc as webhook_service
      participant Worker as ARQ task_deliver_webhook
      participant Sweep as ARQ task_process_webhook_retries
    end
    box rgb(220,252,231) Data
      participant DB as Postgres
    end
    box rgb(252,231,243) Customer side
      participant CRM as Customer CRM
    end

    Producer->>Svc: emit(event_type, payload, bot_id)
    Svc->>DB: SELECT * FROM webhooks WHERE bot_id=:bot_id AND active AND event_type IN event_filter
    loop per matching webhook
        Svc->>DB: INSERT webhook_deliveries (attempt=1, status='pending')
        Svc->>Worker: enqueue task_deliver_webhook(delivery_id)
    end

    Worker->>DB: SELECT delivery + webhook
    Worker->>Worker: build canonical payload + sign (HMAC-SHA256(secret, body))
    Worker->>CRM: POST url, headers: X-OyeChats-Signature, X-OyeChats-Event
    alt 2xx response
        CRM-->>Worker: 200
        Worker->>DB: UPDATE webhook_deliveries SET status='delivered', response_code=200
    else non-2xx or timeout
        Worker->>DB: UPDATE webhook_deliveries SET attempt+=1, next_retry_at=now+backoff(attempt)
        alt attempt < 5
            Worker->>DB: status='retrying'
        else
            Worker->>DB: status='dead'
            Worker->>Worker: optional: notify owner via email
        end
    end

    Note over Worker,DB: Periodic sweep
    Sweep->>DB: SELECT delivery WHERE status='retrying' AND next_retry_at <= now()
    Sweep->>Worker: re-enqueue task_deliver_webhook
```

## Backoff schedule

| Attempt | Delay before this attempt |
|---|---|
| 1 | 0 (immediate) |
| 2 | 30 seconds |
| 3 | 2 minutes |
| 4 | 10 minutes |
| 5 | 1 hour |

(After attempt 5 → status `dead`. Customers can manually retry from the Webhook delivery log UI.)

## Signature

HMAC-SHA256 with the per-webhook `secret`, hex-encoded, sent in `X-OyeChats-Signature`. Customers verify by repeating the HMAC server-side. Headers also include:

```
X-OyeChats-Signature: <hex>
X-OyeChats-Event: tier_transition
X-OyeChats-Delivery: <delivery_id>
X-OyeChats-Bot-Id: <bot_id>
```

## Event payloads

| Event | Trigger | Payload (top-level keys) |
|---|---|---|
| `tier_transition` | `bant_tier` crossed a threshold (MQL/SAL/SQL) | session, lead, framework, previous_tier, new_tier, score |
| `lead_captured` | `lead_info` row created (form submit) | session, lead |
| `handoff_requested` | `chat_sessions.status` → `waiting` | session, lead, reason |
| `chat_closed` | session → `closed` | session, summary, audit_log_excerpt, rating |
| `meeting_booked` | provider booking webhook confirms | session, lead, booking |

## Key files

| File | Role |
|---|---|
| [`api/app/services/webhook_service.py`](../../../api/app/services/webhook_service.py) | Emit + sign + enqueue + retry policy |
| [`api/app/api/webhook_routes.py`](../../../api/app/api/webhook_routes.py) | CRUD for `webhooks` registrations |
| [`api/app/api/lead_routes.py`](../../../api/app/api/lead_routes.py) | CRM template helpers (Salesforce, HubSpot stubs) |
| [`api/app/worker/tasks.py`](../../../api/app/worker/tasks.py) | `task_deliver_webhook`, `task_process_webhook_retries` |
| [`platform/app/src/pages/Webhooks.jsx`](../../../app/src/pages/Webhooks.jsx) | Admin UI: registrations + delivery log |

## Failure modes

- **Customer endpoint 5xx** → retry chain absorbs intermittent failures.
- **Customer endpoint 4xx** → still retried (e.g., 429 rate-limit); permanent 4xx still ends as `dead` after 5 attempts so that fix-and-retry from the UI works.
- **Signature mismatch on customer side** → that's their bug; we delivered with valid signature, response code is logged for them to debug.
- **Worker down** → events sit in `pending`; the next worker run drains them. Producers don't block on delivery.

## Why this matters

This is OyeChats' integration surface for customer CRMs. Reliability here is what convinces a sales team to wire OyeChats to their pipeline. The retry chain + idempotency + delivery log are the same shape as Stripe and Razorpay's outbound webhooks — see also [Webhook delivery FSM](/05-state-machines/webhook-delivery).
