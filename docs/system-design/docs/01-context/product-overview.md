# Product overview

> **Audience:** Everyone · **Read time:** 4 min · **Last updated:** 2026-04-28

## TL;DR

OyeChats is a multi-tenant SaaS that lets a customer drop one `<script>` tag onto their website and get an AI chatbot that answers visitor questions from their own knowledge base, captures qualified leads (BANT/MEDDIC), and hands off to a human operator when needed. Monetisation is credit-based (Razorpay primary in INR, Stripe fallback for international cards).

## What the product does

| Job to be done | OyeChats answer |
|---|---|
| "Answer visitor FAQs from our docs/website 24×7" | RAG over the customer's own knowledge base — PDF/DOCX/TXT uploads or URL crawls; OpenAI `gpt-5.4-mini` primary, Gemini `gemini-2.5-flash` fallback. |
| "Capture leads while we sleep" | Inline qualification CTAs, BANT scoring, MQL/SAL/SQL tiering, lead alert emails, custom CRM webhooks. |
| "Hand off to a real human when needed" | WebSocket live chat with operator queue, departments, canned responses, audit log, post-chat ratings. |
| "Plug it in without an engineer" | Single `<script src=cdn.oyechats.com/oyechats-widget.js data-bot-key=…>` tag — works on Next.js, WordPress, Webflow, Shopify, plain HTML. |
| "Pay only for what we use" | Event-sourced credit ledger; AI message = 1 credit, URL scan = 3, customer-facing email = 1; system emails free; top-ups expire FIFO after 12 months. |

## End-to-end story

```
Customer signs up → creates a Bot → uploads docs OR crawls URL → copies <script> tag
        │                                                                │
        │                                                                ▼
        │                                              Pastes into their website's <body>
        │                                                                │
        ▼                                                                ▼
   Admin dashboard                                              Visitor lands on page
   (manage bot, see leads,                                          │
    answer live chats)                                              ▼
                                                       Widget loads, auto-creates session
                                                                    │
                                                                    ▼
                                                      Ask question → API → RAG →
                                                      LLM stream → response → BANT extract →
                                                      (optional) escalate to live operator
```

## Three apps in this monorepo

| App | Purpose | Stack | Hosting |
|---|---|---|---|
| **`platform/api`** | FastAPI backend — REST + WebSocket + ARQ worker. The only stateful tier. | Python 3.11 · FastAPI · SQLAlchemy · pgvector · LiteLLM · ARQ | DigitalOcean droplet (Gunicorn behind Nginx) |
| **`platform/widget`** | Self-contained IIFE bundle that customers embed. | React 19 · Vite 7 · Tailwind v4 | Cloudflare R2 (`cdn.oyechats.com`) |
| **`platform/app`** | Admin dashboard SPA — bot management, knowledge base, leads, live chat, billing. | React 19 · Vite 8 · React Router 7 · Recharts | Vercel |

(Landing page `landing/` is a separate Next.js project and is out of scope for this site.)

## Pricing model at a glance

- **Plans** (`plans` table): Free, Standard (₹49/month, 100 credits, 1 operator seat), and higher tiers tunable via `PricingConfig` super-admin store.
- **Credits**: 1 per AI message, 3 per URL scan, 1 per customer-facing email, free for system emails (OTP/password-reset/operator pings).
- **Top-ups**: extra credit packs that expire 12 months after grant, consumed FIFO before plan credits.
- **Seats**: extra operator seats charged per-seat above plan inclusion.
- **Kill switch**: `PricingConfig.kill_switch=true` halts all credit deductions globally without a code deploy.

## Why this stack (one-line each)

- **FastAPI + SQLAlchemy 2.0** — async-friendly Python, great Pydantic ergonomics for our API surface.
- **Postgres + pgvector** — single primary store; vector + relational + TSVECTOR full-text in one place.
- **LiteLLM** — provider-agnostic LLM router with automatic fallback and unified Langfuse tracing.
- **ARQ on Redis** — lightweight background queue; same Redis already needed for rate-limiting and caching.
- **React 19 + Vite** — same toolchain in the widget and admin; widget bundles its own React for host-page isolation.
- **Razorpay primary** — UPI Autopay is the dominant rail in our launch market (India); Stripe handles international.

## What this site is, and isn't

This site is the **living architecture reference** — diagrams, flows, state machines, capacity. It complements but does **not** replace:

- [`platform/docs/api-reference.md`](../../api-reference.md) — endpoint contracts.
- [`platform/docs/runbooks/`](../../runbooks/) — incident playbooks.
- [`platform/docs/graph-*.md`](../../graph-architecture-map.md) — code-graph generated module maps.

When code lands that changes a diagram here, the merging engineer is expected to update the affected page. See the [README](https://github.com/digibranders/oye-chats-platform/blob/development/docs/system-design/README.md) for conventions.
