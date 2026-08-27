# Phase 6 — Hardening, Testing & Production Rollout

## Objective

Gate the entire feature behind rollout flags, close the test matrix across
all five prior phases, add performance telemetry, and roll out gradually.
This phase ships no new product surface — it's the safety net around Phases
1-5.

## Scope

- Feature-flag gating (`bot.language_config.enabled` and
  `operator_translation_enabled`, already defined in Phase 1/4 — this phase
  adds the rollout *process* around them, plus an optional platform-wide kill
  switch).
- Full test matrix: unit, widget, backend, RAG, live-chat, E2E.
- Performance telemetry: `language_resolution_ms`, `language_detection_ms`,
  `translation_ms`, `translation_cache_hit`.
- Security/privacy audit pass against the rules in the README.
- Staged rollout: internal bots → demo bots → 5% → 25% → 50% → 100%.

## Non-scope

- No new functional code — if this phase surfaces a functional gap, that's a
  finding to route back to the relevant Phase 1-5 document, not something to
  patch in-place here.

## Existing files/components affected

| File | Change |
|---|---|
| `api/app/config.py` (per root `CLAUDE.md`, this is where env-var/feature-flag config lives) | Add a platform-wide `MULTILINGUAL_CHAT_KILL_SWITCH` env var (default off = feature available per-bot as configured; on = force-disable regardless of any bot's `language_config.enabled`) — a coarser, faster lever than per-bot toggling if a systemic issue appears in production. |
| Every file touched in Phases 1-5 | No further changes expected; this phase is test/telemetry/flag work layered on top. |

## New files/components required

- Test suites (unit/integration/E2E) as enumerated below — file locations
  follow each phase's existing test conventions (`api/tests/` structure for
  backend, widget's existing test setup, admin's existing `*.test.tsx`
  convention already used throughout `app/src/features/workspace/billing/*`).
- Telemetry instrumentation is added inline in the relevant Phase 1-4 service
  files (`language_service.py`, `chat_routes.py`, `translation_service.py`),
  not a new module.

## Database/schema changes

None. If the security/privacy audit calls for an audit-log entry on language
changes (optional per Phase 2's notes), that's implemented here by writing to
the existing `ChatAuditLog` model — no new table.

## API/WebSocket changes

None new. Telemetry is logged (Langfuse/Sentry, per root `CLAUDE.md`'s
observability stack), not exposed as new API surface.

## Frontend changes

None new, beyond whatever fixes the test matrix surfaces.

## Backend/service changes

Telemetry additions:
- `language_service.resolve_initial_locale` / `_resolve_visitor_language`
  (Phase 2): record `language_resolution_ms`.
- `language_service.detect_message_language` (Phase 3): record
  `language_detection_ms`, only logged when actually invoked (should be rare
  once sessions have persisted language, per Phase 2/3's skip-when-known
  rule — a spike in this metric signals the skip logic regressed).
- `translation_service.translate` (Phase 4): record `translation_ms`,
  `translation_cache_hit` (bool), `translation_provider`,
  `translation_status`. Per the source plan's privacy rule, never log raw
  message content in these metrics — provider/latency/status only.

Kill switch check: add a single guard at the top of
`_resolve_visitor_language` (Phase 2) and `TranslationService.translate`
(Phase 4) — `if settings.MULTILINGUAL_CHAT_KILL_SWITCH: return <disabled
behavior>` — cheap, centralized, and independent of any per-bot config state.

## Dependencies on previous phases

All of Phase 1-5 must be code-complete (though not necessarily 100% rolled
out) before this phase's full test matrix can run meaningfully — Phase 6 is
explicitly the last phase in the dependency graph in
[README.md](README.md).

## Exact implementation steps

1. Add `MULTILINGUAL_CHAT_KILL_SWITCH` to `config.py` and wire the guard into
   Phase 2 and Phase 4's entry points.
2. Add telemetry fields listed above.
3. Write/run the full test matrix (below).
4. Run a manual security/privacy pass against the checklist below.
5. Enable for internal OyeChats bots only; verify telemetry looks sane for a
   few days.
6. Enable for OyeChats demo bots (public-facing, higher traffic, still
   internally owned).
7. Roll to 5% of customers (bot-level or client-level cohort, via
   `bot.language_config.enabled` set programmatically for the cohort, not a
   customer-facing self-serve toggle yet if the admin UI ships gated
   separately — coordinate with Phase 5's rollout).
8. 25% → 50% → 100%, monitoring `language_resolution_ms`/`translation_ms`/
   error rates at each step, with the kill switch as the emergency stop.

## Acceptance criteria (Definition of Done — full feature)

Carried from the source plan's §41, verified against this repo's actual
implementation:

- [ ] Bot admin can configure default and supported languages (Phase 5).
- [ ] Widget can auto-resolve language (Phase 2).
- [ ] Visitor can manually change language (Phase 2).
- [ ] Explicit visitor language persists across navigation/reconnects
      (Phase 2).
- [ ] AI consistently answers in the active conversation language (Phase 3).
- [ ] RAG works across language boundaries without duplicated vector indexes
      (Phase 3 — confirmed no new pgvector indexes were introduced anywhere
      in Phases 1-5).
- [ ] Widget system messages are localized (Phase 2).
- [ ] Website developers can provide locale at initialization
      (`OyeChats.init({locale})`, Phase 2).
- [ ] Website developers can call `OyeChats.update({locale})` at runtime
      (Phase 2 — reusing the existing public API rather than a new
      `setLocale()`).
- [ ] `ChatSession` persists locale/language/source/confidence (Phase 2).
- [ ] Message history retains original language metadata (Phase 4).
- [ ] Operator has a preferred language (Phase 4/5).
- [ ] Operator can view translated visitor messages (Phase 4).
- [ ] Operator replies can be translated to visitor language (Phase 4).
- [ ] Original message is never overwritten (Phase 4).
- [ ] Translation failure does not break live chat (Phase 4).
- [ ] RTL languages render correctly (Phase 2).
- [ ] Analytics can segment conversations by language (Phase 5).
- [ ] Existing bots continue working unchanged with multilingual disabled
      (every phase's default-`false`/nullable-column backward-compatibility
      guarantee).
- [ ] Unit, API, WebSocket, and Playwright E2E coverage passes (this phase).
- [ ] Multilingual feature is protected by rollout flags (this phase).

## Testing/QA requirements

**Unit tests**
- Language resolution precedence matrix (explicit > site > html_lang >
  browser > persisted > message-detected > geo > default) — Phase 1/2.
- Locale normalization matrix (`en-US`, `en → en-IN if supported`,
  `en-CA → en-IN if only en-IN supported`, `fr-CA → fr-FR if only fr-FR
  supported`) — Phase 1.
- RTL matrix (`ar/he/fa/ur → rtl`, `en → ltr`) — Phase 1.

**Widget tests** (Phase 2)
- Selector opens; locale changes correctly; strings re-render; locale
  persists after refresh, launcher close/reopen, and SPA navigation; host
  `OyeChats.update({locale})` works; unsupported locale falls back gracefully.

**Backend tests** (Phases 2-5)
- Session ownership on `POST /chat/language`; explicit-locale persistence;
  detection-only-when-necessary (assert `detect_message_language` is *not*
  called when `session.language_code` is already set); language lock;
  changing language mid-session; public settings serialization unchanged
  key-set-plus-one for old bots; old bots remain behaviorally unchanged
  end-to-end.

**RAG tests** (Phase 3) — the full matrix from that phase's document.

**Live-chat tests** (Phase 4) — the full matrix from that phase's document,
plus the failure-injection test (translation provider outage).

**E2E (Playwright)** — minimum journeys, per source plan §33.6:
1. First visit / browser language.
2. Manual language selection.
3. Website locale override (`OyeChats.init({locale})`).
4. AI response language.
5. Language change mid-conversation.
6. Refresh + restored language.
7. Live handoff + translation.
8. Operator reconnect (confirm no redetection — reads persisted state).
9. RTL language.
10. Unsupported locale fallback.

## Risks and edge cases

- **Performance regression on every chat request.** The target path when
  session language is already known must add **zero** extra language-
  detection or translation calls (source plan §29) — verify via the
  `language_detection_ms` telemetry staying near-zero in steady state, not
  just in a synthetic test.
- **Cache-key change from Phase 3** is the single highest-risk deploy item in
  this entire feature for pre-existing bots — re-verify the "no forced cache
  invalidation for `enabled=false` bots" acceptance criterion from Phase 3
  specifically during the internal-bots rollout stage, before touching real
  customer traffic.
- **Kill switch scope** — confirm `MULTILINGUAL_CHAT_KILL_SWITCH` is checked
  in both the REST path (`chat_routes.py`) and the WebSocket path
  (`live_chat_service.py`/`translation_service.py`) — a kill switch that only
  covers one path is not a real kill switch.

## Rollback considerations

- Every phase's rollback path is documented in its own file; this phase's
  specific addition is the **kill switch**, which is the fastest rollback
  lever available (no deploy needed, flip an env var) and should be the
  first response to any production incident during rollout, before
  considering a code revert or migration downgrade.
- Rollout sequence is designed to be reversible at every step — dropping from
  50% back to 5% (or to 0% via the kill switch) requires no schema or code
  change, only flipping the cohort flag / kill switch.
