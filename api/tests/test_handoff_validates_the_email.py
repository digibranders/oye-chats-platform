"""The widget's email gate was client-side only.

`HandoffForm` blocks an undeliverable address before it will submit, and
`/chat/validate-email` backs that with a real Reoon verdict. But the request
that actually puts a visitor in front of an operator, `POST /operators/handoff`,
never consulted that verdict, and `X-Bot-Key` is embedded in every customer's
page. Anyone posting directly walked in with any address on the first try.

Scope, stated plainly: this closes the replay of the widget's OWN request with
a junk address. It does not stop a caller who simply omits the email, because
`email` stays optional -- widget builds already cached on customers' pages do
not send it, and rejecting those would break live chat for real visitors.
Requiring it is a separate change that needs a per-bot "contact required"
setting, which does not exist yet.

Failing open is preserved throughout. A vendor outage, an exhausted balance or
a lower plan must never stand between a real visitor and a human.
"""

import inspect
from unittest.mock import patch

from app.api import operator_routes


class TestTheEndpointAsksAtAll:
    """Source-level: an end-to-end run needs an operator, a bot, presence, the
    availability state machine and a websocket, and the defect is a missing
    call that no assertion about the response can distinguish from a bot whose
    plan excludes verification."""

    def test_handoff_consults_the_email_verdict(self):
        src = inspect.getsource(operator_routes.request_handoff)

        assert "_handoff_email_is_blocked" in src, (
            "the handoff path must consult the same verdict the widget's own form does, or the gate is client-side only"
        )

    def test_it_gates_before_queueing(self):
        """After ``mark_session_waiting`` the operator has already been woken."""
        src = inspect.getsource(operator_routes.request_handoff)

        assert src.index("_handoff_email_is_blocked") < src.index("mark_session_waiting"), (
            "the check must run before the visitor is queued, not after"
        )


class TestTheGate:
    def _gate(self, verdict):
        with patch.object(operator_routes, "email_verdict_for", return_value=verdict):
            return operator_routes._handoff_email_is_blocked(bot=object(), request=object(), email="x@y.com")

    def test_blocks_an_address_the_vendor_calls_undeliverable(self):
        assert self._gate(True) is True

    def test_passes_an_address_the_vendor_accepts(self):
        assert self._gate(False) is False

    def test_passes_when_the_vendor_could_not_answer(self):
        """``None`` is "not checked": lower plan, opt-out, spent budget, outage,
        or an exhausted balance. Every one of those must fail OPEN."""
        assert self._gate(None) is False

    def test_passes_when_no_email_was_sent(self):
        """Widget builds cached on customer pages do not send one."""
        assert operator_routes._handoff_email_is_blocked(bot=object(), request=object(), email=None) is False
        assert operator_routes._handoff_email_is_blocked(bot=object(), request=object(), email="   ") is False

    def test_a_vendor_that_raises_does_not_block_the_visitor(self):
        """The gate is best-effort. An exception here must not cost a live chat."""
        with patch.object(operator_routes, "email_verdict_for", side_effect=RuntimeError("reoon down")):
            assert operator_routes._handoff_email_is_blocked(bot=object(), request=object(), email="x@y.com") is False


def test_the_request_model_accepts_an_optional_email():
    body = operator_routes.HandoffRequest(session_id="s-1")
    assert body.email is None

    body = operator_routes.HandoffRequest(session_id="s-1", email="visitor@example.com")
    assert body.email == "visitor@example.com"
