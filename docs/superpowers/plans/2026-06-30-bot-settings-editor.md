# Bot Settings Editor Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1743-line `Interface.jsx` bot editor with a thin `BotSettings.jsx` shell + 7 focused tab components, absorbing the bot-config orphaned by sub-project 1, and rename the nav "Appearance" → "Bot Settings".

**Architecture:** Incremental extraction — stand up the shell that owns shared bot-draft/save/preview/entitlement state, then move each tab's UI into its own file under `pages/bot-settings/`, building after each so nothing breaks. Frontend-only; all fields already persist via the existing bot-update save path (no backend/migration).

**Tech Stack:** React 19 · Vite · Tailwind. No JS unit-test runner in this app → every task verifies with `npm run lint` + `npm run build` + targeted manual smoke (per spec). DO NOT introduce react-query (the app doesn't use it).

**Spec:** `docs/superpowers/specs/2026-06-30-bot-settings-editor-design.md`

---

## Shell ↔ tab contract (read first)

The shell (`BotSettings.jsx`) owns ALL shared state, lifted verbatim from today's `Interface.jsx`:
- the selected bot + a **draft** object of editable fields and their setters,
- the **Save** action + dirty tracking + ToastContext calls,
- plan **entitlements** (`ent`) + the lock-badge / upgrade-modal logic,
- the **live preview** pane,
- inner active-tab state (keep the existing in-page tab mechanism).

Each tab component is **presentational + field-binding**, receiving props from the shell. Standardize the prop shape:

```jsx
// Every tab: <XTab draft={draft} set={set} ent={ent} />
// `draft` = current editable bot fields; `set(field, value)` updates one field.
// Paid tabs/sections read `ent` for gating; the shell renders the lock overlay/modal.
```

> Before extracting, read `pages/Interface.jsx` end-to-end and list the exact state variables + setters it holds (e.g. `primaryColor/setPrimaryColor`, `systemPrompt/setSystemPrompt`, `flags/setFlags`, `queueTimeoutSeconds`, `leadFormFields`, etc.). Those become the shell's `draft`/`set` surface. Keep names identical to minimize risk.

## Field → tab mapping (target 7 tabs)

| Tab | Bot fields it binds |
|---|---|
| GeneralTab | `name`, launcher/"have questions?" text, `website` |
| PersonalityTab | `system_prompt`, `brand_tone`, `company_name`, `company_description` |
| AppearanceTab | `primary_color`, `user_bubble_color`, recommended colors, avatar type/upload, `branding_text`, `branding_url` |
| MessagesTab | welcome greeting/subtitle/suggestions/layout, offline message, notification emails, reply-to (existing `MessagesTab` content) |
| BehaviorTab | `feature_flags.*` (file_sharing, rating survey, branding toggle, queue indicator, typing preview, transcript) + advanced knobs (typing/greeting timeouts, frustration thresholds, reconnect — from `AdvancedSettingsTab`) |
| LeadsTab | lead form enable + fields (name/email/phone/company), BANT toggle |
| LiveChatTab | live-chat enable, waiting/no-operator messages, `live_chat_queue_timeout_seconds`, `live_chat_max_queue_size` |

---

## Task 1: Scaffold directory + move existing sub-tab files

**Files:**
- Create dir `app/src/pages/bot-settings/`
- Move: `pages/MessagesTab.jsx` → `pages/bot-settings/MessagesTab.jsx`; `pages/AdvancedSettingsTab.jsx` → `pages/bot-settings/AdvancedSettingsTab.jsx`; `pages/BrandingTab.jsx` → `pages/bot-settings/BrandingTab.jsx`
- Update the import paths in `Interface.jsx` to the new locations.

- [ ] **Step 1:** `git mv` the three files into `pages/bot-settings/` and fix their imports + the imports in `Interface.jsx`.
- [ ] **Step 2:** `cd app && npm run build` → ✓ (editor still works, files just relocated).
- [ ] **Step 3:** `git add -A && git commit -m "refactor(app): move bot-editor sub-tabs under pages/bot-settings/"`

---

## Task 2: Create the `BotSettings.jsx` shell (delegating to existing Interface body)

**Files:**
- Create: `app/src/pages/BotSettings.jsx`

- [ ] **Step 1:** Create `BotSettings.jsx` that, for now, **renders `<Interface />`** unchanged (a pass-through wrapper). This lets us switch routing/nav to the new name first, then refactor behind it with the build always green.

```jsx
// app/src/pages/BotSettings.jsx
import Interface from './Interface';
export default function BotSettings(props) {
  return <Interface {...props} />;
}
```

- [ ] **Step 2:** `cd app && npm run build` → ✓
- [ ] **Step 3:** `git add app/src/pages/BotSettings.jsx && git commit -m "refactor(app): add BotSettings shell wrapping Interface (pass-through)"`

---

## Task 3: Rename nav "Appearance" → "Bot Settings" + route to the shell

**Files:**
- Modify: the sidebar/nav config (find with `grep -rn "Appearance" app/src/components app/src/layouts`), `app/src/pages/Chatbot.jsx` (renders the editor for `?tab=appearance`), `app/src/App.jsx` if it imports `Interface` directly.

- [ ] **Step 1:** Change the nav label "Appearance" → "Bot Settings" (keep the same `?tab=appearance` link target). Point the editor render at `BotSettings` instead of `Interface` (in `Chatbot.jsx` where `botTab === 'appearance'` renders the editor, and anywhere `Interface` is imported as the page). Update the editor's `PageHeader`/title text to "Bot Settings".
- [ ] **Step 2:** `cd app && npm run build` → ✓. Manual: sidebar shows "Bot Settings"; `/chatbot?tab=appearance` opens the editor (now via the shell); the SP1 WorkspaceTab pointer still lands here.
- [ ] **Step 3:** `git commit -m "feat(app): rename Appearance -> Bot Settings; route through shell"`

---

## Task 4: Lift shared state into the shell; render tabs from a config array

**Files:**
- Modify: `app/src/pages/BotSettings.jsx` (becomes the real shell), `app/src/pages/Interface.jsx` (will be emptied out across Tasks 5–11, removed in Task 12).

- [ ] **Step 1:** Copy the shared state, bot-load effect, `save`/dirty logic, `ent` entitlement + lock-modal, and the live-preview pane from `Interface.jsx` into `BotSettings.jsx`. Define the 7-tab config:

```jsx
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'personality', label: 'AI & Personality' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'messages', label: 'Messages' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'leads', label: 'Leads', locked: leadFormLocked, intent: 'leads_form' },
  { id: 'live_chat', label: 'Live Chat', locked: !liveChatAllowed, intent: 'live_chat_appearance' },
];
```

- [ ] **Step 2:** For this task, the shell still renders the OLD inline tab bodies (temporarily import the body from Interface or inline) so the build stays green while state is centralized. Build → ✓.
- [ ] **Step 3:** `git commit -m "refactor(app): lift bot-editor shared state into BotSettings shell"`

> If lifting all state at once is too large to keep green, instead keep `BotSettings` delegating to `Interface` and extract tabs Task 5→11 pulling state up incrementally per tab. Either way: **build must pass after every task.**

---

## Tasks 5–11: Extract one tab per task (build green after each)

For EACH tab below, the steps are identical:
- **(a)** Create `app/src/pages/bot-settings/<Tab>.jsx` exporting `export default function <Tab>({ draft, set, ent }) { ... }`, moving the corresponding JSX + field bindings out of `Interface.jsx`, rewired to `draft`/`set`.
- **(b)** In `BotSettings.jsx`, render `<Tab>` for that tab id; delete the now-moved block from `Interface.jsx`.
- **(c)** `cd app && npm run build && npm run lint` → ✓.
- **(d)** Manual smoke: open the tab, edit a field, Save, confirm persistence + preview update.
- **(e)** Commit `feat(app): extract <Tab> in Bot Settings`.

- [ ] **Task 5 — GeneralTab** (`GeneralTab.jsx`): bot name, launcher text, website. (Colors move to AppearanceTab in Task 7 — leave colors in place until then or move now if cleaner.)
- [ ] **Task 6 — PersonalityTab** (`PersonalityTab.jsx`, NEW): `system_prompt`, `brand_tone`, `company_name`, `company_description`. This is the content orphaned from old Settings — bind to the same bot fields the old Settings "Tone & Personality" wrote. **Closes the SP1 system_prompt gap** — verify save persists `system_prompt`.
- [ ] **Task 7 — AppearanceTab** (`AppearanceTab.jsx`): merge General's color section + the Avatar tab + `BrandingTab` (custom brand text/URL) into one tab. Compose existing `BrandingTab` as a sub-section.
- [ ] **Task 8 — MessagesTab** wiring: render the relocated `bot-settings/MessagesTab.jsx` from the shell with the standardized props (adapt its existing prop shape to `draft`/`set` or keep its current props if the shell passes them through). No content change.
- [ ] **Task 9 — BehaviorTab** (`BehaviorTab.jsx`, NEW): widget **feature flags** section (file_sharing, rating survey, branding toggle, queue indicator, typing preview, transcript — the old Settings "Widget Behavior", bound to `feature_flags`) + the existing `AdvancedSettingsTab` content as a **paid-gated section** (reuse `ent` + lock pattern; gate the advanced section only, leave feature flags free). Compose `bot-settings/AdvancedSettingsTab.jsx`.
- [ ] **Task 10 — LeadsTab** (`LeadsTab.jsx`): lead form enable + fields + BANT toggle. Keep the whole-tab paid lock (`leadFormLocked`).
- [ ] **Task 11 — LiveChatTab** (`LiveChatTab.jsx`): live-chat enable + waiting/no-operator messages + `live_chat_queue_timeout_seconds` + `live_chat_max_queue_size` (the old Settings "Live Chat Queue", now here). Keep the whole-tab paid lock.

---

## Task 12: Remove `Interface.jsx`; finalize shell

**Files:**
- Delete: `app/src/pages/Interface.jsx`
- Modify: any remaining imports of `Interface` → `BotSettings`.

- [ ] **Step 1:** Confirm `Interface.jsx` is now empty of unique logic (all moved to shell + tabs). Delete it; update imports. `grep -rn "Interface" app/src` → only historical/comment refs remain.
- [ ] **Step 2:** `cd app && npm run lint && npm run build` → ✓.
- [ ] **Step 3:** `git commit -m "refactor(app): remove Interface.jsx; Bot Settings fully componentized"`

---

## Task 13: Full verification + SP1-gap closure check

- [ ] **Step 1:** Gate: `cd app && npm run lint && npm run build` → green.
- [ ] **Step 2:** Manual smoke (all 7 tabs): edit+save one field in each; specifically verify the 3 absorbed configs persist — **system prompt** (Personality), a **feature flag** (Behavior), **queue timeout** (Live Chat). Confirm paid locks render on Free for Leads, Live Chat, and the Behavior→advanced section. Confirm the live preview updates. Confirm `/chatbot?tab=appearance` (SP1 pointer) opens Bot Settings.
- [ ] **Step 3:** Confirm the SP1 interim gap is closed (system_prompt/widget-behavior/queue all editable again). The SP1 WorkspaceTab "moved to Bot Settings" pointer remains valid.
- [ ] **Step 4:** `git commit -m "test(app): verify Bot Settings editor (sub-project 2)"` (or no-op if nothing to commit) and push `development`.

---

## Self-Review notes (author)

- **Spec coverage:** rename (T3) · componentize/shell (T2,T4,T12) · 7 tabs incl. absorbed configs (T5–T11) · gating preserved (T9 section-gate, T10/T11 tab-gate) · route kept (T3) · no backend (frontend-only throughout). All spec sections mapped.
- **Incremental safety:** build passes after every task; `Interface.jsx` is only deleted (T12) once fully drained, so the editor never breaks mid-refactor.
- **No backend/tests:** frontend-only; gate is lint+build + documented manual smoke (no JS unit runner — matches the app + SP1 approach).
- **Naming consistency:** tab prop shape `({ draft, set, ent })` used uniformly; absorbed fields named exactly as the bot model / old Settings used them.
