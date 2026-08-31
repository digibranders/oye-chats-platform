# OyeChats Multilingual Feature — Implementation Roadmap

This directory is the phased implementation plan for adding multilingual support to
OyeChats: the visitor widget, the AI/RAG pipeline, live operator chat, and the admin
dashboard. It replaces the flat 44-section planning draft
(`oyechats_multilingual_detailed_implementation_plan.md`) with seven
independently reviewable phase documents, each grounded in the actual repository
state as of 2026-08-22 (branch `development`), with Phase 7 added on 2026-08-25.

Each phase document (`phase-N-*.md`) follows the same template: Objective, Scope /
Non-scope, Existing files affected, New files required, DB/schema changes, API/
WebSocket changes, Frontend changes, Backend/service changes, Dependencies on
previous phases, Exact implementation steps, Acceptance criteria, Testing/QA
requirements, Risks and edge cases, Rollback considerations.

## Phase ownership

Each phase owns exactly one body of work. They are not interchangeable, and two
of them have been confused for each other before, so the boundary is stated
explicitly here.

| Phase | Owns | Document |
|---|---|---|
| **Phase 1** | Language Foundation | [phase-1-language-foundation.md](phase-1-language-foundation.md) |
| **Phase 2** | Widget + Visitor Language | [phase-2-widget-localization.md](phase-2-widget-localization.md) |
| **Phase 3** | Multilingual AI/RAG | [phase-3-multilingual-ai-rag.md](phase-3-multilingual-ai-rag.md) |
| **Phase 4** | Operator Translation | [phase-4-operator-translation.md](phase-4-operator-translation.md) |
| **Phase 5** | Admin Language Configuration + Analytics | [phase-5-admin-analytics.md](phase-5-admin-analytics.md) |
| **Phase 6** | Hardening, Testing & Production Rollout | [phase-6-testing-rollout.md](phase-6-testing-rollout.md) |
| **Phase 7** | Admin Dashboard i18n | [phase-7-admin-dashboard-i18n.md](phase-7-admin-dashboard-i18n.md) |

**Phase 6 and Phase 7 are separate bodies of work and must not be merged.**
Phase 6 hardens and rolls out the conversation-language feature built in Phases
1 to 5; it ships no new product surface. Phase 7 localizes the admin SPA's own
interface, which is a new product surface and was unplanned until 2026-08-25.

## Why seven phases, not one plan

The original draft is directionally correct — three independent language layers
(widget UI locale, conversation language, operator/dashboard locale), an ordered
resolution strategy, BCP-47 locales, no per-language vector DBs, translation as an
abstraction — but it interleaves 30 "phases" that mix foundation work with
optional V3 features, and it assumes file paths that don't match the current repo
(most importantly: the admin dashboard's Admin Platform 2.0 rebuild is **already
complete** for every area this feature touches, and the widget's production entry
point is not `main.jsx`). Splitting into six phases fixes both problems: each phase
ships a coherent, testable, revertible increment, and each is scoped to files that
actually exist today.

## Phase order and dependency graph

```
Phase 1: Language Foundation & Data Model
   (language_service.py, Bot.language_config, public settings exposure)
        │
        ├──────────────────────────────┐
        ▼                               ▼
Phase 2: Widget Localization &   Phase 5: Admin Configuration
Visitor Language                  & Analytics (Bot config UI can
   (ChatSession language          start once Phase 1 lands the
   columns, widget i18n,          Bot.language_config column;
   language resolver)             full analytics needs Phase 2+3
        │                          session data)
        ▼                               │
Phase 3: Multilingual AI/RAG            │
   (build_hybrid_prompt language        │
   directive, QA cache key,             │
   qualification cta_prompt copy)       │
        │                               │
        ▼                               │
Phase 4: Operator Multilingual          │
Live Chat (ChatMessage/Operator         │
   columns, translation_service,        │
   WS protocol, inbox UI) ◄─────────────┘
        │
        ▼
Phase 6: Hardening, Testing & Production Rollout
   (feature flags, E2E coverage, perf/telemetry, staged rollout)


Phase 7: Admin Dashboard i18n            <- independent of Phase 6
   (app/src/i18n runtime, admin_ui_translated,
   Settings language selector, formatter layer)
        ▲
        └── depends on Phase 5's GET /locales catalogue only
```

- **Phase 1 is a hard prerequisite for everything else.** It is pure foundation:
  one new JSONB column on `Bot`, one new service module, one new schema module,
  and one new key in an existing public API response. Old bots get
  `language_config = {}` and behave exactly as today.
- **Phase 2 and Phase 5 can start in parallel once Phase 1 lands**, but Phase 5's
  operator-preference and analytics work depends on data Phase 2 (session
  language) and Phase 4 (message/operator language) produce, so Phase 5 will
  land in two sub-slices in practice (bot config UI first, analytics/routing
  prep last).
- **Phase 3 depends on Phase 2** because it consumes the `ChatSession` language
  columns Phase 2 introduces (it does not add new schema itself).
- **Phase 4 depends on Phase 3** conceptually (visitor language must already be
  resolved and the AI must already answer natively before operator translation
  is useful) but not on Phase 3's code changes directly — it can be built in
  parallel with Phase 3 if needed, since it touches a disjoint set of files
  (`live_chat_service.py`, `ws_routes.py`, `translation_service.py` vs.
  `rag_service.py`, `response_style.py`).
- **Phase 6 runs last for the conversation-language feature** and is mostly
  non-code: feature-flag gating, the test matrix, performance telemetry, and the
  staged rollout sequence. It touches every phase's code but adds no new product
  surface.
- **Phase 7 is independent of Phase 6** and does not block it. It depends only on
  Phase 5's `GET /locales` catalogue, so the two may run in either order or in
  parallel. Phase 6 hardens what visitors and operators experience; Phase 7
  translates the chrome the customer administers it through. Phase 7 must not
  modify anything Phases 1 to 5 own, and in particular must never touch
  `Operator.preferred_locale`.

## Release mapping

| Release | Phases | What ships |
|---|---|---|
| Release 1 — AI multilingual MVP | 1, 2, 3 (+ Phase 6 flag/testing work scoped to these) | Bot language config, widget auto-detect + manual selector, AI answers natively in the visitor's language, localized widget/system copy, RTL foundation. No operator translation. |
| Release 2 — Multilingual live chat | 4 (+ Phase 6 scoped to it) | Operator language preference, incoming/outgoing translation, translation caching, original/translated toggle, WebSocket language metadata. |
| Release 3 — Global intelligence | 5 (routing/analytics slices) | Language analytics, language-aware operator routing, localized knowledge metadata (optional, not required). |
| Release 4: Localized dashboard | 7 | The admin application's own interface in the customer's language: UI-language selector, localized shell and daily-operational surfaces, locale-aware date/number formatting. Independent of Releases 1 to 3. |

## Non-negotiable architectural rules (carried from the source plan, verified against the repo)

1. **Explicit selection > website locale > `<html lang>` > trusted first-message
   detection > browser language > persisted preference > bot default.**
   Once a visitor explicitly picks a language, it is authoritative until they
   change it again.

   > **Corrected 2026-08-31.** The order above is what the code does today
   > (`api/app/api/chat_routes.py:278`, `_DETECTION_OVERRIDABLE_SOURCES`), and it
   > differs from the source plan in two ways.
   >
   > **Message detection moved up, above `browser` and `persisted`.** Leaving it
   > below them made it dead code: `resolve_initial_locale` consults
   > `Accept-Language`, every browser sends one, and any `en-*` header matches a
   > bot offering `en-IN`, so the resolved source was `browser` for essentially
   > every real visitor and detection never ran. A visitor typing pure Devanagari
   > was pinned to English and answered in English. It now outranks exactly the
   > two weak tiers — a header the browser sends and a value carried over from a
   > previous visit are not statements about what this visitor is typing right
   > now — and still loses to an explicit choice and to a locale the customer
   > declared (`site` / `html_lang`).
   >
   > **There is no `geo` tier.** `resolve_initial_locale`
   > (`api/app/services/language_service.py:359`) has five candidate tiers plus
   > the default and never consults IP geo; `LanguageContext.source` still lists
   > `geo` as a legal value but nothing ever emits it. This is consistent with
   > rule 4 below, not a gap.
   >
   > The `browser`, `html_lang` and detection tiers are additionally gated on the
   > bot's `language_config.auto_detect` flag — the dashboard's "Detect the
   > visitor's language" toggle, which until 2026-08-31 was written by the admin
   > UI and read by nothing.
2. **Language is a conversation property**, not an app-wide setting. Widget UI
   locale, conversation language, and operator/dashboard locale are three
   independent state slices, confirmed nowhere conflated in the current
   codebase. **This was greenfield when written; it no longer is.** As of
   2026-08-25 the shipped infrastructure is `api/app/services/language_service.py`
   (`KNOWN_LOCALES`, `WIDGET_UI_LANGUAGES`), `api/app/api/locale_routes.py`
   (`GET /locales`), `widget/src/i18n/` (the full widget runtime), and
   `app/src/services/localeCatalog.ts` (the dashboard's registry client). Phase 7
   extends that, and must not start a second registry.
3. **No per-language vector indexes.** The existing pgvector schema and
   `gemini-embedding-001` embeddings are multilingual-capable already; RAG stays
   unified (`api/app/services/rag_service.py`).
4. **IP/geo is a low-confidence fallback, never the primary signal.** The repo
   actually has *three* separate IP/geo mechanisms, not one — see
   [phase-2-widget-localization.md](phase-2-widget-localization.md) §4 for the
   correction to the source plan's assumption.
5. **`TranslationService` is an abstraction from day one** — provider-swappable,
   isolated from `ws_routes.py`/`live_chat_service.py`/React components. See
   [phase-4-operator-translation.md](phase-4-operator-translation.md).
6. **Original message content is immutable.** Translations are always additive
   (`ChatMessage.translations` JSONB, `OperatorMessage.translatedContent` in the
   admin UI type), never a replacement of stored content.
7. **RTL and BCP-47 locale strings (`hi-IN`, not `Hindi`) from the start** — see
   the direction/locale metadata in `language_service.py` (Phase 1).
8. **Backward compatibility is mandatory.** Every new column is nullable or has
   a JSONB default of `{}`/preset; every existing bot without `language_config`
   must behave identically to today. This mirrors the existing `bant_config`
   pattern in `api/app/services/qualification_service.py:577-580`
   (`cfg = bot.bant_config or {}`, then `.get(key, default)`).

## Key corrections this roadmap makes to the source planning draft

These were discovered during codebase inspection (five parallel research passes
over `api/`, `widget/`, and `app/`) and materially change where work should land:

- **Admin dashboard paths are wrong in the source draft.** `app/src/pages/*`
  (Settings.jsx, Chatbot.jsx, LiveChat.jsx, Leads.jsx, Billing.jsx,
  Qualification.jsx) **do not exist**. The Admin Platform 2.0 rebuild described
  in [app/CLAUDE.md](../../app/CLAUDE.md) is already complete for every area
  this feature touches: bot experience/branding config lives in
  `app/src/features/agents/experience/*` (all `.tsx`), and the live-chat inbox
  lives in `app/src/features/inbox/*` (all `.tsx`/`.ts`). Every admin-side
  path in phase-4 and phase-5 docs below points at the real, current files.
- **Widget production entry is not `main.jsx`.** `widget/src/main.jsx` is
  dev-server-only. Production ships as `widget/src/loader.js` (tiny IIFE, built
  by `vite.loader.config.js`, 8KB gzip budget) plus `widget/src/app-entry.jsx`
  (ESM, dynamically imported, built by `vite.app.config.js`). The widget mounts
  into a **Shadow DOM** (`ensureShadowAndStyles()` in `app-entry.jsx`), which
  matters for `dir="rtl"` and any `<html lang>`-style styling decisions.
- **A public `window.OyeChats` API already exists** (`init/open/close/toggle/
  send/identify/shutdown/boot/update/on/off/once/diagnose`, built in
  `app-entry.jsx`'s `buildPublicApi()`, backed by the `widget-controller.js`
  singleton). Phase 2 should extend this existing surface (`update({locale})`)
  rather than invent a parallel `setLocale()`/`getLocale()` pair from scratch.
- **`QueueWaitingScreen.jsx` is dead code.** It exists and is fully built but is
  imported nowhere in `widget/src`. The actual "waiting for operator" copy is
  inline inside `ChatWindow.jsx`. Phase 2 localizes the inline copy, not the
  orphaned component (see phase-2 risks section for the decision this forces).
- **IP/geo is three unrelated systems**, not one: `api/app/core/geo.py`
  (header-based country, billing-only), `api/app/services/ip_intel_service.py`
  (paid B2B company/threat intel, no country field at all), and
  `_resolve_and_update_location()` in `api/app/api/chat_routes.py:521-751`
  (the actual free-tier city/country lookup, written to `ChatSession.location`
  as an unstructured string). None is currently wired into the live-chat
  WebSocket path.
- **`/chat/stream` has no Pydantic response schema** — it's a raw SSE stream
  (`METADATA:{json} → text chunks → FINAL_METADATA:{json}`), documented only in
  the route docstring at `api/app/api/chat_routes.py:1276`. `ChatRequest`
  (`api/app/schemas/chat.py`, 29 lines total) is the only schema to extend.
- **The AI already implicitly mirrors the visitor's language today**, with zero
  configuration surface: `api/app/services/response_style.py` lines 267-278
  ("LANGUAGE & LOCALE" section of `RESPONSE_STYLE_BLOCK`) instructs the LLM to
  reply in whatever language the visitor writes in. Phase 3 formalizes and
  strengthens this (explicit `LanguageContext`, per-bot enforced language,
  cache-key correctness) rather than building it from nothing.
- **`qualification_service.py` has ~20 hardcoded English `cta_prompt` strings**
  (lines 39, 60, 73, 86, 105, 118, 131, 144, 157, 170, 196, 209, 222, 235, 253,
  265, 277, 289, 301, 313, 325) that are quick-reply pill labels, not
  LLM-generated text. These need the same localization treatment as
  `widget_messages` — flagged explicitly in Phase 3.
- **Two Alembic heads have existed recently** (a merge migration
  `e8bf7678526d_merge_chat_session_probe_branch_with_.py` was needed on
  2026-08-22 to reconcile a fork). Every phase's migration steps below start
  with `alembic heads` — verify a single head before branching a new revision.

## What "Definition of Done" means per phase

Each phase document has its own acceptance criteria. The feature as a whole is
production-ready only when every phase's criteria are met **and** Phase 6's
rollout flag has reached 100% — see
[phase-6-testing-rollout.md](phase-6-testing-rollout.md) for the full checklist
carried over from the source plan's §41.
