"""A paid feature switched off by an unpaid bill must show on the health page.

On 2026-09-08 the Reoon account ran out of credits mid-session. Email
verification failed open for every bot on every plan, exactly as designed, and
``/health/full`` reported ``healthy`` throughout: it checks the database, Redis
and the worker, and said nothing about the vendor whose absence had just turned
an anti-fraud gate into a no-op. The only trace was a WARNING line.

Degraded, not unhealthy. Chat, live chat and billing all work; one enrichment
feature is off. Paging oncall for a topup would train everyone to ignore the
page.

Calls the endpoint function directly rather than through the router: the
subject is the vendor line, and the auth plumbing is covered elsewhere.
"""

import pytest

from app.api.superadmin_routes_v2 import system_health_full
from app.services import reoon_service


@pytest.fixture(autouse=True)
def _clean_credit_state():
    reoon_service.reset_credit_state()
    yield
    reoon_service.reset_credit_state()


def _health() -> dict:
    return system_health_full(_admin=None)


def test_a_working_vendor_reports_connected(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")

    assert _health()["email_verification"] == "connected"


def test_an_exhausted_account_is_named_on_the_health_page(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    monkeypatch.setattr(reoon_service, "_credits_exhausted", True)

    assert _health()["email_verification"] == "no_credits"


def test_an_exhausted_account_degrades_the_platform(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    monkeypatch.setattr(reoon_service, "_credits_exhausted", True)

    assert _health()["status"] == "degraded", "one vendor's balance is not an outage"


def test_an_unconfigured_key_is_distinct_from_an_empty_balance(monkeypatch):
    """Different causes, different fixes: set a key, versus pay a bill."""
    monkeypatch.delenv("REOON_API_KEY", raising=False)

    assert _health()["email_verification"] == "not_configured"


def test_an_unconfigured_key_does_not_degrade(monkeypatch):
    """Not every deployment buys this vendor. Absent on purpose is not a fault."""
    monkeypatch.delenv("REOON_API_KEY", raising=False)
    body = _health()

    assert body["email_verification"] == "not_configured"
    # Whatever the database and Redis say, the vendor did not cause it.
    assert body["status"] != "degraded" or body.get("database") != "connected" or body.get("redis") != "connected"
