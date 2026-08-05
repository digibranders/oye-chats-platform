"""Webhook behaviour for the deferred-cancellation / deferred-start model.

Two halves:

**The charged backstop.** ``/subscriptions/cancel`` leaves the mandate live so
reactivating stays free, and a cron issues the real cancel near period end. If
that cron is down long enough, Razorpay renews a subscription the customer had
already cancelled. That is the one charge the deferral trades against, so
``_handle_subscription_charged`` must catch it: cancel immediately, withhold the
credit grant, and leave the invoice recorded for a refund. The blast radius has
to be one cycle, not an open-ended subscription.

**The deferred start.** ``/subscriptions/resume`` on an already-cancelled
mandate mints a replacement with ``start_at = current_period_end``, so the
customer is not billed twice for overlapping days. The activation that follows
must respect that: it may not grant a new period (their existing credits are
still running), it must carry the paid-through date onto the replacement, and it
must retire the predecessor at cycle end rather than immediately — otherwise the
paid remainder is destroyed at the gateway too.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, CreditLedger, Invoice, Plan, Subscription
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db, email) -> Client:
    c = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, slug, credits=1000) -> Plan:
    p = Plan(name=slug, slug=slug, monthly_price_cents=399900, credits_per_month=credits)
    db.add(p)
    db.flush()
    return p


def _charged_payload(sub_id, *, period_start, period_end, payment_id):
    return {
        "subscription": {
            "entity": {
                "id": sub_id,
                "current_start": int(period_start.timestamp()),
                "current_end": int(period_end.timestamp()),
            }
        },
        "payment": {"entity": {"id": payment_id, "amount": 399900, "currency": "INR"}},
    }


def _activation_payload(*, razorpay_sub_id, client_id, plan_id, period_start, period_end, notes=None):
    return {
        "subscription": {
            "entity": {
                "id": razorpay_sub_id,
                "notes": {
                    "oyechats_client_id": str(client_id),
                    "oyechats_plan_id": str(plan_id),
                    **(notes or {}),
                },
                "current_start": int(period_start.timestamp()),
                "current_end": int(period_end.timestamp()),
                "quantity": 1,
                "customer_id": "cust_deferred",
            }
        }
    }


# ── The charged backstop ──────────────────────────────────────────────────────


def test_charge_past_a_pending_cancellation_is_cancelled_and_not_granted(db, monkeypatch):
    client = _client(db, "backstop-charged@e.com")
    plan = _plan(db, "std-backstop-charged")
    period_start = datetime.now(UTC) - timedelta(days=31)
    period_end = datetime.now(UTC) - timedelta(minutes=5)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_backstop",
        billing_cycle="monthly",
        cancel_at_period_end=True,
        gateway_cancel_executed_at=None,  # the sweep never ran
        current_period_start=period_start,
        current_period_end=period_end,
        last_granted_period_end=period_end,
    )
    sub.plan = plan
    db.add(sub)
    db.commit()

    cancels: list[bool] = []
    monkeypatch.setattr(rzp, "cancel_subscription", lambda s, **kw: cancels.append(kw["at_period_end"]))

    result = rzp._handle_subscription_charged(
        db,
        _charged_payload(
            "sub_backstop",
            period_start=period_end,
            period_end=period_end + timedelta(days=30),
            payment_id="pay_backstop",
        ),
    )
    db.commit()

    assert "refund required" in result
    # Cancelled NOW — the period they paid for has just rolled over, so there is
    # nothing left to protect by waiting.
    assert cancels == [False]

    db.refresh(sub)
    assert sub.status == "canceled"
    assert sub.gateway_cancel_executed_at is not None
    # Credits withheld: the customer cancelled and must not be handed a month
    # they'll be refunded for.
    assert sub.last_granted_period_end == period_end
    assert db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all() == []
    # The money is still recorded so it can be reconciled and refunded.
    assert db.query(Invoice).filter_by(razorpay_payment_id="pay_backstop").one().client_id == client.id


def test_failed_emergency_cancel_stays_active_so_the_sweep_retries(db, monkeypatch):
    """If the emergency cancel itself fails, the row must NOT be flipped to
    ``canceled``.

    Doing so drops it out of the sweep's match set AND the renewal cron, so a
    mandate we failed to stop keeps debiting with nothing anywhere left to retry
    it. Staying active with an un-rolled period is what makes the next sweep
    re-match it.
    """
    client = _client(db, "backstop-failcancel@e.com")
    plan = _plan(db, "std-backstop-failcancel")
    period_start = datetime.now(UTC) - timedelta(days=31)
    period_end = datetime.now(UTC) - timedelta(minutes=5)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_backstop_fail",
        billing_cycle="monthly",
        cancel_at_period_end=True,
        gateway_cancel_executed_at=None,
        current_period_start=period_start,
        current_period_end=period_end,
        last_granted_period_end=period_end,
    )
    sub.plan = plan
    db.add(sub)
    db.commit()

    monkeypatch.setattr(rzp, "cancel_subscription", lambda s, **kw: (_ for _ in ()).throw(RuntimeError("gateway 500")))

    result = rzp._handle_subscription_charged(
        db,
        _charged_payload(
            "sub_backstop_fail",
            period_start=period_end,
            period_end=period_end + timedelta(days=30),
            payment_id="pay_backstop_fail",
        ),
    )
    db.commit()

    assert "will retry" in result
    db.refresh(sub)
    assert sub.status == "active", "must stay in the sweep's match set"
    assert sub.gateway_cancel_executed_at is None
    assert sub.current_period_end == period_end, "period must not roll — it is what re-matches the sweep"
    # Still no credits: the customer cancelled and this charge is refundable.
    assert db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all() == []


def test_authenticated_with_an_immediate_start_grants_nothing(db, monkeypatch):
    """``subscription.authenticated`` proves a mandate exists, not that money
    moved. Only the deferred-start case is acted on; an immediate-start
    subscription waits for its own ``activated`` event, which is the canonical
    proof of collection."""
    client = _client(db, "auth-immediate@e.com")
    plan = _plan(db, "std-auth-immediate")
    monkeypatch.setattr(rzp, "cancel_subscription", lambda s, **kw: None)

    start = datetime.now(UTC) - timedelta(minutes=1)
    result = rzp._handle_subscription_authenticated(
        db,
        _activation_payload(
            razorpay_sub_id="sub_auth_immediate",
            client_id=client.id,
            plan_id=plan.id,
            period_start=start,
            period_end=start + timedelta(days=30),
        ),
    )
    db.commit()

    assert "ignored" in result
    assert db.query(Subscription).filter_by(razorpay_subscription_id="sub_auth_immediate").first() is None
    assert db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all() == []


def test_authenticated_with_a_future_start_materialises_the_row(db, monkeypatch):
    """The case it exists for: a deferred-start reactivation fires this and then
    nothing until the first charge, so without it the local row never appears
    and the "won't renew" banner never clears on a paid reactivation."""
    client = _client(db, "auth-future@e.com")
    plan = _plan(db, "std-auth-future")
    monkeypatch.setattr(rzp, "cancel_subscription", lambda s, **kw: None)

    start = datetime.now(UTC) + timedelta(days=20)
    rzp._handle_subscription_authenticated(
        db,
        _activation_payload(
            razorpay_sub_id="sub_auth_future",
            client_id=client.id,
            plan_id=plan.id,
            period_start=start,
            period_end=start + timedelta(days=30),
        ),
    )
    db.commit()

    row = db.query(Subscription).filter_by(razorpay_subscription_id="sub_auth_future").one()
    assert row.cancel_at_period_end is False
    # Materialised, but still no entitlement until money moves.
    assert db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all() == []


def test_normal_renewal_is_untouched_by_the_backstop(db, monkeypatch):
    """Guard against over-reach: a subscription nobody cancelled must renew."""
    client = _client(db, "backstop-normal@e.com")
    plan = _plan(db, "std-backstop-normal")
    period_start = datetime.now(UTC) - timedelta(days=31)
    period_end = datetime.now(UTC) - timedelta(minutes=5)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_backstop_normal",
        billing_cycle="monthly",
        cancel_at_period_end=False,
        current_period_start=period_start,
        current_period_end=period_end,
        last_granted_period_end=period_end,
    )
    sub.plan = plan
    db.add(sub)
    db.commit()

    monkeypatch.setattr(rzp, "cancel_subscription", lambda s, **kw: pytest.fail("must not cancel a live renewal"))

    # Razorpay carries whole-second epochs, so the row lands on the truncated
    # instant — compare against that, not the microsecond-precision local value.
    new_end = (period_end + timedelta(days=30)).replace(microsecond=0)
    rzp._handle_subscription_charged(
        db,
        _charged_payload(
            "sub_backstop_normal", period_start=period_end, period_end=new_end, payment_id="pay_backstop_normal"
        ),
    )
    db.commit()

    db.refresh(sub)
    assert sub.status == "active"
    assert sub.last_granted_period_end == new_end
    assert db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").count() == 1


# ── The deferred start ────────────────────────────────────────────────────────


def test_future_start_activation_carries_the_paid_period_and_grants_nothing(db, monkeypatch):
    """The replacement authorises today but does not bill until the old period
    ends. Granting here would run ``reset_monthly_plan_credits`` first and
    destroy the allowance the customer already paid for."""
    client = _client(db, "deferred-start@e.com")
    plan = _plan(db, "std-deferred-start")
    paid_through = datetime.now(UTC) + timedelta(days=26)
    old = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_old_deferred",
        billing_cycle="monthly",
        cancel_at_period_end=True,
        gateway_cancel_executed_at=datetime.now(UTC),
        current_period_start=datetime.now(UTC) - timedelta(days=4),
        current_period_end=paid_through,
        last_granted_period_end=paid_through,
    )
    old.plan = plan
    db.add(old)
    db.commit()

    cancels: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        rzp,
        "cancel_subscription",
        lambda s, **kw: cancels.append((s.razorpay_subscription_id, kw["at_period_end"])),
    )

    rzp._handle_subscription_activated(
        db,
        _activation_payload(
            razorpay_sub_id="sub_new_deferred",
            client_id=client.id,
            plan_id=plan.id,
            period_start=paid_through,  # future — this is the deferred start
            period_end=paid_through + timedelta(days=30),
            notes={"prev_razorpay_subscription_id": "sub_old_deferred"},
        ),
    )
    db.commit()

    new = db.query(Subscription).filter_by(razorpay_subscription_id="sub_new_deferred").one()
    # Entitlement is continuous: same paid-through date, same grant marker, so
    # the customer's existing credits keep running untouched.
    assert new.current_period_end == paid_through
    assert new.last_granted_period_end == paid_through
    assert db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all() == []
    # The banner clears — that is the whole point of the reactivation.
    assert new.cancel_at_period_end is False
    assert new.status == "active"

    # The predecessor is retired at CYCLE END, not immediately: cancelling now
    # would void the remainder at Razorpay as well as locally.
    assert cancels == [("sub_old_deferred", True)]


def test_immediate_start_activation_still_grants(db, monkeypatch):
    """Guard against over-reach: an ordinary activation (no deferred start) must
    still reset and grant the new plan's allowance."""
    client = _client(db, "immediate-start@e.com")
    plan = _plan(db, "std-immediate-start")
    monkeypatch.setattr(rzp, "cancel_subscription", lambda s, **kw: None)

    start = datetime.now(UTC) - timedelta(minutes=1)
    rzp._handle_subscription_activated(
        db,
        _activation_payload(
            razorpay_sub_id="sub_immediate",
            client_id=client.id,
            plan_id=plan.id,
            period_start=start,
            period_end=start + timedelta(days=30),
        ),
    )
    db.commit()

    grants = db.query(CreditLedger).filter_by(client_id=client.id, reason="plan_grant").all()
    assert len(grants) == 1
    assert grants[0].delta == plan.credits_per_month


def test_per_bot_resume_retires_the_bots_own_subscription(db, monkeypatch):
    """``oyechats_bot_id`` scopes the sibling sweep to that bot. Without it the
    sweep looked for the ACCOUNT row, left the per-bot row active and cancelling,
    and the customer held two live mandates behind a banner that never cleared."""
    from app.db.models import Bot

    client = _client(db, "perbot-resume@e.com")
    plan = _plan(db, "std-perbot-resume")
    bot = Bot(client_id=client.id, name="Agent A", bot_key="bot-perbot-resume")
    db.add(bot)
    db.flush()
    old = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot.id,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_old_perbot_wh",
        billing_cycle="monthly",
        cancel_at_period_end=True,
        gateway_cancel_executed_at=datetime.now(UTC),
        current_period_start=datetime.now(UTC) - timedelta(days=4),
        current_period_end=datetime.now(UTC) + timedelta(days=26),
    )
    old.plan = plan
    db.add(old)
    db.commit()

    monkeypatch.setattr(rzp, "cancel_subscription", lambda s, **kw: None)

    paid_through = old.current_period_end
    rzp._handle_subscription_activated(
        db,
        _activation_payload(
            razorpay_sub_id="sub_new_perbot_wh",
            client_id=client.id,
            plan_id=plan.id,
            period_start=paid_through,
            period_end=paid_through + timedelta(days=30),
            notes={
                "purpose": "per_bot_subscription",
                "oyechats_bot_id": str(bot.id),
                "prev_razorpay_subscription_id": "sub_old_perbot_wh",
            },
        ),
    )
    db.commit()

    db.refresh(old)
    assert old.status == "canceled", "the bot's own row must be retired"

    new = db.query(Subscription).filter_by(razorpay_subscription_id="sub_new_perbot_wh").one()
    assert new.bot_id == bot.id, "the replacement funds the SAME bot — no new bot minted"
    assert new.cancel_at_period_end is False
    db.refresh(bot)
    assert bot.subscription_id == new.id, "the bot must point at the subscription that now funds it"
    # Exactly two subscriptions for this client: the retired one and its replacement.
    assert db.query(Subscription).filter_by(client_id=client.id).count() == 2
