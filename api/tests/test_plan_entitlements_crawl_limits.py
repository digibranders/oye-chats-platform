"""The plan's crawl page/depth cap rides in the entitlements payload the
console already fetches, so WebsiteFlow can show it before a crawl starts
instead of only after one is rejected."""

import pytest

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


def test_entitlements_limits_include_crawl_page_and_depth_caps(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import get_entitlements

    plan = db.query(Plan).filter(Plan.slug == "starter").one_or_none()
    if plan is None:
        plan = Plan(
            name="Starter",
            slug="starter",
            monthly_price_cents=1000,
            limits={"max_crawl_pages": 100, "max_crawl_depth": 3},
            is_active=True,
        )
        db.add(plan)
        db.flush()

    client = Client(name="Crawl Cap Co", email="crawlcap@test.example", api_key="key-crawlcap")
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["max_crawl_pages"] == plan.limits.get("max_crawl_pages")
    assert entitlements.limits["max_crawl_depth"] == plan.limits.get("max_crawl_depth")


def test_entitlements_limits_default_when_crawl_keys_missing_from_plan(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import UNLIMITED, get_entitlements

    plan = Plan(
        name="Custom",
        slug="custom-no-crawl",
        monthly_price_cents=1000,
        limits={"bots": 1},
        is_active=True,
    )
    db.add(plan)
    db.flush()

    client = Client(name="Custom Co", email="custom@test.example", api_key="key-custom")
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["max_crawl_pages"] == UNLIMITED
    assert entitlements.limits["max_crawl_depth"] == UNLIMITED
