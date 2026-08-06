# Downgrade & Payment-Failure Flows — Code Review + Ideal Design (2026-08-05)

**Scope:** what actually happens (code-verified, file:line) when a customer
(A) downgrades paid→paid (e.g. Professional → Standard/Starter),
(B) downgrades to Free, and
(C) has a failed renewal / autopay failure — covering **money**, **credits**,
and **customer data** in each case. Followed by Razorpay's documented behavior,
industry standards (sourced), and the ideal target design.

Companions: `2026-08-05-billing-full-code-review.md`,
`2026-08-05-ideal-billing-system-blueprint.md`.

---

## 0. Direct answers to the questions asked

| Question | Answer (current code) |
|---|---|
| Is the lower plan correctly debited next cycle? | **No — not automatically.** The old mandate is cancelled at cycle end; because Razorpay blocks Update Subscription for UPI/eMandate, the lower plan is a **new subscription needing fresh customer authorization**. The customer gets one re-auth email at cutover; until they act, nothing is debited — and their service is **offline** (finding D2). |
| Is any customer data deleted on downgrade? | **No.** Bots, documents/website training data, sessions, leads are untouched. The only hard-delete path in the whole system is expired **trials** (15-day retention, `task_delete_expired_trial_data`, with a paying-sibling safety check). |
| What happens to credits? | Old plan credits stay usable until period end. At cutover the plan-credit pool is **reset and re-granted at the new plan's allowance — unused plan credits are forfeited** (only upgrades snapshot rollover). **Top-up credits survive** (separate grants, 12-month expiry, not touched by the reset). |
| Downgrade to Free? | Mandate cancelled at cycle end; paid features until period end. **Then a black hole: no Free subscription is ever created** — the row flips to `canceled`, the widget goes offline, and no Free credits are granted (finding D1). |
| Payment / autopay failure? | Razorpay retries T+1/T+2/T+3 → `halted`. Locally: `past_due` with **full access for 7 days** + dunning emails (day 0/3/5) with a hosted recovery link. Day 7 → `expired`: widget offline, writes blocked, suspension email. Data never deleted. **But**: if the customer pays via the recovery link *after* day 7, the money is taken and service stays off (finding D3). |

---

## 1. Case A — Paid → lower paid (Professional → Standard/Starter)

### Current flow
1. `POST /change-plan` Branch 2b (`subscription_routes.py:1538`): seat-overflow
   409 guard, then `schedule_paid_downgrade` (`transition_service.py:225`):
   - **Immediate** Razorpay `cancel_at_cycle_end=true` and
     `gateway_cancel_executed_at` stamped (`:248-252`) — the mandate is dead at
     the gateway from this moment; the downgrade is **not reversible for free**
     (unlike `/cancel`, which defers the gateway call).
   - Queues `scheduled_plan_id / scheduled_billing_cycle / scheduled_change_at
     = current_period_end`.
2. Until period end: status stays `active`, plan stays Professional — full
   features, full remaining credits. Correct.
3. **Cutover**: Razorpay fires `subscription.cancelled` (or `.completed`) at
   cycle end → `promote_scheduled_change` (`transition_service.py:407`, advisory
   lock + FOR UPDATE, idempotent):
   - old seat add-on cancelled, seat count carried in notes;
   - old row → `expired` (`:497-498`);
   - **new Razorpay subscription minted** for the lower plan
     (`create_subscription`, `:504`) — a checkout link, not a charge;
   - **one re-auth email** sent with the hosted authorization link (`:526`);
     email failure is logged, promotion stands.
4. When (if) the customer authorizes: `subscription.activated` creates the new
   local row, `reset_monthly_plan_credits` + grant of the new plan's allowance;
   `apply_pending_proration` finds `upgrade_credit_pending_cents == 0`
   (downgrades never snapshot it) → **zero rollover** of unused old-plan
   credits. Top-ups untouched. First charge of the lower price happens here.

### What's right
- Deferring the plan switch to the cycle boundary, no refund mid-cycle —
  matches the dominant industry pattern (Recurly/Stripe guidance).
- Forfeiting unused *plan* credits at the boundary while *top-ups* survive —
  matches the norm exactly (ElevenLabs/Prospeo pattern for plan credits;
  Ordway/Slack pattern for purchased credits).
- No data deletion of any kind.
- Promotion is race-safe (webhook + cron backstop serialized), seat add-on is
  carried, and the double-mandate orphan case is handled.

### Findings

**D2 · HIGH — Guaranteed service outage at cutover.**
`promote_scheduled_change` expires the old row immediately, but the new local
row only exists after the customer authorizes the new mandate. The widget gate
reads the **latest** subscription row's status (`auth.py:1479-1509` →
`chat_routes.py:401-409` requires `trialing|active|past_due`) — so from cutover
until re-auth the customer's chatbot is offline and dashboard writes are
blocked. The customer asked for a *cheaper plan*, not an interruption; if they
miss the single email, they are stranded indefinitely (the log even says
"customer must be reconciled manually", `transition_service.py:539-544`).
*Root cause is a Razorpay constraint (UPI can't update plans in place), but the
UX around it is wrong-shaped: re-auth is treated as a post-cutover afterthought
instead of a pre-cutover requirement.*

**D5 · MEDIUM — Downgrade is instantly irreversible; "undo" strands the mandate.**
The gateway cancel executes at schedule time (`transition_service.py:248-252`),
not near period end like `/cancel`'s deferred model. Razorpay has **no
un-cancel** (research §3.1), so `POST /cancel-scheduled-change` can only clear
the queue and answer `mandate_action: reauthorise_required` — a customer who
changes their mind within minutes still needs a fresh mandate. The deferred
pattern already exists in this codebase (`gateway_cancel_is_due` +
00:03 sweep); the downgrade path simply doesn't use it.

**D6 · LOW — No in-flow forfeiture warning.** Unused plan credits vanish at
cutover with no confirmation-dialog disclosure (industry pattern: Prospeo shows
an explicit "you will lose N credits" warning). Pure UX, but it's the top
driver of "where did my credits go" tickets.

**D7 · LOW — Single-shot re-auth email.** No reminder cadence, no in-app
banner state for "downgrade pending authorization" — contrast with the dunning
path which has a day-0/3/5 cadence for the analogous situation.

---

## 2. Case B — Downgrade to Free

### Current flow
`POST /change-plan` Branch 1 (`subscription_routes.py:1380-1498`):
- **Manual sub (no gateway mandate):** plan flipped in place, credits reset +
  Free allowance granted immediately. Works correctly.
- **Trial-expired reactivation:** `trial_expired` row cancelled
  (`data_retention_until` nulled so the purge cron can never fire), fresh
  active Free sub inserted + Free credits granted. Works correctly.
- **Razorpay-billed sub:** `cancel_at_cycle_end=true` at the gateway,
  `gateway_cancel_executed_at` stamped, `cancel_at_period_end=True`, any queued
  paid downgrade abandoned (`cancel_scheduled_change`). Paid features continue
  to period end. **Then:**

**D1 · HIGH — The Free plan never materializes.**
At period end Razorpay fires `subscription.cancelled` →
`_handle_subscription_cancelled` (`razorpay_service.py:2649`) finds no
`scheduled_plan_id` (Branch 1 *cleared* it) → the row flips to `canceled`,
full stop. No Free subscription row is created, no Free credits granted.
Consequences:
- Widget: `bot_subscription_status` returns `canceled` → **polite-offline**
  (`chat_routes.py:402`) — the customer who chose "Free plan" has a dead
  chatbot, while a brand-new signup on Free serves traffic fine.
- Dashboard: entitlements *fall back* to Free
  (`plan_entitlements_service.py:35,464-465`), so the UI claims Free tier while
  the widget is down — a data-honesty split.
- Credits: leftover paid-plan credits are never reset, and no Free grant ever
  arrives (the renewal cron only processes `active|trialing` rows).
*Fix:* Branch 1 should queue Free as a scheduled change (reusing
`scheduled_plan_id` with a manual-provider promotion that inserts an active
Free sub + reset/grant at cutover), or the cancelled-webhook handler should
detect `cancel_reason == "downgrade_to_free"` and materialize the Free row.

Data: nothing deleted, ever, on this path — bots/documents/leads all retained
indefinitely (generous vs the 30–90-day industry windows; see §4.3).

---

## 3. Case C — Payment failure / autopay failure

### Current flow
1. Charge fails → Razorpay auto-retries **T+1, T+2, T+3**, then `halted`
   (research §1.2). Each state emits `subscription.pending` /
   `subscription.halted` → `_enter_past_due` (`razorpay_service.py:2803-2828`):
   status `past_due`, `past_due_since` stamped once (first entry only);
   the unpaid-first-period activation grant is revoked under a row lock.
2. **Access during dunning: full.** `past_due` is in the widget's serving set
   and the dashboard's active set — the customer loses nothing for 7 days.
   No new credits are granted (grants only follow `subscription.charged`).
3. **Dunning emails** (`dunning_service.py`): day 0 ("we'll retry"), day 3,
   day 5 — catch-up-if-missed semantics so a worker outage can't silently skip
   the urgent email; each carries the Razorpay **hosted recovery link**
   (correctly *resolved* from the existing subscription — never minting a new
   mandate, which would double-charge; `dunning_service.py:1-13`).
4. **Rescue within grace:** payment on the hosted page → `subscription.charged`
   → `_clear_dunning_state` + normal grant. Clean.
5. **Day 7** (`PAYMENT_FAILED_GRACE_DAYS`): `task_expire_past_due_subscriptions`
   (`tasks.py:1148-1255`) flips to `expired` (state change committed before any
   network I/O — good), suspension email sent with a recovery URL if the
   gateway still reports `pending|halted`.
6. `expired` = widget polite-offline + dashboard writes blocked. **No data
   deletion** — the purge cron targets `trial_expired` only
   (`tasks.py:1070-1073`).

### Findings

**D3 · HIGH — Post-grace recovery via our own email takes money without
restoring service.** The suspension email includes the live Razorpay payment
link (`_suspension_recovery_url`, `tasks.py:1258-1272`). A customer who pays on
it after day 7: the gateway moves halted→active and charges; our
`subscription.charged` handler sees `local.status == "expired"` and **records
the invoice but refuses credits and reactivation**
(`razorpay_service.py:2505-2516`); `subscription.activated/resumed` likewise
refuses (`:2314-2324`). Result: charged, invoiced, still suspended — the exact
"paid but locked out" state, reachable through a link we sent. The
refuse-resurrect guard is correct for *customer-cancelled* rows but
over-broad: `expired` with `cancel_reason == "dunning_grace_elapsed"` is a row
whose re-payment is the desired outcome. *Fix:* in both handlers, treat
dunning-expired rows (`cancel_reason == "dunning_grace_elapsed"`, no
customer-cancel intent) as revivable: flip back to `active`, clear dunning
state, grant the period — or stop sending recovery links once expired and
route to a fresh checkout instead.

**D4 · MEDIUM — 7-day grace vs Razorpay's ~3-day retry exhaustion leaves days
4–7 retry-less, and the halted-UPI recovery path is undocumented.** Razorpay
never auto-retries after halted; our grace continues 4 more days on manual
recovery only. That's fine, but the day-5 email is the last nudge before
suspension — industry norms run 7–14+ day windows with denser late-stage
cadence (Recurly recommends ~27-day dunning windows for monthly plans;
recoveries cluster in the first 10 days). Also flagged from research: Razorpay
documents card recovery from `halted`, but **UPI-halted recovery is
undocumented** — the hosted page may require a new mandate for UPI customers;
worth a live test before relying on the recovery link for the UPI majority.

**D8 · LOW — `past_due` grants no interim credits but keeps full access** — a
customer can burn their remaining balance to zero during grace and effectively
get free service until day 7 only if credits remain; one with an empty balance
is offline-by-credits despite "full access". Consistent enough, but worth a
banner explaining *why* replies stopped.

---

## 4. Ground truth & standards (sourced — see research notes)

### 4.1 Razorpay facts that constrain the design
- `cancel_at_cycle_end=true`: status flips to `cancelled` only at cycle end;
  **no un-cancel API exists** (Cancel-an-Update covers plan updates only) —
  the app-level deferred-cancel flag is the correct workaround, and should be
  used for downgrades too (finding D5).
- **Update Subscription is hard-blocked for UPI and eMandate** ("Subscriptions
  cannot be updated when payment mode is UPI") — plan changes require
  cancel + new subscription + fresh authorization. No 2025-26 change at the
  Razorpay API level yet (NPCI's Oct-2025 Autopay overhaul may eventually
  surface mandate modification; re-verify before building on it).
- Failed charges: `active → pending`, retries T+1/2/3, → `halted`; after
  halted **no further auto-retry**, invoices keep issuing uncharged; recovery
  = customer pays/updates instrument on the hosted page → back to `active`;
  **missed cycles are never re-attempted**.
- Pause/Resume: merchant resume works only for `paused`; a UPI mandate paused
  *by the customer in their UPI app* can only be resumed by the customer.
- Mandate fate after cancellation is undocumented — treat as revoked and
  non-reusable.

### 4.2 Industry norms (Stripe/Chargebee/Recurly/major SaaS)
- Downgrades: effective next cycle, no refund; any mid-cycle value difference
  becomes **account credit, not cash**.
- Over-limit resources on downgrade: **soft-lock / read-only, never delete**
  (Trello closes-but-keeps boards; Notion restricts with grace; Slack hides
  old messages and restores on re-upgrade). Let the user pick which N stay
  active.
- Downgrade-to-free / cancellation: features lock, **data retained 30–90 days
  minimum** (Zendesk 90d, Intercom ~13 months) with export offered and warning
  before deletion.
- Dunning: keep access while retrying (`past_due`), revoke only at
  `unpaid`-equivalent; 7–14-day grace common; escalating email cadence with
  one-click payment update; smart retries recover roughly half of failures.
  Involuntary churn is 20–40% of all churn — recovery flow quality is revenue.
- Credits: plan-included credits forfeit at the boundary (with explicit
  warning); purchased top-ups survive, refunds are goodwill-only.

---

## 5. Ideal design for OyeChats

### A. Paid → lower paid
1. Customer confirms downgrade **and immediately authorizes the new (lower)
   mandate** — the re-auth checkout happens at schedule time, not cutover,
   with `start_at = current_period_end` (the codebase already uses future
   `start_at` for resume-mode-2; same primitive). Both subscriptions coexist
   at the gateway: old one debits nothing further (cancel deferred, below),
   new one debits only from the boundary. **This removes the outage and the
   "will it debit correctly" doubt entirely** — the answer becomes yes,
   automatically, at the correct lower amount.
2. The old mandate's gateway cancel is **deferred to the 00:03 sweep** within
   `GATEWAY_CANCEL_LEAD_DAYS`, exactly like `/cancel` — making
   "undo downgrade" a free flag-flip until ~2 days before period end (D5).
3. If the customer closes the checkout without authorizing: keep the schedule,
   show a persistent "authorize your new plan" banner + reminder emails at
   day −7/−3/−1 before cutover (reuse the dunning cadence machinery, D7). If
   still unauthorized at cutover: **grace-serve on the old entitlements for
   N days** (status `pending_reauth`, widget stays up) before suspending.
4. Confirmation dialog states plainly: "Your remaining X plan credits expire
   on <date>. Your Y top-up credits are unaffected." (D6.)
5. Data: unchanged (already ideal). Over-limit bots: keep serving through
   period end; from cutover, bots beyond the new plan's limit become
   **paused-not-deleted** with an owner-chosen keep-list, matching Trello/
   Notion norms — never auto-delete.

### B. Paid → Free
1. Same scheduled-change machinery as A, but the promotion inserts a
   **manual-provider active Free subscription** + `reset_monthly_plan_credits`
   + Free grant at cutover (no mandate needed — nothing to authorize). This
   closes D1: the widget stays up on Free limits, credits are honest.
2. Over-limit handling as in A.5; features gate off Free entitlements.
3. Data retained indefinitely while the account holds any subscription row
   (Free counts). Deletion only for genuinely abandoned workspaces via an
   explicit future policy (e.g. 12 months inactive, 3 warning emails, export
   link) — never as a side effect of downgrading.

### C. Payment failure
1. Keep the current state machine (it maps cleanly onto Stripe's recommended
   `past_due` → keep access → revoke at `unpaid`-equivalent). Keep day 0/3/5 +
   suspend at 7; optionally extend suspend-not-expire to day 14 with degraded
   service (widget up, dashboard read-only) for the 8–14 window — industry
   data says late recoveries are material.
2. **Fix D3 first:** dunning-expired rows must be revivable. On
   `subscription.charged`/`activated` for a row with
   `cancel_reason == "dunning_grace_elapsed"`: reactivate, clear dunning,
   grant the period. Customer-cancelled rows keep the refuse-resurrect guard.
3. Once the gateway reports a state the hosted page can no longer recover
   (or after the mandate is revoked), stop emailing the recovery link and
   route to a fresh checkout instead.
4. Live-test the halted-UPI recovery path on a real UPI mandate before
   relying on it (undocumented by Razorpay); if UPI cannot self-recover from
   halted, the day-3+ emails for UPI customers should link to a fresh
   checkout, not the hosted page.
5. Data: keep the current never-delete stance; add a "suspended" banner that
   distinguishes payment-suspension from cancellation in the dashboard.

### Priority order
1. **D3** (paid-but-locked-out via our own recovery email) — money taken,
   service withheld; also generates chargebacks.
2. **D1** (downgrade-to-Free black hole) — silent outage on a normal flow.
3. **D2 + D5 together** (authorize-at-schedule-time + deferred gateway cancel)
   — one redesign of `schedule_paid_downgrade`/`promote_scheduled_change`.
4. D7/D6/D4/D8 in normal course.
