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
