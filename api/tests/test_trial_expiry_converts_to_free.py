"""Day 15 converts the trial to Free in place. Nothing is deleted, ever again.

The old path flipped a lapsed trial to ``trial_expired``, stamped
``data_retention_until``, emailed a promise of permanent deletion, and let
``task_delete_expired_trial_data`` hard-delete the workspace. That is what
destroyed a real customer's account on 15 Aug. The trial now converts: the same
subscription row moves to the Free plan, the knowledge built on trial
entitlements is PAUSED rather than dropped, and one upgrade switches it back on.

Legacy rows already inside their retention window are deliberately untouched;
they still age out through the old cron, which no new row ever enters.

Real-Postgres tests via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Bot, Client, Document, Plan, Subscription
from app.worker import tasks as cron_tasks

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _plan(db, slug: str, *, credits: int, trial_days: int = 0, default: bool = False) -> Plan:
    plan = Plan(
        slug=slug,
        name=slug.title(),
        credits_per_month=credits,
        monthly_price_cents=0 if slug in ("free", "trial") else 119900,
        annual_price_cents=0,
        trial_days=trial_days,
        is_active=True,
        is_public=slug != "trial",
        is_default=default,
        sort_order=0 if slug == "trial" else 1,
        limits={"bots": 1, "credits": credits},
        features={"topup_allowed": False},
    )
    db.add(plan)
    db.flush()
    return plan


def _client(db, email: str) -> Client:
    row = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(row)
    db.flush()
    return row


def _lapsed_trial(db, client: Client, plan: Plan, *, days_ago: int = 1) -> Subscription:
    now = datetime.now(UTC)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="trialing",
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=now - timedelta(days=14 + days_ago),
        current_period_end=now - timedelta(days=days_ago),
        trial_start=now - timedelta(days=14 + days_ago),
        trial_end=now - timedelta(days=days_ago),
        payment_provider="manual",
    )
    db.add(sub)
    db.flush()
    # Grant the trial's allowance for real, the way signup does. Without this
    # there is no unused balance and the forfeit at conversion is untestable:
    # every assertion about the Free balance passes whether or not it runs.
    from app.services import credit_service

    sub.plan = plan
    credit_service.grant_for_subscription(db, sub)
    db.flush()
    return sub


def _bot_with_knowledge(db, client: Client, *, key: str) -> Bot:
    bot = Bot(client_id=client.id, bot_key=key, name="B")
    db.add(bot)
    db.flush()
    db.add(
        Document(
            client_id=client.id,
            bot_id=bot.id,
            document_name="https://example.com/",
            source="crawl",
            file_hash=f"h-{key}",
            content="hello",
            embedding=[0.0] * 768,
            is_active=True,
        )
    )
    db.flush()
    return bot


def _run(db):
    """Run the cron against the test session."""
    from contextlib import contextmanager

    @contextmanager
    def _ctx():
        yield db

    from unittest.mock import patch

    with (
        patch("app.db.session.get_session", _ctx),
        patch("app.services.email_service.send_trial_ended_email"),
    ):
        return asyncio.run(cron_tasks.task_expire_trials({}))


def test_expiry_converts_sub_to_free_in_place(db):
    free = _plan(db, "free", credits=200)
    trial = _plan(db, "trial", credits=500, trial_days=14, default=True)
    client = _client(db, "conv-free@e.com")
    sub = _lapsed_trial(db, client, trial)
    db.commit()

    assert _run(db) == 1
    db.refresh(sub)

    assert sub.plan_id == free.id
    assert sub.status == "active"
    assert sub.data_retention_until is None
    # The Free period opens now and runs an anniversary month, so the renewal
    # cron has something to fire on in month two.
    assert sub.current_period_end > datetime.now(UTC)

    from app.services import credit_service

    # Exactly the Free grant, not 500 + 200. A leftover trial balance riding
    # onto Free is the same leak shape as an unmetered top-up.
    assert credit_service.get_balance(db, client.id) == 200


def test_expiry_pauses_knowledge_and_is_reversible(db):
    _plan(db, "free", credits=200)
    trial = _plan(db, "trial", credits=500, trial_days=14, default=True)
    client = _client(db, "conv-pause@e.com")
    bot = _bot_with_knowledge(db, client, key="bot-conv-pause")
    _lapsed_trial(db, client, trial)
    db.commit()

    assert _run(db) == 1

    from sqlalchemy import select

    active = db.execute(select(Document.id).where(Document.bot_id == bot.id, Document.is_active.is_(True))).all()
    assert active == [], "trial knowledge must be paused, not left live on Free"

    # Reversible, which is what the trial-ended email promises.
    from app.services import knowledge_state_service

    restored = knowledge_state_service.reactivate_client_knowledge(db, client.id)
    db.commit()
    assert restored == 1
    still_paused = db.execute(select(Document.id).where(Document.bot_id == bot.id, Document.is_active.is_(False))).all()
    assert still_paused == []


def test_expiry_never_touches_a_client_with_a_live_paid_sub(db):
    """A customer who bought mid-trial keeps what they bought.

    The trial row is retired as converted_to_paid rather than dragged onto
    Free, which would demote a paying customer on day 15.

    The sibling here is BOT-scoped, because that is the only shape that can
    coexist with a live trial row. ``ix_subscriptions_client_legacy_active``
    admits one account-level row per client in the active set, so an
    account-level purchase cannot sit beside the trial: the activation handler
    cancels the trial row in the same transaction that inserts the paid one,
    and this cron never sees it. The guard still has to exist for the per-bot
    case, which the index does allow.
    """
    _plan(db, "free", credits=200)
    trial = _plan(db, "trial", credits=500, trial_days=14, default=True)
    paid = _plan(db, "standard", credits=2500)
    client = _client(db, "conv-paid@e.com")
    sub = _lapsed_trial(db, client, trial)
    funded_bot = Bot(client_id=client.id, bot_key="bot-conv-paid", name="Funded")
    db.add(funded_bot)
    db.flush()
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=paid.id,
            bot_id=funded_bot.id,
            status="active",
            billing_cycle="monthly",
            operator_quantity=1,
            payment_provider="razorpay",
            razorpay_subscription_id="sub_paid_1",
        )
    )
    db.flush()
    db.commit()

    _run(db)
    db.refresh(sub)

    assert sub.status == "canceled"
    assert sub.cancel_reason == "converted_to_paid"
    assert sub.plan_id == trial.id, "the retired row must not be rewritten to Free"


def test_converted_free_sub_renews_on_month_two(db):
    """Conversion must feed the renewal cron, the only trigger for free subs."""
    free = _plan(db, "free", credits=200)
    trial = _plan(db, "trial", credits=500, trial_days=14, default=True)
    client = _client(db, "conv-renew@e.com")
    sub = _lapsed_trial(db, client, trial)
    db.commit()

    _run(db)
    db.refresh(sub)
    assert sub.plan_id == free.id

    # Advance past the anniversary and let the renewal cron do month two.
    sub.current_period_end = datetime.now(UTC) - timedelta(minutes=1)
    db.flush()
    db.commit()

    from contextlib import contextmanager
    from unittest.mock import patch

    @contextmanager
    def _ctx():
        yield db

    with patch("app.db.session.get_session", _ctx):
        renewed = asyncio.run(cron_tasks.task_renew_due_subscriptions({}))
    assert renewed == 1

    from sqlalchemy import func, select

    from app.db.models import CreditLedger
    from app.services import credit_service

    # Plan credits are use-it-or-lose-it, so month two RESETS to Free's 200
    # rather than stacking on month one. What proves the renewal actually ran
    # is a second positive plan_grant row, not the balance.
    grants = db.execute(
        select(func.count())
        .select_from(CreditLedger)
        .where(
            CreditLedger.client_id == client.id,
            CreditLedger.reason == "plan_grant",
            CreditLedger.delta > 0,
        )
    ).scalar_one()
    # Three positive grants: the trial's own at signup, Free's at conversion,
    # and Free's again at the month-two renewal. The last is the one this test
    # exists for, and it is the only trigger a free-tier row ever gets.
    assert grants == 3, "the renewal cron must grant month two on a converted free row"
    assert credit_service.get_balance(db, client.id) == 200
    db.refresh(sub)
    assert sub.current_period_end > datetime.now(UTC)


def test_legacy_trial_expired_rows_still_age_out_unchanged(db):
    """The deletion cron keeps working for rows already in its queue.

    New trials never enter it, but a row stamped before this change must still
    drain rather than being stranded forever.
    """
    _plan(db, "free", credits=200)
    trial = _plan(db, "trial", credits=500, trial_days=14, default=True)
    client = _client(db, "conv-legacy@e.com")
    now = datetime.now(UTC)
    legacy = Subscription(
        client_id=client.id,
        plan_id=trial.id,
        status="trial_expired",
        billing_cycle="monthly",
        operator_quantity=1,
        trial_start=now - timedelta(days=40),
        trial_end=now - timedelta(days=26),
        data_retention_until=now - timedelta(days=1),
        payment_provider="manual",
    )
    db.add(legacy)
    db.flush()
    db.commit()

    # The expiry cron filters on ``trialing`` and must not see it at all.
    assert _run(db) == 0
    db.refresh(legacy)
    assert legacy.status == "trial_expired"
    assert legacy.data_retention_until is not None


def test_a_converted_account_can_never_be_reached_by_the_deletion_cron(db):
    """The point of the whole change, asserted end to end.

    ``task_delete_expired_trial_data`` hard-deletes every Bot owned by a
    workspace whose ``data_retention_until`` has lapsed. That is what destroyed
    a real customer's account. A converted row must be invisible to it, both
    because its status is no longer ``trial_expired`` and because it carries no
    retention stamp at all.
    """
    from contextlib import contextmanager
    from unittest.mock import patch

    from sqlalchemy import select

    _plan(db, "free", credits=200)
    trial = _plan(db, "trial", credits=500, trial_days=14, default=True)
    client = _client(db, "conv-nodelete@e.com")
    bot = _bot_with_knowledge(db, client, key="bot-conv-nodelete")
    sub = _lapsed_trial(db, client, trial)
    db.commit()

    assert _run(db) == 1
    db.refresh(sub)
    assert sub.status == "active"
    assert sub.data_retention_until is None

    @contextmanager
    def _ctx():
        yield db

    with (
        patch("app.db.session.get_session", _ctx),
        patch("app.services.email_service.send_trial_data_deleted_email"),
    ):
        deleted = asyncio.run(cron_tasks.task_delete_expired_trial_data({}))

    assert deleted == 0
    assert db.execute(select(Bot.id).where(Bot.id == bot.id)).first() is not None, (
        "the deletion cron reached a converted account"
    )
    db.refresh(client)
    assert getattr(client, "is_active", True) is not False


def test_the_conversion_email_fires_once_and_marks_itself(db):
    """Marker idempotency, moved here from the stubbed cron tests.

    A re-run after a partial failure must not email the customer twice.
    """
    from contextlib import contextmanager
    from unittest.mock import patch

    _plan(db, "free", credits=200)
    trial = _plan(db, "trial", credits=500, trial_days=14, default=True)
    client = _client(db, "conv-once@e.com")
    sub = _lapsed_trial(db, client, trial)
    db.commit()

    @contextmanager
    def _ctx():
        yield db

    with (
        patch("app.db.session.get_session", _ctx),
        patch("app.services.email_service.send_trial_ended_email") as mail,
    ):
        asyncio.run(cron_tasks.task_expire_trials({}))
    assert mail.call_count == 1
    db.refresh(sub)
    assert sub.trial_emails_sent.get("trial_ended") is not None

    # The row is no longer trialing, so a second tick cannot even see it. Force
    # it back to prove the marker, not the filter, is what stops the resend.
    sub.status = "trialing"
    db.flush()
    db.commit()
    with (
        patch("app.db.session.get_session", _ctx),
        patch("app.services.email_service.send_trial_ended_email") as mail_again,
    ):
        asyncio.run(cron_tasks.task_expire_trials({}))
    mail_again.assert_not_called()


def test_an_email_failure_does_not_block_the_conversion(db):
    """The customer's trial is over whether or not Brevo answered.

    The marker is deliberately NOT set on failure, so the next tick retries the
    email, but the plan move, the grant and the pause must all have committed.
    """
    from contextlib import contextmanager
    from unittest.mock import patch

    free = _plan(db, "free", credits=200)
    trial = _plan(db, "trial", credits=500, trial_days=14, default=True)
    client = _client(db, "conv-mailfail@e.com")
    sub = _lapsed_trial(db, client, trial)
    db.commit()

    @contextmanager
    def _ctx():
        yield db

    with (
        patch("app.db.session.get_session", _ctx),
        patch(
            "app.services.email_service.send_trial_ended_email",
            side_effect=RuntimeError("brevo down"),
        ),
    ):
        assert asyncio.run(cron_tasks.task_expire_trials({})) == 1

    db.refresh(sub)
    assert sub.plan_id == free.id
    assert sub.status == "active"
    assert "trial_ended" not in (sub.trial_emails_sent or {})
