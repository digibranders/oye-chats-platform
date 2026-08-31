# Product overview

> **Audience:** Everyone · **Read time:** 4 min · **Last updated:** 2026-08-31

## TL;DR

OyeChats is a multi-tenant SaaS that lets a customer drop one `<script>` tag onto their website and get an AI chatbot that answers visitor questions from their own knowledge base, captures qualified leads (BANT/MEDDIC), and hands off to a human operator when needed. Monetisation is credit-based, billed through **Razorpay only** — INR domestically and USD for exports, on separate Razorpay plan ids.

## What the product does

| Job to be done | OyeChats answer |
|---|---|
| "Answer visitor FAQs from our docs/website 24×7" | RAG over the customer's own knowledge base — PDF/DOCX/TXT uploads or URL crawls (Jina Reader primary, Spider.cloud fallback, both off-box); Gemini `gemini-embedding-001` for embeddings; OpenAI `gpt-5.4-mini` primary and Gemini `gemini-2.5-flash` fallback for generation. A relevance gate, on by default, is what backs the "answers only from your knowledge base" claim. |
| "Capture leads while we sleep" | Inline qualification CTAs, BANT scoring, MQL/SAL/SQL tiering, lead alert emails, custom CRM webhooks. |
| "Hand off to a real human when needed" | WebSocket live chat with operator queue, departments, canned responses, audit log, post-chat ratings. |
| "Plug it in without an engineer" | Single `<script src=cdn.oyechats.com/oyechats-widget.js data-bot-key=…>` tag — works on Next.js, WordPress, Webflow, Shopify, plain HTML. |
| "Pay only for what we use" | Event-sourced credit ledger; AI message = 1 credit, URL scan = 5, document upload priced by word count, enrichment lookups metered separately; system emails free; top-ups carry forward for life by default (`topup_expiry_months = 0`). |

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
| **`platform/widget`** | Loader IIFE + lazy ESM chunks, mounted in a shadow root on the customer's page. | React 19 · Vite 7 · Tailwind v4 | Cloudflare R2 (`cdn.oyechats.com`) |
| **`platform/app`** | Admin dashboard SPA — bot management, knowledge base, leads, live chat, billing. | React 19 · Vite 8 · React Router 7 · Recharts | Vercel |

(The marketing site is a **separate repository**, `../oyechats-website` — not a directory in this one — and is out of scope for this site.)

## Pricing model at a glance

- **Plans** (`plans` table): Free, Starter, Standard, Professional — plus a non-public `trial` row that every signup lands on, the only seeded row with `trial_days > 0`. Amounts, credit grants and seat inclusions live in `api/scripts/seed_plans.py`, which is the price source of truth; credit costs and top-up packs are tunable at runtime via the `PricingConfig` super-admin store.
- **Prices are BASE prices, exclusive of GST** (changed 2026-08-26). A domestic customer is debited base + GST, added at charge time by `core/tax.py::gross_charge_minor`. An international customer is an export of services, pays no Indian GST, and is charged the listed USD price.
- **Credits**: 1 per AI message (`credit_cost.ai_chat`), 5 per URL scan, document uploads by word count, 10 per email verification and 5 per company lookup where those features are enabled; system emails (OTP/password-reset/operator pings) are free. The shipped seed also sets `credit_cost.email_send` to 0.
- **Top-ups**: extra credit packs. **They do not expire by default** — `pricing_config.topup_expiry_months` ships as `0`, meaning lifetime; set it positive to switch expiry on. Allocation spends **plan credits first** (they are use-it-or-lose-it), then top-ups by soonest expiry.
- **Seats**: extra operator seats charged per-seat above plan inclusion.
- **Kill switch**: `PricingConfig.kill_switch=true` halts all credit deductions globally without a code deploy.

## Why this stack (one-line each)

- **FastAPI + SQLAlchemy 2.0** — async-friendly Python, great Pydantic ergonomics for our API surface.
- **Postgres + pgvector** — single primary store; vector + relational + TSVECTOR full-text in one place.
- **LiteLLM** — provider-agnostic LLM router with automatic fallback and unified Langfuse tracing.
- **ARQ on Redis** — lightweight background queue; same Redis already needed for rate-limiting and caching.
- **React 19 + Vite** — same toolchain in the widget and admin; the widget bundles its own React **and** mounts in a shadow root, so host-page styles are isolated in both directions.
- **Razorpay only** — UPI Autopay is the dominant rail in the launch market (India), and Razorpay's USD plans cover exports, so a second gateway would double the webhook, idempotency and invoicing surface for no new coverage.

## What this site is, and isn't

This site is the **living architecture reference** — diagrams, flows, state machines, capacity. It complements but does **not** replace:

- [`platform/docs/api-reference.md`](../../../api-reference.md) — endpoint contracts.
- [`platform/docs/runbooks/`](../../../runbooks/) — incident playbooks.
- [`platform/docs/graph-*.md`](../../../graph-architecture-map.md) — code-graph generated module maps.

When code lands that changes a diagram here, the merging engineer is expected to update the affected page. See the [README](https://github.com/digibranders/oye-chats-platform/blob/development/docs/system-design/README.md) for conventions.
