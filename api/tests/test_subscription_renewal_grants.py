"""Per-period subscription grant idempotency — remediation H4 (real Postgres).

The renewal grant in ``subscription.charged`` used a fragile 24h time-window
heuristic to avoid double-granting the first cycle. We replace it with an
explicit per-period marker (``Subscription.last_granted_period_end``): the
plan's credits are granted at most once per distinct billing period, regardless
of event timing, ordering, or replays. This also completes H1's "grant
idempotent per period".
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Client, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="renewal-grant tests need a reachable Postgres at DB_URL",
)

S1 = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
E1 = datetime(2026, 1, 31, 12, 0, tzinfo=UTC)
E2 = datetime(2026, 2, 28, 12, 0, tzinfo=UTC)


def _make_sub(db, last_granted=None):
    client = Client(name="c", email="h4@e.com", api_key="h4", hashed_password="h")
    db.add(client)
    db.flush()
    plan = Plan(name="Std", slug="std-h4", monthly_price_cents=399900, credits_per_month=1000)
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_h4",
        current_period_start=S1,
        current_period_end=E1,
        last_granted_period_end=last_granted,
    )
    sub.plan = plan
    db.add(sub)
    db.commit()
    return client, sub


def _charged(sub_id, period_end, period_start=None, payment_id=None):
    ent = {"id": sub_id, "current_end": int(period_end.timestamp())}
    if period_start is not None:
        ent["current_start"] = int(period_start.timestamp())
    payload = {"subscription": {"entity": ent}}
    if payment_id is not None:
        payload["payment"] = {"entity": {"id": payment_id, "amount": 399900, "currency": "INR"}}
    return payload


def test_grant_subscription_period_is_idempotent_per_period(db):
    _client, sub = _make_sub(db, last_granted=None)

    assert rzp._grant_subscription_period(db, sub, E1) is True
    assert sub.last_granted_period_end == E1

    # Same period again → no grant.
    assert rzp._grant_subscription_period(db, sub, E1) is False

    # New period → grant.
    assert rzp._grant_subscription_period(db, sub, E2) is True
    assert sub.last_granted_period_end == E2


def test_charged_grants_once_per_period(db, monkeypatch):
    _client, sub = _make_sub(db, last_granted=E1)  # activation already granted E1

    calls = []
    original = credit_service.grant_for_subscription
    monkeypatch.setattr(
        rzp.credit_service,
        "grant_for_subscription",
        lambda session, subscription, reference_id=None: (
            calls.append(subscription.id),
            original(session, subscription, reference_id=reference_id),
        )[1],
    )

    # Charged for the already-granted period E1 → no grant.
    rzp._handle_subscription_charged(db, _charged("sub_h4", E1, period_start=S1))
    db.commit()
    assert calls == []

    # Charged for a NEW period E2 → grants once; marker advances.
    rzp._handle_subscription_charged(db, _charged("sub_h4", E2, payment_id="pay_e2"))
    db.commit()
    assert len(calls) == 1
    db.refresh(sub)
    assert sub.last_granted_period_end == E2

    # Replay of the E2 charge (distinct payment, same period) → still one grant.
    rzp._handle_subscription_charged(db, _charged("sub_h4", E2, payment_id="pay_e2_dup"))
    db.commit()
    assert len(calls) == 1


def test_charged_for_unknown_subscription_raises_for_retry(db):
    """First-charge race: ``subscription.charged`` can beat ``subscription.
    activated``. The handler must RAISE (→ dead-letter + 5xx → Razorpay
    redelivers after activation lands), never ack-drop — a 2xx is final and
    permanently loses the period's invoice (prod, 2026-07-02)."""
    with pytest.raises(rzp.WebhookOutOfOrder):
        rzp._handle_subscription_charged(db, _charged("sub_never_linked", E1))


# ── Cron renewal, per-scope + per-period (BL-5 / NB-8) ────────────────────────
#
# Under per-bot billing a client holds an account-level subscription
# (``bot_id IS NULL``) plus one subscription per paid bot. The renewal cron
# (``task_renew_due_subscriptions``) must grant each scope its own credits,
# keyed on the same per-period marker the webhook uses. The old cron used a
# same-day client-wide ``plan_grant`` probe: bot A's grant today suppressed
# bot B's legitimate renewal (permanent one-month credit loss), and a per-bot
# renewal wiped the account pool because the reset omitted ``bot_id``.


def _make_client(db, email, api_key):
    client = Client(name="c", email=email, api_key=api_key, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, slug, credits):
    plan = Plan(name=slug, slug=slug, monthly_price_cents=399900, credits_per_month=credits)
    db.add(plan)
    db.flush()
    return plan


def _make_scoped_sub(db, client, plan, *, bot_id, rzp_id, period_end):
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot_id,
        status="active",
        payment_provider="razorpay",
        billing_cycle="monthly",
        razorpay_subscription_id=rzp_id,
        current_period_start=S1,
        current_period_end=period_end,
        last_granted_period_end=None,
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def _make_bot(db, client):
    from app.db.models import Bot

    bot = Bot(client_id=client.id, bot_key=f"bot-{client.id}-cron")
    db.add(bot)
    db.flush()
    return bot


def _run_renewal_cron(db, monkeypatch):
    """Drive ``task_renew_due_subscriptions`` against the test session.

    The task imports ``get_session`` from ``app.db.session`` inside its body and
    commits through it; we patch that symbol to yield the test session (without
    closing it) so the cron operates on the same rows the test inspects.
    """
    import asyncio
    from contextlib import contextmanager

    from app.db import session as db_session
    from app.worker import tasks as worker_tasks

    @contextmanager
    def _fake_get_session():
        yield db

    monkeypatch.setattr(db_session, "get_session", _fake_get_session)
    return asyncio.run(worker_tasks.task_renew_due_subscriptions({}))


def test_cron_renews_account_and_bot_scopes_independently(db, monkeypatch):
    """One client, two due subs (account + per-bot). Both must be granted into
    their own ledgers; neither suppresses the other (BL-5 / NB-8)."""
    client = _make_client(db, "cron-scope@e.com", "cron-scope")
    account_plan = _make_plan(db, "acct-plan", 1000)
    bot_plan = _make_plan(db, "bot-plan", 500)
    bot = _make_bot(db, client)

    _make_scoped_sub(db, client, account_plan, bot_id=None, rzp_id="sub_acct", period_end=E1)
    _make_scoped_sub(db, client, bot_plan, bot_id=bot.id, rzp_id="sub_bot", period_end=E1)
    db.commit()

    renewed = _run_renewal_cron(db, monkeypatch)

    assert renewed == 2
    # Each scope receives exactly its own plan's credits, in its own ledger.
    assert credit_service.get_balance(db, client.id, bot_id=None) == 1000
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 500


def test_cron_is_noop_on_second_run(db, monkeypatch):
    """Running the cron twice must not double-grant — the per-period marker
    (``last_granted_period_end``) plus the roll-forward makes the second pass a
    no-op. The period end is one day stale so a single monthly roll-forward
    lands it in the future and the sub is no longer due."""
    from datetime import timedelta

    client = _make_client(db, "cron-idem@e.com", "cron-idem")
    account_plan = _make_plan(db, "acct-idem", 1000)
    bot_plan = _make_plan(db, "bot-idem", 500)
    bot = _make_bot(db, client)

    just_due = datetime.now(UTC) - timedelta(days=1)
    _make_scoped_sub(db, client, account_plan, bot_id=None, rzp_id="sub_acct_i", period_end=just_due)
    _make_scoped_sub(db, client, bot_plan, bot_id=bot.id, rzp_id="sub_bot_i", period_end=just_due)
    db.commit()

    first = _run_renewal_cron(db, monkeypatch)
    assert first == 2

    # Period rolled ~1 month forward past ``now``, so nothing is due; a second
    # run grants nothing and balances are unchanged.
    second = _run_renewal_cron(db, monkeypatch)
    assert second == 0
    assert credit_service.get_balance(db, client.id, bot_id=None) == 1000
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 500


def test_cron_per_bot_renewal_does_not_reset_account_pool(db, monkeypatch):
    """A per-bot renewal must reset/grant only the bot ledger — it must NOT wipe
    the account pool. Regression guard for the cross-scope reset mismatch: the
    old cron reset the account pool while granting into the bot ledger."""
    client = _make_client(db, "cron-cross@e.com", "cron-cross")
    account_plan = _make_plan(db, "acct-cross", 1000)
    bot_plan = _make_plan(db, "bot-cross", 500)
    bot = _make_bot(db, client)

    # Account sub is NOT due (period ends in the future); only the bot sub is due.
    future_end = datetime(2999, 1, 1, 12, 0, tzinfo=UTC)
    account_sub = _make_scoped_sub(db, client, account_plan, bot_id=None, rzp_id="sub_acct_x", period_end=future_end)
    _make_scoped_sub(db, client, bot_plan, bot_id=bot.id, rzp_id="sub_bot_x", period_end=E1)
    # Seed a pre-existing account-pool grant so we can prove it survives.
    credit_service.grant_for_subscription(db, account_sub)
    db.commit()
    assert credit_service.get_balance(db, client.id, bot_id=None) == 1000

    renewed = _run_renewal_cron(db, monkeypatch)

    assert renewed == 1
    # Account pool untouched by the per-bot renewal.
    assert credit_service.get_balance(db, client.id, bot_id=None) == 1000
    # Bot ledger got its own grant.
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 500
