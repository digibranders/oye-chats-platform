"""Finding E: a positive ``refund`` row must be counted by ``get_balance`` AND be
spendable by the FIFO allocator.

Before the fix, a refund with no live grant inflated the balance
(``get_balance`` sums all deltas) but raised ``InsufficientCredits`` on the next
deduction because ``_grants_for`` excluded ``reason="refund"`` from the
allocatable set — leaving the customer with a positive-but-unspendable balance.
"""

import os

import pytest

from app.db.models import Client
from app.services import credit_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _client(db) -> Client:
    c = Client(name="RefundE", email="refund-e@test.local", hashed_password="x", api_key="k-refund-e")
    db.add(c)
    db.flush()
    return c


def test_refund_credits_are_spendable(db):
    client = _client(db)
    # A refund with NO originating live grant (e.g. crawl-failure refund).
    credit_service.refund(db, client.id, amount=50, reference_id=999, note="crawl refund")
    db.commit()

    assert credit_service.get_balance(db, client.id) == 50

    # This must NOT raise InsufficientCredits — the refunded 50 is real balance.
    new_balance = credit_service.check_and_deduct(db, client.id, 10, reason="url_scan")
    db.commit()

    assert new_balance == 40
    assert credit_service.get_balance(db, client.id) == 40


def test_balance_equals_allocatable_after_refund(db):
    """Invariant: get_balance must equal what the allocator can consume."""
    client = _client(db)
    credit_service.refund(db, client.id, amount=30, reference_id=1, note="r")
    db.commit()
    # Draining the whole balance must succeed exactly.
    credit_service.check_and_deduct(db, client.id, 30, reason="ai_chat")
    db.commit()
    assert credit_service.get_balance(db, client.id) == 0


def test_refund_shows_in_breakdown_topup_bucket(db):
    client = _client(db)
    credit_service.refund(db, client.id, amount=25, reference_id=7, note="r")
    db.commit()
    bd = credit_service.get_balance_breakdown(db, client.id)
    assert bd["total"] == 25
    assert bd["topup"] == 25
    assert bd["plan"] == 0
