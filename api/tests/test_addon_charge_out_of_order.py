"""An add-on ``subscription.charged`` for a mandate we have not linked yet.

Razorpay fires ``activated`` and ``charged`` near-simultaneously on a seat or
branding add-on's first cycle, and ``charged`` can win the race. The add-on
handlers used to ACK that event at INFO and drop it, which is final: Razorpay
never redelivers a 2xx, so the GST invoice for money it had already captured was
lost forever. ``_handle_subscription_charged`` has raised ``WebhookOutOfOrder``
for exactly this shape since the 2026-07-02 incident; these tests hold the two
add-on handlers to the same contract.

The other lifecycle events keep ACKing, because there is nothing to lose: a
``cancelled`` or ``halted`` for a mandate we never linked carries no money, and
raising on it would make Razorpay retry a genuinely foreign subscription id
until its retry budget ran out.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.services import razorpay_service as rzp

# Every event name the add-on dispatch table routes to these handlers, minus
# the charge itself.
NON_CHARGE_EVENTS = (
    "subscription.activated",
    "subscription.cancelled",
    "subscription.completed",
    "subscription.halted",
)


def _unlinked_session() -> MagicMock:
    """A session whose add-on lookup finds no local subscription."""
    session = MagicMock()
    session.scalars.return_value.first.return_value = None
    return session


def test_seat_charge_for_an_unlinked_mandate_raises_for_retry():
    session = _unlinked_session()

    with pytest.raises(rzp.WebhookOutOfOrder):
        rzp._handle_seat_addon_event(session, "subscription.charged", {"id": "sub_seat_unlinked"}, {})


def test_branding_charge_for_an_unlinked_mandate_raises_for_retry():
    session = _unlinked_session()

    with pytest.raises(rzp.WebhookOutOfOrder):
        rzp._handle_branding_addon_event(session, "subscription.charged", {"id": "sub_brand_unlinked"}, {})


def test_the_raise_names_the_mandate_so_the_dead_letter_is_actionable():
    session = _unlinked_session()

    with pytest.raises(rzp.WebhookOutOfOrder) as excinfo:
        rzp._handle_seat_addon_event(session, "subscription.charged", {"id": "sub_seat_named"}, {})

    assert "sub_seat_named" in str(excinfo.value)


@pytest.mark.parametrize("event_name", NON_CHARGE_EVENTS)
def test_non_charge_seat_events_for_an_unlinked_mandate_are_acked(event_name: str):
    session = _unlinked_session()

    result = rzp._handle_seat_addon_event(session, event_name, {"id": "sub_seat_unlinked"}, {})

    assert "no local sub" in result


@pytest.mark.parametrize("event_name", NON_CHARGE_EVENTS)
def test_non_charge_branding_events_for_an_unlinked_mandate_are_acked(event_name: str):
    session = _unlinked_session()

    result = rzp._handle_branding_addon_event(session, event_name, {"id": "sub_brand_unlinked"}, {})

    assert "no local sub" in result
