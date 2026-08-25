# Phase 2 — Widget Localization & Visitor Language

## Objective

Let the widget resolve, display, and persist a visitor's language, and let that
resolved language reach the backend and get stored on `ChatSession`. This phase
does **not** change what language the AI responds in (that's Phase 3) — it
establishes the signal and the UI, and proves the language survives navigation,
reconnects, and refresh.

## Scope

- Widget-side locale resolution (explicit → site → `<html lang>` → browser →
  persisted → default), following the precedence rule in the README.
- Widget language selector UI in the existing header menu.
- `ChatSession` language-state columns and a dedicated `POST /chat/language`
  endpoint for explicit changes.
- `locale`/`language`/`language_source` fields added to `ChatRequest` and read
  (but not yet acted on for generation) in `chat_routes.py`.
- RTL foundation: `dir` attribute plumbing through the Shadow DOM host.
- Extend the existing `window.OyeChats` public API (`update(cfg)`) rather than
  inventing a new method pair.

## Non-scope

- AI response language enforcement (Phase 3 — this phase only persists the
  signal; `rag_pipeline_stream`/`build_hybrid_prompt` are not touched here).
- Message-level language detection wiring (Phase 3 owns invoking
  `language_service.detect_message_language`, stubbed in Phase 1).
- Operator-side anything (Phase 4).
- Admin bot-config UI for supported locales (Phase 5) — Phase 2 assumes
  `bot.language_config.supported_locales` already exists in the DB (Phase 1)
  even though there's no admin UI to edit it yet; seed it manually/via script
  for QA until Phase 5 ships.

## Existing files/components affected

**Backend**

| File | Change |
|---|---|
| `api/app/schemas/chat.py` (29 lines total) | Add `locale`, `language`, `language_source` optional fields to `ChatRequest`. |
| `api/app/api/chat_routes.py` — `chat_stream_endpoint` (route line 1279, flow steps 1279-1404) | Add a `_resolve_visitor_language(request, body, bot, session)` step between the existing `_visitor_country_from_request(request)` call (line 332/1339) and the `rag_pipeline_stream(...)` call (lines 1379-1388) — same insertion pattern already used for `visitor_country`. Persist the resolved `LanguageContext` onto `ChatSession` (new columns below); do **not** yet pass it into `rag_pipeline_stream` (Phase 3 wires that kwarg). |
| `api/app/db/models.py` — `ChatSession` (currently lines 767-865) | Add six language-state columns (below). |

**Widget** (production entry: `widget/src/loader.js` + `widget/src/app-entry.jsx`
— confirmed `main.jsx` is dev-only and not part of the shipped bundle)

| File | Change |
|---|---|
| `widget/src/app-entry.jsx` (`buildPublicApi()` ~lines 100-120, `ensureShadowAndStyles()` ~lines 80-96) | Resolve initial locale before mount; set `dir` attribute on the shadow host per `language_service`-equivalent client logic; extend `update(cfg)` to accept `{ locale }` and re-render on change. |
| `widget/src/widget-controller.js` (`getController()` singleton, `update()` ~lines 165-170, `VALID_EVENTS` lines 11-22) | Add `localeChanged` to `VALID_EVENTS`; store `locale` in `runtimeConfig`; emit `localeChanged` on `update({ locale })`. |
| `widget/src/components/ChatWidget.jsx` (settings state lines 29-39, fetched via `getChatbotSettings()`) | Read `settings.language_config` from the (Phase 1-extended) public settings response; initialize the resolver with `supported_locales`/`default_locale`. |
| `widget/src/components/ChatWindow.jsx` (3299 lines — the largest surface) | Add the language selector entry to the existing header/overflow menu; replace hardcoded English strings identified below with locale-aware lookups; **fix the hardcoded `'en-US'` locale at line 2041** (currently ignores browser locale — a pre-existing bug this phase should fix as part of the date-formatting localization pass). |
| `widget/src/components/WelcomeScreen.jsx` (greeting strings lines 15-17, subtitle fallback line 39) | Localize greeting/subtitle strings. |
| `widget/src/components/ChatInput.jsx` (placeholder line 109, aria-labels lines 487-730) | Localize placeholder and aria-labels. |
| `widget/src/components/HandoffForm.jsx` (strings lines 51-206) | Localize validation/labels/buttons. |
| `widget/src/components/Launcher.jsx` (lines 11, 103, 137, 177) | Localize greeting bubble and aria-label. |
| `widget/src/components/LeadCaptureForm.jsx` (lines 8-11, 45-99) | Localize field labels/placeholders/validation. |
| `widget/src/services/api.js` — `sendMessageStream` (lines 64-199, body built lines 69-77), `getChatbotSettings` (lines 857-877) | Add `locale`/`language`/`language_source` to the `/chat/stream` request body, next to the existing `cta_dimension` conditional field. |
| `widget/src/services/storage-keys.js` (existing getters: `getSessionKey`, `getLeadCapturedKey`, `getSlashHintSeenKey`, all following `` `${prefix}_${botKey}` ``) | Add `getLocaleKey(botKey)` → `` `oyechats_locale_${botKey}` ``, matching the existing convention exactly. |

## New files/components required

**Backend**
- None new (Phase 1's `language_service.py`/`schemas/language.py` are reused).

**Widget**
- `widget/src/i18n/locales.js` — flat message-dictionary per supported locale
  (starts with `en`, `hi` as the pilot pair; extend as bots enable more).
- `widget/src/i18n/localeResolver.js` — the client-side precedence resolver
  (mirrors `language_service.resolve_initial_locale` logic).
- `widget/src/i18n/formatters.js` — date/number formatting helpers
  (`Intl.DateTimeFormat`/`Intl.NumberFormat` wrappers), replacing the ad hoc
  `toLocaleTimeString`/`toLocaleDateString` calls scattered in `ChatWindow.jsx`
  (lines 108, 149, 2041, 2568) with a single locale-aware helper.
- `widget/src/components/LanguageSelector.jsx` — the header-menu selector.

Bundling note: `vite.app.config.js`'s `manualChunks` deliberately keeps chat/
live-chat/forms un-chunked so Rollup auto-splits per `React.lazy()` call site,
to avoid bloating the eager FAB-only bundle. **Locale dictionaries must be
dynamically imported per-locale** (`import(`./i18n/locales/${locale}.js`)`),
not added to the `vendor` manualChunks bucket — that bucket loads on every
page view regardless of whether the visitor ever opens chat. Do not add
anything to `widget/src/loader.js` beyond minimal locale-detection glue; it
has an explicit 8KB gzip budget (`vite.loader.config.js`, `size-limit` config
in `package.json`).

## Database/schema changes

Add to `ChatSession` (`api/app/db/models.py:767-865`):

```python
language_code = Column(String(16), nullable=True)
locale = Column(String(32), nullable=True)
language_source = Column(String(32), nullable=True)
language_confidence = Column(Float, nullable=True)
language_locked = Column(Boolean, default=False, server_default="false", nullable=False)
language_changed_at = Column(DateTime(timezone=True), nullable=True)
```

All nullable except `language_locked` (defaults `false`) — no backfill needed,
existing sessions simply have `NULL` language state and are treated as
"unresolved, will resolve on next turn" by the Phase 3 consumer.

Migration: same idempotent-guard template as Phase 1, applied to
`chat_sessions` (mirrors `f1a7c3d94e28_chat_session_last_probed_dimension.py`,
the most recent single-column addition to this table). No index added yet —
`ix_chat_sessions_bot_id_created` (existing, `bot_id, created_at DESC`) is
sufficient until Phase 5's analytics work; adding `(bot_id, language_code,
created_at)` before there's data to query would be premature.

## API/WebSocket changes

`api/app/schemas/chat.py` — `ChatRequest` gains:

```python
locale: str | None = Field(default=None, max_length=32)
language: str | None = Field(default=None, max_length=16)
language_source: str | None = Field(default=None, max_length=32)
```

New endpoint, `POST /chat/language` (added to `api/app/api/chat_routes.py`,
respecting the existing static-route-before-dynamic-route ordering noted at
`bot_routes.py:840-841` if colocated in a router with dynamic segments):

```json
// Request
{ "session_id": "...", "locale": "hi-IN" }
// Response
{ "language": "hi", "locale": "hi-IN", "source": "explicit", "locked": true }
```

Behavior: validate bot/session ownership (same pattern as `_resolve_session_id`,
`chat_routes.py:213-227`), validate the locale against
`bot.language_config.supported_locales` via `language_service.is_supported_
locale`, update `ChatSession` language columns, set `language_locked = true`,
`language_source = "explicit"`, write a `ChatAuditLog`-style trail if the
project wants an audit record (optional — `ChatAuditLog` currently only logs
live-chat transitions, not language changes; adding a language entry there is
a judgment call, not required for V1).

No WebSocket changes in this phase — live-chat WS protocol changes are Phase 4
scope, since Phase 2 is about the bot-mode conversation only.

## Frontend changes

Widget only (see file table above). Summary of the UX:

- Language selector lives in the existing widget header overflow/menu (not the
  welcome screen) — a small "⋮" menu with a `Language` submenu, per the source
  plan's UX guidance.
- On explicit selection: call `POST /chat/language`, then re-render current
  session's UI strings from the new locale's dictionary. **Do not restart the
  conversation** — same `session_id`, history preserved.
- Persist via `storage-keys.js`'s new `getLocaleKey(botKey)` →
  `oyechats_locale_${botKey}` in `localStorage`. Decide explicitly whether
  locale should also ride the existing cross-subdomain cookie bridge
  (`resolveShareDomain`/`writeCookie`/`readCookie` in `storage-keys.js:19-182`,
  used today for session continuity) — recommendation: **localStorage only**
  for V1; losing a locale preference on a subdomain hop is low-severity
  compared to losing an in-progress conversation, and reusing the cookie
  machinery adds surface area for no proven need yet.
- `<html lang>` detection reads the **host page's** `document.documentElement.
  lang`, not the widget's own document — the widget lives in a Shadow DOM
  inside the host page, so this is a straightforward host-page read, but the
  Shadow DOM boundary is exactly why `dir="rtl"` must be set on the **shadow
  host element** (`ensureShadowAndStyles()` in `app-entry.jsx`), not on
  `document.documentElement`, for RTL styling to actually cascade into the
  widget's rendered content.
- `OyeChats.init({ locale: "fr-FR" })` and `OyeChats.update({ locale: "fr-FR"
  })` reuse the **existing** public API (`buildPublicApi()` in
  `app-entry.jsx`, backed by `widget-controller.js`'s `update()` at lines
  165-170) — add `locale` as a recognized `runtimeConfig` key and emit the
  existing event-listener pattern (`VALID_EVENTS`) with a new `localeChanged`
  event, rather than adding a bespoke `setLocale()`/`getLocale()` API pair.
  This is simpler than the source plan's proposal and consistent with how
  `identify()`/`boot()` already work.

**Dead-code decision required:** `QueueWaitingScreen.jsx` is fully built but
imported nowhere in the widget (confirmed via full-tree grep). The actual
"waiting for operator" copy the plan needs to localize is inline in
`ChatWindow.jsx` (system messages at lines 768, 788, 790, 1467, 1507, 1734,
progressive waiting copy at lines 933-935). **This phase localizes the inline
`ChatWindow.jsx` copy** and leaves `QueueWaitingScreen.jsx` untouched — do not
spend effort localizing a component nothing renders. Flag to the team
separately whether `QueueWaitingScreen.jsx` should be wired in or deleted;
that's an unrelated pre-existing cleanup, out of scope here.

## Backend/service changes

`chat_routes.py` — new `_resolve_visitor_language(request, body, bot, session)`
helper, called where `_visitor_country_from_request(request)` is already
called (line 332/1339 context), implementing the precedence order using
`language_service.resolve_initial_locale`:

```
if session.language_locked: use session language (unless body.language_source == "explicit")
elif body.language/locale present (explicit or widget-resolved via html_lang/browser): use it, persist
elif session.language_code already set (from a prior turn): reuse it, skip re-resolution
else: geo fallback (existing _resolve_and_update_location signal, once available) → bot.language_config.default_locale
```

This mirrors the "later turns: use session language if locked" rule and the
"skip detection when session language known" performance rule from the source
plan, without yet touching generation (Phase 3).

## Dependencies on previous phases

Requires Phase 1: `language_service.py`, `schemas/language.py`, and
`Bot.language_config` (for `supported_locales`/`default_locale`/`enabled`)
must exist. If `bot.language_config.enabled` is `false` (the Phase 1 default
for all existing bots), `_resolve_visitor_language` should short-circuit to
`bot.language_config.default_locale` / `"en"` without running detection —
this keeps old bots' behavior and latency identical until an admin explicitly
enables multilingual for that bot (Phase 5 ships the toggle).

## Exact implementation steps

1. Add the six `ChatSession` columns; write and run the migration.
2. Extend `ChatRequest` with `locale`/`language`/`language_source`.
3. Implement `_resolve_visitor_language` in `chat_routes.py`; wire it into
   `chat_stream_endpoint` before the `rag_pipeline_stream` call (no new kwarg
   to that call yet — just persistence).
4. Add `POST /chat/language`.
5. Widget: create `i18n/localeResolver.js`, `i18n/locales.js` (en + hi to
   start), `i18n/formatters.js`.
6. Widget: add `getLocaleKey` to `storage-keys.js`.
7. Widget: wire locale resolution into `app-entry.jsx` before mount; set
   `dir` on the shadow host.
8. Widget: extend `widget-controller.js`'s `update()`/`VALID_EVENTS` for
   `locale`/`localeChanged`.
9. Widget: build `LanguageSelector.jsx`; add to `ChatWindow.jsx`'s header
   menu.
10. Widget: replace hardcoded strings in `WelcomeScreen.jsx`, `ChatInput.jsx`,
    `HandoffForm.jsx`, `Launcher.jsx`, `LeadCaptureForm.jsx`, and the inline
    waiting-copy in `ChatWindow.jsx` with `i18n/locales.js` lookups. Fix the
    `'en-US'` hardcode at `ChatWindow.jsx:2041`.
11. Widget: send `locale`/`language`/`language_source` in `api.js`'s
    `sendMessageStream` body.
12. Manual QA: existing bot with `language_config.enabled=false` shows
    identical widget behavior pre/post-change.

## Acceptance criteria

- [ ] Widget resolves locale per the precedence order and renders localized UI
      strings (en/hi pilot pair) without a full page reload.
- [ ] Manual language selection persists across widget close/reopen, page
      refresh, and SPA navigation on the host site (via `localStorage`).
- [ ] `session_id` does not change when locale changes mid-conversation;
      history is preserved.
- [ ] `POST /chat/language` validates against `bot.language_config.
      supported_locales` and rejects unsupported locales gracefully
      (normalizes to base language or bot default, per the source plan's
      fallback rule).
- [ ] `OyeChats.init({ locale })` and `OyeChats.update({ locale })` both work
      from a host page's own script.
- [ ] `dir="rtl"` applied correctly on the shadow host for `ar`/`he`/`fa`/`ur`.
- [ ] A bot with `language_config.enabled=false` (the default for every
      pre-existing bot) shows zero behavior change.

## Testing/QA requirements

- Widget unit/component tests: selector opens, locale changes, strings
  re-render, persistence survives refresh, unsupported locale falls back.
- Backend tests: `POST /chat/language` session-ownership check, explicit-locale
  persistence, locked-language behavior on subsequent turns.
- E2E (Playwright, per source plan §33.6 items 1-3, 6, 9, 10): first-visit
  browser-language detection, manual selection, website-locale override
  (`OyeChats.init({locale})`), refresh + restored language, RTL language,
  unsupported-locale fallback.

## Risks and edge cases

- **Detection thrash on mixed-language messages.** A visitor typing
  "Hi, mujhe pricing ke baare mein batao" should not flip session language on
  every turn — Phase 2 only resolves language once per session (first turn or
  explicit change); message-level re-detection heuristics are Phase 3's
  concern, this phase just avoids re-running resolution when
  `session.language_code` is already set.
- **Shadow DOM + `dir` attribute** — verify RTL cascades correctly; a naive
  `document.documentElement.dir = 'rtl'` would be a no-op inside a shadow
  root and is an easy mistake to make.
- **`storage-keys.js` cookie-bridging scope creep** — resist folding locale
  into the existing cross-subdomain cookie logic unless a customer actually
  needs it; it's meaningfully more code for a preference that's cheap to
  re-detect.

## Rollback considerations

- Widget: locale resolution and selector are additive UI; reverting the
  widget build to a pre-Phase-2 version is a normal rollback (no data loss —
  `ChatSession` language columns are simply unused).
- Backend: `POST /chat/language` and the `ChatRequest` field additions are
  additive; rolling back the route/schema changes leaves old sessions'
  language columns as `NULL`, which Phase 3's fallback chain already handles.
- DB: `downgrade()` on the `chat_sessions` migration is safe as long as Phase
  3/4 haven't shipped read dependencies on these columns yet.
