# Test Readiness Report — OyeChats Monorepo

_Assessment date: 2026-08-17 · Branch: `claude/monorepo-test-coverage-ynv9j4`_

This report covers a full assess → inventory → gap-analysis → implement → measure
pass across all three applications in the monorepo (`api/`, `app/`, `widget/`).
The k6 harness in `load-tests/` is performance tooling and is out of scope here.

> ## STATUS 2026-08-31
>
> **Kept for the open half, not the closed half.** The launch blocker is fixed and
> its full product-model reasoning is preserved in the migration itself
> (`api/alembic/versions/f3a7c1e9b204_*.py`), so that section is history. What still
> earns this file its place is "Remaining gaps (prioritized)" — which records *why*
> each open gap does not block launch — and "Manual testing still required", which is
> a live checklist.
>
> Two corrections:
> - **The counts below are stale.** They were true on 2026-08-17. The suite has grown
>   substantially since (the 2026-08-31 branch alone reports 140 app test files / 1,812
>   app tests, up from 69 / 611 here). Re-count before quoting any number in this file.
> - **The IPv6-loopback finding is still open.** `hostname === '::1'` is still there, now
>   at `app/src/features/agents/channels/embedEnvironment.ts:14` (the file is TypeScript
>   now, not `.js`). `new URL('http://[::1]:8000').hostname` returns the bracketed
>   `'[::1]'`, so the branch remains dead and an IPv6-loopback API endpoint still resolves
>   to `production`. Reported, still not fixed.
>
> The `injection_patterns.py` finding is unchanged and still pinned by
> `api/tests/test_rag_injection_guards.py:105`; the file is at
> `api/app/security/injection_patterns.py`.

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
**4,850 pass**), the frontend suites, the migration chain on a clean database,
lint/format, and both production builds are green.

A final targeted review pass then classified every remaining gap by production
risk and closed the four that mattered (invite HTTP routes incl. their
unauthenticated public endpoints, the prompt-injection/leak guards, the OAuth
`state` token negatives, and the background-enqueue seam) — **+88 tests, each
mutation-verified**.

**TEST READINESS: PASS** — no RELEASE BLOCKING or IMPORTANT BEFORE LAUNCH gaps
remain; the full test/build/migration suite is green. Everything still open is
NICE TO HAVE with a stated reason it does not block launch.

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
| **API** total statements | 66.37% | **67.83%** | +1.46 pts (4,660→4,850 tests) |
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
- Affected + full backend suite green (**4,762 pass** at the time of the fix;
  **4,850** after the final review pass); frontend green (app
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

## Final review pass — gap classification & closure

A last targeted pass reviewed this report, the coverage reports, and the
repository to classify every remaining gap by production risk, and then closed
only those that materially improve confidence. Nothing was added to move a
percentage.

### 1. Gaps identified before this pass

| # | Gap | Classification |
|---|-----|----------------|
| 1 | **Invite HTTP route layer** — `invite_routes.py` at **38%**; the service layer was covered but the routes were not, including the two **unauthenticated** public token endpoints that grant workspace access | **IMPORTANT BEFORE LAUNCH** |
| 2 | **Prompt-injection / prompt-leak guards** — `is_visitor_injection_attempt` and `contains_system_prompt_leak` had **zero** direct tests (found during this pass) | **IMPORTANT BEFORE LAUNCH** |
| 3 | **OAuth `state` token negatives** — only the happy-path round-trip was tested; no tamper/forge/expiry coverage on the OAuth CSRF + attribution token (found during this pass) | **IMPORTANT BEFORE LAUNCH** |
| 4 | **`worker/enqueue.py` at 23%** — the seam every background job crosses, containing two documented incident fixes | **NICE TO HAVE** (raised — cheap and pins real regressions) |
| 5 | `rag_service.rag_pipeline_stream` — ~1,800 uncovered lines of streaming orchestration | **NICE TO HAVE** |
| 6 | `worker/tasks.py` at 60% — long task bodies | **NICE TO HAVE** |
| 7 | `push_service` 49%, `operator_presence_service` 27% | **NICE TO HAVE** |
| 8 | Widget React components (25 `.jsx`, no unit tests) | **NICE TO HAVE** |
| 9 | Widget `api.js` (network/SSE) | **NICE TO HAVE** |
| 10 | App page/feature components | **NICE TO HAVE** |
| 11 | `/me/self-operator` + `/me/workspaces` routes | **NICE TO HAVE** |

**No gap was classified RELEASE BLOCKING.** The one release blocker in this
codebase (`invite_service.bot_id`) was resolved in the previous pass.

### 2. Gaps closed in this pass (+88 backend tests, 4 files)

| File | Tests | What it closes |
|------|------:|----------------|
| `tests/test_invite_routes_http.py` | 18 | Gap 1. Full HTTP round-trip — owner creates → **emailed token** → anonymous airlock lookup → invitee accepts → `Operator` bound to the invite's bot. Plus cross-tenant isolation on list/revoke/resend, token rotation killing the old link, single-use acceptance (410), revoked-link refusal, the `InviteError`→HTTP mapping, and a Brevo failure not rolling back the invite. |
| `tests/test_rag_injection_guards.py` | 42 | Gap 2. Known jailbreak phrasings, ChatML/delimiter role spoofing, case-insensitivity, mid-message injection — **and** the false-positive side (ordinary visitor questions must stay answerable). Leak check is driven off the real `_LEAKAGE_SENTINELS` tuple so the two cannot drift apart. |
| `tests/test_oauth_state_token_security.py` | 16 | Gap 3. Payload tampering (self-granting a promo code), redirect rewriting, signature forgery + substitution, unsigned payloads, malformed input, expiry and zero/missing `ts`, plus the just-inside-the-window boundary. |
| `tests/test_worker_enqueue.py` | 12 | Gap 4. The strong reference that stops a fire-and-forget enqueue being GC'd mid-flight; the per-call pool that avoids "Event loop is closed"; dedup passthrough; Redis-outage swallowing; and the job-status mapping (a completed-but-**failed** job must report `failed`, not `complete`). |

**Coverage on the closed modules:** `invite_routes.py` **38% → 75%**,
`worker/enqueue.py` **23% → 93%**, and the OAuth state-token + RAG guard
functions from **no direct coverage → fully exercised**.

### 3. Mutation verification (not just "the tests pass")

Every new file was checked by breaking the guarantee it claims to protect and
confirming the right tests fail. Source was restored after each run:

| Guarantee removed | Result |
|---|---|
| Workspace filter on invite list | `test_list_returns_only_the_callers_workspace` **failed** |
| Email-mismatch guard on accept | `test_accept_rejects_a_different_signed_in_account` **failed** |
| HMAC signature check + expiry check | **6** OAuth tests failed |
| One injection regex fragment | **4** injection tests failed |
| Strong reference on the background task | `test_enqueue_sync_inside_a_running_loop…` **failed** |

Two weak assertions written during this pass were tightened before commit
(`status in (402, 403)` → exact `403 live_chat_locked`; `in (200, 409, 410)` →
exact `410 invite_already_accepted`), and no test asserts only that a mock was
called.

### 4. Minor defect found while testing (reported, not silently fixed)

The `you are now …` exclusion in `app/security/injection_patterns.py` is
narrower than its own comment claims. The comment says it excludes "you are now
talking to our assistant/support", but `(?!assistant|support)` is an
*immediate* lookahead, so only the bare forms are excluded — and the optional
`(?:a\s+)?` lets the regex backtrack past the exclusion entirely, so
"you are now a support agent" is flagged too.

This is **over-blocking (a false positive), not an under-blocking security
hole**: a legitimate visitor phrasing gets refused. It is pinned as current
behavior in `test_you_are_now_exclusion_is_narrower_than_its_comment_claims`
rather than "fixed" by loosening a security filter without product input.
Risk: **LOW**. Does not block launch.

---

## Remaining gaps (prioritized)

All CLOSED items are listed for traceability; everything still open is
classified, with the reason it does not block launch.

| Area | Classification | Status | Why it does not block launch |
|------|----------------|--------|------------------------------|
| `invite_service` create/accept success paths | was RELEASE BLOCKING | ✅ **CLOSED** (97%) | Resolved with the `bot_id` fix; covered end to end. |
| Invite **HTTP route** round-trip incl. public token endpoints | was IMPORTANT BEFORE LAUNCH | ✅ **CLOSED** (38%→75%) | Full journey + cross-tenant + authz now covered, mutation-verified. |
| Prompt-injection / prompt-leak guards | was IMPORTANT BEFORE LAUNCH | ✅ **CLOSED** | 42 behavioral tests, both directions (catch attacks, don't refuse customers). |
| OAuth `state` tamper/forge/expiry | was IMPORTANT BEFORE LAUNCH | ✅ **CLOSED** | 16 negative-path tests, mutation-verified against guard removal. |
| `worker/enqueue.py` | was NICE TO HAVE | ✅ **CLOSED** (23%→93%) | Both documented incident fixes pinned. |
| `rag_service.rag_pipeline_stream` (~1,800 uncovered lines) | **NICE TO HAVE** | Open | It is one monolithic streaming generator over LLM + embeddings + DB. A unit test would need to stub every one of those and would assert the stub choreography, not behavior — the "false confidence" the brief warns against. Its *decision helpers* (retrieval, ranking, CAG-lite threshold, relevance gate, media cards, refusals, safety) **are** covered by 31 existing test files, and the end-to-end path is exercised by manual QA and the k6 chat-stream scenario. Recommended future work: a seam-level integration test with a recorded LLM transcript. |
| `worker/tasks.py` (60%) | **NICE TO HAVE** | Open | Already exercised by ~20 task-level test files (invoice PDF, email retry, dunning cron, re-embed, recrawl, renewal isolation). The uncovered remainder is long task bodies whose decision points are individually covered. Failures are retried by ARQ and observable via Sentry/Langfuse. |
| `push_service` (49%), `operator_presence_service` (27%) | **NICE TO HAVE** | Open | Both degrade safely: a missed web-push or a stale presence row degrades UX, never data integrity, money, or access control. No tenant-isolation or auth logic lives in either. |
| `oauth_service.exchange_code_for_profile` / `verify_id_token` | **NICE TO HAVE** | Open | Pure HTTP conversations with Google's token/tokeninfo endpoints. Testing them means asserting against a mocked Google, which validates the mock rather than the integration. The security-bearing half (the signed `state` token) is now fully covered. Belongs in a staging smoke test against a real Google test project. |
| `/me/self-operator`, `/me/workspaces` routes | **NICE TO HAVE** | Open | Owner-as-operator convenience + the workspace switcher list. The seat/entitlement logic they call (`_require_seat_available`, the live-chat gate) is covered at the service layer and via the invite routes; these endpoints add routing on top. |
| Widget React components (25 `.jsx`) | **NICE TO HAVE** | Open | Behavior is covered where it is risky: the security boundary (`sanitize`), link suppression, markdown/sentinel handling and the slash-command parser are unit-tested, and mount/lazy-load/`identify` are covered by Playwright. The rest is presentational. |
| Widget `api.js` (877 loc, network/SSE) | **NICE TO HAVE** | Open | Almost entirely `fetch`/SSE plumbing; the correct layer is E2E against a mock backend, not unit mocks of `fetch`. |
| App page/feature components | **NICE TO HAVE** | Open | The logic behind them (entitlements, plan gates, billing model, paywall gate, polling, CSV safety) is unit-tested; the components are largely presentational. Chasing the global % here would add brittle render tests. |
| **Manual/staging verification still required** | — | Open | See "Manual testing still required" below. |

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

### Flaky tests — final position

- **One flaky test was found across all passes**, and it is fixed: the widget
  `identify()` E2E raced the async API bootstrap (waited on the loader *stub*
  rather than the real implementation). Failed ~1 in 3 cold runs; now waits for
  the real API. Re-verified **3/3 consecutive green runs** in this pass, on top
  of the 5/5 recorded earlier.
- **No new flakiness was introduced.** The 88 tests added in this pass use no
  real clock, no network, no Redis and no cross-test shared state; the invite
  route tests reuse the existing TRUNCATE-per-test `db` fixture and the autouse
  `_reset_rate_limiter` fixture, so they are order-independent. The new files
  were each run repeatedly during development with identical results.
- **Known environment-dependent (not flaky) cases:** the widget Playwright
  `mobile` project needs WebKit, which is not installed in this sandbox
  (Chromium only) — it is not a code failure. DB-backed backend tests skip
  cleanly when `DB_URL` is unset.

### Manual testing still required

These cannot be meaningfully automated in this repo today and should be
verified by hand (or in staging) before launch. None is a *test-suite* gap:

1. **Google OAuth end-to-end** against a real Google project — the signed
   `state` token is covered, but the code↔token exchange talks to Google.
2. **Razorpay live checkout** — the webhook/idempotency/ledger logic is heavily
   covered, but a real card/UPI payment round-trip is environment-bound.
3. **Invite email delivery** — the invite→token→accept chain is now covered in
   full, but that Brevo actually *delivers* the mail (templates, spam
   placement) is external.
4. **RAG answer quality** on real customer documents — correctness of retrieved
   answers is a judgment call, not an assertion.
5. **Widget embedding on real host sites** (WordPress/Webflow/Shopify) and the
   `mobile`/WebKit E2E project.
6. **Invoice PDF rendering** — depends on system pango/WeasyPrint, which is
   platform-specific (see the worker rules in `CLAUDE.md`).

---

## Final test counts

| Suite | Baseline | Final | Δ |
|-------|---------:|------:|---|
| **API** (pytest, 328 files) | 4,660 | **4,850** | +190 |
| **App** (vitest, 69 files) | 550 | **611** | +61 |
| **Widget** (node:test) | 86 | **119** | +33 |
| **Widget E2E** (Playwright/Chromium) | 3 (not runnable) | **3 (runnable, stable)** | infra fixed |
| **Total automated tests** | 5,299 | **5,583** | **+284** |

## Final coverage

| Metric | Baseline | Final |
|--------|---------:|------:|
| **API** statements | 66.37% | **67.83%** |
| **App** statements | 16.82% | **17.15%** |
| **App** branches | 14.84% | **15.16%** |
| **App** functions | 13.65% | **14.01%** |
| **App** lines | 17.72% | **18.02%** |

Critical-path modules matter more than the totals. Where risk is concentrated:
`invite_service` **97%**, `worker/enqueue` **93%**, `intent_service` **100%**,
`knowledge_quota_service` **89%**, `invite_routes` **75%** (from 38%),
`razorpay_service` 79%, `plan_entitlements_service` 75%, and the OAuth
state-token + RAG injection/leak guards fully exercised. The global App figure
stays low by design — its denominator is the entire `src/**`, dominated by
presentational React that unit tests would cover only brittlely.

## Final build / type / lint / E2E status

| Check | Result |
|-------|--------|
| API — full suite (4,850) | ✅ pass (8m33s) |
| API — `ruff check` / `ruff format --check` | ✅ clean |
| API — migrations on clean DB (`upgrade`→`check`→`downgrade -1`→`upgrade`) | ✅ pass, **no schema drift** |
| App — `vitest run` (611) | ✅ pass |
| App — `eslint` | ✅ clean |
| App — `tsc --noEmit` | ✅ clean |
| App — production build | ✅ pass |
| Widget — `node:test` (119) | ✅ pass |
| Widget — `eslint` | ✅ clean |
| Widget — production build | ✅ pass (loader 1.24 KB gzip) |
| Widget — **E2E Playwright/Chromium** | ✅ **3/3, green on 3 consecutive runs** |
| Widget — E2E `mobile` project | ⚠️ needs WebKit (not installed in this sandbox) — environment, not code |

## Final status

**TEST READINESS: PASS**

The suite is broad, genuinely behavioral, deterministic, CI-gated, and — where
it matters most — **mutation-verified**: every file added in the final pass was
checked by deliberately breaking the guarantee it protects and confirming the
right tests fail (tenant isolation, email-mismatch, HMAC signature, expiry,
injection patterns, background-task retention).

- **No RELEASE BLOCKING gaps remain.** The single blocker found in this work
  (`invite_service.bot_id`) was root-caused, fixed with the evidence-backed data
  model rather than a test workaround, and is covered end to end.
- **No IMPORTANT BEFORE LAUNCH gaps remain.** All four — the invite HTTP route
  layer (including its unauthenticated public endpoints), the prompt-injection
  and prompt-leak guards, the OAuth `state` token negatives, and the background
  enqueue seam — were closed in this pass.
- Everything still open is **NICE TO HAVE**, each with a stated reason it does
  not block launch (see "Remaining gaps"). The dominant one — the RAG streaming
  generator — is deliberately left to integration/manual QA rather than covered
  with stub choreography that would read as confidence without providing it.
- **One flaky test existed and is fixed**; no new flakiness was introduced.
- Two minor, non-blocking defects are reported rather than silently patched: the
  dead `::1` IPv6-loopback branch in `embedEnvironment.js`, and the
  narrower-than-documented `you are now …` injection exclusion (over-blocking,
  not a security hole).

PASS is claimed on qualitative grounds as well as quantitative: the numbers
moved modestly, but the tests that moved them are the ones that would actually
catch a regression in authentication, authorization, tenant isolation, money,
data integrity, and the core user journeys. Manual/staging verification is
still required for the six externally-bound areas listed above.
