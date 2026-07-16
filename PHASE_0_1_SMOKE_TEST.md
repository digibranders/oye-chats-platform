# Smoke-Test Checklist — Onboarding Phase 0 + Phase 1

> For the changes on `development` from the audit implementation. Run against a local stack:
> `cd api && ./scripts/dev.sh` (API + ARQ worker + migrations) and `cd app && npm run dev` (dashboard on :5174).
> **Apply the new migration first:** `cd api && uv run alembic upgrade head` (adds the Phase 1.1 `bots` columns).
> Automated gates already pass: app `lint`+`build`, api `ruff`+`format`+`pytest`.

---

## Phase 0

### 0.1 Seed-question cache (no premature empty)
- [ ] Create a bot and reach the Prove step **before** the crawl finishes indexing; confirm that once the crawl completes, sample-question chips appear (not a permanent "open input only"). Previously an early empty result was cached forever.

### 0.2 / 0.3 Create contract + idempotent create
- [ ] Create a bot in Build Studio → it advances to Prove with the correct bot selected (no bounce, no duplicate bot).
- [ ] On a **free** account that already has a bot, submit the **same** website again → you get the existing bot back (no confusing 402). Submitting a **different** website still shows the upgrade/402 path.
- [ ] "Add chatbot" wizard (my-bots) still creates and navigates correctly.

### 0.4 Resume
- [ ] Start Build Studio, advance to Personalize, click "Skip to dashboard".
- [ ] Dashboard shows "Resume setup" → click it → lands on **Personalize** (not step 1), and the website field is **prefilled** if you go back to Connect.

### 0.5 Install-verify failure path
- [ ] Reach "Go live" and do **not** install the widget → after ~35s a "Not seeing it go live yet?" panel with a "Check again" button appears (no infinite spinner). "Check again" re-checks and toasts if still not detected.

### 0.7 Error boundary
- [ ] (Optional) Temporarily throw in a page component → you get the branded "Something went wrong" card with a Reload button, not a blank white screen.

### 0.8 URL validation
- [ ] At Connect, type `acme` (no dot) → inline "doesn't look like a valid website" error; `acme.com` proceeds.

### 0.9 / 0.10
- [ ] Open the Top-up modal with no packs configured → "No credit packs available" message (not a blank modal).
- [ ] Toasts across the app still render correct type/color (showToast order standardized).

---

## Phase 1

### 1.1 Durable trained state  ⚠️ needs migration applied
- [ ] After a crawl completes, `GET /bots/{id}` returns `last_crawl_status: "done"`, a `crawl_completed_at` timestamp, and `indexed_chunk_count > 0`.
- [ ] Re-enter Build Studio for that bot → Prove step latches "trained" **instantly** (from the durable fact), without waiting on a document round-trip.
- [ ] A **failed** crawl sets `last_crawl_status: "failed"` (and doesn't stamp `crawl_completed_at`).

### 1.3 Seed-questions warmed in the worker
- [ ] Watch the worker log after a crawl: seed questions are computed there. Then the Prove step's seed-question fetch returns **instantly** (cached), rather than pausing on an LLM call.
- [ ] If you race to Prove before the worker finishes, the on-demand endpoint still returns questions (fallback intact).

### 1.4 Bounded brand-tone detect
- [ ] In Bot Settings, trigger "detect tone" → returns within ~20s (or a clean "pick one manually") instead of hanging up to ~180s.

### 1.6 Auto-ask first seed question
- [ ] Reach Prove on a freshly-trained bot → the **first** seed question is asked automatically and answered in the widget preview, with no click. The "first_test_asked" metric only fires on your **own** first manual ask (auto uses `first_test_auto`).

### 1.7 Persist proof + stepper guard
- [ ] Ask a question in Prove, continue to Personalize, click **Back** → the Prove conversation is still there (not wiped).
- [ ] Stepper dots **beyond** the furthest reached step are disabled (can't jump to "Go live" before training).

### 1.8 Login order  ⚠️ auth change — verify all 3 personas
- [ ] **Client** logs in → lands on dashboard on the **first** request (check Network: no failing `/auth/operator-login` before it).
- [ ] **Team-member operator** (email is not a client) logs in → still reaches `/support`.
- [ ] **Owner who is also a self-operator** logs in → lands on their dashboard as client (then can use the workspace switcher). Confirm this matches intent.

---

## Not yet implemented (remaining Phase 1)
- **1.5** Stream the Build Studio preview answer (SSE) — needs `/chat/stream` to support owner-preview + skip credits on the billing path, plus frontend SSE consumption.
- **1.2** Fast-path crawl (latch "trained" after homepage+nav, background the rest) — crawl-orchestration change.
