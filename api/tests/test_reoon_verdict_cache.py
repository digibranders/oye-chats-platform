"""The blur-check verdict cache, and why its two answers keep different time.

`/chat/validate-email` is unmetered and authenticated only by the widget's bot
key, which is embedded in every customer's page, so it was 20 free Reoon calls
a minute per key on OyeChats' own account. Caching the verdict fixes that.

What caching must NOT do is turn a transient vendor error into a lockout. An
"undeliverable" verdict BLOCKS the visitor (`HandoffForm` refuses to submit on
it), it comes from a live DNS/SMTP probe with known false positives, and the
cache key is the address rather than the tenant, so a single bad probe held
for a day would pin a real person out of every OyeChats widget on the internet
with no invalidation path. The deliverable verdict carries no such risk.

Hence: 24h for "fine", minutes for "blocked". These tests pin that asymmetry,
the fail-open on an unreachable vendor, and the key's namespace prefix.
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
    """An in-memory stand-in that records the TTL each write asked for."""
    store: dict[str, tuple[object, int]] = {}

    def _get(key: str):
        entry = store.get(key)
        return entry[0] if entry else None

    def _set(key: str, value, ttl: int) -> bool:
        store[key] = (value, ttl)
        return True

    with (
        patch("app.core.cache.cache_get", side_effect=_get),
        patch("app.core.cache.cache_set", side_effect=_set),
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


def _ttl_of(store: dict, verdict: bool) -> int:
    (entry,) = [v for v in store.values() if v[0] == {"undeliverable": verdict}]
    return entry[1]


class TestTheTwoVerdictsKeepDifferentTime:
    def test_a_deliverable_address_is_cached_for_a_day(self, cache, post):
        with patch("app.services.reoon_service.verify_email", return_value=_GOOD):
            assert post("priya@infosys.com").json() == {"valid": True}

        assert _ttl_of(cache, False) == 24 * 60 * 60

    def test_a_blocking_verdict_is_held_only_minutes(self, cache, post):
        """Long enough to absorb a burst on the public key, short enough that a
        false positive clears on the visitor's next try rather than next day."""
        with patch("app.services.reoon_service.verify_email", return_value=_BAD):
            assert post("priya@infosys.com").json()["valid"] is False

        blocked_ttl = _ttl_of(cache, True)
        assert blocked_ttl <= 15 * 60
        assert blocked_ttl < 24 * 60 * 60


class TestTheVendorIsCalledOnce:
    def test_a_repeat_check_reads_the_cache(self, cache, post):
        with patch("app.services.reoon_service.verify_email", return_value=_GOOD) as verify:
            post("priya@infosys.com")
            post("priya@infosys.com")

        verify.assert_called_once()

    def test_a_different_address_is_a_different_key(self, cache, post):
        with patch("app.services.reoon_service.verify_email", return_value=_GOOD) as verify:
            post("priya@infosys.com")
            post("arjun@infosys.com")

        assert verify.call_count == 2
        assert len(cache) == 2


class TestAnOutageIsNeverCached:
    def test_an_unreachable_vendor_fails_open_and_writes_nothing(self, cache, post):
        """The next attempt must retry, not inherit the outage."""
        with patch("app.services.reoon_service.verify_email", return_value=None):
            assert post("priya@infosys.com").json() == {"valid": True, "unverified": True}

        assert cache == {}

    def test_the_retry_reaches_the_vendor(self, cache, post):
        with patch("app.services.reoon_service.verify_email", return_value=None):
            post("priya@infosys.com")
        with patch("app.services.reoon_service.verify_email", return_value=_GOOD) as verify:
            post("priya@infosys.com")

        verify.assert_called_once()


class TestTheKeyIsNamespaced:
    def test_the_key_carries_the_platform_prefix(self, cache, post):
        """`core.cache.PREFIX` namespaces every key this platform writes, so a
        shared Redis can't collide and a prefix flush can reach it, which
        matters here because there is no other invalidation path."""
        from app.core.cache import PREFIX

        with patch("app.services.reoon_service.verify_email", return_value=_GOOD):
            post("priya@infosys.com")

        (key,) = cache
        assert key.startswith(PREFIX)

    def test_the_raw_address_is_never_stored(self, cache, post):
        with patch("app.services.reoon_service.verify_email", return_value=_GOOD):
            post("priya@infosys.com")

        (key,) = cache
        assert "priya" not in key
        assert "infosys.com" not in key
