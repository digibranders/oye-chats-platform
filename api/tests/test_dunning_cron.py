"""The dunning cron sends each cadence email once, and only on success.

The marker is the whole safety mechanism: written too eagerly and the email is
dropped permanently; written to the wrong column and the cadence never fires at
all. Both are silent failures, so both are asserted explicitly here.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _past_due_sub(db, *, days_ago: int, email: str, status: str = "past_due") -> Subscription:
    client = Client(name="D", email=email, api_key=f"key-{email}", hashed_password="h")
    db.add(client)
    db.flush()
    plan = Plan(
        name="Standard",
        slug=f"std-{email}",
        monthly_price_cents=94900,
        credits_per_month=6000,
        included_operator_seats=1,
        is_active=True,
    )
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status=status,
        past_due_since=datetime.now(UTC) - timedelta(days=days_ago),
        razorpay_subscription_id=f"sub_{email}",
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


@pytest.fixture
def sent(monkeypatch):
    """Capture which markers were sent, bypassing Brevo and Razorpay."""
    from app.worker import tasks

    captured: list[str] = []
    monkeypatch.setattr(tasks, "_dunning_send", lambda marker, **kw: captured.append(marker) or True)
    return captured


def test_day_three_sends_action_required_and_marks_the_right_column(db, sent):
    """Asserts on ``dunning_emails_sent`` BY NAME. A marker helper hardcoded to
    ``trial_emails_sent`` would write there silently and the cadence would
    never advance, no exception, no type error."""
    from app.worker import tasks

    sub = _past_due_sub(db, days_ago=3, email="d3@test.dev")

    tasks._run_dunning_cycle(db)

    assert sent == ["halted_3"]
    assert "halted_3" in (sub.dunning_emails_sent or {})
    assert sub.trial_emails_sent == {}


def test_second_run_on_the_same_day_does_not_resend(db, sent):
    from app.worker import tasks

    _past_due_sub(db, days_ago=3, email="d3b@test.dev")

    tasks._run_dunning_cycle(db)
    tasks._run_dunning_cycle(db)

    assert sent == ["halted_3"]


def test_a_failed_send_leaves_the_marker_unset_for_retry(db, monkeypatch):
    """The single most important contract here: a failed hand-off must NOT be
    recorded, or the cadence skips straight past that email forever."""
    from app.worker import tasks

    monkeypatch.setattr(tasks, "_dunning_send", lambda marker, **kw: False)
    sub = _past_due_sub(db, days_ago=3, email="fail@test.dev")

    tasks._run_dunning_cycle(db)

    assert "halted_3" not in (sub.dunning_emails_sent or {})


def test_a_missed_tick_is_caught_up_not_dropped(db, sent):
    """Cron did not run on day 3; the day-4 pass must still deliver it."""
    from app.worker import tasks

    sub = _past_due_sub(db, days_ago=4, email="catchup@test.dev")
    sub.dunning_emails_sent = {"failed_0": "t"}
    db.flush()

    tasks._run_dunning_cycle(db)

    assert sent == ["halted_3"]


def test_active_subscriptions_are_ignored(db, sent):
    from app.worker import tasks

    _past_due_sub(db, days_ago=3, email="active@test.dev", status="active")

    tasks._run_dunning_cycle(db)

    assert sent == []


def test_rows_without_an_anchor_are_skipped(db, sent):
    """Legacy past_due rows with no past_due_since have no day bucket."""
    from app.worker import tasks

    sub = _past_due_sub(db, days_ago=3, email="anchorless@test.dev")
    sub.past_due_since = None
    db.flush()

    tasks._run_dunning_cycle(db)

    assert sent == []


def test_day_left_count_is_reported_to_the_template(db, monkeypatch):
    from app.worker import tasks

    seen: dict = {}

    def _capture(marker, **kw):
        seen.update(kw)
        return True

    monkeypatch.setattr(tasks, "_dunning_send", _capture)
    _past_due_sub(db, days_ago=5, email="daysleft@test.dev")

    tasks._run_dunning_cycle(db)

    # PAYMENT_FAILED_GRACE_DAYS (7) - 5 elapsed.
    assert seen["days_left"] == 2
    assert seen["plan_name"] == "Standard"


# ── Expiry + suspension email ────────────────────────────────────────────────


def test_expiry_commits_even_when_the_suspension_email_fails(db, monkeypatch):
    """The state change is load-bearing; the email is not. A Brevo or Razorpay
    outage must never leave a customer entitled to a plan they stopped paying
    for.

    Asserts DURABILITY, not just in-memory attributes: ``db.rollback()`` before
    the assertions discards anything uncommitted, so this fails if the expiry is
    only committed after the network I/O (or not at all). Mutation-tested.
    Deleting the commit makes this test fail.
    """
    from app.services import email_service
    from app.worker import tasks

    def _boom(*_a, **_kw):
        raise RuntimeError("brevo down")

    monkeypatch.setattr(email_service, "send_subscription_suspended_email", _boom)
    sub = _past_due_sub(db, days_ago=99, email="expire@test.dev")
    db.commit()
    sub_id = sub.id

    tasks._expire_past_due_cycle(db)

    db.rollback()  # discard anything the cycle left uncommitted
    from app.db.models import Subscription as _Sub

    fresh = db.get(_Sub, sub_id)
    assert fresh.status == "expired"
    assert fresh.cancel_reason == "dunning_grace_elapsed"
    assert fresh.canceled_at is not None


def test_a_poisoned_notification_does_not_starve_the_rest_of_the_batch(db, monkeypatch):
    """create_notification flushes internally. A failed flush leaves the session
    rollback-required, so swallowing it without rollback() makes the NEXT
    iteration's session.get raise PendingRollbackError and every remaining
    subscription go unserved. Silently."""
    from app.db.models import Notification
    from app.worker import tasks

    sent: list[str] = []
    monkeypatch.setattr(tasks, "_dunning_send", lambda marker, **kw: sent.append(marker) or True)

    def _poison(session, **_kw):
        """Reproduce the REAL failure, not a synthetic one.

        A plain ``raise`` never touches the session, so it cannot prove the
        rollback is needed. create_notification flushes internally, so the
        genuine hazard is a flush that violates a constraint (here an FK to a
        client that does not exist) which leaves the session rollback-required.
        """
        session.add(Notification(client_id=999_999_999, type="payment_failed", title="x"))
        session.flush()

    monkeypatch.setattr("app.services.notification_service.notify_payment_failed", _poison)
    _past_due_sub(db, days_ago=3, email="poison-a@test.dev")
    _past_due_sub(db, days_ago=3, email="poison-b@test.dev")
    db.commit()

    tasks._run_dunning_cycle(db)

    # BOTH must be served despite the notification blowing up on the first.
    assert len(sent) == 2


def test_annual_subscriber_is_quoted_the_annual_amount(db, monkeypatch):
    """An annual customer whose Rs 9,108 charge fails must not be told
    'the Rs 949 charge didn't go through'."""
    from app.worker import tasks

    seen: dict = {}
    monkeypatch.setattr(
        "app.services.email_service.send_payment_failed_email",
        lambda to, **kw: seen.update(kw) or True,
    )
    sub = _past_due_sub(db, days_ago=0, email="annual@test.dev")
    sub.billing_cycle = "annual"
    sub.plan.annual_price_cents = 910800
    db.flush()

    tasks._run_dunning_cycle(db)

    assert "9,108" in seen["amount"], seen["amount"]


def test_expiry_sends_the_suspension_email_once_and_marks_it(db, monkeypatch):
    from app.worker import tasks

    calls: list[str | None] = []
    monkeypatch.setattr(tasks, "_suspension_recovery_url", lambda sub: "https://rzp.io/i/abc")
    monkeypatch.setattr(
        "app.services.email_service.send_subscription_suspended_email",
        lambda to, **kw: calls.append(kw.get("recovery_url")) or True,
    )
    sub = _past_due_sub(db, days_ago=99, email="suspend@test.dev")

    tasks._expire_past_due_cycle(db)

    assert calls == ["https://rzp.io/i/abc"]
    assert "suspended" in (sub.dunning_emails_sent or {})


def test_a_row_still_inside_grace_is_not_expired(db, monkeypatch):
    from app.worker import tasks

    monkeypatch.setattr(tasks, "_suspension_recovery_url", lambda sub: None)
    sub = _past_due_sub(db, days_ago=3, email="ingrace@test.dev")

    assert tasks._expire_past_due_cycle(db) == 0
    assert sub.status == "past_due"


def test_suspension_url_is_none_when_the_gateway_is_unreachable(db, monkeypatch):
    """Falls back to prose rather than rendering a dead button."""
    from app.services import dunning_service
    from app.worker import tasks

    def _boom(_id):
        raise dunning_service.DunningError("down")

    monkeypatch.setattr(dunning_service, "get_recovery_link", _boom)
    sub = _past_due_sub(db, days_ago=99, email="nourl@test.dev")

    assert tasks._suspension_recovery_url(sub) is None


def test_the_quoted_amount_is_the_gross_that_was_actually_debited(db, monkeypatch):
    """Prices are published exclusive of GST, so the base is not what failed.

    Telling a customer "the ₹9,108 charge didn't go through" when ₹10,747.44
    left their account is the same class of error as quoting the monthly figure
    to an annual subscriber, in the one email that has to look credible.
    """
    from app.worker import tasks

    seen: dict = {}
    monkeypatch.setattr(
        "app.services.email_service.send_payment_failed_email",
        lambda to, **kw: seen.update(kw) or True,
    )
    # ``charge_tax_rate_bps`` returns 0 for an unregistered seller (no GSTIN),
    # which is what this test database has. Pin the live 18% so the assertion
    # below tests the uplift rather than an unconfigured no-op.
    monkeypatch.setattr("app.services.seller_profile_service.charge_tax_rate_bps", lambda _s: 1800)
    sub = _past_due_sub(db, days_ago=0, email="gross-amount@test.dev")
    sub.billing_cycle = "annual"
    sub.plan.annual_price_cents = 910800
    db.flush()

    tasks._run_dunning_cycle(db)

    # ₹9,108 base + 18% GST = ₹10,747.44 debited.
    assert "10,747.44" in seen["amount"], seen["amount"]
    # The base is still named, so the figure reconciles against the plan row.
    assert "9,108" in seen["amount"], seen["amount"]


# ── The mandate must die with the subscription ───────────────────────────────
#
# Expiry used to flip ``status`` and deactivate the knowledge base while leaving
# the Razorpay mandate LIVE and merely halted. Halted is inside
# ``RECOVERABLE_GATEWAY_STATES``, so the suspension email rendered a working
# "recover your subscription" button — and if the customer pressed it (or
# Razorpay's own retry finally succeeded) the charge was captured, an invoice
# was written, and ``_handle_subscription_charged`` refused to reactivate an
# expired row. Money in, zero service, recovery only by a manual refund.


def test_expiry_cancels_the_gateway_mandate(db, monkeypatch):
    from app.services import transition_service
    from app.worker import tasks

    monkeypatch.setattr(tasks, "_dunning_send", lambda *a, **kw: True)
    cancelled: list[tuple[int, bool]] = []

    def _fake_cancel(session, sub, *, at_period_end=True):
        cancelled.append((sub.id, at_period_end))
        sub.gateway_cancel_executed_at = datetime.now(UTC)
        return True

    monkeypatch.setattr(transition_service, "execute_gateway_cancellation", _fake_cancel)

    sub = _past_due_sub(db, days_ago=99, email="expire-cancels@test.dev")
    db.commit()
    sub_id = sub.id

    tasks._expire_past_due_cycle(db)

    assert cancelled, "the dunning expiry must retire the mandate, not leave it live and chargeable"
    assert cancelled[0][0] == sub_id
    # IMMEDIATE, not at cycle end: the period has already elapsed unpaid, and a
    # cycle-end cancel leaves Razorpay free to keep retrying until then.
    assert cancelled[0][1] is False


def test_expiry_survives_a_failed_gateway_cancel(db, monkeypatch):
    """The state change is load-bearing; the gateway call is not. A Razorpay
    outage must never leave a customer entitled to a plan they stopped paying
    for — same doctrine as the suspension email."""
    from app.services import razorpay_service, transition_service
    from app.worker import tasks

    monkeypatch.setattr(tasks, "_dunning_send", lambda *a, **kw: True)

    def _boom(session, sub, *, at_period_end=True):
        raise razorpay_service.RazorpayBillingError("gateway down")

    monkeypatch.setattr(transition_service, "execute_gateway_cancellation", _boom)

    sub = _past_due_sub(db, days_ago=99, email="expire-cancel-fails@test.dev")
    db.commit()
    sub_id = sub.id

    assert tasks._expire_past_due_cycle(db) == 1

    db.rollback()
    from app.db.models import Subscription as _Sub

    fresh = db.get(_Sub, sub_id)
    assert fresh.status == "expired"


# ── The figure in a dunning email is the one the customer compares against
#    their bank statement, so it must be the amount actually attempted ────────
#
# ``_dunning_send`` honoured only the CYCLE axis. The admin at-risk queue has
# honoured all three (cycle, rail, standing referral discount) since
# ``_cycle_at_risk_minor``; the customer-facing email did not. So a discounted
# subscriber was quoted the full list price (roughly double their real debit),
# and a USD-rail subscriber was quoted the INR column. A wrong number is what
# makes a dunning email read as phishing — the opposite of its purpose.
#
# Both consumers now share one implementation: ``dunning_service.cycle_charge_minor``.


def _priced_plan(**overrides):
    from app.db.models import Plan as _P

    defaults = dict(
        name="Standard",
        slug="std-cycle-charge",
        monthly_price_cents=94900,
        annual_price_cents=949000,
        monthly_price_usd_cents=1900,
        annual_price_usd_cents=19000,
    )
    defaults.update(overrides)
    return _P(**defaults)


def test_cycle_charge_follows_the_billing_cycle():
    from app.services.dunning_service import cycle_charge_minor

    plan = _priced_plan()
    assert cycle_charge_minor(plan, "monthly", "INR") == 94900
    assert cycle_charge_minor(plan, "annual", "INR") == 949000


def test_cycle_charge_follows_the_rail():
    from app.services.dunning_service import cycle_charge_minor

    plan = _priced_plan()
    assert cycle_charge_minor(plan, "monthly", "USD") == 1900
    assert cycle_charge_minor(plan, "annual", "USD") == 19000


def test_cycle_charge_applies_a_standing_discount_the_way_the_gateway_does():
    from app.services.dunning_service import cycle_charge_minor

    plan = _priced_plan()
    # Mirrors resolve_discounted_plan: base - floor(base × bps / 10000).
    assert cycle_charge_minor(plan, "monthly", "INR", discount_bps=5000) == 94900 - 47450


def test_cycle_charge_reports_a_broken_price_as_unknown_not_zero():
    """A missing price must not print "₹0.00 failed" at a customer who is about
    to lose a real cycle."""
    from app.services.dunning_service import cycle_charge_minor

    assert cycle_charge_minor(_priced_plan(annual_price_usd_cents=None), "annual", "USD") is None
    assert cycle_charge_minor(_priced_plan(annual_price_cents=0), "annual", "INR") is None
    assert cycle_charge_minor(None, "monthly", "INR") is None


def test_the_dunning_email_quotes_the_shared_calculation(db, monkeypatch):
    """`_dunning_send` must route through it rather than re-deriving the price
    from the INR columns alone."""
    from app.services import dunning_service, email_service
    from app.worker import tasks

    captured: dict = {}
    monkeypatch.setattr(email_service, "send_payment_failed_email", lambda to, **kw: captured.update(kw) or True)
    seen: list = []

    def _spy(plan, billing_cycle, currency, discount_bps=0):
        seen.append((billing_cycle, currency, discount_bps))
        return 50000

    monkeypatch.setattr(dunning_service, "cycle_charge_minor", _spy)

    sub = _past_due_sub(db, days_ago=0, email="dun-shared@test.dev")
    sub.billing_cycle = "annual"
    db.flush()
    owner = db.get(Client, sub.client_id)

    tasks._dunning_send("failed_0", owner=owner, sub=sub, plan_name="Standard", days_left=7, rate_bps=1800)

    assert seen, "the email must price the cycle through the shared helper"
    assert seen[0][0] == "annual"
    assert "500" in captured.get("amount", ""), captured
