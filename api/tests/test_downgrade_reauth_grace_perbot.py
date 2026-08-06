"""Per-bot downgrade re-auth grace row is cancelled at activation.

The downgrade cutover mints a short-lived ``past_due`` GRACE subscription on the
target plan (``transition_service.promote_scheduled_change``). For an ACCOUNT
downgrade that row has ``bot_id IS NULL`` and the account-level sibling-cancel
sweep in ``_handle_subscription_activated`` clears it at re-auth. For a PER-BOT
downgrade the grace row is bot-scoped (``bot_id`` set), and a plain re-auth lands
in that same account-level branch (no ``per_bot``/``revive`` purpose note) with
``funded_bot_id`` None — so the ``bot_id IS NULL`` sweep never touches it and the
grace row would linger orphaned.

The activation handler recovers that bot-scoped grace row via the
``prev_razorpay_subscription_id`` link it shares with the activating mandate and
cancels it through ``transition_service.cancel_bot_scoped_reauth_grace`` before
inserting the new row. These tests pin that behaviour.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from app.db.models import Bot, Client, Plan, Subscription
from app.services import razorpay_service as rzp
from app.services.transition_service import DOWNGRADE_REAUTH_GRACE_REASON

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="per-bot downgrade re-auth grace tests need a reachable Postgres at DB_URL",
)

_OLD_MANDATE = "sub_old_perbot_grace"


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=44900,
        annual_price_cents=449000,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
    )
    db.add(plan)
    db.flush()
    return plan


def _make_bot(db, client, *, key: str) -> Bot:
    bot = Bot(client_id=client.id, bot_key=key, name="Agent")
    db.add(bot)
    db.flush()
    return bot


def _make_grace_row(db, client, plan, *, bot_id: int | None, prev_mandate: str) -> Subscription:
    """A bot-scoped downgrade re-auth grace row as promote_scheduled_change mints it."""
    now = datetime(2026, 1, 31, tzinfo=UTC)
    grace = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot_id,
        status="past_due",
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=now,
        current_period_end=datetime(2026, 2, 28, tzinfo=UTC),
        past_due_since=now,
        payment_provider="razorpay",
        razorpay_subscription_id=None,
        prev_razorpay_subscription_id=prev_mandate,
        cancel_reason=DOWNGRADE_REAUTH_GRACE_REASON,
    )
    grace.plan = plan
    db.add(grace)
    db.flush()
    return grace


def _activation_payload(*, razorpay_sub_id: str, client_id: int, plan_id: int, prev_sub_id: str) -> dict:
    return {
        "subscription": {
            "entity": {
                "id": razorpay_sub_id,
                "notes": {
                    "oyechats_client_id": str(client_id),
                    "oyechats_plan_id": str(plan_id),
                    "prev_razorpay_subscription_id": prev_sub_id,
                },
                "current_start": int(datetime(2026, 2, 1, tzinfo=UTC).timestamp()),
                "current_end": int(datetime(2026, 2, 28, tzinfo=UTC).timestamp()),
                "quantity": 1,
                "customer_id": "cust_test",
            }
        }
    }


def test_perbot_grace_row_is_cancelled_at_reauth_activation(db):
    client = _make_client(db, email="perbot-grace@e.com")
    starter = _make_plan(db, slug="starter-perbot-grace")
    bot = _make_bot(db, client, key="bot-perbot-grace")
    grace = _make_grace_row(db, client, starter, bot_id=bot.id, prev_mandate=_OLD_MANDATE)
    db.commit()

    payload = _activation_payload(
        razorpay_sub_id="sub_new_perbot_grace",
        client_id=client.id,
        plan_id=starter.id,
        prev_sub_id=_OLD_MANDATE,
    )
    with patch.object(rzp, "_get_razorpay", return_value=MagicMock()):
        rzp._handle_subscription_activated(db, payload)
    db.commit()

    db.refresh(grace)
    assert grace.status == "canceled", "the bot-scoped grace row must be cancelled at re-auth activation"

    # The new authorized subscription for the target plan now exists and is active.
    new_active = (
        db.execute(
            select(Subscription).where(
                Subscription.client_id == client.id,
                Subscription.razorpay_subscription_id == "sub_new_perbot_grace",
            )
        )
        .scalars()
        .one()
    )
    assert new_active.status == "active"
    assert new_active.plan_id == starter.id


def test_activation_without_matching_grace_row_leaves_others_untouched(db):
    """The cleanup is narrowly scoped: a grace row for a DIFFERENT prior mandate
    is not cancelled by an unrelated activation."""
    client = _make_client(db, email="perbot-grace-scope@e.com")
    starter = _make_plan(db, slug="starter-perbot-scope")
    bot = _make_bot(db, client, key="bot-perbot-scope")
    other_grace = _make_grace_row(db, client, starter, bot_id=bot.id, prev_mandate="sub_some_other_mandate")
    db.commit()

    payload = _activation_payload(
        razorpay_sub_id="sub_new_perbot_scope",
        client_id=client.id,
        plan_id=starter.id,
        prev_sub_id=_OLD_MANDATE,  # does NOT match other_grace's prev mandate
    )
    with patch.object(rzp, "_get_razorpay", return_value=MagicMock()):
        rzp._handle_subscription_activated(db, payload)
    db.commit()

    db.refresh(other_grace)
    assert other_grace.status == "past_due", "an unrelated grace row must not be cancelled"
