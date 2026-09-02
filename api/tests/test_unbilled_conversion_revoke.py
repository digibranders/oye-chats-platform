"""A mid-trial purchase whose first debit fails must not keep the paid period.

``_revoke_unpaid_activation_grant`` exists because a UPI ``subscription.activated``
grants a period's credits BEFORE the first debit. It anchors on
``current_period_start``, and Razorpay writes that field at the first real
debit and nowhere else. The one shape that ALWAYS pre-grants is the mid-trial
conversion, whose mandate starts in the future, so its ``current_period_start``
is exactly ``None`` and the guard returned early on precisely the case the
function was written for.

The result was a self-serve monetisation bypass. Convert on day 3 of a trial,
let the day-14 debit fail, and the account holds a full paid allowance through
the whole ``past_due`` grace window having paid nothing. ``past_due`` is a live
subscription status, so entitlements stay at the purchased tier throughout, and
the expiry cron that ends the window never touches the ledger.

The cancel path already understood this state: ``_was_unbilled_trial_conversion``
is exactly "the conversion marker is set and no debit has landed". The revoke
path simply never asked.
"""

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, Invoice, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

PAID_CREDITS = 10_000


def _client(db, email):
    c = Client(name="C", email=email, api_key=f"k-{email}", hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db):
    p = Plan(
        name="Professional",
        slug=f"pro-{datetime.now(UTC).timestamp()}",
        monthly_price_cents=139900,
        credits_per_month=PAID_CREDITS,
        is_active=True,
    )
    db.add(p)
    db.flush()
    return p


def _converted_mid_trial(db, client, plan, *, rzp_id, marker_set=True):
    """The state a day-3 conversion leaves behind.

    Credits granted at authentication, marker advanced to the deferred
    period's end, and NO ``current_period_start``: the debit has not happened.
    """
    first_debit = datetime.now(UTC) + timedelta(days=11)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id=rzp_id,
        billing_cycle="monthly",
        current_period_start=None,  # Razorpay writes this at the first debit
        current_period_end=first_debit,
        last_granted_period_end=first_debit + timedelta(days=30),
    )
    if marker_set:
        sub.trial_emails_sent = {rzp.TRIAL_CONVERSION_GRANT_MARKER: first_debit.isoformat()}
    sub.plan = plan
    db.add(sub)
    db.flush()
    credit_service.grant_plan_credits(db, client.id, PAID_CREDITS, bot_id=None)
    db.flush()
    return sub


def _halted(rzp_id):
    return {"subscription": {"entity": {"id": rzp_id}}}


def test_a_failed_first_debit_takes_back_the_unpaid_period(db):
    client = _client(db, "convert-halt@example.test")
    sub = _converted_mid_trial(db, client, _plan(db), rzp_id="sub_conv_1")
    assert credit_service.get_balance(db, client.id) == PAID_CREDITS

    rzp._handle_subscription_halted(db, _halted("sub_conv_1"))
    db.flush()

    assert credit_service.get_balance(db, client.id) == 0
    assert sub.status == "past_due"


def test_a_successful_retry_can_still_grant_afterwards(db):
    """The revoke must leave the row re-grantable, not permanently poisoned.

    Rolling the marker back to ``None`` is what allows that: the monotonic
    guard in `grant_subscription_period_once` only short-circuits on a marker
    that is not None.
    """
    client = _client(db, "convert-retry@example.test")
    sub = _converted_mid_trial(db, client, _plan(db), rzp_id="sub_conv_2")
    rzp._handle_subscription_halted(db, _halted("sub_conv_2"))
    db.flush()
    assert credit_service.get_balance(db, client.id) == 0

    granted = credit_service.grant_subscription_period_once(db, sub, datetime.now(UTC) + timedelta(days=41))
    db.flush()

    assert granted is True
    assert credit_service.get_balance(db, client.id) == PAID_CREDITS


def test_a_redelivered_halted_does_not_revoke_twice(db):
    client = _client(db, "convert-idem@example.test")
    _converted_mid_trial(db, client, _plan(db), rzp_id="sub_conv_3")
    rzp._handle_subscription_halted(db, _halted("sub_conv_3"))
    db.flush()
    credit_service.grant_topup(db, client.id, 250)
    db.flush()

    rzp._handle_subscription_halted(db, _halted("sub_conv_3"))
    db.flush()

    # The purchased top-up is untouched by a second delivery.
    assert credit_service.get_balance(db, client.id) == 250


def test_pending_behaves_like_halted(db):
    client = _client(db, "convert-pending@example.test")
    _converted_mid_trial(db, client, _plan(db), rzp_id="sub_conv_4")

    rzp._handle_subscription_pending(db, _halted("sub_conv_4"))
    db.flush()

    assert credit_service.get_balance(db, client.id) == 0


def test_a_conversion_that_did_bill_is_left_alone(db):
    """A paid charge means the period was paid for. Nothing to reverse."""
    client = _client(db, "convert-paid@example.test")
    plan = _plan(db)
    sub = _converted_mid_trial(db, client, plan, rzp_id="sub_conv_5")
    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=sub.id,
            amount_cents=165082,
            currency="inr",
            status="paid",
            kind="plan_charge",
            razorpay_payment_id="pay_conv_5",
        )
    )
    db.flush()

    rzp._handle_subscription_halted(db, _halted("sub_conv_5"))
    db.flush()

    assert credit_service.get_balance(db, client.id) == PAID_CREDITS


def test_a_row_without_the_conversion_marker_is_not_touched(db):
    """`current_period_start is None` alone must not authorise a revoke.

    The marker is what distinguishes "granted ahead of a debit that never
    came" from any other row that happens to be missing a period anchor.
    """
    client = _client(db, "convert-nomarker@example.test")
    _converted_mid_trial(db, client, _plan(db), rzp_id="sub_conv_6", marker_set=False)

    rzp._handle_subscription_halted(db, _halted("sub_conv_6"))
    db.flush()

    assert credit_service.get_balance(db, client.id) == PAID_CREDITS
