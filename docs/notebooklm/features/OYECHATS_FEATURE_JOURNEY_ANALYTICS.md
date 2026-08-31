# OyeChats Feature: Visitor Journey Analytics

*Self-sufficient NotebookLM knowledge source on a single OyeChats feature. Evidence tags: [T1] = confirmed in code, [T2] = confirmed in product docs, [T3] = marketing positioning, [VERIFY] = unconfirmed, needs human check.*

---

## 1. What This Feature Is

A normal chatbot only remembers the conversation itself — what the visitor typed and what the AI answered. OyeChats does something more: it captures the **page-view trail** a visitor took on the business's own website **before, during, and after** they chat — and it does this whether or not the visitor ever opens the chat at all [T1, `api/app/api/chat_routes.py`].

This is two tightly linked pieces:
- **Capture** — the widget silently records the path (URL path, not full URL) of every page the visitor views, tags each entry with a phase (`pre` / `chat` / `post`) and, where relevant, a named event (`chat_opened`, `chat_closed`, `handoff_requested`, `meeting_booked`, `offline_message_sent`, `lead_captured`), and periodically posts the running list to the backend, which sanitizes, merges, and stores it as `ChatSession.visitor_journey` (JSONB) [T1, `api/app/api/chat_routes.py`, `api/app/db/models.py`].
- **Analysis** — a dedicated "Journey" analytics view aggregates these stored journeys per bot into ranked page lists, pre-chat path sequences that preceded a conversion, and post-chat destinations [T1, `api/app/services/journey_analytics_service.py`].

A closely related but separate mechanism — **behavioral scoring** — turns some of the same raw signals (return visit, UTM presence, time on page, pages viewed, referrer) into points that feed a visitor's BANT/qualification score, not the Journey view itself [T1, `api/app/services/behavioral_service.py`].

## 2. Who Cares & Why

- **Marketing / growth lead** — wants to know which pages on the site actually lead to a conversation, and where a paid campaign (UTM-tagged) sends people once they land. Journey analytics is explicitly the tool built for this — the master knowledge doc calls it "the most distinctive view" among the platform's analytics surfaces [T2, `docs/notebooklm/marketing/OYECHATS_MASTER_KNOWLEDGE.md` §6.6].
- **Business owner / sales lead** — wants to see what a visitor did right before and right after talking to the AI: did they bounce, did they head to pricing, did they book a meeting.
- **Operator picking up a handoff** — inherits the visitor's journey alongside the transcript, so a human isn't starting cold; this is part of the platform's broader "hand the human a warm lead" design [T2, `OYECHATS_MASTER_KNOWLEDGE.md` §10].
- **Visitor** — never sees this directly; it's entirely a business-side analytics capability.

## 3. How It Actually Works

**What is captured** [T1, `api/app/api/chat_routes.py`, `api/app/db/models.py`]
- Each journey entry is a small dict: `{"path": "/pricing", "ts": "2026-07-09T12:00:15Z", "phase": "pre"|"chat"|"post", "event": "..."}` [T1, code comment in `chat_routes.py`: `"[{"path": "/services", "ts": "2026-07-09T12:00:15Z", "phase": "pre", "event": "chat_opened"}, ...]"`].
- `path` is the only required field — a same-origin path string, capped at 500 characters.
- `phase` is one of exactly three whitelisted values: `pre` (before the chat opened), `chat` (during the conversation), `post` (after chat closed). Anything outside this whitelist is silently dropped server-side — never trusted from the widget as-is [T1].
- `event` is one of six whitelisted markers: `chat_opened`, `chat_closed`, `handoff_requested`, `meeting_booked`, `offline_message_sent`, `lead_captured` — again, anything else is dropped [T1].
- The array is capped at 200 entries per session; when trimming is needed, the oldest `pre`-phase entries are dropped first so the `chat`/`post` markers (the parts that matter most for outcome analysis) survive [T1, `_trim_journey` in `chat_routes.py`].
- The widget sends its **full current journey** on every update (not a delta); the backend merges defensively against existing stored data (deduped by path+phase+event+timestamp) so a widget that lost its local state (private tab, cleared storage, cross-device return) can never silently overwrite prior history with a shorter list [T1, `_merge_journey`].

**Separate but adjacent: `VisitorEvent` and `BotGrowthEvent`** [T1, `api/app/db/models.py`, root `CLAUDE.md`]
- `VisitorEvent` is a per-session behavioral-signal log (`event_type`: `page_view`|`return_visit`|`utm_captured`|`time_on_site`, plus a JSONB `event_data` payload) — a lower-level event stream distinct from the curated `visitor_journey` array on the session itself.
- `BotGrowthEvent` is unrelated to visitor journeys — it's a per-bot business/growth event log (e.g., demo-link distribution), not part of this feature [T1, `api/app/db/models.py` class comment: "Minimal growth event log for tracking public demo-link distribution"].
- `ChatSession` also independently stores `page_url`, `referrer`, and `utm_params` as their own columns (the visitor's landing context), plus a `visit_count` integer and a `behavioral_score` — these feed the qualification/BANT score, not the Journey aggregation view [T1, `api/app/db/models.py`].

**How raw journeys become the analytics numbers customers see** [T1, `api/app/services/journey_analytics_service.py`]
The `visitor_journey` JSONB column is read directly and aggregated in Python (not SQL) per bot, scoped to a date window:
- **`top_pages`** — ranks pages by how many distinct sessions visited them, optionally filtered to one phase (e.g., "top pages visited *before* chat").
- **`paths_to_conversion`** — for a chosen conversion event (`meeting_booked`, `handoff_requested`, or `offline_message_sent` — a fixed whitelist called `CONVERSION_EVENTS`), returns the top pre-chat page *sequences* that preceded that outcome, with a session count and conversion rate per sequence. `lead_captured` is deliberately excluded from this attribution because it double-counts against handoff/demo forms that also collect email — it's surfaced only as a separate header metric.
- **`post_chat_destinations`** — where visitors go after the chat closes: the first page they land on post-chat, every distinct page touched post-chat, and the top full post-chat path sequences.
- **`top_pre_chat_sequences`** — across *all* sessions (converted or not), the most common pre-chat browsing patterns, each paired with its most common continuation after chat — this is what powers the visual flow diagram.
- **`summary_counts`** — header totals: sessions with a recorded journey, count per conversion event, sessions that browsed post-chat without converting, sessions with no activity at all (drop-off), and leads captured.
- Long or noisy paths are truncated from the head (not the tail) so that, e.g., `/a/b/c/d` and `/x/b/c/d` are still recognized as the same underlying `/b/c/d` pattern rather than fragmenting the counts [T1].

**Plan gating** [T1, `api/app/services/plan_entitlements_service.py`, `app/src/features/analytics/JourneyPage.tsx`]
- The Journey analytics *view* is gated to `trial`, `standard`, `professional` and `enterprise` (`JOURNEY_ANALYTICS_SLUGS`, `plan_entitlements_service.py:427`). Below that — Free and Starter — the frontend shows a full-page "locked feature" upgrade card instead of the charts. (An earlier revision of this doc quoted the set as `{standard, professional}`; the trial and Enterprise tiers were added to it later.)
- Data collection itself is **not** gated — the code comment on the frontend page states collection "still runs on those plans, so an upgrade surfaces prior history immediately" [T1, `JourneyPage.tsx` docstring] — meaning a customer who upgrades doesn't lose the journey history that accumulated while they were on a lower tier.

## 4. What It Looks Like

Confirmed frontend surface: a **top-level "Journey" page at `/journey`** (`app/src/features/analytics/JourneyPage.tsx`), scoped to one selected chatbot. The component names below are taken from that page's own import list, replacing four names an earlier revision of this document inferred from an older branch and which do not exist in the shipped tree [T1, `JourneyPage.tsx:28-31`]:
- **`JourneyFlow`** — the accessible list view of the same journey data; always available, and the fallback if anything about the diagram regresses.
- **`JourneyDiagram`** — the Sankey-style flow diagram, offered as a **view toggle** beside the list rather than replacing it: source pages on the left (bucketed into a small fixed set of labeled slots so the layout stays stable as a business's URLs change), a central "opened chat" node, outcome destinations on the right, curve thickness scaling with visitor volume.
- **`JourneyPagesPanel`** — the ranked page panel over the `top_pages` aggregation. *(Previously guessed at as `PageInfluence`.)*
- **`JourneyOutcomesDonut`** — the outcomes donut over conversion/outcome counts, shipped with a real text alternative rather than an `aria-hidden` SVG. *(Previously guessed at as `JourneyOutcomes`.)*
- `FunnelPanel.tsx` also exists in the same directory. *(There is no `LeadJourneyFunnel.tsx`; that name was inferred, not observed.)*

> **Note on IA — resolved.** Journey is **not** folded into an agent's Analytics tab. It is its own top-level rail item and its own route, `/journey`, sitting between Leads and Analytics [T1, `app/src/shell/nav.ts:78`]. `nav.ts`'s own comment records why: *"Journey ... moved back out to its own top-level route."* The `app/CLAUDE.md` mandate that folds it into Analytics is forward intent, not a description of the build.

## 5. A Real Scenario Walkthrough

A visitor clicks a retargeting ad and lands on a SaaS company's pricing page.

1. **Pre-chat browsing.** The widget records `{"path": "/pricing", "phase": "pre"}`, then the visitor clicks through to `/pricing/enterprise`, then to `/case-studies` — each a `pre`-phase entry appended to the running journey.
2. **The visitor leaves without chatting.** No conversation happens yet; nothing about this visit becomes a lead, but if the widget already has a session record, the pre-chat browsing accumulates against that session for whenever a conversation eventually starts.
3. **Days later, the same visitor returns** via a retargeting ad (a UTM-tagged link) and opens the chat this time. The journey entry `{"path": "/pricing", "phase": "chat", "event": "chat_opened"}` marks the moment the chat itself opened, embedded inline in the same ordered path history.
4. **They ask a pricing question, get an answer, and ask to talk to a human** — the widget appends `{"event": "handoff_requested", ...}` at its position in the timeline.
5. **After the handoff conversation ends, they browse to `/contact` and then `/book-a-demo`**, tagged `phase: "post"`.
6. **On the admin side**, this single session's journey now reads as one continuous record: pre-chat pages → chat-open marker → handoff event → post-chat pages — exactly what `journey_analytics_service.py`'s aggregations are built to summarize across many sessions: which pre-chat pages most often precede a handoff request, and what visitors do immediately after.

*(This walkthrough illustrates the mechanics only — no conversion-rate, "X% more leads," or revenue figure exists in any inspected source, and none is implied here.)*

## 6. Capabilities vs Limits

**Confirmed capable of:**
- Recording page-path browsing before, during, and after a chat, on a single browser/device session, tied to the same `ChatSession` record [T1].
- Tagging specific business-relevant moments (chat opened/closed, handoff requested, meeting booked, offline message sent, lead captured) inline in the same ordered timeline as page views [T1].
- Aggregating that data per bot into top pages, pre-chat sequences that precede a specific conversion event, post-chat destinations, and header summary counts [T1].
- Defensively merging repeated widget payloads without losing history, and bounding array size without discarding the moments (chat/post markers) that matter most [T1].
- Preserving journey history across a plan upgrade — collection isn't gated, only the *view* is [T1].

**Known limits / not claimed:**
- **No cross-device tracking.** Nothing in the inspected code associates journeys across two different browsers or devices for the "same" human visitor — the journey is scoped to whatever session/local-state the widget tracks on one browser [VERIFY: absence-of-evidence, not an explicit code comment ruling it out, but no session-linking-by-identity mechanism was found].
- **No off-site behavior.** Only paths on the business's own site (wherever the widget is embedded) are captured — there is no signal about what a visitor did on other websites, search engines, or social platforms beyond the `referrer`/UTM params captured at landing.
- **Only path strings, not full page content or scroll/click behavior.** The journey records *which* pages were visited and in what order/phase — not time spent per page (that's a separate `time_on_page` signal feeding behavioral scoring, not stored per-entry in the journey array), not click-level interaction, not scroll depth.
- **Full URLs are not stored** — only the path, capped at 500 characters; query strings beyond what's embedded in the path are not explicitly called out as preserved or stripped in the inspected sanitizer [VERIFY: confirm whether `?utm_source=...` query strings survive into `path` or are stripped before reaching the widget's payload].
- **Conversion attribution is restricted to a fixed whitelist** of three events (`meeting_booked`, `handoff_requested`, `offline_message_sent`) — a business cannot currently define a custom conversion event for this specific path-sequence analysis [T1].
- **No claim of deterministic, guaranteed capture** — like all client-recorded telemetry, this depends on the widget script executing successfully in the visitor's browser (ad blockers, JS-disabled browsers, or a widget load failure would produce a session with no journey data) [VERIFY: no explicit code-level fallback/retry behavior for a failed journey POST was inspected in this pass].

## 7. Evidence & Open [VERIFY] Items

- Core capture mechanics (journey entry shape, phase/event whitelists, size caps, trim/merge behavior) are [T1] — confirmed directly in `api/app/api/chat_routes.py` (`_sanitize_journey`, `_trim_journey`, `_merge_journey`, `_JOURNEY_PHASES`, `_JOURNEY_EVENTS`, `_MAX_JOURNEY_ENTRIES`).
- Storage model (`ChatSession.visitor_journey` JSONB, `VisitorEvent`, `BotGrowthEvent`) confirmed [T1] in `api/app/db/models.py` and cross-checked against root `CLAUDE.md`'s DB schema section.
- Aggregation logic (`top_pages`, `paths_to_conversion`, `post_chat_destinations`, `top_pre_chat_sequences`, `summary_counts`) is [T1], confirmed directly in `api/app/services/journey_analytics_service.py`.
- Behavioral scoring (return visit, UTM, time on page, pages viewed, referrer → points feeding BANT) is [T1], confirmed in `api/app/services/behavioral_service.py` — noted here as an adjacent but distinct mechanism from the Journey *view* itself; do not conflate the two in a script (one is a qualification-score input, the other is a visibility/analytics surface).
- Plan gating (`JOURNEY_ANALYTICS_SLUGS = {"trial", "standard", "professional", "enterprise"}`) confirmed [T1] at `api/app/services/plan_entitlements_service.py:427`; frontend enforcement confirmed [T1] in `app/src/features/analytics/JourneyPage.tsx`.
- **[VERIFY] — closed.** The four component names this document previously carried (`UserJourneyFlow`, `PageInfluence`, `JourneyOutcomes`, `LeadJourneyFunnel`) do not exist in `app/src/features/analytics/`. The shipped page imports `JourneyFlow`, `JourneyDiagram`, `JourneyOutcomesDonut` and `JourneyPagesPanel` (`JourneyPage.tsx:28-31`). Never name a component in customer-facing material; if a script must, take the name from that import list.
- **[VERIFY]** Whether query-string parameters (e.g., UTM tags on a specific pathname) survive into the stored `path` string or are stripped before the widget posts them — relevant if a script wants to show a UTM-tagged URL inside the journey trail itself (UTM capture as `ChatSession.utm_params` is separately confirmed [T1], but that's a landing-context field, not a per-entry journey field).
- **[VERIFY]** No explicit cross-device or off-site tracking mechanism was found — flagged as a limit under §6, but this is an absence-of-evidence finding, not a code comment that explicitly rules it out; worth a second check if a future script is tempted to imply broader tracking.
- Per platform-wide guidance: no ROI, conversion-rate lift, or revenue figure exists in any inspected source for this feature — none was invented for this document, and none should be added elsewhere without independent evidence.
