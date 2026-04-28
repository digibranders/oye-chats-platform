# Billing & checkout

> **Audience:** New engineers · CTO · **Read time:** 5 min · **Last updated:** 2026-04-28

## TL;DR

Customer picks a plan → backend creates a provider order/subscription (Razorpay primary in INR, Stripe fallback) → customer completes payment → provider sends a webhook → idempotency check → activate `subscriptions` row → grant credits → notify. Top-ups follow the same shape but write to `credit_ledger` with `expires_at = now + 12 months`.

## Sequence — subscribing to a paid plan

```mermaid
sequenceDiagram
    autonumber
    actor Cust as Customer
    box rgb(224,242,254) Browser
      participant Admin as Admin SPA
    end
    box rgb(254,243,199) Backend
      participant API as FastAPI
      participant DB as Postgres
    end
    box rgb(252,231,243) Payment providers
      participant RZP as Razorpay
      participant Stripe
    end
    box rgb(237,233,254) Async + email
      participant Worker as ARQ
      participant Brevo
    end

    Cust->>Admin: /subscription, choose Standard plan, click Pay
    Admin->>API: POST /subscriptions/checkout (plan_id, cycle, provider="razorpay")
    alt provider=razorpay (default)
        API->>RZP: create subscription (or order for one-time)
        RZP-->>API: subscription_id, short_url
        API->>DB: INSERT subscriptions (status=trialing, provider_subscription_id, ...)
        API-->>Admin: { provider_url }
        Admin->>RZP: redirect to checkout (UPI Autopay / card)
        Cust->>RZP: complete payment
    else provider=stripe (fallback)
        API->>Stripe: create checkout.session
        Stripe-->>API: session.url
        API-->>Admin: { provider_url }
        Admin->>Stripe: redirect
        Cust->>Stripe: complete payment
    end

    Note over RZP,API: Provider webhook
    RZP-->>API: POST /webhooks/razorpay (signed)
    API->>API: verify signature (HMAC-SHA256)
    API->>DB: SELECT processed_webhooks WHERE event_id=...
    alt already processed
        API-->>RZP: 200 OK (idempotent)
    else new
        API->>DB: INSERT processed_webhooks (event_id, provider)
        API->>DB: UPDATE subscriptions SET status='active', current_period_end
        API->>DB: INSERT invoices
        API->>DB: INSERT credit_ledger (delta=plan grant, expires_at=NULL, reason='monthly_grant')
        API->>Worker: enqueue task_send_email("subscription_active")
        Worker-->>Brevo: send confirmation
    end

    Admin->>API: GET /subscriptions/current (poll after redirect back)
    API-->>Admin: status=active, plan=Standard, credits=100
    Admin-->>Cust: success page
```

## Sequence — buying a credit top-up pack

```mermaid
sequenceDiagram
    autonumber
    actor Cust as Customer
    participant Admin as Admin SPA
    participant API
    participant RZP as Razorpay
    participant DB as Postgres

    Cust->>Admin: select top-up pack (50 / 200 / 500 credits)
    Admin->>API: POST /subscriptions/topup (pack=200)
    API->>API: read pack price + credits from pricing_config.topup_packs
    API->>RZP: create one-time order (₹999)
    RZP-->>API: order_id
    API-->>Admin: { order_id, key_id }
    Admin->>RZP: open Razorpay checkout
    Cust->>RZP: complete payment
    RZP-->>Admin: payment_id, signature

    Admin->>API: POST /subscriptions/topup/verify (order_id, payment_id, signature)
    API->>API: verify HMAC signature
    API->>DB: INSERT credit_ledger (delta=+200, reason='topup', expires_at=now+12mo, grant_id=self)
    API->>DB: INSERT invoices
    API-->>Admin: { credit_balance, expiry_date }
```

## Key files

| File | Role |
|---|---|
| [`api/app/api/subscription_routes.py`](../../../api/app/api/subscription_routes.py) | All `/subscriptions/*` endpoints |
| [`api/app/api/webhook_billing_routes.py`](../../../api/app/api/webhook_billing_routes.py) | Inbound Razorpay + Stripe webhooks |
| [`api/app/services/razorpay_service.py`](../../../api/app/services/razorpay_service.py) | Razorpay subscription/order/signature/webhook handling |
| [`api/app/services/billing_service.py`](../../../api/app/services/billing_service.py) | Stripe equivalent |
| [`api/app/services/credit_service.py`](../../../api/app/services/credit_service.py) | Credit ledger writes |
| [`api/app/services/plan_service.py`](../../../api/app/services/plan_service.py) | Plan lookups, trial logic |
| [`platform/app/src/pages/Subscription.jsx`](../../../app/src/pages/Subscription.jsx) | Plan compare + checkout |
| [`platform/app/src/pages/Billing.jsx`](../../../app/src/pages/Billing.jsx) | Existing customer billing dashboard |

## Idempotency

The single most important property: webhooks are retried by both Razorpay and Stripe. The `processed_webhooks` composite PK `(event_id, provider)` ensures every event is applied exactly once. Both webhook handlers do the SELECT-then-INSERT in a transaction (`ON CONFLICT DO NOTHING` semantically).

## Currencies

- All money stored in **minor units** (paise / cents), `int` columns.
- `Plan.currency` decides display; the active provider is a function of the customer's selection at checkout.
- Razorpay handles INR end-to-end (UPI Autopay covers most of our launch market). Stripe handles every other currency.

## Provider selection logic

```mermaid
flowchart LR
    classDef start fill:#fff7ed,stroke:#c2410c,color:#7c2d12
    classDef gate fill:#fef9c3,stroke:#a16207,color:#713f12,stroke-dasharray:5 3
    classDef provider fill:#e0e7ff,stroke:#4f46e5,color:#312e81

    Start["User clicks Pay"]:::start
    A{{"BILLING_PROVIDER<br/>env override?"}}:::gate
    B{{"Customer chose<br/>provider?"}}:::gate
    RZP["Razorpay checkout"]:::provider
    Stripe["Stripe checkout"]:::provider

    Start --> A
    A -- "env = stripe" --> Stripe
    A -- "env = razorpay (default)" --> B
    B -- "razorpay" --> RZP
    B -- "stripe" --> Stripe
    B -- "default · INR" --> RZP
```

`BILLING_PROVIDER` env var lets ops force one in case of an outage. The default is `razorpay` (per-CLAUDE.md).

## Failure modes

- **Provider webhook lost** → both providers will retry indefinitely; the next retry hits the idempotency log and finishes the activation.
- **Out-of-order webhooks** (e.g., `payment_failed` arrives before `payment_succeeded`) → the FSM in [Subscription state machine](/05-state-machines/subscription) keeps the system at the most-advanced state seen.
- **Signature mismatch** → 401, no DB writes, ops alerted via Sentry.
- **Customer pays but webhook never arrives** → fallback poll job (planned, not yet built) will sweep `subscriptions WHERE status='trialing' AND created_at < now-24h` against provider APIs.

## Why this matters

This is the only flow that touches **money**. Bugs here are unrecoverable in the worst case (double-charge, missed activation). Idempotency, signature verification, and the `processed_webhooks` log are the three guard rails. When changing this code, the test suite in `api/tests/test_subscription_routes.py` and the Razorpay/Stripe webhook fixtures are mandatory reading.
