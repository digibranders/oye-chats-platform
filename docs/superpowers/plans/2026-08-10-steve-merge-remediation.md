# Steve-branch merge remediation — implementation plan

> **For agentic workers:** work task-by-task, smallest safe step first. Steps use
> checkbox (`- [ ]`) syntax. **A review agent runs after EVERY task** — see
> "Review loop workflow" at the bottom. That loop is not optional: on this
> workstream it has caught a real defect on every single pass, including three
> occasions where a "fix" did not actually work.

**Goal:** close the still-applicable defects two adversarial reviews found in `048c069`
(pricing & credits) and `e6327b9` (logo), which are now merged into
`development`.

**Status of the merge itself:** DONE and pushed. Conflicts resolved
semantically, not textually. Four things were fixed during the merge because
they were merge-critical or one-line; everything else is below.

**Branch:** `development`. Never touch `main`.

---

## What was already fixed during the merge — do not redo

| ID | Fix | Why it could not wait |
|---|---|---|
| B1 | Repointed `f5a1c2b3d4e6.down_revision` → `1da557cae107` | Two alembic heads. `alembic upgrade head` raises "Multiple head revisions"; CI's migration gate fails on step 1 and `deploy-api.yml` aborts under `set -e`. Git reported NO textual conflict, so this was invisible. |
| B2 | `_already_resolved` now gates the **charge**, not just the lookup | `company_name` was charged 10 credits per chat MESSAGE. A 15-turn conversation = 150 credits of enrichment vs 15 of actual AI replies; ~67 conversations exhaust a Professional plan's month. |
| B3 | `idempotency_key` on both enrichment charges | `/chat/lead-capture` is posted by the widget from the pre-chat form AND the handoff form → 2 charges, 1 lead. Worse, it is rate-limited per bot key, which is public: 10/min × 10 credits = 6,000 credits/hour, draining a Standard plan in ~25 minutes. |
| FE-B1 | `UsagePage.tsx:466` "roll over for 12 months" → "never expire" | The hero 400px above said "Never expire". Both rendered on one screen, in the commit whose whole purpose was the reprice. |

Also repaired during the merge: `OverviewPage.test.tsx` expected an `<h1>` with
the agent name, which `048c069` deleted along with `AgentOverviewHero` (identity
moved to `AgentLayout`). The assertion was re-homed rather than deleted. Both
frontend reviewers missed this because they ran only the touched test file.

---

## Tasks 1 & 2 — Razorpay repricing and subscriber grandfathering: **CLOSED, won't-do**

Both reviews flagged these as the highest-value money findings. **Neither
applies**, on two explicit decisions from the product owner:

1. **The production database is wiped and reseeded before market launch.**
   Everything in it today is test data.
2. **New Razorpay plans will be created fresh at launch.** The existing plan
   ids are not being carried forward.

That removes the premise under both:

* **H2 — `seed_plans.py --apply` reprices without minting Razorpay plans.** The
  failure mode was a stale `razorpay_plan_id_*` billing the OLD amount while the
  UI showed the new one (Professional: display ₹3,599, bill ₹1,399). With plans
  minted fresh at launch there is no stale id to mismatch.
* **H3 — existing subscribers silently lose credits.** Standard 6,000 → 2,500 at
  an unchanged ₹949; annual 72,000 → 30,000 on a ₹9,108 mandate. With no
  pre-launch subscribers there is nobody to grandfather.

**What is still worth doing, but only AFTER launch** — once there are live
subscribers and live Razorpay plan ids, `seed_plans.py` becomes genuinely
dangerous, because both failure modes come back with real customers attached.
Add then, not now:

- [ ] A guard in `seed_plans.py` that refuses to change `price_inr` on a plan
      whose `razorpay_plan_id_*` is set, pointing at the superadmin edit path
      (`superadmin_plan_routes.py:426`) which mints a new gateway plan on any
      price change.
- [ ] A decision, recorded in code, on what a `credits_per_month` change does to
      subscribers already on that plan.

Its docstring currently advertises "idempotent", which it is not — worth a
one-line correction whenever the file is next touched.

---

## Task 3 — Refund or charge-after-success on enrichment failure (H1)

`api/app/api/chat_routes.py` deducts before `fetch_ip_intel()` / `verify_email()`.
A Reoon 5xx or an ipapi.is timeout burns 10 credits with nothing written and no
compensating ledger row. The `refund` reason already exists and is unused.

- [ ] **Step 1: Failing test** — patch the vendor to raise; assert the ledger
      nets to zero for that unit of work.
- [ ] **Step 2: Implement.** Prefer charge-after-success where the call is
      idempotent; otherwise write a `refund` row. Note the interaction with the
      `idempotency_key` added during the merge — a refund must not let the next
      message re-charge.
- [ ] **Step 3: Full suite. Commit.**

---

## Task 4 — Document tier labels overcharge at 4 of 5 boundaries (FE H-1)

Backend `max_words` is **exclusive** (`credit_service.py:162-168`, `word_count <
cap`). `app/src/features/workspace/UsagePage.tsx:248-254` labels them inclusive.

| Label | Advertised | Actually charged at the boundary |
|---|---|---|
| "Up to 100 words" | 5 | 15 |
| "100–500 words" | 15 | 30 |
| "500–2,000 words" | 30 | 75 |
| "2,000–10,000 words" | 75 | 150 |

Steve's own comment at `UsagePage.tsx:212` documents that `max_words` is
exclusive, immediately above the labels that fall into the trap. Also fix the
`credit_service.py:309` docstring, which says that bucket is "25 credits" — it
is 15. Three-way drift.

- [ ] **Step 1:** Relabel to match the exclusive backend ("Under 100 words",
      "100–499", "500–1,999", "2,000–9,999"), OR change the backend to
      inclusive. Prefer relabelling — changing the gate changes what people are
      charged.
- [ ] **Step 2:** Add a test that derives the labels from the same source as
      the gate, or asserts the boundary explicitly.
- [ ] **Step 3:** `npx tsc --noEmit && npm run lint && npm run build && npx vitest run`. Commit.

---

## Task 5 — Credit costs are hardcoded in the UI against a tunable backend (FE M-3)

All five prices and five doc tiers are literals in `UsagePage.tsx`, while the
backend reads them from the `pricing_config` KV that the superadmin can edit.
Any price edit silently makes this page wrong, defeating the point of
`PricingConfig`. There is no credit-cost API surface today.

- [ ] Add a read-only endpoint exposing effective credit costs; consume it.
      Coordinate with Task 4 so the labels come from one source.

---

## Task 6 — Avatar cropper accepts anything (FE H-4)

`AvatarPicker.tsx:143` sets only `accept="image/*"` (a hint). The UI promises
"PNG, JPG or SVG up to 2MB" and enforces none of it.

Three concrete failures, all verified by the reviewer:
1. A 6000×8000 phone photo → ~48 MP canvas ≈ 192 MB; past iOS Safari's 16.7 MP
   cap `toBlob` returns a **transparent** blob with no exception — the user
   uploads an invisible avatar and is told it worked.
2. `canvasToFile` always re-encodes lossless PNG, so a 2 MB JPEG becomes a
   10–25 MB PNG and the server rejects a file inside the advertised limit.
3. `image/*` admits SVG; an SVG with no intrinsic size gives `naturalWidth === 0`
   and the `Math.max(1, …)` guards silently upload a 1×1 PNG.

- [ ] Allow-list `file.type`, check `file.size` BEFORE `readAsDataURL`,
      downscale to a bounded max dimension (~1024px) before drawing.
- [ ] Tests for each of the three cases.

---

## Task 7 — Drop-off analytics report confident wrong numbers (FE H-2)

`UserJourneyFlow.tsx:644-663` subtracts whole buckets, so any path with even one
conversion is removed from "Drop-off" **entirely** — meaning the highest-traffic
paths, the ones most likely to contain a conversion, are the most likely to
disappear. Surviving rows render their FULL session count labelled as drop-offs.
`conversionPaths` is also fetched with `limit: 5` against `limit: 6` for
pre-chat sequences, so conversions outside the top 5 are double-counted.

- [ ] Either subtract at the session level (needs backend attribution) or revert
      to the previous behaviour and label the filter approximate. **Do not ship
      authoritative-looking wrong analytics.**
- [ ] Fix the empty state at `:1079`, which claims "every journey reached an
      outcome" when there were simply no journeys.

---

## Task 8 — Smaller, verified items

- [ ] **M6 (security-ish, cheap):** `credit_service.is_feature_enabled:356-365`
      does `bool(value)` on config written through the unvalidated `value: Any`
      superadmin editor. A superadmin typing the string `"false"` **enables** the
      feature (`bool("false") is True`) — including
      `feature.company_name_enabled`, which is meant to stay off until launch.
      Coerce strings properly.
- [ ] **M7:** Real ledger-level tests for `_charge_for_enrichment` — every
      existing test patches it, so nothing verifies a ledger row is written, 10
      is deducted, or the bot ledger rather than the client pool is targeted.
      (The merge added a call-count + idempotency-key test; that is necessary,
      not sufficient.)
- [ ] **M1:** Lifetime top-ups are not retroactive — existing rows keep a
      12-month `expires_at` and `expire_old_topups:771` still sweeps them while
      the UI says lifetime.
- [ ] **M2:** `topup_expiry_months = 0` is inert in production —
      `get_pricing:216-219` lets the DB row (currently `12`) win. Merging the
      code alone does not deliver lifetime credits; it needs
      `seed_pricing_config.py` re-run. Undocumented deploy coupling — document it.
- [ ] **M5:** `plan_entitlements_service.py:588,613` narrowed `plan_slug != "free"`
      to `{"standard","professional"}`. The old comment explicitly warned a
      bespoke enterprise slug must not lose it. Starter and custom paid slugs now
      leave `is_valid_email` as `None`, tripping the 409 soft gate at
      `lead_routes.py:615`. Decide and communicate.
- [ ] **FE H-5:** Deleting `AgentOverviewHero` removed the *agent-scoped*
      "Resume setup" CTA; only the unscoped `hasLaunchProgress(workspaceId)`
      remains. The deleted file's own comment warns an unscoped button
      "resumed onboarding against a different agent and renamed / re-crawled it".
      Port the `needsSetup` branch into `HealthHero.nextStep`.
- [ ] **FE E-1:** Logo swap is half-applied — `Login.jsx`, `Register.jsx`,
      `ForgotPassword.jsx` and `sw.js:194` still serve the OLD mark. The user
      watches the logo change between login and sidebar.
- [ ] **FE E-2:** `AgentActionsMenu` delete flow leaves `busy=true` and the
      dialog mounted on success; if the parent refetch keeps the row the user
      gets a permanently-spinning modal that cannot be dismissed.
- [ ] **FE:** Remove the dead `react-easy-crop` dependency (zero references) and
      `React.lazy` the cropper — it is +28.5 kB in the MAIN chunk, paid by every
      user on first paint for a modal that opens on demand.
- [ ] **FE M-3/M-4/M-5/M-7, L-1..L-6:** see the review notes; all low.

---

## Pre-existing, not from this merge

- [ ] `KnowledgePage.tsx(31,58)` TS2305 on `getKnowledgeState`. **This is NOT a
      runtime bug** — the function genuinely exists and is exported in
      `app/src/services/api.js:786`, and the backend endpoint
      `/documents/knowledge-state` exists. Only the hand-maintained
      `app/src/services/api.d.ts` lacks the declaration. One-line fix:
      `export function getKnowledgeState(botId?: number): Promise<{active_count:number; inactive_count:number; deactivated:boolean}>;`
      A separate session may already have done this — check before editing.
- [ ] `UsagePage.tsx` TS6133 ×2 — `Zap` unused, and `ActivityCard` defined but
      never rendered. Check git history before deleting `ActivityCard`; it may
      be a section someone forgot to wire up rather than dead code.

---

## Review loop workflow — MANDATORY after every task

1. Implement the task TDD-style: failing test → minimal fix → passing test.
2. **Mutation-check every rule you add.** Revert the fix (not the test) and
   confirm the test fails. A test that passes with the fix removed is not a
   test. On this workstream that check has repeatedly exposed fixes that did
   nothing.
3. Run the gates for what you touched:
   - `cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
   - `cd app && npx tsc --noEmit && npm run lint && npm run build && npx vitest run`
   - If you touched migrations: `uv run alembic heads` (must be exactly ONE),
     then upgrade → `alembic check` → `downgrade -1` → upgrade against a
     throwaway database.
   - **Stop any local uvicorn first** — it competes for DB connections and
     produces ~150 spurious failures that look real.
4. Commit with a message that states what was wrong, not just what changed.
5. **Dispatch an adversarial review agent** on the commit. Tell it to be
   skeptical, to verify claims by running code rather than reading, and to
   report severity + file:line + a concrete failure scenario. Explicitly ask it
   to check whether the fix actually works, and to spot-check the mutation
   claims itself.
6. Fix what it finds. Re-review if a BLOCKER or HIGH was found. Repeat until a
   round comes back with nothing above MEDIUM.
7. Only then move to the next task.

**Do not batch tasks to save review rounds.** Every round on this workstream has
found something real.
