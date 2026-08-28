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
