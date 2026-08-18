"""Downgrade cutover hardening. Land on the TARGET plan, never Free.

Under the UPI re-auth model a paid→paid downgrade cancels the old mandate at
period end and, at cutover, ``transition_service.promote_scheduled_change``
mints a NEW (unauthorized) Razorpay subscription for the lower plan. Before this
fix no local row existed until the customer re-authorized, so
``get_client_subscription`` found nothing active and entitlements fell back to
**Free**, a "downgrade to Standard" silently became a "downgrade to Free".

The fix creates a short-lived ``past_due`` GRACE subscription on the target plan
at cutover so the customer keeps target-tier entitlements during the re-auth
window. It carries no gateway mandate, so the real ``subscription.activated``
promotes it via the clean ``local is None`` branch; if the customer never
re-authorizes, ``task_expire_past_due_subscriptions`` expires it to Free after
``PAYMENT_FAILED_GRACE_DAYS``.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.models import Bot, Client, Plan, Subscription
from app.services import razorpay_service as rzp
from app.services import transition_service
from app.services.plan_service import get_client_plan, get_client_subscription
from app.services.transition_service import DOWNGRADE_REAUTH_GRACE_REASON

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="downgrade re-auth grace tests need a reachable Postgres at DB_URL",
)


# ── Builders ────────────────────────────────────────────────────────────────


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str, price_cents: int, credits: int = 1000, seats: int = 1) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=price_cents,
        annual_price_cents=price_cents * 10,
        monthly_price_usd_cents=price_cents,
        credits_per_month=credits,
        included_operator_seats=seats,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_inr_monthly",
        razorpay_plan_id_annual=f"plan_{slug}_inr_annual",
    )
    db.add(plan)
    db.flush()
    return plan


def _make_sub(db, client, plan, *, razorpay_subscription_id, new_plan) -> Subscription:
    """An active paid sub with a queued downgrade to ``new_plan`` due now."""
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id=razorpay_subscription_id,
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
        scheduled_plan_id=new_plan.id,
        scheduled_billing_cycle="monthly",
        scheduled_change_at=datetime(2026, 1, 31, tzinfo=UTC),
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


class _FakeCreateSub:
    """Records create_subscription calls; returns a realistic checkout payload."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def __call__(self, session, client, plan, billing_cycle, *, extra_notes=None, **kwargs):
        self.calls.append({"plan_id": plan.id, "extra_notes": dict(extra_notes or {})})
        return {
            "provider": "razorpay",
            "subscription_id": f"sub_new_{len(self.calls)}",
            "short_url": "https://rzp.io/i/reauth-link",
        }


def _grace_row(db, client_id: int) -> Subscription | None:
    return (
        db.execute(
            select(Subscription).where(
                Subscription.client_id == client_id,
                Subscription.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON,
            )
        )
        .scalars()
        .first()
    )


def _patch_promotion_side_effects(monkeypatch) -> _FakeCreateSub:
    fake_create = _FakeCreateSub()
    monkeypatch.setattr(rzp, "create_subscription", fake_create)
    monkeypatch.setattr(
        transition_service.email_service,
        "send_downgrade_reauth_email",
        lambda **kw: None,
    )
    return fake_create


# ── Core: cutover lands the customer on the target plan, not Free ─────────────


def test_cutover_creates_grace_row_on_target_plan(db, monkeypatch):
    client = _make_client(db, email="grace-core@e.com")
    pro = _make_plan(db, slug="g-pro", price_cents=139900, credits=10000, seats=3)
    std = _make_plan(db, slug="g-std", price_cents=94900, credits=6000, seats=2)
    sub = _make_sub(db, client, pro, razorpay_subscription_id="sub_grace_core", new_plan=std)
    db.commit()

    _patch_promotion_side_effects(monkeypatch)

    payload = transition_service.promote_scheduled_change(db, sub)
    db.commit()
    db.refresh(sub)

    assert payload is not None
    # Old row terminal, queued change consumed (unchanged existing behaviour).
    assert sub.status in ("expired", "canceled")
    assert sub.scheduled_plan_id is None

    # A grace row now carries the TARGET plan's entitlements.
    grace = _grace_row(db, client.id)
    assert grace is not None
    assert grace.plan_id == std.id
    assert grace.status == "past_due"
    assert grace.razorpay_subscription_id is None  # no mandate → clean activation path
    assert grace.past_due_since is not None  # anchors the 7-day expiry cron
    assert grace.prev_razorpay_subscription_id == "sub_grace_core"

    # The whole point: the customer resolves to Standard, NOT Free.
    assert get_client_plan(db, client.id).slug == std.slug
    resolved = get_client_subscription(db, client.id)
    assert resolved is not None and resolved.id == grace.id


def test_promotion_is_idempotent_single_grace_row(db, monkeypatch):
    """A double cutover (completed + cancelled + cron) must not mint a second
    grace row, the second call no-ops on the cleared scheduled trio."""
    client = _make_client(db, email="grace-idem@e.com")
    pro = _make_plan(db, slug="gi-pro", price_cents=139900)
    std = _make_plan(db, slug="gi-std", price_cents=94900)
    sub = _make_sub(db, client, pro, razorpay_subscription_id="sub_grace_idem", new_plan=std)
    db.commit()

    _patch_promotion_side_effects(monkeypatch)

    assert transition_service.promote_scheduled_change(db, sub) is not None
    db.commit()
    # Second fire for the same cutover.
    assert transition_service.promote_scheduled_change(db, sub) is None
    db.commit()

    grace_rows = (
        db.execute(
            select(Subscription).where(
                Subscription.client_id == client.id,
                Subscription.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON,
            )
        )
        .scalars()
        .all()
    )
    assert len(grace_rows) == 1


# ── Guard: the grace row is not mistaken for a failed payment ─────────────────


def test_grace_row_excluded_from_dunning_cycle(db, monkeypatch):
    from app.worker import tasks as worker_tasks

    client = _make_client(db, email="grace-dun@e.com")
    pro = _make_plan(db, slug="gd-pro", price_cents=139900)
    std = _make_plan(db, slug="gd-std", price_cents=94900)
    sub = _make_sub(db, client, pro, razorpay_subscription_id="sub_grace_dun", new_plan=std)
    db.commit()

    _patch_promotion_side_effects(monkeypatch)
    transition_service.promote_scheduled_change(db, sub)
    db.commit()

    sent: list[str] = []
    for name in (
        "send_payment_failed_email",
        "send_payment_action_required_email",
        "send_payment_final_warning_email",
    ):
        monkeypatch.setattr(transition_service.email_service, name, lambda *a, _n=name, **k: sent.append(_n) or True)

    emails = worker_tasks._run_dunning_cycle(db)
    db.commit()

    assert emails == 0
    assert sent == [], "a mandate-less re-auth grace row must never get a 'payment failed' email"


def test_expiry_cron_flips_grace_to_expired_and_sends_no_suspended_email(db, monkeypatch):
    from app.config import PAYMENT_FAILED_GRACE_DAYS
    from app.worker import tasks as worker_tasks

    client = _make_client(db, email="grace-exp@e.com")
    pro = _make_plan(db, slug="ge-pro", price_cents=139900)
    std = _make_plan(db, slug="ge-std", price_cents=94900)
    sub = _make_sub(db, client, pro, razorpay_subscription_id="sub_grace_exp", new_plan=std)
    db.commit()

    _patch_promotion_side_effects(monkeypatch)
    transition_service.promote_scheduled_change(db, sub)
    db.commit()

    grace = _grace_row(db, client.id)
    assert grace is not None
    # Age the grace row past the dunning grace window.
    grace.past_due_since = datetime.now(UTC) - timedelta(days=PAYMENT_FAILED_GRACE_DAYS + 1)
    db.commit()

    suspended: list[dict] = []
    monkeypatch.setattr(
        worker_tasks,
        "send_subscription_suspended_email",
        lambda *a, **k: suspended.append(k) or True,
        raising=False,
    )
    # The Pass-2 send resolves the symbol from email_service; patch both to be safe.
    monkeypatch.setattr(
        transition_service.email_service,
        "send_subscription_suspended_email",
        lambda *a, **k: suspended.append(k) or True,
        raising=False,
    )

    flipped = worker_tasks._expire_past_due_cycle(db)
    db.commit()
    db.refresh(grace)

    assert flipped >= 1
    assert grace.status == "expired"  # now drops to Free entitlements
    assert grace.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON  # preserved, not overwritten
    assert suspended == [], "a lapsed downgrade grace row is not a payment-failure suspension"


# ── Handoff: real re-auth promotes the grace row to an active target sub ──────


def test_real_activation_promotes_grace_and_sweeps_it(db, monkeypatch):
    client = _make_client(db, email="grace-act@e.com")
    pro = _make_plan(db, slug="ga-pro", price_cents=139900, credits=10000, seats=3)
    std = _make_plan(db, slug="ga-std", price_cents=94900, credits=6000, seats=2)
    sub = _make_sub(db, client, pro, razorpay_subscription_id="sub_grace_act", new_plan=std)
    db.commit()

    _patch_promotion_side_effects(monkeypatch)
    # Notification is best-effort and may reach out; neutralise it for the test.
    monkeypatch.setattr(rzp, "_emit_plan_purchased_notification", lambda *a, **k: None, raising=False)

    transition_service.promote_scheduled_change(db, sub)
    db.commit()
    grace = _grace_row(db, client.id)
    assert grace is not None and grace.status == "past_due"

    # The customer authorizes the new mandate → subscription.activated for the
    # NEW id (grace row has NULL id, so this takes the clean "local is None" path).
    payload = {
        "subscription": {
            "entity": {
                "id": "sub_new_1",
                "notes": {
                    "oyechats_client_id": str(client.id),
                    "oyechats_plan_id": str(std.id),
                    "prev_razorpay_subscription_id": "sub_grace_act",
                },
                "current_start": int(datetime(2026, 2, 1, tzinfo=UTC).timestamp()),
                "current_end": int(datetime(2026, 2, 28, tzinfo=UTC).timestamp()),
                "quantity": 1,
                "customer_id": "cust_grace",
            }
        }
    }
    rzp._handle_subscription_activated(db, payload)
    db.commit()
    db.refresh(grace)

    # Grace row swept; a real active Standard subscription now funds the account.
    assert grace.status == "canceled"
    active = get_client_subscription(db, client.id)
    assert active is not None
    assert active.razorpay_subscription_id == "sub_new_1"
    assert active.status == "active"
    assert active.plan_id == std.id
    assert get_client_plan(db, client.id).slug == std.slug


# ── /subscriptions/current exposes the grace state for the banner ─────────────


@contextmanager
def _session_cm(session):
    yield session


def _current_response(db, client, *, url="/subscriptions/current"):
    """Drive GET /subscriptions/current with the workspace owner authenticated."""
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {"client_id": client.id}
    api = TestClient(app, raise_server_exceptions=False)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        return api.get(url)


def test_current_exposes_reauth_grace_state(db, monkeypatch):
    client = _make_client(db, email="grace-banner@e.com")
    pro = _make_plan(db, slug="gb-pro", price_cents=139900)
    std = _make_plan(db, slug="gb-std", price_cents=94900, seats=2)
    sub = _make_sub(db, client, pro, razorpay_subscription_id="sub_grace_banner", new_plan=std)
    db.commit()

    _patch_promotion_side_effects(monkeypatch)
    transition_service.promote_scheduled_change(db, sub)
    db.commit()

    resp = _current_response(db, client)
    assert resp.status_code == 200
    body = resp.json()

    # The subscription still reads past_due (the raw grace status)...
    assert body["subscription"]["status"] == "past_due"
    # ...but the distinct reauth block tells the banner the real story.
    reauth = body["reauth"]
    assert reauth is not None
    assert reauth["required"] is True
    assert reauth["reason"] == "downgrade_reauth"
    assert reauth["target_plan_name"] == std.name  # the tier they downgraded TO
    assert reauth["grace_until"] is not None
    # Fresh cutover → the full grace window (7 days) is still ahead.
    from app.config import PAYMENT_FAILED_GRACE_DAYS

    assert reauth["days_left"] in (PAYMENT_FAILED_GRACE_DAYS - 1, PAYMENT_FAILED_GRACE_DAYS)


def test_current_reauth_is_null_for_ordinary_active_subscription(db):
    client = _make_client(db, email="no-grace@e.com")
    std = _make_plan(db, slug="ng-std", price_cents=94900)
    sub = Subscription(
        client_id=client.id,
        plan_id=std.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_active_ng",
        billing_cycle="monthly",
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
    )
    sub.plan = std
    db.add(sub)
    db.commit()

    resp = _current_response(db, client)
    assert resp.status_code == 200
    body = resp.json()
    assert body["subscription"]["status"] == "active"
    assert body["reauth"] is None


# ── Per-bot cleanup helper (called by the per-bot activation branch) ──────────


def _make_bot(db, client, *, bot_key: str) -> Bot:
    bot = Bot(client_id=client.id, bot_key=bot_key)
    db.add(bot)
    db.flush()
    return bot


def _make_bot_grace_row(db, client, plan, bot) -> Subscription:
    """A bot-scoped ``past_due`` re-auth grace row, as promote would mint it."""
    grace = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot.id,
        status="past_due",
        payment_provider="razorpay",
        razorpay_subscription_id=None,
        billing_cycle="monthly",
        past_due_since=datetime.now(UTC),
        cancel_reason=DOWNGRADE_REAUTH_GRACE_REASON,
    )
    grace.plan = plan
    db.add(grace)
    db.flush()
    return grace


def test_cancel_bot_scoped_reauth_grace_cancels_and_is_idempotent(db):
    client = _make_client(db, email="grace-perbot@e.com")
    std = _make_plan(db, slug="pb-std", price_cents=94900)
    bot = _make_bot(db, client, bot_key="bot-grace-pb1")
    grace = _make_bot_grace_row(db, client, std, bot)
    db.commit()

    # First call frees the (client, bot) unique-index slot for the incoming
    # bot-scoped active row.
    cancelled = transition_service.cancel_bot_scoped_reauth_grace(db, client.id, bot.id)
    db.commit()
    db.refresh(grace)

    assert cancelled == 1
    assert grace.status == "canceled"
    assert grace.canceled_at is not None
    assert grace.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON  # audit marker preserved

    # Idempotent: nothing left to cancel.
    assert transition_service.cancel_bot_scoped_reauth_grace(db, client.id, bot.id) == 0


def test_cancel_bot_scoped_reauth_grace_is_noop_for_null_bot_and_real_subs(db):
    client = _make_client(db, email="grace-noop@e.com")
    std = _make_plan(db, slug="noop-std", price_cents=94900)
    bot = _make_bot(db, client, bot_key="bot-grace-noop")

    # A REAL active bot-scoped subscription (no grace marker) must never be touched.
    real = Subscription(
        client_id=client.id,
        plan_id=std.id,
        bot_id=bot.id,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_real_pb",
        billing_cycle="monthly",
    )
    real.plan = std
    db.add(real)
    db.commit()

    # bot_id=None is a no-op (account-level grace is the existing sweep's job).
    assert transition_service.cancel_bot_scoped_reauth_grace(db, client.id, None) == 0
    # A real paid sub is out of scope (cancel_reason is not the grace marker).
    assert transition_service.cancel_bot_scoped_reauth_grace(db, client.id, bot.id) == 0
    db.refresh(real)
    assert real.status == "active"
