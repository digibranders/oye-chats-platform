"""Reconciliation sweep for orphaned operator-seat add-on subscriptions.

The seat add-on (P0-3) is a SEPARATE Razorpay subscription. Every path that
ends/supersedes the parent cancels it only best-effort, and the cutover
re-create is an external call a rolled-back activation can strand, so an
add-on can outlive its parent and keep billing ₹499/seat/month. These tests
cover ``seat_addon_reports``: it must cancel exactly the orphans (parent dead
or no local owner), leave live-owned add-ons alone, and clear the local
pointer only on a successful gateway cancel.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest

from app.db.models import Client, Plan, Subscription
from app.services import razorpay_service, seat_addon_reports

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db, email: str) -> Client:
    c = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, slug: str) -> Plan:
    p = Plan(name=slug, slug=slug, monthly_price_cents=459900, credits_per_month=1000)
    db.add(p)
    db.flush()
    return p


def _sub(db, client, plan, *, status: str, seat_addon_id: str | None, seats: int = 0) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status=status,
        payment_provider="razorpay",
        razorpay_subscription_id=f"main_{seat_addon_id or status}",
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
        seat_addon_subscription_id=seat_addon_id,
        seat_addon_quantity=seats,
        canceled_at=datetime.now(UTC) if status in ("canceled", "expired") else None,
    )
    db.add(sub)
    db.flush()
    return sub


def _gateway_addon(sub_id: str, *, status: str = "active", plan_id: str | None = None) -> dict:
    return {
        "id": sub_id,
        "status": status,
        "plan_id": plan_id or "plan_test_seat",
        "notes": {"purpose": "seat_addon"},
    }


def _patch_gateway(monkeypatch, *, gateway_items, cancelled_sink, fail_ids=()):
    monkeypatch.setattr(
        razorpay_service,
        "iter_seat_addon_subscriptions",
        lambda **_: iter(gateway_items),
    )

    def _cancel(sub_id: str) -> None:
        if sub_id in fail_ids:
            raise razorpay_service.RazorpayBillingError("gateway 500")
        cancelled_sink.append(sub_id)

    monkeypatch.setattr(razorpay_service, "cancel_seat_addon_by_id", _cancel)


def test_cancels_only_orphans_and_clears_dead_parent_pointer(db, monkeypatch):
    client = _client(db, "recon-orphan@e.com")
    plan = _plan(db, "std-recon-orphan")
    # Live parent still owns its add-on → must be left alone.
    _sub(db, client, plan, status="active", seat_addon_id="addon_live", seats=2)
    # Dead parent still points at its add-on → orphan, pointer must be cleared.
    dead = _sub(db, client, plan, status="canceled", seat_addon_id="addon_dead", seats=3)
    db.commit()

    cancelled: list[str] = []
    _patch_gateway(
        monkeypatch,
        gateway_items=[
            _gateway_addon("addon_live"),
            _gateway_addon("addon_dead"),
            _gateway_addon("addon_ghost"),  # no local owner at all
            _gateway_addon("addon_done", status="completed"),  # already dead at gateway
        ],
        cancelled_sink=cancelled,
    )

    result = seat_addon_reports.reconcile_orphaned_seat_addons(db)
    db.commit()

    assert sorted(result["orphans"]) == ["addon_dead", "addon_ghost"]
    assert sorted(result["cancelled"]) == ["addon_dead", "addon_ghost"]
    assert result["failed"] == []
    # Live add-on never cancelled; already-dead gateway sub never touched.
    assert "addon_live" not in cancelled
    assert "addon_done" not in cancelled
    # Dead parent's stale pointer is cleared so it stops advertising the add-on.
    db.refresh(dead)
    assert dead.seat_addon_subscription_id is None
    assert dead.seat_addon_quantity == 0


def test_cancel_failure_is_reported_and_pointer_left_intact(db, monkeypatch):
    client = _client(db, "recon-fail@e.com")
    plan = _plan(db, "std-recon-fail")
    dead = _sub(db, client, plan, status="expired", seat_addon_id="addon_stuck", seats=1)
    db.commit()

    cancelled: list[str] = []
    _patch_gateway(
        monkeypatch,
        gateway_items=[_gateway_addon("addon_stuck")],
        cancelled_sink=cancelled,
        fail_ids=("addon_stuck",),
    )

    result = seat_addon_reports.reconcile_orphaned_seat_addons(db)
    db.commit()

    assert result["cancelled"] == []
    assert result["failed"] == ["addon_stuck"]
    # Cancel failed → the local pointer must NOT be cleared (the mandate is
    # still live; clearing it would hide a real orphan from the next sweep).
    db.refresh(dead)
    assert dead.seat_addon_subscription_id == "addon_stuck"


def test_detect_only_mode_does_not_cancel(db, monkeypatch):
    client = _client(db, "recon-detect@e.com")
    plan = _plan(db, "std-recon-detect")
    _sub(db, client, plan, status="canceled", seat_addon_id="addon_detect", seats=1)
    db.commit()

    cancelled: list[str] = []
    _patch_gateway(monkeypatch, gateway_items=[_gateway_addon("addon_detect")], cancelled_sink=cancelled)

    result = seat_addon_reports.reconcile_orphaned_seat_addons(db, cancel=False)

    assert result["orphans"] == ["addon_detect"]
    assert result["cancelled"] == []
    assert cancelled == []


# ── F3/F4: USD rail coverage ─────────────────────────────────────────────────


def test_iterator_accepts_both_seat_rails(db, monkeypatch):
    """F3, the sweep's defensive plan-id filter must admit BOTH seat plan ids;
    filtering to the INR id alone hid every USD seat mandate from orphan
    reconciliation."""
    pages = [
        {
            "items": [
                {"id": "sub_inr", "plan_id": "plan_seat_inr", "notes": {"purpose": "seat_addon"}},
                {"id": "sub_usd", "plan_id": "plan_seat_usd", "notes": {"purpose": "seat_addon"}},
                {"id": "sub_wrongplan", "plan_id": "plan_main", "notes": {"purpose": "seat_addon"}},
                {"id": "sub_notseat", "plan_id": "plan_seat_inr", "notes": {"purpose": "topup"}},
            ]
        },
        {"items": []},
    ]

    class _FakeRzp:
        class subscription:
            @staticmethod
            def all(params):
                return pages.pop(0)

    monkeypatch.setattr(razorpay_service, "_get_razorpay", lambda: _FakeRzp())
    monkeypatch.setattr(razorpay_service, "RAZORPAY_SEAT_PLAN_ID", "plan_seat_inr")
    monkeypatch.setattr(razorpay_service, "RAZORPAY_SEAT_PLAN_ID_USD", "plan_seat_usd")

    got = [item["id"] for item in razorpay_service.iter_seat_addon_subscriptions()]
    assert got == ["sub_inr", "sub_usd"]


def test_razorpay_originated_cancellation_retires_seat_addon(db, monkeypatch):
    """F4, a cancellation arriving FROM Razorpay (customer cancelled in their
    UPI app / Razorpay's emails) must retire the seat add-on mandate like every
    other cancellation path, parking the count for a later reactivation."""
    client = _client(db, "rzp-cancel-seat@e.com")
    plan = _plan(db, "std-rzp-cancel-seat")
    sub = _sub(db, client, plan, status="active", seat_addon_id="addon_live", seats=2)
    db.commit()

    cancelled: list[str] = []

    def _fake_cancel_seat_addon(session, subscription):
        cancelled.append(subscription.seat_addon_subscription_id)
        subscription.seat_addon_subscription_id = None
        subscription.seat_addon_quantity = 0

    monkeypatch.setattr(razorpay_service, "cancel_seat_addon", _fake_cancel_seat_addon)

    razorpay_service._handle_subscription_cancelled(
        db, {"subscription": {"entity": {"id": sub.razorpay_subscription_id}}}
    )
    db.commit()
    db.refresh(sub)

    assert cancelled == ["addon_live"]
    assert sub.status == "canceled"
    assert sub.seat_addon_pending_quantity == 2  # parked, not lost


def test_seat_cancel_failure_does_not_fail_the_cancellation(db, monkeypatch):
    """A seat-cancel gateway failure is logged for reconciliation but must not
    5xx the plan-cancellation bookkeeping (the orphan sweep is the retry)."""
    client = _client(db, "rzp-cancel-seatfail@e.com")
    plan = _plan(db, "std-rzp-cancel-seatfail")
    sub = _sub(db, client, plan, status="active", seat_addon_id="addon_stuck", seats=1)
    db.commit()

    def _boom(session, subscription):
        raise razorpay_service.RazorpayBillingError("gateway down")

    monkeypatch.setattr(razorpay_service, "cancel_seat_addon", _boom)

    result = razorpay_service._handle_subscription_cancelled(
        db, {"subscription": {"entity": {"id": sub.razorpay_subscription_id}}}
    )
    db.commit()
    db.refresh(sub)

    assert "cancelled" in result
    assert sub.status == "canceled"
    assert sub.seat_addon_subscription_id == "addon_stuck"  # pointer intact for the sweep
