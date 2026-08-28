"""Per-bot downgrade re-auth grace row is cancelled at activation.

The downgrade cutover mints a short-lived ``past_due`` GRACE subscription on the
target plan (``transition_service.promote_scheduled_change``). For an ACCOUNT
downgrade that row has ``bot_id IS NULL`` and the account-level sibling-cancel
sweep in ``_handle_subscription_activated`` clears it at re-auth. For a PER-BOT
downgrade the grace row is bot-scoped (``bot_id`` set), and a plain re-auth lands
in that same account-level branch (no ``per_bot``/``revive`` purpose note) with
``funded_bot_id`` None, so the ``bot_id IS NULL`` sweep never touches it and the
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
from app.services import transition_service
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


# ── P0: the promoted per-bot replacement must carry bot scope ─────────────────
#
# ``promote_scheduled_change`` used to mint the re-auth mandate with only
# ``prev_razorpay_subscription_id`` + ``carried_seat_count`` in its notes, even
# for a BOT-SCOPED subscription. The activation handler then saw no per-bot
# markers, took the account-level branch, and its sibling sweep — scoped
# ``bot_id IS NULL`` — cancelled the client's live ACCOUNT subscription and
# gateway-cancelled its mandate. A per-bot downgrade cutover could kill an
# unrelated Enterprise mandate, irreversibly.


class _FakeCreateSub:
    """Stub for ``razorpay_service.create_subscription`` capturing extra_notes."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, session, client, plan, billing_cycle, *, extra_notes=None, **kwargs):
        self.calls.append(
            {
                "plan_id": plan.id,
                "billing_cycle": billing_cycle,
                "extra_notes": dict(extra_notes or {}),
            }
        )
        return {
            "provider": "razorpay",
            "subscription_id": f"sub_new_promoted_{len(self.calls)}",
            "short_url": "https://rzp.io/i/reauth-link",
        }


def _make_active_sub(
    db,
    client,
    plan,
    *,
    bot_id: int | None,
    mandate: str | None,
    scheduled_plan_id: int | None = None,
) -> Subscription:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot_id,
        status="active",
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=now,
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
        payment_provider="razorpay",
        razorpay_subscription_id=mandate,
        scheduled_plan_id=scheduled_plan_id,
        scheduled_billing_cycle="monthly" if scheduled_plan_id else None,
        scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC) if scheduled_plan_id else None,
    )
    db.add(sub)
    db.flush()
    return sub


def _promote(db, monkeypatch, sub) -> _FakeCreateSub:
    fake_create = _FakeCreateSub()
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: None,
    )
    assert transition_service.promote_scheduled_change(db, sub) is not None
    return fake_create


def test_perbot_promotion_stamps_bot_scope_on_the_replacement_mandate(db, monkeypatch):
    client = _make_client(db, email="perbot-promote-notes@e.com")
    professional = _make_plan(db, slug="pro-perbot-promote")
    starter = _make_plan(db, slug="starter-perbot-promote")
    bot = _make_bot(db, client, key="bot-perbot-promote")
    sub = _make_active_sub(
        db, client, professional, bot_id=bot.id, mandate="sub_old_promote", scheduled_plan_id=starter.id
    )
    db.commit()

    fake_create = _promote(db, monkeypatch, sub)

    notes = fake_create.calls[0]["extra_notes"]
    assert notes.get("purpose") == "per_bot_subscription"
    assert notes.get("oyechats_bot_id") == str(bot.id)
    assert notes.get("prev_razorpay_subscription_id") == "sub_old_promote"


def test_account_promotion_stays_unscoped(db, monkeypatch):
    """An account-level downgrade must NOT gain per-bot markers: its activation
    relies on the account-scoped sweep to retire the account grace row."""
    client = _make_client(db, email="acct-promote-notes@e.com")
    professional = _make_plan(db, slug="pro-acct-promote")
    starter = _make_plan(db, slug="starter-acct-promote")
    sub = _make_active_sub(
        db, client, professional, bot_id=None, mandate="sub_old_acct_promote", scheduled_plan_id=starter.id
    )
    db.commit()

    fake_create = _promote(db, monkeypatch, sub)

    notes = fake_create.calls[0]["extra_notes"]
    assert "purpose" not in notes
    assert "oyechats_bot_id" not in notes


def test_perbot_downgrade_cutover_spares_the_account_subscription(db, monkeypatch):
    """End-to-end pin of the P0: promote a per-bot downgrade, then activate the
    replacement mandate with the notes the promotion actually stamped. The
    client's separate ACCOUNT subscription must survive, and the new row must be
    scoped to the bot it funds."""
    client = _make_client(db, email="perbot-cutover-account@e.com")
    enterprise = _make_plan(db, slug="ent-perbot-cutover")
    professional = _make_plan(db, slug="pro-perbot-cutover")
    starter = _make_plan(db, slug="starter-perbot-cutover")
    bot = _make_bot(db, client, key="bot-perbot-cutover")
    account_sub = _make_active_sub(db, client, enterprise, bot_id=None, mandate="sub_account_enterprise")
    bot_sub = _make_active_sub(
        db, client, professional, bot_id=bot.id, mandate="sub_old_bot_cutover", scheduled_plan_id=starter.id
    )
    db.commit()

    fake_create = _promote(db, monkeypatch, bot_sub)
    db.commit()

    # Activate the replacement exactly as Razorpay would echo it back: the base
    # notes create_subscription always stamps, plus the extra notes captured
    # from the promotion itself.
    notes = {
        "oyechats_client_id": str(client.id),
        "oyechats_plan_id": str(starter.id),
        "billing_cycle": "monthly",
        **fake_create.calls[0]["extra_notes"],
    }
    payload = {
        "subscription": {
            "entity": {
                "id": "sub_new_bot_cutover",
                "notes": notes,
                "current_start": int(datetime(2026, 2, 1, tzinfo=UTC).timestamp()),
                "current_end": int(datetime(2026, 2, 28, tzinfo=UTC).timestamp()),
                "quantity": 1,
                "customer_id": "cust_test",
            }
        }
    }
    with patch.object(rzp, "_get_razorpay", return_value=MagicMock()):
        rzp._handle_subscription_activated(db, payload)
    db.commit()

    db.refresh(account_sub)
    assert account_sub.status == "active", (
        "a per-bot downgrade cutover must never cancel the client's account subscription"
    )

    new_row = (
        db.execute(select(Subscription).where(Subscription.razorpay_subscription_id == "sub_new_bot_cutover"))
        .scalars()
        .one()
    )
    assert new_row.status == "active"
    assert new_row.bot_id == bot.id, "the promoted replacement must stay scoped to the bot it funds"

    # The bot-scoped grace row minted by the promotion is retired, and the bot
    # is re-linked to the subscription that now funds it.
    grace = (
        db.execute(
            select(Subscription).where(
                Subscription.client_id == client.id,
                Subscription.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON,
            )
        )
        .scalars()
        .one()
    )
    assert grace.status == "canceled"
    db.refresh(bot)
    assert bot.subscription_id == new_row.id
