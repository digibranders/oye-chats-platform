"""Billing MUTATIONS resolve the same subscription the page displays.

The read path (``/subscription/current``) falls back to the account plan when
the selected agent has no subscription of its own. The write path did not, so
Billing rendered the account plan next to Cancel / Reactivate / Add-seat
buttons that every one of them answered with 404 "No active subscription
found" — the exact symptom reported against the Cancel modal.

Read and write must agree, or the UI offers actions it cannot perform.
"""

import os

import pytest

from app.db.models import Bot, Client, Plan, Subscription

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db, email):
    row = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(row)
    db.flush()
    return row


def _plan(db, slug, price=139900):
    plan = Plan(
        name="Professional",
        slug=slug,
        monthly_price_cents=price,
        credits_per_month=10000,
        included_operator_seats=3,
        is_active=True,
    )
    db.add(plan)
    db.flush()
    return plan


def _bot(db, client, key):
    bot = Bot(client_id=client.id, bot_key=key, name="Agent")
    db.add(bot)
    db.flush()
    return bot


def _sub(db, client, plan, *, bot_id=None, status="active"):
    sub = Subscription(client_id=client.id, plan_id=plan.id, bot_id=bot_id, status=status)
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def test_agent_without_its_own_subscription_falls_back_to_the_account_plan(db):
    """The reported bug: an agent selected in the switcher made Cancel 404."""
    from app.api.subscription_routes import _resolve_target_subscription

    client = _client(db, "mut-fallback@e.com")
    plan = _plan(db, "pro-mut-fallback")
    account_sub = _sub(db, client, plan)
    bot = _bot(db, client, "bot-mut-fallback")

    resolved = _resolve_target_subscription(db, client.id, bot.id)

    assert resolved is not None, "Cancel/Resume/Seats would 404 here"
    assert resolved.id == account_sub.id


def test_agent_with_its_own_subscription_is_still_targeted_precisely(db):
    """The fallback must not clobber genuine per-agent targeting."""
    from app.api.subscription_routes import _resolve_target_subscription

    client = _client(db, "mut-scoped@e.com")
    account_plan = _plan(db, "pro-mut-scoped-acct")
    bot_plan = _plan(db, "pro-mut-scoped-bot", price=94900)
    _sub(db, client, account_plan)
    bot = _bot(db, client, "bot-mut-scoped")
    bot_sub = _sub(db, client, bot_plan, bot_id=bot.id)

    resolved = _resolve_target_subscription(db, client.id, bot.id)

    assert resolved.id == bot_sub.id


def test_no_bot_id_targets_the_account_subscription(db):
    from app.api.subscription_routes import _resolve_target_subscription

    client = _client(db, "mut-none@e.com")
    plan = _plan(db, "pro-mut-none")
    account_sub = _sub(db, client, plan)

    assert _resolve_target_subscription(db, client.id, None).id == account_sub.id


def test_a_client_with_no_subscription_at_all_still_resolves_to_none(db):
    """The 404 is correct here — there is genuinely nothing to act on."""
    from app.api.subscription_routes import _resolve_target_subscription

    client = _client(db, "mut-empty@e.com")
    bot = _bot(db, client, "bot-mut-empty")

    assert _resolve_target_subscription(db, client.id, bot.id) is None


def test_a_foreign_bot_id_never_reaches_another_workspace(db):
    """get_subscription_for_bot filters by client_id, so a foreign bot resolves
    to None and we fall back to the CALLER's own account subscription — never
    the other workspace's."""
    from app.api.subscription_routes import _resolve_target_subscription

    owner = _client(db, "mut-owner@e.com")
    other = _client(db, "mut-other@e.com")
    owner_plan = _plan(db, "pro-mut-owner")
    other_plan = _plan(db, "pro-mut-other", price=94900)
    owner_sub = _sub(db, owner, owner_plan)
    other_bot = _bot(db, other, "bot-mut-other")
    _sub(db, other, other_plan, bot_id=other_bot.id)

    resolved = _resolve_target_subscription(db, owner.id, other_bot.id)

    assert resolved.id == owner_sub.id
    assert resolved.client_id == owner.id


def test_read_and_write_paths_agree_on_the_same_subscription(db):
    """The invariant behind the bug. If these two ever diverge again, Billing
    shows one plan and acts on another (or on nothing)."""
    from app.api.subscription_routes import _resolve_target_subscription
    from app.services.plan_service import get_client_subscription, get_subscription_for_bot

    client = _client(db, "mut-agree@e.com")
    plan = _plan(db, "pro-mut-agree")
    _sub(db, client, plan)
    bot = _bot(db, client, "bot-mut-agree")

    # What /subscription/current renders for this bot.
    displayed = get_subscription_for_bot(db, client.id, bot.id) or get_client_subscription(db, client.id)
    # What a mutation would act on.
    targeted = _resolve_target_subscription(db, client.id, bot.id)

    assert displayed is not None
    assert targeted is not None
    assert displayed.id == targeted.id
