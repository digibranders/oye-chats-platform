"""Dunning recovery resolves the EXISTING subscription's hosted link.

It must never mint a new Razorpay subscription: a halted subscription is still
alive and recoverable through Razorpay's own hosted page, so a second mandate
would double-charge a customer who authorises it while the original is still
rescuable. (``/resume`` mints one only because an at-cycle-end cancellation is
irreversible at the gateway. There is nothing left to authorise there.)
"""

import pytest


class _FakeSubAPI:
    def __init__(self, entity=None, boom=False):
        self.entity = entity
        self.boom = boom

    def fetch(self, sub_id):
        if self.boom:
            raise RuntimeError("gateway down")
        return self.entity

    def create(self, data):
        # Raise rather than record: an assertion on a recorded list only
        # protects the paths that bother to check it. Mutation testing showed a
        # `create()` call added to the non-recoverable branch passed the whole
        # suite. Raising here enforces the invariant on EVERY case, including
        # the terminal-state and missing-short_url paths where a future "just
        # re-mint it for them" fix is most tempting.
        raise AssertionError("dunning must never mint a new Razorpay subscription")


class _FakeClient:
    def __init__(self, entity=None, boom=False):
        self.subscription = _FakeSubAPI(entity, boom)


@pytest.mark.parametrize("state", ["halted", "pending"])
def test_recoverable_states_return_the_hosted_link(monkeypatch, state):
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": state, "short_url": "https://rzp.io/i/abc"})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    result = svc.get_recovery_link("sub_1")

    assert result.recoverable is True
    assert result.url == "https://rzp.io/i/abc"
    assert result.gateway_status == state
    # No new mandate. Enforced for every case by _FakeSubAPI.create raising.


@pytest.mark.parametrize("state", ["created", "authenticated"])
def test_pre_first_charge_states_are_not_recoverable(monkeypatch, state):
    """Deliberate divergence from razorpay_service._AUTHORIZABLE_SUB_STATES.

    Those states mean "this checkout can still be paid", nothing has failed
    yet. Treating them as recoverable would email "we couldn't collect payment"
    to someone who was never charged. Pinned so a future harmonisation of the
    two constants breaks a test instead of a customer.
    """
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": state, "short_url": "https://rzp.io/i/abc"})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    assert svc.get_recovery_link("sub_1").recoverable is False


@pytest.mark.parametrize("state", ["cancelled", "completed", "expired"])
def test_terminal_states_are_not_recoverable(monkeypatch, state):
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": state, "short_url": "https://rzp.io/i/abc"})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    result = svc.get_recovery_link("sub_1")

    assert result.recoverable is False
    assert result.url is None
    assert result.gateway_status == state


def test_active_subscription_is_not_recoverable(monkeypatch):
    """Nothing to recover, and Razorpay cannot swap the instrument on a
    healthy active subscription anyway (master plan D-1)."""
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": "active", "short_url": "https://rzp.io/i/abc"})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    assert svc.get_recovery_link("sub_1").recoverable is False


def test_missing_short_url_is_not_recoverable(monkeypatch):
    """A recoverable state with no hosted link is useless to the customer.
    Report it rather than emailing a button that goes nowhere."""
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": "halted", "short_url": None})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    result = svc.get_recovery_link("sub_1")
    assert result.recoverable is False
    assert result.url is None
    assert result.gateway_status == "halted"


def test_status_is_compared_case_insensitively(monkeypatch):
    """Razorpay has returned capitalised states in the past; the codebase
    lower-cases elsewhere (razorpay_service._AUTHORIZABLE_SUB_STATES check)."""
    from app.services import dunning_service as svc

    fake = _FakeClient({"id": "sub_1", "status": "HALTED", "short_url": "https://rzp.io/i/abc"})
    monkeypatch.setattr(svc, "_client", lambda: fake)

    assert svc.get_recovery_link("sub_1").recoverable is True


def test_gateway_failure_raises_rather_than_reporting_unrecoverable(monkeypatch):
    """A transient fetch failure must not be reported as 'unrecoverable'. That
    would tell a paying customer their subscription is dead."""
    from app.services import dunning_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient(boom=True))

    with pytest.raises(svc.DunningError):
        svc.get_recovery_link("sub_1")


def test_no_gateway_id_is_not_recoverable_without_calling_razorpay(monkeypatch):
    """Manually-granted subscriptions have no razorpay_subscription_id. The
    fake would raise if it were called, so this also proves we short-circuit."""
    from app.services import dunning_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient(boom=True))
    result = svc.get_recovery_link(None)
    assert result.recoverable is False
    assert result.gateway_status is None


def test_empty_entity_is_not_recoverable(monkeypatch):
    """Razorpay returning an empty body must not crash the caller."""
    from app.services import dunning_service as svc

    monkeypatch.setattr(svc, "_client", lambda: _FakeClient({}))

    result = svc.get_recovery_link("sub_1")
    assert result.recoverable is False
    assert result.gateway_status is None
