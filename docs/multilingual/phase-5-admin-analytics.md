# Phase 5 — Admin Configuration & Analytics

> **Status: authoritative implementation specification.** Rewritten on
> 2026-08-24 after an audit against the live repository and the shipped Phase 4
> UI. The previous draft was assessed **REWORK REQUIRED**: it was written
> before Phase 4 existed and planned an operator language UI on the workspace
> Members page, which is both the wrong owner (an admin editing someone else's
> reading preference) and now duplicate work.
>
> **The single most important thing this phase does:** until 5B ships, no
> customer can turn multilingual on at all. Four phases of work are unreachable
> without direct database access.

## The three language layers

These are independent. Conflating any two of them is the mistake this plan
exists to prevent.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ LAYER 1 — BOT / VISITOR LANGUAGE            "What does my chatbot speak?" │
│                                                                          │
│   Chatbots → Agent → Experience → Language                    [PHASE 5B] │
│   Bot.language_config  (JSONB, per bot)                                  │
│                                                                          │
│   enabled · supported_locales · default_locale · auto_detect             │
│   allow_visitor_language_switch · operator_translation_enabled           │
│                                                                          │
│   Drives: widget UI language, widget language switcher, the language      │
│           the AI answers in, whether operator translation runs at all     │
└──────────────────────────────────────────────────────────────────────────┘
                                     │
                      operator_translation_enabled gates ↓
                                     │
┌──────────────────────────────────────────────────────────────────────────┐
│ LAYER 2 — OPERATOR TRANSLATION TARGET   "What language do I READ chat in?"│
│                                                                          │
│   Support → Live Chat → availability card              [SHIPPED PHASE 4] │
│   Operator.preferred_locale  (per operator, self-service)                │
│                                                                          │
│   Visitor messages are translated INTO this. Operator replies are         │
│   translated FROM it. "Don't translate" = read every message as written.  │
│                                                                          │
│   Phase 5A change: options come from the backend registry, not a          │
│   hardcoded array.                                                        │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ LAYER 3 — DASHBOARD INTERFACE LANGUAGE    "What language is the APP in?"  │
│                                                                          │
│   Profile → Preferences  (neither the page nor the field exists)          │
│   Client.ui_locale  (new column)                       [DEFERRED PHASE 6] │
│                                                                          │
│   Navigation, buttons, labels, tables, errors.                            │
│   MUST NOT reuse Operator.preferred_locale.                               │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why layer 2 and layer 3 must stay separate fields.** They answer different
questions for the same human. An operator who reads the OyeChats console in
English may well be the person handling Hindi visitors. Reusing
`preferred_locale` for the dashboard would force that operator into a Hindi
admin UI as the price of translating Hindi chats. `Operator.preferred_locale`
is documented in `models.py` as the live-chat working language and is read by
exactly one caller (`translation_service.resolve_incoming_target`). It stays
that way.

---

# Phase 5A — Locale Foundation

## Objective

One authoritative locale catalog, served by the backend, consumed by every
admin language selector. Removes the duplicate registries Phase 4 introduced
before there was anywhere central to put them.

## The drift being fixed

Five catalogs exist today. Three were added during Phase 4, which is why this
is the first thing Phase 5 does rather than an afterthought.

| # | Location | Entries | Added by | Action |
|---|---|---|---|---|
| 1 | `api/app/services/language_service.py` `KNOWN_LOCALES` (line 44) | 29 | Phase 1 | **Becomes the single source** |
| 2 | `widget/src/i18n/localeNames.js` `LOCALE_CATALOG` | 30 | Phase 1/2 | **Keep** (see below) |
| 3 | `widget/src/i18n/localeCatalog.js` `RTL_LANGUAGES` | 4 | Phase 1/2 | **Keep** (see below) |
| 4 | `app/src/features/inbox/liveChatHelpers.ts` `LOCALE_NAMES` | 29 | Phase 4 | **Delete** |
| 5 | `app/src/features/inbox/OperatorLanguagePicker.tsx` `OPERATOR_LOCALES` | 12 | Phase 4 | **Delete** |

#1 and #2 already disagree on count. #5 disagrees with everything and is what
makes the Support dropdown offer languages no bot supports.

**The widget catalogs stay, deliberately.** The widget is an IIFE bundle that
must render a locale's name and direction before any network call resolves, on
a customer's page, offline-capable. Fetching them would put a request on the
critical path of first paint for zero benefit. They are already parity-tested
against the backend via `NORMALIZATION_FIXTURES`, so the pair cannot silently
drift. Two catalogs under test beats five untested.

## Existing files/components

| File | Change |
|---|---|
| `api/app/services/language_service.py` — `KNOWN_LOCALES` (44), `LocaleInfo` (`schemas/language.py`) | No change. Becomes the served source of truth. |
| `api/app/main.py` | Register the new router. |
| `app/src/features/inbox/liveChatHelpers.ts` — `LOCALE_NAMES` (119), `languageLabel` (155) | Delete the constant; `languageLabel` reads from the fetched catalog. |
| `app/src/features/inbox/OperatorLanguagePicker.tsx` — `OPERATOR_LOCALES` (14) | Delete the constant; options come from the hook. |
| `app/src/features/inbox/ConversationLanguageBadge.tsx` | Already delegates to `languageLabel`; no change. |
| `app/src/services/api.js` + `api.d.ts` | Add `getLocales()`. |
| `api/app/api/operator_routes.py` — `GET /operators/me/language` (1646) | Also return the locales available to this operator. |
| `api/app/api/operator_routes.py` — `list_operators` (304), response rows built at 339-356 | Add `preferred_locale` + `supported_languages` to each row. |

## New files/components

- `api/app/api/locale_routes.py` — `GET /locales`
- `app/src/hooks/useLocaleCatalog.ts` — fetch-once + cache, exposes
  `locales`, `labelFor(code)`, `directionFor(code)`
- `api/tests/test_locale_routes.py`

## API changes

```
GET /locales                       auth: get_current_client_or_operator
→ { "locales": [
      { "code": "en", "locale": "en-IN", "name": "English (India)",
        "native_name": "English (India)", "direction": "ltr" }, … ] }
```

Serialised straight from `KNOWN_LOCALES`; the shape mirrors `LocaleInfo`
(`api/app/schemas/language.py`) field for field. Static per deploy, so the
response carries a long `Cache-Control` and the client fetches once per
session.

```
GET /operators/me/language
→ { "preferred_locale": "en-IN",
    "supported_languages": [],
    "available_locales": ["en-IN", "hi-IN"] }     ← NEW
```

`available_locales` is the union of `supported_locales` across the bots this
operator serves. That is what the Support dropdown offers.

## State / cache behaviour

`GET /locales` is deploy-static: fetched once per admin session, held in the
hook, no invalidation needed. `available_locales` is derived per request from
live bot config, so an admin adding a locale in 5B is reflected on the
operator's next load with no extra plumbing.

## UX behaviour — the Support dropdown

The control keeps its current home in the availability card. Only its options
change.

- **"Don't translate"** stays first and is the null value.
- Options = `available_locales`, labelled from the catalog.
- **A current-but-unavailable `preferred_locale` is preserved, not dropped.**
  If an operator is set to Portuguese and no bot they serve offers it any
  more, the option remains selected and is rendered as
  `Portuguese — no longer offered`. Silently resetting it would change what an
  operator reads without telling them, and re-selecting is a deliberate act.
- Helper text unchanged: *"Visitor messages are translated into X."*

## Validation rules

- Every locale written to `preferred_locale` normalises through
  `language_service.normalize_locale` (already enforced server-side at
  `PUT /operators/me/language`).
- An unknown code from the catalog renders as its uppercased tag rather than
  raw text — existing `languageLabel` behaviour, preserved.

## Tests

1. `GET /locales` returns every `KNOWN_LOCALES` entry with all five fields.
2. `GET /locales` requires auth.
3. `GET /operators/me/language` returns `available_locales` as the union
   across the operator's bots.
4. An operator serving a single-locale bot gets exactly that locale.
5. `languageLabel` resolves from the fetched catalog, and degrades to the
   uppercased tag for an unknown code.
6. The Support dropdown renders "Don't translate" plus `available_locales`.
7. A preserved-but-unavailable preference stays selected and is marked.
8. **No hardcoded locale array remains in `app/src`** — a source assertion, so
   registry #5 cannot quietly come back.

## Acceptance criteria

- [ ] `GET /locales` serves the backend catalog.
- [ ] `LOCALE_NAMES` and `OPERATOR_LOCALES` are deleted from `app/src`.
- [ ] The Support dropdown offers only locales the operator's bots support.
- [ ] An operator whose language was removed keeps it, visibly flagged.
- [ ] Widget catalogs are untouched and its bundle size is unchanged.

## Rollback considerations

Additive. Reverting restores the hardcoded arrays; no data is written by this
sub-phase, so nothing is stranded.

---

# Phase 5B — Bot Language Configuration

## Objective

Give customers the UI to turn multilingual on. This is the phase that makes
Phases 1 through 4 reachable.

## Existing files/components

Every path below was verified against the live repository.

| File | Change |
|---|---|
| `app/src/features/agents/experience/ExperiencePage.tsx` — `SECTION_TABS` (29-35: `branding \| messages \| personality \| liveChatLeads \| servicesCopy`) | Add a 6th tab `{ key: 'language', label: 'Language' }`. |
| `app/src/features/agents/experience/BotConfigSection.tsx` — cards at `LiveChatCard` (433), `LeadFormCard` (568), `ServicesCard` (659), `SmartLinksCard` (750), `WidgetCopyCard` (855); loads `getBot(botId)` (108), saves per-slice `updateBot(saveBotId, buildPatch())` (142) | **This is the file to extend.** `language_config` is its own `Bot` JSONB column, directly analogous to `bant_config`, and this file's independent-slice PATCH pattern already handles exactly that shape. Add `LanguageCard` beside the existing five. |
| `app/src/features/agents/experience/botConfig.ts` — patch builders `liveChatPatch` (273), `leadFormPatch` (285), `servicesPatch` (292), `answerLinksPatch` (300), `copyPatch` (304) | Add `languagePatch(config)` as a sixth, same shape. |
| `app/src/features/agents/experience/types.ts` | Add the `language_config` shape to the bot draft type. |
| `app/src/hooks/useLocaleCatalog.ts` (from 5A) | Supplies the options for both selectors. |

**Not `MessagesSection.tsx`.** That edits `widget_messages` (customer-authored
copy) through a different save path. Language is bot configuration.

## New files/components

- `app/src/features/agents/experience/LanguageCard.tsx`
- `app/src/features/agents/experience/languageConfig.test.ts`

## API changes

**None.** Verified against the live repository:

- `PATCH /bots/{bot_id}` already accepts `language_config` as a
  `BoundedJsonObject` (`bot_routes.py:510`) — no allow-list work, contrary to
  the previous draft's open question.
- It **shallow-merges** rather than replacing (`bot_routes.py:2473-2476`), so a
  partial patch cannot wipe unrelated keys.
- It **already validates** the enabled/operator-translation dependency on the
  *merged* result and returns 422 (`bot_routes.py:2487-2493`).

The UI writes through the existing `updateBot` client call.

## State / cache behaviour

**Already correct — do not add anything.** `bot_routes.py:2555` calls
`cache_delete(bot_config_key(bot.bot_key))` immediately after the commit, in
the same handler that merges `language_config`. Every save through the UI
propagates to the widget on its next `GET /bots/settings/public`.

The 10-minute `BOT_CONFIG_TTL` staleness seen during Phase 4 testing was
caused by writing to the database with a script, bypassing the API entirely.
It is not a gap in the save path and needs no second invalidation.

## UX behaviour

```text
Language

  ⬤ Multilingual                                          [ on/off ]
    Let visitors chat in their own language.

    ── everything below is disabled while multilingual is off ──

    Supported languages
      [ English (India) ×] [ हिन्दी ×]            [ + Add language ▾ ]

    Default language        [ English (India) ▾ ]
      Used when a visitor's language can't be determined.

    ☑ Detect the visitor's language automatically
    ☐ Let visitors switch language in the widget
        (disabled, with reason, while fewer than 2 supported languages)

    ☑ Translate live chat for operators
        Visitor messages are shown to your team in their own working
        language, and replies are translated back.
```

Disabled-not-hidden while multilingual is off: a customer must be able to see
what turning it on will give them.

## Validation rules

Enforced in the UI so the customer never meets the server's 422:

| Rule | Behaviour |
|---|---|
| `default_locale ∈ supported_locales` | Default selector's options are the supported list. Removing the current default auto-promotes the next remaining locale. |
| `supported_locales` non-empty when enabled | The last chip cannot be removed; save blocked with an inline reason. |
| `allow_visitor_language_switch` needs ≥2 locales | Control disabled below two, with the reason shown. A switcher with one option is meaningless. |
| `operator_translation_enabled` requires `enabled` | Nested under the master toggle; clears when multilingual is turned off. |
| Turning multilingual **off** | Confirm, stating what stops: widget selector hides, the AI reverts to its default language, operator translation stops. **Existing sessions keep their `language_code`** — the column is not cleared, so re-enabling restores them. |

## Tests

1. `languagePatch` emits only the `language_config` slice.
2. Round-trip: load `language_config` → edit → save → reload matches.
3. Removing the default locale from supported auto-promotes a new default.
4. The last supported locale cannot be removed while enabled.
5. Visitor-switch control is disabled at fewer than 2 locales.
6. `operator_translation_enabled` cannot be set while `enabled` is false.
7. Turning multilingual off clears `operator_translation_enabled` in the patch.
8. Disabled state renders every control read-only, not absent.
9. Backend: a partial `language_config` PATCH preserves untouched keys
   (pins the shallow-merge).
10. Backend: `operator_translation_enabled: true` with `enabled: false`
    returns 422 (already-passing regression, re-asserted from the UI path).

## Acceptance criteria

- [ ] An admin can enable multilingual, pick supported and default locales,
      and set all three toggles, entirely through the UI.
- [ ] Saving invalidates the bot-config cache; the widget picks it up on next
      load with no deploy.
- [ ] `default_locale` can never be outside `supported_locales`.
- [ ] The 422 dependency is unreachable from the UI.
- [ ] No IP confidence scores, classifier internals, or embedding details are
      exposed — human-readable controls only.
- [ ] Turning multilingual on for a fresh bot makes the Phase 2 widget
      selector and Phase 3 AI behaviour activate with no code change.

## Rollback considerations

Purely additive UI over an existing column. Reverting the admin build removes
the tab; stored `language_config` values keep working because Phases 1–4 read
them directly.

---

# Phase 5C — Analytics

## Objective

Make language a dimension customers can see, using only data the schema
already produces.

## Existing files/components

| File | Change |
|---|---|
| `api/app/api/analytics_routes.py` — existing `@router.get` endpoints (`/dashboard` 137, `/ratings-summary` 291, `/resolution-summary` 308) | Add a `/language-breakdown` endpoint following the same shape. |
| `api/app/db/models.py` — `ChatSession` indexes | Add `ix_chat_sessions_bot_language_created`. |
| `app/src/features/agents/analytics/` — `LeadsBreakdown.tsx`, `SatisfactionBreakdown.tsx`, `analytics.types.ts`, `useAgentAnalytics.ts`, `chartTheme.tsx` | Add a `LanguageBreakdown.tsx` following the existing breakdown pattern. |

## New files/components

- `app/src/features/agents/analytics/LanguageBreakdown.tsx`
- `api/alembic/versions/<rev>_chat_session_language_index.py`

## Metrics — only what the data supports

| Metric | Source | Ready |
|---|---|---|
| Conversations by language | `ChatSession.language_code` | ✅ Phase 2 |
| AI resolution by language | `language_code` × `visitor_resolved` | ✅ |
| Live-chat volume by language | `language_code` × `status` | ✅ |
| Translation requests / ok / failed | `translation_requests`, `translation_ok`, `translation_failed`, `translation_timeout` counters | ✅ Phase 4 |
| Translation tokens & cost | `translation_tokens_prompt` / `_completion` + `credit_cost.translation` ledger rows | ✅ Phase 4 |

**Explicitly excluded: operator language capability.** `supported_languages`
has no UI in this phase and is empty for every operator, so the chart would be
blank for every customer. It returns when routing needs it.

## API changes

```
GET /analytics/language-breakdown?bot_id=<id>&period=30d
    auth: get_current_client_or_operator   (same dependency as the
          neighbouring analytics endpoints)
→ { "conversations": [ { "language_code": "hi", "label": "Hindi",
                         "total": 412, "resolved": 301, "live_chat": 88 },
                       { "language_code": null, "label": "Not detected",
                         "total": 96,  "resolved": 71,  "live_chat": 4 } ],
    "translation": { "requests": 1240, "ok": 1198, "failed": 42,
                     "tokens_prompt": 88120, "tokens_completion": 41030,
                     "credits": 1198 } }
```

Labels are resolved SERVER-SIDE from `KNOWN_LOCALES`, never sent as a raw code
for the client to guess at, matching how Phase 3 and Phase 4 resolve display
names. `language_code: null` is returned as a real row so the totals reconcile
with the dashboard's conversation count rather than quietly under-reporting.

No new write routes. This sub-phase is read-only.

## State / cache behaviour

None. The endpoint queries Postgres directly, like the neighbouring analytics
endpoints. Translation counters come from the existing Redis metric buckets
(`app/core/metrics.py`, ~26h TTL), so the translation panel shows a rolling
window rather than all-time and must be labelled as such.

No cache invalidation is involved: nothing here is cached, and the bot-config
cache is unrelated to analytics.

## UX behaviour

A `LanguageBreakdown` card on the agent Analytics page, following
`LeadsBreakdown.tsx` / `SatisfactionBreakdown.tsx`.

- Hidden entirely when the bot has multilingual off. A single "English 100%"
  row is noise, not insight.
- Rows sorted by conversation volume, "Not detected" always last regardless of
  size, so it reads as a residual rather than a language.
- The translation panel renders only when `operator_translation_enabled` is on,
  and states the rolling window explicitly ("last 24 hours").

## Validation rules

- `bot_id` is ownership-checked against `auth["client_id"]`, matching every
  other analytics endpoint.
- An unknown `language_code` (a locale later removed from `KNOWN_LOCALES`)
  renders as its uppercased tag rather than being dropped, so historical data
  never silently vanishes from the totals.

## Database changes

```python
Index(
    "ix_chat_sessions_bot_language_created",
    "bot_id", "language_code", created_at.desc(),
)
```

Idempotent-guard migration using `sa.inspect(op.get_bind()).get_indexes(TABLE)`,
same template as the Phase 1/2/4 column guards. Pure performance index, no
application dependency.

## Tests

1. `/language-breakdown` returns counts grouped by `language_code`.
2. Sessions with `language_code IS NULL` (multilingual off) are grouped as
   "Not detected" rather than dropped, so totals reconcile with the dashboard.
3. Tenant isolation: the endpoint never returns another workspace's sessions.
4. Migration upgrade → downgrade → upgrade in one process.
5. `EXPLAIN ANALYZE` confirms the new index is used.

## Acceptance criteria

- [ ] A customer with multilingual on sees conversations broken down by
      language.
- [ ] Translation usage and cost are visible.
- [ ] NULL-language sessions reconcile against total conversation count.
- [ ] The breakdown query uses the new index.

## Rollback considerations

The index drops cleanly. The endpoint and component are additive.

---

# Phase 6 — Dashboard Interface i18n (DEFERRED)

**Not in Phase 5. Recorded here so the gap is not mistaken for an oversight.**

Translating the admin application itself is a separate, larger initiative than
all of Phase 5. Two facts, both verified against the live repository:

1. **There is no i18n infrastructure in `app/`.** No `app/src/i18n` directory,
   no i18next, no react-intl, no `useTranslation`. Every string in the admin
   dashboard is hardcoded English — roughly 4,800 lines in the inbox feature
   alone.
2. **There is no personal Profile or Preferences page.** Workspace contains
   General, Members, Billing, Usage, Reports, API Keys, Integrations,
   Affiliate (`app/src/app/routes.tsx:135-148`), and `GeneralPage` is
   explicitly *workspace* identity, not personal settings.

So Phase 6 needs: an i18n library, a full extraction pass, at least one
complete translated dictionary, a new Profile route, and a new
`Client.ui_locale` column.

**It must not reuse `Operator.preferred_locale`.** That field is the live-chat
translation target. Reusing it would force an operator who handles Hindi
visitors to run their entire admin console in Hindi.

Deferred because it delivers nothing to the *visitor* experience, which is
what the multilingual programme is for. Layers 1 and 2 make the product work
in Hindi for customers; layer 3 makes the console prettier for internal staff.

---

# Explicitly out of scope for Phase 5

| Item | Why |
|---|---|
| Dashboard interface language | Phase 6. See above. |
| "Languages I speak" UI (`supported_languages`) | No consumer. Language-aware routing is Release 3. Building an editor for a field nothing reads is premature; the column and its `PATCH /operators/{id}` support already exist for when routing arrives. |
| Operator language on `MembersPage.tsx` | Wrong owner. `preferred_locale` is a personal reading preference, self-service in Support → Live Chat (Phase 4). An admin must not set what language a colleague reads in. |
| Language-aware operator routing | Release 3. |
| `document.language` / localized KB | Source plan §28, optional future. |
| Routing-filter documentation comment | Trivial; no reason to schedule. |
| New locale catalog in the widget | The widget's bundled catalog is deliberate (offline, first paint). |

---

# Behavioural decisions

**An operator's target language is not in the bot's supported list.**
Nothing breaks: `resolve_incoming_target` reads `preferred_locale` and
translates into it regardless. `supported_locales` constrains *visitor*
locales only. The dropdown flags it rather than resetting it (5A).

**An admin removes a supported locale that is in use.**
Sessions already locked to it keep it (`language_locked`); new sessions fall to
`default_locale`. Operator preferences are untouched. The UI warns on save if a
live session is using the removed locale.

**Multilingual is turned off.**
Widget selector hides (already gated on `enabled`); the AI reverts
byte-identical to pre-Phase-3 because
`_resolve_visitor_language_and_update_session` returns `None`; operator
translation stops because `is_translation_enabled` requires both flags;
existing sessions keep `language_code`, so re-enabling restores them.

---

# Implementation order

| | Sub-phase | Why this order |
|---|---|---|
| 1 | **5A — Locale Foundation** | Small, and it removes drift Phase 4 introduced. 5B's two selectors need the catalog. |
| 2 | **5B — Bot Language Configuration** | The real deliverable. Until this ships, multilingual cannot be enabled without database access. |
| 3 | **5C — Analytics** | Depends on nothing above, but is only meaningful once customers can actually enable multilingual. |
| — | **Phase 6 — Dashboard i18n** | Separate initiative. |

If only one sub-phase ships, it must be **5B**.

---

# Dependencies on previous phases

- **Phase 1** — `Bot.language_config`, `KNOWN_LOCALES`, `normalize_locale`.
- **Phase 2** — `ChatSession.language_code`; the widget selector 5B toggles.
- **Phase 3** — AI language behaviour 5B toggles; makes "AI resolution by
  language" meaningful.
- **Phase 4** — `Operator.preferred_locale`, the Support dropdown 5A rewires,
  and the translation metrics 5C reports.
