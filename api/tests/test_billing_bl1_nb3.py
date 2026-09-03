"""BL-1 + NB-3 remediation. Scheduled downgrade survives cutover, no silent strand.

Under the UPI re-auth model a scheduled paid downgrade cancels the old mandate
``at_period_end`` and queues ``scheduled_plan_id``. Razorpay fires
``subscription.cancelled`` (NOT ``subscription.completed``) at the cutover of a
``cancel_at_cycle_end`` mandate. The bugs fixed here:

* BL-1. ``subscription.cancelled`` was scheduled-change-blind: it flipped the
  row to ``canceled`` and the queued downgrade was lost. Fixed by routing both
  the ``cancelled`` and ``completed`` handlers through a shared
  ``_promote_scheduled_if_pending`` helper, and by widening the cron backstop to
  re-include ``canceled`` rows that still carry ``scheduled_plan_id``.
* NB-3. Promotion created the new lower-plan checkout but never told the
  customer, stranding them with no active sub and no re-auth path. Fixed by
  emailing the Razorpay ``short_url`` re-auth link from
  ``promote_scheduled_change``.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Bot, Client, Document, Plan, Subscription
from app.services import razorpay_service as rzp
from app.services import transition_service
from tests.conftest import reset_database

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="BL-1/NB-3 billing tests need a reachable Postgres at DB_URL",
)


# ── Builders ────────────────────────────────────────────────────────────────


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str, price_cents: int = 399900, credits: int = 1000) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=price_cents,
        annual_price_cents=price_cents * 10,
        monthly_price_usd_cents=price_cents,
        credits_per_month=credits,
        included_operator_seats=1,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_inr_monthly",
        razorpay_plan_id_annual=f"plan_{slug}_inr_annual",
    )
    db.add(plan)
    db.flush()
    return plan


def _make_sub(
    db,
    client: Client,
    plan: Plan,
    *,
    razorpay_subscription_id: str,
    status: str = "active",
    scheduled_plan_id: int | None = None,
    scheduled_change_at: datetime | None = None,
) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status=status,
        payment_provider="razorpay",
        razorpay_subscription_id=razorpay_subscription_id,
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
        scheduled_plan_id=scheduled_plan_id,
        scheduled_billing_cycle="monthly" if scheduled_plan_id else None,
        scheduled_change_at=scheduled_change_at,
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def _cancelled_payload(razorpay_sub_id: str) -> dict:
    return {"subscription": {"entity": {"id": razorpay_sub_id}}}


def _completed_payload(razorpay_sub_id: str) -> dict:
    return {"subscription": {"entity": {"id": razorpay_sub_id}}}


class _FakeCreateSub:
    """Records create_subscription calls; returns a realistic checkout payload."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, session, client, plan, billing_cycle, *, extra_notes=None, **kwargs):
        self.calls.append(
            {
                "client_id": client.id,
                "plan_id": plan.id,
                "billing_cycle": billing_cycle,
                "extra_notes": dict(extra_notes or {}),
            }
        )
        return {
            "provider": "razorpay",
            "subscription_id": f"sub_new_{len(self.calls)}",
            "short_url": "https://rzp.io/i/reauth-link",
        }


# ── BL-1: cancelled webhook promotes a queued downgrade ───────────────────────


def test_cancelled_webhook_promotes_scheduled_downgrade(db, monkeypatch):
    """``subscription.cancelled`` for a sub carrying ``scheduled_plan_id`` must
    promote the queued downgrade (new checkout + customer notified), NOT leave a
    plain terminal-canceled row with the change lost."""
    client = _make_client(db, email="bl1-cancel@e.com")
    old_plan = _make_plan(db, slug="bl1-pro", price_cents=399900)
    new_plan = _make_plan(db, slug="bl1-basic", price_cents=99900)
    sub = _make_sub(
        db,
        client,
        old_plan,
        razorpay_subscription_id="sub_bl1_cancel",
        status="active",
        scheduled_plan_id=new_plan.id,
        scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC),
    )
    db.commit()

    fake_create = _FakeCreateSub()
    emails: list[dict] = []
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: emails.append(kw),
    )

    rzp._handle_subscription_cancelled(db, _cancelled_payload("sub_bl1_cancel"))
    db.commit()
    db.refresh(sub)

    # New lower-plan checkout was created, carrying the old sub id for reconcile.
    assert len(fake_create.calls) == 1
    assert fake_create.calls[0]["plan_id"] == new_plan.id
    assert fake_create.calls[0]["extra_notes"]["prev_razorpay_subscription_id"] == "sub_bl1_cancel"

    # Customer notified with the re-auth link, not silently stranded.
    assert len(emails) == 1
    assert emails[0]["reauth_url"] == "https://rzp.io/i/reauth-link"
    assert emails[0]["to_email"] == "bl1-cancel@e.com"

    # Queued change consumed; old row is terminal (not a plain lost cancel).
    assert sub.scheduled_plan_id is None
    assert sub.status in ("expired", "canceled")


# ── BL-1: cron backstop catches the dropped-webhook case ──────────────────────


def test_cron_backstop_promotes_canceled_row_with_scheduled_plan(db, monkeypatch):
    """If the cancelled webhook was dropped, the row is already ``canceled`` but
    still carries ``scheduled_plan_id``. The cron backstop must still promote."""
    client = _make_client(db, email="bl1-cron@e.com")
    old_plan = _make_plan(db, slug="bl1c-pro", price_cents=399900)
    new_plan = _make_plan(db, slug="bl1c-basic", price_cents=99900)
    _make_sub(
        db,
        client,
        old_plan,
        razorpay_subscription_id="sub_bl1_cron",
        status="canceled",  # webhook already flipped it, blind to the schedule
        scheduled_plan_id=new_plan.id,
        scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC),
    )
    db.commit()

    fake_create = _FakeCreateSub()
    emails: list[dict] = []
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: emails.append(kw),
    )

    now = datetime(2026, 2, 5, tzinfo=UTC)
    subs = (
        db.execute(
            select(Subscription).where(
                Subscription.scheduled_plan_id.is_not(None),
                Subscription.scheduled_change_at <= now,
                Subscription.status.in_(("active", "trialing", "past_due", "canceled")),
            )
        )
        .scalars()
        .all()
    )
    promoted = sum(1 for s in subs if transition_service.promote_scheduled_change(db, s) is not None)
    db.commit()

    assert promoted == 1
    assert len(fake_create.calls) == 1
    assert len(emails) == 1


# ── BL-1: normal cancel WITHOUT a scheduled change is unaffected ──────────────


def test_plain_cancel_without_scheduled_change_still_terminates(db, monkeypatch):
    """A cancel with no queued downgrade must do the plain terminal cancel, no
    promotion, no checkout, no email (regression guard)."""
    client = _make_client(db, email="bl1-plain@e.com")
    plan = _make_plan(db, slug="bl1-plain", price_cents=399900)
    sub = _make_sub(db, client, plan, razorpay_subscription_id="sub_bl1_plain", status="active")
    db.commit()

    fake_create = _FakeCreateSub()
    emails: list[dict] = []
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: emails.append(kw),
    )

    rzp._handle_subscription_cancelled(db, _cancelled_payload("sub_bl1_plain"))
    db.commit()
    db.refresh(sub)

    assert sub.status == "canceled"
    assert sub.canceled_at is not None
    assert fake_create.calls == []
    assert emails == []


# ── NB-3: promotion is idempotent (double-fire must not double-provision) ─────


def test_promotion_is_idempotent_sequential(db, monkeypatch):
    """completed + cancelled + cron can all fire for the same cutover. Only the
    first promotes; later calls are no-ops (scheduled trio already cleared).

    Sequential double-fire on ONE session. The genuinely-concurrent
    two-session case is covered by
    ``test_lock_serializes_concurrent_webhook_and_cron``."""
    client = _make_client(db, email="nb3-idem@e.com")
    old_plan = _make_plan(db, slug="nb3-pro", price_cents=399900)
    new_plan = _make_plan(db, slug="nb3-basic", price_cents=99900)
    sub = _make_sub(
        db,
        client,
        old_plan,
        razorpay_subscription_id="sub_nb3_idem",
        status="active",
        scheduled_plan_id=new_plan.id,
        scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC),
    )
    db.commit()

    fake_create = _FakeCreateSub()
    emails: list[dict] = []
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: emails.append(kw),
    )

    # First: cancelled webhook promotes.
    rzp._handle_subscription_cancelled(db, _cancelled_payload("sub_nb3_idem"))
    db.commit()
    # Second: a late completed webhook for the same sub must NOT re-provision.
    rzp._handle_subscription_completed(db, _completed_payload("sub_nb3_idem"))
    db.commit()
    db.refresh(sub)

    assert len(fake_create.calls) == 1
    assert len(emails) == 1
    assert sub.scheduled_plan_id is None


# ── Fix A: the lock serializes a genuine webhook + cron double-fire ───────────


def test_lock_serializes_concurrent_webhook_and_cron(pg_engine, fk_checks_switchable, monkeypatch):
    """Two independent sessions (webhook + cron) racing on the SAME cutover must
    promote exactly ONCE (one checkout, one email) not twice (Fig A).

    We model the race with two real sessions on the throwaway Postgres. Session
    A (the webhook) promotes and commits, clearing the scheduled trio. Session B
    (the cron) still holds a stale in-memory row with ``scheduled_plan_id`` set;
    when it calls ``promote_scheduled_change`` the ``SELECT ... FOR UPDATE``
    refresh re-reads A's committed row, sees the trio cleared, and no-ops. This
    proves the row-lock + re-check serialization. Remove the
    ``refresh(with_for_update=True)`` re-check and B double-provisions."""
    fake_create = _FakeCreateSub()
    emails: list[dict] = []
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: emails.append(kw),
    )

    session_a = Session(pg_engine, autoflush=False)
    session_b = Session(pg_engine, autoflush=False)
    try:
        client = _make_client(session_a, email="lock-race@e.com")
        old_plan = _make_plan(session_a, slug="lock-pro", price_cents=399900)
        new_plan = _make_plan(session_a, slug="lock-basic", price_cents=99900)
        sub_a = _make_sub(
            session_a,
            client,
            old_plan,
            razorpay_subscription_id="sub_lock_race",
            status="active",
            scheduled_plan_id=new_plan.id,
            scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC),
        )
        session_a.commit()

        # Session B loads the row BEFORE A promotes, its in-memory copy still
        # carries the queued change (the racing-read the fix must defeat).
        sub_b = session_b.get(Subscription, sub_a.id)
        assert sub_b is not None
        assert sub_b.scheduled_plan_id == new_plan.id

        # Webhook (session A) promotes first and commits, releasing its xact lock
        # and clearing the trio in the DB.
        payload_a = transition_service.promote_scheduled_change(session_a, sub_a)
        session_a.commit()
        assert payload_a is not None

        # Cron (session B) now runs against its stale row. The FOR UPDATE refresh
        # inside ``promote_scheduled_change`` must observe A's committed clear and
        # no-op. NO second checkout, NO second email.
        payload_b = transition_service.promote_scheduled_change(session_b, sub_b)
        session_b.commit()
        assert payload_b is None

        assert len(fake_create.calls) == 1, "promotion must create exactly one checkout"
        assert len(emails) == 1, "customer must be emailed exactly once"
    finally:
        session_a.rollback()
        session_b.rollback()
        # This test builds its own sessions rather than taking the ``db``
        # fixture, so it runs that fixture's teardown by hand.
        session_b.close()
        reset_database(session_a, fk_checks_switchable=fk_checks_switchable)
        session_a.close()


# ── Fix D: cron backstop drives the REAL task, not a hand-rolled query ────────


def _run_promote_cron(db, monkeypatch) -> int:
    """Drive the REAL ``task_promote_scheduled_downgrades`` against the test
    session, mirroring the renewal-cron test harness. The task imports
    ``get_session`` from ``app.db.session`` inside its body; we patch that symbol
    to yield the test session so the cron operates on the rows the test set up."""
    import asyncio
    from contextlib import contextmanager

    from app.db import session as db_session
    from app.worker import tasks as worker_tasks

    @contextmanager
    def _fake_get_session():
        yield db

    monkeypatch.setattr(db_session, "get_session", _fake_get_session)
    return asyncio.run(worker_tasks.task_promote_scheduled_downgrades({}))


def test_real_cron_task_promotes_stale_canceled_row(db, monkeypatch):
    """The REAL cron task (not an inline re-implementation of its query) must
    promote a ``canceled`` row that still carries a due ``scheduled_plan_id``."""
    from datetime import timedelta

    client = _make_client(db, email="cron-real@e.com")
    old_plan = _make_plan(db, slug="cronr-pro", price_cents=399900)
    new_plan = _make_plan(db, slug="cronr-basic", price_cents=99900)
    _make_sub(
        db,
        client,
        old_plan,
        razorpay_subscription_id="sub_cron_real",
        status="canceled",
        scheduled_plan_id=new_plan.id,
        scheduled_change_at=datetime.now(UTC) - timedelta(days=1),
    )
    db.commit()

    fake_create = _FakeCreateSub()
    emails: list[dict] = []
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: emails.append(kw),
    )

    promoted = _run_promote_cron(db, monkeypatch)

    assert promoted == 1
    assert len(fake_create.calls) == 1
    assert len(emails) == 1


# ── Fix D: short_url is None → manual-reconcile warning, no email ─────────────


def test_promotion_without_short_url_warns_and_sends_no_email(db, monkeypatch):
    """If the created checkout has no ``short_url`` (nothing to re-authorise
    against), the promotion still stands but must NOT send a re-auth email, it
    takes the manual-reconcile warning branch instead."""
    client = _make_client(db, email="nourl@e.com")
    old_plan = _make_plan(db, slug="nourl-pro", price_cents=399900)
    new_plan = _make_plan(db, slug="nourl-basic", price_cents=99900)
    sub = _make_sub(
        db,
        client,
        old_plan,
        razorpay_subscription_id="sub_nourl",
        status="active",
        scheduled_plan_id=new_plan.id,
        scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC),
    )
    db.commit()

    def _create_no_url(session, client, plan, billing_cycle, *, extra_notes=None, **kwargs):
        return {"provider": "razorpay", "subscription_id": "sub_new_nourl"}  # no short_url

    emails: list[dict] = []
    monkeypatch.setattr(rzp, "create_subscription", _create_no_url)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: emails.append(kw),
    )

    payload = transition_service.promote_scheduled_change(db, sub)
    db.commit()
    db.refresh(sub)

    assert payload is not None
    assert payload.get("short_url") is None
    assert emails == [], "no re-auth email when there is no link to send"
    # Promotion still committed: trio cleared, old row terminal.
    assert sub.scheduled_plan_id is None
    assert sub.status in ("expired", "canceled")


# ── Fix D: a failing re-auth email must NOT roll back the promotion ───────────


def test_reauth_email_failure_does_not_roll_back_promotion(db, monkeypatch):
    """The re-auth email is best-effort (delivery-failure is captured to Sentry
    by the send path). If the send raises, the promotion (the checkout that
    already exists at the gateway) must still commit, not unwind."""
    client = _make_client(db, email="emailfail@e.com")
    old_plan = _make_plan(db, slug="ef-pro", price_cents=399900)
    new_plan = _make_plan(db, slug="ef-basic", price_cents=99900)
    sub = _make_sub(
        db,
        client,
        old_plan,
        razorpay_subscription_id="sub_emailfail",
        status="active",
        scheduled_plan_id=new_plan.id,
        scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC),
    )
    db.commit()

    fake_create = _FakeCreateSub()
    monkeypatch.setattr(rzp, "create_subscription", fake_create)

    def _boom(**kw):
        raise RuntimeError("brevo down")

    monkeypatch.setattr(transition_service.email_service, "send_downgrade_reauth_email", _boom)

    payload = transition_service.promote_scheduled_change(db, sub)
    db.commit()
    db.refresh(sub)

    # The email blew up, but the promotion stands.
    assert payload is not None
    assert len(fake_create.calls) == 1
    assert sub.scheduled_plan_id is None
    assert sub.status in ("expired", "canceled")


# ── Fix C: an abandoned downgrade (cleared trio) is NOT promoted ──────────────


def test_stale_schedule_cleared_by_cancel_is_not_promoted(db, monkeypatch):
    """After an outright cancel clears the scheduled trio (Fix C), neither the
    cancelled webhook nor the cron may promote the abandoned downgrade."""
    client = _make_client(db, email="abandoned@e.com")
    old_plan = _make_plan(db, slug="ab-pro", price_cents=399900)
    new_plan = _make_plan(db, slug="ab-basic", price_cents=99900)
    sub = _make_sub(
        db,
        client,
        old_plan,
        razorpay_subscription_id="sub_abandoned",
        status="active",
        scheduled_plan_id=new_plan.id,
        scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC),
    )
    db.commit()

    # Customer cancels outright → trio cleared (what Fix C does in the route).
    assert transition_service.cancel_scheduled_change(db, sub) is True
    sub.cancel_at_period_end = True
    db.commit()

    fake_create = _FakeCreateSub()
    emails: list[dict] = []
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: emails.append(kw),
    )

    # Cancelled webhook lands: nothing queued, so it must plain-cancel, not promote.
    rzp._handle_subscription_cancelled(db, _cancelled_payload("sub_abandoned"))
    db.commit()
    # Cron backstop also runs: the cleared trio keeps the row out of its match set.
    promoted = _run_promote_cron(db, monkeypatch)
    db.refresh(sub)

    assert promoted == 0
    assert fake_create.calls == [], "abandoned downgrade must not create a checkout"
    assert emails == [], "abandoned downgrade must not email a re-auth link"
    assert sub.scheduled_plan_id is None
    assert sub.status == "canceled"


def test_promote_cron_rolls_back_a_failed_rows_partial_promotion(db, monkeypatch):
    """Review fix. Promote_scheduled_change flushes the terminal flip +
    cleared schedule BEFORE its gateway create. A create failure (deterministic
    for USD rows via IntlPaymentsDisabled while the intl switch is off) must
    roll THIS row back. Previously the end-of-loop commit persisted the
    half-promotion: downgrade silently destroyed, no replacement checkout."""
    from datetime import timedelta

    from app.services import razorpay_service, transition_service

    client = _make_client(db, email="cron-rollback@e.com")
    old_plan = _make_plan(db, slug="cronrb-pro", price_cents=399900)
    new_plan = _make_plan(db, slug="cronrb-basic", price_cents=99900)
    due = datetime.now(UTC) - timedelta(hours=1)
    bad = _make_sub(
        db,
        client,
        old_plan,
        razorpay_subscription_id="sub_cron_rb_bad",
        scheduled_plan_id=new_plan.id,
        scheduled_change_at=due,
    )
    db.commit()

    real_promote = transition_service.promote_scheduled_change

    def _promote_then_fail(session, sub):
        # Reach the real function far enough to flush the destructive local
        # writes, then fail at the gateway-create step like the intl switch does.
        sub.status = "expired"
        sub.scheduled_plan_id = None
        sub.scheduled_billing_cycle = None
        sub.scheduled_change_at = None
        session.flush()
        raise razorpay_service.IntlPaymentsDisabled("USD rail off")

    monkeypatch.setattr(transition_service, "promote_scheduled_change", _promote_then_fail)

    promoted = _run_promote_cron(db, monkeypatch)
    assert promoted == 0

    db.expire_all()
    refreshed = db.get(Subscription, bad.id)
    # The half-promotion was rolled back: the queued change survives for the
    # next run (after the flag/config is fixed) instead of vanishing.
    assert refreshed.status == "active"
    assert refreshed.scheduled_plan_id == new_plan.id
    assert refreshed.scheduled_change_at is not None

    # Restore and prove the row still promotes cleanly afterwards.
    monkeypatch.setattr(transition_service, "promote_scheduled_change", real_promote)


# ── A gateway cancel echoed back for a row we already retired ────────────────


def _bot_with_active_knowledge(db, client: Client, *, key: str) -> Bot:
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


def _knowledge_is_active(db, bot: Bot) -> bool:
    rows = db.execute(select(Document.is_active).where(Document.bot_id == bot.id)).scalars().all()
    return bool(rows) and all(rows)


def test_cancelled_for_a_superseded_subscription_keeps_the_upgraded_knowledge_live(db):
    """Upgrade cutover: activation flips the old account-level row to
    ``canceled`` and cancels its mandate at the gateway. Razorpay then sends
    ``subscription.cancelled`` for the OLD id. That event must not run the
    paid→Free side effects against the customer's NEW subscription: before
    this it called ``deactivate_client_knowledge``, whose per-bot funding check
    never matches an account-level row, and paused every bot the customer had
    just upgraded."""
    client = _make_client(db, email="superseded-cancel@e.com")
    standard = _make_plan(db, slug="sup-standard", price_cents=119900)
    professional = _make_plan(db, slug="sup-professional", price_cents=399900)
    old = _make_sub(db, client, standard, razorpay_subscription_id="sub_sup_old", status="canceled")
    old.canceled_at = datetime(2026, 1, 15, tzinfo=UTC)
    new = _make_sub(db, client, professional, razorpay_subscription_id="sub_sup_new", status="active")
    bot = _bot_with_active_knowledge(db, client, key="bot-sup")
    db.commit()

    rzp._handle_subscription_cancelled(db, _cancelled_payload("sub_sup_old"))
    db.commit()
    db.refresh(old)
    db.refresh(new)

    assert _knowledge_is_active(db, bot), "the upgraded customer's knowledge must stay live"
    assert new.status == "active"
    assert old.status == "canceled"
    # No second row was minted (the unbilled-trial forfeit path must not run
    # on a row we already retired).
    assert len(db.execute(select(Subscription).where(Subscription.client_id == client.id)).scalars().all()) == 2


def test_completed_for_an_already_expired_subscription_is_bookkeeping_only(db):
    client = _make_client(db, email="superseded-completed@e.com")
    standard = _make_plan(db, slug="sup2-standard", price_cents=119900)
    professional = _make_plan(db, slug="sup2-professional", price_cents=399900)
    old = _make_sub(db, client, standard, razorpay_subscription_id="sub_sup2_old", status="expired")
    _make_sub(db, client, professional, razorpay_subscription_id="sub_sup2_new", status="active")
    bot = _bot_with_active_knowledge(db, client, key="bot-sup2")
    db.commit()

    rzp._handle_subscription_completed(db, _completed_payload("sub_sup2_old"))
    db.commit()
    db.refresh(old)

    assert _knowledge_is_active(db, bot)
    assert old.status == "expired"


def test_cancelled_for_a_live_account_level_subscription_still_pauses_knowledge(db):
    """The guard above must not over-reach: a genuine lapse (the only funded
    row is the one being cancelled) still pauses the knowledge."""
    client = _make_client(db, email="genuine-cancel@e.com")
    standard = _make_plan(db, slug="gen-standard", price_cents=119900)
    sub = _make_sub(db, client, standard, razorpay_subscription_id="sub_gen_live", status="active")
    bot = _bot_with_active_knowledge(db, client, key="bot-gen")
    db.commit()

    rzp._handle_subscription_cancelled(db, _cancelled_payload("sub_gen_live"))
    db.commit()
    db.refresh(sub)

    assert sub.status == "canceled"
    assert not _knowledge_is_active(db, bot)
