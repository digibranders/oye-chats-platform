# Execution log, plan-less 14-day trial

Plan: `docs/superpowers/plans/2026-08-28-trial-model.md`
Branch: `claude/trial-model-14d`, cut from `development` at `8192e408`.

## Environment

| Item | Value |
|---|---|
| Postgres | 16 (Ubuntu cluster `16/main`), `postgresql-16-pgvector` 0.6.0 installed from apt |
| `DB_URL` | `postgresql://postgres:postgres@localhost:5432/oyechats` |
| Extensions | `vector` and `citext` created by the `pg_engine` fixture on `oyechats_pytest` |
| Harness proof | `uv run pytest tests/test_activation_events.py -q --no-cov` reported **6 passed**, zero skipped |
| Frontend | `npm ci` in `app/` |

Every backend figure below is a run with `DB_URL` exported, so DB-backed tests
execute rather than skip. Where a number of skips is reported it is named.

Baseline established after Task 1 with the whole suite: **5869 passed, 4 skipped**
(5873 collected).

## Task log

### Task 1, `plans.is_public`

Status: **done**.

Failing test first (`tests/test_trial_signup_defaults.py`), verified failing with
exactly the error the plan predicted, `TypeError: 'is_public' is an invalid
keyword argument for Plan`. Then the column on `Plan`, migration
`l6a7b8c9d0e1` chained off the single head `k5f6a7b8c9d0` (confirmed with
`alembic heads`, not assumed), the `is_public` filter in
`plan_service.get_active_plans`, and the purchase guard on all three plan
resolution sites: `/checkout/quote`, `/checkout` and `/change-plan`.

Deviation, recorded rather than improvised: ten tests in
`tests/test_change_plan_unlimited_agent_guard.py` failed after the guard landed.
Cause is not the guard. That file builds `Plan` objects that are never flushed,
so SQLAlchemy column defaults never fire and `is_public` reads `None`. The file
already passes `is_active=True` explicitly for exactly this reason, so the fix
follows its own convention: `_plan` now also passes `is_public=True`. Production
rows cannot take this shape, the column is `NOT NULL` with a server default.

Gates: two new tests pass. `-k "plan_service or pricing_catalog or
checkout_quote"` 9 passed. `-k "plan or checkout or subscription"` 647 passed.
Whole suite 5869 passed, 4 skipped. `ruff check` clean, `ruff format --check`
clean (642 files).

### Task 1 review

Fresh-context adversarial subagent, 6 findings. Fixed in the Task 2 commit
(they were reported after the Task 1 commit was already pushed):

1. **`POST /bots/checkout` is a fourth purchase entry point and was unguarded**
   (`api/app/api/bot_routes.py`). It resolves any active plan by slug, and the
   only slug it refuses is `free`, so `{"plan_slug": "trial"}` went through.
   Worse than a wrong price: the route hands the request to
   `pending_checkout_service.reuse_or_supersede`, which cancels the account's
   in-flight mandate at the gateway on a plan mismatch, and that cancel is
   irreversible, so the request would destroy a real mandate and then fail with
   a contact-sales error. Fixed by adding `is_public` to the lookup predicate
   (not a later refusal), which keeps this route's deliberate 404-not-400
   semantics, with a regression test proven to fail without the guard.
2. **The three Step 4 guards had no test.** An implementation that added the
   column and the listing filter but skipped Step 4 entirely would have passed.
   Added three route tests, each verified failing with the guard removed.
3. **Three docstrings described the old behaviour**
   (`subscription_routes.list_plans`, `public_pricing_routes` module docstring,
   `app/src/features/workspace/billingModel.ts`). Reworded.
4. `plan_service.start_trial` accepts the seeded trial row by slug between
   Tasks 2 and 2b. Task 2b removes the route; recorded, not separately fixed.
5. `is_public` is not serialized or editable in the super-admin plan surface.
   Out of scope for this plan; recorded as a follow-up.
6. `/subscriptions/admin/plan-price-check` iterates `get_active_plans` and so
   silently skips non-public rows. Harmless for a row priced at zero; recorded.

### Task 2, seed the trial row

Status: **done**.

Tests written first and verified failing with `KeyError: 'trial'` exactly as the
plan predicted (proven by stashing `scripts/seed_plans.py` and re-running).

Two plan-versus-code discrepancies recorded rather than improvised around:

* The plan calls the upsert tuple `_UPSERT_FIELDS` at `seed_plans.py:300`. It is
  actually `_SCALAR_FIELDS`. `is_public` was added to the real one.
* Plan Step 4 expects the dry-run to print `free.is_default true→false` and the
  `is_public` backfills. The seeder's dry-run prints only a verb, price, credit
  count and checkout-wiring state per slug, never field-level changes. So the
  dry-run was run twice, once against a DB seeded from the pre-change matrix, to
  confirm the verbs (one `insert trial`, five `update`), and the field-level
  effects were then verified directly against the local dev database after an
  `--apply` there: trial `is_default t / is_public f / is_active t /
  trial_days 14 / 500 credits / sort_order 0`, free demoted to `is_default f`,
  standard at `trial_days 0`, `is_public t` on all five public rows.

Three problems the plan did not anticipate, all caused by the new row:

* **`test_the_ladder_covers_every_seeded_plan`** asserted the seed matrix equals
  the price ladder. The trial is not a rung: it is priced at zero, never listed
  and never sold, and every guard in that file reasons about what a customer can
  buy. Narrowed to public rows, with a second assertion naming the non-public
  set so a future delisted row still has to be declared here.
* **Silent over-grant.** `plan_entitlements_service._paid_tier_includes` treats
  any slug outside `_SEEDED_PLAN_SLUGS` as a bespoke per-contract enterprise row
  and grants it every gated feature. The trial would have collected visitor
  intelligence and email verification by accident, through the bespoke rule,
  while missing journey analytics, lead-source attribution and delta recrawl,
  which are plain `in` checks. Neither half matches "every Professional
  feature". Resolved deliberately, as the module's own docstring asks: `trial`
  added to `_SEEDED_PLAN_SLUGS` and to all five ladders, with a test pinning the
  trial's answer to Professional's on every one of them.
* **The docs exporter would have published the trial.**
  `scripts/export_plan_matrix.py` feeds the public documentation's plan and
  capability tables from `_PLANS`. It now drops non-public rows and clamps every
  capability's slug list to the published set, which is the same decision
  `is_public` encodes everywhere else.

One self-inflicted defect, caught by the full suite and fixed: the ladder edit
dropped `"standard"` from `EMAIL_VERIFICATION_SLUGS`.

Gates: full backend suite 5875 passed, 4 skipped after the fix (two failures
before it). `ruff check` and `ruff format --check` clean. Frontend
`tsc --noEmit` and `npm run lint` clean, run because the review's finding 3
touched `app/src/features/workspace/billingModel.ts`.

### Task 2 review

Fresh-context adversarial subagent (this one and every one after it forbidden
from running any test runner, after the first review's pytest run collided with
mine over the shared throwaway database). 6 findings, all real, all fixed in the
Task 2b commit:

1. **A sixth slug-keyed gate.** `quotation_routes.QUOTATION_PLAN_SLUGS` gates the
   quotation flow on a bare `in` check with no bespoke fallback, and the trial
   was not on it. So the row's own description, which
   `subscription_routes` serializes into the dashboard, promised "fourteen days
   of everything" while a Professional feature 403'd. `trial` added. The parity
   test that was supposed to catch this hand-enumerated five ladders and could
   never have found a sixth, so it now DISCOVERS gates by scanning the modules
   for module-level `*_SLUGS` frozensets. Verified: removing `trial` from
   `QUOTATION_PLAN_SLUGS` now fails that test.
2. **The retired 7-day offer still lived in two defaults.**
   `models.Plan.trial_days` carried a comment asserting "Standard 7, trials are
   Standard-only", and `superadmin_plan_routes` defaulted a hand-created tier to
   `trial_days=7`, which would have minted a second trial concept. The editor
   default is now 0 and the comment states the real policy. The column's
   `server_default="7"` is left alone deliberately: changing it needs a
   migration for rows nothing creates, and the comment now says so. Flagged.
3. **`auth_routes` registration comment described the behaviour this work
   removed** ("the default plan is free ... the trial is opt-in via the billing
   modal"). Reworded. Its welcome-email fallbacks also still named the retired
   offer's shape, 750 credits and 7 days, so a missing plan relationship would
   have emailed a customer numbers no row carries. Both read the row or say
   zero now, and `config.TRIAL_CREDITS` (the 750) is deleted, having lost its
   only reader.
4. **Narrowing the ladder guard dropped the trial out of two invariants that
   still apply to it.** `test_limits_credits_mirrors_credits_per_month` and
   `test_no_plan_bundles_branding_removal` now walk every seeded row; only the
   price and annual-discount guards stay ladder-only, because they divide by a
   price the trial does not have.
5. **The seed test pinned about a third of the row.** Nothing asserted the four
   price fields are zero, which matters: the row is `is_default`, so
   `assign_default_plan_to_client` opens a subscription on it and grants credits
   with no payment in the loop. Prices, seats, sort order and the rest of the
   limits map are pinned now.
6. Two nits fixed: the seed dry-run printed `self-serve` for the one row the
   whole change exists to make un-buyable (it now prints `NOT FOR SALE,
   delisted`), and the exporter's gate test derived both sides of its assertion
   from the exporter's own output, so it could only catch a rename. It reads the
   seed directly now.

### Task 2b, retire the Standard-only trial offer

Status: **done**.

Failing test first: `test_start_trial_route_is_gone` asserts both that no route
in the subscriptions router ends in `/start-trial` and that a POST to it 404s.
Verified failing before the removal.

Removed: `POST /subscriptions/start-trial` with its `StartTrialRequest`,
`plan_service.start_trial`, `plan_service.TrialUnavailable`, and the one test
that pinned them (`test_start_trial_acquires_billing_lock`; the lock invariant it
covered is still covered for the surviving path by the test directly below it).
`has_used_trial` is KEPT: it feeds `/subscriptions/current`'s `trial_used`, which
the payload still carries. So is `assign_default_plan_to_client`'s `trial_days >
0` branch, which IS the new trial's mechanism.

Frontend: the `startTrial` client, the trial branch in `usePlanCheckout`,
`isTrialEligible`, the card-free-trial CTA in `PlanPickerDialog`, and the
`trialUsed` prop threading behind them are gone. `submit`'s `actionKind`
parameter went with them: its only purpose was forcing the trial path and no
caller passed it. `grep startTrial src/` is now zero hits.

Two tests were retargeted rather than deleted, because their subject was not the
trial: the keyboard-navigation test used the trial button only as a focus
target, and "never offers a trial the backend would refuse" is now an
unconditional invariant ("never offers a trial, because the picker is not where
trials start").

Copy that named the deleted route was corrected wherever it appeared: the
super-admin `extend_trial_days` 409 told a support engineer to send the customer
to `POST /subscriptions/start-trial`, which was the plan's own
false-published-claim failure mode in miniature. It now names what actually
exists. Same for three code comments in `plan_service`, `razorpay_service` and
`superadmin_plan_routes`.

Gates: full backend suite **5879 passed, 4 skipped**. `ruff check` and
`ruff format` clean. Frontend `tsc --noEmit` clean, `npm run lint` clean
(1 pre-existing warning, 0 errors), `npx vitest run` 134 files / 1767 tests
passed.

Also merged `origin/development` (`24ce482`, a WidgetMock refactor) into the
branch at the user's request. Clean merge, frontend only, and the full frontend
suite was re-run against it.

### Task 2b review

11 findings. All the real ones fixed in the Task 3 commit.

1. **HIGH, and it was the task's own stated failure mode.** Removing the trial
   CTA's label left the sentence beside it: a plan card with `trialDays > 0`
   still rendered "7-day free trial, no card needed." above a button now reading
   "Subscribe" that goes straight to Razorpay. The replacement test asserted on
   a button role, so a paragraph sailed past it, and the fixture rendered that
   exact string while the test passed. The copy is deleted; the test now asserts
   on TEXT with the fixture still carrying `trial_days: 7`, so a plan row with a
   trial length can never resurrect the promise. Verified: re-adding the
   sentence fails it.
2. **HIGH.** The parity test asserted `_paid_tier_includes` over all six gates,
   but two of them (quotation, delta recrawl) use a bare `in` and never call it,
   so those assertions were vacuous. Worse, they papered over a live split:
   `_paid_tier_includes` grants any slug outside `_SEEDED_PLAN_SLUGS` (a bespoke
   per-contract tier) while a bare `in` denies it. That split is pre-existing
   and out of this plan's scope, so it is NOT changed. The test now asserts
   membership parity on every gate and the wrapper only where it is the
   enforcer, with a comment naming the split so the next reader sees it.
3. **MEDIUM.** The gate scan was still enumerated one level up: a hardcoded
   module list, `frozenset` only, and a floor of "at least one gate found". It
   now walks every file under `app` and carries `_KNOWN_SLUG_GATES` as a floor.
   Walking FILES rather than `pkgutil.walk_packages` matters: `app/api` has no
   `__init__.py`, so the package walker never descended into it and would have
   silently missed the one gate the scan exists to catch. Verified against both
   failure modes: dropping the trial from a gate fails, and renaming a gate out
   of the `_SLUGS` convention fails.
4. **MEDIUM.** My previous fix made the degraded welcome email worse, not
   better. `credits=0, duration_days=0` renders "your 0-day free trial is live,
   you've got 0 credits", asserted to a customer whose subscription IS trialing
   and whose credits ARE in the ledger. Stale-but-plausible was replaced by
   self-evidently broken. The email is now skipped when the plan row is missing,
   with a warning log; the trial payload still reaches the app. The sibling
   OAuth signup path carried the same retired-offer fallback and additionally
   reported 7 days for a row that says 0. Fixed to match.
5. **MEDIUM, and it corrects this log.** `usePlanCheckout`'s `currentPlanSlug`
   and `currentSubscriptionStatus` existed only to feed `isTrialEligible` and
   became dead. That produced a `react-hooks/exhaustive-deps` warning which the
   Task 2b entry above recorded as "1 pre-existing warning". It was not
   pre-existing, it was mine. Removed, along with the now-dead `currentStatus`
   prop on `PlanPickerDialog` and `useBillingData.trialUsed`, which lost its
   last reader. `npm run lint` is now clean with **zero** warnings.
6. LOW. The promo comment still described suppressing an auto-trial path that no
   longer exists, in the function that removed it. Reworded.
7. LOW. `EMAIL_INVENTORY.md` still cited `subscription_routes.py:221 (trial
   start)`. Already corrected in the Task 3 work.
8. LOW. `docs/billing/2026-07-09-billing-invoice-system-architecture.md` still
   drew `[*] --> trialing: start-trial` in the state machine and listed Starter
   at 14 trial days. Both corrected, with a paragraph saying where the trial row
   is and why it is not in the catalogue table.
9. LOW. The newly recognised sixth gate was absent from the exported capability
   matrix, so the published docs under-reported what Professional and Enterprise
   include. Added, with its row in the exporter test. Two stale docstrings in
   `quotation_routes` that still said Professional-only were reworded.
10. LOW. The reworded super-admin 409 named a remedy no API offers: the console
    cannot write `trial_start` / `trial_end`. It now says granting a trial to an
    existing customer is not a supported operation, which is true.
11. LOW. Covered by 5.

### Task 3, signup lands on the trial

Status: **done**. This task verifies rather than builds.

`test_signup_opens_a_trialing_sub_with_500_credits` passed on the first run,
which the plan says is the point: `assign_default_plan_to_client`'s `trial_days
> 0` branch already opens the subscription trialing, pins `current_period_end`
to `trial_end`, and grants the plan's credits inline. `credit_service.get_balance`
exists under that name, so the plan's test needed no adaptation.

Copy, per Step 3:

* A real defect found while reading `send_trial_welcome_email`: its subject line
  was `Welcome to OyeChats (your 14-day trial is live` with the closing paren in
  the shell's copy of the same string, `Welcome to OyeChats) your ...`. An
  em-dash strip had put the parentheses on the wrong words, and both halves ship
  to customers. Fixed to a comma.
* `send_trial_days_left_email` named the plan in its headline, which with the
  seeded row renders "your Free Trial trial ends tomorrow". It no longer renders
  the name. The `plan_name` parameter is kept, as the plan instructs, with a
  docstring saying why it is accepted and not shown.
* `EMAIL_INVENTORY.md` updated for both, including dropping the trigger that
  pointed at the deleted start-trial route.

The retention promise in the days-left body ("kept safe for 15 days after the
trial ends") is deliberately left for Task 5, which is where the retention model
actually changes and where the trial-ended email is rewritten, so both claims
move in one commit with one inventory update.

Gates: full backend suite **5880 passed, 4 skipped**. `ruff check` and
`ruff format` clean. Frontend `tsc --noEmit` clean, `npm run lint` clean with
zero warnings, `npx vitest run` 134 files / 1767 tests passed.

One observation recorded, not a finding:
`tests/test_superadmin_invoices.py::test_resend_email_requires_pdf_and_buyer_email`
fails under a `-k`-filtered run and passes both alone and in the full suite. It
is order-sensitive on some other module's state, is unrelated to this work, and
does not fail any gate this plan runs.

### Task 3 review

12 findings. All the actionable ones fixed in the Task 4 commit.

1. **HIGH.** The day-0 welcome email's three quick-start links were dead. It
   linked `/knowledge` and `/chatbot`, neither of which is a route in the
   rebuilt console nor in its legacy-redirect table, so every step of "a 3-step
   path to your first chat" landed on Not Found, for every new signup. The real
   pages are per chatbot and the email has no chatbot id, so all three now point
   at `/chatbots`, where all three actually begin.
2. **MEDIUM-HIGH.** The literal string Step 3 named, "your trial of {plan}",
   still shipped in `send_trial_ended_email`, rendering "Your trial of Free
   Trial wrapped up today." I had deferred it to Task 5 on the grounds that Task
   5 rewrites that email, but the deferral I recorded covered the RETENTION
   claim in a different email. Reworded now; Task 5 still rewrites the body.
3. **MEDIUM.** The reminder cadence is already wrong on a 14-day row: the
   halfway email fires at `days_remaining == 4`, which is day 10 of 14, and the
   body says "you're halfway through". Nothing is sent for the first ten days.
   This is Task 5 Step 5's job and is left there deliberately, but it is now
   written down in `EMAIL_INVENTORY.md` as a known gap rather than being implied
   by stale headings.
4. **MEDIUM.** My B1 edit had left `EMAIL_INVENTORY.md` self-contradicting: one
   document saying the trial is 14 days, the cadence is the 7-day one, and 14
   days is "legacy". B2 and B3 reconciled.
5. **MEDIUM-LOW.** The welcome-email skip I added guarded the wrong thing. It
   skipped on a missing plan row, but a row carrying zero credits or zero trial
   days still sent, rendering the "0 credits / 0-day trial" the guard existed to
   prevent. Both paths now guard on the NUMBERS, and the OAuth path, which
   skipped silently, logs.
6. **LOW.** `credits_granted` still went into the trial payload as 0 for the
   case the email refuses to send. The field is `int | None` and the login path
   already answers None. Fixed.
7. **LOW.** Nothing tested the welcome email at all, which is how a broken
   subject line and three dead links shipped. `tests/test_trial_welcome_email.py`
   pins the subject, asserts every APP_URL link resolves to a real route, and
   records what a zero renders. Verified: reintroducing either original defect
   fails it.
8. **LOW.** `_mk` granted 500 credits to every plan it built, so the signup
   test's balance assertion could not tell the trial's grant from Free's or from
   a hardcoded constant. Free now grants 200.
9. **LOW.** The gate scan imported all 165 modules under `app` into the test
   process to read their attributes, and silently dropped the gate of any module
   that failed to import. It parses with `ast` now: no imports, no side effects,
   and an unimportable module is still scanned.
10. **LOW.** The narrowed `_paid_tier_includes` loop was near-vacuous, since
    that function collapses to plain membership for any slug on the roster. It
    now asserts the one thing it actually adds, that the trial IS on the roster,
    plus the bespoke-slug behaviour that makes the roster matter.
11. **LOW.** Three comments claimed pinning `current_period_end` to `trial_end`
    makes the billing UI's "renews on" label the trial deadline.
    `getRenewalDisplay` short-circuits on `trialEnd` and renders "Trial ends",
    never reading `currentPeriodEnd` for a trialing row. The real reason (the
    trial IS the period, and the renewal cron reads that column) is stated now.
12. Retention claims: recorded for Task 5.

### Task 4, first training free and a wall that upsells

Status: **done**.

`resolve_crawl_cost_per_page` written test-first, verified failing with
`ImportError` as the plan predicted, then wired into all three charging sites
(`/crawl/discover`'s quote, `/crawl/diff`, and the crawl start) so the estimate
a customer is shown is the price they are charged.

One signature deviation from the plan, recorded rather than improvised: the plan
writes `resolve_crawl_cost_per_page(session, client_id, bot)`. Every crawl route
takes `bot_id` as an OPTIONAL query parameter and none of them has a `Bot` in
hand at the charging site, so the helper takes `bot_id: int | None`. With no bot
to scope to it falls back to the client's own crawl history, because reading
"no bot, so no crawls" would hand out a fresh free training on every
account-level call. Covered by its own test.

Mutation-tested rather than assumed: ignoring the feature flag, dropping the
`source == "crawl"` filter, and ignoring the per-bot scope each fail a distinct
test.

The honest wall, both halves:

* The crawl-outcome mislabel is fixed at the source. A crawl stopped by an empty
  credit balance, a knowledge-character ceiling, or the kill switch indexed
  nothing, which was indistinguishable from a JS-rendered site, so the customer
  was told "we couldn't extract readable text to train on" and sent to debug a
  rendering problem they did not have. `batch_web_ingestion` now names WHY it
  aborted, and `_terminal_status` maps a limit abort to a new `limit` outcome
  with its own message. Partial success stays `done`: pages that landed before
  the abort are real knowledge. `limit` was threaded through the frontend's
  status union, terminal sets and `isCrawlFinished`, and `WebsiteFlow` renders
  it as a warning that says upgrade rather than a danger that says debug.
* The per-crawl cap wall names the site's real size on the trial: "Your site has
  340 pages. Your trial trains 100. Upgrade to train them all, or deselect 30 to
  continue now." Paid tiers keep the deselect-first sentence, because on a paid
  tier that is the actionable move.

**Harness fix, and it is a deviation worth reading.** Three of this task's gate
runs came back with dozens of ERRORs in unrelated modules that passed when run
alone. The cause is not this work: `tests/conftest.py`'s `pg_engine` was
module-scoped, so every DB-backed module DROPped and CREATEd the same
`oyechats_pytest`, and with enough modules in one run those cycles interleave
and the CREATE fails with `duplicate key value violates unique constraint
"pg_database_datname_index"`. The Task 1 reviewer independently hit it and
confirmed it pre-existed. Adding DB-backed modules made it fire more often, and
it reads exactly like a real regression, which makes every gate number
untrustworthy. The fixture is session-scoped now; isolation is unchanged because
the function-scoped `db` fixture still TRUNCATEs every table after each test.
The full suite went from 8 failures and 9 errors to zero of both, and from 17
minutes to 10.

Gates: full backend suite **5902 passed, 4 skipped, zero failures, zero errors**.
The 4 skips are `test_live_chat_cross_process.py`, which needs two API processes
on a shared data tier (`LC_NODE_A`/`LC_NODE_B`); no DB-backed test skipped.
`ruff check` and `ruff format --check` clean. Frontend `tsc --noEmit` clean,
`npm run lint` clean with zero warnings, `npx vitest run` 134 files / 1769 tests
passed.

### Task 4 review

10 findings, and the two most severe were things I had reported as working.
All fixed in the Task 5 commit.

1. **HIGH, and my Task 4 commit message asserted the opposite.** The plan's
   Step 3 requires the pre-crawl quote to SHOW the free training, "rather than a
   price that then isn't charged". The backend returned `cost_per_page: 0`
   correctly and the client threw it away: `crawlBudgetOf` clamped it with
   `Math.max(1, ...)`, so a trial customer's free 100-page training was quoted
   as "1 credits a page", "100 credits", and a confirm dialog reading "100
   pages × 1 credits = 100 credits". The deterrent the feature exists to remove,
   re-created exactly, and inverted: quoted 100, charged 0. The clamp existed to
   keep a division finite, so that is now guarded at the division instead. The
   pre-existing test pinned the clamp, which is why nothing caught it. The UI
   states a free crawl as free rather than as "0 credits".
2. **HIGH.** The trial wall copy I added was unreachable. `/crawl/discover`
   truncates its listing AT the plan ceiling, so on the trial `total_found` can
   never exceed 100 and `selectedPages > perCrawlLimit` is never true; had it
   been, "Your site has {found} pages" would have printed 100, not the site's
   real size. My test constructed a payload the endpoint is structurally
   incapable of returning. The reachable signal is `capped`, which is the
   server saying "there was more than this", so the sentence is now "Your site
   has more than 100 pages. Your trial trains 100 of them. Upgrade to train the
   rest." It does not block, because the 100 they can train are worth training.
3. **MEDIUM-HIGH.** The three limit sentences the orchestrator computes were
   written into `result` only, and `CrawlContext` surfaces `error`. So the
   specific message naming WHICH limit was hit never reached anyone and the UI
   always fell back to a generic line, under a comment claiming the server sends
   the sentence. It is passed as `error` now, with a test that fails if that
   argument is dropped.
4. **MEDIUM.** Free training was grantable twice. `bot_id` is optional on every
   crawl route, so a crawl with it omitted and a crawl with it set were two
   different scopes under the plan's per-bot rule, and both came out free. The
   predicate is per ACCOUNT now. This is a deliberate deviation from the plan's
   "judged per bot": the trial grants exactly one bot, so the rules coincide
   except where the difference is abuse. The remaining vector, deleting every
   crawl-sourced document to become eligible again, is documented in the
   helper as accepted: closing it needs a durable "has consumed" marker rather
   than an inference over live rows, which is a billing-state change this task
   does not carry.
5. **MEDIUM.** A zero-priced crawl walked straight past the global credit kill
   switch, because the switch is enforced inside `check_and_deduct` and a zero
   cost skips that call. The path it could not see is the highest-volume one
   there is: up to 100 pages of embedding per new signup. The pipeline now
   consults the switch explicitly on the free path and aborts with the same
   reason code.
6. **MEDIUM.** The regression test the plan asked for tested only the pure
   `_terminal_status`, so deleting either line of the plumbing that feeds it
   left the suite green, and the MESSAGE, which is what the plan actually named,
   was asserted nowhere. Both are covered now, and verified by deletion.
7. **MEDIUM-LOW.** The day-0 onboarding screen still told a limited crawl to
   "add a site", i.e. redo the thing that had just worked. It reads the `limit`
   outcome now.
8. LOW. `state["abort_reason"]` was read with `[]` on a dict some existing test
   fakes build without the key. `.get()`.
9. LOW. The new pricing tests were order-dependent wherever a local Redis is
   running, because the entitlements cache keys on `client_id` alone and the
   truncate restarts identities. Cache disabled in that module.
10. LOW. The pipeline's documented return contract did not mention
    `abort_reason`; `test_crawl_discover_credits.py` passed only because a
    MagicMock incidentally resolved to "no features". Both pinned.

### Task 5, day 15 converts to Free

Status: **done**.

Six tests written first and verified failing (the legacy-rows one correctly
passed from the start, since the cron's `trialing` filter already excluded it).
`task_expire_trials` now converts in place: the row moves to the Free plan,
`status` goes to `active`, `data_retention_until` is cleared, a fresh
anniversary period opens so the renewal cron can grant month two, the unused
trial allowance is forfeited before Free's is granted, and every bot's knowledge
is paused. A client who bought mid-trial has their trial row retired as
`converted_to_paid` instead.

Two plan-versus-code discrepancies recorded rather than improvised:

* The plan says to zero the trial remainder "via a ledger adjustment with reason
  `trial_expired_forfeit`". `CreditLedger.reason` is a native Postgres ENUM, so
  a new value needs a migration; more importantly, the existing
  `reset_monthly_plan_credits` docstring documents exactly why a bespoke
  negative row is wrong: an orphan negative with no `grant_id` floats in the raw
  sum but never reduces the per-grant remaining, which is the documented cause
  of a past "614 / 500" balance bug. The forfeit therefore reuses
  `reset_monthly_plan_credits`, the mechanism the codebase already has for
  "zero the unused allowance at a period boundary", which conversion is.
* The plan's test seeds an account-level paid sibling beside the live trial row.
  `ix_subscriptions_client_legacy_active` admits ONE account-level row per
  client in the active set, so that shape cannot exist: the activation handler
  cancels the trial in the same transaction that inserts the purchase. The
  reachable sibling is per-bot, which the other index does allow, so that is
  what the test builds. The guard is still required; the outside voice's
  correction on this point is what the code actually shows.

Knowledge pause and restore are account-level now
(`deactivate_client_knowledge` / `reactivate_client_knowledge`), because the
per-bot helpers are hard no-ops for the NULL `bot_id` these rows carry, which is
the outside voice's F1. The trial-ended email's restore promise depends on it.

Copy: `send_trial_ended_email` no longer takes `data_retention_until`, no longer
warns about permanent deletion, and says what actually happens, that the account
is on Free with nothing deleted and the knowledge paused until a plan is picked.
The days-left email's "kept safe for 15 days" claim went with it.
`send_trial_data_deleted_email` is marked legacy. `EMAIL_INVENTORY.md` updated
for all of it, including removing the known-gap note now that the cadence is
fixed.

Cadence retuned to the 14-day trial: halfway at 7 days remaining (genuinely
halfway, where it used to fire at 4, which is day 10 of 14 under a heading
reading "you're halfway through", leaving the first ten days silent), then 3 and
1. Marker keys `day_7` / `day_11` / `day_13` are unchanged, so an in-flight
subscription is never sent the same slot twice; they name the slot, not the day.

`TestTaskExpireTrials` in `test_worker_cron_tasks.py` was removed rather than
patched. It drove a hand-rolled fake session, and the task now collaborates with
plans, the credit ledger and documents; satisfying all of that with a fake would
have been asserting on the fake. Its three real behaviours (the transition,
marker idempotency, an email failure not blocking the transition) are pinned in
the new real-Postgres file, with a pointer left where the class was.

Mutation-tested: removing the forfeit, the knowledge pause, the paid-sibling
guard, or reintroducing the retention stamp each fail a distinct test. The first
round of these all survived, which exposed two tests that were weaker than they
looked (the fixture never granted the trial's credits, so there was nothing to
forfeit), and those were strengthened before the fixes were accepted.

Gates: full backend suite **5911 passed, 4 skipped, zero failures**. `ruff
check` and `ruff format --check` clean. Frontend `tsc --noEmit` clean, `npm run
lint` clean with zero warnings, `npx vitest run` 134 files / 1770 tests passed.

### Task 5 review

12 findings. The first is the one that matters, and it is the failure mode this
whole plan was written to avoid.

1. **HIGH. The email's central promise had no implementation.**
   `reactivate_client_knowledge` was added in Task 5 and had ZERO production
   callers: the only reference in the tree was the test that called it directly.
   Every real reactivation site passes a subscription's `bot_id`, and a
   `/billing` checkout never stamps a bot into its notes, so an account-level
   row carries NULL and `reactivate_bot_knowledge` hard-returns 0. Meanwhile
   three separate emails were shipping "choosing a plan switches all of it back
   on, in one step, with nothing to re-upload" to every trial customer. A
   converted customer who paid would have got nothing un-paused. My own log
   asserted the wiring existed. It is wired now, in both activation branches,
   with a test that fails if the account-level path is removed. **This entry
   corrects the Task 5 log above: the restore was NOT wired when that was
   written.**
2. MEDIUM-HIGH. The "plumbing regression test" I added to satisfy the plan's
   Step 4 re-implemented the block inline and copied only its `no_content`
   branch, so the payload was always empty and the "does not say readable text"
   assertion compared against `""`. It passed with the production limit branch
   deleted. It now extracts and executes the real block from source; deleting
   that branch fails three tests.
3. MEDIUM. My `capped` upsell branch was inserted AHEAD of the credit-shortfall
   warning, so every trial customer whose site fills the 100-page cap stopped
   seeing "your credits cover N of these M pages" even when they could not
   afford the selection. Credits first now: a shortfall they can act on right
   now outranks a pitch to upgrade.
4. MEDIUM. The cron still committed the whole batch once, while now writing
   ledger rows, a grant and a bulk document update per row, and queueing the
   email BEFORE the commit. One bad row rolled back markers whose emails had
   already gone out, so the next tick re-emailed and re-converted everyone.
   Per-row commits now, matching `task_renew_due_subscriptions` (audit F14),
   and the conversion commits before the email is queued.
5. MEDIUM. The plan's `converted_to_free` JSONB marker had been silently
   dropped; idempotency rested on the status filter alone. Added, and a row
   carrying it is skipped, so a hand-restored `trialing` row cannot forfeit and
   re-grant. Mutation-tested.
6. MEDIUM-LOW. A missing `free` plan failed OPEN: rows were left `trialing`,
   which is in the active set, so every lapsed trial would keep full
   entitlements indefinitely while the cron re-logged hourly. It now refuses
   the whole batch loudly.
7. MEDIUM-LOW. "more than 100 pages" is false for a site of exactly 100, since
   `capped` is `total >= cap`. "at least 100 pages" now.
8. LOW. Four stale comments still described `trial_expired` plus retention as
   the live path, including the trial-lifecycle section header directly above
   the rewritten cron and the `/subscriptions/current` payload telling the
   frontend to render a deletion warning. All corrected, all marked legacy.
9. LOW. `deactivate_client_knowledge` iterated the client's bots, so documents
   with a NULL `bot_id` (which the crawl routes create whenever the optional
   parameter is omitted, and which this very branch's tests exercise) were
   never paused. "Your knowledge base is paused" has to be true of the whole
   base. Covered in both directions.
10. LOW. The `.get` hardening had been applied to one of six identical reads.
11. LOW. The free-price fix had landed on `/crawl/discover` only, so
    `/crawl/diff` still clamped and `RecrawlDialog` rendered "0 credits a page",
    the exact string the sibling fix removed. Both surfaces now.
12. LOW. A converted account gets no in-app "your trial ended" signal, because
    `_build_trial_payload` matches only `trialing`/`trial_expired`. Left for
    Task 6, which adds the `/auth/me` fields, and recorded here.

Gates after the fixes: full backend suite **5913 passed, 4 skipped, zero
failures**. `ruff check` and `ruff format --check` clean. Frontend `tsc` clean,
`npm run lint` clean with zero warnings, `npx vitest run` 134 files / 1771 tests.

### Task 6, mid-trial purchase

Status: **done**, except the sandbox step, which is out of scope for this
environment (see below).

Seven tests written first and verified failing, in their own throwaway database
because they drive the real webhook handler (mirroring
`test_merge_promo_resume_regressions.py`).

The five deltas, as the rewritten task specifies:

1. **`start_at` for a trialing buyer.** `resolve_trial_defer_at` takes the LATER
   of the trial's end and any consumed promo start, floored at 48 hours out for
   eMandate and UPI pre-debit notice. A day-13 buyer therefore gets billing at
   now+48h, up to a day of extra grace, rather than a date the gateway would
   refuse. Returns None for a lapsed or absent trial, which charges normally.
   Checkout stamps `oyechats_trial_conversion` so the handlers can tell this
   deferred start from a resume.
2. **Grant at authentication.** The distinction the note carries is real: a
   resume's customer has ALREADY paid through `start_at` and must be granted
   nothing, while a trial buyer has not, and paying early is precisely how they
   stop being limited. So the conversion takes the granting branch and, like a
   promo, does not inherit the swept trial row's period or grant marker
   (inheriting the marker would no-op the grant and leave them on the
   entitlements they just paid to leave). The grant is keyed on `start_at`,
   which is what makes the day-14 `subscription.charged` a no-op.
3. **The harvest, closed.** A conversion-marked mandate cancelled before its
   first debit has spent credits no payment covered. The cancellation handler
   forfeits the unspent remainder and converts the account to Free, which is
   where day 14 would have put it anyway. That also removes the limbo the first
   draft created: such a row matched neither the expiry sweep (which filters
   `trialing`) nor `/auth/me`'s trial payload.
4. **Client-level knowledge reactivation** was wired in the previous commit, as
   the Task 5 review finding.
5. **`/auth/me`** carries `paid_plan_starts_at` and `paid_plan_name`.

One design correction found while writing the test, recorded rather than worked
around: the plan's payload sketch adds these fields alongside the trial
countdown, but `ix_subscriptions_client_legacy_active` admits one account-level
row in the active set, so the activation sweep has already CANCELLED the trial
row by the time the mandate is authorised. There is no trialing row left to
decorate. `_build_trial_payload` therefore derives the whole "Standard starts in
N days" state from the PURCHASED row, and returns it before the trialing lookup.
Without that, the one customer who has just paid is the only one who sees no
trial UI at all.

No second retirement path was built. The plan's rewritten Task 6 is explicit
that the activation handler already sweeps and cancels the sibling account row
including a trialing one, and the test asserts that existing behaviour rather
than adding to it.

The verify fast path needed no new code: `reconcile_subscription_from_razorpay`
already delegates to `_handle_subscription_activated` under a synthetic
idempotency key, so verify and the webhook are one function and a double
delivery grants once. Both facts are now pinned by a test.

Mutation-tested: not recognising the conversion note, failing to set the
grant-once marker, and removing the cancel forfeit each fail distinct tests.

**Step 5, the Razorpay sandbox proof, is NOT done.** It needs live TEST keys and
a human driving the checkout modal. Flagged for follow-up: one deferred checkout
early in the trial and one at day 13 (the 48-hour floor case), confirming the
mandate reaches `authenticated` with a future `start_at` and no charge, and that
cancel-and-recreate still handles a sub in `authenticated`.

Gates: full backend suite **5920 passed, 4 skipped, zero failures**. `ruff
check` and `ruff format --check` clean.

### Task 6 review

10 findings. The first two are the serious ones and both are corrections to
claims I made in the Task 6 entry above.

1. **CRITICAL: the feature was unreachable from the path customers actually
   take.** `/checkout` accepts a trialing customer at the API level, but the
   console never sends them there: `billingModel.hasActive` counts `trialing`
   as active, so `usePlanCheckout` routes plan picks to `/change-plan`. There
   the trial row has no gateway mandate, branches 2a and 2b both require one,
   and it falls into Branch 3, which minted the subscription with no `start_at`
   and no notes. So the customer was charged immediately, lost their remaining
   free days, and got neither the grant at authentication nor the forfeit that
   balances it. Every one of the five deltas was bypassed. Branch 3 now carries
   the deferral. **This corrects the Task 6 entry above, which described the
   billing clock as protected.**
2. **HIGH: the day-14 charge re-granted.** The marker was keyed on `start_at`,
   but a deferred mandate's first charge carries `current_end = start_at + one
   interval`, a whole interval past the marker and far outside the four-day
   period-key tolerance, so the debit reset the allowance the customer had just
   bought and granted a second one. Confirmed directly with a probe against the
   real handler: one grant became two. The marker is now `start_at + interval`.
   My test could not have caught it, twice over: it derived `current_end` from
   the marker under test, so the comparison was circular, and it asserted on the
   BALANCE, which is identical either way because plan credits are
   use-it-or-lose-it (a re-grant resets and re-grants the same number). It
   asserts the marker directly now, and fails under the original bug.
3. **HIGH: "Standard starts in N days" would have been true forever.** The gate
   was the grant marker plus `last_granted_period_end > now`, and neither ever
   stops being true: the marker is never cleared and the period end rolls
   forward on every renewal. A customer who bought in September would still be
   told in March that their plan starts in 29 days, with Upgrade suppressed.
   Gated on `current_period_start is None` now, which Razorpay writes at the
   first real debit and nowhere else.
4. MEDIUM. The payload branch also repurposes `trial_end_at`, `days_remaining`
   and `credits_granted` to describe the purchased plan rather than the trial.
   Deliberate, and now stated in the docstring rather than left implicit.
5. MEDIUM. The harvest guard tested "no paid invoice", which is wrong in both
   directions: a refund flips an invoice to `refunded`, so a customer billed for
   months who takes a partial refund and cancels would have been stripped of
   credits and downgraded; and `/checkout/verify` writes a paid Invoice from the
   authorisation transaction, which would have disabled the guard entirely. It
   reads `current_period_start is None` now.
6. MEDIUM. The plan's ledger reason `trial_conversion_cancel_forfeit` was
   dropped for the same reason as Task 5's (native PG enum, and a bespoke
   negative row breaks `get_balance_breakdown`'s attribution), but I had not
   recorded that deviation. Recorded here. The consequence is real and worth
   knowing: in the audit trail a punitive forfeit looks like a routine monthly
   reset.
7. MEDIUM. `_forfeit_and_convert_to_free` diverges from Task 5's conversion
   (new row rather than in place, no marker, no email) and did not invalidate
   the entitlements cache, so a just-downgraded account kept the paid tier's
   limits for the 60s TTL. The cache invalidation is added. The structural
   divergence is left as-is and recorded: the cancelled row is terminal and
   cannot be converted in place, so a replacement row is the right shape here.
8. MEDIUM. No test covered the route wiring, which is why finding 1 survived.
   The plan's `test_verify_endpoint_flips_entitlements_before_any_webhook` is
   still approximated by source inspection rather than by driving the endpoint;
   recorded as a known weakness rather than claimed as covered.
9. LOW. The conversion row carries NULL period anchors during the deferral, so
   Billing shows no renewal date between purchase and day 14. Recorded.
10. LOW. The conversion note was defined independently in two modules. One
    definition now, imported by the producer.

### Task 7, the two trial surfaces in the app shell

Status: **done**.

`TrialCard` in the rail footer directly above Billing, `TrialBanner` in
`ShellBanners` above the routed content. Both read one `/auth/me` query through
`useTrialState`, so they cannot disagree about how many days are left. The
payload was already being served and simply never consumed.

The card has no close button, deliberately: the banner is the interruption and
can be dismissed, the card is the standing fact about an account on a clock.
Three states, as the plan specifies: counting days; counting credits when
credits are the binding constraint (`creditsRemaining / granted < daysRemaining
/ 14`, which is what makes the two comparable); and, once the customer has
bought, a green confirmation with no CTA, because showing an Upgrade button to
someone who has paid is an insult rather than a call to action.

The banner's dismissal is per account (`trial_banner_dismissed:{clientId}`,
every read and write wrapped) and returns regardless of dismissal at three days
or fewer: "stop telling me" is reasonable on day four and unreasonable on day
thirteen, when the consequence is the chatbot going quiet.

One design-system correction: the first version painted `bg-success-tint
text-success` on the card. The rail is ink and paper status tokens do not
survive it; the repo's own guardrail test caught it, and the token file ships
rail-ground twins. `text-rail-success` / `text-rail-accent` now.

Mutation-tested: removing the credits state, showing Upgrade in the bought
state, removing the three-day override, and making the dismissal global each
fail a distinct test.

Gates: full backend suite **5921 passed, 4 skipped, zero failures**. `ruff
check` and `ruff format --check` clean. Frontend `tsc --noEmit` clean, `npm run
lint` clean with zero warnings, `npx vitest run` 136 files / 1784 tests passed.
