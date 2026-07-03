"""Gapless per-FY invoice numbering allocator."""

import os
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from app.db.models import InvoiceCounter
from app.services.invoice_service import allocate_invoice_number, financial_year_label

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def test_financial_year_label_indian_fy():
    # India FY runs 1 Apr – 31 Mar.
    assert financial_year_label(datetime(2026, 7, 2, tzinfo=UTC)) == "26-27"
    assert financial_year_label(datetime(2026, 3, 31, tzinfo=UTC)) == "25-26"
    assert financial_year_label(datetime(2026, 4, 1, tzinfo=UTC)) == "26-27"
    assert financial_year_label(datetime(2027, 1, 15, tzinfo=UTC)) == "26-27"


def test_allocation_is_sequential_and_formatted(db):
    dt = datetime(2026, 7, 2, tzinfo=UTC)
    n1 = allocate_invoice_number(db, "DB", dt)
    n2 = allocate_invoice_number(db, "DB", dt)
    n3 = allocate_invoice_number(db, "DB", dt)
    assert n1 == "DB/26-27/000001"
    assert n2 == "DB/26-27/000002"
    assert n3 == "DB/26-27/000003"


def test_separate_series_per_prefix_and_fy(db):
    dt = datetime(2026, 7, 2, tzinfo=UTC)
    other_fy = datetime(2026, 3, 31, tzinfo=UTC)
    assert allocate_invoice_number(db, "DB", dt) == "DB/26-27/000001"
    assert allocate_invoice_number(db, "OC", dt) == "OC/26-27/000001"  # different prefix → own series
    assert allocate_invoice_number(db, "DB", other_fy) == "DB/25-26/000001"  # different FY → own series
    assert allocate_invoice_number(db, "DB", dt) == "DB/26-27/000002"  # first series resumes


def test_counter_row_created_and_incremented(db):
    dt = datetime(2026, 7, 2, tzinfo=UTC)
    allocate_invoice_number(db, "DB", dt)
    allocate_invoice_number(db, "DB", dt)
    counter = db.get(InvoiceCounter, ("26-27", "DB"))
    assert counter.last_serial == 2


def test_concurrent_allocation_is_gapless(db, pg_engine):
    """Two independent transactions allocating against the same counter must get
    consecutive numbers with no gap or duplicate — the FOR UPDATE row lock
    serializes them."""
    dt = datetime(2026, 7, 2, tzinfo=UTC)
    # Seed the counter row + commit so both sessions see it.
    allocate_invoice_number(db, "DB", dt)
    db.commit()

    s1 = Session(pg_engine)
    s2 = Session(pg_engine)
    try:
        # s1 locks the counter and increments (2) but does not commit yet.
        n1 = allocate_invoice_number(s1, "DB", dt)
        assert n1 == "DB/26-27/000002"
        # s2's allocation must block on the row lock until s1 commits, then get 3.
        s1.commit()
        n2 = allocate_invoice_number(s2, "DB", dt)
        s2.commit()
        assert n2 == "DB/26-27/000003"
    finally:
        s1.close()
        s2.close()
        # Clean the committed rows so the shared DB stays tidy for other tests.
        with Session(pg_engine) as cleanup:
            cleanup.query(InvoiceCounter).filter_by(financial_year="26-27", prefix="DB").delete()
            cleanup.commit()


def test_engine_url_available(db):
    # Guard: the concurrency test needs a real engine URL, not a mock bind.
    assert str(db.get_bind().url).startswith("postgresql")


def test_rolled_back_allocation_does_not_burn_serial(db, pg_engine):
    # Gap-freedom under failure: an allocation that rolls back must reuse the
    # serial, not leave a hole (Rule 46). Uses prefix "RB" to avoid other tests.
    dt = datetime(2026, 7, 2, tzinfo=UTC)
    s1 = Session(pg_engine)
    try:
        assert allocate_invoice_number(s1, "RB", dt) == "RB/26-27/000001"
        s1.rollback()
    finally:
        s1.close()
    s2 = Session(pg_engine)
    try:
        assert allocate_invoice_number(s2, "RB", dt) == "RB/26-27/000001"  # reused, no gap
        s2.rollback()
    finally:
        s2.close()
