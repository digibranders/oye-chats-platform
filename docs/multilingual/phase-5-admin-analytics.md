# Phase 5 — Admin Configuration & Analytics

## Objective

Give admins a UI to configure per-bot language settings, give operators a UI
to set their language preferences, and expose language as an analytics
dimension. Prepare (but do not require) language-aware operator routing.

## Scope

- Admin "Language & Localization" configuration section on the bot Experience
  page, editing `Bot.language_config` (Phase 1's column).
- Operator "Languages I speak" / preferred-language UI on the workspace
  members page, editing `Operator.preferred_locale`/`supported_languages`
  (Phase 4's columns).
- Language dimension in conversation/session analytics.
- `chat_sessions(bot_id, language_code, created_at)` index, added now that
  Phase 2/3 are producing real data to query.
- Document (not necessarily ship) the language-aware routing filter shape in
  `live_chat_routing_service.py`.

## Non-scope

- Actually implementing language-aware routing (documented as a follow-up,
  same status as the department-aware filtering the module's own docstring
  already flags as future work) — this is Release 3 scope per the README's
  release mapping, not required for V1.
- Localized knowledge-base documents / `document.language` metadata (source
  plan §28's "optional future enhancement" — explicitly out of scope here).
- Regional currency/date/number formatting beyond what Phase 2's
  `widget/src/i18n/formatters.js` already does.

## Existing files/components affected

**Admin app** — confirmed against the actual current repository state (the
Admin Platform 2.0 rebuild is complete for both target areas; there is no
`ExperiencePage.tsx`/`BotConfigSection.tsx` fork to choose between old and
new — only the new structure exists)

| File | Change |
|---|---|
| `app/src/features/agents/experience/ExperiencePage.tsx` (tab shell, `SECTION_TABS`: `branding \| messages \| personality \| liveChatLeads \| servicesCopy`; loads via `getClientSettings(botId)` line 94, saves via `updateClientSettings(...)` line 162) | Add a 6th tab, `language`, to `SECTION_TABS`. |
| `app/src/features/agents/experience/BotConfigSection.tsx` (renders `liveChatLeads`/`servicesCopy` tabs; loads via `getBot(botId)` line 108, saves via independent slice `updateBot(saveBotId, buildPatch())` calls, line 142; pattern defined in `botConfig.ts` lines 273-316 as `liveChatPatch`, `leadFormPatch`, `servicesPatch`, `answerLinksPatch`, `copyPatch`) | **This is the file to extend**, not `MessagesSection.tsx` — `language_config` is its own `Bot` column (Phase 1), directly analogous to `bant_config`/`business_hours`, which this file's slice-PATCH pattern already handles. Add a `LanguageSection` component following the same shape as the existing cards (`LiveChatCard`, `LeadFormCard`, `ServicesCard`, `SmartLinksCard`, `WidgetCopyCard`, lines 855-966 for the closest analog), with its own `languagePatch()` in `botConfig.ts` alongside the existing five. |
| `app/src/features/agents/experience/botConfig.ts` | Add `languagePatch(draft)` following the existing five patch-builder functions (lines 273-316). |
| `app/src/features/agents/experience/types.ts` | Add `language_config` to whatever type represents the `Bot` shape consumed here. |
| `app/src/features/workspace/MembersPage.tsx` | Add "Preferred language" and "Languages I speak" fields to the operator edit UI — this is the confirmed, actual location of operator/member management in the current admin app (there is no separate `OperatorSettings` page). |
| `app/src/services/api.js` (+ its `api.d.ts` typed companion) | Add/confirm an operator-update call that can PATCH `preferred_locale`/`supported_languages` on `Operator` (likely an existing operator-update endpoint gains two new optional fields — verify the exact existing operator PATCH route during implementation; not enumerated by the research pass). |
| `app/src/features/analytics/*` | Add a "by language" breakdown to whatever chart/table component currently segments conversations (by date, by status, etc.) — exact file not enumerated by the research pass; locate via the existing segmentation pattern at implementation time. |

**Backend**

| File | Change |
|---|---|
| `api/app/db/models.py` — `ChatSession` | Add index `ix_chat_sessions_bot_language_created` on `(bot_id, language_code, created_at)`, alongside the existing `ix_chat_sessions_bot_id_created` (`bot_id, created_at DESC`, lines 860-864). |
| `api/app/services/live_chat_routing_service.py` (module docstring lines 29-35, `select_operator` at line 85, `candidates` list flows through `_least_busy`/`_round_robin`/`_first_available`) | **Documentation-only change in this phase**: add a code comment describing the future language-filter shape (`candidates = [op for op in candidates if visitor_language in (op.supported_languages or [])] or candidates` — falling back to the unfiltered list rather than an empty queue, since translation makes cross-language assignment viable, just not preferred), matching the existing department-filter documentation style. No behavior change ships in Phase 5. |

## New files/components required

- `app/src/features/agents/experience/LanguageSection.tsx`
- New analytics visualization component (exact name/location TBD at
  implementation time, inside `app/src/features/analytics/`).

## Database/schema changes

```python
Index(
    "ix_chat_sessions_bot_language_created",
    ChatSession.bot_id, ChatSession.language_code, ChatSession.created_at,
)
```

Idempotent-guard migration, same template as prior phases, applied via
`op.create_index(...)`/`op.drop_index(...)` with an existence check
(`sa.inspect(op.get_bind()).get_indexes(TABLE)`), mirroring the column-guard
pattern used for columns in Phases 1/2/4.

No new columns in this phase — `Bot.language_config` (Phase 1),
`Operator.preferred_locale`/`supported_languages` (Phase 4), and
`ChatSession.language_code` (Phase 2) are all already in place; this phase
only builds UI on top of them and adds one index.

## API/WebSocket changes

None new. This phase's admin UI reads/writes through the **existing**
`getBot`/`updateBot` and `getClientSettings`/`updateClientSettings` API
surfaces (`app/src/services/api.js`), extended with the new fields — no new
backend routes required, since `Bot.language_config` is already exposed via
standard bot-update PATCH semantics (same as every other `Bot` JSONB column).

Confirm during implementation whether `updateBot`'s PATCH endpoint on the
backend (`api/app/api/bot_routes.py`) already accepts arbitrary/allow-listed
`Bot` fields generically, or whether `language_config` needs to be explicitly
added to an allow-list — the research pass confirmed the *response* shape of
`GET /bots/settings/public` in detail but not the request-side PATCH
allow-list mechanics for `bot_routes.py`'s update endpoint.

## Frontend changes

`LanguageSection.tsx` (new, in `app/src/features/agents/experience/`),
mirroring the source plan's UX mock but adapted to the existing design system
(`app/src/design-system/`) and the `BotConfigSection.tsx` card pattern
(plan-gated via `useEntitlements`/`FeatureGate`, same as `WidgetCopyCard`):

```text
Language & Localization

Default language          [ English (India) ▼ ]
Supported languages       [ English ✓ ] [ हिन्दी ✓ ] [ + Add language ]
Visitor language           [x] Automatically detect visitor language
                            [x] Allow visitors to change language
Live operator translation  [x] Translate visitor messages for operators
                            [x] Translate operator replies to visitor language
```

Maps directly to `Bot.language_config`'s five keys (`enabled` — toggled
implicitly by having ≥1 supported locale beyond the default, or an explicit
top-level toggle; `default_locale`; `supported_locales`; `auto_detect`;
`allow_visitor_language_switch`; `operator_translation_enabled`). Do not
expose IP confidence scores, the LLM language classifier, or embedding-model
internals in this UI — human-readable toggles only, per the source plan's
explicit instruction (§8.2).

`MembersPage.tsx` gains two fields per operator row/edit-modal: preferred
language (single-select) and languages spoken (multi-select checkbox list),
matching `Operator.preferred_locale`/`supported_languages`.

## Backend/service changes

None beyond the index migration — this phase is UI-over-existing-data. If the
`updateBot` PATCH allow-list needs `language_config` added explicitly (see
API/WebSocket changes above), that's a small, mechanical backend change
discovered at implementation time, not a new service.

## Dependencies on previous phases

- **Phase 1**: `Bot.language_config` column and its shape.
- **Phase 2**: `ChatSession.language_code` — needed for any analytics
  breakdown and for the new index to be meaningful.
- **Phase 4**: `Operator.preferred_locale`/`supported_languages` columns —
  needed for the `MembersPage.tsx` UI to have somewhere to write.
- Phase 3 is not a hard dependency for this phase's UI work, but the
  analytics slice is more useful once Phase 3 is live (otherwise "AI
  resolution by language" has no real signal yet).

## Exact implementation steps

1. Add the `chat_sessions` composite index migration.
2. Locate the exact `updateBot` PATCH allow-list in `bot_routes.py`; add
   `language_config` if it's not already generically accepted.
3. Build `LanguageSection.tsx` + `languagePatch()` in `botConfig.ts`; wire
   into `ExperiencePage.tsx`'s `SECTION_TABS` and `BotConfigSection.tsx`.
4. Locate the exact operator-update API call in `api.js`; extend it (or add
   a new call) for `preferred_locale`/`supported_languages`.
5. Extend `MembersPage.tsx` with the two new operator fields.
6. Locate the existing analytics segmentation component; add a language
   breakdown following its existing pattern (e.g. status/date breakdowns).
7. Add the documentation-only comment to `live_chat_routing_service.py`.
8. Manual QA: toggle `language_config.enabled` for a test bot end-to-end
   through the new UI, confirm Phase 2/3 widget and RAG behavior responds
   correctly without any code deploy.

## Acceptance criteria

- [ ] Admin can set default/supported languages, auto-detect, visitor-switch,
      and operator-translation toggles for a bot through the UI, and the
      values persist to `Bot.language_config`.
- [ ] Turning on multilingual for a bot through the admin UI alone (no code
      change) makes Phase 2's widget selector and Phase 3's AI language
      behavior activate for that bot.
- [ ] Operators can set preferred language and languages spoken through
      `MembersPage.tsx`, persisting to `Operator.preferred_locale`/
      `supported_languages`.
- [ ] Analytics view shows a conversation-by-language breakdown for bots with
      multilingual enabled.
- [ ] No IP confidence scores, classifier internals, or embedding-model
      details are exposed in the admin UI.

## Testing/QA requirements

- Admin UI tests: `LanguageSection.tsx` save/load round-trip against
  `Bot.language_config`; `MembersPage.tsx` save/load round-trip against
  `Operator` columns.
- Backend: `updateBot` PATCH accepts `language_config` and persists it
  correctly; old bots' public settings response still matches Phase 1's
  acceptance criteria after this phase's PATCH-path changes.
- Analytics: verify the language breakdown query performs acceptably using
  the new index (`EXPLAIN ANALYZE` on the `(bot_id, language_code,
  created_at)` index against a realistic session volume).

## Risks and edge cases

- **Unknown exact `updateBot` allow-list mechanics and analytics file
  location** — both flagged above as needing a short implementation-time
  lookup rather than being guessed here; this phase's estimate should budget
  for that discovery.
- **Turning off `allow_visitor_language_switch` after visitors have already
  set an explicit locale** — decide (and document in the admin UI copy)
  whether existing sessions keep their locked language or revert to bot
  default; recommend: existing locked sessions keep their language (least
  surprising), only new sessions are affected.
- **Operator language list vs. actual translation need** — since Phase 4
  ships translation that works even when the operator doesn't speak the
  visitor's language, the "languages I speak" field is informational/future-
  routing-only in V1, not a hard gate on who can respond — make sure the UI
  copy doesn't imply otherwise.

## Rollback considerations

- All UI in this phase is additive to existing pages; reverting the admin
  build removes the new tab/fields with no data loss (the underlying columns
  simply go unedited, not deleted).
- The one schema change (index) is safely dropped via `downgrade()` with no
  application-code dependency risk, since it's a pure performance index, not
  a data column.
