"""Functional-bug audit 2026-09-02: B3, B5, B7, B8, B9.

Five independent webhook/ledger defects, each pinned by one test:

* **B3** ``subscription.halted`` / ``.pending`` resurrected a row we had already
  retired (``canceled`` / ``expired``) into ``past_due`` with a fresh grace
  window, and ran the activation-grant revoke against whatever subscription the
  client is on NOW.
* **B5** ``_clawback_reasons_for`` treated the branding-removal add-on as a
  legacy plan charge, so every branding refund tried to claw a plan grant.
* **B7** A non-trial mandate cancelled BEFORE its first debit kept the full
  activation grant: a period of credits nobody ever paid for.
* **B8** ``subscription.authenticated`` did not carry ``event_id``, so a refusal
  inside the activation handler burned the provider event id and the mandate
  could never be reprocessed.
* **B9** The first period's grant was linked to its invoice only on EXACT
  period-end equality, so ordinary month-anchor drift left it unlinked and a
  later refund clawed back an unrelated period's credits.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db.models import Client, CreditLedger, Invoice, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="audit billing tests need a reachable Postgres at DB_URL",
)


# ── Builders ────────────────────────────────────────────────────────────────


def _client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _plan(db, *, slug: str, credits: int = 2500) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=119900,
        annual_price_cents=1199000,
        credits_per_month=credits,
        included_operator_seats=1,
        is_active=True,
        razorpay_plan_id_monthly=f"plan_{slug}_inr_monthly",
        razorpay_plan_id_annual=f"plan_{slug}_inr_annual",
    )
    db.add(plan)
    db.flush()
    return plan


def _sub(
    db,
    client: Client,
    plan: Plan,
    *,
    razorpay_subscription_id: str,
    status: str = "active",
    period_start: datetime | None = None,
    period_end: datetime | None = None,
) -> Subscription:
    start = period_start or datetime(2026, 1, 1, tzinfo=UTC)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status=status,
        billing_cycle="monthly",
        operator_quantity=1,
        payment_provider="razorpay",
        razorpay_subscription_id=razorpay_subscription_id,
        current_period_start=start,
        current_period_end=period_end or (start + timedelta(days=30)),
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def _event(sub_id: str) -> dict:
    return {"subscription": {"entity": {"id": sub_id}}}


# ── B3 ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("handler", "terminal_status"),
    [
        (rzp._handle_subscription_halted, "canceled"),
        (rzp._handle_subscription_pending, "expired"),
    ],
)
def test_b3_dunning_events_do_not_resurrect_a_retired_row(db, handler, terminal_status):
    """A halted/pending echo for a mandate WE retired changes nothing.

    Razorpay keeps emitting dunning events for a mandate after an upgrade
    supersedes it or the dunning expiry ends it. Applying them would put a dead
    row back into ``past_due`` (a live status, at the purchased tier) with a
    fresh grace clock, and would revoke credits the client's CURRENT
    subscription granted.
    """
    client = _client(db, email=f"b3-{terminal_status}@e.com")
    plan = _plan(db, slug=f"b3{terminal_status}")
    retired = _sub(db, client, plan, razorpay_subscription_id="sub_b3_retired", status=terminal_status)
    retired.last_granted_period_end = retired.current_period_end
    db.flush()

    # Credits the account holds under whatever it is on now.
    credit_service.grant_plan_credits(db, client.id, 2500, note="current plan grant")
    db.flush()
    balance_before = credit_service.get_balance(db, client.id)

    message = handler(db, _event("sub_b3_retired"))

    db.refresh(retired)
    assert f"already {terminal_status} locally" in message
    assert retired.status == terminal_status
    assert retired.past_due_since is None
    assert retired.last_granted_period_end == retired.current_period_end
    assert credit_service.get_balance(db, client.id) == balance_before


def test_b3_dunning_events_still_apply_to_a_live_row(db):
    """The guard is terminal-only: a live subscription still enters past_due."""
    client = _client(db, email="b3-live@e.com")
    plan = _plan(db, slug="b3live")
    live = _sub(db, client, plan, razorpay_subscription_id="sub_b3_live", status="active")

    rzp._handle_subscription_halted(db, _event("sub_b3_live"))

    db.refresh(live)
    assert live.status == "past_due"
    assert live.past_due_since is not None


# ── B5 ──────────────────────────────────────────────────────────────────────


def test_b5_branding_addon_refund_claws_back_nothing():
    """A branding-removal charge funds no credits, exactly like a seat charge.

    Falling through to the legacy branch made a branding refund hunt for a plan
    grant it never funded (and log a false "review manually" error).
    """
    from app.db.models import ADDON_INVOICE_KINDS

    assert "branding" in ADDON_INVOICE_KINDS
    for kind in ADDON_INVOICE_KINDS:
        assert rzp._clawback_reasons_for(Invoice(kind=kind, subscription_id=7)) is None
    assert rzp._clawback_reasons_for(Invoice(kind="withheld_charge", subscription_id=7)) is None
    # Unchanged for the kinds that DO fund credits.
    assert rzp._clawback_reasons_for(Invoice(kind="plan_charge", subscription_id=7)) == ("plan_grant",)
    assert rzp._clawback_reasons_for(Invoice(kind="topup", subscription_id=None)) == ("topup",)


# ── B7 ──────────────────────────────────────────────────────────────────────


def test_b7_cancel_before_the_first_debit_revokes_the_activation_grant(db):
    """UPI grants the first period at activation; a cancel before the debit must reverse it.

    No paid plan invoice exists on the subscription, so the grant was never
    paid for. The marker rolls back to the period start so a later retry can
    re-grant cleanly.
    """
    client = _client(db, email="b7@e.com")
    plan = _plan(db, slug="b7standard")
    sub = _sub(db, client, plan, razorpay_subscription_id="sub_b7", status="active")
    credit_service.grant_for_subscription(db, sub)
    sub.last_granted_period_end = sub.current_period_end
    db.flush()
    assert credit_service.get_balance(db, client.id) == 2500

    rzp._handle_subscription_cancelled(db, _event("sub_b7"))

    db.refresh(sub)
    assert sub.status == "canceled"
    assert credit_service.get_balance(db, client.id) == 0
    assert sub.last_granted_period_end == sub.current_period_start


def test_b7_cancel_after_a_paid_charge_keeps_the_credits(db):
    """A customer who actually paid for the period keeps what they bought."""
    client = _client(db, email="b7paid@e.com")
    plan = _plan(db, slug="b7paid")
    sub = _sub(db, client, plan, razorpay_subscription_id="sub_b7_paid", status="active")
    credit_service.grant_for_subscription(db, sub)
    sub.last_granted_period_end = sub.current_period_end
    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=sub.id,
            kind="plan_charge",
            status="paid",
            amount_cents=119900,
            currency="INR",
        )
    )
    db.flush()

    rzp._handle_subscription_cancelled(db, _event("sub_b7_paid"))

    db.refresh(sub)
    assert credit_service.get_balance(db, client.id) == 2500
    assert sub.last_granted_period_end == sub.current_period_end


# ── B8 ──────────────────────────────────────────────────────────────────────


def test_b8_authenticated_carries_the_event_id_into_activation(monkeypatch):
    """A refusal inside activation must be able to release the idempotency key.

    Without the id threaded through ``subscription.authenticated``, the provider
    event was burned on work that never persisted, and the mandate could never
    be reprocessed.
    """
    seen: dict[str, object] = {}

    def _fake_activated(session, payload, *, event_id=None):
        seen["event_id"] = event_id
        return "ok"

    monkeypatch.setattr(rzp, "_handle_subscription_activated", _fake_activated)

    payload = {
        "subscription": {
            "entity": {
                "id": "sub_b8",
                "notes": {"oyechats_promotion_id": "5"},
            }
        }
    }
    assert rzp._handle_subscription_authenticated(None, payload, event_id="evt_b8") == "ok"
    assert seen["event_id"] == "evt_b8"


# ── B9 ──────────────────────────────────────────────────────────────────────


def test_b9_invoice_link_is_backfilled_despite_month_anchor_drift(db):
    """The activation grant gets its invoice link even when the dates drift.

    The renewal marker day-clamps a month-end anchor while Razorpay's
    ``current_end`` re-expands it, so the two describe one cycle a few days
    apart. Exact equality left the grant unlinked forever, and a later refund of
    that invoice fell back to "most recent grant in scope".
    """
    client = _client(db, email="b9@e.com")
    plan = _plan(db, slug="b9standard")
    marker = datetime(2026, 2, 28, tzinfo=UTC)
    sub = _sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_b9",
        period_start=datetime(2026, 1, 31, tzinfo=UTC),
        period_end=marker,
    )
    credit_service.grant_for_subscription(db, sub)  # activation-time, no reference_id
    sub.last_granted_period_end = marker
    db.flush()

    invoice = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        kind="plan_charge",
        status="paid",
        amount_cents=119900,
        currency="INR",
    )
    db.add(invoice)
    db.flush()

    granted = credit_service.grant_subscription_period_once(
        db,
        sub,
        datetime(2026, 3, 3, tzinfo=UTC),  # 3 days past the marker: same cycle
        invoice_id=invoice.id,
    )

    assert granted is False  # still no double grant
    grant = db.execute(
        select(CreditLedger).where(CreditLedger.client_id == client.id, CreditLedger.delta > 0)
    ).scalar_one()
    assert grant.reference_id == invoice.id


def test_b9_a_stale_older_period_replay_is_not_linked(db):
    """A replay of a genuinely older period stays unlinked.

    Real cycles are ≥ 28 days, far outside the tolerance, so widening the match
    cannot misattribute an old invoice onto the current period's grant.
    """
    client = _client(db, email="b9stale@e.com")
    plan = _plan(db, slug="b9stale")
    marker = datetime(2026, 3, 1, tzinfo=UTC)
    sub = _sub(
        db,
        client,
        plan,
        razorpay_subscription_id="sub_b9_stale",
        period_start=datetime(2026, 2, 1, tzinfo=UTC),
        period_end=marker,
    )
    credit_service.grant_for_subscription(db, sub)
    sub.last_granted_period_end = marker
    db.flush()

    old_invoice = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        kind="plan_charge",
        status="paid",
        amount_cents=119900,
        currency="INR",
    )
    db.add(old_invoice)
    db.flush()

    granted = credit_service.grant_subscription_period_once(
        db,
        sub,
        datetime(2026, 2, 1, tzinfo=UTC),  # the PREVIOUS period, replayed
        invoice_id=old_invoice.id,
    )

    assert granted is False
    grant = db.execute(
        select(CreditLedger).where(CreditLedger.client_id == client.id, CreditLedger.delta > 0)
    ).scalar_one()
    assert grant.reference_id is None
