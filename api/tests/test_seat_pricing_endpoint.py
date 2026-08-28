"""``GET /superadmin/billing/seat-pricing`` and the per-plan ``drifted`` flag.

``_reject_seat_price_drift`` accepts only ``0`` or the canonical seat price, but
nothing served that constant, so a console could only hard-code it or learn it
from a 422. The endpoint serves both rails' prices AND whether each rail's
Razorpay seat plan id is actually set, because a price with no configured
add-on is a price nobody can buy.

``drifted`` on ``GET /superadmin/plans`` uses the definition already logged at
WARNING level in ``subscription_routes.update_seats``.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import config as app_config
from app.api import superadmin_plan_routes
from app.api.auth import get_superadmin
from app.config import EXTRA_SEAT_PRICE_USD_CENTS, RAZORPAY_SEAT_PLAN_PRICE_CENTS
from app.db.models import Plan

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="seat-pricing route tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _ctx(session):
    yield session


def _api(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_plan_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_plan_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=1, is_superadmin=True)
    return TestClient(app, raise_server_exceptions=False)


def _plan(db, **kwargs) -> Plan:
    row = Plan(currency="INR", **kwargs)
    db.add(row)
    db.flush()
    return row


def test_seat_pricing_serves_both_canonical_constants(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    monkeypatch.setattr(app_config, "RAZORPAY_SEAT_PLAN_ID", "plan_SEATINR")
    monkeypatch.setattr(app_config, "RAZORPAY_SEAT_PLAN_ID_USD", "plan_SEATUSD")

    res = api.get("/superadmin/billing/seat-pricing")
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["inr"]["currency"] == "INR"
    assert body["inr"]["price_cents"] == RAZORPAY_SEAT_PLAN_PRICE_CENTS
    assert body["usd"]["currency"] == "USD"
    assert body["usd"]["price_cents"] == EXTRA_SEAT_PRICE_USD_CENTS
    assert body["inr"]["plan_configured"] is True
    assert body["usd"]["plan_configured"] is True
    # The gateway ids themselves are never echoed.
    assert "plan_SEATINR" not in res.text
    assert "plan_SEATUSD" not in res.text


def test_seat_pricing_reports_an_unconfigured_rail(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    monkeypatch.setattr(app_config, "RAZORPAY_SEAT_PLAN_ID", "plan_SEATINR")
    monkeypatch.setattr(app_config, "RAZORPAY_SEAT_PLAN_ID_USD", None)

    body = api.get("/superadmin/billing/seat-pricing").json()

    assert body["inr"]["plan_configured"] is True
    # razorpay_service raises RazorpayBillingError on this rail until the env
    # var is set, so the price alone would be a quote nobody can act on.
    assert body["usd"]["plan_configured"] is False
    assert body["usd"]["plan_id_env_var"] == "RAZORPAY_SEAT_PLAN_ID_USD"


def test_plan_rows_report_seat_price_drift(db, monkeypatch) -> None:
    api = _api(db, monkeypatch)
    canonical = _plan(
        db,
        name="Canonical",
        slug="canonical",
        included_operator_seats=1,
        extra_seat_price_cents=RAZORPAY_SEAT_PLAN_PRICE_CENTS,
    )
    off_constant = _plan(
        db,
        name="Legacy",
        slug="legacy",
        included_operator_seats=1,
        # Predates the write-time guard: it charges ₹449 but advertises ₹299.
        extra_seat_price_cents=29900,
    )
    zero_priced = _plan(
        db,
        name="Zero",
        slug="zero",
        included_operator_seats=1,
        extra_seat_price_cents=0,
    )
    unlimited = _plan(
        db,
        name="Enterprise",
        slug="enterprise-seats",
        included_operator_seats=-1,
        extra_seat_price_cents=0,
    )
    db.commit()

    rows = {p["id"]: p for p in api.get("/superadmin/plans").json()}

    assert rows[canonical.id]["drifted"] is False
    assert rows[off_constant.id]["drifted"] is True
    # 0 with billable seats still sells at the canonical price while displaying
    # nothing, which is the exact divergence update_seats logs.
    assert rows[zero_priced.id]["drifted"] is True
    # UNLIMITED included seats can never sell an add-on (/seats 400s first).
    assert rows[unlimited.id]["drifted"] is False


@pytest.mark.parametrize(
    ("seats", "price", "drifted", "why"),
    [
        (2, 50_000, False, "the canonical price is what the add-on charges"),
        (2, 49_999, True, "one paisa off is a price the customer is shown and never billed"),
        (2, 100_000, True, "twice the price is still not the price"),
        (2, 44_900, True, "the shipped default is NOT canonical once the constant moves"),
        (2, 0, True, "0 displays nothing while /seats still sells at the canonical price"),
        (2, None, True, "a NULL column reads as 0, which is the same defect"),
        (1, 50_000, False, "included seats do not change the add-on's price"),
        (-1, 0, False, "UNLIMITED included seats can never sell an add-on: /seats 400s first"),
        (-1, 50_000, False, "and its price column is moot for the same reason"),
        (-1, 12_345, False, "even a nonsense price on an unlimited plan sells nothing"),
    ],
)
def test_drift_is_defined_against_the_canonical_price_and_the_unlimited_exemption(
    monkeypatch, seats, price, drifted, why
) -> None:
    """Pin the definition against literals, not against the function's own body.

    Asserting ``_seat_price_drifted(row) == (row.extra_seat_price_cents !=
    CONST)`` re-implements the implementation as its own oracle: it holds for a
    flipped comparison, a wrong constant or a dropped unlimited-seats
    exemption, because both sides move together. These cases state the intended
    answer independently.

    The canonical price is monkeypatched to ``50_000``, deliberately NOT the
    shipped ``44_900``: reading the constant back into the expected values is
    what made the old test a tautology, and a literal that happened to equal
    the default would not prove the function reads the constant at all. Every
    expectation below is a literal against a canonical price the environment
    does not supply, so a wrong constant, a flipped comparison or a dropped
    unlimited-seats exemption each fail at least one case.
    ``superadmin_plan_routes`` holds the constant by value (imported at module
    load), so the patch belongs on that module, not on ``app.config``. The
    real shipped price is pinned end-to-end by
    ``test_plan_rows_report_seat_price_drift`` above.
    """
    monkeypatch.setattr(superadmin_plan_routes, "RAZORPAY_SEAT_PLAN_PRICE_CENTS", 50_000)
    row = Plan(
        name="X",
        slug="x",
        currency="INR",
        included_operator_seats=seats,
        extra_seat_price_cents=price,
    )
    assert superadmin_plan_routes._seat_price_drifted(row) is drifted, why
