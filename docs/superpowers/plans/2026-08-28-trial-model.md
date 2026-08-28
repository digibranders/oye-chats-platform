# Plan-less 14-Day Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new signup gets a 14-day trial with all Professional features (1 bot, 1 seat, first training free up to 100 pages, 500 conversation credits, no top-ups), which converts to the Free plan at expiry with nothing deleted; paying mid-trial upgrades entitlements instantly while the first debit waits for day 14.

**Architecture:** The trial is a non-purchasable, non-public `trial` Plan row that becomes the signup default — `assign_default_plan_to_client` already has a trial branch keyed on `trial_days > 0`, so the signup path needs no new code, only data. Expiry stops being `trial_expired` + retention + deletion and becomes an in-place conversion to the Free plan reusing the existing knowledge-pause machinery. Mid-trial purchase rides the launch-promo precedent: `create_subscription(start_at=trial_end)` plus the already-handled `subscription.authenticated` webhook.

**Tech Stack:** FastAPI + SQLAlchemy/Alembic (api), React 19 + Vite (app), Next.js (oyechats-website), Razorpay subscriptions.

**Spec:** the published artifact "Trial and First Install" (settled decisions: day-15 → Free with nothing deleted; billing clock never moves / entitlements upgrade instantly; 100 pages free + 500 credits; no top-ups during trial).

**Deliberately OUT of scope** (each is its own later plan):
- Raising Free's 2,500-char knowledge ceiling (open product decision).
- Onboarding steps 3–5 from the artifact (citations, install-verified screen, qualification step).
- The super-admin console (oyechats-admin) — the trial row will appear in its plan list; harmless.

**Ground truth found during review (do not re-derive):**
- `plans.is_default` default is Free (`scripts/seed_plans.py:86`); Standard carries `trial_days: 7` (`seed_plans.py:166`).
- `get_default_plan` requires `is_active=True` (`app/services/plan_service.py:140-151`), but `get_active_plans` (`plan_service.py:41-44`) feeds `/plans` AND `GET /public/pricing-catalog` → a naïve trial row would render on oyechats.com/pricing. Hence the new `is_public` column.
- The trial signup branch already exists: `assign_default_plan_to_client` (`plan_service.py:485-545`) starts `trialing` with `trial_start/trial_end` and grants `credits_per_month` inline.
- Crawl charging: `document_routes.py:1071/1177/1459` read `get_credit_cost(db, "url_scan")` and pass `cost_per_page` down; re-crawls already pass 0 (`recrawl_service.py:20-25`). Page cap enforcement reads `limits.max_crawl_pages` (`document_routes.py:1422-1446`, `plan_entitlements_service.py:866`).
- Trial expiry: `task_expire_trials` (`worker/tasks.py:1282-1305`) flips to `trial_expired`, stamps `data_retention_until = trial_end + TRIAL_DATA_RETENTION_DAYS` (config.py:514, default 15), emails `send_trial_ended_email` whose copy promises **permanent deletion** (`email_service.py:1478-1507`). `task_delete_expired_trial_data` then hard-deletes (this is what destroyed client 3 on 15 Aug).
- Reminder cadence `task_trial_reminder_emails` maps days-remaining `{4: day_7, 2: day_11, 1: day_13}` (`worker/tasks.py:1349-1353`) — tuned for a 7-day trial.
- The old Standard-only trial surface, in full (all retired by Task 2b): `POST /subscriptions/start-trial` (`subscription_routes.py:323`), `plan_service.start_trial` + `TrialUnavailable` (`plan_service.py:575+`, reasons incl. `already_trialed` one-per-plan-lifetime), frontend `usePlanCheckout.ts` "trial-eligible paid plan → start-trial (no card)" branch, `PlanPickerDialog` trial CTA + its tests, `api.ts:3525 startTrial`. Production has ZERO `trialing` subscriptions as of 2026-08-28, so nothing is in flight on the old offer.
- Top-ups are enforced server-side via `has_feature("topup_allowed")` (`subscription_routes.py:3886-3900`); the trial row simply carries `false`.
- Future-start precedent: promo checkout passes `start_at` (`subscription_routes.py:2112`), `create_subscription` sends it only when in the future (`razorpay_service.py:685-689`), and `subscription.authenticated` **is already handled** and "materialises the row WITHOUT granting credits" (`razorpay_service.py:2533-2540`). `_is_live_sub` treats `authenticated` as live (`razorpay_service.py:1911`).
- Trial→paid checkout today falls through as a normal conversion (`subscription_routes.py:2199-2209`, `same_plan` excludes `trialing`) — it does NOT pass `start_at`, so today a trialing buyer is charged immediately.
- `/auth/me` already returns `trial_end_at` + `days_remaining` (`auth_routes.py:331-332, 570-580`).
- Knowledge pause/unpause helpers exist: `knowledge_state_service.deactivate_bot_knowledge` / `reactivate_bot_knowledge`.
- Website copy to change: `oyechats-website/src/lib/pricing.ts:146` ("Start 7-day trial"), `:283` (FAQ), and **legal**: `legal.ts:109` + `:232` both promise "deleted 15 days after the trial ends". CI gate `scripts/verify-html.mjs` (W-1 no em-dashes) applies to all copy.
- Registration welcome email is already parameterised on the plan row (`auth_routes.py:955`, `send_trial_welcome_email(credits=…, duration_days=…)`).
- Email catalogue accuracy is test-enforced: update `emails/EMAIL_INVENTORY.md` alongside any sender copy change.

---

## File structure

**Create**
- `api/alembic/versions/<rev>_plans_is_public.py` — `plans.is_public` boolean, server_default true
- `api/tests/test_trial_signup_defaults.py` — signup lands on the trial
- `api/tests/test_trial_first_training_free.py` — crawl charging during trial
- `api/tests/test_trial_expiry_converts_to_free.py` — day-15 conversion
- `api/tests/test_trial_midway_purchase.py` — start_at + instant entitlements + no double grant
- `app/src/shell/TrialCard.tsx` + `TrialCard.test.tsx` — rail card (3 states)
- `app/src/shell/TrialBanner.tsx` + `TrialBanner.test.tsx` — dismissible banner

**Modify**
- `api/scripts/seed_plans.py` — trial row; `free.is_default=False`; stale comments
- `api/app/db/models.py` — `Plan.is_public`
- `api/app/services/plan_service.py` — public filter; checkout guard input
- `api/app/api/subscription_routes.py` — reject non-public plan checkout; trialing branch passes `start_at`; verify path retires trial
- `api/app/services/razorpay_service.py` — authenticated-handler: trial-conversion grant with marker
- `api/app/api/document_routes.py` — first-training-free cost helper (3 call sites)
- `api/app/services/crawl_orchestrator.py` (or pipeline result mapping) — honest limit-hit message
- `api/app/worker/tasks.py` — expiry conversion; 14-day reminder cadence
- `api/app/services/email_service.py` — trial_ended rewrite; welcome/reminder copy
- `api/emails/EMAIL_INVENTORY.md`
- `api/app/api/auth_routes.py` — `/auth/me`: add `paid_plan_starts_at` for the "Standard starts in N days" card state
- `app/src/shell/nav.ts` / shell layout — mount TrialCard above the Billing footer item; mount TrialBanner in `ProtectedLayout`
- `app/src/features/workspace/billing/usePlanCheckout.ts`, `PlanPickerDialog.tsx` (+test), `app/src/services/api.ts` — retire the start-trial branch (Task 2b)
- `oyechats-website/src/lib/pricing.ts`, `src/lib/legal.ts` — 14-day copy; retention clauses

Run backend tests from `api/` with `.venv/bin/python -m pytest <file> -q --no-cov` (DB_URL must point at local Postgres; the suite builds its own `_pytest` database). Frontend: `cd app && npx vitest run <file>`. Commit after every task; branch must be `development` (`git branch --show-current` before each commit).

---

### Task 1: `plans.is_public` — a default plan that never renders on the pricing page

The trial row must satisfy `get_default_plan` (`is_active=True`) without leaking into `get_active_plans`, which feeds `/plans` and `GET /public/pricing-catalog` (see `plan_service.py:64-70` — `is_active` deliberately conflates neither of these, so a third flag is required, not a filter hack).

**Files:** Create `api/alembic/versions/<rev>_plans_is_public.py` · Modify `api/app/db/models.py`, `api/app/services/plan_service.py`, `api/app/api/subscription_routes.py` · Test `api/tests/test_trial_signup_defaults.py`

- [ ] **Step 1: Failing tests** (new file `api/tests/test_trial_signup_defaults.py`)

```python
"""The trial plan is default for signups and invisible to buyers."""
import pytest
from app.db.models import Plan
from app.services.plan_service import get_active_plans, get_default_plan

def _mk(db, slug, *, default=False, public=True, trial_days=0, active=True):
    p = Plan(slug=slug, name=slug.title(), credits_per_month=500,
             monthly_price_cents=0, annual_price_cents=0,
             trial_days=trial_days, is_default=default, is_active=active,
             is_public=public, sort_order=99,
             limits={"bots": 1}, features={"topup_allowed": False})
    db.add(p); db.flush(); db.commit(); return p

def test_non_public_default_wins_signup_but_never_lists(db):
    _mk(db, "free")
    trial = _mk(db, "trial", default=True, public=False, trial_days=14)
    assert get_default_plan(db).id == trial.id
    assert trial.id not in {p.id for p in get_active_plans(db)}

def test_public_listing_unchanged_for_ordinary_plans(db):
    free = _mk(db, "free")
    assert free.id in {p.id for p in get_active_plans(db)}
```

- [ ] **Step 2: Run to verify failure** — `TypeError: 'is_public' is an invalid keyword argument for Plan`.

- [ ] **Step 3: Model + migration.** In `models.py`, next to `is_default`:

```python
    # Rendered on /plans and the public pricing catalogue. False for internal
    # rows that must exist and be assignable (the signup trial) but must never
    # be shown or bought. Orthogonal to is_active on purpose — see
    # plan_service.plan_checkout_is_wired's warning about conflating flags.
    is_public = Column(Boolean, default=True, nullable=False, server_default="true")
```

Migration (chain off the current single head — run `.venv/bin/python -m alembic heads` first and put THAT id in `down_revision`; do not assume):

```python
def upgrade() -> None:
    op.add_column("plans", sa.Column("is_public", sa.Boolean(), nullable=False, server_default="true"))

def downgrade() -> None:
    op.drop_column("plans", "is_public")
```

- [ ] **Step 4: Filter + guard.** `plan_service.get_active_plans` adds `Plan.is_public.is_(True)` to its `where`. In `subscription_routes.py`, at the top of both `/checkout/quote` and `/checkout` plan resolution (where an inactive plan is already rejected), add:

```python
        if not plan.is_public:
            raise HTTPException(status_code=400, detail="This plan cannot be purchased.")
```

- [ ] **Step 5: Tests pass** — the two new tests, then the neighbouring suites: `pytest tests/test_trial_signup_defaults.py tests/ -q --no-cov -k "plan_service or pricing_catalog or checkout_quote"`.

- [ ] **Step 6: Commit** — `feat(billing): plans.is_public — assignable-but-unlisted plan rows`

### Task 2: Seed the trial row; Free stops being the default

**Files:** Modify `api/scripts/seed_plans.py` · Test extends `api/tests/test_trial_signup_defaults.py`

- [ ] **Step 1: Failing test** (append):

```python
def test_seed_matrix_defaults_the_trial_and_not_free():
    from scripts.seed_plans import _PLANS
    by_slug = {p["slug"]: p for p in _PLANS}
    trial, free = by_slug["trial"], by_slug["free"]
    assert trial["is_default"] and not free["is_default"]
    assert trial["is_public"] is False and trial["trial_days"] == 14
    assert trial["credits_per_month"] == 500
    assert trial["limits"]["max_crawl_pages"] == 100
    assert trial["limits"]["knowledge_characters"] == 500_000
    assert trial["limits"]["bots"] == 1 and trial["limits"]["operators"] == 1
    assert trial["features"]["topup_allowed"] is False
    assert trial["features"]["first_training_free"] is True
    # every Professional feature except volume/topup is open
    pro = by_slug["professional"]["features"]
    for key, val in pro.items():
        if key != "topup_allowed":
            assert trial["features"][key] == val, key
```

- [ ] **Step 2: Verify failure** — `KeyError: 'trial'`.

- [ ] **Step 3: Implement.** Add to `_PLANS` (sorted first, `sort_order: 0`), copy Professional's `features` verbatim then override `topup_allowed: False` and add `first_training_free: True` (eng review: plan behaviour stays in plan data, like every other feature flag); set `included_operator_seats: 1`, all prices 0, `"is_public": False`, and:

```python
        "slug": "trial",
        "name": "Free Trial",
        "description": "Fourteen days of everything, on one chatbot.",
        "credits_per_month": 500,
        "trial_days": 14,
        "is_default": True,
        "limits": {
            "credits": 500, "bots": 1, "operators": 1, "leads": -1,
            "page_scraping": 100, "documents": -1,
            "knowledge_characters": 500_000,  # = Standard. 100 pages at ~4k chars is ~400k, so the page cap binds first and this stays a backstop, not a wall
            "chat_history_days": 90,
            "max_crawl_depth": 4, "max_crawl_pages": 100,
            "max_crawl_js_pages": 50, "max_crawl_concurrency": 4,
        },
```

Flip Free's `"is_default": True` → `False` and Standard's `"trial_days": 7` → `0` (the signup trial replaces the Standard-only offer; the dead code it leaves behind is removed in Task 2b). Add `"is_public": True` to the four public rows and `is_public` to `_UPSERT_FIELDS` (the tuple at `seed_plans.py:300`). Fix the two stale comments reading `# trials are the Standard-only 7-day offer`. Extend the Task 2 seed test with `assert by_slug["standard"]["trial_days"] == 0` and `assert all(p["trial_days"] == 0 for p in _PLANS if p["slug"] != "trial")`.

- [ ] **Step 4: Dry-run the seed against the dev DB** — `.venv/bin/python scripts/seed_plans.py` (no `--apply`); confirm the printed diff shows exactly: new `trial` row, `free.is_default true→false`, `is_public` backfills. **Do not `--apply` to any shared DB in this task** — rollout is Task 10.

- [ ] **Step 5: Tests pass, then commit** — `feat(billing): seed the 14-day plan-less trial as the signup default`

### Task 2b: Retire the Standard-only trial offer

With every purchasable plan at `trial_days = 0`, the start-trial surface is dead code with a live route. Remove it rather than leave a second trial concept for the next reader to reconcile — a Free-plan customer post-conversion must never see a "start a card-free Standard trial" button.

**Keep untouched:** `assign_default_plan_to_client`'s `trial_days > 0` branch (it IS the new trial's mechanism) and every `status == "trialing"` handling in checkout/expiry (the new trial produces trialing subs).

**Files:** Modify `api/app/api/subscription_routes.py`, `api/app/services/plan_service.py`, `app/src/features/workspace/billing/usePlanCheckout.ts`, `app/src/features/workspace/billing/PlanPickerDialog.tsx` (+ test), `app/src/services/api.ts` · Delete the start-trial tests that pin the old behaviour

- [ ] **Step 1: Failing test** (append to `api/tests/test_trial_signup_defaults.py`):

```python
def test_start_trial_route_is_gone(test_app_client):
    # 404, not 400/403: the surface is removed, not gated.
    assert test_app_client.post("/subscriptions/start-trial", json={"plan_slug": "standard"}).status_code == 404
```

(Use the app-factory fixture the other route-absence tests use; if none exists, assert the route is absent from `app.routes` instead.)

- [ ] **Step 2: Verify failure** — route currently answers.
- [ ] **Step 3: Backend removal.** Delete `start_trial_endpoint` + `StartTrialRequest` (`subscription_routes.py:323`), then `plan_service.start_trial` and `TrialUnavailable` IF nothing else imports them (`grep -rn "TrialUnavailable\|start_trial" api/app api/tests` first — delete their dedicated tests in the same commit; any OTHER test that fails is a real dependency: stop and re-scope). Do not touch `assign_default_plan_to_client`.
- [ ] **Step 4: Frontend removal.** In `usePlanCheckout.ts` delete the trial-eligible branch (line ~247 `startTrial(plan.slug)`) and the `already_trialed` handling (~127); the docstring's decision table loses its trial row. In `PlanPickerDialog.tsx` remove the card-free-trial CTA and its two tests (`:331`, `:356`); remove `startTrial` from `api.ts:3525` and from both test mock blocks. Grep `startTrial` repo-wide afterwards: zero hits.
- [ ] **Step 5: Gates.** `pytest tests/test_trial_signup_defaults.py tests/ -q --no-cov -k "start_trial or plan_service or checkout"` and `cd app && npx tsc --noEmit && npx vitest run src/features/workspace/billing/ && npm run lint`.
- [ ] **Step 6: Commit** — `refactor(billing): retire the Standard-only trial offer — the signup trial is the only trial`

### Task 3: Signup lands on the trial (verify, don't build — the branch exists)

`assign_default_plan_to_client`'s `trial_days > 0` branch (`plan_service.py:522-534`) already creates `trialing` + grants credits inline, and `auth_routes.py:955` already emails `send_trial_welcome_email(credits=…, duration_days=…)` from the row. This task pins that behaviour with the new row and fixes copy that assumed a *plan* trial.

**Files:** Test `api/tests/test_trial_signup_defaults.py` · Modify `api/app/services/email_service.py` (welcome copy only if it names a plan)

- [ ] **Step 1: Failing test** (append; use the real service against the `db` fixture):

```python
def test_signup_opens_a_trialing_sub_with_500_credits(db):
    from app.db.models import Client
    from app.services import credit_service, plan_service
    _mk(db, "free")
    _mk(db, "trial", default=True, public=False, trial_days=14)
    c = Client(name="T", email="trial-t@example.com", api_key="k-trial-1", hashed_password="h")
    db.add(c); db.flush(); db.commit()
    sub = plan_service.assign_default_plan_to_client(db, c.id)
    db.commit()
    assert sub.status == "trialing"
    assert (sub.trial_end - sub.trial_start).days == 14
    assert sub.current_period_end == sub.trial_end
    assert credit_service.get_balance(db, c.id) == 500
```

(If `get_balance` is named differently, use the ledger-sum helper the existing credit tests use — copy their import, do not invent one.)

- [ ] **Step 2: Run.** Expect PASS already — that is the point; if it fails, the failure is a real finding, fix before proceeding.
- [ ] **Step 3: Read `send_trial_welcome_email` (`email_service.py:1333`) and the halfway/days-left copy.** Wherever the body says "your trial of {plan}" or implies a plan was chosen, reword to the trial's own name ("your free trial"), keeping params. Update `emails/EMAIL_INVENTORY.md` rows for any subject/body change (the accuracy test enforces the count and catalogue).
- [ ] **Step 4: `pytest tests/test_trial_signup_defaults.py tests/test_email_inventory_accuracy.py -q --no-cov` → green. Commit** — `feat(billing): new signups open on the 14-day trial`

### Task 4: First training free (100 pages), and the wall tells the truth

Charging sites: `document_routes.py:1071` (discover/quote), `:1177`, `:1459` (start crawl) all read `get_credit_cost(db, "url_scan")`. The trial's `max_crawl_pages: 100` (Task 2) already caps page count via `:1422-1446`. What's missing: cost 0 for the trial's FIRST training, and an upsell-shaped limit message.

**Files:** Modify `api/app/api/document_routes.py` · Create `api/tests/test_trial_first_training_free.py`

- [ ] **Step 1: Failing tests** — drive the three sites through one helper:

```python
"""During the trial, the first website training is free; later ones charge."""
def test_first_training_costs_zero_on_trial(db): ...
def test_second_training_charges_url_scan_on_trial(db): ...
def test_first_training_still_charges_on_paid_plans(db): ...
```

Assert on the helper `resolve_crawl_cost_per_page(session, client_id, bot)` (to be created), not on route wiring: a plan with `first_training_free` + bot with zero `source='crawl'` documents → 0; same plan + bot that has crawl documents → 5; a plan without the flag → 5 either way. The flag, not the slug, is the switch — same convention as `topup_allowed`.

- [ ] **Step 2: Verify failure** — `ImportError`.
- [ ] **Step 3: Implement** in `document_routes.py` (near the other crawl helpers):

```python
def resolve_crawl_cost_per_page(session, client_id: int, bot) -> int:
    """Per-page crawl price for THIS crawl.

    The trial's first training is free: site size is a fact about the
    customer's website, not about the value they will get, and metering it
    made a 100-page site spend its whole budget before evaluating anything.
    "First" is judged per bot by whether any crawl-sourced Document exists,
    the same predicate `recrawl_service._load_crawl_urls_for_bot` uses to
    decide what a re-crawl covers. Re-crawls are free on every tier already.
    """
    from app.services import plan_entitlements_service
    ents = plan_entitlements_service.get_entitlements(client_id, session)
    if ents.has_feature("first_training_free"):
        has_crawled = session.execute(
            select(Document.id).where(
                Document.bot_id == bot.id, Document.source == "crawl"
            ).limit(1)
        ).first()
        if has_crawled is None:
            return 0
    return credit_service.get_credit_cost(session, "url_scan")
```

Replace the three `get_credit_cost(db, "url_scan")` call sites with `resolve_crawl_cost_per_page(db, client.id, bot)`. The quote site (`:1071`) must use it too, so the pre-crawl estimate shows "0 credits · first training free" rather than a price that then isn't charged.

- [ ] **Step 4: The honest wall.** Find where `limit_type: "max_crawl_pages"` is emitted (`document_routes.py:1446`) and confirm the response carries the plan's cap and the found count. In the app, locate the component rendering that limit (grep `max_crawl_pages` in `app/src/`) and set the trial copy to: `Your site has {found} pages. Your trial trains 100 — upgrade to train them all.` (Nearby: the crawl-failure path that mislabels a quota abort as "couldn't extract readable text" — the orchestrator returns `no_content` for a quota abort. Fix the mapping while here: `KnowledgeQuotaExceeded`/credit aborts must produce a `limit` outcome, not `no_content`; grep `no_content` in `crawl_orchestrator.py` and thread the abort reason through. Write one regression test asserting a quota abort does not yield the no-content message.)
- [ ] **Step 5: Tests + neighbours** — `pytest tests/test_trial_first_training_free.py tests/ -q --no-cov -k "crawl or document_routes" ` → green. Frontend: `npx vitest run` for the touched component.
- [ ] **Step 6: Commit** — `feat(trial): first training free up to 100 pages, and a limit wall that upsells instead of lying`

### Task 5: Day 15 converts to Free — nothing deleted, ever again

**Files:** Modify `api/app/worker/tasks.py` (`task_expire_trials`), `api/app/services/email_service.py` (`send_trial_ended_email`), `api/emails/EMAIL_INVENTORY.md` · Create `api/tests/test_trial_expiry_converts_to_free.py`

- [ ] **Step 1: Failing tests:**

```python
def test_expiry_converts_sub_to_free_in_place(db): ...
    # trialing sub past trial_end + free plan exists →
    # sub.plan_id == free.id, sub.status == "active",
    # sub.data_retention_until is None, anniversary period set,
    # free monthly credits granted (200), trial credit balance zeroed or left per design below
def test_expiry_pauses_knowledge_and_is_reversible(db): ...
    # bot with indexed docs → deactivate_bot_knowledge called (docs inactive)
def test_expiry_never_touches_a_client_with_a_live_or_deferred_paid_sub(db): ...
    # a sibling sub in active/authenticated/created → trial row is retired
    # (canceled, cancel_reason="converted_to_paid") and NOT converted to free
def test_converted_free_sub_renews_on_month_two(db): ...
    # advance past the anniversary current_period_end →
    # task_renew_due_subscriptions grants Free's 200 (it is "the only trigger
    # for free-tier subs", worker/tasks.py:559 — conversion must feed it)
def test_legacy_trial_expired_rows_still_age_out_unchanged(db): ...
    # pre-existing trial_expired + data_retention_until rows remain for
    # task_delete_expired_trial_data (legacy only; new rows never enter it)
```

- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Rewrite the flip block** (`worker/tasks.py:1282-1305`). Shape:

```python
                free_plan = get_plan_by_slug(session, "free")
                paid = session.execute(
                    select(Subscription.id).where(
                        Subscription.client_id == sub.client_id,
                        Subscription.id != sub.id,
                        Subscription.status.in_(("active", "trialing", "past_due", "created", "authenticated", "pending")),
                    ).limit(1)
                ).first()
                if paid is not None:
                    sub.status = "canceled"
                    sub.cancel_reason = "converted_to_paid"
                else:
                    sub.plan_id = free_plan.id
                    sub.status = "active"
                    _mark_email_sent(sub, "converted_to_free", now)  # JSONB marker, NOT a new column — the idempotency key this cron already uses
                    sub.data_retention_until = None
                    sub.current_period_start = now
                    sub.current_period_end = add_months(now, 1)
                    grant_monthly_credits(session, sub, months=1)   # the exact helper credit_service already exposes for free-plan grants — reuse, don't invent
                    for bot in bots_of(session, sub.client_id):
                        deactivate_bot_knowledge_over_limit(session, bot)
```

Verified safe (eng review): the deferred-purchase row sits in `created`/`authenticated`, which are OUTSIDE `ix_subscriptions_client_bot_active`'s predicate (`status IN ('active','trialing','past_due')`, models.py:1951), so it coexists with the live trial row until retirement — the retirement-before-activation ordering below is still required at day 14, but there is no collision window at purchase time.

Two constraints discovered in review that this must respect: **(a)** don't add a column casually — if a conversion marker is needed for idempotency, prefer `trial_emails_sent["converted_to_free"]` (the JSONB marker pattern this cron already uses); **(b)** the knowledge pause must reuse `knowledge_state_service.deactivate_bot_knowledge` semantics exactly as the paid→free downgrade path does — read that caller first (grep `deactivate_bot_knowledge` call sites) and mirror it, including whatever decides "over limit". Trial credit remainder: zero it via a ledger adjustment with reason `trial_expired_forfeit` so the Free balance is exactly the Free grant (a leftover trial balance on Free is the top-up-leak shape again).

- [ ] **Step 4: Email rewrite.** `send_trial_ended_email` loses `data_retention_until` entirely. New copy (subject `Your OyeChats trial has ended — your account is now on Free`): everything is kept; knowledge above the Free plan's limit is paused, one upgrade switches it back on; button "Choose a plan" → `/billing`. Delete the warning alert promising permanent deletion. `send_trial_data_deleted_email` stays (legacy rows), with a docstring line: "Legacy: new trials never enter the retention path as of 2026-08-28." Update `EMAIL_INVENTORY.md`.
- [ ] **Step 5: Cadence for 14 days** (`worker/tasks.py:1349-1353`): mapping becomes `{7: ("halfway", "halfway"), 3: ("day_11", "days_left"), 1: ("day_13", "days_left")}` — keep the historical marker KEYS (`day_7` → keep as key `day_7` if renaming breaks dedup for in-flight rows; safest: keep keys, change trigger thresholds and copy). Decide by reading `_mark_email_sent` usage; the test must assert no double-send for a sub that already carries old markers.
- [ ] **Step 6: All four tests green; then the full worker/email neighbourhood:** `pytest tests/test_trial_expiry_converts_to_free.py tests/test_worker_cron_tasks.py tests/test_email_inventory_accuracy.py -q --no-cov`.
- [ ] **Step 7: Commit** — `feat(billing): trial expiry converts to Free in place — retention/deletion path retired for new trials`

### Task 6: Mid-trial purchase — mandate now, debit day 14, entitlements instantly

The precedent is the promo path end to end. Differences: the deferred sub must (a) retire the trial row at authentication, (b) grant the purchased plan's first-period credits AT authentication with a marker so activation/charged does not double-grant (the per-bot activation credit-marker machinery from the 2026-07-22 audit is the pattern — find `activation credit marker` in `razorpay_service.py`/`credit_service.py` and reuse its key scheme).

**Files:** Modify `api/app/api/subscription_routes.py`, `api/app/services/razorpay_service.py` · Create `api/tests/test_trial_midway_purchase.py`

- [ ] **Step 1: Failing tests:**

```python
def test_trialing_checkout_passes_start_at_trial_end(db, monkeypatch): ...
    # capture create_subscription kwargs; start_at == int(sub.trial_end.timestamp())
def test_authenticated_webhook_retires_trial_and_grants_plan_credits_once(db): ...
    # after subscription.authenticated: trial sub canceled (reason converted_to_paid),
    # new sub live in the active set, balance == plan.credits_per_month + marker set
def test_activation_at_day14_does_not_regrant(db): ...
    # replay subscription.activated for the same sub → balance unchanged
def test_entitlements_resolve_to_purchased_plan_immediately(db): ...
    # get_entitlements(client) between auth and first charge → purchased plan_slug
def test_verify_endpoint_flips_entitlements_before_any_webhook(db): ...
    # POST /checkout/verify with a valid signature → same retire+grant as the
    # webhook, so the customer sees the upgrade the second the popup closes
def test_verify_then_webhook_is_idempotent(db): ...
    # both paths run → one retirement, one grant, one marker
def test_upgrade_after_conversion_reactivates_paused_knowledge(db): ...
    # converted-to-Free account with paused docs buys a plan →
    # reactivate_bot_knowledge restores them (the trial-ended email PROMISES
    # this; razorpay_service.py:3640/3862/3910 already wire it — prove it)
def test_cancel_before_day14_charges_nothing_and_leaves_trial_running(db): ...
    # gateway cancel of the deferred sub → trial sub restored/still governs?  NO:
    # decision — trial was retired at auth; cancel re-opens nothing. Assert the
    # account falls to Free at original trial_end via Task 5's sibling check.
```

(The last test encodes a real decision: once you buy, the trial row is retired; cancelling the unbilled purchase before day 14 means Task 5's expiry sweep no longer sees a live sibling — so the conversion-to-Free happens on the original `trial_end`. The days themselves are preserved because the retired trial row keeps its `trial_end` and the app keeps rendering the countdown from `/auth/me` — Step 4.)

- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Checkout branch.** In `subscription_routes.py`, in the branch where `sub.status == "trialing"` falls through to conversion, compute and pass `start_at`:

```python
            trial_defer_at = None
            if sub is not None and sub.status == "trialing" and sub.trial_end and sub.trial_end > now:
                # The billing clock never moves: mandate authorised now, first
                # debit at the trial's original end. Entitlements flip at the
                # `subscription.authenticated` webhook, not here.
                trial_defer_at = int(sub.trial_end.timestamp())
            result = razorpay_service.create_subscription(..., start_at=trial_defer_at, ...)
```

**Decision (eng review): `/checkout/verify` is the fast path, the webhook is the durable path.** Extract ONE idempotent `convert_trial_purchase(session, sub)` (retire trial → grant with marker → stamp) and call it from both; the marker makes double-delivery a no-op. A customer who just paid must never see trial limits while a webhook is in flight.

- [ ] **Step 4: Authenticated handler.** In `razorpay_service.py`'s `subscription.authenticated` branch (the promo materialiser), extend for `notes`-marked trial conversions (stamp `oyechats_trial_conversion: "1"` + `oyechats_trial_sub_id` in `extra_notes` at checkout): retire the trial row (`canceled` / `converted_to_paid` — respecting `ix_subscriptions_client_bot_active` by retiring BEFORE the new row enters the active set, exactly as `transition_service.execute_gateway_cancellation`'s comment block prescribes), grant first-period credits with the activation-marker key, leave trial credits in place until day 15 forfeit (Task 5 zeroes on conversion; a converted-to-paid client keeps both buckets — they paid). `/auth/me`: add `paid_plan_starts_at` (ISO) + `paid_plan_name` when a deferred sub exists, so the rail card can say "Standard starts in 11 days".
- [ ] **Step 5: All five tests green, then the billing neighbourhood:** `pytest tests/test_trial_midway_purchase.py tests/ -q --no-cov -k "checkout or razorpay or webhook_billing or promo"`.
- [ ] **Step 6: Sandbox proof (manual, gated).** Against Razorpay TEST keys (they are ACTIVE in the local .env per repo memory): one real deferred-checkout through the modal; confirm the gateway shows `authenticated` with future `start_at` and no charge. Record the sub id in the PR description. Also verify the known constraint: a *second* upgrade before day 14 must go cancel+recreate (UPI/eMandate cannot Update) — assert the existing cancel+recreate path handles a sub in `authenticated` (it is in `_AUTHORIZABLE_SUB_STATES`, `razorpay_service.py:734`; test if uncovered).
- [ ] **Step 7: Commit** — `feat(billing): mid-trial purchase defers the first debit to day 14 and upgrades entitlements at authentication`

### Task 7: The two trial surfaces in the app shell

**Files:** Create `app/src/shell/TrialBanner.tsx`, `app/src/shell/TrialCard.tsx` + tests · Modify shell composition (`app/src/app/ProtectedLayout.tsx` for the banner; the rail footer that renders `nav.ts` `placement: 'footer'` items for the card — grep `placement` in `src/shell/` to find the exact component)

- [ ] **Step 1: Failing tests** (vitest, RTL):

```
TrialBanner
  - renders days remaining from /auth/me data; X dismisses; dismissal persisted per client_id
  - stays dismissed on re-render; RETURNS regardless of dismissal when days_remaining <= 3
  - hidden entirely when not trialing
TrialCard
  - state 1: counting days, CTA "Upgrade" → /billing
  - state 2: credits become binding (credits low, days ample) → counts credits instead
  - state 3: paid_plan_starts_at present → green, "Standard starts in N days", no Upgrade CTA
  - never renders a close button
```

- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement.** Data: whatever context already holds `/auth/me` (grep `days_remaining` in `app/src`; extend the fetch's type with `paid_plan_starts_at`). Dismissal: `localStorage` key `trial_banner_dismissed:{client_id}` — per-account, so a shared browser doesn't leak dismissals; wrap reads in try/catch. "Credits become binding": `creditsRemaining / 500 < daysRemaining / 14`. Copy exactly as the artifact: banner "**{n} days left** in your trial. Add a payment method to keep your chatbot running." card CTA "Upgrade →" / paid state "{Plan} starts in {n} days". No em-dashes in any string (site gate W-1 is website-only, but the writing rule is global).
- [ ] **Step 4: Mount.** Banner: inside `ProtectedLayout` above the routed content (after the verification gate so `/verify-email` never shows it). Card: in the rail footer, immediately above the Billing nav item (`nav.ts:81` is the anchor; the rendering component is what gets the slot).
- [ ] **Step 5: `npx tsc --noEmit && npx vitest run src/shell/ && npm run lint && npm run build` → green. Browser-verify all three card states against the local API (drive states by editing the dev sub row).**
- [ ] **Step 6: Commit** — `feat(shell): trial banner and rail countdown card`

### Task 8: Website copy — 14 days, and legal stops promising deletion

**Files:** Modify `oyechats-website/src/lib/pricing.ts`, `oyechats-website/src/lib/legal.ts`

- [ ] **Step 1:** `grep -rn "7-day\|7 day\|15 days" src/` — enumerate every hit before editing; the four known ones are `pricing.ts:146` (CTA → `Start 14-day free trial`), `pricing.ts:283` (FAQ → 14 days, all-features-open framing, "converts to the Free plan; nothing is deleted"), `legal.ts:109` and `legal.ts:232` (both currently: trial data "is deleted 15 days after the trial ends" → replace with: on trial end the account converts to the Free plan; data is retained subject to Free-plan limits; knowledge beyond those limits is paused, not deleted). Mirror the wording style of the existing `legal.ts:738` downgrade clause, which already says exactly this for paid→Free.
- [ ] **Step 2:** Effective-date/changelog convention: legal.ts has a doc-versioning pattern (grep `effective` / `updated`) — bump per its own convention.
- [ ] **Step 3:** `npm run lint && npm run build` (build runs `verify-html.mjs`, which fails on any em-dash in rendered copy — write the new sentences accordingly).
- [ ] **Step 4: Commit** — `docs(site): the trial is 14 days and its ending deletes nothing`. Flag in the PR: **legal copy changed — needs the same review channel as the 2026-08-17 legal reconciliation.**

### Task 9: Full-suite gate

- [ ] `cd api && uv run ruff check . && uv run ruff format --check . && .venv/bin/python -m pytest tests/ -q --no-cov -p no:randomly` — zero failures.
- [ ] `cd app && npx tsc --noEmit && npm run lint && npx vitest run && npm run build` — zero failures.
- [ ] `cd ../oyechats-website && npm run lint && npm run build`.
- [ ] Commit anything the gates surfaced; otherwise nothing to commit.

### Task 10: Rollout (production, in order — each step user-authorised)

Deploy order matters because the seed changes signup behaviour instantly:

- [ ] **1. Deploy code** (API + app + website) with the seed NOT yet applied — everything is backwards-compatible: no trial row exists, Free is still default, new columns are server-defaulted.
- [ ] **2. `alembic upgrade head`** on prod (adds `is_public`, backfilled true).
- [ ] **3. `python scripts/seed_plans.py --apply`** — trial row lands, Free demoted. From this moment new signups get the trial. Verify with one real signup (plus-alias) end to end: trialing sub, 500 credits, free first crawl, banner + card visible.
- [ ] **4. Watch `task_expire_trials`'s first tick** after the first trial cohort ages (journalctl on the droplet) — expected log: conversions, zero retention stamps.
- [ ] **5. In-flight accounts:** any subscription currently `trialing` on the OLD Standard-trial offer keeps its `trial_end`; the new expiry path converts them to Free instead of expiring them — strictly better, no migration needed. Any row already `trial_expired` inside its retention window is legacy: decide explicitly (recommended: null their `data_retention_until` and convert to Free with the same sweep, one-off SQL, so the deletion cron's queue drains to zero forever).

---

## Self-review notes (already applied)

- **Spec coverage:** trial-not-a-plan → Tasks 1–2; free training + 500 credits → Task 4 + seed; instant-entitlements/deferred debit → Task 6; day-15 conversion → Task 5; no top-ups → seed row (`topup_allowed: false`, enforcement pre-exists at `subscription_routes.py:3893`); banner + 3-state card → Task 7; website/legal → Task 8. The one open product decision (Free's ceiling) is excluded by name in the header.
- **Type consistency:** `resolve_crawl_cost_per_page(session, client_id, bot)` is the only new cross-file callable; `is_public` the only new column; `paid_plan_starts_at`/`paid_plan_name` the only payload additions.
- **Old-trial retirement (Task 2b):** route removed not gated; `assign_default_plan_to_client` and all `trialing` handling explicitly preserved; prod verified to have zero in-flight trialing subs.
- **Known traps encoded:** double credit grant (Task 6 marker), `ix_subscriptions_client_bot_active` retirement order (Task 6), email-marker dedup across cadence change (Task 5 step 5), pricing-catalogue leak (Task 1), UPI no-update constraint (Task 6 step 6), W-1 em-dash gate (Task 8), deploy-before-seed ordering (Task 10).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 6 issues: 2 decisions taken, 4 applied inline, 2 dissolved under verification |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**Decisions taken 2026-08-28:** (1) `/checkout/verify` flips entitlements as the fast path with the `subscription.authenticated` webhook as durable backstop, one idempotent function. (2) First-training-free is keyed by a `first_training_free` feature flag on the plan row, not a slug check.
**Verified during review:** superadmin plan list is unaffected by `is_public` (own unfiltered query, superadmin_plan_routes.py:221); deferred-purchase rows cannot collide with the live trial row (outside the unique index predicate, models.py:1951); free-tier month-2 renewal rides `task_renew_due_subscriptions` (worker/tasks.py:559) — now pinned by test.
**UNRESOLVED:** none.
**VERDICT:** ENG CLEARED — ready to implement.
