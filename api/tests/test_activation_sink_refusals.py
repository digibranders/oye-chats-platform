"""The activation sink refuses shapes it cannot persist - instead of 500ing.

P2 from the pooled-plan seam audit: ``_handle_subscription_activated`` guarded
the pooled-plan-on-bot-scope shape only when the plan row RESOLVED. A notes
``oyechats_plan_id`` pointing at no Plan row fell straight through to the
INSERT, which died on the foreign key - a 5xx that burns Razorpay's retry
window on a deterministic failure, with no dead-letter row and no released
idempotency key. The customer HAS been charged, so the charge must land in
``failed_webhooks`` exactly like the pooled-scope refusal does.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import select

from app.db.models import Bot, Client, Subscription
from app.services import razorpay_service as rzp

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="activation sink refusal tests need a reachable Postgres at DB_URL",
)


def _payload(*, client_id: int, plan_id: int, extra_notes: dict | None = None) -> dict:
    notes = {
        "oyechats_client_id": str(client_id),
        "oyechats_plan_id": str(plan_id),
        "billing_cycle": "monthly",
        **(extra_notes or {}),
    }
    return {
        "subscription": {
            "entity": {
                "id": "sub_unknown_plan",
                "notes": notes,
                "current_start": int(datetime(2026, 2, 1, tzinfo=UTC).timestamp()),
                "current_end": int(datetime(2026, 2, 28, tzinfo=UTC).timestamp()),
                "quantity": 1,
                "customer_id": "cust_test",
            }
        }
    }


@pytest.mark.parametrize(
    "extra_notes",
    [
        pytest.param(None, id="account-scope"),
        pytest.param({"purpose": "per_bot_subscription"}, id="new-bot-scope"),
    ],
)
def test_unknown_plan_id_is_dead_lettered_not_a_crash(db, extra_notes):
    client = Client(
        name="c", email=f"unknown-plan-{bool(extra_notes)}@e.com", api_key=f"k{bool(extra_notes)}", hashed_password="h"
    )
    db.add(client)
    db.flush()
    db.commit()

    missing_plan_id = 999_999_999
    payload = _payload(client_id=client.id, plan_id=missing_plan_id, extra_notes=extra_notes)

    captured: list[dict] = []
    with (
        patch.object(rzp, "_get_razorpay", return_value=MagicMock()),
        patch.object(rzp, "_dead_letter_synthetic", side_effect=lambda **kw: captured.append(kw)),
    ):
        result = rzp._handle_subscription_activated(db, payload)
    db.commit()

    # Refused with an ACK, not an exception - and nothing was persisted.
    assert "NOT created" in result
    rows = db.execute(select(Subscription).where(Subscription.client_id == client.id)).scalars().all()
    assert rows == []
    bots = db.execute(select(Bot).where(Bot.client_id == client.id)).scalars().all()
    assert bots == [], "no bot may be minted for a refused activation"

    # The charge is recorded for ops, carrying the ids needed to act.
    assert len(captured) == 1
    assert "sub_unknown_plan" in captured[0]["dedup_key"]
    assert captured[0]["context"]["plan_id"] == missing_plan_id
