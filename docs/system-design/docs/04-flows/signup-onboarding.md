# Signup & onboarding

> **Audience:** New engineers · **Read time:** 4 min · **Last updated:** 2026-04-28

## TL;DR

Customer registers → seeded as `clients` row + free trial `subscriptions` row → creates first `bots` row → uploads docs (or crawls URL) → grabs embed snippet from the Chatbot page. End-to-end zero engineer required.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User as Customer
    box rgb(224,242,254) Browser
      participant Admin as Admin SPA
    end
    box rgb(254,243,199) Backend
      participant API as FastAPI
      participant DB as Postgres
    end
    box rgb(237,233,254) Async + email
      participant Worker as ARQ
      participant Brevo
    end

    User->>Admin: visit /register, submit email + password + company
    Admin->>API: POST /auth/register
    API->>DB: INSERT clients (api_key=randomgen, hashed_password)
    API->>DB: INSERT subscriptions (plan=free, status=trialing)
    API->>DB: INSERT credit_ledger (delta=plan grant)
    API->>Worker: enqueue task_send_email("welcome")
    API-->>Admin: 200 + api_key
    Admin->>Admin: store api_key in localStorage
    Worker-->>Brevo: send "welcome" email (sys, free)

    User->>Admin: navigate /chatbot, fill name + system_prompt
    Admin->>API: POST /bots (X-API-Key)
    API->>DB: INSERT bots (bot_key=bot-randomgen)
    API-->>Admin: bot id + bot_key
    Admin-->>User: render embed snippet

    User->>Admin: navigate /knowledge, upload PDF
    Admin->>API: POST /documents/upload (X-API-Key, file)
    API->>API: store file in Cloudflare R2 (S3-compatible PUT)
    API->>Worker: enqueue task_ingest_documents(bot_id, r2_key)
    API-->>Admin: 202 Accepted
    Worker->>Worker: extract → clean → chunk → embed
    Worker->>DB: INSERT documents (vectors, tsvector)
    Worker-->>Admin: status polled via /documents/{id}

    User->>User: copy <script> tag<br/>paste into website
```

## Key files

| File | Role |
|---|---|
| [`api/app/api/auth_routes.py`](../../../api/app/api/auth_routes.py) | `POST /auth/register`; password hashing, api_key gen, default subscription |
| [`api/app/api/bot_routes.py`](../../../api/app/api/bot_routes.py) | `POST /bots`, embed-script template |
| [`api/app/api/document_routes.py`](../../../api/app/api/document_routes.py) | Upload route → R2 → ARQ enqueue |
| [`api/app/services/credit_service.py`](../../../api/app/services/credit_service.py) | First plan-grant ledger row |
| [`api/app/worker/tasks.py`](../../../api/app/worker/tasks.py) | `task_ingest_documents` |
| [`platform/app/src/pages/Register.jsx`](../../../app/src/pages/Register.jsx) | Form |
| [`platform/app/src/pages/Chatbot.jsx`](../../../app/src/pages/Chatbot.jsx) | Embed snippet UI |
| [`platform/app/src/pages/KnowledgeBase.jsx`](../../../app/src/pages/KnowledgeBase.jsx) | Upload UI |

## Failure modes

- **Email already in use** → 409, customer told to log in instead.
- **R2 upload fails** → 502, no `documents` rows are written; user can retry.
- **Worker not running** → ingestion sits in queue; in dev/test, `WORKER_ENABLED=false` switches to in-process thread pool so it's never *stuck*.
- **Embed script copied wrong** → bot returns 404 on widget settings call; widget shows a helpful "[OyeChats] bot key invalid" console error.

## Why this matters

This is the path every customer walks. If anything in this chain regresses, the conversion funnel collapses — see [Analytics](../../../app/src/pages/Analytics.jsx) for the metrics to watch.
