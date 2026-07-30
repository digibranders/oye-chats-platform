"""The operator-seat add-on (P0-3) is a SEPARATE Razorpay subscription from the
main plan. Three places that end or replace the main subscription previously
never touched it, leaving it as a permanently-billing orphan and silently
dropping the customer's paid seats on plan changes:

1. ``POST /subscription/cancel`` — cancelling the plan left the seat add-on
   running forever.
2. ``_handle_subscription_activated``'s sibling-cancel sweep (immediate
   upgrade / resume cutover) — the old seat add-on was never cancelled, and
   the new subscription never got one, even if the customer had paid seats.
3. ``promote_scheduled_change`` (scheduled downgrade cutover) — same gap.

These tests are regression guards for the fix: seat add-ons must be
cancelled with the subscription they're attached to, and carried forward
(re-created) on any subscription that supersedes it.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.api.subscription_routes import CancelSubscriptionRequest
from app.api.subscription_routes import cancel_subscription as cancel_subscription_route
from app.db.models import Client, Plan, Subscription
from app.services import razorpay_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture(autouse=True)
def _seat_plan_configured():
    """Seat billing is env-only with no baked-in default (``RAZORPAY_SEAT_PLAN_ID``).
    Configure it for the suite so the seat add-on carry/create paths run instead of
    raising ``RazorpayBillingError`` — mirrors the patch in ``test_razorpay_service``.
    """
    with patch.object(razorpay_service, "RAZORPAY_SEAT_PLAN_ID", "plan_test_seat"):
        yield


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str, price_cents: int = 459900, credits: int = 1000) -> Plan:
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
    razorpay_subscription_id: str | None,
    status: str = "active",
    seat_addon_subscription_id: str | None = None,
    seat_addon_quantity: int = 0,
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
        seat_addon_subscription_id=seat_addon_subscription_id,
        seat_addon_quantity=seat_addon_quantity,
    )
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def _activation_payload(*, razorpay_sub_id: str, client_id: int, plan_id: int, prev_sub_id: str | None = None) -> dict:
    notes: dict[str, str] = {"oyechats_client_id": str(client_id), "oyechats_plan_id": str(plan_id)}
    if prev_sub_id is not None:
        notes["prev_razorpay_subscription_id"] = prev_sub_id
    return {
        "subscription": {
            "entity": {
                "id": razorpay_sub_id,
                "notes": notes,
                "current_start": int(datetime(2026, 1, 1, tzinfo=UTC).timestamp()),
                "current_end": int(datetime(2026, 1, 31, tzinfo=UTC).timestamp()),
                "quantity": 1,
                "customer_id": "cust_test",
            }
        }
    }


# ── 1. /subscription/cancel also cancels the seat add-on ──────────────────────


def test_cancel_route_cancels_seat_addon(mock_db_session, mock_get_session):
    sub = SimpleNamespace(
        id=10,
        client_id=1,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_main_1",
        seat_addon_subscription_id="sub_addon_1",
        seat_addon_quantity=2,
        cancel_at_period_end=False,
        canceled_at=None,
        cancel_reason=None,
    )
    client = SimpleNamespace(id=1)

    def _fake_cancel_addon(session, sub_arg):
        sub_arg.seat_addon_subscription_id = None
        sub_arg.seat_addon_quantity = 0

    with (
        patch("app.api.subscription_routes.get_session", mock_get_session),
        patch("app.api.subscription_routes.lock_client_for_billing", MagicMock()),
        patch("app.api.subscription_routes._resolve_target_subscription", return_value=sub),
        patch("app.services.razorpay_service.cancel_subscription", MagicMock()) as mock_cancel_main,
        patch("app.services.razorpay_service.cancel_seat_addon") as mock_cancel_addon,
        patch("app.services.transition_service.cancel_scheduled_change", MagicMock()),
    ):
        mock_cancel_addon.side_effect = _fake_cancel_addon
        cancel_subscription_route(CancelSubscriptionRequest(), client)

    mock_cancel_main.assert_called_once()
    mock_cancel_addon.assert_called_once_with(mock_db_session, sub)
    assert sub.seat_addon_subscription_id is None
    assert sub.seat_addon_quantity == 0


def test_cancel_route_seat_addon_failure_does_not_block_plan_cancel(mock_db_session, mock_get_session):
    """A failing seat-addon cancel must not raise — the plan cancel already succeeded."""
    sub = SimpleNamespace(
        id=11,
        client_id=1,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_main_2",
        seat_addon_subscription_id="sub_addon_2",
        seat_addon_quantity=1,
        cancel_at_period_end=False,
        canceled_at=None,
        cancel_reason=None,
    )
    client = SimpleNamespace(id=1)

    with (
        patch("app.api.subscription_routes.get_session", mock_get_session),
        patch("app.api.subscription_routes.lock_client_for_billing", MagicMock()),
        patch("app.api.subscription_routes._resolve_target_subscription", return_value=sub),
        patch("app.services.razorpay_service.cancel_subscription", MagicMock()),
        patch("app.services.razorpay_service.cancel_seat_addon", side_effect=RuntimeError("gateway 500")),
        patch("app.services.transition_service.cancel_scheduled_change", MagicMock()),
    ):
        result = cancel_subscription_route(CancelSubscriptionRequest(), client)

    assert "message" in result
    assert sub.cancel_at_period_end is True


# ── 2. Immediate upgrade / resume cutover carries the seat add-on forward ──────


def test_activation_cancels_old_seat_addon_and_carries_to_new_sub(db):
    from app.services import razorpay_service as rzp

    client = _make_client(db, email="seatcutover@e.com")
    std = _make_plan(db, slug="std-seatcut")
    pro = _make_plan(db, slug="pro-seatcut")
    old = _make_sub(
        db,
        client,
        std,
        razorpay_subscription_id="sub_old_seatcut",
        status="active",
        seat_addon_subscription_id="sub_addon_old",
        seat_addon_quantity=3,
    )
    db.commit()

    fake = MagicMock()
    fake.subscription.create.return_value = {"id": "sub_addon_new"}
    payload = _activation_payload(
        razorpay_sub_id="sub_new_seatcut",
        client_id=client.id,
        plan_id=pro.id,
        prev_sub_id="sub_old_seatcut",
    )

    with patch.object(rzp, "_get_razorpay", return_value=fake):
        rzp._handle_subscription_activated(db, payload)
    db.commit()

    # Old seat add-on was cancelled at the gateway (immediate — cancel_at_cycle_end=0).
    addon_cancel_calls = [c for c in fake.subscription.cancel.call_args_list if c.args[0] == "sub_addon_old"]
    assert len(addon_cancel_calls) == 1, fake.subscription.cancel.call_args_list
    assert addon_cancel_calls[0].kwargs["data"] == {"cancel_at_cycle_end": 0}

    db.refresh(old)
    assert old.seat_addon_subscription_id is None
    assert old.seat_addon_quantity == 0

    # New subscription got a FRESH seat add-on carrying the same seat count.
    create_calls = [
        c
        for c in fake.subscription.create.call_args_list
        if c.kwargs.get("data", {}).get("notes", {}).get("purpose") == "seat_addon"
    ]
    assert len(create_calls) == 1, fake.subscription.create.call_args_list
    assert create_calls[0].kwargs["data"]["quantity"] == 3

    new = db.query(Subscription).filter_by(razorpay_subscription_id="sub_new_seatcut").one()
    assert new.seat_addon_subscription_id == "sub_addon_new"
    # Carry now GATES entitlement on re-auth: pending set, quantity 0 until
    # the customer authorizes the new seat mandate (finding A follow-up).
    assert new.seat_addon_pending_quantity == 3
    assert new.seat_addon_quantity == 0


def test_activation_without_old_seat_addon_does_not_create_one(db):
    """No seats to carry -> no add-on subscription is minted for the new sub."""
    from app.services import razorpay_service as rzp

    client = _make_client(db, email="noseat@e.com")
    std = _make_plan(db, slug="std-noseat")
    pro = _make_plan(db, slug="pro-noseat")
    _make_sub(db, client, std, razorpay_subscription_id="sub_old_noseat", status="active")
    db.commit()

    fake = MagicMock()
    payload = _activation_payload(
        razorpay_sub_id="sub_new_noseat",
        client_id=client.id,
        plan_id=pro.id,
        prev_sub_id="sub_old_noseat",
    )

    with patch.object(rzp, "_get_razorpay", return_value=fake):
        rzp._handle_subscription_activated(db, payload)
    db.commit()

    addon_create_calls = [
        c
        for c in fake.subscription.create.call_args_list
        if c.kwargs.get("data", {}).get("notes", {}).get("purpose") == "seat_addon"
    ]
    assert addon_create_calls == []

    new = db.query(Subscription).filter_by(razorpay_subscription_id="sub_new_noseat").one()
    assert new.seat_addon_subscription_id is None
    assert new.seat_addon_quantity == 0


def test_downstream_failure_does_not_mint_orphan_addon(db):
    """Create-then-rollback orphan window (review finding): the seat add-on
    re-create must run AFTER every fail-prone activation DB write, so a later
    failure can't strand a freshly-minted add-on live at the gateway with no
    local owner. Here proration raises; the new add-on must never have been
    created. Before the reorder the add-on was minted first, so this same
    proration failure would have left a live orphan."""
    from app.services import razorpay_service as rzp

    client = _make_client(db, email="reorder-orphan@e.com")
    std = _make_plan(db, slug="std-reorder")
    pro = _make_plan(db, slug="pro-reorder")
    _make_sub(
        db,
        client,
        std,
        razorpay_subscription_id="sub_old_reorder",
        status="active",
        seat_addon_subscription_id="sub_addon_reorder_old",
        seat_addon_quantity=3,
    )
    db.commit()

    fake = MagicMock()
    fake.subscription.create.return_value = {"id": "sub_addon_reorder_new"}
    payload = _activation_payload(
        razorpay_sub_id="sub_new_reorder",
        client_id=client.id,
        plan_id=pro.id,
        prev_sub_id="sub_old_reorder",
    )

    with (
        patch.object(rzp, "_get_razorpay", return_value=fake),
        patch(
            "app.services.transition_service.apply_pending_proration",
            side_effect=RuntimeError("proration boom"),
        ),
        pytest.raises(RuntimeError, match="proration boom"),
    ):
        rzp._handle_subscription_activated(db, payload)
    db.rollback()

    addon_create_calls = [
        c
        for c in fake.subscription.create.call_args_list
        if c.kwargs.get("data", {}).get("notes", {}).get("purpose") == "seat_addon"
    ]
    assert addon_create_calls == [], fake.subscription.create.call_args_list


# ── 3. Scheduled-downgrade cutover carries the seat add-on forward ─────────────


def test_promote_scheduled_change_cancels_old_seat_addon_and_carries_notes(db):
    from app.services import razorpay_service as rzp
    from app.services import transition_service

    client = _make_client(db, email="downgrade-seat@e.com")
    pro = _make_plan(db, slug="pro-dgseat")
    std = _make_plan(db, slug="std-dgseat")
    sub = _make_sub(
        db,
        client,
        pro,
        razorpay_subscription_id="sub_old_dgseat",
        status="active",
        seat_addon_subscription_id="sub_addon_dg",
        seat_addon_quantity=2,
    )
    sub.scheduled_plan_id = std.id
    sub.scheduled_billing_cycle = "monthly"
    sub.scheduled_change_at = sub.current_period_end
    db.commit()

    fake = MagicMock()
    fake.subscription.create.return_value = {
        "id": "sub_new_dgseat",
        "short_url": "https://rzp.io/i/abc",
    }

    with (
        patch.object(rzp, "_get_razorpay", return_value=fake),
        patch("app.services.transition_service.email_service.send_downgrade_reauth_email", MagicMock()),
    ):
        payload = transition_service.promote_scheduled_change(db, sub)
    db.commit()

    assert payload is not None

    # Old seat add-on cancelled at the gateway.
    addon_cancel_calls = [c for c in fake.subscription.cancel.call_args_list if c.args[0] == "sub_addon_dg"]
    assert len(addon_cancel_calls) == 1

    db.refresh(sub)
    assert sub.seat_addon_subscription_id is None
    assert sub.status == "expired"

    # The seat count travelled forward via the new subscription's notes so
    # the eventual activation webhook can re-create the add-on.
    main_create_calls = [
        c
        for c in fake.subscription.create.call_args_list
        if c.kwargs.get("data", {}).get("notes", {}).get("purpose") != "seat_addon"
    ]
    assert len(main_create_calls) == 1
    assert main_create_calls[0].kwargs["data"]["notes"]["carried_seat_count"] == "2"


def test_promote_scheduled_change_seat_carry_reaches_activation(db):
    """End-to-end: schedule a downgrade with seats, promote it, then feed the
    resulting checkout's notes through the activation webhook — the new
    subscription should come out the other side with the seats intact."""
    from app.services import razorpay_service as rzp
    from app.services import transition_service

    client = _make_client(db, email="downgrade-seat-e2e@e.com")
    pro = _make_plan(db, slug="pro-dge2e")
    std = _make_plan(db, slug="std-dge2e")
    sub = _make_sub(
        db,
        client,
        pro,
        razorpay_subscription_id="sub_old_dge2e",
        status="active",
        seat_addon_subscription_id="sub_addon_dge2e",
        seat_addon_quantity=4,
    )
    sub.scheduled_plan_id = std.id
    sub.scheduled_billing_cycle = "monthly"
    sub.scheduled_change_at = sub.current_period_end
    db.commit()

    fake = MagicMock()
    fake.subscription.create.return_value = {
        "id": "sub_new_dge2e",
        "short_url": "https://rzp.io/i/def",
    }

    with (
        patch.object(rzp, "_get_razorpay", return_value=fake),
        patch("app.services.transition_service.email_service.send_downgrade_reauth_email", MagicMock()),
    ):
        transition_service.promote_scheduled_change(db, sub)
    db.commit()

    # Simulate the activation webhook for the freshly-minted subscription,
    # carrying forward the notes create_subscription actually sent.
    sent_notes = next(
        c.kwargs["data"]["notes"]
        for c in fake.subscription.create.call_args_list
        if c.kwargs.get("data", {}).get("notes", {}).get("purpose") != "seat_addon"
    )
    fake.subscription.create.return_value = {"id": "sub_addon_dge2e_new"}
    activation_payload = {
        "subscription": {
            "entity": {
                "id": "sub_new_dge2e",
                "notes": {**sent_notes, "oyechats_client_id": str(client.id), "oyechats_plan_id": str(std.id)},
                "current_start": int(datetime(2026, 2, 1, tzinfo=UTC).timestamp()),
                "current_end": int(datetime(2026, 2, 28, tzinfo=UTC).timestamp()),
                "quantity": 1,
                "customer_id": "cust_test",
            }
        }
    }
    with patch.object(rzp, "_get_razorpay", return_value=fake):
        rzp._handle_subscription_activated(db, activation_payload)
    db.commit()

    new = db.query(Subscription).filter_by(razorpay_subscription_id="sub_new_dge2e").one()
    assert new.seat_addon_subscription_id == "sub_addon_dge2e_new"
    assert new.seat_addon_pending_quantity == 4
    assert new.seat_addon_quantity == 0
