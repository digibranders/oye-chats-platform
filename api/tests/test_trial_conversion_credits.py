"""Converting from a trial must not cost the customer their unused trial credits.

``grant_subscription_period_once`` resets the prior period's unused plan grant
before granting the new one, so a renewal cannot roll last month's allowance
into this month. Trial credits are a ``plan_grant`` too, so that reset also fired
on the FIRST grant of a paid subscription and zeroed whatever was left of the
trial: someone three days into a 14-day trial with 400 of 500 credits remaining
converted to Starter and landed on 1000 rather than 1400. They lost credits by
paying, on the day they paid.

These pin all three behaviours at once, because the fix for the first could
easily break the third.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, Plan, Subscription
from app.services import credit_service as cs

pytestmark = pytest.mark.usefixtures("db")

TRIAL_CREDITS = 500
STARTER_CREDITS = 1000


def _client(db) -> Client:
    stamp = datetime.now(UTC).timestamp()
    client = Client(
        name="Converter",
        email=f"convert{stamp}@example.test",
        hashed_password="x",
        api_key=f"key{stamp}",
    )
    db.add(client)
    db.flush()
    return client


def _starter(db) -> Plan:
    plan = db.query(Plan).filter(Plan.slug == "starter").one_or_none()
    if plan is None:
        plan = Plan(
            slug="starter",
            name="Starter",
            credits_per_month=STARTER_CREDITS,
            monthly_price_cents=59900,
            annual_price_cents=574800,
            limits={"credits": STARTER_CREDITS},
            features={},
        )
        db.add(plan)
        db.flush()
    return plan


def _trial_grant_with_some_spent(db, client: Client, spend: int):
    """A trial allowance partway through its window."""
    grant = cs.grant_plan_credits(db, client.id, TRIAL_CREDITS, note="trial")
    grant.expires_at = datetime.now(UTC) + timedelta(days=14)
    db.flush()
    cs.check_and_deduct(db, client.id, spend, reason="ai_chat")
    db.flush()
    return grant


def _convert(db, client: Client, plan: Plan) -> Subscription:
    """The first grant of a paid subscription, which is what conversion is."""
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        billing_cycle="monthly",
        last_granted_period_end=None,
    )
    db.add(sub)
    db.flush()
    # `preserve_prior_credits` is what the trial-conversion path passes; a
    # renewal and a lapse to Free both leave it False.
    cs.grant_subscription_period_once(db, sub, datetime.now(UTC) + timedelta(days=30), preserve_prior_credits=True)
    db.flush()
    return sub


def test_converting_mid_trial_keeps_the_unused_trial_credits(db):
    client = _client(db)
    _trial_grant_with_some_spent(db, client, spend=100)
    assert cs.get_balance(db, client.id) == 400

    _convert(db, client, _starter(db))

    assert cs.get_balance(db, client.id) == 400 + STARTER_CREDITS


def test_the_trial_credits_are_spent_before_the_plan_credits(db):
    """They expire first, so spending them last would waste them.

    `_grants_for` orders plan grants by `expires_at` ascending, and the trial
    window closes before the paid period does.
    """
    client = _client(db)
    trial = _trial_grant_with_some_spent(db, client, spend=100)
    _convert(db, client, _starter(db))

    plan_grant = next(g for g in cs._grants_for(db, client.id) if g.id != trial.id and g.reason == "plan_grant")

    cs.check_and_deduct(db, client.id, 400, reason="ai_chat")
    db.flush()

    assert trial.delta - cs._consumed_against(db, trial.id) == 0
    assert plan_grant.delta - cs._consumed_against(db, plan_grant.id) == STARTER_CREDITS


def test_a_renewal_still_does_not_roll_last_period_over(db):
    """The reset's actual job, which the trial fix must not disable.

    Skipping the reset on EVERY grant rather than only the subscription's first
    would hand every renewing customer two months of credits at once.
    """
    client = _client(db)
    plan = _starter(db)
    sub = _convert(db, client, plan)
    period_end = sub.last_granted_period_end
    assert period_end is not None

    # Renew without spending anything: the unused allowance must not carry.
    cs.grant_subscription_period_once(db, sub, period_end + timedelta(days=30))
    db.flush()

    assert cs.get_balance(db, client.id) == STARTER_CREDITS


def test_a_topup_survives_a_renewal(db):
    """Top-ups are bought, not granted, and were never in the reset's scope."""
    client = _client(db)
    plan = _starter(db)
    sub = _convert(db, client, plan)
    cs.grant_topup(db, client.id, 250)
    db.flush()
    period_end = sub.last_granted_period_end
    assert period_end is not None

    cs.grant_subscription_period_once(db, sub, period_end + timedelta(days=30))
    db.flush()

    assert cs.get_balance(db, client.id) == STARTER_CREDITS + 250
