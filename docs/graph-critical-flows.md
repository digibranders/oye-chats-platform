# OyeChats Critical Execution Flows (Code Graph)

> Auto-generated from code-review-graph. Last updated: 2026-04-07.
> 248 total flows detected. Top 20 by criticality shown below.

## Top 20 Critical Flows

| # | Flow | Criticality | Nodes | Category |
|:-:|------|:-----------:|:-----:|----------|
| 1 | `behavioral_signals_endpoint` | **0.845** | 4 | Lead Qualification |
| 2 | `chat_sdr_endpoint` | **0.791** | 9 | Lead Qualification |
| 3 | `meeting_booked_endpoint` | **0.783** | 4 | Meeting Booking |
| 4 | `operator_login` | **0.780** | 10 | Auth |
| 5 | `connect_operator` | **0.780** | 14 | Live Chat |
| 6 | `register` | **0.773** | 4 | Auth |
| 7 | `create_client` | **0.773** | 4 | Auth |
| 8 | `generate_sdr_stream` | **0.770** | 10 | Lead Qualification |
| 9 | `login` | **0.760** | 3 | Auth |
| 10 | `reset_password` | **0.760** | 3 | Auth |
| 11 | `operator_change_password` | **0.760** | 4 | Auth |
| 12 | `get_session_details` | **0.760** | 3 | Chat |
| 13 | `visitor_websocket` | **0.748** | 7 | Live Chat |
| 14 | `_background_bant_extraction` | **0.741** | 14 | Lead Qualification |
| 15 | `legacy_agent_websocket` | **0.740** | 12 | Live Chat (Legacy) |
| 16 | `connect_visitor` | **0.735** | 19 | Live Chat |
| 17 | `disconnect_operator_and_broadcast` | **0.735** | 16 | Live Chat |
| 18 | `accept_chat` | **0.735** | 15 | Live Chat |
| 19 | `chat_endpoint` | **0.733** | 29 | RAG Chat (Core) |
| 20 | `run_web_ingestion` | **0.730** | 10 | Ingestion |

## Flow Categories

### Core Product (RAG Chat)
- **`chat_endpoint`** (0.733, 29 nodes) -- The main product flow:
  `User question -> X-Bot-Key auth -> hybrid search (vector + keyword) -> context build -> LiteLLM streaming -> BANT extraction (background) -> streamed response`
- Largest flow by node count. Touches: auth, rag_service, llm_service, repository, sdr_service

### Lead Qualification (Newest)
- **`behavioral_signals_endpoint`** (0.845) -- Highest criticality. Captures visitor behavior for scoring.
- **`chat_sdr_endpoint`** (0.791) -- Runs BANT/custom framework scoring on chat sessions.
- **`generate_sdr_stream`** (0.770) -- Streaming SDR qualification responses.
- **`_background_bant_extraction`** (0.741, 14 nodes) -- Background task extracting BANT signals from conversations.
- **`meeting_booked_endpoint`** (0.783) -- Confirms meeting bookings from qualified leads.

### Live Chat (Largest Subsystem)
- **`connect_operator`** (0.780, 14 nodes) -- Operator joins via WebSocket.
- **`connect_visitor`** (0.735, 19 nodes) -- Visitor WebSocket handshake + queue assignment.
- **`accept_chat`** (0.735, 15 nodes) -- Operator accepts a waiting chat.
- **`disconnect_operator_and_broadcast`** (0.735, 16 nodes) -- Operator disconnect + reassignment.
- **`visitor_websocket`** (0.748) -- Visitor-side WebSocket connection.

### Auth
- **`operator_login`** (0.780, 10 nodes) -- Operator-specific auth (separate from client auth).
- **`register`** / **`create_client`** (0.773) -- Client signup.
- **`login`** / **`reset_password`** (0.760) -- Standard client auth.

### Ingestion
- **`run_web_ingestion`** (0.730, 10 nodes) -- URL crawl -> extract -> chunk -> embed -> store.

## Impact Zones

When modifying code, check which flows are affected:

| If you touch... | Likely affected flows |
|-----------------|----------------------|
| `auth.py` | ALL flows (every endpoint uses auth) |
| `rag_service.py` | `chat_endpoint`, `generate_sdr_stream` |
| `llm_service.py` | `chat_endpoint`, `generate_sdr_stream`, `_background_bant_extraction` |
| `live_chat_service.py` | `connect_operator`, `connect_visitor`, `accept_chat`, `disconnect_*` |
| `repository.py` | Nearly all flows (DB access layer) |
| `sdr_service.py` | `chat_sdr_endpoint`, `_background_bant_extraction`, `behavioral_signals_endpoint` |
| `ws_routes.py` | All WebSocket flows (visitor, operator, legacy) |
| `pipeline.py` | `run_web_ingestion` |
| `webhook_service.py` | `behavioral_signals_endpoint`, `meeting_booked_endpoint` |
