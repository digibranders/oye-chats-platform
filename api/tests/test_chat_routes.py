"""Tests for app.api.chat_routes. Chat endpoint functionality."""

import asyncio
import contextlib
import time
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_bot_for_chat, get_current_bot, get_current_client_or_operator
from app.api.chat_routes import _is_answer_chunk, _record_stream_latency, router
from app.core.chat_concurrency import ChatConcurrencyGate
from app.core.metrics import record_latency_ms


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(bot_override=None, auth_override=None):
    app = FastAPI()
    app.include_router(router)
    if bot_override:
        app.dependency_overrides[get_current_bot] = lambda: bot_override
        # /chat and /chat/stream now resolve the bot via get_bot_for_chat
        # (adds an owner-preview branch); override it too so these tests hit
        # the same fixture bot.
        app.dependency_overrides[get_bot_for_chat] = lambda: bot_override
    if auth_override:
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth_override
    return app


@pytest.fixture(autouse=True)
def _allow_subscription(monkeypatch):
    """Default every chat-route test to a healthy subscription.

    PR3 added an owner-subscription check at the top of /chat and
    /chat/stream. These tests already mock the bot row and assert
    happy-path behaviour, so the gate would otherwise short-circuit them
    into the offline path. Tests that specifically exercise the offline
    path patch this same symbol back to a non-active value.

    Also defaults every test's bot to a plan that includes real-time email
    validation (Standard/Professional). TestValidateEmail's tests assert
    on Reoon's result and predate the Standard+Professional plan gate;
    the new gating tests in test_chat_routes_email_validation_gating.py
    override this back to False per-test to exercise the denial path.
    """
    from app.api import chat_routes

    monkeypatch.setattr(chat_routes, "bot_subscription_status", lambda _client_id, subscription_id=None: "active")
    monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
    # Email verification is also gated on the per-agent opt-in (AI Agent →
    # Advanced); default it ON here so TestValidateEmail's Reoon-result
    # assertions exercise the verification path rather than the skip path.
    monkeypatch.setattr(chat_routes, "_agent_enrichment_opt_in", lambda *_a, **_k: True)


def _default_bot(**overrides):
    defaults = dict(
        id=1,
        client_id=1,
        bot_key="bot-test123",
        name="Test Bot",
        is_active=True,
        bant_enabled=False,
        bant_config=None,
        system_prompt="You are helpful.",
        website="https://example.com",
        company_name=None,
        company_description=None,
        brand_tone=None,
        live_chat_enabled=False,
        feature_flags={},
        widget_config={},
        notification_email=None,
        notification_emails=None,
        meeting_booking_enabled=False,
        calendly_url=None,
        subscription_id=None,
        is_legacy_pooled=False,
        _subscription_bot_id=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# ── Chat endpoint ────────────────────────────────────────────────────────────


class TestChatEndpoint:
    def test_successful_chat(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        mock_session = MagicMock()

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.services.credit_service.get_credit_cost", return_value=1),
            patch("app.services.credit_service.check_and_deduct"),
            patch("app.api.chat_routes._resolve_session_id", return_value="session-1"),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes.submit_background"),
            patch(
                "app.api.chat_routes.collect_rag_pipeline",
                return_value={
                    "answer": "Hello! How can I help?",
                    "sources": [],
                    "session_id": "session-1",
                    "message_id": 42,
                },
            ),
        ):
            mock_gs.return_value = _session_ctx(mock_session)
            response = tc.post(
                "/chat",
                json={"question": "Hello"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["answer"] == "Hello! How can I help?"
        assert data["session_id"] == "session-1"

    def test_empty_question_rejected(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        response = tc.post(
            "/chat",
            json={"question": ""},
            headers={"X-Bot-Key": "bot-test123"},
        )

        assert response.status_code == 422


# ── Chat concurrency gate on POST /chat ──────────────────────────────────────


def _saturated_gate(acquire_timeout_s: float = 0.05) -> ChatConcurrencyGate:
    """A gate whose only slot is already taken, so the next acquire sheds after
    ``acquire_timeout_s``. Taking it outside the app's loop is fine: an
    uncontended acquire returns at once and binds the semaphore to no loop."""
    gate = ChatConcurrencyGate(limit=1, acquire_timeout_s=acquire_timeout_s)
    asyncio.run(gate.slot().__aenter__())
    return gate


def _charged_chat_patches(refunds: list[int], pipeline):
    """Patches for a ``POST /chat`` that gets past the subscription and credit
    gates with one credit charged, and whose refunds land in ``refunds``."""
    return (
        patch("app.api.chat_routes.get_session", side_effect=lambda: _session_ctx(MagicMock())),
        patch("app.services.credit_service.get_credit_cost", return_value=1),
        patch("app.services.credit_service.check_and_deduct"),
        patch("app.api.chat_routes._refund_ai_chat_credit", side_effect=lambda _bot, cost: refunds.append(cost)),
        patch("app.api.chat_routes._resolve_session_id", return_value="session-1"),
        patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
        patch("app.api.chat_routes._resolve_visitor_language_and_update_session", return_value=None),
        patch("app.api.chat_routes.submit_background"),
        patch("app.api.chat_routes.collect_rag_pipeline", pipeline),
    )


class TestChatConcurrencyGate:
    """``POST /chat`` used to bypass the backpressure gate ``/chat/stream``
    acquires, so a burst on the legacy endpoint could exhaust the DB pool the
    gate exists to protect. These pin that the two endpoints now share one
    ceiling and one shed contract: HTTP 503 + Retry-After, and the credit
    charged before the gate comes back."""

    def _post(self, tc: TestClient):
        return tc.post("/chat", json={"question": "Hello"}, headers={"X-Bot-Key": "bot-test123"})

    def test_returns_503_with_retry_after_when_the_gate_is_full(self):
        bot = _default_bot()
        tc = TestClient(_build_app(bot_override=bot))
        refunds: list[int] = []
        pipeline = AsyncMock(return_value={"answer": "never", "sources": [], "session_id": "session-1"})

        with ExitStack() as stack:
            for cm in _charged_chat_patches(refunds, pipeline):
                stack.enter_context(cm)
            stack.enter_context(patch("app.api.chat_routes.chat_gate", _saturated_gate()))
            response = self._post(tc)

        assert response.status_code == 503
        assert response.headers["retry-after"] == "1"
        assert response.json()["detail"]["error"] == "server_busy"
        pipeline.assert_not_called()
        # A shed request is never charged: the credit taken before the gate comes back.
        assert refunds == [1]

    def test_a_shed_preview_request_refunds_nothing(self):
        """Owner-preview replies are free, so there is nothing to give back."""
        bot = _default_bot(_is_preview=True)
        tc = TestClient(_build_app(bot_override=bot))
        refunds: list[int] = []

        with ExitStack() as stack:
            for cm in _charged_chat_patches(refunds, AsyncMock()):
                stack.enter_context(cm)
            stack.enter_context(patch("app.services.preview_quota.check_and_increment_preview", return_value=True))
            stack.enter_context(patch("app.api.chat_routes.chat_gate", _saturated_gate()))
            response = self._post(tc)

        assert response.status_code == 503
        assert refunds == []

    def test_the_pipeline_runs_inside_a_slot_that_is_released_afterwards(self):
        bot = _default_bot()
        tc = TestClient(_build_app(bot_override=bot))
        gate = ChatConcurrencyGate(limit=2, acquire_timeout_s=1.0)
        refunds: list[int] = []
        seen: dict[str, int] = {}

        async def pipeline(*_args, **_kwargs):
            seen["in_flight"] = gate.stats()["in_flight"]
            return {"answer": "Hello!", "sources": [], "session_id": "session-1"}

        with ExitStack() as stack:
            for cm in _charged_chat_patches(refunds, pipeline):
                stack.enter_context(cm)
            stack.enter_context(patch("app.api.chat_routes.chat_gate", gate))
            response = self._post(tc)

        assert response.status_code == 200
        assert response.json()["answer"] == "Hello!"
        assert seen["in_flight"] == 1
        assert gate.stats()["in_flight"] == 0
        assert refunds == []

    def test_the_slot_is_released_when_the_pipeline_raises(self):
        bot = _default_bot()
        tc = TestClient(_build_app(bot_override=bot), raise_server_exceptions=False)
        gate = ChatConcurrencyGate(limit=1, acquire_timeout_s=1.0)
        refunds: list[int] = []

        with ExitStack() as stack:
            for cm in _charged_chat_patches(refunds, MagicMock(side_effect=RuntimeError("pipeline exploded"))):
                stack.enter_context(cm)
            stack.enter_context(patch("app.api.chat_routes.chat_gate", gate))
            response = self._post(tc)

        assert response.status_code == 500
        assert gate.stats()["in_flight"] == 0
        assert refunds == [1]


# ── Stream latency metrics ───────────────────────────────────────────────────


class TestStreamLatencyMetrics:
    """``/chat/stream`` records ``chat_ttft_ms`` (request start to the first
    answer chunk) and ``chat_stream_total_ms`` (request start to the end of the
    stream) as latency histograms, handed to the background pool so the event
    loop never waits on Redis."""

    def _patches(self, stream, submitted: list):
        return (
            patch("app.api.chat_routes._deduct_ai_chat_credit_sync", return_value=1),
            patch("app.api.chat_routes._refund_ai_chat_credit"),
            patch("app.api.chat_routes._resolve_session_id", return_value="session-1"),
            patch("app.api.chat_routes._parse_request_context", return_value=("1.2.3.4", "Desktop Chrome")),
            patch("app.api.chat_routes._resolve_visitor_language_and_update_session", return_value=None),
            patch("app.api.chat_routes.submit_background", side_effect=lambda fn, *a, **k: submitted.append((fn, a))),
            patch("app.api.chat_routes.rag_pipeline_stream", stream),
        )

    def _latencies(self, submitted: list) -> list[tuple[str, float]]:
        return [(args[0], args[1]) for fn, args in submitted if fn is record_latency_ms]

    def _stream(self, tc: TestClient):
        return tc.post("/chat/stream", json={"question": "Hello"}, headers={"X-Bot-Key": "bot-test123"})

    def test_records_ttft_on_the_first_answer_chunk_and_total_at_the_end(self):
        async def stream(*_args, **_kwargs):
            yield 'METADATA:{"session_id": "session-1"}\n'
            yield "\n"  # whitespace is not an answer
            yield "Hello"
            yield " there"
            yield '\nFINAL_METADATA:{"message_id": 1}\n'

        submitted: list = []
        tc = TestClient(_build_app(bot_override=_default_bot()))
        with ExitStack() as stack:
            for cm in self._patches(stream, submitted):
                stack.enter_context(cm)
            response = self._stream(tc)

        assert response.status_code == 200
        latencies = self._latencies(submitted)
        assert [name for name, _ in latencies] == ["chat_ttft_ms", "chat_stream_total_ms"]
        (_, ttft), (_, total) = latencies
        assert 0 <= ttft <= total

    def test_no_ttft_when_the_stream_carries_no_answer_text(self):
        async def stream(*_args, **_kwargs):
            yield "METADATA:{}\n"
            yield '\nFINAL_METADATA:{"generation_failed": true}\n'

        submitted: list = []
        tc = TestClient(_build_app(bot_override=_default_bot()))
        with ExitStack() as stack:
            for cm in self._patches(stream, submitted):
                stack.enter_context(cm)
            self._stream(tc)

        assert [name for name, _ in self._latencies(submitted)] == ["chat_stream_total_ms"]

    def test_a_stream_that_dies_midway_records_ttft_but_no_total(self):
        """A total for a stream that never finished would only make the
        distribution look faster than the service is."""

        async def stream(*_args, **_kwargs):
            yield "METADATA:{}\n"
            yield "Hel"
            raise RuntimeError("provider died")

        submitted: list = []
        tc = TestClient(_build_app(bot_override=_default_bot()))
        with ExitStack() as stack:
            for cm in self._patches(stream, submitted):
                stack.enter_context(cm)
            with contextlib.suppress(RuntimeError):
                self._stream(tc)

        assert [name for name, _ in self._latencies(submitted)] == ["chat_ttft_ms"]

    def test_recording_never_raises_when_the_pool_refuses_work(self):
        with patch("app.api.chat_routes.submit_background", side_effect=RuntimeError("shutting down")):
            _record_stream_latency("chat_ttft_ms", time.perf_counter())  # must not raise

    @pytest.mark.parametrize(
        ("chunk", "expected"),
        [
            ("Hello", True),
            ("  Hello\n", True),
            ('METADATA:{"a": 1}\n', False),
            ('\nFINAL_METADATA:{"message_id": 1}\n', False),
            ("", False),
            ("\n  \n", False),
        ],
    )
    def test_is_answer_chunk(self, chunk, expected):
        assert _is_answer_chunk(chunk) is expected


# ── Lead capture ─────────────────────────────────────────────────────────────


class TestLeadCapture:
    def test_valid_lead_capture(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.ensure_chat_session") as mock_ensure,
            patch("app.api.chat_routes.create_or_update_lead_info"),
            patch("app.services.webhook_service.fire_webhook"),
            patch(
                "app.services.reoon_service.verify_email",
                return_value={"is_safe_to_send": True, "status": "safe", "is_disposable": False},
            ),
        ):
            session = MagicMock()
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/lead-capture",
                json={
                    "session_id": "session-1",
                    "name": "John",
                    "email": "john@example.com",
                    "phone": "+1234567890",
                    "company": "Acme",
                },
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["success"] is True
        # The lead form runs before the first chat turn, so this is often the
        # call that CREATES the session row. It must stamp the owner: analytics
        # filter on ``client_id`` and a NULL row is invisible to the dashboard.
        assert mock_ensure.call_args.kwargs["client_id"] == bot.client_id
        assert mock_ensure.call_args.kwargs["bot_id"] == bot.id

    def test_restored_lead_writes_row_but_fires_no_webhook(self):
        """Re-seeding a returning visitor's name into a NEW session must not look
        like a new lead: the row is written (that is what stops the bot asking for
        the name again), but the customer's ``lead_captured`` webhook and the
        email enrichment must both stay silent, or every new conversation from a
        known visitor would emit a duplicate lead event."""
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.ensure_chat_session"),
            patch("app.api.chat_routes.create_or_update_lead_info") as mock_upsert,
            patch("app.services.webhook_service.fire_webhook") as mock_webhook,
            patch("app.core.thread_pool.submit_background") as mock_bg,
        ):
            session = MagicMock()
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/lead-capture",
                json={"session_id": "session-restored", "name": "Gaurav", "restored": True},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["restored"] is True
        # The lead row IS written — this is what suppresses the name question.
        assert mock_upsert.called
        assert mock_upsert.call_args.kwargs["name"] == "Gaurav"
        # ...but nothing that signals "a new lead arrived" runs.
        assert not mock_webhook.called
        assert not mock_bg.called

    def test_normal_lead_capture_still_fires_webhook(self):
        """Regression guard for the flag above: a genuine submission (no
        ``restored``) must keep firing the webhook and enrichment exactly as
        before, so adding the flag cannot silently disable real lead events."""
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.ensure_chat_session"),
            patch("app.api.chat_routes.create_or_update_lead_info"),
            patch("app.services.webhook_service.fire_webhook") as mock_webhook,
            patch("app.core.thread_pool.submit_background") as mock_bg,
        ):
            session = MagicMock()
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/lead-capture",
                json={"session_id": "session-real", "name": "John", "email": "john@example.com"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json().get("restored") is None
        assert mock_webhook.called
        assert mock_bg.called

    def test_invalid_email_rejected(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        response = tc.post(
            "/chat/lead-capture",
            json={
                "session_id": "session-1",
                "name": "John",
                "email": "not-an-email",
            },
            headers={"X-Bot-Key": "bot-test123"},
        )

        assert response.status_code == 422


# ── Validate email (submit-time widget gate) ─────────────────────────────────


class TestValidateEmail:
    @pytest.fixture(autouse=True)
    def _no_verdict_cache(self, monkeypatch):
        """Take the Reoon verdict cache out of the picture for this class.

        These tests assert what the endpoint DECIDES, but it caches verdicts in
        a live Redis keyed only on the address, with a 24h TTL and no test
        namespace. Without this, an earlier case here caches a verdict for an
        address a later case reuses, and the later one reads the cache instead
        of its own mock, passing on a clean Redis and failing for the rest of
        the day. The cache's own behaviour is covered in
        test_reoon_verdict_cache.py.
        """
        monkeypatch.setattr("app.core.cache.cache_get", lambda _key: None)
        monkeypatch.setattr("app.core.cache.cache_set", lambda *_a, **_k: True)

    def test_bad_syntax_blocked_without_calling_reoon(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with patch("app.services.reoon_service.verify_email") as mock_verify:
            response = tc.post(
                "/chat/validate-email",
                json={"email": "not-an-email"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json() == {"valid": False, "reason": "Please enter a valid email address."}
        mock_verify.assert_not_called()

    def test_disposable_email_blocked(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with patch(
            "app.services.reoon_service.verify_email",
            return_value={
                "status": "disposable",
                "is_safe_to_send": False,
                "is_disposable": True,
                "is_valid_syntax": True,
                "is_spamtrap": False,
                "mx_accepts_mail": True,
            },
        ):
            response = tc.post(
                "/chat/validate-email",
                json={"email": "test@mailinator.com"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["valid"] is False

    def test_dead_domain_blocked(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with patch(
            "app.services.reoon_service.verify_email",
            return_value={
                "status": "invalid",
                "is_safe_to_send": False,
                "is_disposable": False,
                "is_valid_syntax": True,
                "is_spamtrap": False,
                "mx_accepts_mail": False,
            },
        ):
            response = tc.post(
                "/chat/validate-email",
                json={"email": "test@thisdomaindoesnotexist9821xyz.com"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["valid"] is False

    def test_catch_all_domain_allowed_through(self):
        """The key lenient-blocking behavior: a real B2B lead on a
        catch-all corporate domain must NOT be rejected just because Reoon
        can't positively confirm deliverability."""
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with patch(
            "app.services.reoon_service.verify_email",
            return_value={
                "status": "catch_all",
                "is_safe_to_send": False,  # not positively confirmed, but not junk either
                "is_disposable": False,
                "is_valid_syntax": True,
                "is_spamtrap": False,
                "mx_accepts_mail": True,
            },
        ):
            response = tc.post(
                "/chat/validate-email",
                json={"email": "priya@fabrikam.com"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json() == {"valid": True}

    def test_confirmed_safe_email_allowed(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with patch(
            "app.services.reoon_service.verify_email",
            return_value={
                "status": "safe",
                "is_safe_to_send": True,
                "is_disposable": False,
                "is_valid_syntax": True,
                "is_spamtrap": False,
                "mx_accepts_mail": True,
            },
        ):
            response = tc.post(
                "/chat/validate-email",
                json={"email": "gaurav@fynix.digital"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json() == {"valid": True}

    def test_fails_open_when_reoon_unavailable(self):
        """An outage or missing key on our side must never block a real
        visitor from submitting the form."""
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with patch("app.services.reoon_service.verify_email", return_value=None):
            response = tc.post(
                "/chat/validate-email",
                json={"email": "gaurav@fynix.digital"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        # 200 with an explicit "we did not verify this", never an error status:
        # the widget must not have to read a verdict out of a status code.
        assert response.json() == {"valid": True, "unverified": True}


# ── Feedback ─────────────────────────────────────────────────────────────────


class TestFeedback:
    def test_valid_feedback(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.update_message_feedback", return_value=True),
            patch("app.api.chat_routes.get_langfuse", return_value=None),
        ):
            session = MagicMock()
            msg = MagicMock()
            msg.trace_id = None
            session.execute.return_value.scalars.return_value.first.return_value = msg
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/feedback/42",
                json={"feedback": 1},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200

    def test_feedback_not_found(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.update_message_feedback", return_value=False),
        ):
            session = MagicMock()
            session.execute.return_value.scalars.return_value.first.return_value = None
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/feedback/999",
                json={"feedback": 1},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 404


# ── Lead info ────────────────────────────────────────────────────────────────


class TestLeadInfo:
    def test_returns_lead_info(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        lead = SimpleNamespace(name="John", email="john@example.com", phone=None, company=None)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.get_lead_info_by_session", return_value=lead),
        ):
            session = MagicMock()
            cs = SimpleNamespace(id="s1", bot_id=1)
            session.execute.return_value.scalars.return_value.first.return_value = cs
            mock_gs.return_value = _session_ctx(session)

            response = tc.get(
                "/chat/lead-info/s1",
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["lead_info"]["name"] == "John"

    def test_returns_none_when_no_lead(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.get_lead_info_by_session", return_value=None),
        ):
            session = MagicMock()
            session.execute.return_value.scalars.return_value.first.return_value = None
            mock_gs.return_value = _session_ctx(session)

            response = tc.get(
                "/chat/lead-info/no-session",
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["lead_info"] is None


# ── Behavioral signals ───────────────────────────────────────────────────────


class TestBehavioralSignals:
    def test_records_signals(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        cs = SimpleNamespace(
            id="s1",
            bot_id=1,
            page_url=None,
            referrer=None,
            utm_params=None,
            visit_count=0,
            behavioral_score=0,
        )
        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
            patch("app.api.chat_routes.ensure_chat_session", return_value=cs),
            patch("app.services.behavioral_service.score_behavioral_signals", return_value=25),
        ):
            session = MagicMock()
            session.execute.return_value.scalar_one.return_value = cs
            session.execute.return_value.scalar_one_or_none.return_value = cs
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/behavioral-signals",
                json={
                    "session_id": "s1",
                    "page_url": "https://example.com/pricing",
                    "time_on_page": 30,
                },
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 200
        assert response.json()["success"] is True
        assert response.json()["behavioral_score"] == 25


# ── Journey merge + sanitize ─────────────────────────────────────────────────


class TestJourneySanitize:
    def test_accepts_phase_and_event_in_whitelist(self):
        from app.api.chat_routes import _sanitize_journey

        out = _sanitize_journey(
            [
                {"path": "/pricing", "ts": "2026-08-06T10:00:00Z", "phase": "pre"},
                {"path": "/pricing", "ts": "2026-08-06T10:01:00Z", "phase": "chat", "event": "chat_opened"},
            ]
        )
        assert out == [
            {"path": "/pricing", "ts": "2026-08-06T10:00:00Z", "phase": "pre"},
            {"path": "/pricing", "ts": "2026-08-06T10:01:00Z", "phase": "chat", "event": "chat_opened"},
        ]

    def test_drops_unknown_phase_and_event(self):
        from app.api.chat_routes import _sanitize_journey

        out = _sanitize_journey(
            [
                {"path": "/x", "phase": "bogus", "event": "not_a_real_event"},
            ]
        )
        # Row survives, but phase/event are stripped
        assert out == [{"path": "/x"}]

    def test_drops_non_string_phase_event(self):
        from app.api.chat_routes import _sanitize_journey

        out = _sanitize_journey([{"path": "/x", "phase": 42, "event": {"nope": True}}])
        assert out == [{"path": "/x"}]


class TestJourneyMerge:
    def test_empty_existing_uses_incoming(self):
        from app.api.chat_routes import _merge_journey

        incoming = [{"path": "/a", "phase": "pre", "ts": "t1"}]
        assert _merge_journey(None, incoming) == incoming
        assert _merge_journey([], incoming) == incoming

    def test_empty_incoming_preserves_existing(self):
        from app.api.chat_routes import _merge_journey

        existing = [{"path": "/a", "phase": "pre", "ts": "t1"}]
        assert _merge_journey(existing, None) == existing
        assert _merge_journey(existing, []) == existing

    def test_widget_resend_is_idempotent(self):
        """Widget sends the FULL journey on every update; same payload
        twice must not duplicate rows."""
        from app.api.chat_routes import _merge_journey

        journey = [
            {"path": "/a", "phase": "pre", "ts": "t1"},
            {"path": "/b", "phase": "pre", "ts": "t2"},
        ]
        merged = _merge_journey(journey, journey)
        assert merged == journey

    def test_merge_appends_new_entries(self):
        from app.api.chat_routes import _merge_journey

        existing = [{"path": "/a", "phase": "pre", "ts": "t1"}]
        incoming = [
            {"path": "/a", "phase": "pre", "ts": "t1"},
            {"path": "/b", "phase": "chat", "event": "chat_opened", "ts": "t2"},
            {"path": "/c", "phase": "post", "ts": "t3"},
        ]
        merged = _merge_journey(existing, incoming)
        assert merged == [
            {"path": "/a", "phase": "pre", "ts": "t1"},
            {"path": "/b", "phase": "chat", "event": "chat_opened", "ts": "t2"},
            {"path": "/c", "phase": "post", "ts": "t3"},
        ]

    def test_merge_keeps_existing_when_widget_lost_state(self):
        """Private tab / cleared storage → widget sends a shorter journey.
        We must not lose the history we already stored."""
        from app.api.chat_routes import _merge_journey

        existing = [
            {"path": "/a", "phase": "pre", "ts": "t1"},
            {"path": "/b", "phase": "pre", "ts": "t2"},
        ]
        incoming = [{"path": "/c", "phase": "pre", "ts": "t3"}]  # fresh widget
        merged = _merge_journey(existing, incoming)
        assert merged == [
            {"path": "/a", "phase": "pre", "ts": "t1"},
            {"path": "/b", "phase": "pre", "ts": "t2"},
            {"path": "/c", "phase": "pre", "ts": "t3"},
        ]

    def test_trim_drops_pre_phase_first(self):
        """When over cap, oldest pre-phase entries go first so chat/post
        markers survive."""
        from app.api.chat_routes import _trim_journey

        entries = (
            [{"path": f"/pre-{i}", "phase": "pre", "ts": f"p{i}"} for i in range(198)]
            + [{"path": "/opened", "phase": "chat", "event": "chat_opened", "ts": "c1"}]
            + [{"path": "/after1", "phase": "post", "ts": "p1"}]
            + [{"path": "/after2", "phase": "post", "ts": "p2"}]
            + [{"path": "/after3", "phase": "post", "ts": "p3"}]
        )
        assert len(entries) == 202
        trimmed = _trim_journey(entries)
        assert len(trimmed) == 200
        assert any(e.get("event") == "chat_opened" for e in trimmed)
        # All 3 post entries survive
        assert sum(1 for e in trimmed if e.get("phase") == "post") == 3

    def test_trim_no_op_under_cap(self):
        from app.api.chat_routes import _trim_journey

        entries = [{"path": "/a", "phase": "pre"}] * 10
        assert _trim_journey(entries) == entries


# ── Transcript ───────────────────────────────────────────────────────────────


class TestTranscript:
    def test_requires_session(self):
        bot = _default_bot()
        app = _build_app(bot_override=bot)
        tc = TestClient(app)

        with (
            patch("app.api.chat_routes.get_session") as mock_gs,
        ):
            session = MagicMock()
            session.execute.return_value.scalar_one_or_none.return_value = None
            session.execute.return_value.scalars.return_value.first.return_value = None
            mock_gs.return_value = _session_ctx(session)

            response = tc.post(
                "/chat/transcript",
                json={"session_id": "no-session", "recipient_email": "a@b.com"},
                headers={"X-Bot-Key": "bot-test123"},
            )

        assert response.status_code == 404


class TestVisitorCountryFromRequest:
    """_visitor_country_from_request reads Cloudflare's CF-IPCountry header and
    normalizes it: real codes upper-cased, placeholders/missing → None (so the
    pricing directive defaults to USD)."""

    @staticmethod
    def _req(headers):
        # dict.get satisfies the case-insensitive lowercase lookup the helper
        # performs; a real Starlette request is unnecessary for this unit.
        return SimpleNamespace(headers=headers)

    def test_india(self):
        from app.api.chat_routes import _visitor_country_from_request

        assert _visitor_country_from_request(self._req({"cf-ipcountry": "IN"})) == "IN"

    def test_lowercase_value_is_upcased(self):
        from app.api.chat_routes import _visitor_country_from_request

        assert _visitor_country_from_request(self._req({"cf-ipcountry": "us"})) == "US"

    def test_missing_header_is_none(self):
        from app.api.chat_routes import _visitor_country_from_request

        assert _visitor_country_from_request(self._req({})) is None

    @pytest.mark.parametrize("placeholder", ["XX", "T1", ""])
    def test_placeholder_values_are_none(self, placeholder):
        from app.api.chat_routes import _visitor_country_from_request

        assert _visitor_country_from_request(self._req({"cf-ipcountry": placeholder})) is None
