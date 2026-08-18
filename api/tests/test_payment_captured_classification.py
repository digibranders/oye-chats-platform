"""Every subscription payment used to 500 the Razorpay webhook endpoint.

    Razorpay webhook processing error for payment.captured:
      could not fetch order order_TPaHCGidZhBZxx for top-up notes
    Razorpay webhook processing error for order.paid:
      could not fetch order order_TPaGONr87vQzhK for top-up notes
    POST /webhooks/razorpay 500

``_handle_payment_captured`` treated every ``payment.captured`` / ``order.paid``
as a possible top-up and fetched the order to read its notes. For a SUBSCRIPTION
payment that fetch fails, and the handler raised ``RazorpayTransientError`` to
force a retry, a retry that can never succeed. Razorpay retries failed webhooks
aggressively and disables endpoints that keep failing, so this is an outage
risk for every customer's billing events, not a log-noise problem.

The classification already existed (the handler logs "ignored (not a topup)" on
the path where the fetch succeeds), it just ran too late. It now runs first,
from the webhook body alone.

What must NOT change: a genuinely UNKNOWN payment whose order fetch fails
transiently still raises, so the event dead-letters and Razorpay redelivers
(finding C. Swallowing it permanently lost a paid top-up). And
``WebhookOutOfOrder`` must still produce a non-2xx, or ``subscription.charged``
events that arrive before their subscription is linked would be lost forever.
"""

import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import webhook_billing_routes
from app.services import razorpay_service as rzp


def _subscription_payment_captured():
    """The real shape: Razorpay raises an Invoice for every subscription charge."""
    return {
        "payment": {
            "entity": {
                "id": "pay_TPaHCG",
                "order_id": "order_TPaHCGidZhBZxx",
                "invoice_id": "inv_TPaHCGx",
                "amount": 599900,
                "currency": "INR",
                "notes": {},
            }
        }
    }


def _order_paid_for_a_subscription():
    return {
        "payment": {"entity": {"id": "pay_TPaGON", "order_id": "order_TPaGONr87vQzhK", "amount": 599900}},
        "order": {"entity": {"id": "order_TPaGONr87vQzhK", "amount": 599900, "notes": {}}},
    }


# ── A subscription payment is classified without touching the gateway ───────


def test_subscription_payment_is_ignored_without_fetching_the_order():
    rzp_client = MagicMock()
    with patch.object(rzp, "_get_razorpay", return_value=rzp_client) as get_rzp:
        result = rzp._handle_payment_captured(MagicMock(), _subscription_payment_captured())
    assert "ignored" in result.lower()
    assert "subscription" in result.lower()
    # The whole point: no gateway round-trip, so nothing can fail.
    assert not get_rzp.called
    assert not rzp_client.order.fetch.called


def test_order_paid_for_a_subscription_trusts_the_order_entity_in_the_payload():
    """The order is IN the payload: empty notes mean "not a top-up", not "unknown"."""
    rzp_client = MagicMock()
    with patch.object(rzp, "_get_razorpay", return_value=rzp_client) as get_rzp:
        result = rzp._handle_payment_captured(MagicMock(), _order_paid_for_a_subscription())
    assert "ignored" in result.lower()
    assert not get_rzp.called


def test_a_subscription_payment_grants_nothing():
    """Belt and braces: the ignore path must not touch the ledger."""
    session = MagicMock()
    with (
        patch.object(rzp, "_get_razorpay") as get_rzp,
        patch.object(rzp.credit_service, "grant_topup") as grant,
    ):
        rzp._handle_payment_captured(session, _subscription_payment_captured())
    assert not grant.called
    assert not session.add.called
    assert not get_rzp.called


def test_subscription_payment_webhook_returns_2xx(monkeypatch):
    """End to end through the route: an ignored event must ACK, never 500."""
    monkeypatch.setattr(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", "shh")
    app = FastAPI()
    app.include_router(webhook_billing_routes.router)
    body = {"event": "payment.captured", "payload": _subscription_payment_captured()}

    with (
        patch.object(rzp, "verify_webhook_signature"),
        patch.object(rzp, "_record_or_skip_event", return_value=True),
        patch.object(rzp, "_get_razorpay") as get_rzp,
        patch("app.db.session.SessionLocal", MagicMock()),
    ):
        res = TestClient(app, raise_server_exceptions=False).post(
            "/webhooks/razorpay",
            content=json.dumps(body),
            headers={"x-razorpay-signature": "sig", "x-razorpay-event-id": "evt_sub_pay"},
        )

    assert res.status_code == 200, res.text
    assert not get_rzp.called


# ── Genuine unknowns still force a redelivery ───────────────────────────────


def test_unknown_payment_with_a_transient_fetch_failure_still_raises():
    """Finding C, preserved: we do not know whether this was a top-up, and a
    timeout says nothing about the order, so retry rather than ack."""
    payload = {"payment": {"entity": {"id": "pay_1", "order_id": "order_xyz", "amount": 49900, "notes": {}}}}
    rzp_client = MagicMock()
    rzp_client.order.fetch.side_effect = TimeoutError("razorpay 5xx")
    with (
        patch.object(rzp, "_get_razorpay", return_value=rzp_client),
        pytest.raises(rzp.RazorpayTransientError),
    ):
        rzp._handle_payment_captured(MagicMock(), payload)


def test_a_permanent_fetch_failure_acks_and_dead_letters():
    """A 4xx will still be a 4xx on the tenth redelivery. ACK, but never
    silently: the row lands in the dead-letter list ops already triages."""
    from razorpay.errors import BadRequestError

    payload = {"payment": {"entity": {"id": "pay_gone", "order_id": "order_gone", "amount": 49900, "notes": {}}}}
    rzp_client = MagicMock()
    rzp_client.order.fetch.side_effect = BadRequestError("The id provided does not exist")
    with (
        patch.object(rzp, "_get_razorpay", return_value=rzp_client),
        patch.object(rzp, "_dead_letter_synthetic") as dead_letter,
    ):
        result = rzp._handle_payment_captured(MagicMock(), payload)

    assert "ignored" in result.lower()
    assert dead_letter.called
    kwargs = dead_letter.call_args.kwargs
    assert kwargs["dedup_key"] == "unclassifiable-payment:pay_gone"
    assert "MANUAL REVIEW REQUIRED" in kwargs["error"]


def test_permanent_failure_classification_fails_closed():
    """Anything that is not a Razorpay 4xx is treated as transient (→ retry)."""
    from razorpay.errors import BadRequestError, ServerError

    assert rzp._is_permanent_gateway_failure(BadRequestError("bad id")) is True
    assert rzp._is_permanent_gateway_failure(ServerError("boom")) is False
    assert rzp._is_permanent_gateway_failure(TimeoutError("slow")) is False


def test_a_real_topup_is_still_granted_from_a_fetched_order():
    """The H5 path is untouched: a bare Order with no invoice_id still fetches."""
    payload = {"payment": {"entity": {"id": "pay_topup", "order_id": "order_topup", "amount": 49900, "notes": {}}}}
    rzp_client = MagicMock()
    rzp_client.order.fetch.return_value = {"notes": {"purpose": "topup", "client_id": "5", "credits": "1000"}}
    session = MagicMock()
    session.execute.return_value.scalars.return_value.first.return_value = None
    with (
        patch.object(rzp, "_get_razorpay", return_value=rzp_client),
        patch.object(rzp.invoice_service, "finalize_invoice_safely"),
        patch.object(rzp.credit_service, "grant_topup") as grant,
    ):
        result = rzp._handle_payment_captured(session, payload)
    assert grant.called
    assert "granted" in result.lower()


# ── Regression guard: WebhookOutOfOrder must keep redelivering ──────────────


def test_webhook_out_of_order_still_returns_non_2xx(monkeypatch):
    """``subscription.charged`` arriving before its subscription is linked is a
    LEGITIMATE retry signal. Fixing the 500 storm must not ack it, a 2xx here
    permanently loses the period's invoice (prod, client 11, 2026-07-02)."""
    monkeypatch.setattr(webhook_billing_routes, "RAZORPAY_WEBHOOK_SECRET", "shh")
    monkeypatch.setattr(webhook_billing_routes, "WEBHOOK_RETRY_ON_ERROR", True)
    app = FastAPI()
    app.include_router(webhook_billing_routes.router)
    body = {"event": "subscription.charged", "payload": {"subscription": {"entity": {"id": "sub_early"}}}}

    with (
        patch.object(rzp, "verify_webhook_signature"),
        patch.object(rzp, "handle_webhook_event", side_effect=rzp.WebhookOutOfOrder("not linked yet")),
        patch.object(webhook_billing_routes, "_dead_letter"),
        patch("app.db.session.SessionLocal", MagicMock()),
    ):
        res = TestClient(app, raise_server_exceptions=False).post(
            "/webhooks/razorpay",
            content=json.dumps(body),
            headers={"x-razorpay-signature": "sig", "x-razorpay-event-id": "evt_early"},
        )

    assert res.status_code >= 500, res.text
