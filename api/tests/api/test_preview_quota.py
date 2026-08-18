"""Preview-mode chats must be capped by a per-bot daily quota.

``bot._is_preview`` (stamped by ``get_bot_for_chat`` for an owner-authenticated
Build Studio request. See ``app/api/auth.py``) makes ``/chat`` and
``/chat/stream`` skip ``ai_chat`` credit deduction entirely. Left unbounded,
that's a free-LLM bypass: a bot owner can proxy real visitor traffic through
preview and never pay. ``check_and_increment_preview`` (app/services/
preview_quota.py) closes it with a per-bot, per-UTC-day counter; the chat
handlers must call it BEFORE generating and reject with 429 once exceeded.

Two layers:
  1. Pure unit tests of the helper itself, covering the Redis path, the
     in-process fallback (Redis unconfigured), the fail-open behaviour on a
     live Redis error, per-bot isolation, and the daily reset.
  2. Handler-level tests proving ``/chat`` honours the quota: over-quota gets
     429 with no LLM/credit call, under-quota gets 200 with no credit
     deduction (mirrors the "preview is free" contract already covered by
     ``test_preview_chat_auth.py``).
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from app.services import preview_quota

# ─────────────────────────────────────────────────────────────────────────────
# Helper unit tests
# ─────────────────────────────────────────────────────────────────────────────


class _FakeRedis:
    """Minimal INCR/EXPIRE double. Enough surface for check_and_increment_preview."""

    def __init__(self) -> None:
        self.store: dict[str, int] = {}
        self.ttls: dict[str, int] = {}
        self.incr_calls = 0

    def incr(self, key: str) -> int:
        self.incr_calls += 1
        self.store[key] = self.store.get(key, 0) + 1
        return self.store[key]

    def expire(self, key: str, ttl: int) -> None:
        self.ttls[key] = ttl


class _ExplodingRedis:
    """Simulates a live Redis connection that errors mid-call."""

    def incr(self, key: str):
        raise ConnectionError("redis unavailable")

    def expire(self, key: str, ttl: int):
        raise ConnectionError("redis unavailable")


@pytest.fixture(autouse=True)
def _isolate_local_counts():
    """The in-process fallback dict is module-global. Isolate it per test."""
    preview_quota._local_counts.clear()
    yield
    preview_quota._local_counts.clear()


@pytest.fixture
def _limit_of_3(monkeypatch):
    monkeypatch.setattr(preview_quota, "PREVIEW_DAILY_LIMIT", 3)
    return 3


def test_redis_path_allows_up_to_limit_then_blocks_on_nth_plus_one(monkeypatch, _limit_of_3):
    fake = _FakeRedis()
    monkeypatch.setattr(preview_quota, "get_redis", lambda: fake)

    results = [preview_quota.check_and_increment_preview(101) for _ in range(3)]
    assert results == [True, True, True]

    # The 4th call (limit + 1) must be rejected.
    assert preview_quota.check_and_increment_preview(101) is False

    # Further calls keep being rejected, not just the boundary one.
    assert preview_quota.check_and_increment_preview(101) is False


def test_redis_path_sets_ttl_only_on_first_increment(monkeypatch, _limit_of_3):
    fake = _FakeRedis()
    monkeypatch.setattr(preview_quota, "get_redis", lambda: fake)

    preview_quota.check_and_increment_preview(202)
    preview_quota.check_and_increment_preview(202)
    preview_quota.check_and_increment_preview(202)

    assert len(fake.ttls) == 1  # expire() called exactly once, on the first INCR
    (ttl_value,) = fake.ttls.values()
    assert ttl_value == preview_quota._TTL_SECONDS


def test_local_fallback_allows_up_to_limit_then_blocks(monkeypatch, _limit_of_3):
    """Redis unconfigured (get_redis() -> None) still enforces the real cap."""
    monkeypatch.setattr(preview_quota, "get_redis", lambda: None)

    results = [preview_quota.check_and_increment_preview(303) for _ in range(3)]
    assert results == [True, True, True]
    assert preview_quota.check_and_increment_preview(303) is False


def test_redis_error_mid_call_fails_open(monkeypatch, _limit_of_3):
    """A live Redis connection that errors must allow the request through
    (documented fail-open choice), not silently block every preview chat."""
    monkeypatch.setattr(preview_quota, "get_redis", lambda: _ExplodingRedis())

    for _ in range(10):  # far beyond the limit. Fail-open never flips to False
        assert preview_quota.check_and_increment_preview(404) is True


def test_counters_are_isolated_per_bot(monkeypatch, _limit_of_3):
    fake = _FakeRedis()
    monkeypatch.setattr(preview_quota, "get_redis", lambda: fake)

    for _ in range(3):
        assert preview_quota.check_and_increment_preview(1) is True
    assert preview_quota.check_and_increment_preview(1) is False

    # A different bot has its own, independent budget.
    assert preview_quota.check_and_increment_preview(2) is True


def test_counter_resets_on_a_new_day(monkeypatch, _limit_of_3):
    fake = _FakeRedis()
    monkeypatch.setattr(preview_quota, "get_redis", lambda: fake)

    # First 4 calls land on "today" (3 allowed + 1 over-limit), the 5th lands
    # on "tomorrow". Proving a fresh day bucket starts a fresh count.
    day_sequence = ["20260721"] * 4 + ["20260722"]
    bucket_calls: list[str] = []

    def _fake_bucket(bot_id: int) -> str:
        idx = min(len(bucket_calls), len(day_sequence) - 1)
        day = day_sequence[idx]
        bucket_calls.append(day)
        return f"{bot_id}:{day}"

    monkeypatch.setattr(preview_quota, "_day_bucket", _fake_bucket)

    for _ in range(3):
        assert preview_quota.check_and_increment_preview(9) is True
    assert preview_quota.check_and_increment_preview(9) is False  # exhausted "today"

    # A fresh day bucket starts a fresh count, even for the same bot.
    assert preview_quota.check_and_increment_preview(9) is True


# ─────────────────────────────────────────────────────────────────────────────
# Handler-level tests: /chat honours the quota
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")
class TestChatEndpointPreviewQuota:
    @staticmethod
    def _make_client_bot(db, *, email: str, api_key: str):
        from app.db.models import Bot, Client

        client = Client(name="Owner", email=email, api_key=api_key, hashed_password="h")
        db.add(client)
        db.flush()
        bot = Bot(client_id=client.id, bot_key=f"bot-{api_key}", name="Preview Bot", system_prompt="")
        db.add(bot)
        db.flush()
        db.commit()
        return client, bot

    def _app_with_bot(self, bot):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from app.api import chat_routes
        from app.api.auth import get_bot_for_chat

        app = FastAPI()
        app.include_router(chat_routes.router)
        app.dependency_overrides[get_bot_for_chat] = lambda: bot
        return TestClient(app, raise_server_exceptions=False)

    def test_over_quota_preview_returns_429_and_never_deducts_or_generates(self, db):
        from app.api import chat_routes
        from app.services import credit_service

        _, bot = self._make_client_bot(db, email="quota-over@example.com", api_key="quota-over-key")
        bot._is_preview = True
        api = self._app_with_bot(bot)

        def _deduct_should_not_be_called(*_a, **_k):
            pytest.fail("credit_service.check_and_deduct must not be called on the preview path")

        def _rag_should_not_be_called(*_a, **_k):
            pytest.fail("rag_pipeline must not run once the preview quota is exceeded")

        with (
            patch.object(chat_routes, "bot_subscription_status", lambda *a, **k: "active"),
            patch.object(chat_routes, "rag_pipeline", _rag_should_not_be_called),
            patch.object(credit_service, "check_and_deduct", _deduct_should_not_be_called),
            patch("app.services.preview_quota.check_and_increment_preview", lambda bot_id: False),
        ):
            res = api.post("/chat?preview=true&bot_id=1", json={"question": "Hi"})

        assert res.status_code == 429, res.text
        assert res.json()["detail"] == "preview_daily_limit_reached"

    def test_under_quota_preview_returns_200_with_no_credit_deduction(self, db):
        from app.api import chat_routes
        from app.services import credit_service

        _, bot = self._make_client_bot(db, email="quota-under@example.com", api_key="quota-under-key")
        bot._is_preview = True
        api = self._app_with_bot(bot)

        def _deduct_should_not_be_called(*_a, **_k):
            pytest.fail("credit_service.check_and_deduct must not be called on the preview path")

        with (
            patch.object(chat_routes, "bot_subscription_status", lambda *a, **k: "active"),
            patch.object(
                chat_routes,
                "rag_pipeline",
                lambda *a, **k: {"answer": "Hi there", "sources": []},
            ),
            patch.object(chat_routes, "submit_background", lambda *a, **k: None),
            patch.object(credit_service, "check_and_deduct", _deduct_should_not_be_called),
            patch("app.services.preview_quota.check_and_increment_preview", lambda bot_id: True),
        ):
            res = api.post("/chat?preview=true&bot_id=1", json={"question": "Hi"})

        assert res.status_code == 200, res.text
        assert res.json()["answer"] == "Hi there"
