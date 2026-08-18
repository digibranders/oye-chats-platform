"""Review batch A. Findings K (MRR seat double-count) and N (first-period marker
not advanced when `activated` lacks current_end). Finding I (deferred gateway
cancels) is covered by the existing cutover suites (test_billing_bl2_bl4,
test_seat_addon_cutover).
"""

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from app.core.dates import add_months
from app.db.models import Client, Plan, Subscription
from app.services import razorpay_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _plan(db, **kw):
    defaults = dict(
        name="Standard",
        slug="std-a",
        monthly_price_cents=459900,
        annual_price_cents=4599000,
        currency="INR",
        included_operator_seats=1,
        extra_seat_price_cents=49900,
        is_active=True,
    )
    defaults.update(kw)
    p = Plan(**defaults)
    db.add(p)
    db.flush()
    return p


# ── K: MRR must not multiply the whole plan by the seat count ─────────────────


def test_mrr_counts_seats_as_flat_addon(db, monkeypatch):
    from app.api import superadmin_plan_routes as spr
    from app.config import RAZORPAY_SEAT_PLAN_PRICE_CENTS

    client = Client(name="M", email="mrr@test.local", hashed_password="x", api_key="k-mrr")
    db.add(client)
    db.flush()
    # Plan column intentionally set to a DIVERGENT seat price: MRR must reflect
    # the amount the seat add-on actually charges (RAZORPAY_SEAT_PLAN_PRICE_CENTS),
    # not whatever the plan row advertises (finding H3).
    plan = _plan(db, extra_seat_price_cents=99999)
    # 3 total seats = 1 included + 2 extra.
    db.add(
        Subscription(
            client_id=client.id,
            plan_id=plan.id,
            status="active",
            billing_cycle="monthly",
            operator_quantity=3,
            razorpay_subscription_id="sub_mrr",
        )
    )
    db.flush()
    db.commit()

    monkeypatch.setattr(spr, "get_session", lambda: _cm(db))
    sa = Client(name="SA", email="sa-mrr@test.local", hashed_password="x", api_key="k-sa-mrr", is_superadmin=True)
    result = spr.get_revenue_metrics(superadmin=sa)

    expected = spr._plan_monthly_usd_cents(plan, "monthly") + spr._to_usd_cents(
        2 * RAZORPAY_SEAT_PLAN_PRICE_CENTS, "INR"
    )
    assert result["mrr_cents"] == expected
    # And crucially NOT the old triple-count.
    assert result["mrr_cents"] != spr._plan_monthly_usd_cents(plan, "monthly") * 3


@contextmanager
def _cm(session):
    yield session


# ── N: first-period marker advances even without current_end ─────────────────


def test_activation_without_current_end_advances_marker(db):
    client = Client(name="N", email="n@test.local", hashed_password="x", api_key="k-n")
    db.add(client)
    db.flush()
    plan = _plan(db, slug="std-n")
    db.commit()

    # `activated` with current_start but NO current_end (UPI mandate authed,
    # not yet charged).
    payload = {
        "subscription": {
            "entity": {
                "id": "sub_n",
                "notes": {
                    "oyechats_client_id": str(client.id),
                    "oyechats_plan_id": str(plan.id),
                    "billing_cycle": "monthly",
                },
                "current_start": int(datetime(2026, 1, 1, tzinfo=UTC).timestamp()),
                # no current_end
                "quantity": 1,
            }
        }
    }
    with patch.object(razorpay_service, "_get_razorpay", return_value=MagicMock()):
        razorpay_service._handle_subscription_activated(db, payload)
    db.commit()

    sub = db.scalars(select(Subscription).where(Subscription.razorpay_subscription_id == "sub_n")).first()
    assert sub is not None
    # Marker advanced to the DERIVED first-period end (current_start + 1 month),
    # so the first `charged` for that period will correctly no-op instead of
    # granting a second time.
    assert sub.last_granted_period_end == add_months(datetime(2026, 1, 1, tzinfo=UTC), 1)
