"""Finding B: a plan's DB price and its immutable Razorpay plan must never
diverge.

Root-cause fix: editing a plan's price re-mints the Razorpay plan and swaps the
id in the same update, so every future charge matches the displayed price.
(Razorpay plans are immutable; without the re-mint the catalog quotes the new
price while new mandates keep debiting the old plan.)
"""

import os
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from app.db.models import Client, Plan
from app.services import razorpay_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


# ── create_plan_for_price (pure, no DB) ──────────────────────────────────────


def test_create_plan_for_price_returns_id():
    rzp = MagicMock()
    rzp.plan.create.return_value = {"id": "plan_NEW"}
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        pid = razorpay_service.create_plan_for_price(name="Standard (monthly)", amount_paise=559900, period="monthly")
    assert pid == "plan_NEW"
    assert rzp.plan.create.call_args.kwargs["data"]["item"]["amount"] == 559900


def test_create_plan_for_price_rejects_nonpositive():
    with pytest.raises(ValueError):
        razorpay_service.create_plan_for_price(name="x", amount_paise=0, period="monthly")


# ── update_plan resync (DB) ──────────────────────────────────────────────────


def test_update_plan_mints_new_rzp_plan_on_price_change(db, monkeypatch):
    from app.api import superadmin_plan_routes as spr

    plan = Plan(
        name="Standard",
        slug="standard",
        monthly_price_cents=459900,
        annual_price_cents=4599000,
        currency="INR",
        razorpay_plan_id_monthly="plan_OLD",
        is_active=True,
    )
    db.add(plan)
    db.flush()
    db.commit()
    plan_id = plan.id

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(spr, "get_session", _fake_session)
    minted = {}

    def _fake_create(*, name, amount_paise, period, currency="INR"):
        minted["amount"] = amount_paise
        minted["period"] = period
        return "plan_NEW"

    monkeypatch.setattr("app.services.razorpay_service.create_plan_for_price", _fake_create)

    superadmin = Client(name="SA", email="sa-b@test.local", hashed_password="x", api_key="k-sa-b", is_superadmin=True)
    db.add(superadmin)
    db.flush()

    spr.update_plan(plan_id, spr.UpdatePlanRequest(monthly_price_cents=559900), superadmin=superadmin)

    refreshed = db.get(Plan, plan_id)
    assert refreshed.monthly_price_cents == 559900
    assert refreshed.razorpay_plan_id_monthly == "plan_NEW"  # id swapped
    assert minted == {"amount": 559900, "period": "monthly"}


def test_update_plan_without_price_change_does_not_mint(db, monkeypatch):
    from app.api import superadmin_plan_routes as spr

    plan = Plan(
        name="Starter",
        slug="starter",
        monthly_price_cents=179900,
        annual_price_cents=1799000,
        currency="INR",
        razorpay_plan_id_monthly="plan_KEEP",
        is_active=True,
    )
    db.add(plan)
    db.flush()
    db.commit()
    plan_id = plan.id

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(spr, "get_session", _fake_session)

    def _boom(**_):
        raise AssertionError("create_plan_for_price must not be called when price is unchanged")

    monkeypatch.setattr("app.services.razorpay_service.create_plan_for_price", _boom)

    superadmin = Client(name="SA", email="sa-b2@test.local", hashed_password="x", api_key="k-sa-b2", is_superadmin=True)
    db.add(superadmin)
    db.flush()

    # Change only the description — no price field touched.
    spr.update_plan(plan_id, spr.UpdatePlanRequest(description="new copy"), superadmin=superadmin)
    refreshed = db.get(Plan, plan_id)
    assert refreshed.razorpay_plan_id_monthly == "plan_KEEP"


def test_update_plan_price_to_zero_clears_id_without_500(db, monkeypatch):
    """Finding: setting a price to 0 (make a tier free) must not raise an
    uncaught 500 — create_plan_for_price rejects a non-positive amount. Instead
    the gateway id is cleared and the edit succeeds."""
    from app.api import superadmin_plan_routes as spr

    plan = Plan(
        name="Standard",
        slug="std-tozero",
        monthly_price_cents=94900,
        annual_price_cents=910800,
        currency="INR",
        razorpay_plan_id_monthly="plan_OLD_ZERO",
        is_active=True,
    )
    db.add(plan)
    db.flush()
    db.commit()
    plan_id = plan.id

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(spr, "get_session", _fake_session)

    def _boom(**_):
        raise AssertionError("create_plan_for_price must not be called for a 0 price")

    monkeypatch.setattr("app.services.razorpay_service.create_plan_for_price", _boom)

    superadmin = Client(name="SA", email="sa-z@test.local", hashed_password="x", api_key="k-sa-z", is_superadmin=True)
    db.add(superadmin)
    db.flush()

    # No exception (was an uncaught 500 before); id cleared, price zeroed.
    spr.update_plan(plan_id, spr.UpdatePlanRequest(monthly_price_cents=0), superadmin=superadmin)
    refreshed = db.get(Plan, plan_id)
    assert refreshed.monthly_price_cents == 0
    assert refreshed.razorpay_plan_id_monthly is None


def test_get_default_plan_ignores_deactivated_default(db, monkeypatch):
    """Finding: a deactivated-but-still-default plan must never be handed to new
    signups. get_default_plan filters is_active; delete_plan also clears the flag."""
    from app.api import superadmin_plan_routes as spr
    from app.services import plan_service

    active_default = Plan(name="Free", slug="free-dp", monthly_price_cents=0, is_active=True, is_default=True)
    db.add(active_default)
    db.flush()
    db.commit()

    # While active, it is the resolved default.
    assert plan_service.get_default_plan(db).id == active_default.id

    @contextmanager
    def _fake_session():
        yield db

    monkeypatch.setattr(spr, "get_session", _fake_session)
    superadmin = Client(name="SA", email="sa-dp@test.local", hashed_password="x", api_key="k-sa-dp", is_superadmin=True)
    db.add(superadmin)
    db.flush()

    # Deactivating the default clears the flag on soft-delete.
    spr.delete_plan(active_default.id, superadmin=superadmin)

    db.refresh(active_default)
    assert active_default.is_default is False
    assert active_default.is_active is False
    # No active default remains → resolver returns None (caller falls back to free slug).
    assert plan_service.get_default_plan(db) is None
