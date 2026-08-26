# Multilingual Phase 1 + Phase 2: Senior Engineering Code Review

**Reviewer role:** Senior engineer / architecture reviewer
**Date:** 2026-08-24
**Branch:** `development`
**Scope reviewed:** Phase 1 (commit `c6622179`, "feat: add multilingual language foundation") and Phase 2 (uncommitted working tree)
**Reviewed against:** [README.md](README.md), [phase-1-language-foundation.md](phase-1-language-foundation.md), [phase-2-widget-localization.md](phase-2-widget-localization.md), the current git diff, and existing OyeChats architecture and conventions.

No files were modified during this review.

---

## Executive Verdict

# 🔴 REWORK REQUIRED

The architecture is sound and faithful to the agreed design. The implementation has a defect that makes the headline Phase 2 feature non-functional in production, plus a validation bypass that will corrupt Phase 3 behaviour on bots that never enabled multilingual. Both are proven below with executable evidence, not inference.

Two mandatory release gates also fail right now: `npm run lint` (error) and `npm run size` (vendor chunk over budget).

Critically: **the test suite passes 100% (129 widget + 82 backend) while the primary feature does not work.** The precedence test exercises the resolver function directly with arguments that the only production caller never supplies.

### Checks run

| Check | Result |
|---|---|
| Widget tests (`npm test`) | ✓ 129 pass |
| Widget lint (`npx eslint .`) | ✗ 1 error |
| Widget build (`npm run build`) | ✓ succeeds |
| Bundle budget (`npm run size`) | ✗ vendor chunk over by 3.17 KB |
| Backend lint (`ruff check .`) | ✓ all checks passed |
| Backend tests (new multilingual suites) | ✓ 82 pass |
| Alembic heads | ✓ single head `c8f5b2e0a3d9` |

---

## 1. Critical Issues

### C1. Widget language auto-detection is entirely dead code

**Files:** `widget/src/i18n/localeResolver.js:75-76`, `widget/src/components/ChatWidget.jsx:54-66`

`resolveClientLocale` destructures `htmlLang = null` and `browser = null`, then guards the DOM and navigator lookups:

```js
const effectiveHtmlLang = htmlLang !== undefined ? htmlLang : getHtmlLang();
const effectiveBrowser  = browser  !== undefined ? browser  : getBrowserLanguage();
```

Because the destructuring default is `null` rather than `undefined`, `null !== undefined` is always `true`. `getHtmlLang()` and `getBrowserLanguage()` therefore never execute. `ChatWidget.jsx` compounds this by passing only `explicit` and `persisted`; `site`, `htmlLang`, and `browser` are never passed at all.

**Proof.** Host page declares `<html lang="hi-IN">`, browser prefers `hi-IN`, bot supports `hi-IN`:

```text
getHtmlLang() directly      = hi-IN
getBrowserLanguage() direct = hi-IN
ChatWidget production call  = {"locale":"en-IN","language":"en","source":"default","locked":false}
EXPECTED per plan           = hi-IN via html_lang / browser
```

**Why it matters.** Four of the eight precedence tiers (site, html_lang, browser, and by extension any first-visit detection) are inert. The Phase 2 acceptance criterion "Widget can auto-resolve language" is unmet, and E2E journeys 1 and 3 cannot pass. Every first-time visitor receives the bot default regardless of their browser or the host page's declared language. The backend's `Accept-Language` fallback partially masks this for the AI response, but the widget UI always renders in the default locale.

**Recommended fix.** Change the guards to `htmlLang ?? getHtmlLang()` (or default the parameters to `undefined`), and pass `site`, `htmlLang`, and `browser` explicitly from `ChatWidget.jsx`. Add a test that calls the resolver the way `ChatWidget` calls it.

---

### C2. `POST /chat/language` bypasses all validation when multilingual is disabled

**File:** `api/app/api/chat_routes.py:1500-1506`

```python
if lang_cfg.get("enabled", False) and not is_supported_locale(normalized, supported):
    matched = match_supported_locale(normalized, supported)
    if not matched:
        raise HTTPException(status_code=400, detail="Unsupported locale")
    normalized = matched
```

The `enabled` check short-circuits the entire validation branch. When `enabled` is `False`, which is the Phase 1 default for every existing bot, any well-formed locale is accepted and written.

**Proof.**

```text
bot.language_config       = {'enabled': False, 'default_locale': 'en-IN', 'supported_locales': ['en-IN']}
POST /chat/language ar-SA -> 200 {'language': 'ar', 'locale': 'ar-SA', 'source': 'explicit', 'locked': True}
WROTE TO DB               = {'language_code': 'ar', 'locale': 'ar-SA', 'language_source': 'explicit',
                             'language_confidence': 1.0, 'language_locked': True}
```

**Why it matters.** Three compounding problems:

1. It violates the non-negotiable backward-compatibility rule. A bot with the feature off is no longer behaving exactly as it does today, and an unauthenticated visitor (public `X-Bot-Key`) can write and lock arbitrary language state.
2. It is a Phase 3 landmine. Phase 3 reads `session.language_code` and will generate Arabic for a bot that never opted in, with `language_locked=True` preventing self-correction.
3. The route has no `@limiter.limit` decorator, unlike every other public chat route (lines 1198, 1354, 1547, 1638, and others), so this write is unthrottled.

**Recommended fix.** Reject with 403 or 400 when `enabled` is false, make validation unconditional, and add `@limiter.limit("20/minute", key_func=key_from_bot_key)`.

---

### C3. Explicit visitor selection is not locked when chosen before the first message

**File:** `widget/src/components/ChatWindow.jsx:1140-1142`

```js
locale: currentLocale,
language: getLanguageCode(currentLocale),
languageSource: 'browser',        // hardcoded on EVERY send
```

The widget never sends `language_source: 'explicit'`. If a visitor opens the widget and picks Hindi before sending a first message, `sessionId` is null so `changeSessionLanguage()` is skipped (`ChatWindow.jsx:1146`). The session is then created by the first `/chat/stream` call with `language_source='browser'`, so the backend resolves it as the `browser` candidate and returns `locked=False`.

**Why it matters.** This directly violates the stated architectural requirement that explicit visitor selection must be persistent and locked. The choice survives as a value but loses its authority, so later auto-resolution can silently overwrite it. It also renders the backend's `explicit` branch (`chat_routes.py:273`) unreachable from the streaming path.

**Recommended fix.** Track the real source in `ChatWindow` state and send it. When a locale is chosen with no session yet, either defer the `/chat/language` call until the session ID exists, or send `language_source: 'explicit'` on the first message.

---

### C4. Eager vendor bundle regression on every page view, for every customer

**Files:** `widget/vite.app.config.js:50,57`, `widget/package.json:40`

`id.includes('/i18n/')` and `lucide-react` were added to the `vendor` manualChunks bucket, and the budget was raised from 67 KB to 70 KB. It still fails:

```text
Vendor chunk (React + axios + services incl. journey tracking)
Package size limit has exceeded by 3.17 kB
Size limit: 70 kB
Size:       73.17 kB gzipped
```

**Why it matters.** `vendor` is the eager chunk that loads on every page view of every customer site, whether or not the visitor ever opens chat. Both locale dictionaries plus the icon library now ship to visitors of bots that have multilingual disabled. This is a Core Web Vitals regression on customer sites, and a failing `npm run size` blocks the mandatory pre-completion checks. The Phase 2 plan explicitly warned against exactly this: locale dictionaries must be dynamically imported per locale and must not be added to the vendor manualChunks bucket.

**Recommended fix.** Remove `/i18n/` and `lucide-react` from the vendor bucket, dynamically `import()` dictionaries per locale (`LanguageSelector` is already lazy, so its icons follow it), and restore the 67 KB budget rather than raising it.

---

## 2. High Priority Issues

### H1. `console.*` now ships to production (unrelated regression)

**File:** `widget/vite.app.config.js:20-22`

`esbuild: { drop: ['console', 'debugger'] }` was deleted. Verified in the built output: 25 `console.error` and 8 `console.warn` calls in the vendor chunk, plus `console.log` in `app-entry` and `LiveChatMode`. This leaks `[OyeChats]` internals into every customer's browser console and inflates C4. It is unrelated to multilingual and appears to be a debugging change that was never reverted.

**Fix:** restore the drop configuration.

### H2. `npm run lint` fails

**File:** `widget/src/components/ChatWidget.jsx:1`

```text
1:59  error  'lazy' is defined but never used  no-unused-vars
```

Left over after the `lazyWithRetry` swap. This is a hard CI gate per `CLAUDE.md`.

### H3. The `site` precedence tier is silently discarded backend-side

**File:** `api/app/api/chat_routes.py:271-277`

The candidate mapping handles `explicit`, `html_lang`, `browser`, and `persisted`. `site` is absent. A widget sending `language_source: 'site'` has its locale dropped entirely and falls through to the `Accept-Language` header, so website locale (tier 2) loses to browser language (tier 4). This inverts the agreed precedence.

### H4. Regional locales are not narrowed to the supported variant

**File:** `api/app/api/chat_routes.py:1500-1506`

`is_supported_locale()` returns `True` on a base-language match, which skips the `match_supported_locale()` narrowing.

**Proof.**

```text
supported = ['fr-FR']
requested = fr-CA
is_supported_locale = True   (so the narrowing block is SKIPPED)
match_supported     = fr-FR  (what SHOULD be stored)
ACTUALLY STORED     = fr-CA
```

This contradicts Phase 1's stated acceptance criterion (`fr-CA → fr-FR if only fr-FR supported`). The session then carries a locale for which the bot has no dictionary and no configuration.

### H5. Persisted explicit choice ranks below browser (latent, activates when C1 is fixed)

**Files:** `widget/src/i18n/localeResolver.js:79-85`, `api/app/services/language_service.py:236-242`

Persisted is checked after browser and html_lang. Today this is masked by C1, because browser and html_lang are never populated. The moment C1 is fixed, a returning visitor's saved Hindi choice will be overridden by an English host page.

The root cause is that `writeLocale()` in `storage-keys.js` stores only the locale string, not its source, so an explicit choice is indistinguishable from an auto-detected one. **C1 and H5 must be fixed together**, otherwise fixing C1 introduces a new regression. Persist `{locale, source}` and feed a persisted explicit value in as `explicit`.

### H6. `onLocaleChange` listener leak in `mount()`

**File:** `widget/src/app-entry.jsx:175-181`

The unsubscribe function returned by `onLocaleChange` is discarded. Every `init()` to `destroy()` to `init()` cycle (supported via `shutdown`/`boot`) adds another listener holding a closure over a stale `_container`, writing `dir` to a detached DOM node.

**Fix:** store the unsubscriber and call it in the teardown path.

### H7. Widget ignores the backend's authoritative locale response

**File:** `widget/src/components/ChatWindow.jsx:1145-1152`

`changeSessionLanguage()` returns the resolved `{language, locale, source, locked}`, but the widget optimistically sets `newLocale` and discards the response. Combined with H4, the widget can display `fr-CA` while the session stores `fr-FR`.

### H8. Frontend and backend locale normalization diverge

**Files:** `widget/src/i18n/i18n.js:18-25` versus `api/app/services/language_service.py:79-146`

The widget's version uses `.replace('_', '-')` (first occurrence only), uppercases `parts[1]` unconditionally, and drops everything past the second subtag. `zh-Hans-CN` becomes `zh-HANS`: the script subtag is corrupted and the region is lost. The backend correctly yields `zh-Hans-CN`. The widget also returns `'en-IN'` for invalid input where the backend returns `None`, so malformed input silently becomes a valid-looking locale.

Two normalizers for one contract is both a correctness hazard and a maintenance hazard.

### H9. Extra database round-trip and transaction on every chat request

**File:** `api/app/api/chat_routes.py:257-303`

`_resolve_visitor_language_and_update_session` opens its own `get_session()`, performs a `SELECT`, and may `INSERT` or `UPDATE` and `commit`, all before `rag_pipeline_stream` runs its own `ensure_chat_session`. On the streaming path it is wrapped in `asyncio.to_thread`, consuming a thread-pool slot.

Phase 6 requires no extra call when the session language is already known. This runs unconditionally for every enabled bot, even on turn 50.

**Fix:** fold the resolution into the existing `ensure_chat_session` call rather than opening a second session.

---

## 3. Medium and Low Priority Issues

| # | File | Issue |
|---|---|---|
| M1 | `widget/src/i18n/i18n.js:92` | `t()` returns the key itself when a translation is missing, so the pervasive `t('x.y') \|\| 'Fallback'` idiom (roughly 20 sites) is dead code. A missing key renders `header.close` as visible UI text. Return `null` on miss, or drop the misleading `\|\|`. |
| M2 | `widget/src/components/ChatWindow.jsx` | Localization is largely incomplete: only 8 `t()` calls. Hardcoded English remains at lines 128, 956-958, 1493, 1533, 1546, and 1621 (`'Our team'`, `'Connecting you with our team...'`, the progressive waiting copy). This is exactly the inline copy Phase 2 scoped in. |
| M3 | `widget/src/components/ChatWindow.jsx:791,811,813` | System messages are filtered by string equality on UI copy (`m.text === 'Connecting you with our team...'`). Localizing that string silently breaks message removal. This must be switched to a stable message ID before M2 can be completed. |
| M4 | 3 files | Locale metadata is triplicated and inconsistent: backend `KNOWN_LOCALES` (29 entries), `LanguageSelector.LOCALE_NAMES` (32 entries, including bn, ta, te, mr, gu, kn, ml, pa which exist in neither other list), and `i18n.DICTIONARIES` (2 entries). A visitor can be offered বাংলা that has no dictionary and no backend support. |
| M5 | `api/alembic/versions/c8f5b2e0a3d9_…py:24-40` | Module-level `sa.Column` objects are reused across `upgrade()` calls. Verified: a second bind raises `ArgumentError: Column object 'language_code' already assigned to Table 'chat_sessions'`. Single CLI invocations are fine, so production deploys are safe, but upgrade → downgrade → upgrade in one process (Phase 1's own acceptance criterion) crashes. Build the columns inside `upgrade()`. |
| M6 | `widget/src/widget-controller.js:171-196` | Two events (`language:changed` and `localeChanged`) are fired for one state change, and both were added to `VALID_EVENTS`. Pick one; the plan specified `localeChanged`. |
| M7 | `api/app/api/chat_routes.py:268` | Only the first tag of `Accept-Language` is used and q-values are ignored. `en-US,en;q=0.9,hi;q=0.8` against a Hindi-only bot falls to default instead of matching `hi`. |
| M8 | `widget/src/i18n/localeResolver.js:42-45` | Mirrors M7: uses `navigator.language` and ignores the rest of `navigator.languages`. |
| M9 | `ChatWidget.jsx:59` versus `chat_routes.py:258` | Default-enabled semantics disagree. The widget uses `langCfg.enabled !== false`, which is enabled when the key is absent; the backend uses `.get("enabled", False)`, which is disabled. On a stale bot-cache entry the widget enables while the backend does not. |
| M10 | `chat_routes.py:265-266,287` | Dead branch: a locked session with `language_source == 'explicit'` passes the early return, then hits `if not chat_session.language_locked:` and does nothing. Misleading control flow. |
| M11 | `LanguageSelector.jsx:81-84` | The `isSelected` base-language match highlights both `en-US` and `en-GB` simultaneously when both are supported. |
| M12 | `ChatWindow.jsx:2242` | `showLanguageOption` is true when `supported_locales === undefined`, showing a "Language" menu with a single entry. |
| M13 | `app-entry.jsx:96-98` | `getDirection()` runs before locale resolution, so RTL locales get a flash of LTR layout before the listener corrects `dir`. |
| M14 | `ChatWindow.jsx:1148` | `writeLocale(newLocale, settings?.bot_key)`: `bot_key` is not in the `/bots/settings/public` response (verified). This works only via the `currentBotKey()` fallback, so the argument is misleading. |
| L1 | `loader.js:99-111`, `api.js:7-13`, `ChatWindow.jsx:34` | Scope creep: `data-api-url` plus localhost auto-detection of `http://localhost:8000`, shipped in the size-budgeted production loader. Unrelated to multilingual. |
| L2 | `ChatWidget.jsx:1-11,325-334` | Scope creep: `lazyWithRetry` and `ErrorBoundary` around `ChatWindow` (a good change on its own) and the `Headphones` to inline-SVG swap (`ChatWindow.jsx:2681`) are bundled into the multilingual diff, complicating review and rollback. |

---

## 4. Architecture Review

**The agreed architecture is intact and I recommend preserving it.** Every constraint holds. The three language layers stay separate. `rag_service.py` is untouched (verified: no `visitor_language` parameter yet), so Phase 3 has a clean seam. There is no per-language RAG index. No external translation provider was introduced. IP and geo are not wired in as a detector; the `geo` tier is simply not implemented yet, which is the correct Phase 2 posture.

| Dimension | Assessment |
|---|---|
| **Language context propagation** | ⚠️ The shape is right (`LanguageContext` to session columns), but the `language_source` contract is muddled: the widget hardcodes `'browser'` (C3), the backend drops `'site'` (H3), and `'explicit'` is unreachable outside `/chat/language`. Fix the source contract before Phase 3 consumes it, because Phase 3's prompt directive depends on trustworthy source and lock semantics. |
| **ChatSession persistence** | ✅ Column design is correct: nullable, additive, `language_locked` defaulted false, ownership enforced via `_get_session_for_bot`. Multi-tenant isolation is properly enforced in `update_chat_session_language`. |
| **Locale resolver** | ⚠️ The function is well factored and correct in isolation; the wiring is broken (C1). Two divergent implementations (H8) are the main structural debt. Recommend the widget resolver own client-side precedence, with the backend validating rather than re-resolving. |
| **Widget and backend contract** | ⚠️ Additive and backward compatible: all new request fields are optional, and old widgets keep working. Weakened by the widget ignoring the authoritative response (H7). |
| **Future AI/RAG integration** | ✅ Clean. Phase 3 only needs `visitor_language=session.language_code` threaded into `rag_pipeline_stream` and `build_hybrid_prompt`, exactly as planned. The blocker is C2: Phase 3 must be able to trust that language state only exists on opted-in bots. |
| **Extensibility to many languages** | ⚠️ Adding a language currently means editing three uncoordinated catalogs (M4). Consolidate to one source of truth before scaling past en and hi. |
| **Operator translation (Phase 4)** | ✅ Unblocked. `ChatMessage` and `Operator` columns are untouched as planned, and `live_chat_service.py` is clean. |

**Verdict:** these are implementation defects, not architectural ones. No redesign is warranted.

---

## 5. Regression Review

| Area | Risk | Detail |
|---|---|---|
| **Existing bots** | 🔴 High | C2: visitors can write locked language state on bots with the feature off. The Phase 1 `enabled: false` guarantee is broken. |
| **Widget performance (all customers)** | 🔴 High | C4: eager vendor chunk grew from 67 KB to 73.17 KB gzipped on every page view, including non-multilingual bots. `npm run size` fails. |
| **Customer site consoles** | 🟠 Medium | H1: 33 or more `console.*` calls now execute in production. |
| **Existing widget embeds** | 🟢 Low | The loader API is additive (`setLocale` and `getLocale` added to the stub). A cached older `oyechats-widget.js` keeps working. |
| **Existing sessions** | 🟢 Low | New columns are nullable; a `NULL` language is handled as unresolved. |
| **Existing API consumers** | 🟢 Low | `ChatRequest` fields are all optional and `/bots/settings/public` gains one additive key. Stale Redis bot-cache entries lacking `language_config` degrade safely to `{}` and therefore to disabled, though see M9. |
| **Live chat, lead capture, handoff** | 🟢 Low | Untouched paths. `LiveChatMode.jsx` has a single cosmetic `t()` change. |
| **Chat latency** | 🟠 Medium | H9: one extra SELECT and transaction per request on enabled bots. |
| **CI** | 🔴 High | H2 lint error and C4 size failure both block the mandatory gates. |

---

## 6. Test Coverage Assessment

### Well covered

Locale normalization matrix, RTL detection, `t()` interpolation and fallback chain, dictionary key parity (verified independently: 59 keys in each of en and hi, no drift), `matchSupportedLocale`, storage helpers, controller `setLocale` and `getLocale`, the language-lock preservation path (`test_locked_session_preserves_language` is a genuinely good test), and the `/chat/language` 404-on-ownership-error path.

### Tests that give false confidence

This is the central problem with the current suite.

1. **`i18n.test.js:115` "resolveClientLocale follows strict precedence"** passes `site`, `htmlLang`, and `browser` as explicit arguments. The only production caller passes none of them (C1). The test is green while the feature is entirely dead. This single test is why C1 shipped.
2. **`test_chat_language.py:51,71`** mock out `update_chat_session_language` completely, so they assert only that the route echoes back what it just computed. No database write, no locking, and no ownership filtering is actually verified.
3. **`test_change_language_unsupported_locale`** uses `ja-JP`, which has no base-language match at all, so it never exercises the base-match-but-wrong-region path. That is precisely where H4 lives.

### Missing before Phase 3

- A resolver test invoked exactly as `ChatWidget.jsx` invokes it (would have caught C1).
- `POST /chat/language` against a bot with `enabled: False` (C2).
- `fr-CA` to `fr-FR` narrowing (H4).
- `language_source: 'site'` end to end (H3).
- Returning-visitor test: persisted explicit choice versus a conflicting `<html lang>` (H5).
- A real multi-tenant isolation test (a session belonging to bot A, requested with bot B's `X-Bot-Key`) that hits the actual repository function rather than a mock.
- Any component test for `LanguageSelector`, and any test asserting UI strings re-render after a locale change.
- A migration round-trip in a single process (M5).

---

## 7. Required Fixes Before Phase 3

### Blockers, must fix

1. **C1** Fix the `??` guards in `localeResolver.js`; pass `site`, `htmlLang`, and `browser` from `ChatWidget.jsx`. Add a test mirroring the real call site.
2. **C2** Make locale validation unconditional in `/chat/language`; reject when `enabled` is false; add `@limiter.limit`.
3. **C3** Send the real `language_source`; ensure explicit selection locks even when chosen before a session exists.
4. **C4** Remove `/i18n/` and `lucide-react` from the vendor bucket; lazy-load dictionaries; restore the 67 KB budget.
5. **H1** Restore `esbuild: { drop: ['console', 'debugger'] }`.
6. **H2** Remove the unused `lazy` import so `npm run lint` passes.
7. **H3** Add the `site` tier to the backend resolver mapping.
8. **H4** Always narrow through `match_supported_locale()`.
9. **H5** Persist `{locale, source}` and treat a persisted explicit choice as `explicit`. This must land together with C1, otherwise fixing C1 introduces a new regression.

### Strongly recommended

10. **H6** listener leak, **H7** apply the backend response, **H8** unify the two normalizers (a single implementation, ideally with shared fixtures), **H9** fold into the existing `ensure_chat_session`.

### Should fix before scaling past en and hi

11. **M1** `t()` fallback semantics, **M2** and **M3** finish `ChatWindow` localization after replacing string-equality message matching, **M4** single locale catalog, **M5** migration column reuse, **M9** align the enabled-default semantics.

### Housekeeping

12. Split the L1 and L2 scope creep into a separate commit so the multilingual change is independently revertible.

---

## Recommendation

# 🔴 Fix these issues first, then proceed to Phase 3.

Do not start Phase 3 yet. Phase 3's entire value, the AI responding in the visitor's language, reads `ChatSession.language_code` and `language_locked`. Today that state is:

- never populated from browser or page signals (C1),
- writable with arbitrary values on bots that never opted in (C2),
- carrying a `language_source` that does not reflect reality (C3).

Building prompt-directive logic on top of that will produce wrong-language responses on customer bots, and will make the root cause far harder to isolate once RAG is in the loop.

The good news is that the architecture needs no redesign. C1 and C3 are small, surgical fixes; C2 is a one-line condition change plus a decorator; C4 is a configuration revert. Items 1 through 9 are realistically a focused day of work, and the resulting foundation is genuinely solid for Phases 3 and 4.
