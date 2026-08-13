# OyeChats Feature — Live Chat Handoff & Routing

*This document is self-sufficient as the sole NotebookLM knowledge source on this one feature. Evidence tags: [T1] = confirmed directly in code, [T2] = confirmed in project documentation (`CLAUDE.md`), [T3] = positioned/marketing framing, [VERIFY] = flagged, not fully confirmed.*

---

## 1. What This Feature Is

Live Chat Handoff is the mechanism by which a conversation that started with the AI agent gets handed to a real human on the business's team — with full context, no cold start — when the visitor needs it. It bundles four things that work together as one feature: **handoff & state transitions**, **queueing & routing** (getting the visitor to the right, available operator), **canned responses** (fast, consistent replies for operators), and **offline messaging** (a graceful fallback when no one is available). [T1]

This is not a separate "support ticket" system bolted onto the chatbot — it's the same conversation thread, the same session, just changing who's answering. [T1 — `session_state_machine.py`]

## 2. Who Cares & Why

- **Business owner / CEO / CMO** — the AI shouldn't be a wall between a ready buyer and a sale. When a visitor needs a human — a pricing negotiation, a trust question, a complex edge case — the system routes them to a real teammate automatically, without the visitor having to leave the chat, re-explain themselves, or find a "contact us" form. [T3]
- **Operator (the team member answering chats)** — receives chats already carrying the visitor's conversation history, qualification signals, and journey — never starts cold. [T1 — `session_state_machine.py` audit log + full ChatSession context]
- **Visitor** — never notices a "system switch." They keep typing in the same window; the response quality and speed of routing is the only thing that changes. [T3]

## 3. How It Actually Works

### 3.1 The state machine
Every chat session has exactly one status at a time, enforced by an explicit, code-level state machine (`session_state_machine.py`) — not ad-hoc flags: [T1]

```
bot     → waiting   (visitor requests handoff)
waiting → live      (operator accepts)
waiting → bot       (visitor cancels, timeout, or no operators available)
waiting → closed    (visitor leaves while waiting)
live    → bot       (operator closes chat, returns to AI)
live    → closed    (visitor ends live chat)
live    → waiting   (chat transferred to another operator or department)
closed  → (terminal — no further transitions)
```

Transitions are atomic (row-locked, compare-and-swap style) and every transition writes an immutable audit log entry (`ChatAuditLog`) — who did it, when, and why. This is what "full context, never starts cold" means concretely: the operator's view is built from this same persisted history, not a fresh ticket. [T1]

### 3.2 Availability — what happens the instant a visitor asks for a human
Before anything routes, an availability resolver computes one of seven states in real time: `available`, `no_operators`, `out_of_hours`, `all_offline`, `all_busy`, `queue_full`, `feature_disabled`. Each maps to one of three visitor-facing actions: **route** (send straight to an operator), **wait** (show the queue, with progressive messaging), or **offline_form** (show the offline-message form). [T1 — `live_chat_availability_service.py`]

Business hours can be set per-department (Sales 9–6, Support 24/7, etc.) as well as per-bot; a bot with no department configured falls back to bot-level hours, and no hours configured at all means 24/7. Availability is cached (Redis) and invalidated the moment queue size, operator presence, or hours change. [T1]

### 3.3 Queueing
If no operator is free, the visitor enters a **FIFO queue** — persisted in Postgres (not just Redis) specifically so a Redis blip or restart never silently drops a waiting visitor. Redis is used only as a fast "is this session already queued" index; Postgres is the source of truth. Position is computed live (not a stored counter) so it stays correct even as people join and leave mid-queue. [T1 — `live_chat_queue_service.py`]

Visitors can time out of the queue (configurable per bot), abandon (close the widget), or get dequeued the instant an operator frees up.

### 3.4 Routing — who actually gets the chat
When an operator becomes available, one of three routing strategies (configurable per bot) decides who receives the next chat: [T1 — `live_chat_routing_service.py`]

- **`least_busy`** (default) — the operator with the fewest active chats right now; ties broken by round-robin so load stays evenly spread.
- **`round_robin`** — strict rotation regardless of current load, for predictable fairness.
- **`first_available`** — simplest option, mainly for single-operator workspaces.

**Department-aware automatic routing is not live yet.** The data model fully supports departments (see below), and the code comment explicitly documents this as a deliberate v2 scope decision — auto-routing today is single-pool across all online operators for a bot, not filtered by department. [T1 — code comment, `live_chat_routing_service.py`: *"The spec ships single-pool routing first. Department-aware routing is a v2 feature... The current code path doesn't filter by department but the data model supports it."*]

### 3.5 Departments — what does exist today
Departments are a real, implemented data grouping for operators (`Department` model, [T2 — root `CLAUDE.md`: *"Department — Operator grouping"*]) used for two things right now:
1. **Per-department business hours** (Sales open 9–6, Support open 24/7) — live in the availability resolver. [T1]
2. **Manual transfer to a department** — an operator can hand an active chat to *either another operator or a department* via a Transfer dialog in the dashboard. [T1 — `app/src/features/inbox/TransferDialog.tsx`: offers both `{kind: 'operator'}` and `{kind: 'department'}` targets]

So: departments exist and are usable today for manual routing and scheduling — what's *not* built yet is the AI automatically picking a department at first-contact (e.g., a pre-chat "Sales or Support?" picker driving automatic routing). Keep this distinction precise: **don't say "route to the right department automatically" — that's the v2 feature, not what ships today.**

### 3.6 Multi-device operator alerts
Operators can be logged in on multiple devices (laptop, desktop, phone) at once. When a chat needs attention, a push notification (Web Push/VAPID) fires to *every* subscribed device simultaneously — whichever the operator clicks first wins, via a race-safe accept lock — and the other devices' notifications update in place to "Claimed by [operator]" instead of staying stale. [T1 — `push_service.py`]

### 3.7 Canned responses
Operators can save reusable quick replies (`CannedResponse`: title, content, an optional `/shortcut` trigger, and a category) shared across the whole workspace team, not per-operator — since the whole team answers from the same shared pool during live chat. [T1 — `canned_response_routes.py`]

### 3.8 Offline messaging
When availability resolves to "no one's available" (out of hours, all offline, or queue full), the visitor sees a form instead of a queue: name, email, phone (optional), message, and — if department routing is in play — a department selector. Submitting it: [T1 — `offline_message_routes.py`]
- Stores an `OfflineMessage` row tied to the bot (and session, if one exists).
- Sends the team a notification email (multiple recipients supported).
- Sends the visitor a confirmation email.
This is explicitly the graceful fallback — the visitor is never left with a dead end, just a delayed one.

## 4. What It Looks Like

- **Admin side (dashboard "Inbox")**: a live conversation list, a conversation detail/thread view, a session-details side panel (visitor info, journey, qualification signals), a Transfer dialog (operator-or-department picker), a Canned Responses panel, and an Offline Messages panel — all wired to a persistent operator WebSocket connection with its own status indicator. [T1 — `app/src/features/inbox/` file set: `InboxPage.tsx`, `ConversationView.tsx`, `SessionDetailsPanel.tsx`, `TransferDialog.tsx`, `CannedResponsesPanel.tsx`, `OfflineMessagesPanel.tsx`, `useOperatorSocket.ts`, `useOperatorStatus.ts`]
- **Widget side (visitor view)**: the same chat window the AI was answering in seamlessly continues — a queue-position indicator appears if waiting, then messages start arriving from a human instead of the AI, with no visible "reload" or "new window." [T1 — `widget/src/components/LiveChatMode.jsx`]
- **The handoff moment itself** has no special visual fanfare in the product today — it's a status change, not a modal or interstitial. [T1]

## 5. A Real Scenario Walkthrough

**Scenario A — daytime, operator available:**
1. A visitor has been chatting with the AI agent; the conversation reaches a point where they ask for a human (or the AI itself flags it — see the Qualification feature doc for the trigger logic).
2. Session transitions `bot → waiting`. Availability resolves to `available`.
3. Routing selects an operator (say, `least_busy`) instantly — no queue.
4. That operator's dashboard (and every device they're logged into) gets a push notification with the visitor's full context: what they asked the AI, their qualification signal, their page journey.
5. Operator accepts (first device to click wins the race-safe lock). Session transitions `waiting → live`. The operator replies — possibly using a canned response for a common question — in the same window the visitor has been in the whole time.
6. Operator resolves the chat; transitions `live → closed`, or `live → bot` if they want the AI to keep handling the tail end.

**Scenario B — after hours, no one online:**
1. Visitor asks for a human at 11pm. Availability resolves to `out_of_hours` (or `all_offline`, depending on which check fails).
2. Instead of a queue, the visitor sees the offline-message form. They leave their name, email, and message.
3. The team gets a notification email; the visitor gets a confirmation email. Nothing is lost — it's a queryable `OfflineMessage` record waiting in the dashboard's Inbox for the morning.

## 6. Capabilities vs. Limits

**What it does:**
- Enforces valid state transitions with a full audit trail (never a silently corrupted session status).
- Queues visitors durably in Postgres — survives restarts, doesn't rely on Redis alone.
- Routes by three configurable strategies, evenly or fairly distributing load.
- Alerts every operator device at once, resolves races safely.
- Falls back gracefully to an offline form with dual (team + visitor) email confirmation when no one's available.
- Supports manual transfer to another operator *or* a department mid-conversation.

**What it does not do (yet):**
- **No automatic department-based routing at first contact** — this is explicitly a documented v2 feature, not live. [T1]
- No admin-facing "average wait time" queue analytics UI was confirmed in this pass — the queue service notes this as a `v2` intention (*"gives the admin a queryable history for the 'who waited how long' admin analytics in v2"*) [T1 — code comment; treat current-state analytics claims as **[VERIFY]**].
- The handoff has no dedicated "transfer moment" UI beyond the Transfer dialog.

**Critical framing point:** the AI never replaces the person — it hands off to a human who then closes the conversation; the AI qualifies and first-responds, a person on the business's team still does the closing.

## 7. Evidence & Open [VERIFY] Items

| Claim | Evidence | Confidence |
|---|---|---|
| State machine transitions, audit logging | `api/app/services/session_state_machine.py` | [T1] |
| Availability states + visitor actions | `api/app/services/live_chat_availability_service.py` | [T1] |
| Postgres-backed FIFO queue | `api/app/services/live_chat_queue_service.py` | [T1] |
| Three routing strategies | `api/app/services/live_chat_routing_service.py` | [T1] |
| Department routing is NOT automatic yet (v2) | Code comment in `live_chat_routing_service.py` | [T1] |
| Manual transfer to operator OR department exists today | `app/src/features/inbox/TransferDialog.tsx` | [T1] |
| Per-department business hours | `live_chat_availability_service.py` | [T1] |
| Multi-device push, race-safe accept | `api/app/services/push_service.py` | [T1] |
| Canned responses, shared across team | `api/app/api/canned_response_routes.py` | [T1] |
| Offline messaging + dual email confirmation | `api/app/api/offline_message_routes.py` | [T1] |
| Admin queue-wait-time analytics ("who waited how long") | Code comment says "v2" — **not confirmed as shipped** | [VERIFY] |
| Exact current Inbox page visual layout/polish | Inferred from file names in `app/src/features/inbox/`, not a live screenshot | [VERIFY] |

**Do not claim:** automatic department routing, a dedicated "handoff animation" in the real product, or queue-wait analytics as a current admin feature — all three are either v2-scoped or unconfirmed.
