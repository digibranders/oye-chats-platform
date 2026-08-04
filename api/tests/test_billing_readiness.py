"""Billing readiness is reported in /health/full without gating fully_ok (F7).

An unset seller profile silently turns every charge into an un-numbered legacy
row with no tax document. It was invisible until a customer or a CA asked for
an invoice. It is a configuration gap, not an outage, so it is reported but
deliberately does NOT flip the endpoint to 503.
"""

import os

import pytest

from app.services.seller_profile_service import save_seller_profile

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def test_billing_block_reports_inactive_when_seller_profile_unset(db):
    from app.main import _billing_readiness

    assert _billing_readiness(db) == {
        "invoicing_active": False,
        "reason": "seller profile not configured",
    }


def test_billing_block_reports_active_once_configured(db):
    from app.main import _billing_readiness

    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"}, actor_id=None)
    assert _billing_readiness(db) == {"invoicing_active": True, "reason": None}


def test_probe_never_raises_on_a_broken_session():
    """Health checks must degrade, never 500. A dead session reports the
    failure as a reason string instead of propagating."""
    from app.main import _billing_readiness

    class _BrokenSession:
        def get(self, *_args, **_kwargs):
            raise RuntimeError("connection reset")

    result = _billing_readiness(_BrokenSession())
    assert result["invoicing_active"] is False
    assert "RuntimeError" in result["reason"]


def test_cached_readiness_hits_the_db_once_within_the_ttl(db, monkeypatch):
    """Two external monitors poll every ~60s; the answer changes about once
    ever. Without the TTL this opens an ORM session ~2880x/day for nothing."""
    from app import main as main_module

    calls: list[int] = []

    def _counting_probe(_session):
        calls.append(1)
        return {"invoicing_active": True, "reason": None}

    monkeypatch.setattr(main_module, "_billing_readiness", _counting_probe)
    monkeypatch.setattr(main_module, "_billing_probe_cache", {"ts": 0.0, "value": None})

    first = main_module._cached_billing_readiness()
    second = main_module._cached_billing_readiness()

    assert first == second == {"invoicing_active": True, "reason": None}
    assert len(calls) == 1
