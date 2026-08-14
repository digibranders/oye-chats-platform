"""No visitor PII may leave this process inside a Sentry payload.

``send_default_pii=False`` covers ``user.ip_address`` and ``REMOTE_ADDR`` and
nothing else that matters here. Four separate paths carried a visitor's address
or email past it:

1. ``CF-Connecting-IP`` in the request headers ``SentryAsgiMiddleware`` attaches
   to every event. Nginx rewrites ``X-Forwarded-For`` to the Cloudflare edge
   address — so the header the SDK scrubs is the empty one and the header
   ``chat_routes`` actually trusts is the one that shipped.
2. Raw addresses interpolated into WARNING log records, which Sentry's
   LoggingIntegration turns into breadcrumbs on a shared background thread.
3. A recipient address set verbatim as an ``email.*`` Sentry tag.
4. A recipient address as the *message* of an ERROR record, which
   LoggingIntegration promotes to a full Sentry event.

A visitor IP and a visitor email are both personal data under GDPR and under
India's DPDP Act, where this product's basis is consent-only with no
legitimate-interest fallback.

These tests pin each fix at the layer that can actually regress: the hook by
running the SDK's own request-data builder and then the hook over it, and the
wiring by calling the two ``_init_sentry_*`` functions with a stubbed
``sentry_sdk.init``. Deleting ``before_send``, dropping a header from the list,
or re-interpolating an address into any of the four sites fails a test here.
"""

import json
import logging
import threading
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
import sentry_sdk
from sentry_sdk.integrations._asgi_common import _get_request_data
from sentry_sdk.integrations._wsgi_common import SENSITIVE_HEADERS

import app.core.sentry_scrub as scrub
from app.core.sentry_scrub import CREDENTIAL_HEADERS, VISITOR_IP_HEADERS, scrub_event

# Documentation ranges (RFC 5737 / RFC 3849) and RFC 2606 domains, so a grep for
# any of these never collides with a real value someone pasted into a fixture.
IPV4 = "203.0.113.42"
IPV6 = "2001:db8::dead:beef"
VISITOR_EMAIL = "priya.sharma@example.com"

# ``_resolve_and_update_location`` returns early for private addresses, and
# Python counts every RFC 5737 documentation range as private
# (``ipaddress.ip_address("203.0.113.42").is_private`` is True) — so the tests
# that drive that function need one it will actually work on. This is the
# address IANA holds for example.com: publicly routable, and nobody's visitor.
PUBLIC_IPV4 = "93.184.216.34"

DSN = "https://key@sentry.io/123"


class _JsonResponse:
    """Stand-in for the ``urlopen`` context manager the geo vendors are called through."""

    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_JsonResponse":
        return self

    def __exit__(self, *_exc) -> bool:
        return False


def _asgi_scope(headers: dict[str, str]) -> dict:
    """An ASGI HTTP scope shaped the way uvicorn builds one.

    Header names are lower-cased bytes and values are bytes, per the ASGI spec —
    matching the real thing matters, because it is the only reason
    ``_get_request_data`` produces the dict the hook then has to match against.
    """
    return {
        "type": "http",
        "method": "POST",
        "scheme": "https",
        "server": ("10.0.0.4", 8000),
        "path": "/chat",
        "query_string": b"",
        "client": ("127.0.0.1", 51234),
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
    }


def _event_from(headers: dict[str, str]) -> dict:
    """An error event carrying the request block the SDK would have built."""
    return {"level": "error", "request": _get_request_data(_asgi_scope(headers))}


REALISTIC_HEADERS = {
    "host": "api.oyechats.com",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    "referer": "https://customer.example.com/pricing",
    "content-type": "application/json",
    "x-bot-key": "bot-6a427d4529b9",
    "cf-ipcountry": "IN",
    # What Cloudflare + nginx actually deliver: the edge address in the header
    # the SDK scrubs, the visitor in the one it does not.
    "x-forwarded-for": "172.71.150.11",
    "cf-connecting-ip": IPV4,
    "x-operator-key": "op-secret-0000-1111",
}


class TestSdkGapIsReal:
    """The premise of the whole module. If these ever fail, the SDK closed the
    gap on its own and ``sentry_scrub`` can be pruned — that is a good failure,
    not a flaky one."""

    def test_sdk_scrubs_the_header_nginx_already_emptied(self):
        assert "X_FORWARDED_FOR" in SENSITIVE_HEADERS
        assert "X_REAL_IP" in SENSITIVE_HEADERS

    def test_sdk_does_not_scrub_the_header_that_holds_the_visitor(self):
        """Run the SDK's real request-data builder and show the address survives."""
        request = _get_request_data(_asgi_scope(REALISTIC_HEADERS))
        assert request["headers"]["cf-connecting-ip"] == IPV4

    def test_our_list_adds_only_what_the_sdk_misses(self):
        """Keeps the list honest: nothing in it duplicates the SDK's own work."""
        for header in VISITOR_IP_HEADERS | CREDENTIAL_HEADERS:
            assert header.upper().replace("-", "_") not in SENSITIVE_HEADERS, (
                f"{header} is scrubbed by the SDK already — drop it from sentry_scrub"
            )


class TestVisitorIpHeaders:
    def test_cf_connecting_ip_is_gone_from_a_real_sdk_request_block(self):
        event = scrub_event(_event_from(REALISTIC_HEADERS))
        headers = event["request"]["headers"]
        assert "cf-connecting-ip" not in headers
        assert IPV4 not in str(event)

    def test_dropped_not_replaced_with_a_marker(self):
        """The Langfuse call in d041a7a: a field whose only value is a constant
        is not a diagnostic. No key, no placeholder, no annotated stand-in."""
        event = scrub_event(_event_from({"cf-connecting-ip": IPV4}))
        assert event["request"]["headers"] == {}

    @pytest.mark.parametrize("header", sorted(VISITOR_IP_HEADERS))
    def test_every_listed_ip_header_is_stripped(self, header):
        event = scrub_event(_event_from({header: IPV4}))
        assert event["request"]["headers"] == {}

    def test_ipv6_address_goes_too(self):
        event = scrub_event(_event_from({"cf-connecting-ip": IPV6}))
        assert IPV6 not in str(event)

    def test_matching_is_case_insensitive(self):
        """ASGI lower-cases header names; a non-conforming server must not be
        able to slip one through on casing alone."""
        event = {"request": {"headers": {"CF-Connecting-IP": IPV4, "True-Client-IP": IPV4}}}
        assert scrub_event(event)["request"]["headers"] == {}

    def test_debuggable_context_survives(self):
        """Stripping an address is the goal; gutting the request block so nobody
        can debug a 500 is not."""
        event = scrub_event(_event_from(REALISTIC_HEADERS))
        request = event["request"]
        headers = request["headers"]
        assert headers["user-agent"].startswith("Mozilla/5.0")
        assert headers["referer"] == "https://customer.example.com/pricing"
        assert headers["host"] == "api.oyechats.com"
        # The bot key is public — it ships in the embed snippet on the
        # customer's own site — and it is how you tell which agent errored.
        assert headers["x-bot-key"] == "bot-6a427d4529b9"
        # Country is not a visitor, and it is the only geography left.
        assert headers["cf-ipcountry"] == "IN"
        assert request["method"] == "POST"
        assert request["url"] == "https://api.oyechats.com/chat"


class TestCredentialHeaders:
    @pytest.mark.parametrize("header", sorted(CREDENTIAL_HEADERS))
    def test_operator_credentials_are_stripped(self, header):
        event = scrub_event(_event_from({header: "op-secret-0000-1111"}))
        assert "op-secret-0000-1111" not in str(event)


class TestHookNeverBreaksErrorReporting:
    """A ``before_send`` that raises makes the SDK discard the event. Losing the
    error is not an acceptable outcome of a scrubbing bug."""

    @pytest.mark.parametrize(
        "event",
        [
            {},
            {"request": None},
            {"request": {}},
            {"request": {"headers": None}},
            {"request": {"headers": "trimmed-for-size"}},
            {"level": "error", "message": "no request block at all"},
        ],
    )
    def test_tolerates_odd_shapes(self, event):
        assert scrub_event(event) is event

    def test_non_dict_event_passes_through(self):
        assert scrub_event(None) is None

    def test_hint_is_accepted_positionally(self):
        """Sentry calls the hook as ``before_send(event, hint)``."""
        event = _event_from({"cf-connecting-ip": IPV4})
        assert scrub_event(event, {"exc_info": None})["request"]["headers"] == {}

    def test_fails_closed_on_an_internal_error(self, monkeypatch):
        """If the scrub itself breaks, the request block goes rather than going
        out unscrubbed — but the event, with its stack trace, still ships."""

        def _boom(_event):
            raise RuntimeError("scrub is broken")

        monkeypatch.setattr(scrub, "_strip_request_headers", _boom)
        event = scrub.scrub_event({"level": "error", "request": {"headers": {"cf-connecting-ip": IPV4}}})
        assert "request" not in event
        assert event["level"] == "error"


class TestInitWiring:
    """Without this the header list is dead code: nothing else fails if someone
    deletes ``before_send=`` from an ``init`` call."""

    @staticmethod
    def _capture_init(monkeypatch):
        captured: dict = {}
        monkeypatch.setattr(sentry_sdk, "init", lambda **kwargs: captured.update(kwargs))
        monkeypatch.setattr(sentry_sdk, "set_tag", lambda *_a, **_k: None)
        monkeypatch.setattr("app.config.SENTRY_ENABLED", True)
        monkeypatch.setattr("app.config.SENTRY_DSN", DSN)
        monkeypatch.setattr("app.config.APP_ENV", "production")
        return captured

    def test_api_wires_both_hooks(self, monkeypatch):
        import app.main

        captured = self._capture_init(monkeypatch)
        app.main._init_sentry_for_api()
        assert captured["before_send"] is scrub_event
        # Transactions do NOT go through before_send, and they carry the same
        # request block — at traces_sample_rate=0.1, one chat request in ten.
        assert captured["before_send_transaction"] is scrub_event
        assert captured["send_default_pii"] is False

    def test_worker_wires_both_hooks(self, monkeypatch):
        import app.worker.settings as worker_settings

        captured = self._capture_init(monkeypatch)
        worker_settings._init_sentry_for_worker()
        assert captured["before_send"] is scrub_event
        assert captured["before_send_transaction"] is scrub_event
        assert captured["send_default_pii"] is False


class TestNoAddressInLogRecords:
    """LoggingIntegration turns WARNING records into breadcrumbs and ERROR
    records into events. Anything interpolated into one of these messages is a
    Sentry payload, and the message is the one field no scrubber gets to see."""

    def test_ip_intel_vendor_failure_does_not_log_the_address(self, monkeypatch, caplog):
        from app.services import ip_intel_service

        monkeypatch.setenv("IPAPI_IS_KEY", "vendor-key-should-not-appear")

        def _boom(*_a, **_k):
            raise OSError("connection reset by peer")

        monkeypatch.setattr(ip_intel_service.urllib.request, "urlopen", _boom)
        with caplog.at_level(logging.WARNING):
            assert ip_intel_service.fetch_ip_intel(IPV4) is None

        assert caplog.text, "the failure must still be reported"
        assert IPV4 not in caplog.text
        assert "vendor-key-should-not-appear" not in caplog.text

    def test_ip_intel_vendor_error_payload_does_not_log_the_address(self, monkeypatch, caplog):
        from app.services import ip_intel_service

        monkeypatch.setenv("IPAPI_IS_KEY", "vendor-key-should-not-appear")
        monkeypatch.setattr(
            ip_intel_service.urllib.request,
            "urlopen",
            lambda *_a, **_k: _JsonResponse({"error": "quota exceeded"}),
        )
        with caplog.at_level(logging.WARNING):
            assert ip_intel_service.fetch_ip_intel(IPV4) is None

        assert "quota exceeded" in caplog.text, "the vendor's reason must still be reported"
        assert IPV4 not in caplog.text

    def test_geolocation_vendor_failures_do_not_log_the_address(self, monkeypatch, caplog):
        """Both free geo vendors down. Four WARNING records, no address in any."""
        from app.api import chat_routes

        monkeypatch.setattr(chat_routes, "_already_resolved", lambda *_a: (True, False))

        def _boom(*_a, **_k):
            raise OSError("connection reset by peer")

        monkeypatch.setattr(chat_routes.urllib.request, "urlopen", _boom)
        with caplog.at_level(logging.WARNING):
            chat_routes._resolve_and_update_location("sess-abc", PUBLIC_IPV4, None)

        assert "ipwho.is failed" in caplog.text
        assert "ipapi.co also failed" in caplog.text
        assert "sess-abc" in caplog.text, "the session is what makes the line diagnosable"
        assert PUBLIC_IPV4 not in caplog.text

    def test_resolved_location_is_logged_as_geography_and_still_stored_whole(self, monkeypatch, caplog):
        """The one site where redaction beats dropping: ``format_visitor_location``
        leaves a real city behind, so the line still says what the vendor
        resolved. And the DB column keeps the address — this task changes what
        is transmitted, never what is stored."""
        from app.api import chat_routes

        row = SimpleNamespace(location=f"IP: {PUBLIC_IPV4}")

        class _Query:
            def query(self, _model):
                return self

            def filter(self, *_a):
                return self

            def first(self):
                return row

            def commit(self):
                return None

        @contextmanager
        def _fake_session():
            yield _Query()

        monkeypatch.setattr(chat_routes, "_already_resolved", lambda *_a: (True, False))
        monkeypatch.setattr(chat_routes, "get_session", _fake_session)
        monkeypatch.setattr(
            chat_routes.urllib.request,
            "urlopen",
            lambda *_a, **_k: _JsonResponse({"success": True, "city": "Mumbai", "country": "India"}),
        )

        with caplog.at_level(logging.INFO):
            chat_routes._resolve_and_update_location("sess-xyz", PUBLIC_IPV4, None)

        assert row.location == f"Mumbai, India | {PUBLIC_IPV4}", "storage is unchanged — address and all"
        assert "Background geolocation resolved" in caplog.text
        assert "Mumbai, India" in caplog.text
        assert PUBLIC_IPV4 not in caplog.text


class TestNoEmailInSentryTags:
    def test_recipient_tag_is_redacted(self):
        from app.services.email_service import _email_failure_tags

        tags = _email_failure_tags({"event": "chat_followup", "email": VISITOR_EMAIL})
        assert tags["email.email"] == "p***@example.com"
        assert VISITOR_EMAIL not in str(tags)

    def test_to_tag_is_redacted(self):
        from app.services.email_service import _email_failure_tags

        tags = _email_failure_tags({"kind": "raw", "to": VISITOR_EMAIL})
        assert tags["email.to"] == "p***@example.com"

    def test_address_quoted_back_inside_a_vendor_error_is_redacted(self):
        """Brevo echoes the offending recipient in its error bodies, and that
        body rides along as the ``reason`` tag."""
        from app.services.email_service import _email_failure_tags

        reason = f'HTTP 400 brevo_code=invalid_parameter message=Invalid recipient "{VISITOR_EMAIL}"'
        tags = _email_failure_tags({"reason": reason})
        assert VISITOR_EMAIL not in tags["email.reason"]
        assert "p***@example.com" in tags["email.reason"]
        # Still diagnosable: the reason itself survives.
        assert "invalid_parameter" in tags["email.reason"]

    def test_non_email_tags_are_untouched(self):
        from app.services.email_service import _email_failure_tags

        tags = _email_failure_tags({"event": "trial_ended", "days_remaining": 3, "template_id": 17})
        assert tags == {
            "email.event": "trial_ended",
            "email.days_remaining": "3",
            "email.template_id": "17",
        }


class TestBackgroundTasksDoNotShareASentryScope:
    """Three pool threads serve every caller of ``submit_background``, and
    Sentry's ThreadingIntegration forks the scope once per *thread*, not per
    task. So every task submitted after a pool thread was created shared one
    isolation scope with every other task that thread ever ran — and a
    breadcrumb left by one visitor's geolocation lookup attached itself to the
    next error an unrelated task raised there. ``webhook_service`` dispatches
    into this same pool, and its deliveries do report errors to Sentry.

    Scope *identity* is the invariant, not breadcrumb content: breadcrumbs are
    dropped when no Sentry client is bound, which is every test run, so
    asserting on them here would pass whether or not the fork exists.
    """

    TASKS = 5  # > the pool's 3 workers, so thread reuse is guaranteed, not likely

    def test_each_task_gets_its_own_isolation_scope(self):
        from app.core.thread_pool import _pool, submit_background

        assert _pool._max_workers < self.TASKS, "the pigeonhole below depends on this"

        scopes = []  # holds references, so no id() can be recycled between tasks
        threads = []

        def record(finished: threading.Event):
            scopes.append(sentry_sdk.get_isolation_scope())
            threads.append(threading.current_thread().name)
            finished.set()

        # Strictly sequential: each task must finish before the next is queued,
        # or the pool spreads them across workers and never reuses a thread.
        for _ in range(self.TASKS):
            finished = threading.Event()
            submit_background(record, finished)
            assert finished.wait(timeout=10), "background task never ran"

        assert len(scopes) == self.TASKS
        assert len(set(threads)) < self.TASKS, "no thread was reused — the test proves nothing"
        assert len({id(scope) for scope in scopes}) == self.TASKS, (
            "two tasks shared an isolation scope — the per-task fork in core.thread_pool.submit_background is gone"
        )
