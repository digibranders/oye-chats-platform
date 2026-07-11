"""Finding C: when a payment.captured lacks order notes and order.fetch fails,
the handler must RAISE (so the webhook rail dead-letters + retries) rather than
ack it as "ignored" and burn the dedup row — which permanently loses a paid
top-up (customer charged, zero credits, never reprocessed).
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services import razorpay_service


def _payment_captured_without_notes(order_id="order_xyz"):
    return {
        "payment": {"entity": {"id": "pay_1", "order_id": order_id, "amount": 49900, "notes": {}}},
    }


def test_order_fetch_failure_raises_transient():
    payload = _payment_captured_without_notes()
    rzp = MagicMock()
    rzp.order.fetch.side_effect = TimeoutError("razorpay 5xx")
    with (
        patch.object(razorpay_service, "_get_razorpay", return_value=rzp),
        pytest.raises(razorpay_service.RazorpayTransientError),
    ):
        razorpay_service._handle_payment_captured(MagicMock(), payload)


def test_order_fetch_success_not_topup_is_ignored():
    """A genuine non-topup (order fetched, purpose absent) is still ack'd — not
    raised — so we don't retry forever on unrelated payments."""
    payload = _payment_captured_without_notes()
    rzp = MagicMock()
    rzp.order.fetch.return_value = {"notes": {"purpose": "something_else"}}
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        result = razorpay_service._handle_payment_captured(MagicMock(), payload)
    assert "ignored" in result.lower()


def test_transient_error_is_a_billing_error():
    """It must reach the webhook route's broad Exception arm (500 → retry), not be
    mistaken for a signature/validation error."""
    assert issubclass(razorpay_service.RazorpayTransientError, razorpay_service.RazorpayBillingError)
