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

**The launch blocker has since been root-caused and fixed** — an evidence-based
investigation of the whole invite flow led to `operator_invites.bot_id` (see
the "Launch blocker: RESOLVED" section below). The complete backend suite (now
**4,762 pass**), the frontend suites, the migration chain on a clean database,
lint/format, and both production builds are green.

**TEST COVERAGE STATUS: PASS** — the invite launch blocker is genuinely
resolved and the full test/build suite remains green. The items in the
"Remaining gaps" section are ordinary future-coverage work, not launch
blockers.

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

### API (backend) — +102 tests, 4 files (4,660 → 4,762)
| File | Cases | Approach |
|------|------:|----------|
| `tests/test_invite_service.py` | 39 | real-Postgres `db` fixture: token opacity (sha256 hash lookup, wrong/empty token), RBAC (non-manager/owner/superadmin guards), live-chat feature gate, per-bot seat limit at the exact boundary, duplicate-pending & existing-operator conflicts, revoked/accepted/expired/idempotent accept branches, **and (post-fix) the create/accept success paths, per-bot seat isolation, and reactivation-reassign-to-new-bot** |
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
| **API** total statements | 66.37% | **67.26%** | +0.89 pts (4,660→4,762 tests) |
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
| `invite_service.py` | **97%** (was 81% while the `bot_id` bug made the success paths unreachable; now covered end to end after the fix) |
| `live_chat_routing_service.py` | **74%** |

Frontend targeted modules (`apiErrors.ts`, `pollUntil.ts`, `isLocalHostname.ts`,
and the entitlement/plan hooks) likewise went from 0% to full behavioral
coverage of their branches.

---

## Launch blocker: RESOLVED — `invite_service.bot_id`

### Root cause
`app/services/invite_service.py` constructs `OperatorInvite(..., bot_id=...)`
and `accept_invite` reads `invite.bot_id`, but `OperatorInvite` had **no
`bot_id` column** in either the ORM model or the baseline schema. Reproduced
directly: `TypeError: 'bot_id' is an invalid keyword argument for
OperatorInvite`. So `create_invite`/`accept_invite` raised at runtime and the
**POST `/invites` endpoint and invite acceptance were broken** — team-member
onboarding could not work.

### Investigation → product-model decision
Per the brief, I did **not** jump to adding a column. I traced the invite flow
end to end (create, accept, lookup, validation, the Operator/Bot/Client
relationships, models, migrations, routes, auth, frontend, tests, and every
`bot_id` reference) and answered the scoping questions from repository
evidence:

1. **Scoped to a specific bot?** **Yes.** `Operator.bot_id` is `NOT NULL`, so
   acceptance can only create an operator *for a bot*; the frontend requires a
   selected bot and sends `bot_id`; the create path validates the bot belongs
   to the workspace; seat limits are counted per-bot.
2. **Valid across multiple bots?** **No.** One pending invite per
   `(workspace, email)`; it targets exactly one bot; acceptance yields one
   Operator on that bot.
3. **Bot relationship represented indirectly elsewhere?** **No.** The Operator
   built at acceptance needs `bot_id` directly — there is no indirection to
   borrow it from.
4. **Is `bot_id` accidental?** **No — intentional but unfinished.** It is
   load-bearing across the request model (`CreateInviteRequest.bot_id`,
   required), response model (`InviteView.bot_id`), service, and frontend
   (`OperatorInvite.bot_id: number`, and the Members list filters invites by
   bot).
5. **Missing column caused by incomplete implementation?** **Yes.**
   `operator_invites` was born (baseline schema) without `bot_id`; the
   bot-scoping code was added later (single commit, already referencing
   `bot_id`) with no matching model column or migration. `create_invite` — the
   *only* writer of this table — has therefore never once succeeded.
6. **Would adding `bot_id` change existing behavior?** **No regression.** The
   endpoint 500'd before; there is no working behavior to preserve. The change
   makes the already-intended flow function.
7. **Would removing the plumbing be safer?** **No.** Removal would break the
   frontend (which sends and filters by `bot_id`) and leave no way to satisfy
   `Operator.bot_id NOT NULL` without inventing an arbitrary bot.

**Decision: Option A — bot-scoped invites are clearly intended.** Complete the
incomplete implementation.

### The fix
- **Model:** added `OperatorInvite.bot_id` — `FK bots.id ON DELETE CASCADE`,
  indexed, `NOT NULL` — mirroring `operators.bot_id`.
- **Migration `f3a7c1e9b204`:** adds the column + index + FK in the house
  idempotent style (offline-mode guard; index/FK names match what Postgres
  derives for the model so `create_all` and the migration converge). `NOT NULL`
  with no server default is safe because the only writer never succeeded, so
  the table holds no rows to backfill; on a populated DB the migration would
  fail loudly (non-destructive) rather than invent a bot.
- **Tests:** the seed helper now sets `bot_id`; added success-path coverage —
  `create_invite` persists a bot-scoped pending invite, `accept_invite`
  provisions an Operator on `invite.bot_id`, seat limits are enforced **per
  bot**, and reactivation reassigns to the new invite's bot. (Cross-workspace
  isolation at create was already covered.) `invite_service.py` coverage rose
  **81% → 97%**.
- **Frontend:** no change required — its `OperatorInvite` type already declares
  `bot_id`.

### Verification of the fix
- Migration chain on a **clean database**: `upgrade head` → `alembic check`
  ("No new upgrade operations detected" — model matches DB) → `downgrade -1` →
  `upgrade head`, all green.
- Runtime `TypeError` no longer reproduces; `create_invite`/`accept_invite`
  succeed.
- Affected + full backend suite green (**4,762 pass**); frontend green (app
  611, widget 119); ruff check/format clean; both production builds green.

**Launch blocker status: RESOLVED.**

## Other bug found (unchanged — separate, non-blocking)

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
| `invite_service` create/accept success paths | ~~Untestable until the `bot_id` bug is fixed~~ **RESOLVED** — now covered end to end (97%) | ~~High~~ Done | ✅ Done | No (resolved) |
| Invite acceptance via the HTTP route (`POST /invites` + `/accept`) end-to-end | Service layer is covered; the route wiring (auth gate → service → email dispatch) has only the verification-gate test | Low-Med | A TestClient round-trip that posts a valid `bot_id` and asserts a 200 + persisted invite/operator | No |
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
- **API:** ruff check ✓ · ruff format ✓ · full suite `4,762 pass` ✓
- **Migration (clean DB):** `upgrade head` → `alembic check` (no drift) →
  `downgrade -1` → `upgrade head` ✓ · existing migrations remain valid ✓

## Final status

**TEST COVERAGE STATUS: PASS.**

The suite is broad, genuinely behavioral, deterministic, and CI-gated. The
high-risk gaps that remained (invites/RBAC, quota, routing, intent, the widget
XSS/CSS security boundary, the paywall gate, async polling) are filled with
mutation-sensitive tests. The one launch blocker — the `invite_service.bot_id`
defect the testing surfaced — has been root-caused, fixed via the
evidence-backed correct data model (`operator_invites.bot_id`, completing an
unfinished implementation rather than papering over it), covered end to end
(`invite_service` 81% → 97%), and verified: the full backend suite (4,762),
the frontend suites, the clean-DB migration chain, lint/format, and both
production builds are all green.

PASS is claimed on both counts the brief requires: the blocker is genuinely
resolved (not merely made to pass a test), and the complete test/build suite
remains green. The items under "Remaining gaps" are ordinary future-coverage
work — none blocks launch.
