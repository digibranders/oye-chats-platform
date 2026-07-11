"""Review batch D — finding O3 (get_balance must not count expired-but-unswept
top-ups) and O1 (expire_old_topups locks before reading consumption)."""

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Client, CreditLedger
from app.services import credit_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db) -> Client:
    c = Client(name="D", email="batchd@test.local", hashed_password="x", api_key="k-batchd")
    db.add(c)
    db.flush()
    return c


def test_get_balance_excludes_expired_unswept_topup(db):
    client = _client(db)
    # A top-up already past expiry but not yet swept by the daily cron.
    db.add(
        CreditLedger(
            client_id=client.id,
            delta=100,
            reason="topup",
            expires_at=datetime.now(UTC) - timedelta(days=1),
        )
    )
    db.flush()

    # Spendable balance must be 0 — it matches what the FIFO allocator can spend,
    # not the raw delta sum (which still includes the expired grant until swept).
    assert credit_service.get_balance(db, client.id) == 0
    with pytest.raises(credit_service.InsufficientCredits):
        credit_service.check_and_deduct(db, client.id, 10, reason="ai_chat")


def test_get_balance_counts_live_topup(db):
    client = _client(db)
    db.add(
        CreditLedger(
            client_id=client.id,
            delta=100,
            reason="topup",
            expires_at=datetime.now(UTC) + timedelta(days=30),
        )
    )
    db.flush()
    assert credit_service.get_balance(db, client.id) == 100


def test_expire_old_topups_does_not_oversweep(db):
    """O1 sanity: an expired top-up partly consumed is swept for only the unused
    remainder (locking before the consumption read prevents over-sweep)."""
    client = _client(db)
    grant = CreditLedger(
        client_id=client.id, delta=100, reason="topup", expires_at=datetime.now(UTC) - timedelta(days=1)
    )
    db.add(grant)
    db.flush()
    # 40 already consumed against this grant.
    db.add(CreditLedger(client_id=client.id, delta=-40, reason="ai_chat", grant_id=grant.id))
    db.flush()

    expired = credit_service.expire_old_topups(db)
    db.flush()
    assert expired == 60  # only the unused remainder


# ── §5: get_credit_cost fails closed ──────────────────────────────────────────


def test_get_credit_cost_unknown_action_fails_closed(db, monkeypatch):
    # Unknown action → charge the fail-closed default (1), never free (0).
    monkeypatch.setattr(credit_service, "get_pricing", lambda s: {})
    assert credit_service.get_credit_cost(db, "brand_new_action") == credit_service._DEFAULT_CREDIT_COST


def test_get_credit_cost_non_numeric_fails_closed(db, monkeypatch):
    monkeypatch.setattr(credit_service, "get_pricing", lambda s: {"credit_cost.ai_chat": "oops"})
    assert credit_service.get_credit_cost(db, "ai_chat") == credit_service._DEFAULT_CREDIT_COST


def test_get_credit_cost_reads_configured_value(db, monkeypatch):
    monkeypatch.setattr(credit_service, "get_pricing", lambda s: {"credit_cost.ai_chat": 3})
    assert credit_service.get_credit_cost(db, "ai_chat") == 3
