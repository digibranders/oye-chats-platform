"""The operator-seat gate must read the limit at the SAME scope it counts.

`POST /operators` counts operators bound to `request.bot_id` — a deliberately
per-bot count, so each agent has its own allowance. It used to read the LIMIT
from `get_entitlements(client_id, ...)`, the ACCOUNT view, which resolves
through `plan_service.get_client_subscription` — the highest-PRICED subscription
across every scope.

For a workspace with per-bot subscriptions the two disagree, in both directions:

* Seats bought on a cheaper agent's subscription raised `operator_quantity` on
  THAT row, while the gate kept reading the pricier agent's row. The customer
  was charged monthly and the seats never appeared anywhere.
* Conversely one purchase on the priciest row raised the account limit, and
  because the count is per-bot, every other agent silently gained the same
  extra capacity for free.

Both vanish once the gate resolves the limit from the subscription that funds
the bot being counted — which is exactly what `get_bot_entitlements` is for.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os

import pytest

from app.db.models import Bot, Client, Plan, Subscription
from app.services import plan_entitlements_service

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="operator seat scope tests need a reachable Postgres at DB_URL",
)


def _plan(db, *, slug: str, price: int, seats: int) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=price,
        credits_per_month=1000,
        included_operator_seats=seats,
        is_active=True,
        limits={"operators": 50},
    )
    db.add(plan)
    db.flush()
    return plan


def _bot_with_sub(db, client, plan, *, key: str, operator_quantity: int) -> Bot:
    bot = Bot(client_id=client.id, bot_key=key, name=key)
    db.add(bot)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot.id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=operator_quantity,
        payment_provider="razorpay",
        razorpay_subscription_id=f"sub_{key}",
    )
    db.add(sub)
    db.flush()
    bot.subscription_id = sub.id
    db.flush()
    return bot


def test_seats_bought_on_a_cheaper_agent_raise_that_agents_limit(db):
    """The purchase lands on the agent it was made for, even when a pricier
    sibling subscription exists."""
    client = Client(name="c", email="seat-scope@e.com", api_key="seat-scope", hashed_password="h")
    db.add(client)
    db.flush()
    pro = _plan(db, slug="pro-seatscope", price=299900, seats=1)
    starter = _plan(db, slug="starter-seatscope", price=94900, seats=1)

    # The pricier agent has NO extra seats; the cheaper one bought two.
    pricey = _bot_with_sub(db, client, pro, key="bot-pricey", operator_quantity=1)
    cheap = _bot_with_sub(db, client, starter, key="bot-cheap", operator_quantity=3)
    db.commit()

    cheap_limit = plan_entitlements_service.get_bot_entitlements(cheap.id, db, use_cache=False).limit_for("operators")
    pricey_limit = plan_entitlements_service.get_bot_entitlements(pricey.id, db, use_cache=False).limit_for("operators")

    assert cheap_limit == 3, "the agent the seats were bought for must get them"
    assert pricey_limit == 1, "an agent that bought no seats must not inherit a sibling's"


def test_the_account_view_is_the_one_that_disagrees(db):
    """Pins WHY the gate had to change scope: the account view resolves the
    highest-priced subscription, so it reports the pricey agent's seat count for
    every agent — the exact number the per-bot count is then compared against."""
    client = Client(name="c", email="seat-scope-acct@e.com", api_key="seat-scope-acct", hashed_password="h")
    db.add(client)
    db.flush()
    pro = _plan(db, slug="pro-seatscope-acct", price=299900, seats=1)
    starter = _plan(db, slug="starter-seatscope-acct", price=94900, seats=1)
    _bot_with_sub(db, client, pro, key="bot-pricey-acct", operator_quantity=1)
    cheap = _bot_with_sub(db, client, starter, key="bot-cheap-acct", operator_quantity=3)
    db.commit()

    account_limit = plan_entitlements_service.get_entitlements(client.id, db, use_cache=False).limit_for("operators")
    bot_limit = plan_entitlements_service.get_bot_entitlements(cheap.id, db, use_cache=False).limit_for("operators")

    # The account view follows the PRICIEST row (Professional, 1 seat) and so
    # cannot see the seats the customer actually bought on the Starter agent.
    assert account_limit == 1
    assert bot_limit == 3
    assert account_limit != bot_limit


# ── The gate itself ──────────────────────────────────────────────────────────
#
# The two tests above only prove the two SCOPES disagree. The defect was that
# the gate picked the wrong one, so that is what this pins: the helper the route
# uses to resolve the allowance must follow the bot whose roster it is about to
# count.


def test_the_gate_resolves_the_limit_from_the_bots_own_subscription(db):
    from app.api.operator_routes import resolve_operator_seat_limit

    client = Client(name="c", email="seat-gate@e.com", api_key="seat-gate", hashed_password="h")
    db.add(client)
    db.flush()
    pro = _plan(db, slug="pro-seatgate", price=299900, seats=1)
    starter = _plan(db, slug="starter-seatgate", price=94900, seats=1)
    pricey = _bot_with_sub(db, client, pro, key="bot-pricey-gate", operator_quantity=1)
    cheap = _bot_with_sub(db, client, starter, key="bot-cheap-gate", operator_quantity=3)
    db.commit()

    # The seats were bought on the Starter agent; the gate must see them there…
    assert resolve_operator_seat_limit(db, client.id, cheap.id) == 3
    # …and must NOT hand them to the sibling that never bought any.
    assert resolve_operator_seat_limit(db, client.id, pricey.id) == 1


def test_the_gate_falls_back_to_the_account_plan_for_an_unfunded_agent(db):
    """An agent with no subscription of its own draws on the account plan, so
    the allowance must come from there rather than resolving to Free."""
    from app.api.operator_routes import resolve_operator_seat_limit

    client = Client(name="c", email="seat-gate-fallback@e.com", api_key="seat-gate-fb", hashed_password="h")
    db.add(client)
    db.flush()
    pro = _plan(db, slug="pro-seatgate-fb", price=299900, seats=2)
    account_sub = Subscription(
        client_id=client.id,
        plan_id=pro.id,
        bot_id=None,
        status="active",
        billing_cycle="monthly",
        operator_quantity=5,
        payment_provider="razorpay",
        razorpay_subscription_id="sub_acct_fb",
    )
    db.add(account_sub)
    db.flush()
    orphan = Bot(client_id=client.id, bot_key="bot-orphan-fb", name="orphan")
    db.add(orphan)
    db.commit()

    assert resolve_operator_seat_limit(db, client.id, orphan.id) == 5
