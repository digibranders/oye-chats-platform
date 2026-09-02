"""The Billing meter must not invent consumption that never happened.

The card used to derive "how much of your allowance is gone" as
``plan.credits_per_month - <ledger balance>``: a plan-catalogue constant minus
a ledger figure. That subtraction is only meaningful when the period's grant
was actually issued AND equals the constant, and there are reachable states
where it isn't. An account whose grant never landed (both signup paths swallow
a failed ``assign_default_plan_to_client``) has a 500-credit plan and an empty
ledger, so the meter rendered a full red bar reading "500 / 500 credits" beside
"Spent this period 0" — two numbers on one card contradicting each other, under
the words "Your chatbots have stopped answering".

``plan_granted`` is the missing figure: what the ledger actually issued. With
it the meter is one source subtracted from itself, so it can only ever report
real consumption.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client
from app.services import credit_service as cs

pytestmark = pytest.mark.usefixtures("db")


def _client(db) -> Client:
    stamp = datetime.now(UTC).timestamp()
    client = Client(
        name="Allowance",
        email=f"allowance{stamp}@example.test",
        hashed_password="x",
        api_key=f"key{stamp}",
    )
    db.add(client)
    db.flush()
    return client


def test_an_ungranted_account_reports_nothing_issued(db):
    """The state behind the misleading card: a plan, but no grant.

    ``plan_granted`` of 0 is what lets the UI tell "never issued" apart from
    "issued and spent", which are the same balance and opposite messages.
    """
    client = _client(db)

    breakdown = cs.get_balance_breakdown(db, client.id)

    assert breakdown["plan_granted"] == 0
    assert breakdown["plan"] == 0


def test_the_issued_allowance_is_reported_before_anything_is_spent(db):
    client = _client(db)
    cs.grant_plan_credits(db, client.id, 500, note="trial")
    db.flush()

    breakdown = cs.get_balance_breakdown(db, client.id)

    assert breakdown["plan_granted"] == 500
    assert breakdown["plan"] == 500


def test_a_fully_spent_allowance_still_reports_what_was_issued(db):
    """The opposite failure, and why the figure cannot come from the balance.

    ``_grants_for`` skips a grant with nothing left on it, so accumulating only
    what survives would report 0 issued for someone who spent all 500 — the
    meter would empty itself at exactly the moment it should read full.
    """
    client = _client(db)
    cs.grant_plan_credits(db, client.id, 500, note="trial")
    db.flush()
    cs.check_and_deduct(db, client.id, 500, reason="ai_chat")
    db.flush()

    breakdown = cs.get_balance_breakdown(db, client.id)

    assert breakdown["plan_granted"] == 500
    assert breakdown["plan"] == 0


def test_partial_spend_is_the_difference_between_the_two(db):
    client = _client(db)
    cs.grant_plan_credits(db, client.id, 500, note="trial")
    db.flush()
    cs.check_and_deduct(db, client.id, 120, reason="ai_chat")
    db.flush()

    breakdown = cs.get_balance_breakdown(db, client.id)

    assert breakdown["plan_granted"] - breakdown["plan"] == 120


def test_purchased_credits_are_not_part_of_the_plan_allowance(db):
    """The meter measures the plan's monthly grant, not the wallet."""
    client = _client(db)
    cs.grant_plan_credits(db, client.id, 500, note="trial")
    cs.grant_topup(db, client.id, 250)
    db.flush()

    breakdown = cs.get_balance_breakdown(db, client.id)

    assert breakdown["plan_granted"] == 500
    assert breakdown["topup"] == 250


def test_an_expired_allowance_is_no_longer_reported_as_issued(db):
    """It has to drop out in step with the balance it explains.

    A lapsed trial keeps its spent grant row. Counting it as issued while its
    remaining credits are excluded would put the meter back where it started:
    claiming a full period's consumption against a plan nobody is on.
    """
    client = _client(db)
    grant = cs.grant_plan_credits(db, client.id, 500, note="trial")
    grant.expires_at = datetime.now(UTC) - timedelta(days=1)
    db.flush()

    breakdown = cs.get_balance_breakdown(db, client.id)

    assert breakdown["plan_granted"] == 0
    assert breakdown["plan"] == 0
