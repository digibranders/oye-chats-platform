"""A dead letter must close itself when the retry it asked for succeeds.

Razorpay redelivers a webhook we 5xx'd, and the redelivery usually works: the
out-of-order case that motivated this (``subscription.charged`` arriving a
second before ``subscription.activated``) is resolved entirely by the gateway's
own retry a second later. Nothing closed the dead-letter row when that
happened, so ``failed_webhooks`` accumulated ``pending`` rows for events that
had long since processed.

That is worse than untidy. The table is the one place an operator looks to ask
"is billing healthy right now", and the first live payment on this platform
finished with a perfect ledger, a correct invoice, and a row saying one webhook
had failed. A signal that reads the same whether or not anything is wrong
cannot be alerted on, and the honest reading of it costs an investigation every
time.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from app.api import webhook_billing_routes as routes
from app.db.models import FailedWebhook

pytestmark = pytest.mark.usefixtures("db")

EVENT_ID = "evt_retry_me"


def _dead_letter(db, *, event_id: str = EVENT_ID, status: str = "pending") -> int:
    row = FailedWebhook(
        provider="razorpay",
        event_id=event_id,
        event_type="subscription.charged",
        raw_payload=json.dumps({"event": "subscription.charged"}).encode("utf-8"),
        signature="sig",
        headers={"x-razorpay-event-id": event_id},
        error="WebhookOutOfOrder('arrived before the subscription was linked')",
        status=status,
    )
    db.add(row)
    db.commit()  # the resolver runs in its OWN session and must see this
    return row.id


def _reread(db, row_id: int) -> FailedWebhook:
    db.expire_all()
    return db.execute(select(FailedWebhook).where(FailedWebhook.id == row_id)).scalar_one()


def test_a_successful_retry_closes_the_dead_letter(db):
    row_id = _dead_letter(db)

    routes._resolve_dead_letters(provider="razorpay", event_id=EVENT_ID)

    row = _reread(db, row_id)
    assert row.status == "replayed"
    assert row.replayed_at is not None


def test_only_the_event_that_succeeded_is_closed(db):
    mine = _dead_letter(db)
    other = _dead_letter(db, event_id="evt_still_broken")

    routes._resolve_dead_letters(provider="razorpay", event_id=EVENT_ID)

    assert _reread(db, mine).status == "replayed"
    assert _reread(db, other).status == "pending"


def test_a_row_an_operator_triaged_to_ignored_is_left_alone(db):
    """`ignored` is a decision, not a state to be overwritten.

    Marking it `replayed` would rewrite the operator's own record of what they
    concluded about the event.
    """
    row_id = _dead_letter(db, status="ignored")

    routes._resolve_dead_letters(provider="razorpay", event_id=EVENT_ID)

    row = _reread(db, row_id)
    assert row.status == "ignored"
    assert row.replayed_at is None


def test_an_already_replayed_row_keeps_its_original_timestamp(db):
    """A later redelivery of the same event must not restamp it."""
    row_id = _dead_letter(db)
    routes._resolve_dead_letters(provider="razorpay", event_id=EVENT_ID)
    first = _reread(db, row_id).replayed_at

    routes._resolve_dead_letters(provider="razorpay", event_id=EVENT_ID)

    assert _reread(db, row_id).replayed_at == first


def test_nothing_to_close_is_not_an_error(db):
    """The overwhelmingly common case: the event never dead-lettered at all."""
    routes._resolve_dead_letters(provider="razorpay", event_id="evt_never_failed")


def test_a_bookkeeping_failure_never_breaks_the_acknowledgement(db, monkeypatch):
    """This runs after the webhook has already been processed and committed.

    Letting it raise would turn a completed, money-moving event into a 500, and
    Razorpay would redeliver something that has already been applied. The
    tidy-up is strictly less important than the ACK.
    """
    row_id = _dead_letter(db)

    def _explode():
        raise RuntimeError("database went away")

    monkeypatch.setattr(routes, "get_session", _explode)
    routes._resolve_dead_letters(provider="razorpay", event_id=EVENT_ID)  # must not raise

    monkeypatch.undo()
    assert _reread(db, row_id).status == "pending"


def test_the_live_route_closes_the_dead_letter_its_own_retry_resolved(db, monkeypatch):
    """End to end, because a correct resolver nobody calls fixes nothing.

    Deliberately not a mocked session: a `MagicMock` accepts any write and
    reports success, so this assertion would pass against a route that never
    touched the database at all.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.services import invoice_service, razorpay_service

    row_id = _dead_letter(db)

    monkeypatch.setattr(routes, "RAZORPAY_WEBHOOK_SECRET", "whsec")
    monkeypatch.setattr(razorpay_service, "verify_webhook_signature", lambda **_: None)
    monkeypatch.setattr(razorpay_service, "handle_webhook_event", lambda *a, **k: "ok")
    monkeypatch.setattr(invoice_service, "request_pdf_render_soon", lambda *a, **k: None)

    app = FastAPI()
    app.include_router(routes.router)
    resp = TestClient(app).post(
        "/webhooks/razorpay",
        content=json.dumps({"event": "subscription.charged"}).encode("utf-8"),
        headers={"x-razorpay-signature": "sig", "x-razorpay-event-id": EVENT_ID},
    )

    assert resp.status_code == 200
    assert _reread(db, row_id).status == "replayed"
