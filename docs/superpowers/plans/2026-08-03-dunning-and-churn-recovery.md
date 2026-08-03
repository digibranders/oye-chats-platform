# Dunning & Involuntary-Churn Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer's recurring payment fails, tell them — by email and in-app — and give them a working one-click path back to paying, before the 7-day grace window silently expires their plan.

**Architecture:** Razorpay already retries the charge and hosts a card-update page; it does **not** need us to mint a new subscription (unlike `/resume`). So this plan adds the layer Razorpay cannot: OyeChats-branded, product-aware messaging ("your agents stop responding in 2 days") plus an in-app banner, both pointing at Razorpay's hosted recovery link. The email cadence mirrors the existing trial-reminder cron exactly, including its JSONB idempotency marker.

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · ARQ/Redis cron · Brevo email · React 19 + TypeScript · pytest

**Depends on:** Phase 0 of `2026-08-03-payments-and-invoicing-system.md` (merged). Independent of Phases 1–2 and of Plan C.

---

## 1. Why this is the highest-value remaining work

Involuntary churn — customers who *want* to stay but whose payment failed — is recoverable revenue. Today OyeChats recovers none of it, because it tells the customer nothing.

Verified current behaviour:

| Event | What happens | What the customer sees |
|---|---|---|
| `payment.failed` | `_handle_payment_failed` logs a warning and returns. No DB change. | **Nothing** |
| `subscription.pending` | `_enter_past_due` → `status='past_due'`, `past_due_since` stamped | **Nothing** |
| `subscription.halted` | Same, plus `_revoke_unpaid_activation_grant` | **Nothing** |
| 7 days later | `task_expire_past_due_subscriptions` → `status='expired'`, `cancel_reason='dunning_grace_elapsed'` | Their agents stop working |

The only trace of `past_due` anywhere in the frontend is a badge colour (`billingModel.ts:311`). There is no banner, no email, no recovery CTA. The customer's first signal that anything was wrong is their chatbot going offline.

---

## 2. Research findings — and the one that changes the design

### 2.1 Razorpay retries before it halts

An auto-charge failure moves the subscription to **`pending`**, not straight to halted. Razorpay then retries — daily for cards; for eMandate and UPI, retries only begin after the bank confirms or rejects, which can take over 24h, and bank holidays shift the schedule. After roughly **3 retries over T+3 days** the subscription moves to **`halted`**.

**Design consequence:** do not shout on the first failure. At `pending` the charge may well succeed tomorrow with no customer action at all — an alarming "YOUR PAYMENT FAILED" email on day 0 creates support load and anxiety for a problem that often self-resolves. Day 0 gets a calm heads-up; the urgent messaging starts at `halted`, when retries are genuinely exhausted.

### 2.2 A halted subscription recovers **without** a new subscription — this is the critical finding

Razorpay's documented recovery for a halted subscription: it emails the customer *"a link that the customer can use to change the card linked to the Subscription."* Through that hosted page the customer can **retry the same card, update the card, or switch to UPI or eMandate**, and on success the subscription *"moves back to the `active` state."* Merchants can also resend that link from the dashboard.

This is **materially different from `/resume`**. `/resume` mints a fresh Razorpay subscription because an at-cycle-end cancellation is irreversible at the gateway — there is nothing left to authorise. A halted subscription is still alive and still authorisable. Minting a second subscription here would be a **double-charge bug**: the customer authorises the new mandate while the old halted one is still recoverable.

> **The single most important rule in this plan: dunning recovery reuses the existing subscription's hosted link. It never mints a new one.**

This also refines decision D-1 in the master plan. D-1 said the instrument cannot be swapped on a live subscription — true for a *healthy* one. A **halted** subscription is exactly the case where Razorpay does support changing the instrument in place.

### 2.3 Razorpay already emails the customer — ours must complement, not duplicate

Razorpay sends customer notifications at 8 lifecycle stages, and the pending/halted ones carry the card-update CTA. We cannot assume they are off, and we should not send a second email that says the same thing in worse words.

Our emails add what Razorpay structurally cannot: **product consequence and deadline.** Razorpay knows nothing about the customer's agents, their conversation volume, or that OyeChats will suspend them on day 7. That is the entire value of our layer.

- [ ] **Confirm in the Razorpay dashboard which subscription notifications are enabled**, and whether they are merchant-branded. If Razorpay's halted email is on, our day-3 email must reference it ("we've also sent you a secure link from Razorpay") rather than compete with it.

### 2.4 A recovered subscription does not back-charge the missed cycle

Documented: once a subscription moves from `halted` back to `active`, *"the previous charges are not re-attempted. Only future payments are charged automatically."* Invoices for the halted period are still created but *"we will not charge these invoices. You will have to charge them manually."*

**Consequence:** every recovery leaks one billing cycle unless someone charges the outstanding invoice. At ₹949–₹1,399/month this is small per event but it is pure margin, and it compounds. Task 9 surfaces the outstanding amount to the super-admin rather than silently writing it off — the decision to chase it is commercial, not technical.

### 2.5 What the codebase already gives us

Three patterns exist and should be reused rather than reinvented:

- **`rebuild_upgrade_checkout`** (`razorpay_service.py:479`) already fetches a live subscription and returns its `short_url` — Razorpay's hosted page. It gates on `_AUTHORIZABLE_SUB_STATES = {"created", "authenticated", "pending"}`, which **excludes `halted`**. Task 2 addresses that gap deliberately rather than by widening the constant blindly.
- **`send_seat_reauth_email` / `send_downgrade_reauth_email`** (`email_service.py:982`, `:1016`) are re-auth emails with a `reauth_url` button. The new templates mirror them.
- **`task_trial_reminder_emails` + `_mark_email_sent`** (`worker/tasks.py`) is a day-bucketed cadence with a JSONB idempotency marker. The dunning cron is the same shape.

---

## 3. Architecture decisions

**A-1. Recovery link, never a new mandate.** `get_recovery_checkout` fetches the existing subscription's `short_url`. If Razorpay reports a state from which the subscription cannot be recovered, the endpoint says so explicitly and routes the customer to re-subscribe — it never silently mints.

**A-2. Cadence keyed on days in `past_due`, not on webhook arrival.** Webhooks can be replayed, delayed, or dead-lettered; `past_due_since` is a stable anchor already maintained idempotently by `_enter_past_due`. Same reasoning as the trial cron keying on `days_remaining`.

**A-3. Escalation matches Razorpay's retry reality (§2.1).**

| Day in past_due | Marker | Tone | Sent because |
|---|---|---|---|
| 0 | `failed_0` | Calm heads-up. "We'll retry automatically." No action asked. | Razorpay is still retrying; most of these self-resolve |
| 3 | `halted_3` | Action needed, with the recovery link | Retries exhausted; nothing happens without the customer |
| 5 | `warning_5` | Deadline. "Your agents stop responding in 2 days." | Last chance before suspension |
| on expiry | `suspended` | Service suspended, link still works | Fired by the expiry cron, not the cadence cron |

**A-4. In-app banner is not optional.** Email deliverability is imperfect and billing email may differ from the login email. The banner appears on every page for a `past_due` account, because a customer who never opens email still opens the product.

**A-5. Reuse `Subscription.trial_emails_sent`? No — separate column.** A dedicated `dunning_emails_sent` keeps the two lifecycles independent and lets a customer who churns and returns get a fresh dunning sequence without clearing their trial history.

---

## 4. File structure

- Create: `api/app/services/dunning_service.py` — recovery-link resolution + cadence decision. All logic, no I/O framing.
- Create: `api/alembic/versions/<rev>_subscription_dunning_emails_sent.py`
- Modify: `api/app/db/models.py` — `Subscription.dunning_emails_sent`
- Modify: `api/app/services/email_service.py` — 4 templates
- Modify: `api/app/services/notification_service.py` — `payment_failed` type + fix the stale billing link
- Modify: `api/app/api/subscription_routes.py` — `GET /subscriptions/payment-recovery`
- Modify: `api/app/services/razorpay_service.py` — notify on `pending` / `halted`
- Modify: `api/app/worker/tasks.py` + `settings.py` — `task_dunning_emails` cron
- Create: `app/src/features/workspace/billing/PastDueBanner.tsx`
- Modify: `app/src/shell/AppShell.tsx` — mount the banner
- Tests: `api/tests/test_dunning_cadence.py`, `test_dunning_recovery_link.py`, `test_dunning_cron.py`

`dunning_service` holds the decisions (which email is due, is this subscription recoverable); the cron and routes stay thin. Matches how `invoice_service` / `credit_service` are structured.

---

## 5. Tasks

### Task 1: `dunning_emails_sent` marker column

**Files:** `api/app/db/models.py`, new migration

- [ ] **Step 1: Add the column**

In `Subscription`, immediately after `trial_emails_sent`:

```python
    # Dunning cadence idempotency markers, mirroring ``trial_emails_sent``:
    # {"failed_0": "<iso ts>", "halted_3": ..., "warning_5": ..., "suspended": ...}.
    # Deliberately NOT reusing trial_emails_sent: the two lifecycles are
    # independent, and a customer who recovers, later churns, and returns must
    # get a fresh dunning sequence without their trial history being cleared.
    dunning_emails_sent = Column(JSONB, nullable=False, server_default="{}", default=dict)
```

- [ ] **Step 2: Generate the migration**

Run: `cd api && uv run alembic revision --autogenerate -m "subscription dunning emails sent"`

- [ ] **Step 3: Verify it is additive and reversible**

The file must contain exactly one `op.add_column` on `subscriptions` with `server_default="{}"` and `nullable=False` (so existing rows backfill to `{}` without a data migration), plus a matching `downgrade`.

```bash
cd api && uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head && uv run alembic heads
```
Expected: all succeed, single head.

- [ ] **Step 4: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/
git commit -m "feat(dunning): add subscriptions.dunning_emails_sent marker column"
```

---

### Task 2: Recovery-link resolution

**Files:** Create `api/app/services/dunning_service.py`; Test `api/tests/test_dunning_recovery_link.py`

- [ ] **Step 1: Write the failing test**

```python
"""Dunning recovery resolves the EXISTING subscription's hosted link.

It must never mint a new Razorpay subscription: a halted subscription is still
alive and recoverable, so a second mandate would double-charge a customer who
authorises it while the original is still rescuable.
"""

import pytest


class _FakeSubAPI:
    def __init__(self, entity=None, boom=False):
        self.entity = entity
        self.boom = boom
        self.created = []

    def fetch(self, sub_id):
        if self.boom:
            raise RuntimeError("gateway down")
        return self.entity

    def create(self, data):  # must never be called
        self.created.append(data)
        return {"id": "sub_NEW"}


class _FakeClient:
    def __init__(self, entity=None, boom=False):
        self.subscription = _FakeSubAPI(entity, boom)


@pytest.mark.parametrize("state", ["halted", "pending"])
def test_recoverable_states_return_the_hosted_link(monkeypatch, state):
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": state, "short_url": "https://rzp.io/i/abc"})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    result = svc.get_recovery_link("sub_1")

    assert result.recoverable is True
    assert result.url == "https://rzp.io/i/abc"
    assert result.gateway_status == state
    # The whole point: no new mandate.
    assert fake.subscription.created == []


@pytest.mark.parametrize("state", ["cancelled", "completed", "expired"])
def test_terminal_states_are_not_recoverable(monkeypatch, state):
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": state, "short_url": "https://rzp.io/i/abc"})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    result = svc.get_recovery_link("sub_1")

    assert result.recoverable is False
    assert result.url is None
    assert result.gateway_status == state


def test_active_subscription_is_not_recoverable(monkeypatch):
    """Nothing to recover -- and Razorpay cannot swap the instrument on a
    healthy active subscription anyway (master plan D-1)."""
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": "active", "short_url": "https://rzp.io/i/abc"})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    assert svc.get_recovery_link("sub_1").recoverable is False


def test_missing_short_url_is_not_recoverable(monkeypatch):
    """A recoverable state with no hosted link is useless to the customer --
    report it rather than emailing a button that goes nowhere."""
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": "halted", "short_url": None})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    result = svc.get_recovery_link("sub_1")
    assert result.recoverable is False
    assert result.url is None


def test_gateway_failure_raises_rather_than_reporting_unrecoverable(monkeypatch):
    """A transient fetch failure must not be reported as 'unrecoverable' -- that
    would tell a paying customer their subscription is dead."""
    from app.services import dunning_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient(boom=True))

    with pytest.raises(svc.DunningError):
        svc.get_recovery_link("sub_1")


def test_no_gateway_id_is_not_recoverable_without_calling_razorpay(monkeypatch):
    """Manually-granted subscriptions have no razorpay_subscription_id."""
    from app.services import dunning_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient(boom=True))
    result = svc.get_recovery_link(None)
    assert result.recoverable is False
    assert result.gateway_status is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_dunning_recovery_link.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.dunning_service'`

- [ ] **Step 3: Write the implementation**

Create `api/app/services/dunning_service.py`:

```python
"""Involuntary-churn recovery.

Razorpay retries a failed recurring charge (pending -> retries -> halted) and
hosts a page where the customer can retry the same instrument, swap the card,
or move to UPI/eMandate. On success the subscription returns to ``active``
WITHOUT a new subscription being created.

That is why this module only ever RESOLVES a link. It never mints a mandate.
``/resume`` mints one because an at-cycle-end cancellation is irreversible at
the gateway — there is nothing left to authorise. A halted subscription is
still alive, so minting here would leave two live mandates and double-charge a
customer who authorises the new one.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# States from which Razorpay's hosted page can still bring a subscription back
# to ``active``. ``active`` is excluded: there is nothing to recover, and the
# instrument on a healthy subscription cannot be swapped in place.
RECOVERABLE_GATEWAY_STATES = frozenset({"pending", "halted"})


class DunningError(RuntimeError):
    """The gateway could not be reached to resolve a recovery link."""


@dataclass(frozen=True)
class RecoveryLink:
    recoverable: bool
    url: str | None
    gateway_status: str | None


def _client():
    """Indirection so tests can substitute a fake without patching razorpay."""
    from app.services.razorpay_service import _get_razorpay

    return _get_razorpay()


def get_recovery_link(razorpay_subscription_id: str | None) -> RecoveryLink:
    """Resolve the hosted recovery page for a failing subscription.

    Raises ``DunningError`` on a gateway failure rather than returning
    ``recoverable=False`` — the two mean very different things to a customer,
    and reporting a transient timeout as "your subscription is dead" is worse
    than showing an error.
    """
    if not razorpay_subscription_id:
        # Manual/comped subscription — no gateway mandate exists to recover.
        return RecoveryLink(recoverable=False, url=None, gateway_status=None)

    try:
        entity = _client().subscription.fetch(razorpay_subscription_id) or {}
    except Exception as exc:  # noqa: BLE001 — normalised into our own error type
        logger.warning("dunning: could not fetch subscription %s: %s", razorpay_subscription_id, exc)
        raise DunningError("Could not reach the payment provider. Please try again.") from exc

    status = str(entity.get("status") or "").lower() or None
    url = entity.get("short_url") or None

    # A recoverable state with no hosted link is not actionable: emailing a
    # button that goes nowhere is worse than saying nothing.
    if status not in RECOVERABLE_GATEWAY_STATES or not url:
        return RecoveryLink(recoverable=False, url=None, gateway_status=status)

    return RecoveryLink(recoverable=True, url=url, gateway_status=status)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_dunning_recovery_link.py -v`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add api/app/services/dunning_service.py api/tests/test_dunning_recovery_link.py
git commit -m "feat(dunning): resolve Razorpay's hosted recovery link, never mint a mandate"
```

---

### Task 3: Cadence decision

**Files:** `api/app/services/dunning_service.py`; Test `api/tests/test_dunning_cadence.py`

- [ ] **Step 1: Write the failing test**

```python
"""Which dunning email is due, given days elapsed in past_due.

Day 0 is deliberately calm: Razorpay is still retrying and most of these
self-resolve without the customer doing anything. Urgency starts at day 3,
when retries are exhausted.
"""

import pytest

from app.services.dunning_service import DUNNING_CADENCE, due_email


@pytest.mark.parametrize(
    "days,expected",
    [(0, "failed_0"), (1, None), (2, None), (3, "halted_3"), (4, None), (5, "warning_5"), (6, None)],
)
def test_cadence_fires_only_on_its_own_day(days, expected):
    assert due_email(days, sent={}) == expected


def test_already_sent_marker_suppresses_resend():
    assert due_email(3, sent={"halted_3": "2026-08-01T00:00:00+00:00"}) is None


def test_other_markers_do_not_suppress_a_different_day():
    assert due_email(3, sent={"failed_0": "2026-08-01T00:00:00+00:00"}) == "halted_3"


def test_days_beyond_the_cadence_send_nothing():
    """Day 7+ is the expiry cron's suspension email, not the cadence cron's."""
    assert due_email(7, sent={}) is None
    assert due_email(30, sent={}) is None


def test_negative_days_send_nothing():
    """Clock skew or a future-stamped anchor must not fire day 0 repeatedly."""
    assert due_email(-1, sent={}) is None


def test_cadence_stays_inside_the_grace_window():
    """Every cadence day must land before PAYMENT_FAILED_GRACE_DAYS, or we would
    email a deadline that has already passed."""
    from app.config import PAYMENT_FAILED_GRACE_DAYS

    assert max(DUNNING_CADENCE) < PAYMENT_FAILED_GRACE_DAYS
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_dunning_cadence.py -v`
Expected: FAIL — `ImportError: cannot import name 'DUNNING_CADENCE'`

- [ ] **Step 3: Write the implementation**

Append to `api/app/services/dunning_service.py`:

```python
# Days elapsed in past_due -> marker key. Shaped around Razorpay's own retry
# behaviour: it retries roughly daily for T+3 days before halting, so day 0 is
# a calm heads-up ("we'll retry automatically") and the urgent messaging starts
# at day 3 when retries are genuinely exhausted. Every key must land strictly
# inside PAYMENT_FAILED_GRACE_DAYS or we would promise a deadline that has
# already passed — enforced by test.
DUNNING_CADENCE: dict[int, str] = {
    0: "failed_0",
    3: "halted_3",
    5: "warning_5",
}

# Sent by the expiry cron when the grace window elapses, not by the cadence.
SUSPENDED_MARKER = "suspended"


def due_email(days_in_past_due: int, sent: dict) -> str | None:
    """Marker key for the email due today, or None.

    Fires only on the exact day bucket — a missed cron tick means that email is
    skipped rather than sent late alongside the next one. That is deliberate:
    a day-3 "retries exhausted" email arriving on day 5 next to the deadline
    warning reads as spam and undermines both.
    """
    if days_in_past_due < 0:
        return None
    marker = DUNNING_CADENCE.get(days_in_past_due)
    if marker is None or (sent or {}).get(marker):
        return None
    return marker
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_dunning_cadence.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add api/app/services/dunning_service.py api/tests/test_dunning_cadence.py
git commit -m "feat(dunning): day-bucketed email cadence shaped around Razorpay retries"
```

---

### Task 4: Email templates

**Files:** `api/app/services/email_service.py`

- [ ] **Step 1: Add the four templates**

Mirror `send_seat_reauth_email` (`:1016`) exactly for structure, imports and error handling. Append after it:

```python
def send_payment_failed_email(to_email: str, *, name: str | None, plan_name: str, amount: str) -> None:
    """Day 0: the charge failed and Razorpay will retry automatically.

    Deliberately calm and asks for NOTHING. At this point the subscription is
    ``pending`` and Razorpay retries daily for ~3 days; most of these succeed
    on their own. An alarming email here creates support load for a problem
    that usually self-resolves.
    """
    inner = (
        h1("We couldn't process your payment")
        + p(
            f"Hi {_first_name(name)} — the {strong(amount)} charge for your {strong(plan_name)} plan "
            f"didn't go through. This is usually a temporary bank decline."
        )
        + ed.alert("We'll retry automatically over the next few days. You don't need to do anything yet.", "info")
        + p("If it keeps failing we'll email you a secure link to update your payment method.", top=8)
        + p(f"Questions? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    _send_dunning(to_email, "We couldn't process your payment — we'll retry", inner, event="payment_failed")


def send_payment_action_required_email(
    to_email: str, *, name: str | None, plan_name: str, amount: str, recovery_url: str, days_left: int
) -> None:
    """Day 3: retries are exhausted. Nothing happens without the customer."""
    inner = (
        h1("Action needed: update your payment method")
        + p(
            f"Hi {_first_name(name)} — we've tried the {strong(amount)} charge for your "
            f"{strong(plan_name)} plan several times and it hasn't gone through."
        )
        + ed.alert(
            f"Your AI agents keep working for another {days_left} days. After that they'll stop "
            f"responding to visitors until payment is restored.",
            "warning",
        )
        + p("Use the secure link below to retry your card, use a different one, or switch to UPI.")
        + button("Update payment method", recovery_url)
        + p(f"Questions? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    _send_dunning(to_email, "Action needed: update your payment method", inner, event="payment_action_required")


def send_payment_final_warning_email(
    to_email: str, *, name: str | None, plan_name: str, recovery_url: str, days_left: int
) -> None:
    """Day 5: the deadline is the message."""
    day_word = "day" if days_left == 1 else "days"
    inner = (
        h1(f"Your AI agents stop in {days_left} {day_word}")
        + p(
            f"Hi {_first_name(name)} — your {strong(plan_name)} payment is still outstanding. "
            f"In {strong(f'{days_left} {day_word}')} your agents will stop responding to visitors "
            f"and your chat widget will go into offline mode."
        )
        + ed.alert("This takes under a minute to fix and everything resumes immediately.", "warning")
        + button("Restore my subscription", recovery_url)
        + p(f"Need help? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    _send_dunning(to_email, f"Your AI agents stop in {days_left} {day_word}", inner, event="payment_final_warning")


def send_subscription_suspended_email(
    to_email: str, *, name: str | None, plan_name: str, recovery_url: str | None
) -> None:
    """Grace elapsed. Still recoverable — say so, and keep the door open."""
    action = (
        button("Restore my subscription", recovery_url)
        if recovery_url
        else p("Visit Billing in your workspace to restart your plan.", top=8)
    )
    inner = (
        h1("Your subscription has been suspended")
        + p(
            f"Hi {_first_name(name)} — we weren't able to collect payment for your "
            f"{strong(plan_name)} plan, so your agents have stopped responding to visitors."
        )
        + ed.alert("Your data, knowledge base and conversation history are all safe and untouched.", "info")
        + p("Restore payment and everything comes straight back.")
        + action
        + p(f"Need help? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    _send_dunning(to_email, "Your OyeChats subscription has been suspended", inner, event="subscription_suspended")


def _send_dunning(to_email: str, subject: str, inner: str, *, event: str) -> None:
    """Shared send + failure handling for the dunning family.

    Never raises: a Brevo outage must not break the cron loop and block every
    other customer's email. The cadence marker is only written by the CALLER on
    success, so a failed send is retried on the next matching day bucket.
    """
    try:
        send_email_async(
            to_email,
            subject,
            shell(subject=subject, preheader=subject, inner=inner),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s_email_failed for %s: %s", event, _redact(to_email), exc)
        _capture_email_failure(exc, event=event, email=to_email)
```

- [ ] **Step 2: Verify the helpers used above all exist with these names**

```bash
cd api && grep -nE "^def (h1|p|strong|button|shell|send_email_async|_first_name|_redact|_capture_email_failure)\b|^_SUPPORT_LINK|ed\.alert" app/services/email_service.py | head -20
```
Every symbol referenced must appear. If `ed.alert`'s signature differs, match the call in `send_seat_reauth_email` rather than inventing one.

- [ ] **Step 3: Render them into the email gallery and eyeball each**

The repo keeps rendered samples in `api/emails/gallery/`. Regenerate and open the four new files. A dunning email with a broken button is worse than no email.

- [ ] **Step 4: Lint and commit**

```bash
cd api && uv run ruff check app/services/email_service.py && uv run ruff format --check app/services/email_service.py
git add api/app/services/email_service.py api/emails/gallery/
git commit -m "feat(dunning): payment-failed, action-required, final-warning and suspended emails"
```

---

### Task 5: In-app notification + fix the stale billing link

**Files:** `api/app/services/notification_service.py`

- [ ] **Step 1: Fix the dead link**

`notify_plan_purchased` links to `/settings?tab=billing`, which **no longer exists** after the Admin 2.0 rebuild — the route is now `/workspace/billing` (`app/src/app/routes.tsx:138`). Fix it before adding a second notification next to a broken one:

```python
        link="/workspace/billing",
```

Then confirm no other stale links remain:

```bash
cd api && grep -rn '"/settings' app --include=*.py | grep -v __pycache__
```
Expected: no matches.

- [ ] **Step 2: Add the payment-failed type**

```python
TYPE_PAYMENT_FAILED = "payment_failed"
```

Add it to `KNOWN_TYPES`, then:

```python
def notify_payment_failed(
    session: Session,
    *,
    client_id: int,
    plan_name: str,
    days_left: int,
    recoverable: bool,
) -> dict[str, Any]:
    """In-app counterpart to the dunning emails.

    Email deliverability is imperfect and the billing email may differ from the
    login email — a customer who never opens email still opens the product.
    """
    day_word = "day" if days_left == 1 else "days"
    body = (
        f"We couldn't collect payment for {plan_name}. Your agents keep working for "
        f"{days_left} more {day_word}."
        if recoverable
        else f"We couldn't collect payment for {plan_name}. Update your billing details to continue."
    )
    return create_notification(
        session,
        client_id=client_id,
        type_=TYPE_PAYMENT_FAILED,
        title="Payment failed — action needed",
        body=body,
        link="/workspace/billing",
        data={"plan_name": plan_name, "days_left": days_left, "recoverable": recoverable},
    )
```

- [ ] **Step 3: Verify the frontend renders the new type**

```bash
grep -rn "plan_purchased\|crawl_completed" app/src/shell/NotificationCenter.tsx | head
```
If the component maps type → icon/colour, add `payment_failed` with a warning tone. An unmapped type must still render — check the fallback branch exists before assuming it does.

- [ ] **Step 4: Commit**

```bash
git add api/app/services/notification_service.py app/src/shell/
git commit -m "feat(dunning): in-app payment-failed notification; fix dead /settings billing link"
```

---

### Task 6: `GET /subscriptions/payment-recovery`

**Files:** `api/app/api/subscription_routes.py`

- [ ] **Step 1: Add the endpoint**

```python
@router.get("/payment-recovery")
def payment_recovery(client: Client = Depends(get_current_client), bot_id: int | None = None):
    """Recovery state + hosted link for a failing subscription.

    Drives the past-due banner and its CTA. Read-only and safe to poll: it
    resolves Razorpay's existing hosted page and never mutates anything, in
    particular never minting a second mandate (see dunning_service).
    """
    from app.config import PAYMENT_FAILED_GRACE_DAYS
    from app.services.dunning_service import DunningError, get_recovery_link

    with get_session() as session:
        sub = _resolve_target_subscription(session, client.id, bot_id)
        if sub is None or sub.status != "past_due":
            return {"past_due": False, "recoverable": False, "recovery_url": None, "days_left": None}

        days_left = None
        if sub.past_due_since is not None:
            since = sub.past_due_since
            if since.tzinfo is None:
                since = since.replace(tzinfo=UTC)
            elapsed = (datetime.now(UTC) - since).days
            days_left = max(0, PAYMENT_FAILED_GRACE_DAYS - elapsed)

        try:
            link = get_recovery_link(sub.razorpay_subscription_id)
        except DunningError:
            # Gateway hiccup: still tell the customer they are past due — that
            # part is true and locally known — but don't claim their
            # subscription is unrecoverable.
            return {
                "past_due": True,
                "recoverable": None,
                "recovery_url": None,
                "days_left": days_left,
                "plan_name": sub.plan.name if sub.plan else None,
            }

        return {
            "past_due": True,
            "recoverable": link.recoverable,
            "recovery_url": link.url,
            "days_left": days_left,
            "plan_name": sub.plan.name if sub.plan else None,
        }
```

- [ ] **Step 2: Verify `_resolve_target_subscription` exists with that signature**

```bash
cd api && grep -n "def _resolve_target_subscription" -A 6 app/api/subscription_routes.py
```
It is used by `/resume` and `/cancel`; match its argument order exactly.

- [ ] **Step 3: Verify by hand against a forced past_due row**

```bash
psql "$DB_URL" -c "UPDATE subscriptions SET status='past_due', past_due_since=now() - interval '3 days' WHERE id=3;"
KEY=$(psql "$DB_URL" -tAc "SELECT api_key FROM clients WHERE id=2;")
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:8000/subscriptions/payment-recovery | python3 -m json.tool
psql "$DB_URL" -c "UPDATE subscriptions SET status='active', past_due_since=NULL WHERE id=3;"
```
Expected: `past_due: true`, `days_left: 4`. **Restore the row afterwards** — the last statement is not optional.

- [ ] **Step 4: Commit**

```bash
git add api/app/api/subscription_routes.py
git commit -m "feat(dunning): GET /subscriptions/payment-recovery for the past-due banner"
```

---

### Task 7: The dunning cron

**Files:** `api/app/worker/tasks.py`, `api/app/worker/settings.py`; Test `api/tests/test_dunning_cron.py`

- [ ] **Step 1: Write the failing test**

```python
"""The dunning cron sends each cadence email once and only on its day."""

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _past_due_sub(db, *, days_ago: int, email: str):
    client = Client(name="D", email=email, api_key=f"key-{email}")
    db.add(client)
    db.flush()
    plan = Plan(name="Standard", slug=f"std-{email}", monthly_price_cents=94900, credits_per_month=6000)
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="past_due",
        past_due_since=datetime.now(UTC) - timedelta(days=days_ago),
        razorpay_subscription_id="sub_x",
    )
    db.add(sub)
    db.flush()
    return sub


def test_day_three_sends_action_required_and_marks_it(db, monkeypatch):
    from app.worker import tasks

    sent = []
    monkeypatch.setattr(
        tasks, "_dunning_send", lambda marker, **kw: sent.append(marker) or True
    )
    sub = _past_due_sub(db, days_ago=3, email="d3@test.dev")

    tasks._run_dunning_cycle(db)

    assert sent == ["halted_3"]
    assert "halted_3" in (sub.dunning_emails_sent or {})


def test_second_run_on_the_same_day_does_not_resend(db, monkeypatch):
    from app.worker import tasks

    sent = []
    monkeypatch.setattr(tasks, "_dunning_send", lambda marker, **kw: sent.append(marker) or True)
    _past_due_sub(db, days_ago=3, email="d3b@test.dev")

    tasks._run_dunning_cycle(db)
    tasks._run_dunning_cycle(db)

    assert sent == ["halted_3"]


def test_active_subscriptions_are_ignored(db, monkeypatch):
    from app.worker import tasks

    sent = []
    monkeypatch.setattr(tasks, "_dunning_send", lambda marker, **kw: sent.append(marker) or True)
    sub = _past_due_sub(db, days_ago=3, email="active@test.dev")
    sub.status = "active"
    db.flush()

    tasks._run_dunning_cycle(db)

    assert sent == []


def test_a_failed_send_leaves_the_marker_unset_for_retry(db, monkeypatch):
    from app.worker import tasks

    monkeypatch.setattr(tasks, "_dunning_send", lambda marker, **kw: False)
    sub = _past_due_sub(db, days_ago=3, email="fail@test.dev")

    tasks._run_dunning_cycle(db)

    assert "halted_3" not in (sub.dunning_emails_sent or {})


def test_rows_without_an_anchor_are_skipped(db, monkeypatch):
    """Legacy past_due rows with no past_due_since have no day bucket."""
    from app.worker import tasks

    sent = []
    monkeypatch.setattr(tasks, "_dunning_send", lambda marker, **kw: sent.append(marker) or True)
    sub = _past_due_sub(db, days_ago=3, email="anchorless@test.dev")
    sub.past_due_since = None
    db.flush()

    tasks._run_dunning_cycle(db)

    assert sent == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/test_dunning_cron.py -v`
Expected: FAIL — `AttributeError: module 'app.worker.tasks' has no attribute '_run_dunning_cycle'`

- [ ] **Step 3: Write the implementation**

In `api/app/worker/tasks.py`, mirroring `task_trial_reminder_emails`:

```python
def _mark_dunning_sent(sub, key: str, when) -> None:
    """JSONB columns don't auto-detect in-place mutation — rebuild the dict.
    Same reasoning as ``_mark_email_sent`` for trial reminders."""
    existing = dict(sub.dunning_emails_sent or {})
    existing[key] = when.isoformat()
    sub.dunning_emails_sent = existing


def _dunning_send(marker: str, *, owner, sub, plan_name: str, days_left: int) -> bool:
    """Send the email for ``marker``. Returns True on success.

    Split out so the cron's control flow is testable without Brevo or Razorpay.
    Returns False rather than raising so one bad address cannot abort the loop
    and starve every other customer.
    """
    from app.core.pricing import format_amount
    from app.services.dunning_service import DunningError, get_recovery_link
    from app.services.email_service import (
        send_payment_action_required_email,
        send_payment_failed_email,
        send_payment_final_warning_email,
    )

    try:
        if marker == "failed_0":
            # Day 0 asks for nothing, so it needs no recovery link — and
            # skipping the fetch avoids a gateway call for the majority of
            # cases that resolve on Razorpay's own retry.
            send_payment_failed_email(
                owner.email,
                name=owner.name,
                plan_name=plan_name,
                amount=format_amount(sub.plan.monthly_price_cents, "INR") if sub.plan else "",
            )
            return True

        link = get_recovery_link(sub.razorpay_subscription_id)
        if not link.recoverable or not link.url:
            logger.info(
                "dunning: %s not recoverable for sub %s (gateway=%s) — skipping %s",
                sub.razorpay_subscription_id,
                sub.id,
                link.gateway_status,
                marker,
            )
            return False

        if marker == "halted_3":
            send_payment_action_required_email(
                owner.email,
                name=owner.name,
                plan_name=plan_name,
                amount=format_amount(sub.plan.monthly_price_cents, "INR") if sub.plan else "",
                recovery_url=link.url,
                days_left=days_left,
            )
        else:  # warning_5
            send_payment_final_warning_email(
                owner.email,
                name=owner.name,
                plan_name=plan_name,
                recovery_url=link.url,
                days_left=days_left,
            )
        return True
    except (DunningError, Exception) as exc:  # noqa: BLE001
        logger.warning("dunning: %s send failed for sub %s: %s", marker, sub.id, exc)
        return False


def _run_dunning_cycle(session) -> int:
    """One pass over past_due subscriptions. Returns emails sent."""
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.config import PAYMENT_FAILED_GRACE_DAYS
    from app.db.models import Client, Subscription
    from app.services.dunning_service import due_email
    from app.services.notification_service import notify_payment_failed

    now = datetime.now(UTC)
    sent = 0
    subs = (
        session.execute(
            select(Subscription).where(
                Subscription.status == "past_due",
                Subscription.past_due_since.is_not(None),
            )
        )
        .scalars()
        .all()
    )
    for sub in subs:
        since = sub.past_due_since
        if since.tzinfo is None:
            since = since.replace(tzinfo=UTC)
        days = (now - since).days
        marker = due_email(days, sub.dunning_emails_sent or {})
        if marker is None:
            continue

        owner = session.get(Client, sub.client_id)
        if owner is None or not owner.email:
            continue

        plan_name = sub.plan.name if sub.plan else "your plan"
        days_left = max(0, PAYMENT_FAILED_GRACE_DAYS - days)

        if _dunning_send(marker, owner=owner, sub=sub, plan_name=plan_name, days_left=days_left):
            # Marker written ONLY on success, so a Brevo outage retries on the
            # next matching day bucket instead of silently swallowing the email.
            _mark_dunning_sent(sub, marker, now)
            sent += 1
            try:
                notify_payment_failed(
                    session,
                    client_id=sub.client_id,
                    plan_name=plan_name,
                    days_left=days_left,
                    recoverable=True,
                )
            except Exception:  # noqa: BLE001 — a notification must never cost us the email
                logger.warning("dunning: in-app notification failed for sub %s", sub.id, exc_info=True)
    session.commit()
    return sent


async def task_dunning_emails(ctx: dict) -> int:
    """Cron: dunning cadence for past_due subscriptions.

    Runs daily. Razorpay retries the charge on its own for ~3 days; this adds
    the product context Razorpay cannot know — that the customer's agents stop
    responding when our grace window elapses.
    """
    import asyncio

    from app.db.session import get_session

    def _run() -> int:
        with get_session() as session:
            return _run_dunning_cycle(session)

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_dunning_emails: sent %d dunning email(s)", count)
    return count
```

- [ ] **Step 4: Register the cron**

In `api/app/worker/settings.py`, import `task_dunning_emails` alongside the other billing tasks, add it to the functions list, and schedule it **after** the expiry cron at `hour=0, minute=25` so a subscription that expires today gets the suspension email rather than a cadence email:

```python
        cron(task_dunning_emails, hour=9, minute=30),
```

9:30 UTC is 15:00 IST — a working-hours send for the Indian customer base, and far from the midnight billing crons.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && uv run pytest tests/test_dunning_cron.py -v`
Expected: 5 passed

- [ ] **Step 6: Commit**

```bash
git add api/app/worker/tasks.py api/app/worker/settings.py api/tests/test_dunning_cron.py
git commit -m "feat(dunning): daily cadence cron for past_due subscriptions"
```

---

### Task 8: Suspension email on grace expiry

**Files:** `api/app/worker/tasks.py` (`task_expire_past_due_subscriptions`)

- [ ] **Step 1: Send on the flip**

Inside the existing loop, after `sub.cancel_reason = "dunning_grace_elapsed"`:

```python
                # Tell the customer their agents just went offline. Best-effort
                # and deliberately after the state change: the expiry must
                # commit even if Brevo is down.
                try:
                    from app.db.models import Client as _Client
                    from app.services.dunning_service import get_recovery_link
                    from app.services.email_service import send_subscription_suspended_email

                    owner = session.get(_Client, sub.client_id)
                    if owner and owner.email and not (sub.dunning_emails_sent or {}).get("suspended"):
                        try:
                            link = get_recovery_link(sub.razorpay_subscription_id)
                            url = link.url if link.recoverable else None
                        except Exception:  # noqa: BLE001 — send without a link rather than not at all
                            url = None
                        send_subscription_suspended_email(
                            owner.email,
                            name=owner.name,
                            plan_name=sub.plan.name if sub.plan else "your plan",
                            recovery_url=url,
                        )
                        _mark_dunning_sent(sub, "suspended", now)
                except Exception:  # noqa: BLE001
                    logger.warning("suspension email failed for sub %s", sub.id, exc_info=True)
```

- [ ] **Step 2: Verify the expiry still commits when email fails**

Add to `api/tests/test_dunning_cron.py`:

```python
def test_expiry_commits_even_when_the_suspension_email_fails(db, monkeypatch):
    """The state change is the load-bearing part; the email is not."""
    from app.services import email_service
    from app.worker import tasks

    def _boom(*_a, **_kw):
        raise RuntimeError("brevo down")

    monkeypatch.setattr(email_service, "send_subscription_suspended_email", _boom)
    sub = _past_due_sub(db, days_ago=99, email="expire@test.dev")

    tasks._expire_past_due_cycle(db)

    assert sub.status == "expired"
    assert sub.cancel_reason == "dunning_grace_elapsed"
```

This requires extracting the cron's inner `_run` into a testable `_expire_past_due_cycle(session)`, exactly as Task 7 did for the dunning loop. Do that extraction as part of this step — leaving the logic inline makes it untestable.

- [ ] **Step 3: Run and commit**

```bash
cd api && uv run pytest tests/test_dunning_cron.py -v
git add api/app/worker/tasks.py api/tests/test_dunning_cron.py
git commit -m "feat(dunning): suspension email when the grace window elapses"
```

---

### Task 9: Past-due banner

**Files:** Create `app/src/features/workspace/billing/PastDueBanner.tsx`; modify `app/src/shell/AppShell.tsx`

- [ ] **Step 1: Build the banner**

It polls `GET /subscriptions/payment-recovery`, renders nothing when `past_due` is false, and otherwise shows a warning bar pinned above the page content:

- `days_left > 0`: "Payment failed — your agents stop responding in N days." + **Update payment method** button opening `recovery_url` in a new tab.
- `recoverable === false`: no button; link to `/workspace/billing` with "Contact support" copy. Never render a dead button.
- `recoverable === null` (gateway unreachable): show the warning without the button, and a quiet "we couldn't reach the payment provider" line. The past-due state is locally known and still true.

- [ ] **Step 2: Mount it app-wide**

In `AppShell.tsx`, render `<PastDueBanner />` above the routed outlet — not inside the Billing page. A customer who never visits Billing is exactly the one who needs to see it.

- [ ] **Step 3: Verify against a forced past_due row**

Use the psql commands from Task 6 Step 3 to flip a subscription to `past_due`, load any page, confirm the banner appears with the right day count, then **restore the row**.

- [ ] **Step 4: Gates and commit**

```bash
cd app && npm run lint && npm run build
git add app/src/features/workspace/billing/PastDueBanner.tsx app/src/shell/AppShell.tsx
git commit -m "feat(dunning): app-wide past-due banner with recovery CTA"
```

---

### Task 10: Recovery visibility for the super-admin

**Files:** `api/app/api/superadmin_routes_v2.py`, `oyechats-admin/src/app/(dashboard)/revenue/page.tsx`

- [ ] **Step 1: Add the endpoint**

```python
@router.get("/billing/dunning")
def dunning_overview(_admin: Client = Depends(get_superadmin)):
    """Who is currently failing, how far into grace, and what it is worth.

    Also surfaces the recovered-cycle gap: Razorpay does NOT re-attempt the
    missed charge when a halted subscription returns to active, so every
    recovery leaves one cycle uncollected unless it is charged manually.
    """
    from app.config import PAYMENT_FAILED_GRACE_DAYS

    with get_session() as session:
        rows = session.execute(
            select(Subscription, Client.email, Plan.name)
            .join(Client, Subscription.client_id == Client.id)
            .outerjoin(Plan, Subscription.plan_id == Plan.id)
            .where(Subscription.status == "past_due")
            .order_by(Subscription.past_due_since)
        ).all()

        now = datetime.now(UTC)
        items = []
        for sub, email, plan_name in rows:
            since = sub.past_due_since
            if since and since.tzinfo is None:
                since = since.replace(tzinfo=UTC)
            elapsed = (now - since).days if since else None
            items.append(
                {
                    "subscription_id": sub.id,
                    "client_email": email,
                    "plan_name": plan_name,
                    "past_due_since": since.isoformat() if since else None,
                    "days_elapsed": elapsed,
                    "days_left": max(0, PAYMENT_FAILED_GRACE_DAYS - elapsed) if elapsed is not None else None,
                    "emails_sent": sorted((sub.dunning_emails_sent or {}).keys()),
                    "at_risk_minor": sub.plan.monthly_price_cents if sub.plan else 0,
                }
            )
        return {
            "count": len(items),
            "at_risk_minor_total": sum(i["at_risk_minor"] for i in items),
            "grace_days": PAYMENT_FAILED_GRACE_DAYS,
            "items": items,
        }
```

- [ ] **Step 2: Render it on the Revenue page**

A "Payments at risk" card: count, total at-risk amount, and a table of the items with which dunning emails have gone out. This is the operator's queue for a manual save call.

- [ ] **Step 3: Gates and commit**

```bash
cd api && uv run ruff check app/api/superadmin_routes_v2.py
cd ../../oyechats-admin && npm run lint && npx tsc --noEmit && npm run build
git commit -am "feat(dunning): payments-at-risk overview for the super-admin"
```

---

## 6. Verification before this ships

- [ ] **Full backend suite**: `cd api && uv run pytest` — expected ≥2557 passed (the Phase 0 baseline) plus the ~30 added here.
- [ ] **`ruff check` + `ruff format --check`** clean.
- [ ] **`cd app && npm run lint && npm run build`**, **`cd oyechats-admin && npm run lint && npx tsc --noEmit && npm run build`**.
- [ ] **Razorpay test-mode end-to-end** — the only way to validate §2.2, which the whole plan rests on:
  1. Create a test subscription and let a charge fail so it enters `pending`.
  2. Confirm our day-0 email fires and no recovery link is fetched.
  3. Let retries exhaust to `halted`.
  4. **Confirm `subscription.fetch(...).short_url` on a halted subscription actually serves the card-update page.** The docs describe the hosted page but do not state that `short_url` is how you reach it. If it is not, `get_recovery_link` needs a different source and Tasks 2/4/7 change — find this out before writing the UI.
  5. Complete recovery through that page; confirm the subscription returns to `active` and **no second subscription exists**.
  6. Confirm the missed cycle was *not* charged (§2.4), and that it shows up in the Task 10 overview.

---

## 7. Self-review

**Spec coverage.** The gap was: failed payment → customer told nothing → silent expiry. Day 0/3/5 emails (Tasks 4, 7), suspension email (Task 8), in-app notification (Task 5), app-wide banner (Task 9), a working recovery CTA (Tasks 2, 6), and operator visibility (Task 10). Every state in the §1 table now produces a customer-visible signal.

**Placeholder scan.** No TBDs. Three steps deliberately instruct verification before editing — Task 4 Step 2 (email helper names), Task 6 Step 2 (`_resolve_target_subscription` signature), Task 5 Step 3 (notification type mapping) — because those symbols were not confirmed during research and guessing at them is how a plan produces code that does not import. Task 8 Step 2 requires extracting `_expire_past_due_cycle` rather than testing inline logic.

**Type consistency.** `RecoveryLink(recoverable, url, gateway_status)` is constructed in one place and consumed identically in Tasks 6, 7 and 8. `due_email(days, sent) -> str | None` and the marker keys `failed_0` / `halted_3` / `warning_5` / `suspended` match across the cadence dict, the cron, the emails and the Task 10 response. `_mark_dunning_sent` mirrors the existing `_mark_email_sent`.

**The risk that would sink this plan.** Everything downstream of §2.2 assumes a halted subscription's `short_url` reaches Razorpay's card-update page. The recovery mechanism is documented; that `short_url` is the handle to it is inference. **Verification step 4 above must pass before Task 9 is built** — if it fails, the recovery link comes from somewhere else and Tasks 2, 4 and 7 need revisiting. Do not build the UI on an unverified link.

**One thing deliberately not built.** Automatic retry of the missed cycle after recovery (§2.4). It needs a manual charge against an outstanding Razorpay invoice, which is a money-moving write on a customer who just had a payment problem — the wrong thing to automate without a commercial decision. Task 10 surfaces the amount so that decision can be made with numbers.
