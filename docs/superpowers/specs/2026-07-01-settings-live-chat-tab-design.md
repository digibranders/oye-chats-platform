# Settings → Live Chat tab (central hub) — Design

**Date:** 2026-07-01
**Status:** Approved (pending spec review)
**Area:** `oye-chats-platform/app` (admin/customer platform, Vite + React)

## Problem

The Team page shows a nudge:

> "Business hours and queue behaviour apply to all operators. **Configure in Settings → Live Chat**"

The link points to `/settings`, but the Settings page has **no Live Chat tab** — it was
referenced in copy but never built. A second stale reference exists further down the Team
page ("Settings → Business Hours section"). Both point to a place that does not exist.

Meanwhile, the config the nudge promises **already exists**, just elsewhere:

| Config | Where it lives today | Backend field | Scope |
|---|---|---|---|
| Business hours | Team → Departments → Edit (`BusinessHoursEditor`) | `departments.business_hours` (JSONB) | Per-department |
| Business hours (fallback) | *No UI* | `bots.business_hours` (JSONB) | Per-bot, used when a chat has no department |
| Queue behaviour | Bot Settings → Live Chat | `bots.live_chat_queue_timeout_seconds`, `bots.live_chat_max_queue_size` | Per-bot |

The nudge's "apply to all operators" framing is also inaccurate: the backend deliberately
moved business hours to **per-department** (migration `c2d3e4f5a6b7`, 2026-06-18) so Sales,
Support, and Billing can each keep their own schedule.

## Decision

Build the **Settings → Live Chat** tab the copy promises, as a **central hub** (user-chosen
direction): edit the one thing with no other home (the workspace-default `bots.business_hours`
fallback), edit queue behaviour inline for the selected bot (user-chosen), and surface
per-department overrides as a read-only summary that deep-links to the real editor.

This keeps a **single source of truth**: department schedules are only edited in Team →
Departments; the hub never duplicates them.

## Scope

**Frontend only.** No backend, migration, or API changes.
- `PATCH /bots/{id}` already accepts `business_hours`, `live_chat_queue_timeout_seconds`,
  `live_chat_max_queue_size` (see `api/app/api/bot_routes.py:191-194`).
- `getClientSettings(botId)` returns those fields; `getDepartments()` returns
  `business_hours` per department.
- `BusinessHoursEditor` (`src/components/BusinessHoursEditor.jsx`) is reused verbatim — same
  JSONB shape (`{ enabled, timezone, days: { mon: { enabled, start, end }, ... } }`) as
  departments, so both stay consistent.

## Files touched

| File | Change |
|---|---|
| `src/pages/settings/LiveChatTab.jsx` | **New** — the hub tab component |
| `src/pages/Settings.jsx` | Register tab in `TABS`: `{ id: 'live_chat', label: 'Live Chat', icon: Headphones, Component: LiveChatTab }` |
| `src/pages/TeamManagement.jsx` | Initialize `activeTab` from `?tab=` query param (additive) so `/team?tab=departments` lands on Departments; fix the two stale nudges (~line 344, ~line 631) |
| `src/pages/BotSettings.jsx` | Initialize sub-tab from `?section=` query param (additive) so `/chatbot?tab=appearance&section=live_chat` opens the Live Chat sub-tab |

## The tab — sections (top to bottom)

The tab is scoped to `useBotContext().selectedBot` (same pattern as Bot Settings). On mount and
whenever `selectedBot?.id` changes, it loads `getClientSettings(selectedBot.id)` (business hours
+ queue values) and `getDepartments()`.

### 1. Workspace default business hours *(editable)*
- Renders `<BusinessHoursEditor value={businessHours} onChange={setBusinessHours} disabled={readOnly} />`.
- Header copy: *"Default hours for **{bot.name}**. Departments can set their own — these apply
  when a chat has no department."*
- If the workspace has more than one bot, a one-line note: hours are per-bot; switch bots with
  the top-left switcher.

### 2. Queue behaviour *(editable inline, scoped to selected bot)*
- Two numeric inputs bound to `live_chat_queue_timeout_seconds` (5–600) and
  `live_chat_max_queue_size` (1–100), matching the backend `Field` bounds.
- Label makes scope explicit: *"Queue settings for **{bot.name}**."* to avoid the multi-bot
  "which bot?" confusion.
- A small secondary link to Bot Settings → Live Chat for the related widget copy
  (`/chatbot?tab=appearance&section=live_chat`).

### 3. Department overrides *(read-only summary + deep-link)*
- One row per department with a compact schedule summary derived from `dept.business_hours`
  ("Sales · Mon–Fri 09:00–17:00", "Support · Always open" when null/empty).
- Button → `/team?tab=departments`.

### Save
- One primary **Save** action persists sections 1 + 2 together (both are `bots.*` fields):
  `updateClientSettings({ business_hours, live_chat_queue_timeout_seconds, live_chat_max_queue_size }, selectedBot.id)`.
- Success/error via the existing `useToast()`.
- Section 3 has no save (read-only).

## Data flow

```
mount / selectedBot change
  ├─ getClientSettings(selectedBot.id) → business_hours, queue fields
  └─ getDepartments()                  → [{ name, business_hours }]

Save (sections 1+2)
  └─ updateClientSettings({ business_hours, live_chat_queue_timeout_seconds,
                            live_chat_max_queue_size }, selectedBot.id)
        → PATCH /bots/{id}
```

## Edge cases

- **No / loading bot** → skeleton while `botsLoading`; empty-state if the workspace has no bots.
- **Plan-gated live chat** → mirror Bot Settings: when `!liveChatAllowed`, render the sections
  read-only with an upgrade hint using the existing `FeatureGate` / `useUpgradeModal` pattern,
  rather than hiding the tab.
- **Deep-link params are additive** — absent param preserves current default behavior in
  `TeamManagement` / `BotSettings`, so nothing else regresses.
- **Empty business hours** → `BusinessHoursEditor` already treats null/empty as "always open";
  saving `{}` clears back to the fallback, consistent with the department flow.

## Copy fixes (the underlying bug)

- Team page ~line 344: keep "Configure in Settings → Live Chat" — now a real destination
  (`/settings?tab=live_chat`).
- Team page ~line 631: repoint the "Settings → Business Hours section" reference to the correct
  place (the new tab / the Departments editor).

## Testing / verification

Manual via the preview dev server:
1. Tab renders under Settings; `/settings?tab=live_chat` deep-links to it.
2. Editing workspace business hours + queue values and saving persists across reload.
3. Department summaries match real `getDepartments()` data; "always open" shows for empty hours.
4. Both deep-links land on the correct pre-selected sub-tab (Departments / Live Chat).
5. Multi-bot: switching the top-left bot switcher reloads the tab's values for that bot.

Automated gates (per repo standards): `npm run lint` and `npm run build` in `app/`.

## Out of scope

- Per-operator schedules (backend does not model them).
- Any backend / migration / API change.
- A workspace-wide *queue default* independent of a bot (queue stays per-bot; the hub edits the
  selected bot's values).
- Refactoring `TeamManagement` / `BotSettings` tab state beyond the additive URL-param read.
