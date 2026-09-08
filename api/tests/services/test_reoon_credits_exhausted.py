"""An unpaid vendor bill and a network blip are not the same incident.

``verify_email`` funnelled every failure into one ``logger.warning`` and
returned ``None``. Callers must treat ``None`` as fail-open, so a read timeout
and "Not enough credits available. Please recharge." produced identical
behaviour and identical logs. Only one of those resolves itself.

Observed in production on 2026-09-08: the account ran dry mid-session. Three
addresses were correctly blocked, then Reoon answered 403 and every address
after it walked into live chat unverified. ``/health/full`` reported healthy
throughout, because it checks the database and Redis and nothing else. The
only trace was a WARNING line nobody reads.

Failing open stays: blocking real visitors over OUR billing would be worse.
What changes is that the platform now knows, and says so.
"""

import io
import json
import urllib.error
from unittest.mock import patch

import pytest

from app.services import reoon_service


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    reoon_service.reset_credit_state()
    yield
    reoon_service.reset_credit_state()


def _http_error(status: int, body: dict) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url=reoon_service.REOON_VERIFY_URL,
        code=status,
        msg="Forbidden",
        hdrs=None,
        fp=io.BytesIO(json.dumps(body).encode()),
    )


CREDITS_EXHAUSTED = {"reason": "Not enough credits available. Please recharge.", "status": "error"}


def test_still_fails_open_when_credits_run_out():
    """Unchanged, and deliberately so. Our billing is not the visitor's problem."""
    with patch(
        "app.services.reoon_service.urllib.request.urlopen",
        side_effect=_http_error(403, CREDITS_EXHAUSTED),
    ):
        assert reoon_service.verify_email("someone@example.com") is None


def test_records_that_credits_are_the_reason():
    with patch(
        "app.services.reoon_service.urllib.request.urlopen",
        side_effect=_http_error(403, CREDITS_EXHAUSTED),
    ):
        reoon_service.verify_email("someone@example.com")

    assert reoon_service.credits_exhausted() is True


def test_a_timeout_is_not_credit_exhaustion():
    """The distinction is the whole point: a blip fixes itself, a balance does not."""
    with patch(
        "app.services.reoon_service.urllib.request.urlopen",
        side_effect=TimeoutError("The read operation timed out"),
    ):
        reoon_service.verify_email("someone@example.com")

    assert reoon_service.credits_exhausted() is False


def test_a_403_that_is_not_about_credits_is_not_either():
    """A revoked or wrong key is a different incident with a different fix."""
    with patch(
        "app.services.reoon_service.urllib.request.urlopen",
        side_effect=_http_error(403, {"reason": "Invalid API key.", "status": "error"}),
    ):
        reoon_service.verify_email("someone@example.com")

    assert reoon_service.credits_exhausted() is False


def test_a_successful_verification_clears_the_flag():
    """Somebody recharged. The platform must notice without a restart."""
    with patch(
        "app.services.reoon_service.urllib.request.urlopen",
        side_effect=_http_error(403, CREDITS_EXHAUSTED),
    ):
        reoon_service.verify_email("someone@example.com")
    assert reoon_service.credits_exhausted() is True

    payload = {"status": "valid", "is_safe_to_send": True, "is_deliverable": True}
    with patch(
        "app.services.reoon_service.urllib.request.urlopen",
        return_value=_mock_response(payload),
    ):
        reoon_service.verify_email("someone@example.com")

    assert reoon_service.credits_exhausted() is False


def test_it_is_reported_once_not_once_per_visitor(caplog):
    """A dry account fails on EVERY address. One incident, not one per lead."""
    with (
        patch(
            "app.services.reoon_service.urllib.request.urlopen",
            side_effect=_http_error(403, CREDITS_EXHAUSTED),
        ),
        caplog.at_level("ERROR"),
    ):
        for i in range(5):
            reoon_service.verify_email(f"visitor{i}@example.com")

    exhausted = [r for r in caplog.records if reoon_service.CREDITS_METRIC in r.getMessage()]
    assert len(exhausted) == 1, f"expected one report, got {len(exhausted)}"


def test_the_address_is_not_logged_with_the_incident(caplog):
    """The report is about OUR account and carries no visitor's address."""
    with (
        patch(
            "app.services.reoon_service.urllib.request.urlopen",
            side_effect=_http_error(403, CREDITS_EXHAUSTED),
        ),
        caplog.at_level("ERROR"),
    ):
        reoon_service.verify_email("private.person@example.com")

    incident = " ".join(r.getMessage() for r in caplog.records if reoon_service.CREDITS_METRIC in r.getMessage())
    assert incident, "the incident was never reported"
    assert "private.person@example.com" not in incident


def _mock_response(payload: dict):
    from unittest.mock import MagicMock

    response = MagicMock()
    response.read.return_value = json.dumps(payload).encode()
    response.__enter__ = lambda s: s
    response.__exit__ = lambda *a: False
    return response
