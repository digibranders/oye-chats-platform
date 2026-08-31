# Plan — Visitor Journey Tracking (Pre + Post Chat)

Status: **SHIPPED** (verified against source 2026-08-31). Retained as the decision
record — §2 non-goals and §10 locked decisions are still the governing rationale — not
as a plan of work.
Owner: `platform/`
Touches: `widget/`, `api/`, `app/` (Analytics tab under Admin Platform 2.0)

> **As-built deltas from this plan.** The mechanism landed as designed; some names did not.
>
> | Plan says | Shipped as |
> |---|---|
> | `_MAX_JOURNEY_ENTRIES` 50 → 200 (§4.2) | `chat_routes.py:102` — `200` ✓ |
> | `_merge_journey`, append-with-dedup-tail (§4.3) | `chat_routes.py:1992` ✓ |
> | `phase` / `event` on entries (§4.1) | `_JOURNEY_PHASES = {"pre","chat","post"}`, `chat_routes.py:108` ✓ |
> | `markChatEvent`, `sendJourneyUpdate` (§5) | `widget/src/services/api.js:799`, `:839` ✓ |
> | `services/analytics_service.py` (§6) | `services/journey_analytics_service.py` |
> | `/analytics/journeys/*`, three endpoints (§6) | `/analytics/journey/*`, **five** endpoints — `analytics_routes.py:741-850` |
> | `journey_analytics` plan flag, read-side gate (§10.3) | `plan_entitlements_service.is_journey_analytics_enabled{,_for_bot}` ✓ |
> | Journeys view under Analytics (§7) | `app/src/features/analytics/JourneyPage.tsx` and siblings ✓ |
>
> Two corrections landed later and are **not** described below, because they are fixes to
> the shipped thing rather than parts of this plan: `a1cd992` gave the day-bucketing an
> explicit IANA `tz`, and `fdf6e9f` made the dashboard send the reader's zone. See
> [`timezone-handling.md`](timezone-handling.md) §4b.

---


## 1. Goal

Show bot owners **the full page journey a visitor took on their site** — before opening the chat, while chatting, and after closing the chat — and use those journeys to answer three business questions in a new **Journeys** view under Analytics:

1. Which content journeys lead to the most **demo bookings**, **live chat handoffs**, and **offline messages**?
2. Where do visitors go **after** interacting with the chat?
3. Which **pages** on the customer's site drive the most chat sessions and conversions?

## 2. Non-goals (explicit)

- No cross-device / cross-browser identity stitching.
- No per-visitor timeline drill-down in v1. Aggregates only. (Drill-down can come later once we see whether owners use the aggregate.)
- No customer-side JS API, no `oyechats.track(...)` call, no consent snippet. The widget uses the same `localStorage`-backed identity it already does.
- No new cookie banner UX. Storage footprint is unchanged from today.
- No signup-URL tracking. All three "conversions" (**demo booking**, **live chat handoff**, **offline message**) already fire inside code we own; we do not need customer-defined goal URLs.

## 3. Current state (verified in code)

**Widget** — pre-chat tracking already works:
- [`widget/src/services/api.js:482`](../widget/src/services/api.js) `_appendJourneyEntry(path)` deduplicates same-path bursts and caps the array at `JOURNEY_MAX_ENTRIES`.
- [`api.js:502`](../widget/src/services/api.js) `_installJourneyHooks()` monkey-patches `history.pushState` / `replaceState` and listens to `popstate`, so SPA route changes are captured without full reloads.
- [`api.js:533`](../widget/src/services/api.js) `recordPageVisit()` runs on widget load on **every page** the launcher renders on — so pre-chat browsing history is already collected.
- Chat session id lives in **`localStorage`** ([`storage-keys.js:92`](../widget/src/services/storage-keys.js)), so the same visitor across days / tabs reuses the same `chat_session`.

**Backend** — journey is stored but frozen:
- [`api/app/api/chat_routes.py:698`](../api/app/api/chat_routes.py) `POST /chat/behavioral-signals` receives the journey.
- **First non-empty journey wins** ([`chat_routes.py:727`](../api/app/api/chat_routes.py)): once `chat_sessions.visitor_journey` is populated, subsequent submissions are ignored. **This is the exact limitation that blocks post-chat tracking today.**
- `VisitorEvent` table ([`models.py:664`](../api/app/db/models.py)) already logs a `page_view` row per behavioral-signals call — but only for the *first* call in practice, because the widget only sends signals once at session init.
- `visitor_journey` snapshot copied onto `LeadInfo` at lead capture ([`chat_routes.py:659`](../api/app/api/chat_routes.py)) — gated by the `lead_source_attribution` plan feature.

**Admin** — Analytics 2.0:
- The new admin app is being rebuilt under the [`app/CLAUDE.md`](../app/CLAUDE.md) mandate. Analytics is one of the six top-level items (`Home · AI Agents · Inbox · Leads · Analytics · Workspace`). The Journeys view lives under **Analytics** as a new section, using the shared design system (Metric Card / Insight Card / Section Header / etc.).

## 4. Design decisions

### 4.1 One journey array per session, marked with a boundary

Extend the existing `chat_sessions.visitor_journey` (JSONB array). Each entry stays roughly the same shape but gets a phase marker:

```json
[
  { "path": "/pricing",  "ts": "2026-08-06T10:00:00Z", "phase": "pre"  },
  { "path": "/features", "ts": "2026-08-06T10:00:42Z", "phase": "pre"  },
  { "path": "/features", "ts": "2026-08-06T10:01:10Z", "phase": "chat", "event": "chat_opened" },
  { "path": "/features", "ts": "2026-08-06T10:04:00Z", "phase": "chat", "event": "handoff_requested" },
  { "path": "/thanks",   "ts": "2026-08-06T10:05:20Z", "phase": "post" }
]
```

Rationale:
- One column, one array — no schema migration for a new table, no join in the hot query path.
- The `phase` flag makes "post-chat pages" a trivial filter (`WHERE elem->>'phase' = 'post'`).
- Marker rows (`event`) let us anchor "chat_opened", "handoff_requested", "meeting_booked", "offline_message_sent", "chat_closed" against the surrounding page sequence without a second table.

### 4.2 Bump the entry cap, keep it bounded

Today: `_MAX_JOURNEY_ENTRIES = 50` ([`chat_routes.py:57`](../api/app/api/chat_routes.py)). Pre-chat + chat + post-chat can plausibly exceed 50 for a curious visitor over a multi-day localStorage-persistent session. Raise to **200**, keep the 500-char path cap. Reject rows past 200 by discarding the oldest **pre** entries first, so the chat-opened marker and post-chat sequence are preserved (they are the more valuable signal).

### 4.3 Backend endpoint change — append, not first-write-wins

Replace the "first non-empty journey wins" branch in `/chat/behavioral-signals` with an **append-with-dedup-tail** merge:

- New entries whose `path + phase` match the last stored entry are dropped (matches the widget's dedupe).
- New entries are appended in order.
- Trim from the head as needed to stay under 200.

Widget continues to POST the *full* journey it holds; server does the reconciliation. This keeps the widget dumb and idempotent.

### 4.4 Widget change — keep sending after chat opens

Today the widget POSTs behavioral-signals **once at session init**. Change to also POST:

- On chat **open** (add `event: "chat_opened"` marker to the journey).
- On chat **close** / minimize (add `event: "chat_closed"`).
- On each **conversion event** the widget already knows about: `handoff_requested`, `meeting_booked`, `offline_message_sent` (markers).
- On **page navigation while the widget is loaded**, throttled to **one POST per 10 seconds** and coalesced (send the whole updated journey, not a delta). This keeps request volume flat regardless of visitor click speed.
- On `pagehide` / `visibilitychange → hidden`, use `navigator.sendBeacon` for the final flush.

Rate-limit on the backend endpoint stays 30/min per bot key — coalesced sends fit inside that easily even for a very active visitor.

### 4.5 No new DB migration

Nothing in the schema changes. `visitor_journey` is already `JSONB`, so adding `phase` and `event` fields to array entries is a no-op on the DB side. The 200-entry cap is enforced in application code, not the schema.

### 4.6 Analytics reads

For the Journeys view, three server-side queries against `chat_sessions.visitor_journey`:

1. **Top pages** — flatten the JSONB, `GROUP BY path`, count distinct sessions per path. Split by phase.
2. **Paths to conversion** — for each session whose journey contains a conversion event (`meeting_booked` | `handoff_requested` | `offline_message_sent`), extract the ordered sequence of `pre`-phase paths up to that event. Group identical sequences, count sessions per sequence, rank top N per conversion type.
3. **Post-chat destinations** — for each session, the ordered `post`-phase paths; aggregate top first-hops and top full sequences.

All three are read-only, scoped by `bot_id` and a date range. No pre-aggregation table needed at current volume; add a materialized view later if per-request latency becomes a problem.

## 5. Widget changes (concrete)

Files to touch (all in `widget/src/`):
- `services/api.js` — extend `_appendJourneyEntry` to accept `{path, phase, event}`; add `sendJourneyUpdate(sessionId)` with 10s throttle and `sendBeacon` fallback; export a `markChatEvent(name)` helper that appends a marker and triggers a flush.
- `components/ChatWidget.jsx` — call `markChatEvent('chat_opened')` on first open per session; `markChatEvent('chat_closed')` on close/minimize.
- `components/LiveChatMode.jsx` — call `markChatEvent('handoff_requested')` when the visitor submits the handoff form.
- `components/MeetingBooking.jsx` — call `markChatEvent('meeting_booked')` on booking confirmation postMessage.
- `components/OfflineMessage.jsx` (or wherever offline form submits) — `markChatEvent('offline_message_sent')`.

No behavior change for visitors. Widget stays a self-contained IIFE.

## 6. Backend changes (concrete)

Files to touch (all in `api/app/`):
- `api/chat_routes.py`
  - `_sanitize_journey`: accept optional `phase` and `event` fields, whitelist their values.
  - Raise `_MAX_JOURNEY_ENTRIES` from 50 → 200.
  - Replace the first-write-wins branch with `_merge_journey(existing, incoming)` that dedupes the tail and trims pre-phase entries from the head when over cap.
- `services/analytics_service.py` (new file) — three query helpers:
  - `top_pages(bot_id, since, until, phase=None)`
  - `paths_to_conversion(bot_id, conversion_type, since, until, limit=10)`
  - `post_chat_destinations(bot_id, since, until, limit=10)`
- `api/analytics_routes.py` (new file) — three GET endpoints under `/analytics/journeys/*`, auth via `get_current_client_or_operator`, scoped by `bot_id` query param.
- `api/main.py` — mount the new router.
- Tests in `tests/api/test_analytics_routes.py` covering: empty bot, single session, conversion attribution, phase filtering, date range.

**No Alembic migration.** JSONB is flexible; new fields on array elements are additive.

## 7. Admin UI (concrete, aligned with Admin Platform 2.0)

Under **Analytics** in the new sidebar, add a **Journeys** view with three sections, using existing shared components (`SectionHeader`, `MetricCard`, `InsightCard`):

- **Top pages** — table + sparkline of visits over the range, split tabs for `Before chat` / `While chatting` / `After chat`.
- **Paths that convert** — three stacked cards, one per conversion type. Each shows the top 5 pre-chat page sequences as `/foo → /bar → /baz  ·  32 sessions  ·  18% conv rate`.
- **After chat** — ranked list of first-hop destinations after chat close, plus a "top full sequences" collapse.

Date-range picker at the top (default: last 30 days). Empty state copy: "Your visitors' journeys will appear here once they start using the chat."

**Do not** add a per-visitor timeline drill-down in v1. If a bot owner asks, add later.

## 8. Rollout

1. Land widget + backend changes together on `development`.
2. Bump widget version, build, deploy `oyechats-widget.js` to CDN — old cached widgets keep working (they just don't send post-chat updates; backend accepts their smaller payloads fine because the merge is additive).
3. Ship the Journeys view behind no flag — it works instantly on all existing sessions since `visitor_journey` was already being populated pre-chat.
4. Post-chat data starts flowing only from sessions where the visitor loads a post-upgrade widget. No backfill needed or possible.

## 9. Effort estimate

| Area | Estimate |
|---|---|
| Widget (throttled sender + event markers) | ~1 day |
| Backend (merge logic, 3 query helpers, 3 routes, tests) | ~2 days |
| Admin UI (Journeys view + 3 sections) | ~2 days |
| End-to-end QA on a real embed | ~0.5 day |
| **Total** | **~5.5 days** |

## 10. Decisions (locked)

1. **Conversion set for path attribution**: `meeting_booked`, `handoff_requested`, `offline_message_sent`. **`lead_captured` is a header-metric only** — shown as a top-line stat alongside the three, but NOT included in "paths that convert" attribution (would double-count visitors who both book a demo and submit their email via the same form).
2. **Retention**: unchanged — `visitor_journey` lives as long as the parent `chat_sessions` row does. Existing session retention policy applies.
3. **Plan gating**: **paid tiers only**, gated by a new feature flag `journey_analytics` on the plan (parallel to the existing `lead_source_attribution`). Free / Starter clients see an upgrade prompt in the Journeys view. Widget still sends the data regardless of plan (so an upgrade shows immediate history); the gate is on the *read* side only.
4. **Path normalization**: deferred to v2. v1 shows raw paths as-is.
