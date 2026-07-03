"""BL-1 + NB-3 remediation — scheduled downgrade survives cutover, no silent strand.

Under the UPI re-auth model a scheduled paid downgrade cancels the old mandate
``at_period_end`` and queues ``scheduled_plan_id``. Razorpay fires
``subscription.cancelled`` (NOT ``subscription.completed``) at the cutover of a
``cancel_at_cycle_end`` mandate. The bugs fixed here:

* BL-1 — ``subscription.cancelled`` was scheduled-change-blind: it flipped the
  row to ``canceled`` and the queued downgrade was lost. Fixed by routing both
  the ``cancelled`` and ``completed`` handlers through a shared
  ``_promote_scheduled_if_pending`` helper, and by widening the cron backstop to
  re-include ``canceled`` rows that still carry ``scheduled_plan_id``.
* NB-3 — promotion created the new lower-plan checkout but never told the
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

from app.db.models import Client, Plan, Subscription
from app.services import razorpay_service as rzp
from app.services import transition_service

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

    # Customer notified with the re-auth link — not silently stranded.
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
    """A cancel with no queued downgrade must do the plain terminal cancel — no
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


def test_promotion_is_idempotent(db, monkeypatch):
    """completed + cancelled + cron can all fire for the same cutover. Only the
    first promotes; later calls are no-ops (scheduled trio already cleared)."""
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
