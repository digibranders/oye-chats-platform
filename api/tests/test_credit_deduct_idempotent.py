"""Finding H: ``check_and_deduct`` supports OPT-IN idempotency via a globally
unique ``idempotency_key``, so an ARQ retry / SSE reconnect / duplicated
ingestion event carrying the same key can't double-charge.

Existing callers that pass no key (or only a coarse ``reference_id`` label) keep
the exact prior behaviour — they charge once per call.
"""

import os

import pytest
from sqlalchemy import func, select

from app.db.models import Client, CreditLedger
from app.services import credit_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _seed(db) -> Client:
    c = Client(name="DedupH", email="dedup-h@test.local", hashed_password="x", api_key="k-dedup-h")
    db.add(c)
    db.flush()
    db.add(CreditLedger(client_id=c.id, delta=100, reason="plan_grant"))
    db.flush()
    return c


def test_repeat_deduction_same_key_is_noop(db):
    client = _seed(db)
    b1 = credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", idempotency_key="chat:abc")
    db.commit()
    # Same key again — a retry. Must NOT deduct twice.
    b2 = credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", idempotency_key="chat:abc")
    db.commit()

    assert b1 == 95
    assert b2 == 95  # unchanged
    n_neg = db.scalar(
        select(func.count())
        .select_from(CreditLedger)
        .where(CreditLedger.client_id == client.id, CreditLedger.delta < 0)
    )
    assert n_neg == 1  # only one deduction row written


def test_distinct_keys_still_deduct(db):
    client = _seed(db)
    credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", idempotency_key="chat:1")
    credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", idempotency_key="chat:2")
    db.commit()
    assert credit_service.get_balance(db, client.id) == 90


def test_no_key_is_not_deduped(db):
    """Legacy callers (no idempotency_key) keep charging per call — even when the
    coarse reference_id label repeats. This is what protects chat/ingestion from
    silently going free."""
    client = _seed(db)
    credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", reference_id=client.id)
    credit_service.check_and_deduct(db, client.id, 5, reason="ai_chat", reference_id=client.id)
    db.commit()
    assert credit_service.get_balance(db, client.id) == 90


def test_key_stamped_only_on_first_chunk_across_two_grants(db):
    """A deduction that spans two grants must stamp the key on exactly one row so
    the partial unique index (one row per key) is not violated."""
    client = Client(name="Split", email="split-h@test.local", hashed_password="x", api_key="k-split-h")
    db.add(client)
    db.flush()
    db.add(CreditLedger(client_id=client.id, delta=10, reason="plan_grant"))
    db.add(CreditLedger(client_id=client.id, delta=10, reason="topup"))
    db.flush()
    credit_service.check_and_deduct(db, client.id, 15, reason="ai_chat", idempotency_key="chat:split")
    db.commit()

    keyed = db.scalar(
        select(func.count()).select_from(CreditLedger).where(CreditLedger.idempotency_key == "chat:split")
    )
    assert keyed == 1  # exactly one row carries the key
    assert credit_service.get_balance(db, client.id) == 5
