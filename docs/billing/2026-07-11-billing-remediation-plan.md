# Billing & Invoicing Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 8 confirmed money-loss / GST-exposure findings from the 2026-07-10 billing review (`docs/billing/2026-07-11-billing-invoice-system-review.md`) without regressing the core money path.

**Architecture:** Each fix is TDD-first against the existing Postgres-backed pytest suite (`api/tests/`, real `db` fixture). Fixes are grouped into phases that are independently shippable — every phase ends green (`ruff check` · `ruff format` · `pytest`) and is committed on `development`. The recurring anti-pattern the review names — *entitlement granted before the gateway confirms the money* — is corrected everywhere it appears (findings A, C, F): **entitlement follows a confirmed gateway event, never a local intent.**

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · PostgreSQL 16 · Razorpay · pytest (module-scoped Postgres `db` fixture). Schema in tests is built via `Base.metadata.create_all` (so model `__table_args__` changes take effect automatically); **production uses Alembic**, so every schema change needs BOTH a model edit and a migration off head `c4e2f6a8b1d3`.

---

## Findings covered (all re-verified against `development` before this plan)

| Phase | Finding | Severity | One-liner | Confidence |
|-------|---------|----------|-----------|------------|
| 1 | **E** | HIGH | Refund credits counted by `get_balance` but excluded from the FIFO allocator → stuck, unspendable balance | CONFIRMED |
| 1 | **H** | MED | Credit deductions not idempotent per `reference_id` → retry/reconnect double-deduct | CONFIRMED |
| 2 | **C** | HIGH | Paid top-up lost when `order.fetch` throws (swallowed, dedup row burned) | CONFIRMED |
| 3 | **B** | HIGH | Plan-price edit never resyncs the immutable Razorpay plan → displayed ≠ charged | CONFIRMED |
| 4 | **G** | MED | Invoice date & FY serial from finalize wall-clock, not `paid_at` | PARTIAL (real, reframed) |
| 5 | **D** | HIGH | No idempotency on `/change-plan` upgrade → duplicate subs → double-charge | CONFIRMED |
| 5 | **F** | HIGH | Upgrade rollover credit snapshotted at click-time, re-granted in full at activation → leakage | CONFIRMED |
| 6 | **A** | HIGH | Operator seats entitled before mandate auth → free seats + no GST doc for seat revenue | CONFIRMED |

**Recommended execution order:** Phases are ordered fastest-and-most-self-contained first. **Finding A (Phase 6) is the single highest-$ item** but also the largest (new column + migration + webhook handler + route + frontend), so it is scheduled last as a dedicated unit. If a team wants to attack the biggest leak first, Phase 6 can be pulled forward — it has no dependency on the other phases.

Do NOT batch multiple phases into one commit. Each phase is a reviewable unit.

---

## Phase 0: Repo hygiene & doc drift (no code risk)

**Files:**
- Modify: `.gitignore`
- Move: `BILLING_INVOICE_SYSTEM_REVIEW.md` → `docs/billing/2026-07-11-billing-invoice-system-review.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Stop the brainstorm scratch artifact from ever being staged**

Append to `.gitignore`:

```gitignore

# Superpowers / brainstorm skill scratch output (never commit)
.superpowers/
```

- [ ] **Step 2: Delete the stray scratch directory**

```bash
cd /Users/a12345/Desktop/AI/OyeChats/oye-chats-platform
rm -rf .superpowers
git check-ignore .superpowers/ && echo "ignored ✓"
```

- [ ] **Step 3: Relocate the top-level review doc next to its companions**

```bash
git mv BILLING_INVOICE_SYSTEM_REVIEW.md docs/billing/2026-07-11-billing-invoice-system-review.md 2>/dev/null \
  || mv BILLING_INVOICE_SYSTEM_REVIEW.md docs/billing/2026-07-11-billing-invoice-system-review.md
```

(The three `2026-07-09-*` docs are already in `docs/billing/`; add them in the same commit.)

- [ ] **Step 4: Fix the Stripe doc drift in `CLAUDE.md`**

Stripe was fully removed (migration `d7b3f9e2c5a8_remove_stripe_vestiges`); `api/app/services/billing_service.py` does not exist. In `CLAUDE.md`:
- In the "Billing" schema section, change `**Billing (Razorpay primary INR + Stripe fallback)**` → `**Billing (Razorpay, INR — single rail)**`.
- In the **Key Files** table, delete the row `| Billing (Stripe) | api/app/services/billing_service.py |`.
- In the **Tech Stack** table, change the Payments row from `Razorpay (primary, INR) + Stripe (fallback)` → `Razorpay (INR) — single provider; webhook idempotency via processed_webhooks`.
- Change `Invoice — Synced from providers` → `Invoice — issued by OyeChats (Razorpay-triggered)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/a12345/Desktop/AI/OyeChats/oye-chats-platform
git add .gitignore CLAUDE.md docs/billing/2026-07-09-billing-invoice-system-architecture.md \
  docs/billing/2026-07-09-gst-billing-ca-review.md docs/billing/2026-07-09-gst-invoice-summary.html \
  docs/billing/2026-07-11-billing-invoice-system-review.md docs/billing/2026-07-11-billing-remediation-plan.md
git commit -m "docs(billing): land review deliverables + remediation plan; drop Stripe doc drift; ignore .superpowers"
```

---

## Phase 1: Credit-ledger integrity (findings E + H)

**Root cause (review §6.3):** two sources of truth disagree — `get_balance` sums *all* deltas, but `_grants_for` (the allocator) sees a narrower set. Fix by making the allocatable set match what the balance counts (E) and by making deductions idempotent per reference (H).

### Task 1: E — make refunded credits allocatable

**Files:**
- Modify: `api/app/services/credit_service.py` (`_grants_for`, ~line 285)
- Test: `api/tests/test_credit_refund_allocatable.py` (create)

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_credit_refund_allocatable.py`:

```python
"""Finding E: a positive `refund` row must be counted by get_balance AND be
spendable by the FIFO allocator. Before the fix, a refund with no live grant
inflated the balance but raised InsufficientCredits on the next deduction."""
import pytest
from sqlalchemy import select

from app.db.models import Client, CreditLedger
from app.services import credit_service


def _client(db) -> Client:
    c = Client(email="refund-e@test.local", hashed_password="x", api_key="k-refund-e")
    db.add(c)
    db.flush()
    return c


def test_refund_credits_are_spendable(db):
    client = _client(db)
    # A refund with NO originating live grant (e.g. crawl-failure refund).
    credit_service.refund(db, client.id, amount=50, reference_id=999, note="crawl refund")
    db.commit()

    assert credit_service.get_balance(db, client.id) == 50

    # This must NOT raise InsufficientCredits — the refunded 50 is real balance.
    new_balance = credit_service.check_and_deduct(db, client.id, 10, reason="url_scan")
    db.commit()

    assert new_balance == 40
    assert credit_service.get_balance(db, client.id) == 40


def test_balance_equals_allocatable_after_refund(db):
    """Invariant: get_balance must equal what the allocator can consume."""
    client = _client(db)
    credit_service.refund(db, client.id, amount=30, reference_id=1, note="r")
    db.commit()
    # Draining the whole balance must succeed exactly.
    credit_service.check_and_deduct(db, client.id, 30, reason="ai_chat")
    db.commit()
    assert credit_service.get_balance(db, client.id) == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_credit_refund_allocatable.py -v`
Expected: FAIL — `test_refund_credits_are_spendable` raises `InsufficientCredits` (refund rows excluded from `_grants_for`).

- [ ] **Step 3: Add `"refund"` to the allocatable whitelist**

In `api/app/services/credit_service.py`, `_grants_for`, change the `reason.in_(...)` clause (currently line ~288):

```python
    stmt = select(CreditLedger).where(
        *_scope_clause(client_id, bot_id),
        CreditLedger.delta > 0,
        CreditLedger.reason.in_(("plan_grant", "topup", "manual_adjust", "refund")),
    )
```

Also update the ordering `CASE` so refunds sort with top-ups (consumed after plan grants, before nothing else). Change the `order_by` `text(...)` to:

```python
        text(
            "CASE reason WHEN 'plan_grant' THEN 0 "
            "WHEN 'topup' THEN 1 WHEN 'refund' THEN 1 ELSE 2 END"
        ),
```

`refund` rows have `expires_at IS NULL`, so the `only_unexpired` filter keeps them, and `expires_at ASC NULLS LAST` sorts them after dated top-ups — correct FIFO.

- [ ] **Step 4: Fix the now-correct docstring on `refund()`**

The `refund()` docstring (line ~421) says refunds "behave like a fresh manual adjustment for FIFO purposes" — that is now true. Leave it, but update `_grants_for`'s own docstring list (line ~281) to add:

```python
      4. ``refund`` alongside topups (no expiry; sorts after dated topups).
```

- [ ] **Step 5: Also cover `get_balance_breakdown` attribution**

`get_balance_breakdown` iterates `_grants_for`, so refunds now appear — they have `reason != "plan_grant"`, so they land in the `topup_remaining` bucket (line ~314). That is the intended display bucket for "spendable, non-plan credits." No code change; add an assertion to the test to lock it:

```python
def test_refund_shows_in_breakdown_topup_bucket(db):
    client = _client(db)
    credit_service.refund(db, client.id, amount=25, reference_id=7, note="r")
    db.commit()
    bd = credit_service.get_balance_breakdown(db, client.id)
    assert bd["total"] == 25
    assert bd["topup"] == 25
    assert bd["plan"] == 0
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_credit_refund_allocatable.py tests/test_credit_service_clawback.py tests/test_credit_refund_on_failure.py -v`
Expected: PASS (new file green; the two existing refund/clawback suites still green — no regression).

- [ ] **Step 7: Commit**

```bash
cd api
git add app/services/credit_service.py tests/test_credit_refund_allocatable.py
git commit -m "fix(billing): make refunded credits FIFO-allocatable (finding E); balance now equals spendable set"
```

### Task 2: H — idempotent credit deductions per reference

**Files:**
- Modify: `api/app/db/models.py` (`CreditLedger.__table_args__`, ~line 1282)
- Modify: `api/app/services/credit_service.py` (`check_and_deduct`, ~line 349)
- Modify: `api/app/api/chat_routes.py` (~line 344 — pass a real message id)
- Create: `api/alembic/versions/e1f2a3b4c5d6_credit_dedup_unique_index.py`
- Test: `api/tests/test_credit_deduct_idempotent.py` (create)

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_credit_deduct_idempotent.py`:

```python
"""Finding H: check_and_deduct must be idempotent per (reason, reference_id)
within a scope, so an ARQ retry / SSE reconnect can't double-charge credits."""
import pytest
from sqlalchemy import select, func

from app.db.models import Client, CreditLedger
from app.services import credit_service


def _seed(db) -> Client:
    c = Client(email="dedup-h@test.local", hashed_password="x", api_key="k-dedup-h")
    db.add(c)
    db.flush()
    db.add(CreditLedger(client_id=c.id, delta=100, reason="plan_grant"))
    db.flush()
    return c


def test_repeat_deduction_same_reference_is_noop(db):
    client = _seed(db)
    b1 = credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", reference_id=4242)
    db.commit()
    # Same (reason, reference_id) again — a retry. Must NOT deduct twice.
    b2 = credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", reference_id=4242)
    db.commit()

    assert b1 == 95
    assert b2 == 95  # unchanged
    n_neg = db.scalar(
        select(func.count()).select_from(CreditLedger).where(
            CreditLedger.client_id == client.id, CreditLedger.delta < 0
        )
    )
    assert n_neg == 1  # only one deduction row written


def test_distinct_references_still_deduct(db):
    client = _seed(db)
    credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", reference_id=1)
    credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", reference_id=2)
    db.commit()
    assert credit_service.get_balance(db, client.id) == 90


def test_null_reference_is_not_deduped(db):
    """Callers without a reference (reference_id=None) keep old behaviour."""
    client = _seed(db)
    credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", reference_id=None)
    credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", reference_id=None)
    db.commit()
    assert credit_service.get_balance(db, client.id) == 90
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_credit_deduct_idempotent.py -v`
Expected: FAIL — `test_repeat_deduction_same_reference_is_noop` sees `b2 == 90` and `n_neg == 2` (double deduction).

- [ ] **Step 3: Add the app-level idempotency guard in `check_and_deduct`**

In `api/app/services/credit_service.py`, inside `check_and_deduct`, **after** `_acquire_client_lock(...)` (line ~370) and **before** the `available = get_balance(...)` line, insert:

```python
    # Idempotency (finding H): a retry/reconnect must not re-charge the same
    # unit of work. When the caller supplies a reference_id, short-circuit if a
    # deduction for this (scope, reason, reference_id) already exists. Runs
    # under the advisory lock so two concurrent retries can't both pass.
    if reference_id is not None:
        already = session.scalar(
            select(CreditLedger.id).where(
                *_scope_clause(client_id, bot_id),
                CreditLedger.delta < 0,
                CreditLedger.reason == reason,
                CreditLedger.reference_id == reference_id,
            ).limit(1)
        )
        if already is not None:
            logger.info(
                "credit_service: idempotent skip — deduction for (%s, ref=%s) already recorded",
                reason,
                reference_id,
            )
            return get_balance(session, client_id, bot_id)
```

- [ ] **Step 4: Fix the chat caller to pass a UNIQUE reference**

`api/app/api/chat_routes.py:~344` currently passes `reference_id=bot.id` (the bot id — same for every message, so dedup is impossible). Change it to the chat message id being charged for. Locate the `check_and_deduct(...)` call in the chat flow and change `reference_id=bot.id` → `reference_id=<the persisted user/bot ChatMessage.id for this turn>`. If no message id is available at that point, pass the `ChatSession`-scoped monotonic message id created earlier in the same request. Add a code comment:

```python
        # reference_id MUST be unique per billable unit (the ChatMessage id),
        # not bot.id — otherwise finding-H idempotency can never fire.
        credit_service.check_and_deduct(
            session, client_id, cost, reason="ai_chat", reference_id=chat_message.id, bot_id=bot.id
        )
```

> If threading the message id here is non-trivial, that is a real prerequisite — do NOT leave `bot.id`; a duplicated `bot.id` would make every chat for a bot after the first look "already deducted" and silently stop charging. Verify the exact variable in `chat_routes.py` before editing.

- [ ] **Step 5: Add the partial unique index to the model**

In `api/app/db/models.py`, `CreditLedger.__table_args__` (line ~1282), add a partial unique index (Postgres) so a race that slips the app check still fails closed:

```python
    __table_args__ = (
        Index("ix_credit_ledger_client_created", "client_id", sqlalchemy.text("created_at DESC")),
        Index(
            "ix_credit_ledger_topup_expiry",
            "expires_at",
            postgresql_where=sqlalchemy.text("expires_at IS NOT NULL AND delta > 0"),
        ),
        Index("ix_credit_ledger_grant_id", "grant_id"),
        Index("ix_credit_ledger_reference_id", "reference_id"),
        Index(
            "uq_credit_ledger_deduction_ref",
            "client_id",
            "bot_id",
            "reason",
            "reference_id",
            unique=True,
            postgresql_where=sqlalchemy.text("delta < 0 AND reference_id IS NOT NULL"),
        ),
    )
```

The `db` test fixture builds schema via `create_all`, so this index exists automatically in tests. `bot_id` is nullable; Postgres treats `NULL` bot_ids as distinct, which is acceptable here because client-pool deductions (`bot_id IS NULL`) are still deduped by the app-level check under the same advisory lock.

- [ ] **Step 6: Write the Alembic migration for production**

Create `api/alembic/versions/e1f2a3b4c5d6_credit_dedup_unique_index.py`:

```python
"""credit ledger: partial unique index for deduction idempotency (finding H)

Revision ID: e1f2a3b4c5d6
Revises: c4e2f6a8b1d3
Create Date: 2026-07-11
"""
from collections.abc import Sequence

from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: str | Sequence[str] | None = "c4e2f6a8b1d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # CONCURRENTLY cannot run inside Alembic's transaction; use a plain create.
    # Table is small enough that a brief lock is fine. If prod volume makes this
    # a concern, run the CONCURRENTLY variant manually and stamp the revision.
    op.create_index(
        "uq_credit_ledger_deduction_ref",
        "credit_ledger",
        ["client_id", "bot_id", "reason", "reference_id"],
        unique=True,
        postgresql_where="delta < 0 AND reference_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_index("uq_credit_ledger_deduction_ref", table_name="credit_ledger")
```

> Before applying in prod, check for existing duplicate deduction rows: `SELECT client_id, bot_id, reason, reference_id, count(*) FROM credit_ledger WHERE delta < 0 AND reference_id IS NOT NULL GROUP BY 1,2,3,4 HAVING count(*) > 1;` — the historical `bot.id`-as-reference bug means dupes may exist. If so, the index build fails; the migration must first collapse dupes (keep the earliest row per group). Add that `op.execute(...)` cleanup above `create_index` only if the query returns rows.

- [ ] **Step 7: Run tests + confirm migration is linear**

Run:
```bash
cd api
uv run pytest tests/test_credit_deduct_idempotent.py tests/test_credit_deduct_grant_boundary.py -v
uv run alembic heads   # must show exactly one head: e1f2a3b4c5d6
```
Expected: tests PASS; `alembic heads` shows a single head.

- [ ] **Step 8: Commit**

```bash
cd api
git add app/services/credit_service.py app/db/models.py app/api/chat_routes.py \
  alembic/versions/e1f2a3b4c5d6_credit_dedup_unique_index.py tests/test_credit_deduct_idempotent.py
git commit -m "fix(billing): idempotent credit deductions per reference_id + partial unique index (finding H)"
```

### Phase 1 gate

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest tests/ -k "credit" -q
```
Expected: `ruff ✓ · format ✓` and all credit tests green.

---

## Phase 2: Top-up not lost on order-fetch failure (finding C)

**Files:**
- Modify: `api/app/services/razorpay_service.py` (`_handle_payment_captured`, ~line 1945)
- Test: `api/tests/test_topup_fetch_failure.py` (create)

**Fix intent:** distinguish "fetched, confirmed not a top-up" (ack, ignore) from "couldn't fetch, don't know" (raise → dead-letter → Razorpay retries; idempotency makes the eventual success a no-op).

### Task 3: Raise instead of swallow on order-fetch failure

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_topup_fetch_failure.py`:

```python
"""Finding C: when a payment.captured lacks order notes and order.fetch fails,
the handler must RAISE (so the webhook rail retries) — not ack it as 'ignored'
and burn the dedup row, which loses the customer's paid top-up."""
from unittest.mock import MagicMock, patch

import pytest

from app.services import razorpay_service


def _payment_captured_without_notes(order_id="order_xyz"):
    return {
        "payload": {
            "payment": {"entity": {"id": "pay_1", "order_id": order_id, "amount": 49900, "notes": {}}},
        }
    }


def test_order_fetch_failure_raises(db):
    payload = _payment_captured_without_notes()["payload"]
    rzp = MagicMock()
    rzp.order.fetch.side_effect = TimeoutError("razorpay 5xx")
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        with pytest.raises(razorpay_service.RazorpayTransientError):
            razorpay_service._handle_payment_captured(db, payload)


def test_order_fetch_success_not_topup_is_ignored(db):
    """A genuine non-topup (fetched, purpose absent) is still ack'd, not raised."""
    payload = _payment_captured_without_notes()["payload"]
    rzp = MagicMock()
    rzp.order.fetch.return_value = {"notes": {"purpose": "something_else"}}
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        result = razorpay_service._handle_payment_captured(db, payload)
    assert "ignored" in result.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_topup_fetch_failure.py -v`
Expected: FAIL — `test_order_fetch_failure_raises` gets a normal `"...ignored (not a topup)"` return instead of an exception (and `RazorpayTransientError` may not exist yet).

- [ ] **Step 3: Add a transient-error type if one doesn't exist**

Check the top of `api/app/services/razorpay_service.py` for an existing retryable exception (there is `RazorpayBillingError`). Add a distinct transient type near it:

```python
class RazorpayTransientError(Exception):
    """A recoverable gateway/read failure — the webhook must be retried, not ack'd."""
```

Confirm the webhook route (`api/app/api/webhook_billing_routes.py`) returns 5xx (so Razorpay retries) when the handler raises. It already does for uncaught exceptions; verify by reading the route's try/except and ensure `RazorpayTransientError` is NOT caught-and-swallowed there.

- [ ] **Step 4: Raise on fetch failure**

In `_handle_payment_captured`, replace the swallowing `try/except` (lines ~1945-1950):

```python
    order_id_for_notes = (pay_entity or {}).get("order_id")
    if not notes and order_id_for_notes:
        try:
            fetched_order = _get_razorpay().order.fetch(order_id_for_notes)
            notes = (fetched_order or {}).get("notes") or {}
        except Exception as exc:
            # Finding C: we do NOT know whether this was a top-up. Swallowing here
            # acked the event and burned the dedup row, permanently losing a paid
            # top-up. Raise so the event dead-letters and Razorpay retries; the
            # Invoice/credit idempotency below makes the eventual success a no-op.
            logger.warning(
                "order.fetch failed for %s; raising to force webhook retry: %s",
                order_id_for_notes,
                exc,
            )
            raise RazorpayTransientError(
                f"could not fetch order {order_id_for_notes} for top-up notes"
            ) from exc
```

- [ ] **Step 5: Confirm the dedup row is not committed on raise**

Read `api/app/api/webhook_billing_routes.py` around the `handle_webhook_event` call: on exception the route must NOT `session.commit()` (so the `processed_webhooks` INSERT rolls back and the retry re-processes). Verify the commit is only reached on the success path; if the `_record_or_skip_event` INSERT is committed in a separate transaction before dispatch, that is a latent second bug — note it and gate the commit behind successful dispatch. Add a regression test asserting no `ProcessedWebhook` row persists after a raise if this path is reachable in tests.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_topup_fetch_failure.py tests/test_webhook_billing_routes.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd api
git add app/services/razorpay_service.py tests/test_topup_fetch_failure.py
git commit -m "fix(billing): raise (retry) instead of acking a top-up when order.fetch fails (finding C)"
```

---

## Phase 3: Plan-price ↔ Razorpay resync (finding B)

**Files:**
- Modify: `api/app/api/superadmin_plan_routes.py` (`update_plan`, ~line 245)
- Modify: `api/app/services/razorpay_service.py` (base charge path, add a reconciliation guard mirroring `resolve_discounted_plan`, ~line 320-393)
- Test: `api/tests/test_plan_price_resync.py` (create)

**Fix intent (two layers):** (1) block checkout when the live Razorpay plan amount ≠ the DB amount — the exact guard the *discounted* path already has at `resolve_discounted_plan` (~line 476); (2) on a price edit, refuse to silently diverge — require a matching new `razorpay_plan_id_*` or auto-mint one.

### Task 4: Reconcile the base charge path against the DB price

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_plan_price_resync.py`:

```python
"""Finding B: after a plan price edit that does not resync the Razorpay plan,
the base (full-price) charge path must NOT silently bill the stale amount.
It should raise so we never charge != displayed."""
from unittest.mock import MagicMock, patch

import pytest

from app.db.models import Client, Plan
from app.services import razorpay_service


def _plan(db, monthly=459900, rzp_id="plan_STALE") -> Plan:
    p = Plan(
        name="Standard", slug="standard", monthly_price_cents=monthly, annual_price_cents=monthly * 10,
        currency="INR", razorpay_plan_id_monthly=rzp_id, is_active=True,
    )
    db.add(p)
    db.flush()
    return p


def test_base_charge_blocks_on_amount_drift(db):
    client = Client(email="b@test.local", hashed_password="x", api_key="k-b")
    db.add(client); db.flush()
    plan = _plan(db, monthly=559900)  # DB says ₹5,599...
    rzp = MagicMock()
    rzp.plan.fetch.return_value = {"item": {"amount": 459900}}  # ...Razorpay still ₹4,599
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        with pytest.raises(razorpay_service.RazorpayBillingError):
            razorpay_service.create_subscription(db, client, plan, "monthly")
```

> Adjust `create_subscription`'s signature/kwargs to match the real one (read `razorpay_service.py:~300-393`). The assertion that matters: **drift → raise**, no `subscription.create` call.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_plan_price_resync.py -v`
Expected: FAIL — subscription is created against the stale plan id with no amount check.

- [ ] **Step 3: Add the reconciliation guard to the base path**

In `razorpay_service.py`, in the full-price branch (after selecting `razorpay_plan_id` at ~line 320, before `rzp.subscription.create`), mirror the discounted path's check:

```python
    # Finding B: Razorpay plans are immutable; a DB price edit that didn't
    # re-mint the plan makes "displayed != charged". Reconcile the live plan
    # amount against the DB price before charging — same guard the discounted
    # path already applies (see resolve_discounted_plan). Fail closed.
    expected_paise = plan.annual_price_cents if billing_cycle == "annual" else plan.monthly_price_cents
    try:
        live = _get_razorpay().plan.fetch(razorpay_plan_id)
        live_paise = int((live.get("item") or {}).get("amount") or 0)
    except Exception as exc:
        raise RazorpayBillingError("Could not verify plan price with Razorpay.") from exc
    if live_paise != int(expected_paise):
        logger.error(
            "Plan %s price drift: DB=%s Razorpay=%s (plan_id=%s) — refusing to charge",
            plan.slug, expected_paise, live_paise, razorpay_plan_id,
        )
        raise RazorpayBillingError(
            "This plan's price is being updated. Please try again shortly."
        )
```

- [ ] **Step 4: Make `update_plan` resync (or refuse) on a price change**

In `api/app/api/superadmin_plan_routes.py`, `update_plan`, detect a price-field change and re-mint the Razorpay plan in the same transaction. After computing `update_data` (line ~252), before the setattr loop:

```python
        _PRICE_FIELDS = {"monthly_price_cents": "razorpay_plan_id_monthly",
                         "annual_price_cents": "razorpay_plan_id_annual"}
        for price_field, id_field in _PRICE_FIELDS.items():
            new_price = update_data.get(price_field)
            # Only act when the price actually changes and the caller did not
            # also supply a matching new Razorpay plan id.
            if new_price is not None and int(new_price) != int(getattr(plan, price_field) or 0) \
                    and id_field not in update_data:
                from app.services import razorpay_service
                cycle = "annual" if price_field.startswith("annual") else "monthly"
                new_rzp_id = razorpay_service.create_plan_for_price(
                    name=f"{plan.name} ({cycle})",
                    amount_paise=int(new_price),
                    period="yearly" if cycle == "annual" else "monthly",
                    currency=plan.currency or "INR",
                )
                update_data[id_field] = new_rzp_id
                logger.info("Plan %s %s price → %s; minted Razorpay plan %s",
                            plan.id, cycle, new_price, new_rzp_id)
```

- [ ] **Step 5: Add the `create_plan_for_price` helper**

In `razorpay_service.py`, add (reuse the same `rzp.plan.create` shape `resolve_discounted_plan` uses at ~line 482):

```python
def create_plan_for_price(*, name: str, amount_paise: int, period: str, currency: str = "INR") -> str:
    """Mint a fresh immutable Razorpay plan at a given amount; return its id."""
    if amount_paise <= 0:
        raise ValueError("amount_paise must be positive")
    rzp = _get_razorpay()
    try:
        plan = rzp.plan.create(data={
            "period": period, "interval": 1,
            "item": {"name": name[:255], "amount": int(amount_paise), "currency": currency},
        })
    except Exception as exc:
        raise RazorpayBillingError("Could not create Razorpay plan for new price.") from exc
    return plan["id"]
```

- [ ] **Step 6: Test the resync path**

Add to `tests/test_plan_price_resync.py`:

```python
def test_update_plan_mints_new_rzp_plan_on_price_change(db, monkeypatch):
    from app.api import superadmin_plan_routes as spr
    plan = _plan(db, monthly=459900, rzp_id="plan_OLD"); db.commit()
    minted = {}
    def fake_create(*, name, amount_paise, period, currency="INR"):
        minted["amount"] = amount_paise; return "plan_NEW"
    monkeypatch.setattr("app.services.razorpay_service.create_plan_for_price", fake_create)
    # call update_plan via its service path or a TestClient with superadmin auth
    # asserting plan.razorpay_plan_id_monthly == "plan_NEW" and minted["amount"] == 559900
```

Flesh this out using the superadmin auth override pattern in `tests/test_superadmin_plans.py`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_plan_price_resync.py tests/test_plan_price_reconciliation.py tests/test_discounted_plan_cache.py tests/test_superadmin_plans.py -v`
Expected: PASS (existing reconciliation/cache suites still green).

- [ ] **Step 8: Commit**

```bash
cd api
git add app/api/superadmin_plan_routes.py app/services/razorpay_service.py tests/test_plan_price_resync.py
git commit -m "fix(billing): resync Razorpay plan on price edit + reconcile base charge path (finding B)"
```

---

## Phase 4: Invoice dating from the payment instant (finding G)

**Files:**
- Modify: `api/app/services/invoice_service.py` (`finalize_invoice`, line ~165)
- Modify: `api/app/services/razorpay_service.py` (set `paid_at` from the Razorpay capture timestamp, ~line 1669 area — the seat/charge invoice creation)
- Test: `api/tests/test_invoice_dating.py` (create)

**Reframed fix (per verification):** finalize currently dates from `now()`; in the synchronous path `paid_at ≈ now()`, so the visible bug is small *today*. The durable fix is to (a) date the document and FY serial from `invoice.paid_at` (fallback `period_end`, then now), and (b) set `paid_at` from Razorpay's actual capture time (`payment.entity.created_at`, epoch seconds) rather than webhook-processing time — so a 31-Mar-23:59 IST capture processed after midnight still numbers in FY 25-26.

### Task 5: Date the invoice from `paid_at`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_invoice_dating.py`:

```python
"""Finding G: finalize_invoice must derive the document date and FY serial from
paid_at (the real capture instant), not the wall-clock at finalize time."""
from datetime import UTC, datetime

from app.db.models import Client, Invoice
from app.services import invoice_service


def test_finalize_dates_from_paid_at(db, monkeypatch):
    # A payment captured 31-Mar-2026 18:30 UTC == 00:00 IST 1-Apr is edge-y;
    # use a clear case: paid in FY 25-26, finalized days later.
    client = Client(email="g@test.local", hashed_password="x", api_key="k-g",
                    billing_country="IN")
    db.add(client); db.flush()
    paid = datetime(2026, 3, 20, 10, 0, tzinfo=UTC)
    inv = Invoice(client_id=client.id, amount_cents=459900, currency="INR",
                  status="paid", paid_at=paid, description="Standard monthly")
    db.add(inv); db.flush()

    # Force "now" to a later FY so a now()-based impl would misfile.
    monkeypatch.setattr(invoice_service, "datetime", _FrozenNow(datetime(2026, 4, 5, 12, 0, tzinfo=UTC)))
    invoice_service.finalize_invoice(db, inv)  # or finalize_invoice_safely per real API

    assert inv.issued_at == paid
    # FY label for a 20-Mar-2026 IST supply is 25-26.
    assert "25-26" in inv.invoice_number


class _FrozenNow:
    """Minimal shim so `datetime.now(UTC)` in the module returns a fixed value."""
    def __init__(self, when): self._when = when
    def now(self, tz=None): return self._when
    UTC = UTC
    def __getattr__(self, k): return getattr(__import__("datetime").datetime, k)
```

> Match the real finalize entrypoint (`finalize_invoice` vs `finalize_invoice_safely`) and seller-profile gating — the test may need a configured seller fixture (see `tests/test_invoice_finalize.py` for the existing setup; reuse it rather than reinventing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_invoice_dating.py -v`
Expected: FAIL — `issued_at` equals the frozen "now" (Apr 5), not `paid`; FY serial is `26-27`.

- [ ] **Step 3: Derive `issued` from `paid_at`**

In `invoice_service.py`, replace line ~165:

```python
    # Finding G: date the document from the actual payment instant, not the
    # wall-clock at finalize. The FY serial bucket (allocate_invoice_number →
    # financial_year_label, IST) must follow the supply date so a month/FY
    # boundary charge lands in the correct GSTR-1 period with an in-sequence
    # serial. Fall back to period_end, then now, when paid_at is absent.
    issued = invoice.paid_at or getattr(invoice, "period_end", None) or datetime.now(UTC)
    if issued.tzinfo is None:
        issued = issued.replace(tzinfo=UTC)
```

Everything downstream already uses `issued` (`allocate_invoice_number(session, series_prefix, issued)` at line 199 and `invoice.issued_at = issued` at line 200), so no other change is needed here.

- [ ] **Step 4: Set `paid_at` from Razorpay's capture time**

In `razorpay_service.py`, at the invoice-building site(s) that currently set `paid_at=datetime.now(UTC)` (the `subscription.charged` / verify path around line 1669, and the top-up path), read the real capture timestamp from the payment entity:

```python
    # Razorpay stamps epoch-seconds `created_at` on the payment entity — the
    # true capture instant. Prefer it over webhook-processing now() so FY/period
    # dating (finding G) reflects when the money moved, not when we processed it.
    captured_epoch = (pay_entity or {}).get("created_at")
    paid_at = (
        datetime.fromtimestamp(int(captured_epoch), tz=UTC)
        if captured_epoch else datetime.now(UTC)
    )
```

Use `paid_at` wherever `paid_at=datetime.now(UTC)` was passed into the `Invoice(...)` constructor.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_invoice_dating.py tests/test_invoice_finalize.py tests/test_invoice_numbering.py tests/test_dates_and_webhook_ssrf.py -v`
Expected: PASS (numbering/finalize suites still green — allocation logic is unchanged, only the input instant moved).

- [ ] **Step 6: Commit**

```bash
cd api
git add app/services/invoice_service.py app/services/razorpay_service.py tests/test_invoice_dating.py
git commit -m "fix(billing): date invoices + FY serial from paid_at/capture time, not finalize now() (finding G)"
```

---

## Phase 5: Upgrade idempotency + rollover clamp (findings D + F)

**Files:**
- Modify: `api/app/api/subscription_routes.py` (`change-plan` upgrade branch, ~line 1108)
- Modify: `api/app/services/transition_service.py` (`execute_paid_upgrade` ~106; `apply_pending_proration` ~405)
- Modify: `api/app/services/razorpay_service.py` (activation handler ordering, ~line 1544)
- Test: `api/tests/test_upgrade_idempotency.py`, `api/tests/test_upgrade_rollover_clamp.py` (create)

### Task 6: D — guard against a duplicate pending upgrade

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_upgrade_idempotency.py`:

```python
"""Finding D: a sequential double-submit of an upgrade must not mint TWO
Razorpay subscriptions. The second call should return the existing pending
checkout instead of creating another."""
from unittest.mock import MagicMock, patch

from app.db.models import Client, Plan, Subscription
from app.services import transition_service


def _setup(db):
    client = Client(email="d@test.local", hashed_password="x", api_key="k-d"); db.add(client); db.flush()
    old = Plan(name="Starter", slug="starter", monthly_price_cents=179900, currency="INR",
               razorpay_plan_id_monthly="plan_starter", is_active=True)
    new = Plan(name="Standard", slug="standard", monthly_price_cents=459900, currency="INR",
               razorpay_plan_id_monthly="plan_standard", is_active=True)
    db.add_all([old, new]); db.flush()
    sub = Subscription(client_id=client.id, plan_id=old.id, status="active",
                       razorpay_subscription_id="sub_old")
    db.add(sub); db.flush()
    return client, sub, new


def test_second_upgrade_reuses_pending(db):
    client, sub, new = _setup(db)
    created = []
    def fake_create(session, c, plan, cycle, extra_notes=None):
        created.append(plan.id); return {"subscription_id": f"sub_new_{len(created)}"}
    with patch("app.services.razorpay_service.create_subscription", side_effect=fake_create):
        transition_service.execute_paid_upgrade(db, client, sub, new, "monthly"); db.commit()
        transition_service.execute_paid_upgrade(db, client, sub, new, "monthly"); db.commit()
    assert len(created) == 1, "second upgrade must not create a second Razorpay subscription"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_upgrade_idempotency.py -v`
Expected: FAIL — `len(created) == 2`.

- [ ] **Step 3: Persist a pending-upgrade marker and short-circuit**

In `transition_service.execute_paid_upgrade` (line ~150, before creating the new sub), look up an existing not-yet-activated upgrade sub for this client tagged with `prev_razorpay_subscription_id == sub.razorpay_subscription_id`:

```python
    from app.db.models import Subscription  # local import to avoid cycle
    existing_pending = session.scalars(
        select(Subscription).where(
            Subscription.client_id == client.id,
            Subscription.status.in_(("created", "authenticated", "pending")),
            Subscription.prev_razorpay_subscription_id == sub.razorpay_subscription_id,
        )
    ).first()
    if existing_pending is not None and existing_pending.razorpay_subscription_id:
        logger.info("Reusing pending upgrade checkout %s for client %s",
                    existing_pending.razorpay_subscription_id, client.id)
        return razorpay_service.checkout_payload_for(existing_pending)
```

> This requires a `prev_razorpay_subscription_id` column on `Subscription` and a way to rebuild the checkout payload for an existing sub. Read `create_subscription` to see whether the new sub row is persisted with `prev_razorpay_subscription_id` (the notes already carry it). If it is stored only in Razorpay notes, add the column + migration (off head `e1f2a3b4c5d6`) and set it when the new sub row is created. Add `checkout_payload_for(sub)` to `razorpay_service` returning the same dict shape `create_subscription` returns for an existing subscription id.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_upgrade_idempotency.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd api
git add app/services/transition_service.py app/services/razorpay_service.py \
  app/db/models.py alembic/versions/*prev_razorpay*.py tests/test_upgrade_idempotency.py
git commit -m "fix(billing): reuse pending upgrade checkout instead of minting duplicate subscription (finding D)"
```

### Task 7: F — clamp rollover credits to the live balance at activation

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_upgrade_rollover_clamp.py`:

```python
"""Finding F: rollover credits are snapshotted at click-time. If the customer
spends between click and activation, activation must re-grant only what was
actually left — not the stale click-time figure (which leaks credits)."""
from app.db.models import Client, Plan, Subscription
from app.services import credit_service, transition_service


def _mk(db):
    client = Client(email="f@test.local", hashed_password="x", api_key="k-f"); db.add(client); db.flush()
    old = Plan(name="Starter", slug="starter", monthly_price_cents=179900, currency="INR", is_active=True)
    new = Plan(name="Standard", slug="standard", monthly_price_cents=459900, currency="INR", is_active=True)
    db.add_all([old, new]); db.flush()
    # 5000 plan credits live at click time.
    credit_service.grant_plan_credits(db, client.id, 5000)
    old_sub = Subscription(client_id=client.id, plan_id=old.id, status="active",
                           razorpay_subscription_id="sub_old", upgrade_credit_pending_cents=5000)
    new_sub = Subscription(client_id=client.id, plan_id=new.id, status="active",
                           razorpay_subscription_id="sub_new")
    db.add_all([old_sub, new_sub]); db.flush()
    return client, old_sub, new_sub


def test_rollover_clamped_to_live_remaining(db):
    client, old_sub, new_sub = _mk(db)
    # Customer spends 2000 between click and activation → only 3000 remain live.
    credit_service.check_and_deduct(db, client.id, 2000, reason="ai_chat", reference_id=1)
    db.flush()
    # Simulate activation: capture live remaining BEFORE reset, then apply.
    applied = transition_service.apply_pending_proration(
        db, new_sub, prev_razorpay_subscription_id="sub_old",
        live_remaining=credit_service.remaining_plan_credits(db, client.id),
    )
    assert applied == 3000, "must clamp to the 3000 actually remaining, not the 5000 snapshot"
```

> Confirm `grant_plan_credits`/`remaining_plan_credits` signatures against `credit_service.py` before running (both are real functions in that module; `grant_plan_credits(session, client_id, amount, ...)` is shown verbatim earlier in this plan).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_upgrade_rollover_clamp.py -v`
Expected: FAIL — `apply_pending_proration` doesn't accept `live_remaining` and grants the full 5000.

- [ ] **Step 3: Capture live remaining at activation and clamp**

In `razorpay_service._handle_subscription_activated` (ordering around line 1544-1551), capture the old scope's live remaining **before** `_grant_subscription_period` runs `reset_monthly_plan_credits`:

```python
    # Finding F: reset (below) zeroes the old plan's remaining credits, so read
    # the live remaining NOW and clamp the click-time rollover to it — the
    # customer only keeps what they hadn't already spent.
    from app.services.credit_service import remaining_plan_credits
    live_remaining_before_reset = remaining_plan_credits(session, local.client_id)
```

Then pass it through:

```python
    transition_service.apply_pending_proration(
        session, local, prev_razorpay_subscription_id, live_remaining=live_remaining_before_reset
    )
```

- [ ] **Step 4: Clamp inside `apply_pending_proration`**

In `transition_service.apply_pending_proration` (line ~430), add the parameter and clamp:

```python
def apply_pending_proration(
    session: Session,
    new_sub: Subscription,
    prev_razorpay_subscription_id: str | None,
    live_remaining: int | None = None,
) -> int:
    ...
    credit_amount = int(old_sub.upgrade_credit_pending_cents)
    if live_remaining is not None:
        # Never re-grant more than the customer actually had left at activation.
        credit_amount = max(0, min(credit_amount, int(live_remaining)))
    old_sub.upgrade_credit_pending_cents = 0
    session.flush()
    if credit_amount <= 0:
        return 0
    credit_service.grant_topup(...)  # unchanged, using clamped credit_amount
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_upgrade_rollover_clamp.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd api
git add app/services/transition_service.py app/services/razorpay_service.py tests/test_upgrade_rollover_clamp.py
git commit -m "fix(billing): clamp upgrade rollover credits to live balance at activation (finding F)"
```

### Phase 5 gate

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest tests/ -k "upgrade or transition or subscription" -q
```

---

## Phase 6: Operator seats — entitle only after the mandate is authorized, and invoice seat revenue (finding A)

> **Highest $-impact finding.** Largest change: it needs a new column + migration, a dedicated seat webhook handler, a route change, and a frontend change to open the returned checkout. Treat this as its own sub-project. Design section first, then tasks.

**The bug (all three parts CONFIRMED):**
1. `change_seat_count` bumps `sub.operator_quantity` immediately and discards the seat checkout payload → seats work before the mandate is authorized → **free seats**.
2. Seat `subscription.*` events are `return`ed before dispatch (`razorpay_service.py:996-1005`) → a paid seat charge creates **no Invoice / no GST document**.
3. There is no `/seats/verify` route and no gating on the seat sub's `activated` webhook.

**Design (mirrors the main-plan re-auth model):**
- Add `Subscription.seat_addon_pending_quantity` (int, nullable) — the desired extra-seat count awaiting authorization.
- On a seat **increase from zero authorized seats** (first purchase, or any increase where the seat sub isn't yet active): create/edit the seat sub, store the desired count in `seat_addon_pending_quantity`, **return the checkout payload**, and do **not** move `operator_quantity`.
- Add a dedicated seat webhook handler (do not fully drop seat events): on seat `subscription.activated`/`subscription.charged`, set `operator_quantity = included + seat_addon_quantity`, clear `seat_addon_pending_quantity`, and — on `charged` — create a payment-history `Invoice` for the seat charge (no credit grant) so seat revenue is documented for GST/reconciliation.
- Seat **decreases** and edits on an **already-active** seat sub keep the immediate local mirror update (the mandate already exists).

### Task 8: A1 — schema for pending seat quantity

- [ ] **Step 1: Add the column to the model**

In `api/app/db/models.py`, on `Subscription`, add near `seat_addon_quantity`:

```python
    seat_addon_pending_quantity = Column(Integer, nullable=True)  # awaiting mandate auth (finding A)
```

- [ ] **Step 2: Migration off the current head**

Create `api/alembic/versions/f7a8b9c0d1e2_seat_pending_quantity.py`:

```python
"""subscription: seat_addon_pending_quantity (finding A)

Revision ID: f7a8b9c0d1e2
Revises: e1f2a3b4c5d6
Create Date: 2026-07-11
"""
from collections.abc import Sequence
import sqlalchemy as sa
from alembic import op

revision: str = "f7a8b9c0d1e2"
down_revision: str | Sequence[str] | None = "e1f2a3b4c5d6"  # chain after Phase 1's index
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("subscriptions", sa.Column("seat_addon_pending_quantity", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("subscriptions", "seat_addon_pending_quantity")
```

> Confirm the table name is `subscriptions` (read `Subscription.__tablename__`). If Phase 5 added a `prev_razorpay_subscription_id` migration, chain `down_revision` after whichever revision is head — run `uv run alembic heads` first.

- [ ] **Step 3: Commit the schema step**

```bash
cd api
git add app/db/models.py alembic/versions/f7a8b9c0d1e2_seat_pending_quantity.py
git commit -m "feat(billing): add seat_addon_pending_quantity column (finding A groundwork)"
```

### Task 9: A2 — gate seat entitlement on the activation webhook

**Files:**
- Modify: `api/app/api/subscription_routes.py` (`change_seat_count`, ~line 1471-1492)
- Modify: `api/app/services/razorpay_service.py` (`edit_seat_addon_quantity` return value; webhook dispatch ~996; new `_handle_seat_addon_event`)
- Test: `api/tests/test_seat_entitlement_gating.py` (create)

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_seat_entitlement_gating.py`:

```python
"""Finding A: a first seat purchase must NOT bump operator_quantity until the
seat sub's activation webhook confirms the mandate; it must return a checkout
payload; and a seat charge must produce an Invoice."""
from unittest.mock import MagicMock, patch

from app.db.models import Client, Plan, Subscription, Invoice
from app.services import razorpay_service
from sqlalchemy import select


def _sub(db, included=1):
    client = Client(email="a@test.local", hashed_password="x", api_key="k-a", name="A"); db.add(client); db.flush()
    plan = Plan(name="Standard", slug="standard", monthly_price_cents=459900, currency="INR",
                included_operator_seats=included, extra_seat_price_cents=49900, is_active=True); db.add(plan); db.flush()
    sub = Subscription(client_id=client.id, plan_id=plan.id, status="active",
                       operator_quantity=included, razorpay_subscription_id="sub_main"); db.add(sub); db.flush()
    return client, sub


def test_first_seat_purchase_does_not_entitle_until_webhook(db):
    client, sub = _sub(db)
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_seat"}
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        payload = razorpay_service.edit_seat_addon_quantity(db, sub, extra_seats=2)
    # operator_quantity unchanged; pending recorded; checkout returned.
    assert sub.operator_quantity == 1
    assert sub.seat_addon_pending_quantity == 2
    assert payload and payload["subscription_id"] == "sub_seat"


def test_seat_activation_webhook_entitles(db):
    client, sub = _sub(db)
    sub.seat_addon_subscription_id = "sub_seat"
    sub.seat_addon_pending_quantity = 2
    sub.seat_addon_quantity = 2
    db.flush()
    event = {"event": "subscription.activated",
             "payload": {"subscription": {"entity": {"id": "sub_seat",
                        "notes": {"purpose": "seat_addon"}}}}}
    razorpay_service.handle_webhook_event(db, event, event_id="evt_seat_act")
    assert sub.operator_quantity == 3  # 1 included + 2 seats, now authorized
    assert sub.seat_addon_pending_quantity is None


def test_seat_charge_creates_invoice(db):
    client, sub = _sub(db)
    sub.seat_addon_subscription_id = "sub_seat"; sub.seat_addon_quantity = 2; db.flush()
    event = {"event": "subscription.charged",
             "payload": {"subscription": {"entity": {"id": "sub_seat", "notes": {"purpose": "seat_addon"}}},
                         "payment": {"entity": {"id": "pay_seat", "amount": 99800, "created_at": 1_780_000_000}}}}
    razorpay_service.handle_webhook_event(db, event, event_id="evt_seat_chg")
    inv = db.scalars(select(Invoice).where(Invoice.razorpay_payment_id == "pay_seat")).first()
    assert inv is not None and inv.amount_cents == 99800
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_seat_entitlement_gating.py -v`
Expected: FAIL — `edit_seat_addon_quantity` returns `None`, seat events are dropped before dispatch, no invoice.

- [ ] **Step 3: Return the checkout payload + record pending on first purchase**

In `razorpay_service.edit_seat_addon_quantity` (line ~576), change the signature to `-> dict | None` and, on the first-purchase branch (no `seat_addon_subscription_id`), record pending and return the checkout dict instead of `None`:

```python
    rzp = _get_razorpay()
    if not sub.seat_addon_subscription_id:
        addon = create_seat_addon_subscription(session, sub.client, extra_seats=extra_seats)
        sub.seat_addon_subscription_id = addon["subscription_id"]
        sub.seat_addon_quantity = extra_seats
        # Finding A: do NOT entitle yet — the mandate isn't authorized. Stash
        # the desired count; the seat activation webhook promotes it.
        sub.seat_addon_pending_quantity = extra_seats
        session.flush()
        return addon  # frontend opens this checkout
    # Existing active seat sub → mandate already authorized; edit in place.
    try:
        rzp.subscription.edit(sub.seat_addon_subscription_id,
                              data={"quantity": extra_seats, "schedule_change_at": "now"})
    except Exception as exc:
        logger.exception("Razorpay seat edit failed for %s: %s", sub.seat_addon_subscription_id, exc)
        raise RazorpayBillingError("Could not update seat add-on with Razorpay.") from exc
    sub.seat_addon_quantity = extra_seats
    session.flush()
    return None  # no new authorization required
```

- [ ] **Step 4: Update `change_seat_count` to honor the pending gate**

In `subscription_routes.py` (line ~1471-1492), branch on the return value:

```python
        try:
            from app.services import razorpay_service
            checkout = razorpay_service.edit_seat_addon_quantity(session, sub, extra_seats)
        except razorpay_service.RazorpayBillingError as exc:
            logger.exception("Seat add-on update failed for client %s: %s", client.id, exc)
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if checkout is not None:
            # First-time authorization required — DO NOT entitle yet (finding A).
            session.commit()
            return {"message": "Authorize the seat add-on to activate.",
                    "requires_authorization": True, "checkout": checkout,
                    "pending_seats": extra_seats}

        # Existing mandate (edit/decrease) → safe to update the local mirror now.
        sub.operator_quantity = new_total
        session.commit()
        return {"message": "Seats updated.", "total_seats": new_total, "extra_seats": extra_seats,
                "operator_quantity": new_total, "included_operator_seats": floor,
                "extra_seat_price_cents": int(plan.extra_seat_price_cents or 0), "currency": plan.currency}
```

- [ ] **Step 5: Add the dedicated seat webhook handler**

In `razorpay_service.py`, replace the blanket seat early-return (lines ~996-1005) with a routed handler:

```python
    if event_name.startswith("subscription."):
        sub_entity = _extract_subscription_entity(payload) or {}
        sub_notes = sub_entity.get("notes") or {}
        if (sub_notes.get("purpose") or "").lower() == "seat_addon":
            return _handle_seat_addon_event(session, event_name, payload, sub_entity)
```

Add the handler:

```python
def _handle_seat_addon_event(session, event_name, payload, sub_entity) -> str:
    """Seat add-on lifecycle. Unlike plan events these grant NO credits, but they
    DO gate seat entitlement (finding A) and must produce an Invoice on charge."""
    seat_sub_id = sub_entity.get("id")
    local = session.scalars(
        select(Subscription).where(Subscription.seat_addon_subscription_id == seat_sub_id)
    ).first()
    if local is None:
        logger.warning("Seat event %s for unknown seat sub %s", event_name, seat_sub_id)
        return f"Seat add-on event {event_name} (no local sub)"

    if event_name in ("subscription.activated", "subscription.charged"):
        included = int((local.plan.included_operator_seats if local.plan else 1) or 1)
        local.operator_quantity = included + int(local.seat_addon_quantity or 0)
        local.seat_addon_pending_quantity = None  # authorized

    if event_name == "subscription.charged":
        _record_seat_invoice(session, local, payload)  # payment-history invoice, no credits

    if event_name in ("subscription.cancelled", "subscription.completed"):
        included = int((local.plan.included_operator_seats if local.plan else 1) or 1)
        local.operator_quantity = included
        local.seat_addon_quantity = 0
        local.seat_addon_pending_quantity = None

    session.flush()
    return f"Seat add-on event {event_name} handled"
```

- [ ] **Step 6: Emit the seat Invoice (no credit grant)**

Add `_record_seat_invoice` mirroring the top-up invoice insert in `_handle_payment_captured` (idempotent on `razorpay_payment_id`), but with `description="Operator seat add-on"`, `paid_at` from `payment.entity.created_at` (finding G helper), and **no** `credit_service` call. Route it through `finalize_invoice_safely` so it gets a numbered GST document.

```python
def _record_seat_invoice(session, sub, payload) -> None:
    pay = (payload.get("payment") or {}).get("entity") or {}
    rzp_payment_id = pay.get("id")
    if not rzp_payment_id:
        return
    existing = session.scalars(select(Invoice).where(Invoice.razorpay_payment_id == rzp_payment_id)).first()
    if existing:
        return
    captured = pay.get("created_at")
    paid_at = datetime.fromtimestamp(int(captured), tz=UTC) if captured else datetime.now(UTC)
    inv = Invoice(
        client_id=sub.client_id, subscription_id=sub.id, amount_cents=int(pay.get("amount") or 0),
        currency=(pay.get("currency") or "INR").upper(), status="paid", paid_at=paid_at,
        razorpay_payment_id=rzp_payment_id, description="Operator seat add-on",
    )
    session.add(inv); session.flush()
    try:
        finalize_invoice_safely(session, inv)
    except Exception:
        logger.exception("Seat invoice finalize failed for payment %s (non-fatal)", rzp_payment_id)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/test_seat_entitlement_gating.py tests/test_subscription_seats.py tests/test_seat_addon_cutover.py tests/test_seat_addon_reconciliation.py -v`
Expected: PASS (existing seat suites still green; if any assert the old immediate-entitlement behaviour, update them to the gated model and note it in the commit).

- [ ] **Step 8: Frontend — open the returned checkout**

In `app/src/pages/Billing.jsx` (seat control) and any seat modal, when the `POST /seats` response has `requires_authorization: true`, call `new Razorpay(response.checkout)` / open `checkout.short_url` and only reflect the new seat count after the success callback / a fresh `GET` shows it. Do not optimistically show the new seat count. Run `cd app && npm run lint && npm run build`.

- [ ] **Step 9: Commit**

```bash
cd api
git add app/api/subscription_routes.py app/services/razorpay_service.py tests/test_seat_entitlement_gating.py
git commit -m "fix(billing): gate seat entitlement on mandate auth + invoice seat revenue (finding A)"
cd ../ && git add app/src/pages/Billing.jsx
git commit -m "fix(billing-ui): open seat add-on checkout; don't show seats before authorization (finding A)"
```

### Phase 6 gate

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest tests/ -k "seat" -q
cd ../app && npm run lint && npm run build
```

---

## Final verification (all phases)

- [ ] **Backend full suite + lint/format**

```bash
cd api
uv run ruff check .
uv run ruff format --check .
uv run alembic heads      # exactly ONE head
uv run pytest tests/ -q   # full billing + regression suite green
```

- [ ] **Frontend (only if Phase 6 touched it)**

```bash
cd app && npm run lint && npm run build
```

- [ ] **Migration dry-run against a scratch DB**

```bash
cd api && uv run alembic upgrade head && uv run alembic downgrade -3 && uv run alembic upgrade head
```
Expected: clean up/down/up (the three new migrations are reversible).

- [ ] **Report** in the final message: `ruff ✓ · format ✓ · pytest ✓ · alembic single-head ✓` (+ `npm lint ✓ · build ✓` if the UI changed), and the list of findings closed (E, H, C, B, G, D, F, A).

---

## Deferred (out of scope for this plan — track separately)

The review's remaining Medium/Low items are real but lower blast-radius; batch them after the High tranche:
- **I** — defer gateway cancel of a superseded sub to after commit (`razorpay_service.py:~1423`).
- **N** — stable first-period key when `activated` lacks `current_end`.
- **K** — MRR double-counts seats (`superadmin_plan_routes.py:~455`).
- **L** — DB/ORM guard making finalized invoices truly immutable.
- **M** — Rule 46 PDF gaps (export-without-LUT endorsement, POS state name, high-value B2C name/address).
- **J** — per-plan / per-currency seat price resolution.
- **§5 Low batch** — `Field(ge=0)` on prices, seat delta ceiling, fail-closed `RAZORPAY_SEAT_PLAN_ID`, cancel `"cancelled"` spelling, frontend USD fallback-rate unification, delete orphan `app/src/pages/Subscription.jsx`.

**Cross-border / USD (Phase-2 launch blockers, per the CA review):** do NOT flip `INTL_PAYMENTS_ENABLED` until the export forex-realisation condition, Rule-34 notified FX rate, and LUT lifecycle gaps are closed — separate plan.
