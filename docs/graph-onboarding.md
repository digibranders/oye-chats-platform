# OyeChats Developer Onboarding (Code Graph)

> ⚠️ **STALE SNAPSHOT — 2026-04-07. Read the shape, not the numbers.** This file was
> generated once and has not been regenerated since. Everything below describes a
> codebase roughly four months and several thousand tests behind `development`.
> Known-wrong at the time of writing (2026-08-31): crawling no longer uses Playwright or
> crawl4ai (it is HTTP-only via Jina Reader / Spider.cloud); the widget's production entry
> is `loader.js` + `app-entry.jsx`, not `main.jsx`; the admin dashboard is TypeScript under
> `app/src/features/**`, not `app/src/pages/*.jsx`; `models.py` declares 51 tables; and the
> test count is off by more than an order of magnitude. Use it to find *where* subsystems
> sit relative to each other, and verify anything specific against the source.


> Auto-generated from code-review-graph. Last updated: 2026-04-07.

## Key Entry Points

| Want to understand... | Start at | Related flows |
|-----------------------|----------|---------------|
| How chat works end-to-end | `api/app/api/chat_routes.py` -> `services/rag_service.py` | `chat_endpoint` (29 nodes) |
| How auth works | `api/app/api/auth.py` (3 schemes: client, bot, operator) | `login`, `register`, `operator_login` |
| How documents get ingested | `api/app/ingestion/pipeline.py` -> extraction -> chunking -> embedding | `run_web_ingestion` |
| How live chat works | `api/app/api/ws_routes.py` + `services/live_chat_service.py` | `connect_operator`, `connect_visitor`, `accept_chat` |
| How qualification works | `api/app/services/rag_service.py` (extraction) + `qualification_service.py` (frameworks) | `_background_bant_extraction`, `behavioral_signals_endpoint` |
| How webhooks work | `api/app/services/webhook_service.py` + `webhook_routes.py` | `behavioral_signals_endpoint`, `meeting_booked_endpoint` |
| How the widget renders | `widget/src/main.jsx` -> `components/ChatWindow.jsx` | N/A (frontend) |
| How admin pages work | `app/src/App.jsx` (router) -> `app/src/pages/*.jsx` | N/A (frontend) |
| Database schema | `api/app/db/models.py` (10 models) | All flows touch DB |

## Data Flow

```
Visitor (browser)
  |
  v
Widget (oyechats-widget.js)
  |-- REST (X-Bot-Key) --> /api/chat           --> rag_service --> llm_service --> stream response
  |-- REST (X-Bot-Key) --> /api/lead-info      --> repository --> lead_info table
  |-- REST (X-Bot-Key) --> /api/behavioral     --> rag_service --> qualification scoring
  |-- WS   (X-Bot-Key) --> /ws/chat/{id}       --> live_chat_service --> operator matching
  |
Admin (dashboard)
  |-- REST (X-API-Key) --> /api/bots           --> bot CRUD
  |-- REST (X-API-Key) --> /api/documents      --> ingestion pipeline
  |-- REST (X-API-Key) --> /api/sessions       --> chat history, analytics
  |-- REST (X-API-Key) --> /api/operators      --> team management
  |-- REST (X-API-Key) --> /api/webhooks       --> CRM integrations
  |
Operator (dashboard)
  |-- REST (X-Operator-Key) --> /api/operator/* --> operator auth, status
  |-- WS   (X-Operator-Key) --> /ws/operator/* --> live chat bidirectional
```

## Service Dependency Graph

```
chat_routes -----> rag_service -----> repository (DB)
     |                  |                  ^
     |                  v                  |
     |            llm_service              |
     |                  |                  |
     v                  v                  |
rag_service ----> qualification       models.py
     |            framework_service
     v
webhook_service --> external CRM

ws_routes ------> live_chat_service -> repository
     |                  |
     v                  v
email_service     operator matching

ingestion/pipeline --> extraction --> cleaner --> chunking --> embedder --> repository
```

## Auth Schemes (3 separate paths)

| Scheme | Header | Dependency | Used by |
|--------|--------|-----------|---------|
| Client | `X-API-Key` | `get_current_client()` | Admin dashboard |
| Bot | `X-Bot-Key` | `get_current_bot()` | Chat widget |
| Operator | `X-Operator-Key` | `get_current_operator()` | Operator panel |

## Testing Coverage

- 57 test functions across multiple test files
- 191 TESTED_BY edges linking functions to their tests
- Key test areas: auth, CORS, chat endpoints, password flows, demo scenarios
- Use `query_graph(pattern="tests_for", symbol="<function_name>")` to find tests for any function
