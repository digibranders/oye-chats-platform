"""Outbound webhooks are a paid feature. Enforced at DELIVERY time, not just
at registration.

``webhook_routes`` gates webhook CREATION on the ``webhooks`` plan feature, but
that only blocks new registrations. A ``Webhook`` row registered on a paid tier
would otherwise keep firing forever after the customer downgrades to a tier that
lacks the feature (e.g. Standard/Professional -> Starter). ``fire_webhook`` must
consult live plan entitlements on every dispatch and skip when the owning
client's plan no longer includes ``webhooks``.
"""

import os
from contextlib import contextmanager

import pytest

from app.db.models import Bot, Client, Plan, Subscription, Webhook
from app.services import plan_entitlements_service, webhook_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_EVENT = "lead_captured"


def _setup(db, email, *, webhooks_enabled: bool):
    """Create a client on a plan with/without the ``webhooks`` feature, a bot,
    an active subscription, and an active webhook subscribed to ``_EVENT``.
    Returns the bot id."""
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()

    plan = Plan(
        name="Gate Plan",
        slug=f"gate-{email}",
        monthly_price_cents=44900,
        credits_per_month=2000,
        included_operator_seats=1,
        is_active=True,
        features={"webhooks": webhooks_enabled},
    )
    db.add(plan)
    db.flush()

    sub = Subscription(client_id=client.id, plan_id=plan.id, status="active")
    sub.plan = plan
    db.add(sub)

    bot = Bot(client_id=client.id, bot_key=f"bot-{email}", name="Agent")
    db.add(bot)
    db.flush()

    db.add(
        Webhook(
            bot_id=bot.id,
            url="https://example.com/hook",
            secret="s",
            events=[_EVENT],
            is_active=True,
        )
    )
    db.flush()
    return bot.id


@pytest.fixture()
def fire_against(db, monkeypatch):
    """Run ``fire_webhook`` against the test session and capture queued deliveries.

    ``fire_webhook`` opens its own ``get_session()`` (a different DB than the
    test fixture) and reads entitlements through the 60s Redis cache. Point both
    at the test session / disable the cache so the assertion reflects the plan
    gate alone, not cross-session visibility or a stale cache from a sibling
    test (ids reset to 1 between tests)."""

    @contextmanager
    def _ctx():
        yield db

    queued: list[int] = []
    monkeypatch.setattr(webhook_service, "get_session", _ctx)
    monkeypatch.setattr(plan_entitlements_service, "get_redis", lambda: None)
    monkeypatch.setattr(webhook_service, "queue_webhook_delivery", lambda wid, *a, **k: queued.append(wid))
    return queued


def test_downgraded_plan_skips_webhook_dispatch(db, fire_against):
    """A plan without the ``webhooks`` feature must not queue any delivery."""
    bot_id = _setup(db, "no-webhooks@example.com", webhooks_enabled=False)

    webhook_service.fire_webhook(bot_id, _EVENT, {"lead": "x"})

    assert fire_against == [], "webhook fired despite the plan lacking the 'webhooks' feature"


def test_paid_plan_still_dispatches_webhook(db, fire_against):
    """A plan WITH the ``webhooks`` feature must still queue the delivery, the
    gate must not break the happy path."""
    bot_id = _setup(db, "has-webhooks@example.com", webhooks_enabled=True)

    webhook_service.fire_webhook(bot_id, _EVENT, {"lead": "x"})

    assert len(fire_against) == 1, "webhook did not fire for a plan that includes the 'webhooks' feature"
