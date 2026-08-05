"""Downgrade hard-block on knowledge-base overflow.

A paid→paid downgrade to a tier with a smaller ``limits.documents`` allowance is
refused (409 ``document_overflow``) until the customer deletes enough uploaded
documents to fit — the same hard-block contract the operator-seat overflow
already uses. Documents are otherwise grandfathered at upload time, so this
guard is what turns a downgrade into an explicit "get under the limit first"
decision instead of a silent over-quota state.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, Document, Plan, Subscription
from app.services import transition_service

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="document-overflow downgrade tests need a reachable Postgres at DB_URL",
)


# ── Builders ────────────────────────────────────────────────────────────────


def _make_client(db, *, email: str) -> Client:
    client = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, *, slug: str, price_cents: int, documents: int) -> Plan:
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=price_cents,
        annual_price_cents=price_cents * 10,
        monthly_price_usd_cents=price_cents,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
        limits={"documents": documents},
        razorpay_plan_id_monthly=f"plan_{slug}_inr_monthly",
        razorpay_plan_id_annual=f"plan_{slug}_inr_annual",
    )
    db.add(plan)
    db.flush()
    return plan


def _make_upload_doc(db, client, *, name: str) -> Document:
    """Minimal uploaded-source Document row (only the counted columns matter)."""
    doc = Document(
        client_id=client.id,
        document_name=name,
        source="upload",
        file_hash=f"hash-{name}",
        content="x",
        embedding=[0.0] * 768,
    )
    db.add(doc)
    db.flush()
    return doc


# ── check_document_overflow (pure helper) ─────────────────────────────────────


def test_check_document_overflow_flags_excess(db):
    client = _make_client(db, email="doc-over@e.com")
    std = _make_plan(db, slug="doc-std", price_cents=94900, documents=2)
    for i in range(3):
        _make_upload_doc(db, client, name=f"doc-{i}.pdf")
    db.commit()

    overflow = transition_service.check_document_overflow(db, client.id, std)
    assert overflow is not None
    assert overflow.current_documents == 3
    assert overflow.allowed_documents == 2
    assert overflow.excess == 1


def test_check_document_overflow_none_when_within_limit(db):
    client = _make_client(db, email="doc-within@e.com")
    std = _make_plan(db, slug="doc-std2", price_cents=94900, documents=5)
    for i in range(2):
        _make_upload_doc(db, client, name=f"ok-{i}.pdf")
    db.commit()

    assert transition_service.check_document_overflow(db, client.id, std) is None


def test_check_document_overflow_none_when_unlimited(db):
    client = _make_client(db, email="doc-unl@e.com")
    unl = _make_plan(db, slug="doc-unl", price_cents=94900, documents=-1)
    for i in range(10):
        _make_upload_doc(db, client, name=f"unl-{i}.pdf")
    db.commit()

    assert transition_service.check_document_overflow(db, client.id, unl) is None


def test_check_document_overflow_counts_distinct_names_and_ignores_crawls(db):
    """Matches entitlements usage: distinct upload ``document_name``; crawled
    pages (``source != 'upload'``) never count toward the stored-doc cap."""
    client = _make_client(db, email="doc-distinct@e.com")
    std = _make_plan(db, slug="doc-std3", price_cents=94900, documents=1)
    # Two chunks of the SAME uploaded file → one distinct document.
    _make_upload_doc(db, client, name="single.pdf")
    _make_upload_doc(db, client, name="single.pdf")
    # A crawled page is not an upload → excluded from the cap.
    crawl = Document(
        client_id=client.id,
        document_name="https://example.com/page",
        source="crawl",
        file_hash="hash-crawl",
        content="x",
        embedding=[0.0] * 768,
    )
    db.add(crawl)
    db.commit()

    # 1 distinct upload == limit of 1 → no overflow.
    assert transition_service.check_document_overflow(db, client.id, std) is None


# ── change-plan route returns 409 document_overflow ───────────────────────────


@contextmanager
def _session_cm(session):
    yield session


def _post_change_plan(db, client, plan_id):
    from app.api import auth, subscription_routes

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    app.dependency_overrides[auth.require_verified_email] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)
    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        return api.post("/subscriptions/change-plan", json={"plan_id": plan_id})


def test_change_plan_blocks_downgrade_over_document_limit(db):
    client = _make_client(db, email="doc-block@e.com")
    pro = _make_plan(db, slug="dob-pro", price_cents=139900, documents=150)
    std = _make_plan(db, slug="dob-std", price_cents=94900, documents=2)
    sub = Subscription(
        client_id=client.id,
        plan_id=pro.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        razorpay_subscription_id="sub_doc_block",
        billing_cycle="monthly",
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
    )
    sub.plan = pro
    db.add(sub)
    for i in range(3):
        _make_upload_doc(db, client, name=f"blk-{i}.pdf")
    db.commit()

    resp = _post_change_plan(db, client, std.id)
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "document_overflow"
    assert detail["current_documents"] == 3
    assert detail["allowed_documents"] == 2
    assert detail["excess"] == 1
