# Design: Bot Settings Editor Redesign

**Date:** 2026-06-30
**Status:** Approved (design) — pending spec review
**App:** `oye-chats-platform/app`
**Sub-project:** 2 of 3 in the Configure-area IA redesign (after Settings, before My Bots)

## Context

`Interface.jsx` is the per-bot editor, reached today via the mislabeled nav item **"Appearance"** (`/chatbot?tab=appearance`). It's a **1743-line monolith** with 7 tabs (only Messages/Advanced/Custom Brand are extracted; General/Avatar/Leads/Live Chat are inline). After sub-project 1, three configs that used to live in Settings now have **no editing home** (the interim gap): `system_prompt` + brand tone + company info, widget **feature flags**, and live-chat **queue** settings.

This sub-project: **rename → Bot Settings**, **componentize** the monolith, **rationalize the tabs into 7**, and **absorb the 3 orphaned configs** — closing the interim gap. **Frontend-only**: every field already persists through the existing `updateBot` / bot-settings save path (the fields exist on the `Bot` model; they were saved from the old Settings). No new backend.

## Goal

Replace the 1743-line `Interface.jsx` with a thin **Bot Settings** shell + 7 focused tab components, absorbing the orphaned bot-config, with the nav renamed to "Bot Settings".

## New tab taxonomy (rationalized 7)

| # | Tab | Contents | Gating | Source |
|---|---|---|---|---|
| 1 | **General** | bot name, launcher/"have questions?" text, website | free | existing General (minus colors) |
| 2 | **AI & Personality** | **system prompt**, **brand tone**, **company name + description** | free | **absorbs old Settings "Tone & Personality"** (closes system_prompt gap) |
| 3 | **Appearance** | brand color, user-bubble color, recommended colors, **avatar** (upload/orb/mascot), **custom brand** (branding text/URL) | free | merges General-colors + Avatar tab + Custom Brand tab |
| 4 | **Messages** | welcome greeting, suggestions + layout, offline messages, notification emails, reply-to | free | existing `MessagesTab` (unchanged) |
| 5 | **Behavior** | widget **feature flags** (file sharing, rating survey, branding toggle, queue indicator, typing preview, transcript) + **advanced knobs** (typing/greeting timeouts, frustration thresholds, reconnect) | feature flags free; advanced-knobs section paid-gated within the tab | **absorbs old Settings "Widget Behavior"** + existing `AdvancedSettingsTab` |
| 6 | **Leads** | lead-capture form fields + BANT toggle | paid | existing Leads Form |
| 7 | **Live Chat** | live-chat enable, waiting/no-operator messages, **queue timeout + max queue size** | paid | existing Live Chat + **absorbs old Settings "Live Chat Queue"** |

Notes:
- **Gating preserved.** Leads and Live Chat stay paid-locked (whole tab). Behavior is free for the feature-flags section; the advanced-knobs section keeps the existing paid lock (gate the section, not the tab) so we don't paywall the free feature flags.
- `system_prompt` had no home after sub-project 1 — tab 2 closes that gap.

## Componentization & file structure

```
app/src/pages/BotSettings.jsx                 # NEW thin shell (replaces Interface.jsx as the editor entry); left tab rail + active-tab switch, plan-gating + lock modals, the live widget preview pane, shared bot-load/save state
app/src/pages/bot-settings/
  GeneralTab.jsx        # extracted from Interface General (identity only)
  PersonalityTab.jsx    # NEW — system prompt + tone + company
  AppearanceTab.jsx     # extracted colors + Avatar + Custom Brand merged
  MessagesTab.jsx       # moved from pages/MessagesTab.jsx (unchanged content)
  BehaviorTab.jsx       # widget feature flags + AdvancedSettingsTab content (paid section)
  LeadsTab.jsx          # extracted from Interface Leads Form
  LiveChatTab.jsx       # extracted from Interface Live Chat + queue settings
```

- **Decision:** create `BotSettings.jsx` as the new shell and **remove `Interface.jsx`** once its inline tabs are extracted (no dual editors). Existing `MessagesTab.jsx` / `AdvancedSettingsTab.jsx` / `BrandingTab.jsx` move under `bot-settings/` and are composed into the new tabs (Advanced folds into Behavior; Branding folds into Appearance).
- The shell owns: selected-bot load, the shared `save`/dirty state + Save button, the live preview pane, plan-entitlement (`ent`) + lock-modal logic, and tab routing. Each tab is a presentational + field-binding component receiving `{ value, onChange }`-style props (or the shared bot-draft + setters) — small and focused.
- Save path unchanged: the shell persists via the existing `updateBot` / bot-settings update used by `Interface.jsx` today; all moved fields (`system_prompt`, `brand_tone`, `company_name`, `company_description`, `feature_flags`, `live_chat_queue_timeout_seconds`, `live_chat_max_queue_size`) are already in that payload.

## Rename / routing

- Sidebar: rename the **"Appearance"** item under "My Bots" → **"Bot Settings"** (find it in the sidebar/nav config component).
- Route: **keep `/chatbot?tab=appearance` working** (the sub-project-1 WorkspaceTab pointer + any bookmarks link there) and render the new `BotSettings` shell for that tab. Do not change the route param in this sub-project (avoids breaking the SP1 pointer); only the **label** and page-header text change to "Bot Settings".
- Within the editor, the 7 tabs can use their own inner tab state (as today) or `?subtab=` — keep parity with the current in-page tab state to limit churn.

## Data flow / errors / gating

- Bot draft state + save live in the shell (as in current `Interface.jsx`); tabs receive values + change handlers. Save → existing update API → ToastContext on result. No react-query (the app doesn't use it).
- Plan gating via existing `ent`/entitlement helpers + the existing lock-badge + upgrade-modal pattern; applied per-tab (Leads, Live Chat) and per-section (Behavior → advanced knobs).
- No new backend, no schema change, no migration.

## Testing

- Frontend gate: `npm run lint` + `npm run build`.
- Manual smoke: open each of the 7 tabs; edit + save a field in each (esp. the 3 absorbed configs: system prompt, a feature flag, queue timeout) and confirm persistence; verify paid locks still show for Free; verify the live preview still updates; verify `/chatbot?tab=appearance` (the SP1 pointer) lands here.

## Rollout / migration

- Closes the sub-project-1 interim gap (system prompt / widget behavior / queue regain homes). The SP1 WorkspaceTab "Bot configuration has moved to Bot Settings" pointer now correctly resolves to this renamed editor.
- All on `development`; normal deploy. No backend deploy dependency.

## Non-goals

- My Bots page (list/create/embed) → sub-project 3.
- Any change to how bot fields are stored or to the widget itself.
