"""Every Razorpay HTTP call carries a timeout.

The SDK sets none: Client.request forwards **options straight to
session.get/post, and its constructor options only configure base_url and
retries. Without a timeout ``requests`` waits forever on a half-open socket.

That is not theoretical. The dunning cron makes one serial gateway call per
past-due subscription, so a single hung connection stalls the whole job until
ARQ kills it -- and for the expiry sweep a killed job means the batch never
commits.
"""

from unittest.mock import patch

from app.services.razorpay_service import RAZORPAY_HTTP_TIMEOUT, _TimeoutSession


def test_a_timeout_is_injected_when_the_caller_omits_one():
    session = _TimeoutSession()
    with patch("requests.Session.request", return_value="ok") as inner:
        session.get("https://api.razorpay.com/v1/customers/cust_1/tokens")

    assert inner.call_args.kwargs["timeout"] == RAZORPAY_HTTP_TIMEOUT


def test_an_explicit_caller_timeout_is_respected():
    """setdefault, not overwrite -- a caller that knows better keeps control."""
    session = _TimeoutSession()
    with patch("requests.Session.request", return_value="ok") as inner:
        session.post("https://api.razorpay.com/v1/subscriptions", timeout=1)

    assert inner.call_args.kwargs["timeout"] == 1


def test_the_timeout_is_a_connect_read_pair():
    """A single scalar applies the same budget to both phases. Connect should
    fail fast; read must not, because a spurious timeout part-way through a
    subscription create can leave a mandate live at the gateway."""
    connect, read = RAZORPAY_HTTP_TIMEOUT
    assert 0 < connect <= 10
    assert connect < read


def test_the_sdk_client_is_built_with_the_timeout_session(monkeypatch):
    """Guards the WIRING, not just the class: constructing the client without
    ``session=_TimeoutSession()`` would silently restore the old behaviour.

    Asserted behaviourally rather than by ``isinstance``. Another test in the
    suite reloads ``razorpay_service``, which mints a fresh class object and
    makes an identity check fail for a reason that has nothing to do with the
    wiring. What matters is that the client's session injects a timeout.
    """
    from app.services import razorpay_service as svc

    monkeypatch.setattr(svc, "RAZORPAY_ENABLED", True)
    monkeypatch.setattr(svc, "RAZORPAY_KEY_ID", "rzp_test_x")
    monkeypatch.setattr(svc, "RAZORPAY_KEY_SECRET", "secret")

    client = svc._get_razorpay()

    with patch("requests.Session.request", return_value="ok") as inner:
        client.session.get("https://api.razorpay.com/v1/customers")

    assert inner.call_args.kwargs.get("timeout") == svc.RAZORPAY_HTTP_TIMEOUT
