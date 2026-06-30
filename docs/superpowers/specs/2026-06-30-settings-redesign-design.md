# Design: Settings Page Redesign (Account + Workspace)

**Date:** 2026-06-30
**Status:** Approved (design) — pending spec review
**App:** `oye-chats-platform/app` (operator/client dashboard, React + Vite)
**Sub-project:** 1 of 3 in the Configure-area IA redesign

## Context: the Configure-area redesign (the bigger picture)

The dashboard's "Configure" area spans three coupled, oversized, poorly-separated surfaces:

| Surface | Component | Role | Problem |
|---|---|---|---|
| My Bots | `Chatbot.jsx` (`?tab=bots`, 704 lines) | pick/create/embed/delete bots | dated UX |
| "Appearance" → **Bot Settings** | `Chatbot.jsx` (`?tab=appearance`) → `Interface.jsx` (1743 lines) | configure the selected bot (7 tabs) | mislabeled nav; 1743-line monolith |
| Settings | `Settings.jsx` (1141 lines) | account + per-bot grab-bag | mixes account + bot config; duplicates the bot editor; no Notifications |

Agreed plan: **decompose into 3 sub-projects, sequenced 1→2→3**, each with its own spec → plan → build. Cross-cutting decision: **rename the nav item "Appearance" → "Bot Settings"** (it's the full editor, not just appearance). This document covers **sub-project 1: Settings**.

## Goal

Rebuild `Settings.jsx` from scratch as a **tabbed Account + Workspace** page. Personal/account and workspace concerns get a clear home; per-bot configuration leaves Settings for the Bot Settings editor (sub-project 2); add the missing **browser-notifications** controls.

## Non-goals (handled elsewhere)

- The Bot Settings editor (`Interface.jsx`) restructure + receiving moved bot-config → **sub-project 2**.
- My Bots redesign → **sub-project 3**.
- Per-bot config UX itself (it only *leaves* Settings here).

## Current Settings (1141 lines) — disposition of its 8 sections

| Section | New home |
|---|---|
| Theme | → **Appearance** tab (here) |
| Account | → **Profile** tab (here) |
| Change Password | → **Security** tab (here) |
| Send Feedback | → **Feedback & Support** tab (here) |
| Widget Behavior (feature flags) | → Bot Settings editor (**sub-project 2**) |
| Visitor Messages (offline msg, notification emails, reply-to) | → **removed**; already exists in editor's Messages tab (`MessagesTab`) — de-dupe in sub-project 2 |
| Tone & Personality (brand tone, company name/desc, system prompt) | → Bot Settings editor (**sub-project 2**) |
| Live Chat Queue (timeout, max size) | → Bot Settings editor (**sub-project 2**) |

**Migration safety:** to avoid a functionality gap, the four bot-config sections are physically relocated in **sub-project 2** (which adds any missing ones to the editor first). Sub-project 1 builds the new account/workspace tabs alongside; the bot-config sections may remain temporarily until sub-project 2 cuts them over. No bot-config capability is lost between sub-projects.

## Architecture

- `pages/Settings.jsx` becomes a **thin shell**: a left vertical tab rail (mirrors the `Interface.jsx` pattern) + a content pane. Active tab is **URL-driven** via `?tab=` (e.g. `/settings?tab=notifications`), consistent with `Integrations?tab=` / `Insights?tab=`. Deep-linkable and back-button friendly. Unknown/absent tab → default `profile`.
- Each tab is a **focused component** in a new `pages/settings/` directory — small, single-purpose, independently testable, replacing the 1141-line monolith:
  - `ProfileTab.jsx`, `SecurityTab.jsx`, `NotificationsTab.jsx`, `AppearanceTab.jsx`, `WorkspaceTab.jsx`, `FeedbackTab.jsx`
- Shared: react-query for fetch/mutate, the app's `ToastContext` for feedback, existing `services/api.js` client. Each tab owns its own loading skeleton + empty/error states.

## Tabs (detailed)

### 1. Profile (`?tab=profile`, default)
- Reads `/auth/me` (name, email, joined date; avatar if present).
- Inline edit of **name** and **email** with validation (non-empty name; valid, unique email).
- **Backend (new):** `PATCH /client/profile` `{ name?, email? }` → updated profile; 400 on invalid/duplicate email. Auth: `get_current_client`. Audited.

### 2. Security (`?tab=security`)
- **Change password** for both account types:
  - Operators: existing `operatorChangePassword(current, next)`.
  - Clients: **Backend (new):** `POST /client/change-password` `{ current_password, new_password }` (min 8, letter+number), verifies current hash, updates. 400 on mismatch/weak. Audited.
- "Sign out" action (clears auth, redirects to `/login`).
- Validation mirrors register (≥8 chars, letter + number); errors surfaced inline.

### 3. Notifications (`?tab=notifications`)
- Browser/desktop push **enable–disable toggle** + live status using the existing `usePushNotifications` hook (`request()` / wiring `disable()` for the first time).
- Status states: **Enabled** (granted + subscribed), **Off** (default/unsubscribed), **Blocked** (denied → show the lock-icon recovery guidance reused from `PushPermissionBanner`, since JS cannot re-prompt once blocked).
- The hook currently mounts only in `AdminLayout`. **Decision:** lift `usePushNotifications` into a shared `PushContext` provider so the `PushPermissionBanner` and this Notifications tab read/update one source of truth (toggling in the tab updates the banner state and vice-versa). The plan details the provider placement.

### 4. Appearance (`?tab=appearance`)
- Theme selector (system / light / dark), migrated as-is from the current Theme section. Client-side, instant. No backend.

### 5. Workspace (`?tab=workspace`)
- Quick cards linking to existing pages: **Team** (`/team`), **Billing** (`/billing`).
- **API key** card: masked display + **Regenerate** (with confirm warning it invalidates the old key).
  - **Backend (new):** `GET /client/api-key` → `{ api_key_masked }`; `POST /client/api-key/regenerate` → `{ ok, api_key, api_key_masked }` — the regenerate response returns the **full new key once** so the UI can show a copy-to-clipboard reveal immediately after rotation; subsequent views are masked-only. Auth: `get_current_client`. Audited.

### 6. Feedback & Support (`?tab=feedback`)
- **Submit feedback** (existing `POST /client/feedback`, with category + optional attachment) — reuse `FeedbackModal` content or inline form.
- **My feedback** list with resolution status (`GET /client/feedback`) — the feedback-resolution loop already shipped; surface status + admin response here so users see outcomes.

## Backend additions (FastAPI `api/`)

New `get_current_client`-gated endpoints, audited, with pytest coverage:
1. `PATCH /client/profile` — update name/email (unique email check).
2. `POST /client/change-password` — client self-service password change.
3. `GET /client/api-key` + `POST /client/api-key/regenerate` — masked view + rotation.

Reuse `app.core.security.get_password_hash` / `verify_password`; follow existing `client_routes.py` conventions.

## Data flow, errors, gating

- Each tab fetches independently (react-query keys: `["me"]`, `["client-api-key"]`, `["client-feedback"]`, etc.) and mutates with optimistic-free, toast-on-result handlers.
- Validation errors → backend 400 with `detail`; surfaced inline per field/section.
- Theme is local/instant; everything else persists via API.
- Plan gating: none of the account/workspace tabs are plan-locked (unlike the removed bot-config). Workspace links respect existing page guards.

## File structure (sub-project 1)

```
app/src/pages/Settings.jsx            # thin tabbed shell (rewritten)
app/src/pages/settings/
  ProfileTab.jsx
  SecurityTab.jsx
  NotificationsTab.jsx
  AppearanceTab.jsx
  WorkspaceTab.jsx
  FeedbackTab.jsx
api/app/api/client_routes.py          # + profile / change-password / api-key endpoints
api/tests/test_client_account.py      # new endpoint tests
```

## Testing

- Backend: pytest for each new endpoint (happy path + validation + auth).
- Frontend: gate via `npm run lint` + `npm run build`; manual tab-by-tab smoke (deep-link each `?tab=`, save flows, push toggle states).

## Rollout

- All on `development`; ships behind normal deploy. No migration needed (new endpoints only; no schema changes).
- Backend endpoints land first (so the tabs have real wiring), then the frontend.

## Open coordination note

The bot-config relocation (Widget Behavior / Tone / Live Chat Queue / de-dupe Visitor Messages) is owned by **sub-project 2**; this sub-project must not delete those sections until sub-project 2 has a home for them in the Bot Settings editor.
