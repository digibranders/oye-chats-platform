# OyeChats Architecture Map (Code Graph)

> Auto-generated from code-review-graph. Last updated: 2026-04-07.
> Graph: 172 files, 1,154 nodes, 10,092 edges | 72 communities (size >= 5) | 248 execution flows

## Codebase Stats

| Metric | Value |
|--------|-------|
| Files | 172 |
| Functions | 848 |
| Classes | 77 |
| Tests | 57 |
| Languages | Python, JavaScript |

### Edge Breakdown

| Relationship | Count | Meaning |
|-------------|:-----:|---------|
| CALLS | 7,921 | Function-to-function invocations |
| CONTAINS | 1,113 | File/class member containment |
| IMPORTS_FROM | 809 | Cross-file imports |
| TESTED_BY | 191 | Function-to-test coverage links |
| INHERITS | 58 | Class inheritance |

## High-Level Architecture

```
Backend API (Python/FastAPI)     Admin Dashboard (JS/React)    Chat Widget (JS/React IIFE)
├── api/ routes & auth           ├── pages/ (20+ pages)        ├── components/ (chat UI)
├── services/ (operator, RAG,    ├── components/ (shared UI)   ├── icons/
│   SDR, webhooks, extraction)   ├── layouts/                  └── main.jsx (entry)
├── db/ (models, repository)     ├── superadmin/
├── ingestion/ (pipeline)        └── App.jsx (router)
├── core/ (middleware)
└── tests/
```

## Module Map (Communities, size >= 5)

| Module | Size | Cohesion | What it does |
|--------|:----:|:--------:|--------------|
| services-operator (x2) | 117 | 0.33/0.31 | Live chat -- operator matching, WebSocket, handoff, status |
| pages-handle (x7) | ~130 | 0.08-0.34 | Admin dashboard pages -- settings, support, insights, team |
| api-request | 34 | 0.10 | HTTP request handling, middleware, CORS |
| api-password | 29 | 0.13 | Auth flows -- login, register, password reset, OTP |
| components-handle (x5) | ~50 | 0.08-0.26 | Shared UI components across admin + widget |
| db-owner | 25 | 0.10 | SQLAlchemy models, ownership queries, repository |
| pages-dimension | 22 | 0.29 | Admin pages with responsive/dimension logic |
| services-url | 21+8 | 0.23/0.18 | URL crawling via Playwright + crawl4ai |
| api-bot | 19 | 0.19 | Bot CRUD, configuration, embed script |
| services-extraction | 19 | 0.13 | Document extraction (PDF, DOCX, TXT) |
| pages-handle (widget) | 19 | 0.26 | Widget page handlers |
| db-chat | 18 | 0.17 | Chat sessions, messages, audit logs |
| api-endpoint (x3) | 34 | 0.06-0.10 | Various API endpoint groups |
| tests-* (multiple) | ~70 | 0.11-0.52 | Test suites across API routes, auth, CORS |
| icons-icon | 16 | 0.83 | SVG icon components (highest cohesion) |
| services-send (x2) | 26 | 0.21/0.39 | Email/notification sending (Brevo) |
| api-webhook | 12 | 0.21 | Webhook delivery, retry logic, CRM templates |
| services-lead | 11 | 0.36 | Lead capture, behavioral scoring |
| services-framework | 9 | 0.23 | Custom qualification frameworks (BANT, MEDDIC) |
| services-sdr | 5 | 0.05 | SDR qualification service |
| superadmin-clients | 7 | 0.21 | Superadmin panel -- system stats, client management |

## Observations

1. **Operator/Live Chat is the largest subsystem** (117 nodes) -- most complex part of the codebase
2. **`chat_endpoint` flow touches 29 nodes** -- deepest execution path (RAG + LLM + BANT)
3. **Newest features** (qualification phases 1-6) are distinct communities: api-webhook, services-webhook, services-framework, services-lead, pages-analytics
4. **Test coverage**: 57 tests, 191 TESTED_BY edges across multiple communities
