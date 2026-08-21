"""A workspace that bought extra bot seats must see them in its bot limit,
not just the plan's included count — `Client.extra_bot_seats` exists for
exactly this and nothing read it."""

import pytest

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


def test_extra_bot_seats_add_to_the_plan_limit(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import get_entitlements

    plan = db.query(Plan).filter(Plan.slug == "starter").one_or_none()
    if plan is None:
        plan = Plan(
            name="Starter",
            slug="starter",
            monthly_price_cents=1000,
            limits={"bots": 2, "operators": 1},
            is_active=True,
        )
        db.add(plan)
        db.flush()
    base_bots = plan.limits.get("bots")
    client = Client(
        name="Extra Seats Co",
        email="extraseats@test.example",
        api_key="key-extraseats",
        extra_bot_seats=3,
    )
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["bots"] == base_bots + 3


def test_zero_extra_seats_leaves_the_plan_limit_unchanged(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import get_entitlements

    plan = db.query(Plan).filter(Plan.slug == "starter").one_or_none()
    if plan is None:
        plan = Plan(
            name="Starter",
            slug="starter",
            monthly_price_cents=1000,
            limits={"bots": 2, "operators": 1},
            is_active=True,
        )
        db.add(plan)
        db.flush()
    base_bots = plan.limits.get("bots")
    client = Client(name="No Extras Co", email="noextras@test.example", api_key="key-noextras")
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["bots"] == base_bots


def test_unlimited_plan_stays_unlimited_regardless_of_extra_seats(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import UNLIMITED, get_entitlements

    plan = db.query(Plan).filter(Plan.slug == "enterprise").one_or_none()
    if plan is None:
        plan = Plan(
            name="Enterprise",
            slug="enterprise",
            monthly_price_cents=5000,
            limits={"bots": UNLIMITED, "operators": UNLIMITED},
            is_active=True,
        )
        db.add(plan)
        db.flush()
    assert plan.limits.get("bots") == UNLIMITED, "this test assumes Enterprise bots is unlimited"
    client = Client(
        name="Enterprise Extras Co",
        email="entextras@test.example",
        api_key="key-entextras",
        extra_bot_seats=5,
    )
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["bots"] == UNLIMITED
