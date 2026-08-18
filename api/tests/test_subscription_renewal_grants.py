"""Per-period subscription grant idempotency. Remediation H4 (real Postgres).

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
from sqlalchemy import select
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.db.models import Base, Client, CreditLedger, Invoice, Plan, Subscription
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
    redelivers after activation lands), never ack-drop, a 2xx is final and
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


def _paid_invoice(db, sub, *, paid_at, payment_id):
    """A captured charge for the renewal the cron is about to grant. Gateway
    (razorpay) rows only renew against payment evidence; manual/free rows
    don't need one."""
    inv = Invoice(
        client_id=sub.client_id,
        subscription_id=sub.id,
        bot_id=sub.bot_id,
        amount_cents=399900,
        currency="inr",
        status="paid",
        kind="plan_charge",
        razorpay_payment_id=payment_id,
        paid_at=paid_at,
    )
    db.add(inv)
    db.flush()
    return inv


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

    acct = _make_scoped_sub(db, client, account_plan, bot_id=None, rzp_id="sub_acct", period_end=E1)
    botsub = _make_scoped_sub(db, client, bot_plan, bot_id=bot.id, rzp_id="sub_bot", period_end=E1)
    _paid_invoice(db, acct, paid_at=E1, payment_id="pay_cron_acct")
    _paid_invoice(db, botsub, paid_at=E1, payment_id="pay_cron_bot")
    db.commit()

    renewed = _run_renewal_cron(db, monkeypatch)

    assert renewed == 2
    # Each scope receives exactly its own plan's credits, in its own ledger.
    assert credit_service.get_balance(db, client.id, bot_id=None) == 1000
    assert credit_service.get_balance(db, client.id, bot_id=bot.id) == 500


def test_cron_is_noop_on_second_run(db, monkeypatch):
    """Running the cron twice must not double-grant, the per-period marker
    (``last_granted_period_end``) plus the roll-forward makes the second pass a
    no-op. The period end is one day stale so a single monthly roll-forward
    lands it in the future and the sub is no longer due."""
    from datetime import timedelta

    client = _make_client(db, "cron-idem@e.com", "cron-idem")
    account_plan = _make_plan(db, "acct-idem", 1000)
    bot_plan = _make_plan(db, "bot-idem", 500)
    bot = _make_bot(db, client)

    just_due = datetime.now(UTC) - timedelta(days=1)
    acct = _make_scoped_sub(db, client, account_plan, bot_id=None, rzp_id="sub_acct_i", period_end=just_due)
    botsub = _make_scoped_sub(db, client, bot_plan, bot_id=bot.id, rzp_id="sub_bot_i", period_end=just_due)
    _paid_invoice(db, acct, paid_at=just_due, payment_id="pay_cron_acct_i")
    _paid_invoice(db, botsub, paid_at=just_due, payment_id="pay_cron_bot_i")
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
    """A per-bot renewal must reset/grant only the bot ledger, it must NOT wipe
    the account pool. Regression guard for the cross-scope reset mismatch: the
    old cron reset the account pool while granting into the bot ledger."""
    client = _make_client(db, "cron-cross@e.com", "cron-cross")
    account_plan = _make_plan(db, "acct-cross", 1000)
    bot_plan = _make_plan(db, "bot-cross", 500)
    bot = _make_bot(db, client)

    # Account sub is NOT due (period ends in the future); only the bot sub is due.
    future_end = datetime(2999, 1, 1, 12, 0, tzinfo=UTC)
    account_sub = _make_scoped_sub(db, client, account_plan, bot_id=None, rzp_id="sub_acct_x", period_end=future_end)
    bot_sub = _make_scoped_sub(db, client, bot_plan, bot_id=bot.id, rzp_id="sub_bot_x", period_end=E1)
    _paid_invoice(db, bot_sub, paid_at=E1, payment_id="pay_cron_bot_x")
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


# ── flush-before-refresh regression (T5) ──────────────────────────────────────
#
# ``grant_subscription_period_once`` runs ``session.flush()`` immediately before
# ``session.refresh(subscription, with_for_update=True)``. That flush is load-
# bearing ONLY because production ``SessionLocal`` is ``autoflush=False``
# (``app/db/session.py``): the activation→charged webhook pair can be handled in
# one transaction where ``subscription.activated`` sets
# ``last_granted_period_end = P`` (dirty, unflushed) and ``subscription.charged``
# then calls this helper for the SAME period P. Without the flush,
# ``refresh``'s ``SELECT ... FOR UPDATE`` fires before the dirty marker reaches
# the DB, reloads the pre-set committed value, clobbers P in memory, and the
# marker check then mis-decides to grant the period a SECOND time.
#
# The shared ``db`` fixture (conftest) is ``autoflush=True``, so ``refresh``'s
# own SELECT auto-flushes the dirty marker first, the existing tests above pass
# with or without the flush line and therefore do NOT guard it. This test pins
# ``autoflush=False`` (mirroring test_credit_deduct_grant_boundary.py, where
# autoflush-off is likewise a required ingredient of the bug) so that deleting
# the ``session.flush()`` line makes it fail with a double grant.


def _autoflush_off_session(pg_engine) -> Session:
    """A session bound to the throwaway PG that mirrors production's
    ``autoflush=False``, the precondition that makes the flush-before-refresh
    fix observable."""
    return Session(pg_engine, autoflush=False)


def _truncate_all(session: Session) -> None:
    names = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    session.execute(sa_text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
    session.commit()


def test_flush_before_refresh_preserves_same_txn_marker(pg_engine):
    """Same-transaction activation→charged for one period grants exactly once,
    even with ``autoflush=False``. Regression guard for the ``session.flush()``
    before ``refresh`` in ``grant_subscription_period_once`` (commit 4dae732).

    Fails (returns ``True`` and writes a second ``plan_grant``) if that flush is
    removed, because the pending ``last_granted_period_end`` marker gets clobbered
    by the ``FOR UPDATE`` reload before the idempotency check reads it.
    """
    session = _autoflush_off_session(pg_engine)
    try:
        client = Client(name="c", email="flush-refresh@e.com", api_key="flush-refresh", hashed_password="h")
        session.add(client)
        session.flush()
        plan = Plan(name="Std", slug="std-flush-refresh", monthly_price_cents=399900, credits_per_month=1000)
        session.add(plan)
        session.flush()
        sub = Subscription(
            client_id=client.id,
            plan_id=plan.id,
            bot_id=None,
            status="active",
            payment_provider="razorpay",
            razorpay_subscription_id="sub_flush_refresh",
            current_period_start=S1,
            current_period_end=E1,
            last_granted_period_end=None,
        )
        sub.plan = plan
        session.add(sub)
        session.commit()

        # Simulate ``subscription.activated`` having granted + marked period E1
        # earlier in THIS transaction: the marker is set in the identity map but,
        # under autoflush=False, has NOT reached the database yet.
        sub.last_granted_period_end = E1
        assert sub in session.dirty  # precondition: the marker write is pending, unflushed

        # ``subscription.charged`` for the SAME period must observe that pending
        # marker (thanks to the explicit flush) and no-op.
        granted = credit_service.grant_subscription_period_once(session, sub, E1)
        session.commit()

        assert granted is False, "same-period grant must be a no-op"
        plan_grants = session.execute(select(CreditLedger).where(CreditLedger.reason == "plan_grant")).scalars().all()
        assert plan_grants == [], "no plan_grant may be written for an already-granted period"
    finally:
        session.rollback()
        _truncate_all(session)
        session.close()


# ── P1-3: cron/webhook grant-key parity + eligibility ────────────────────────
#
# The cron granted keyed on the OLD ``current_period_end`` while the charged
# webhook keys on Razorpay's NEW ``current_end``. The monotonic marker guard
# (``period_end <= last_granted_period_end`` → no-op) therefore let a DELAYED
# webhook redelivery re-run reset+grant for a period the cron had already
# granted. Wiping the period's consumption. Both callers must key the SAME
# value: the period end of the cycle being granted (the new one).


def test_cron_then_delayed_webhook_grants_once(db, monkeypatch):
    """Cron renews first (webhook outage), the charged webhook for the SAME
    cycle arrives later → the webhook must no-op, preserving consumption."""
    client = _make_client(db, "cron-key@e.com", "cron-key")
    plan = _make_plan(db, "plan-key", 1000)
    sub = _make_scoped_sub(db, client, plan, bot_id=None, rzp_id="sub_key", period_end=E1)
    _paid_invoice(db, sub, paid_at=E1, payment_id="pay_key_1")
    db.commit()

    assert _run_renewal_cron(db, monkeypatch) == 1
    db.refresh(sub)
    new_end = sub.current_period_end  # rolled by the cron

    # Customer burns part of the fresh allowance before the webhook shows up.
    credit_service.check_and_deduct(db, client.id, 400, reason="ai_chat")
    db.commit()
    assert credit_service.get_balance(db, client.id, bot_id=None) == 600

    # Delayed ``subscription.charged`` for the SAME renewed cycle. Razorpay's
    # current_end equals the period the cron already granted.
    rzp._handle_subscription_charged(db, _charged("sub_key", new_end, payment_id="pay_key_2"))
    db.commit()

    # No second reset+grant: consumption survives.
    assert credit_service.get_balance(db, client.id, bot_id=None) == 600
    grants = db.execute(
        select(CreditLedger).where(
            CreditLedger.client_id == client.id,
            CreditLedger.reason == "plan_grant",
            CreditLedger.delta > 0,
        )
    ).scalars()
    assert len(list(grants)) == 1


def test_cron_skips_trialing_rows(db, monkeypatch):
    """Trials never 'renew', the expiry cron owns them. A trialing row whose
    period lapsed must get neither a free full-plan grant nor a period roll."""
    client = _make_client(db, "cron-trial@e.com", "cron-trial")
    plan = _make_plan(db, "plan-trial", 1000)
    sub = _make_scoped_sub(db, client, plan, bot_id=None, rzp_id="sub_trial", period_end=E1)
    sub.status = "trialing"
    db.commit()

    assert _run_renewal_cron(db, monkeypatch) == 0
    db.refresh(sub)
    assert sub.current_period_end == E1  # not rolled
    assert credit_service.get_balance(db, client.id, bot_id=None) == 0


def test_cron_withholds_gateway_renewal_without_paid_invoice(db, monkeypatch):
    """A Razorpay-billed row with NO captured payment for the renewal must not
    be granted (unbounded free service when webhooks are down. F2). The
    period is left un-rolled so the row re-matches once evidence arrives."""
    client = _make_client(db, "cron-unpaid@e.com", "cron-unpaid")
    plan = _make_plan(db, "plan-unpaid", 1000)
    sub = _make_scoped_sub(db, client, plan, bot_id=None, rzp_id="sub_unpaid", period_end=E1)
    db.commit()

    assert _run_renewal_cron(db, monkeypatch) == 0
    db.refresh(sub)
    assert sub.current_period_end == E1  # left due, re-checked next run
    assert credit_service.get_balance(db, client.id, bot_id=None) == 0

    # Payment evidence lands (delayed invoice) → next run grants normally.
    _paid_invoice(db, sub, paid_at=E1, payment_id="pay_unpaid_late")
    db.commit()
    assert _run_renewal_cron(db, monkeypatch) == 1
    assert credit_service.get_balance(db, client.id, bot_id=None) == 1000


def test_cron_still_renews_manual_rows_without_invoice(db, monkeypatch):
    """Free/manual subscriptions have no gateway and no invoices, the cron is
    their ONLY renewal trigger and must keep granting them."""
    client = _make_client(db, "cron-manual@e.com", "cron-manual")
    plan = _make_plan(db, "plan-manual", 300)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="manual",
        billing_cycle="monthly",
        razorpay_subscription_id=None,
        current_period_start=S1,
        current_period_end=E1,
        last_granted_period_end=None,
    )
    sub.plan = plan
    db.add(sub)
    db.commit()

    assert _run_renewal_cron(db, monkeypatch) == 1
    assert credit_service.get_balance(db, client.id, bot_id=None) == 300


def test_cron_seat_invoice_is_not_renewal_evidence(db, monkeypatch):
    """Review fix, a paid SEAT invoice stamps the main sub's id but must not
    evidence a plan renewal: a ₹449 seat debit funding a full plan grant is
    the same masking class the F5 revoke probe closes."""
    client = _make_client(db, "cron-seatmask@e.com", "cron-seatmask")
    plan = _make_plan(db, "plan-seatmask", 1000)
    sub = _make_scoped_sub(db, client, plan, bot_id=None, rzp_id="sub_seatmask", period_end=E1)
    inv = _paid_invoice(db, sub, paid_at=E1, payment_id="pay_seatmask")
    inv.kind = "seat"
    db.commit()

    assert _run_renewal_cron(db, monkeypatch) == 0
    assert credit_service.get_balance(db, client.id, bot_id=None) == 0
    db.refresh(sub)
    assert sub.current_period_end == E1  # left due for real evidence


def test_marker_tolerance_absorbs_month_end_anchor_divergence(db):
    """Review fix (residual P1-3), the cron keys on add_months (day-clamped:
    Mar 28) while the webhook keys on Razorpay's current_end (anchor: Mar 31).
    A ≤4-day advance is the same paid cycle and must no-op; a real next cycle
    (~1 month) must still grant."""
    _client, sub = _make_sub(db, last_granted=datetime(2026, 3, 28, 12, 0, tzinfo=UTC))

    # Same cycle, anchor re-expanded (+3 days) → no-op.
    assert credit_service.grant_subscription_period_once(db, sub, datetime(2026, 3, 31, 12, 0, tzinfo=UTC)) is False

    # Genuine next cycle (+~1 month) → grants.
    assert credit_service.grant_subscription_period_once(db, sub, datetime(2026, 4, 30, 12, 0, tzinfo=UTC)) is True
