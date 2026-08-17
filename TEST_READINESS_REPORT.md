# Test Readiness Report — OyeChats Monorepo

_Assessment date: 2026-08-17 · Branch: `claude/monorepo-test-coverage-ynv9j4`_

This report covers a full assess → inventory → gap-analysis → implement → measure
pass across all three applications in the monorepo (`api/`, `app/`, `widget/`).
The k6 harness in `load-tests/` is performance tooling and is out of scope here.

## TL;DR

**The repository was NOT an untested codebase.** It arrived with a large,
genuine, CI-gated suite (4,660 backend + 550 admin + 86 widget tests, all
green). This work did not "add tests to an untested app" — it **found and
filled the specific high-risk gaps that remained**, fixed a flaky end-to-end
test and broken e2e tooling, and — as a direct by-product of writing real
behavioral tests — **surfaced two real bugs**, one of them a launch blocker.

**TEST COVERAGE STATUS: CONDITIONAL PASS** — conditional only on the
launch-blocking `invite_service` bug (below), which testing exposed and which
is an application defect, not a test gap.

---

## Baseline (before)

| Suite | Test files | Tests | Coverage (statements) | In CI? |
|-------|-----------:|------:|-----------------------|:------:|
| **API** (`api/`, pytest) | 320 | **4,660 pass** | **66.37%** total | ✅ backend job |
| **App** (`app/`, vitest) | 61 | **550 pass** | 16.82% stmt / 14.84% br / 13.65% fn / 17.72% ln | ✅ app job |
| **Widget** (`widget/`, node:test) | 6 | **86 pass** | not measured | ✅ widget job (unit only) |

### Major gaps identified at baseline
- **Widget** was the largest relative gap: `npm test` only globs
  `src/services/*.test.js`. Security-sensitive `sanitize.js` (XSS/CSS-injection
  boundary), `smartLinks.js`, and `lib/slashCommands.js` had **zero** tests.
- **Widget e2e was non-functional**: `playwright.config.js` and the `e2e`
  scripts referenced `@playwright/test`, which was **never declared** in
  `package.json` → `npm run e2e` failed on a fresh install.
- **App**: pure logic with no tests — `utils/apiErrors.ts` (the paywall gate),
  `lib/pollUntil.ts` (async billing/crawl polling), `utils/isLocalHostname.ts`,
  and the entitlement/plan hooks (`useEntitlements`, `useSelectedBotPlan`,
  `usePromoFreePeriod`). One test file (`embedEnvironment.test.js`) was written
  with `node:test` and named `.js`, so vitest's `.ts/.tsx`-only `include`
  **silently never ran it** (dead coverage).
- **API**: several services had **zero** direct coverage — `invite_service`
  (team invites / RBAC / seats), `knowledge_quota_service` (quota enforcement),
  `live_chat_routing_service`, `intent_service`, plus low-coverage worker/RAG
  paths.

---

## Implemented

### Widget — +33 unit tests (86 → 119), e2e repaired
| File | Cases | What it pins |
|------|------:|--------------|
| `src/services/sanitize.test.js` | 11 | hex-colour + image/file URL sanitization; the CSS-injection and `javascript:`/`data:text/html` XSS **negative** cases this boundary exists to block |
| `src/services/smartLinks.test.js` | 10 | URL normalization, per-session click suppression, localStorage persistence, and degradation when storage throws / holds corrupt JSON |
| `src/lib/slashCommands.test.js` | 12 | whole-input command matching, orphan-token detection (URLs / "and/or" must not open the popover), prefix filter, autocomplete caret math, fresh-chat availability gating |

- Broadened `npm test` to also run `src/lib/*.test.js` (single-level glob, safe
  on the Node-20 CI shell).
- **Fixed a flaky e2e test**: `identify() persists visitor` waited only for the
  loader **stub** `window.OyeChats` (whose `diagnose()` returns `undefined`),
  so on a cold load it read visitor state before the real API registered —
  failing ~1 in 3 cold runs. Now waits for the real implementation. Verified
  green 5/5 repeated runs.
- **Declared the missing `@playwright/test` devDependency** so `npm run e2e`
  works from a clean install. Chromium e2e: **3/3 pass**. (The `mobile`/WebKit
  project needs a WebKit browser not present in this sandbox — unrelated to the
  code.)

### App (admin) — +61 tests, 8 files (550 → 611)
| File | Cases | What it pins |
|------|------:|--------------|
| `src/utils/apiErrors.test.ts` | 6 | the exact `402 + must_subscribe===true` paywall gate; strict-boolean + null/primitive negatives keep unrelated failures out of the upgrade flow |
| `src/utils/isLocalHostname.test.ts` | 6 | canonical hosts, `.localhost`/`.local` suffixes, and look-alike spoofs (`localhost.evil.com`, `127.0.0.1.nip.io`) it must reject |
| `src/lib/pollUntil.test.ts` | 8 | settle / timeout / transient-retry / cancel contracts under deterministic fake timers, no leaked timers |
| `src/hooks/useEntitlements.test.tsx` | 15 | `isFree`, `hasFeature` (bool + string flags), `limitFor` (`-1` unlimited sentinel, `0` deny-default), `withinLimit` boundary, `remaining` floor/`Infinity` |
| `src/hooks/useSelectedBotPlan.test.tsx` | 10 | plan name/slug resolution incl. Free agent not borrowing the account plan |
| `src/hooks/usePromoFreePeriod.test.tsx` | 7 | future/expired promo windows, rejected fetch (no throw), unmount-before-resolve drops the late write |
| `src/hooks/useCountUp.test.tsx` | 4 | reduced-motion returns target immediately; animated path eases 0→exact target |
| `src/features/agents/channels/embedEnvironment.test.ts` | 4 | localhost/loopback → development, remote → production, malformed URL fails safe |

- **Revived the dead test file**: `embedEnvironment.test.js` → `.test.ts`
  (vitest now runs it).

### API (backend) — +98 tests, 4 files (4,660 → 4,758)
| File | Cases | Approach |
|------|------:|----------|
| `tests/test_invite_service.py` | 35 | real-Postgres `db` fixture: token opacity (sha256 hash lookup, wrong/empty token), RBAC (non-manager/owner/superadmin guards), live-chat feature gate, per-bot seat limit at the exact boundary, duplicate-pending & existing-operator conflicts, revoked/accepted/expired/idempotent accept branches |
| `tests/test_knowledge_quota_service.py` | 23 | real-Postgres: per-source counter math, DISTINCT-ON source summing, drift recompute |
| `tests/test_live_chat_routing_service.py` | 12 | monkeypatched presence + Redis cursor; asserts which operator each strategy selects |
| `tests/test_intent_service.py` | 28 | pure keyword-regex path + every hybrid LLM decision branch (LLM stubbed at the seam) |

Every assertion targets a decision/persisted outcome (never "a mock was
called") and is mutation-sensitive.

- **`response_style.py` intentionally not covered** — it is a single static
  prompt-string constant plus a one-line getter (no branches, no inputs;
  matches its 5-statement/100% line in the baseline report). A test would be a
  banned snapshot dump or trivial getter assertion.

---

## Coverage (after)

| Suite | Before | After | Δ |
|-------|--------|-------|---|
| **API** total statements | 66.37% | **67.15%** | +0.78 pts (220 more stmts covered) |
| **App** statements | 16.82% | **17.15%** | +0.33 |
| **App** branches | 14.84% | **15.16%** | +0.32 |
| **App** functions | 13.65% | **14.01%** | +0.36 |
| **App** lines | 17.72% | **18.02%** | +0.30 |
| **Widget** unit tests | 86 | **119** | +33 |

**Why the app's global percentage moves only slightly:** the denominator is the
entire `src/**`, dominated by large presentational React (pages, design-system,
shells) that is legitimately covered by the Playwright/manual layer, not unit
tests. The added tests deliberately target **pure logic and hooks**, where the
covered *files* now approach comprehensive branch coverage. Chasing the global
number by rendering every page would produce brittle, low-value tests — exactly
what the brief forbids. Coverage of the **specific targeted modules**
went from **0% → near-complete behavioral coverage**:

| Backend module (was 0%) | After |
|--------------------------|------:|
| `intent_service.py` | **100%** |
| `knowledge_quota_service.py` | **89%** |
| `invite_service.py` | **81%** (uncovered = the `bot_id`-broken create/accept success paths, correctly left unasserted) |
| `live_chat_routing_service.py` | **74%** |

Frontend targeted modules (`apiErrors.ts`, `pollUntil.ts`, `isLocalHostname.ts`,
and the entitlement/plan hooks) likewise went from 0% to full behavioral
coverage of their branches.

---

## Bugs found (by writing real tests — NOT fixed here)

### 🔴 CRITICAL / launch-blocking — `invite_service` references a non-existent column
`app/services/invite_service.py:397` constructs
`OperatorInvite(..., bot_id=bot_id, ...)` and `accept_invite` reads
`invite.bot_id`, but **`OperatorInvite` has no `bot_id` column** in either the
ORM model (`app/db/models.py`) or the baseline schema. Reproduced directly:

```
TypeError: 'bot_id' is an invalid keyword argument for OperatorInvite
```

**Impact:** `create_invite` and `accept_invite` raise at runtime, so the
**POST invite endpoint (`app/api/invite_routes.py:270`) and invite acceptance
are broken.** Team-member onboarding via invite cannot work in this state.
**Recommended fix:** the surrounding code (per-bot seat checks, `invite_routes`
passing `body.bot_id`) shows the intent is per-bot invites — add a `bot_id`
column to `OperatorInvite` (model + Alembic migration), or, if invites are
meant to be workspace-wide, remove the `bot_id` plumbing and use a
workspace-wide seat check. **This should block launch.**

### 🟡 Minor — dead IPv6-loopback branch in `embedEnvironment.js`
`src/features/agents/channels/embedEnvironment.js` compares
`hostname === '::1'`, but `new URL('http://[::1]:8000').hostname` returns the
**bracketed** `'[::1]'`. The branch is dead, so an IPv6-loopback API endpoint
resolves to `production` instead of `development`. Low impact (IPv6 localhost
dev is rare). Fix: compare against `'[::1]'`.

---

## Remaining gaps (prioritized)

| Area | Why it matters | Risk | Recommended future test | Blocks launch? |
|------|----------------|------|--------------------------|:--------------:|
| `invite_service` create/accept **success** paths | Untestable until the `bot_id` bug is fixed; the happy path is currently unverified | High | After the schema fix, assert invite creation persists, token round-trips, and acceptance provisions an Operator seat | **Yes** (via the bug) |
| `rag_service.py` (52%, 2,133 stmts) | Core RAG retrieval/ranking; large untested surface | Med-High | Behavioral tests for hybrid-search ranking, CAG-lite threshold, relevance-gate/rerank on/off | No (already partially covered) |
| `worker/tasks.py` (60%) & `worker/enqueue.py` (23%) | Background ingestion, billing, email jobs | Medium | Task-level tests with a fake ARQ context asserting side-effects/retries | No |
| `push_service.py` (49%), `oauth_service.py` (43%), `operator_presence_service.py` (27%) | Notifications, social login, presence | Medium | Seam-level tests for token/subscription handling and presence transitions | No |
| Widget React components (25 `.jsx`, no unit tests) | Chat UI behavior | Medium | Covered today by 3 Playwright smoke tests; add jsdom+RTL or more e2e for lead/handoff/booking flows | No |
| Widget `api.js` (877 loc, network/SSE) | The visitor↔backend contract | Medium | Extract SSE-parse/journey helpers or assert via e2e against a mock backend | No |
| App page/feature components | Large 0-coverage surface | Low-Med | Add RTL tests for the highest-traffic flows (agent create, billing checkout) rather than chasing the global % | No |

---

## Reliability

- **Flaky test found & fixed:** the widget `identify()` e2e (raced the async
  API bootstrap). Now deterministic — verified 5/5.
- **Broken test infra fixed:** missing `@playwright/test` dependency; a
  `.test.js` file vitest never ran.
- **Isolation:** new API tests use the existing throwaway-Postgres `db` fixture
  (TRUNCATE between tests) and stub external calls (LLM/Redis) at the seam — no
  network, no order dependence. App/widget tests use fake timers and stubbed
  `window`/`localStorage`; no real clock or network.
- **External-dependency note:** the full API suite rebuilds a throwaway schema
  **per module**, so a clean run takes ~10 min locally. Not flaky — just slow;
  a session-scoped schema would speed it up but is out of scope here.

---

## Verification (this branch)

- **Widget:** lint ✓ · unit `119 pass` ✓ · build ✓ (loader 1.24 KB gzip) · e2e chromium `3/3` ✓
- **App:** lint ✓ · typecheck (`tsc --noEmit`) ✓ · `611 pass` ✓ · build ✓
- **API:** ruff check ✓ · ruff format ✓ · new tests `98 pass` ✓ · full suite `4,758 pass` ✓

## Final status

**TEST COVERAGE STATUS: CONDITIONAL PASS.** The suite is broad, genuinely
behavioral, deterministic, and CI-gated; the gaps that remained in high-risk
areas (invites/RBAC, quota, routing, intent, the widget security boundary, the
paywall gate, async polling) are now filled with mutation-sensitive tests. The
single condition on an unqualified PASS is the **`invite_service` `bot_id`
launch-blocker** — an application defect the testing surfaced, which must be
fixed (and its success paths then covered) before production.
