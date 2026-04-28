# System context — C4 Level 1

> **Audience:** New engineers · CTO · **Read time:** 4 min · **Last updated:** 2026-04-28

## TL;DR

At the highest zoom, OyeChats is a single SaaS that four kinds of human actors interact with (visitor, customer admin, operator, super-admin) and that talks to ten external systems for LLM, embeddings, payments, email, file storage, observability, and CDN.

## Diagram

```mermaid
---
config:
  layout: elk
  flowchart:
    nodeSpacing: 50
    rankSpacing: 90
---
flowchart LR
    classDef actor fill:#f1f5f9,stroke:#475569,color:#0f172a,stroke-width:2px
    classDef system fill:#e0e7ff,stroke:#4f46e5,color:#312e81,stroke-width:2px
    classDef llm fill:#fce7f3,stroke:#be185d,color:#831843
    classDef pay fill:#fef3c7,stroke:#b45309,color:#78350f
    classDef ops fill:#cffafe,stroke:#0891b2,color:#164e63
    classDef storage fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
    classDef mail fill:#dcfce7,stroke:#15803d,color:#14532d

    subgraph Actors["People"]
      direction TB
      Visitor(("Visitor<br/>(anonymous)")):::actor
      Customer(("Customer<br/>admin")):::actor
      Operator(("Operator<br/>live-chat")):::actor
      SA(("Super-admin<br/>OyeChats internal")):::actor
    end

    OyeChats[["OyeChats Platform<br/>RAG chat · live chat · leads · billing"]]:::system

    subgraph AI["AI providers"]
      direction TB
      OpenAI[("OpenAI<br/>LLM + embeddings")]:::llm
      Gemini[("Google Gemini<br/>fallback + gate")]:::llm
    end

    subgraph Pay["Payments"]
      direction TB
      Razorpay[("Razorpay<br/>INR primary")]:::pay
      Stripe[("Stripe<br/>international")]:::pay
    end

    subgraph Infra["Hosting & files"]
      direction TB
      CFCDN[("Cloudflare R2 + CDN<br/>widget hosting")]:::storage
      R2Files[("Cloudflare R2<br/>uploads · backups")]:::storage
    end

    subgraph Comms["Comms"]
      direction TB
      Brevo[("Brevo<br/>email")]:::mail
      CRM[("Customer CRMs<br/>signed webhooks")]:::mail
    end

    subgraph Obs["Observability"]
      direction TB
      Langfuse[("Langfuse<br/>LLM traces")]:::ops
      Sentry[("Sentry<br/>errors + perf")]:::ops
    end

    Visitor == "loads widget · chats" ==> OyeChats
    Customer == "configures bots · KB · billing" ==> OyeChats
    Operator == "accepts handoffs · WS messages" ==> OyeChats
    SA == "plans · pricing · clients" ==> OyeChats

    Visitor -. "loads JS" .-> CFCDN
    OyeChats -. "publishes via CI" .-> CFCDN

    OyeChats -- "chat + embed" --> OpenAI
    OyeChats -- "fallback + gate" --> Gemini
    OyeChats <-- "subs · webhooks" --> Razorpay
    OyeChats <-- "subs · webhooks" --> Stripe
    OyeChats -- "send" --> Brevo
    OyeChats -- "POST · HMAC" --> CRM
    OyeChats <-- "S3 PUT/GET" --> R2Files
    OyeChats -- "trace events" --> Langfuse
    OyeChats -- "exceptions" --> Sentry
```

## Actors

| Actor | Authenticates with | Touches |
|---|---|---|
| **Visitor** | None (anonymous; identified by `session_id` cookie) | Widget on customer's site |
| **Customer / Admin** | `X-API-Key` header | Admin dashboard at app domain |
| **Operator** | `X-Operator-Key` (legacy alias `X-Agent-Key`) | Admin dashboard live-chat & team pages |
| **Super-admin** | `X-API-Key` with `is_superadmin=true` | `/superadmin/*` admin pages |

## External systems

| System | Why | Failure mode | Documented in |
|---|---|---|---|
| **OpenAI** | Primary LLM (`gpt-5.4-mini`) + embedding model (`text-embedding-3-small`, 1536-dim) | LiteLLM auto-fails over to Gemini | [External services](/07-deployment/external-services) |
| **Google Gemini** | Fallback LLM (`gemini-2.5-flash`); also gate/enrichment model | If both providers down, chat returns a 502 with retry | [External services](/07-deployment/external-services) |
| **Razorpay** | Primary payment gateway (UPI Autopay, INR) | Stripe handles international cards as fallback | [Billing & checkout](/04-flows/billing-checkout) |
| **Stripe** | International card processing | Razorpay covers INR independently | [Billing & checkout](/04-flows/billing-checkout) |
| **Brevo** | Transactional email (lead alerts, password reset, operator pings) | Failures captured to Sentry; non-blocking | [External services](/07-deployment/external-services) |
| **Cloudflare R2** | S3-compatible object storage for uploaded documents | If down, ingestion blocked but chat unaffected | [Document ingestion](/04-flows/document-ingestion) |
| **Langfuse** | LLM trace export | `LANGFUSE_FORCE_DISABLE` toggle if causing memory pressure (currently disabled on prod) | [Observability](/08-cross-cutting/observability) |
| **Sentry** | Error + perf tracking | Optional — SDK no-ops if `SENTRY_DSN` unset | [Observability](/08-cross-cutting/observability) |
| **Cloudflare R2 + CDN** | Hosts `cdn.oyechats.com/oyechats-widget.js` | Cache-revalidate headers; loader + manifest are short-cache, hashed chunks immutable | [CI/CD](/07-deployment/ci-cd) |
| **Customer CRMs** | Outbound HMAC-signed webhooks (`tier_transition`, `lead_captured`, `handoff_requested`, `chat_closed`, `meeting_booked`) | 5-attempt retry with 30s/2m/10m/1h backoff | [Webhook delivery](/04-flows/webhook-delivery) |

## Trust boundaries

```mermaid
flowchart LR
    classDef untrusted fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d,stroke-dasharray:6 3
    classDef trusted fill:#dcfce7,stroke:#15803d,color:#14532d,stroke-width:2px
    classDef ext fill:#fce7f3,stroke:#be185d,color:#831843

    subgraph customer["⚠ Customer website (untrusted)"]
      direction TB
      widget[["Widget JS<br/>browser-side"]]:::untrusted
    end
    subgraph oye["✅ OyeChats (trusted)"]
      direction TB
      api[["FastAPI · Worker"]]:::trusted
      db[("Postgres + Redis")]:::trusted
    end
    subgraph third["3rd-party SaaS"]
      direction TB
      ext[("OpenAI · Gemini<br/>Brevo · Stripe · …")]:::ext
    end

    widget == "public X-Bot-Key" ==> api
    api == "secret API keys (server-side only)" ==> ext
    api --- db
```

The widget runs on **untrusted host pages**; only the public `bot_key` ever ships to the browser. All secret API keys (OpenAI, Razorpay, Brevo, etc.) live in `/opt/oyechats/platform/api/.env` on the API host and never leave server-side.

## Why this matters

A new engineer should be able to point at this diagram and answer:
1. "Where does customer money go?" → Razorpay/Stripe.
2. "Where do customer documents physically live?" → Postgres (chunks + embeddings) and R2 (originals).
3. "What happens if OpenAI has an outage?" → LiteLLM falls back to Gemini, chat continues.
4. "Where does the widget code physically live?" → Cloudflare R2 at `cdn.oyechats.com`.

If any of those answers stop being true, this page is what to update first.
