# Trial model: production rollout runbook

Companion to `2026-08-28-trial-model.md` (the plan) and
`2026-08-28-trial-model-EXECUTION.md` (what was actually built). This is Task 10,
written out step by step so a human can run it.

**Nothing in this file has been executed.** Every command below is written for
the production droplet, and none of them has been run there by the agent that
wrote them. The only databases this work has ever touched are the local
`oyechats_pytest` and a local `oyechats` dev database.

Read the whole file before starting step 1. Step 0 and step 3 are the two that
can lose customer data, and step 0 has to happen first.

---

## What changes, in one paragraph

A new plan row, slug `trial`, becomes the signup default: fourteen days, 500
credits, Standard's ceilings on one chatbot, the first website crawl free, no
top-ups. It never appears on the pricing page because `plans.is_public` is false
on it. When the fourteen days lapse, `task_expire_trials` converts the same
subscription row onto Free in place: every bot, document and conversation stays,
and knowledge beyond Free's ceiling is paused rather than deleted. A customer who
buys mid-trial gets their entitlements immediately and their first debit deferred
to the end of the trial.

---

## Step 0 (BEFORE the deploy): the legacy `trial_expired` rows

This is the one step with an irreversible failure mode, and it has to be settled
before the new code is anywhere near production.

The OLD expiry path flipped a lapsed trial to `trial_expired` and stamped
`data_retention_until`. A second cron, `task_delete_expired_trial_data`
(`app/worker/tasks.py:1539`, daily at 00:20 UTC), hard-deletes **every bot the
workspace owns** once that timestamp lapses, and the cascades take Document,
ChatSession, ChatMessage, LeadInfo and BANTSignal with them.

The new code never writes such a row again, and `task_expire_trials` only ever
reads `trialing`, so it cannot feed that path. **But rows stamped before the
deploy still drain through it.** Deploying the trial model does not stop the
deletion cron firing on a row a customer created weeks ago.

Count them first, on the droplet, read-only:

```sql
SELECT s.id, s.client_id, c.email, s.trial_end, s.data_retention_until,
       (SELECT count(*) FROM bots b WHERE b.client_id = s.client_id) AS bots
  FROM subscriptions s JOIN clients c ON c.id = s.client_id
 WHERE s.status = 'trial_expired'
   AND s.data_retention_until IS NOT NULL
 ORDER BY s.data_retention_until;
```

Zero rows means nothing to do; record that and move on. Anything else needs an
explicit decision. The plan's recommendation, and mine, is to convert them the
way the new cron converts everyone else, so the deletion queue drains to zero
forever:

```sql
-- Review the SELECT above first. Take a backup (api/scripts/backup.sh) before
-- running this. One transaction.
BEGIN;
UPDATE subscriptions s
   SET status               = 'active',
       plan_id              = (SELECT id FROM plans WHERE slug = 'free'),
       data_retention_until = NULL,
       cancel_at_period_end = false,
       -- Due immediately, so task_renew_due_subscriptions grants Free's
       -- credits on its next tick (00:05 UTC) and rolls the period forward.
       current_period_start = now(),
       current_period_end   = now()
 WHERE s.status = 'trial_expired'
   AND s.data_retention_until IS NOT NULL
   -- Never touch a workspace that has since bought something.
   AND NOT EXISTS (
         SELECT 1 FROM subscriptions o
          WHERE o.client_id = s.client_id
            AND o.id <> s.id
            AND o.status IN ('active', 'trialing', 'past_due'));
-- Expect the SELECT's count, minus anything the NOT EXISTS excluded.
COMMIT;
```

Three things this SQL is and is not, checked before you commit it:

1. **The period fields are not optional.** `task_renew_due_subscriptions`
   (`app/worker/tasks.py:586`) matches on `status = 'active' AND
   current_period_end <= now() AND cancel_at_period_end IS false`. A null
   `current_period_end` never compares true, so a row left without one is
   stranded on Free with no future credit grant, forever. Setting it to `now()`
   makes the row due on the next tick.
2. **`ix_subscriptions_client_legacy_active`** admits one account-level row per
   client in `active|trialing|past_due`. The `NOT EXISTS` clause is what keeps
   this UPDATE from violating it. If it raises a unique violation anyway, a
   per-bot row is involved: roll back and look at that client by hand.
3. **This is not the same thing the cron does.** `task_expire_trials` also
   forfeits the unused trial allowance and calls `deactivate_client_knowledge`,
   so a converted account's knowledge base is paused down to Free's ceiling.
   Raw SQL does neither. These accounts therefore land on Free with their
   knowledge still fully active, which is generous rather than harmful, and
   with whatever credit balance they were left holding. If that matters, pause
   them afterwards from a Python shell on the box:
   `from app.services.knowledge_state_service import deactivate_client_knowledge`.

The conservative alternative, if you would rather not change anyone's plan: set
`data_retention_until = NULL` on those rows and leave the status alone. That
stops the deletion cron dead, at the cost of leaving rows in a status nothing
writes any more.

---

## Step 1: deploy

`deploy-api.yml` runs `alembic upgrade head` as part of the deploy. The one new
migration is `l6a7b8c9d0e1_plans_is_public`, which adds `plans.is_public` with
`server_default 'true'`, so every existing plan keeps listing exactly as it does
today.

Deploy all three: API, app, website (the website is its own repository and its
own PR).

**Nothing has changed for customers at this point.** No trial row exists yet,
Free is still the signup default, and the console's trial surfaces render nothing
because `/auth/me` returns no trial block. This state is safe to sit in for as
long as you like, and it is the state you roll back to.

Verify:

```bash
ssh -i ~/.ssh/oyechats_deploy -o IdentitiesOnly=yes root@159.223.45.213
systemctl status oyechats-api oyechats-worker
curl -s 127.0.0.1:8000/health/full
psql -c "\d plans" | grep is_public
psql -c "SELECT slug, is_public, is_default FROM plans ORDER BY sort_order;"
```

Expect: `is_public` boolean not null default true, every row `t`, `free` still
`is_default = t`, and no `trial` row.

---

## Step 2: dry-run the seed

```bash
cd /opt/oyechats/api          # wherever the deploy checkout lives
uv run python scripts/seed_plans.py
```

It commits nothing without `--apply`. Read the table it prints. The line to check
is:

```
CREATE trial         ₹       0/mo     500 credits  NOT FOR SALE, delisted (is_public false)
```

and that `free` is being updated to `is_default: False`. If the trial line says
anything other than "NOT FOR SALE, delisted", stop: a public trial row renders on
the pricing page as a zero-price plan anyone can select.

The trial row deliberately carries **no Razorpay plan id**. It is never
purchased, so it needs no gateway object, and it is delisted so the
contact-sales fallback never renders.

---

## Step 3: apply the seed (the point of no easy return)

```bash
uv run python scripts/seed_plans.py --apply
```

From this second, every new signup lands on the trial. Verify immediately:

```sql
SELECT slug, is_public, is_default, sort_order, credits_per_month, trial_days
  FROM plans ORDER BY sort_order;
```

Expect `trial` at `sort_order 0`, `is_public = f`, `is_default = t`,
`credits_per_month = 500`, `trial_days = 14`; and `free` with `is_default = f`.

Then check the buying surfaces from outside the box:

```bash
curl -s https://api.oyechats.com/plans | jq '.[].slug'
curl -s https://api.oyechats.com/public/pricing-catalog | jq '.plans[].slug'
```

**Neither may contain `trial`.** If either does, `is_public` is not being
honoured and the pricing page is showing a zero-price plan. Pull it
(`UPDATE plans SET is_active = false WHERE slug = 'trial';`) and investigate
before anyone signs up.

### The real signup, end to end

This step closes the one gap the test suite cannot: whether the server sends the
console the payload its trial surfaces were built against. The mock in
`app/tests/e2e/mockBackend.ts` was shaped by reading `auth_routes.py`, not by
calling it.

Sign up with a plus-alias on a real address and check, in order:

- [ ] `subscriptions` has one row for the new client, `status = 'trialing'`,
      `plan_id` the trial row, `trial_end` fourteen days out.
- [ ] `credit_ledger` has exactly one positive `plan_grant` of 500 for it.
- [ ] The welcome email arrived, its subject names the trial, and its links go to
      `/chatbots`.
- [ ] The console shows the rail card ("14 days left in your trial", directly
      above Billing) and the banner across the top.
- [ ] `GET /auth/me` carries a `trial` block with `days_remaining` and
      `credits_granted`. This is the assertion the mock stands in for.
- [ ] Crawl a website: the quote reads **0 credits**, not 100, and the balance
      afterwards is still 500.
- [ ] A second crawl quotes the normal per-page cost.
- [ ] Crawling a site with more than 100 pages ends `limit`, with a message that
      says "at least 100 pages" rather than reporting success.
- [ ] oyechats.com/pricing says fourteen days and no longer describes the trial
      as something Starter or Standard includes.

Anything on that list failing is a stop-and-roll-back, not a note to fix later.

---

## Step 4: watch the first cohort convert

`task_expire_trials` runs hourly at minute 15 (`app/worker/settings.py:226`). It
does nothing until the first cohort ages, fourteen days after step 3.

Before that, on days 7, 11 and 13, `task_trial_reminder_emails` (09:00 UTC) sends
the days-left mails. Read one: it must not name a plan the customer is not on,
and must not mention data retention.

On day 14:

```bash
journalctl -u oyechats-worker -S today | grep -i trial
```

```sql
-- Converted in place: same row, now on Free, no retention stamp.
SELECT s.id, s.status, p.slug, s.data_retention_until, s.trial_emails_sent
  FROM subscriptions s JOIN plans p ON p.id = s.plan_id
 WHERE s.trial_end < now() AND s.trial_end > now() - interval '2 days';

-- Must stay empty forever.
SELECT count(*) FROM subscriptions
 WHERE status = 'trial_expired' AND data_retention_until IS NOT NULL;
```

Expect `status = 'active'`, plan `free`, `data_retention_until` null, a
`converted_to_free` marker in `trial_emails_sent`, every bot still present, and
the knowledge base paused rather than deleted (the documents still exist; their
chunks are deactivated above Free's ceiling).

The second query is the one that matters. Non-zero after this rollout means
something is writing the old shape and the deletion cron will act on it.

---

## Step 5: the mid-trial purchase, once

The riskiest untested path in the feature. It depends on Razorpay's `start_at`,
and **the sandbox pass was never run** (Task 6 Step 5). Buy a plan from inside a
trial, with a real card, once, and watch:

- [ ] Entitlements upgrade immediately: the console's plan name changes and the
      new ceilings apply.
- [ ] The rail card turns green and reads "{Plan} starts in N days", with no
      Upgrade button.
- [ ] Razorpay shows the subscription with `start_at` at the trial end, and **no
      charge today**.
- [ ] On the actual start date: one charge, one `plan_grant`, and not two. Count
      the rows, do not read the balance. Trial credits are use-it-or-lose-it, so
      a double grant resets and re-grants the same number and the balance cannot
      tell you.

```sql
SELECT count(*) FROM credit_ledger
 WHERE client_id = :id AND reason = 'plan_grant' AND delta > 0;
```

`_TRIAL_DEFER_FLOOR` (48 hours, `subscription_routes.py`) is an informed guess at
Razorpay's eMandate pre-debit notice window. If Razorpay rejects a `start_at` as
too near, that constant is the one thing to change.

---

## Decisions already taken, recorded so nobody re-opens them

- **Existing Free accounts stay on Free.** No retroactive trial. Task 2b removed
  the self-serve start-trial path, so there is no lever a customer can pull; a
  superadmin grant-trial control is a later follow-up if a real customer asks.
- **Signups between step 1 and step 3 get old-Free.** A window of minutes.
  Accepted.
- **The trial clock starts at registration, before email verification.** Observed
  verification time is seconds. Accepted and stated.
- **Accounts currently `trialing` on the OLD Standard-trial offer** keep their
  `trial_end` and are converted to Free by the new path rather than expired.
  Strictly better than what they signed up under; no migration needed.

---

## Razorpay sandbox proof (run 2026-08-31, TEST mode)

Step 5's gateway questions, answered against the real API rather than reasoned
from documentation. Every subscription created was cancelled afterwards.

| Probe | Result |
|---|---|
| `start_at` at +11 days (the normal trial case) | accepted, echoed back with **0s drift** |
| `start_at` at +48h, +6h, +30min | **all accepted** |
| our own `create_subscription` with a conversion note | `status=created`, `paid_count=0`, note present, `short_url` minted |

Two conclusions:

1. **The deferral works end to end.** Our service mints a mandate whose first
   debit is the trial's own end, charges nothing at purchase, and carries the
   conversion note the grant and forfeit both key on.
2. **The 48h floor is not a gateway rule.** The plan reasoned it as an eMandate
   pre-debit notice window the gateway would refuse inside. It does not refuse:
   +30 minutes was accepted. The floor stays as a safety margin on the DEBIT
   (RBI's notice requirement applies to the charge, not the record), and
   `resolve_trial_defer_at`'s docstring now says so instead of stating a gateway
   constraint that does not exist.

**Still requiring a human at the modal:** the `created` to `authenticated`
transition after a customer actually authorises. Everything up to the modal is
now observed; only the customer's own tap is not.

## Rollback

**Before step 3**, rollback is the deploy: revert API and app, and the
migration's `downgrade()` drops `is_public`. Nobody has been affected.

**After step 3**, do not try to un-seed. New signups already hold trial
subscriptions and 500 credits, and deleting the plan row underneath them breaks
their entitlements. Stop the bleeding and leave the cohort whole:

```sql
UPDATE plans SET is_default = true  WHERE slug = 'free';
UPDATE plans SET is_default = false, is_active = false WHERE slug = 'trial';
```

New signups go back to Free immediately. Existing trial subscriptions keep
working: `is_active` gates assignment and listing, not an existing row's
entitlements. Then let the cohort convert to Free normally at day 14, or convert
them early with step 0's UPDATE shape.

Reverting the API CODE after step 3 is worse than leaving it deployed: the old
expiry path would stamp `data_retention_until` on the whole trial cohort and
queue their workspaces for deletion. **If you roll the code back, run step 0's
UPDATE again afterwards.**
