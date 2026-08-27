"""The vendor-call budget on `/chat/validate-email`, and why it is not the
request limit.

The route has two costs. A request costs a cache read and the plan/opt-in gate
queries; a CACHE MISS costs a Reoon call on OyeChats' own account, since the
endpoint is unmetered and authenticated only by the widget's bot key, which is
public. Counting requests to bound the second one meant a visitor re-checking
addresses we already held verdicts for could spend the budget that guards our
vendor bill, and then have their next address let through unchecked. The two
ceilings are therefore separate, and only the vendor call spends the budget.

Refusal is never a rejection: the visitor's form still submits. It returns 200
with `unverified: true` so the widget never has to read a verdict out of a
status code, and so the skips are countable in logs.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import chat_routes
from app.api.auth import get_current_bot

_GOOD = {"is_valid_syntax": True, "is_disposable": False, "status": "valid", "mx_accepts_mail": True}
_BAD = {"is_valid_syntax": True, "is_disposable": False, "status": "invalid", "mx_accepts_mail": False}


@pytest.fixture
def cache():
    """An in-memory stand-in for the verdict cache."""
    store: dict[str, object] = {}

    with (
        patch("app.core.cache.cache_get", side_effect=lambda key: store.get(key)),
        patch("app.core.cache.cache_set", side_effect=lambda key, value, _ttl: store.__setitem__(key, value) or True),
    ):
        yield store


@pytest.fixture
def post(monkeypatch):
    monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
    monkeypatch.setattr(chat_routes, "_agent_enrichment_opt_in", lambda *_a, **_k: True)

    app = FastAPI()
    app.include_router(chat_routes.router)
    app.dependency_overrides[get_current_bot] = lambda: MagicMock(id=1, bot_key="bot-1", client_id=1)
    client = TestClient(app)

    return lambda email: client.post("/chat/validate-email", json={"email": email})


class TestOnlyTheVendorCallSpendsTheBudget:
    def test_a_cached_verdict_costs_nothing(self, cache, post, monkeypatch):
        spent = []
        monkeypatch.setattr(
            chat_routes,
            "consume_vendor_budget",
            lambda *args: spent.append(args) or True,
        )

        with patch("app.services.reoon_service.verify_email", return_value=_GOOD):
            post("priya@infosys.com")
            post("priya@infosys.com")
            post("priya@infosys.com")

        assert len(spent) == 1

    def test_a_syntactically_broken_address_costs_nothing(self, cache, post, monkeypatch):
        """Rejected before the cache, so it can never reach the budget."""
        spent = []
        monkeypatch.setattr(chat_routes, "consume_vendor_budget", lambda *args: spent.append(args) or True)

        assert post("not-an-email").json()["valid"] is False
        assert spent == []


class TestAnExhaustedBudgetIsNeverAVerdict:
    def test_it_returns_unverified_rather_than_an_error_status(self, cache, post, monkeypatch):
        monkeypatch.setattr(chat_routes, "consume_vendor_budget", lambda *_a: False)

        with patch("app.services.reoon_service.verify_email") as verify:
            response = post("priya@infosys.com")

        assert response.status_code == 200
        assert response.json() == {"valid": True, "unverified": True}
        verify.assert_not_called()

    def test_it_is_not_cached_so_the_next_attempt_asks_again(self, cache, post, monkeypatch):
        monkeypatch.setattr(chat_routes, "consume_vendor_budget", lambda *_a: False)
        with patch("app.services.reoon_service.verify_email"):
            post("priya@infosys.com")

        assert cache == {}

        monkeypatch.setattr(chat_routes, "consume_vendor_budget", lambda *_a: True)
        with patch("app.services.reoon_service.verify_email", return_value=_BAD):
            assert post("priya@infosys.com").json()["valid"] is False
