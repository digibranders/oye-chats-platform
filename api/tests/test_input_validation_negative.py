"""Negative tests for the request-boundary validation layer.

Every case here is an input the server must REFUSE. They are grouped by the
bypass class they exercise rather than by endpoint, because the same class of
malformed input reaches many endpoints through the same shared types — a
regression in ``app.schemas.validators`` shows up as a whole group failing,
which points at the cause faster than one red test per route would.

Two properties these tests are deliberately checking for, beyond "it 4xx'd":

* **Rejection, not silent repair.** Several of these values would previously
  have been trimmed, truncated or coerced into something storable. A 422 is
  the pass condition; a 200 with a mangled value is a failure even though the
  endpoint "handled" it.
* **The refusal happens at the boundary.** Where a handler also re-checks a
  value, the test asserts the request never reached the code that would have
  used it — see ``TestFileUploadMetadata`` and the WebSocket frame tests.
"""

import json

import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError

from app.api.auth import get_current_bot
from app.api.bot_routes import UpdateBotRequest
from app.api.chat_routes import (
    BehavioralSignalsRequest,
    LeadCaptureRequest,
    MeetingBookedRequest,
    UploadUrlRequest,
)
from app.api.chat_routes import router as chat_router
from app.core.middleware import validation_exception_handler
from app.schemas.chat import ChatRequest
from app.schemas.validators import (
    BoundedJsonObject,
    DurationSeconds,
    EmailAddress,
    HexColor,
    HttpUrlStr,
    PublicHttpUrl,
    SessionId,
    check_json_object,
)
from app.schemas.ws import OPERATOR_FRAMES, VISITOR_FRAMES, parse_frame


def _rejects(model: type[BaseModel], **kwargs) -> bool:
    """True when *model* refuses ``kwargs``."""
    try:
        model(**kwargs)
    except ValidationError:
        return True
    return False


# ── Shared annotated types ───────────────────────────────────────────────────


class _Probe(BaseModel):
    """Single-field harness so each shared type can be exercised in isolation."""

    session_id: SessionId | None = None
    email: EmailAddress | None = None
    url: HttpUrlStr | None = None
    public_url: PublicHttpUrl | None = None
    color: HexColor | None = None
    seconds: DurationSeconds | None = None
    blob: BoundedJsonObject | None = None


class TestIdentifierType:
    @pytest.mark.parametrize(
        "value",
        [
            "a" * 129,  # over the ceiling
            "../../etc/passwd",  # path traversal
            "sess/../other",  # separator
            "sess id",  # whitespace
            "sess\nid",  # CRLF — log injection / header smuggling shape
            "sess\x00id",  # NUL
            "señor",  # non-ASCII
            "",  # empty
        ],
    )
    def test_rejects_malformed_identifier(self, value):
        assert _rejects(_Probe, session_id=value)

    @pytest.mark.parametrize(
        "value",
        [
            "550e8400-e29b-41d4-a716-446655440000",  # bare uuid4
            "session_550e8400-e29b-41d4-a716-446655440000",  # widget's ChatWindow form
            "sess-lq3k2j-a8f2h1x9",  # widget's crypto-less fallback form
        ],
    )
    def test_accepts_every_format_the_platform_mints(self, value):
        assert _Probe(session_id=value).session_id == value

    def test_type_confusion_object_where_string_expected(self):
        # The classic NoSQL-operator-injection shape. Pydantic refuses it, but
        # the point is that the refusal happens before any lookup runs.
        assert _rejects(_Probe, session_id={"$ne": None})

    def test_type_confusion_array_where_scalar_expected(self):
        assert _rejects(_Probe, session_id=["a", "b"])

    def test_type_confusion_int_where_string_expected(self):
        assert _rejects(_Probe, session_id=12345)


class TestEmailType:
    @pytest.mark.parametrize(
        "value",
        [
            "not-an-email",
            "@example.com",
            "a@",
            "a@b",  # no TLD
            "a@b.c",  # single-char TLD
            "a" * 250 + "@example.com",  # over RFC 5321's 254
            "user@example.com\nBcc: victim@example.com",  # header injection
            "user name@example.com",  # space
            "",
        ],
    )
    def test_rejects_malformed_email(self, value):
        assert _rejects(_Probe, email=value)

    def test_normalises_case_and_surrounding_space(self):
        # Canonicalisation of the same address — not a rewrite into a
        # different one, which is the line this module draws.
        assert _Probe(email="  User@Example.COM  ").email == "user@example.com"

    def test_rejects_object_and_array(self):
        assert _rejects(_Probe, email={"$gt": ""})
        assert _rejects(_Probe, email=["a@b.com"])


class TestUrlTypes:
    @pytest.mark.parametrize(
        "value",
        [
            "javascript:alert(1)",
            "JaVaScRiPt:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "//evil.com/path",  # protocol-relative
            "http://",  # no host
            "https://" + "a" * 3000,  # over the ceiling
            "",
        ],
    )
    def test_rejects_non_http_or_malformed_url(self, value):
        assert _rejects(_Probe, url=value)

    @pytest.mark.parametrize(
        "value",
        [
            "http://127.0.0.1/admin",
            "http://169.254.169.254/latest/meta-data/",  # cloud metadata
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://[::1]/",
        ],
    )
    def test_public_url_rejects_internal_addresses(self, value):
        assert _rejects(_Probe, public_url=value)

    def test_public_url_accepts_a_real_host(self):
        assert _Probe(public_url="https://example.com/x").public_url == "https://example.com/x"


class TestHexColorType:
    @pytest.mark.parametrize(
        "value",
        [
            "red",  # named colour — not the documented format
            "rgb(255,0,0)",
            "#2563EB; background: url(//evil)",  # CSS declaration injection shape
            "#12345",  # wrong digit count
            "#GGGGGG",  # non-hex
            "expression(alert(1))",
        ],
    )
    def test_rejects_non_hex_colour(self, value):
        assert _rejects(_Probe, color=value)

    @pytest.mark.parametrize("value", ["#fff", "#2563EB", "#2563EBFF"])
    def test_accepts_hex_forms(self, value):
        assert _Probe(color=value).color == value


class TestNumericBounds:
    @pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
    def test_rejects_non_finite_floats(self, value):
        # ``json.loads`` accepts NaN / Infinity literals, so these really do
        # arrive over the wire — a NaN in a double column breaks every
        # consumer that later serialises the row back to JSON.
        assert _rejects(_Probe, seconds=value)

    def test_rejects_non_finite_from_a_raw_json_body(self):
        # Proves the literal survives decoding and is caught by the schema,
        # not by the JSON parser.
        decoded = json.loads('{"seconds": NaN}')
        assert decoded["seconds"] != decoded["seconds"]  # it really is NaN
        assert _rejects(_Probe, **decoded)

    def test_rejects_negative_and_absurd_durations(self):
        assert _rejects(_Probe, seconds=-1)
        assert _rejects(_Probe, seconds=10**12)


class TestBoundedJsonObject:
    def test_rejects_too_many_keys(self):
        assert _rejects(_Probe, blob={str(i): 1 for i in range(500)})

    def test_rejects_excessive_nesting(self):
        deep: dict = {"leaf": 1}
        for _ in range(20):
            deep = {"nested": deep}
        assert _rejects(_Probe, blob=deep)

    def test_rejects_oversized_payload(self):
        assert _rejects(_Probe, blob={"pad": "x" * (128 * 1024)})

    def test_rejects_array_where_object_expected(self):
        assert _rejects(_Probe, blob=[1, 2, 3])

    def test_rejects_non_finite_number_nested_inside(self):
        assert _rejects(_Probe, blob={"a": {"b": float("inf")}})

    def test_rejects_oversized_key(self):
        assert _rejects(_Probe, blob={"k" * 500: 1})

    def test_accepts_an_ordinary_config_object(self):
        value = {"show_branding": True, "nested": {"a": 1}}
        assert _Probe(blob=value).blob == value

    def test_check_json_object_reports_the_field_name(self):
        with pytest.raises(ValueError, match="widget_config"):
            check_json_object([1, 2], field="widget_config")


# ── Widget-facing request bodies ─────────────────────────────────────────────


class TestChatRequestBody:
    def test_rejects_empty_question(self):
        assert _rejects(ChatRequest, question="")

    def test_rejects_oversized_question(self):
        assert _rejects(ChatRequest, question="x" * 5001)

    def test_rejects_missing_required_question(self):
        assert _rejects(ChatRequest, session_id="abc")

    def test_rejects_null_question(self):
        assert _rejects(ChatRequest, question=None)

    def test_rejects_hostile_session_id(self):
        assert _rejects(ChatRequest, question="hi", session_id="../../../etc/passwd")


class TestLeadCaptureBody:
    def test_rejects_invalid_email(self):
        assert _rejects(LeadCaptureRequest, session_id="s-1", email="nope")

    def test_rejects_oversized_name(self):
        assert _rejects(LeadCaptureRequest, session_id="s-1", name="n" * 5000)

    def test_rejects_object_for_a_string_field(self):
        assert _rejects(LeadCaptureRequest, session_id="s-1", company={"a": 1})

    def test_accepts_a_normal_submission(self):
        body = LeadCaptureRequest(session_id="s-1", name=" Ada ", email="ADA@Example.com")
        assert body.name == "Ada"
        assert body.email == "ada@example.com"


class TestBehavioralSignalsBody:
    def test_rejects_javascript_page_url(self):
        assert _rejects(BehavioralSignalsRequest, session_id="s-1", page_url="javascript:alert(1)")

    def test_rejects_javascript_referrer(self):
        assert _rejects(BehavioralSignalsRequest, session_id="s-1", referrer="javascript:alert(1)")

    def test_rejects_infinite_time_on_page(self):
        assert _rejects(BehavioralSignalsRequest, session_id="s-1", time_on_page=float("inf"))

    def test_rejects_negative_pages_viewed(self):
        assert _rejects(BehavioralSignalsRequest, session_id="s-1", pages_viewed=-5)

    def test_rejects_unbounded_journey_array(self):
        # The sanitiser would have kept the first 200 and discarded the rest —
        # after iterating all of them. Refusing up front is the difference
        # between a 422 and a 100k-iteration loop per request.
        assert _rejects(
            BehavioralSignalsRequest,
            session_id="s-1",
            journey=[{"path": "/x"}] * 100_000,
        )

    def test_rejects_oversized_utm_params(self):
        assert _rejects(
            BehavioralSignalsRequest,
            session_id="s-1",
            utm_params={f"k{i}": "v" for i in range(200)},
        )

    def test_rejects_deeply_nested_utm_params(self):
        assert _rejects(
            BehavioralSignalsRequest,
            session_id="s-1",
            utm_params={"a": {"b": {"c": {"d": 1}}}},
        )


class TestMeetingBookedBody:
    def test_rejects_javascript_booking_url(self):
        assert _rejects(MeetingBookedRequest, session_id="s-1", booking_url="javascript:alert(1)")

    def test_rejects_unparseable_meeting_time(self):
        # Previously swallowed by ``contextlib.suppress`` and stored as a
        # booking with no time on it.
        assert _rejects(MeetingBookedRequest, session_id="s-1", meeting_time="tomorrow-ish")

    def test_rejects_invalid_attendee_email(self):
        assert _rejects(MeetingBookedRequest, session_id="s-1", attendee_email="nope")

    def test_accepts_iso8601(self):
        body = MeetingBookedRequest(session_id="s-1", meeting_time="2026-09-01T10:00:00+00:00")
        assert body.meeting_time is not None


class TestFileUploadMetadata:
    def test_rejects_negative_declared_size(self):
        # The handler's only guard was ``> _MAX_SIZE_BYTES``, which -1 passes.
        assert _rejects(
            UploadUrlRequest,
            filename="a.png",
            content_type="image/png",
            size=-1,
            session_id="s-1",
        )

    def test_rejects_zero_size(self):
        assert _rejects(
            UploadUrlRequest,
            filename="a.png",
            content_type="image/png",
            size=0,
            session_id="s-1",
        )

    def test_rejects_oversized_filename(self):
        assert _rejects(
            UploadUrlRequest,
            filename="a" * 5000 + ".png",
            content_type="image/png",
            size=100,
            session_id="s-1",
        )

    def test_object_key_extension_is_allow_listed(self):
        from app.services.r2_service import safe_object_extension

        assert safe_object_extension("report.pdf") == "pdf"
        # Separators and traversal in the name cannot reach the object key.
        assert safe_object_extension("a.b/../../etc/passwd") == "bin"
        assert safe_object_extension("x." + "y" * 500) == "bin"
        assert safe_object_extension("no-extension") == "bin"
        assert safe_object_extension(None) == "bin"


class TestUploadFilenameGate:
    @pytest.mark.parametrize(
        "value",
        [
            "../../etc/passwd",
            "/etc/passwd",
            "..",
            ".",
            "a\x00.pdf",
            " leading-space.pdf",
            "trailing-space.pdf ",
            "sub/dir/file.pdf",
            "",
            None,
        ],
    )
    def test_rejects_unsafe_upload_filenames(self, value):
        from app.api.document_routes import _safe_upload_filename

        assert _safe_upload_filename(value) is None

    @pytest.mark.parametrize("value", ["report.pdf", "Q3 Results (final).docx", "notes_v2.md"])
    def test_accepts_ordinary_filenames(self, value):
        from app.api.document_routes import _safe_upload_filename

        assert _safe_upload_filename(value) == value


# ── Agent configuration ──────────────────────────────────────────────────────


class TestBotConfigValidation:
    def test_rejects_css_injection_in_colour(self):
        assert _rejects(UpdateBotRequest, primary_color="#fff; background: url(//evil)")

    def test_rejects_unknown_business_hours_day(self):
        # ``monday`` would have stored cleanly and then been ignored by the
        # availability evaluator, leaving the agent offline all Monday with a
        # schedule on screen saying otherwise.
        assert _rejects(UpdateBotRequest, business_hours={"monday": {"start": "09:00", "end": "17:00"}})

    def test_rejects_out_of_range_business_hours(self):
        assert _rejects(UpdateBotRequest, business_hours={"mon": {"start": "25:00", "end": "17:00"}})
        assert _rejects(UpdateBotRequest, business_hours={"mon": {"start": "9:00", "end": "17:00"}})

    def test_rejects_unknown_timezone(self):
        # The evaluator fails OPEN on an unloadable zone, so a typo here is a
        # silent availability change.
        assert _rejects(UpdateBotRequest, business_hours={"timezone": "Mars/Olympus"})

    def test_accepts_a_valid_schedule(self):
        body = UpdateBotRequest(business_hours={"mon": {"start": "09:00", "end": "17:00"}, "timezone": "Asia/Kolkata"})
        assert body.business_hours is not None
        assert body.model_dump(exclude_unset=True)["business_hours"]["mon"]["start"] == "09:00"

    def test_rejects_invalid_notification_recipient(self):
        assert _rejects(UpdateBotRequest, notification_emails={"default": ["not-an-email"]})

    def test_rejects_unknown_notification_bucket(self):
        assert _rejects(UpdateBotRequest, notification_emails={"sms_alerts": ["a@b.com"]})

    def test_rejects_unbounded_recipient_list(self):
        assert _rejects(
            UpdateBotRequest,
            notification_emails={"default": [f"u{i}@example.com" for i in range(500)]},
        )

    def test_rejects_unknown_avatar_type(self):
        assert _rejects(UpdateBotRequest, avatar_type="iframe")

    def test_rejects_unknown_qualification_framework(self):
        assert _rejects(UpdateBotRequest, qualification_framework="../../etc")

    def test_rejects_unknown_lead_form_field(self):
        assert _rejects(UpdateBotRequest, lead_form_fields=[{"field": "ssn", "required": True}])

    def test_rejects_javascript_smart_link(self):
        assert _rejects(UpdateBotRequest, answer_links=[{"keyword": "pricing", "url": "javascript:alert(1)"}])

    def test_rejects_oversized_feature_flags(self):
        assert _rejects(UpdateBotRequest, feature_flags={f"flag_{i}": True for i in range(500)})

    def test_rejects_oversized_bant_config(self):
        assert _rejects(UpdateBotRequest, bant_config={"pad": "x" * (256 * 1024)})

    @pytest.mark.parametrize("value", ["../../etc/passwd", "data:text/html,<script>", "/absolute/path", "a//b"])
    def test_rejects_unsafe_logo_reference(self, value):
        assert _rejects(UpdateBotRequest, bot_logo=value)

    @pytest.mark.parametrize("value", ["https://cdn.example.com/logo.png", "logos/abc-123.png", "abc.png"])
    def test_accepts_real_logo_references(self, value):
        assert UpdateBotRequest(bot_logo=value).bot_logo == value

    def test_rejects_out_of_range_handoff_delay(self):
        assert _rejects(UpdateBotRequest, handoff_delay_seconds=-1)
        assert _rejects(UpdateBotRequest, handoff_delay_seconds=10**9)

    def test_rejects_oversized_domain_allowlist(self):
        assert _rejects(UpdateBotRequest, allowed_domains=[f"host{i}.example.com" for i in range(500)])


# ── WebSocket frames ─────────────────────────────────────────────────────────


class TestWebSocketFrameValidation:
    def test_rejects_non_object_frame(self):
        frame, reason = parse_frame([1, 2, 3], VISITOR_FRAMES)
        assert frame is None and "JSON object" in reason

    def test_rejects_frame_without_a_type(self):
        frame, reason = parse_frame({"content": "hi"}, VISITOR_FRAMES)
        assert frame is None and "type" in reason

    def test_rejects_non_string_type(self):
        frame, reason = parse_frame({"type": 7}, VISITOR_FRAMES)
        assert frame is None

    def test_rejects_unknown_frame_type(self):
        frame, reason = parse_frame({"type": "drop_database"}, VISITOR_FRAMES)
        assert frame is None and "Unsupported" in reason

    def test_rejects_type_confused_message_content(self):
        # ``data.get("content", "").strip()`` used to raise AttributeError
        # here, killing the socket mid-conversation.
        frame, reason = parse_frame({"type": "message", "content": 12345}, VISITOR_FRAMES)
        assert frame is None

    def test_rejects_oversized_message_content(self):
        frame, _ = parse_frame({"type": "message", "content": "x" * 20_000}, VISITOR_FRAMES)
        assert frame is None

    def test_rejects_non_integer_read_receipt(self):
        frame, _ = parse_frame({"type": "read_receipt", "last_read_id": {"$gt": 0}}, VISITOR_FRAMES)
        assert frame is None

    def test_offline_form_over_socket_enforces_the_http_contract(self):
        # The socket branch claimed parity with POST /offline-messages but
        # only truncated the address; every field here ends up in a
        # notification email.
        frame, _ = parse_frame(
            {"type": "submit_offline_form", "name": "Ada", "email": "not-an-email", "message": "hi"},
            VISITOR_FRAMES,
        )
        assert frame is None

    def test_offline_form_requires_name_and_message(self):
        assert parse_frame({"type": "submit_offline_form", "email": "a@b.com"}, VISITOR_FRAMES)[0] is None
        assert (
            parse_frame(
                {"type": "submit_offline_form", "name": "Ada", "email": "a@b.com", "message": ""},
                VISITOR_FRAMES,
            )[0]
            is None
        )

    def test_offline_form_caps_the_transcript(self):
        frame, _ = parse_frame(
            {
                "type": "submit_offline_form",
                "name": "Ada",
                "email": "a@b.com",
                "message": "hi",
                "transcript": [{"role": "user", "content": "x"}] * 5_000,
            },
            VISITOR_FRAMES,
        )
        assert frame is None

    def test_accepts_a_well_formed_message(self):
        frame, reason = parse_frame({"type": "message", "content": "hello", "client_msg_id": "c-123"}, VISITOR_FRAMES)
        assert reason is None
        assert frame.content == "hello"

    def test_operator_socket_rejects_visitor_only_frames(self):
        # A visitor-scoped action must not be reachable from the operator
        # socket just because both loops read from the same manager.
        assert parse_frame({"type": "leave_queue"}, OPERATOR_FRAMES)[0] is None
        assert parse_frame({"type": "submit_offline_form"}, OPERATOR_FRAMES)[0] is None

    def test_visitor_socket_rejects_operator_only_frames(self):
        assert parse_frame({"type": "set_availability", "accepting": False}, VISITOR_FRAMES)[0] is None
        assert parse_frame({"type": "close_chat", "session_id": "s-1"}, VISITOR_FRAMES)[0] is None
        assert parse_frame({"type": "heartbeat"}, VISITOR_FRAMES)[0] is None


# ── End-to-end: the boundary rejects before the handler runs ─────────────────


def _widget_client():
    """A TestClient whose bot auth is satisfied, so 422s come from the schema.

    Registers the SAME ``RequestValidationError`` handler ``app.main`` does —
    without it these tests would exercise FastAPI's default handler and miss
    what the deployed one actually returns.
    """
    bot = type(
        "Bot",
        (),
        {"id": 1, "client_id": 1, "bot_key": "bot-test", "name": "T", "is_active": True},
    )()
    app = FastAPI()
    app.include_router(chat_router)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.dependency_overrides[get_current_bot] = lambda: bot
    return TestClient(app, raise_server_exceptions=False)


class TestDirectApiCallsBypassingTheFrontend:
    """The frontend is not a control. These post straight at the API."""

    def test_behavioral_signals_rejects_hostile_payload_without_touching_the_db(self):
        client = _widget_client()
        res = client.post(
            "/chat/behavioral-signals",
            json={
                "session_id": "s-1",
                "page_url": "javascript:alert(document.cookie)",
                "pages_viewed": -1,
            },
        )
        assert res.status_code == 422

    @pytest.mark.parametrize("literal", [b"Infinity", b"-Infinity", b"NaN"])
    def test_behavioral_signals_rejects_a_raw_non_finite_literal(self, literal):
        # Sent as raw bytes: ``json.dumps`` refuses to emit these, but
        # ``json.loads`` — which is what Starlette decodes the body with —
        # accepts all three, so they are reachable from any non-Python client.
        #
        # This must be a clean 422. It used to be a 500: the value reached the
        # global validation-error handler, which echoed it back through
        # ``json.dumps`` and raised "Out of range float values are not JSON
        # compliant" while rendering the error response.
        client = _widget_client()
        res = client.post(
            "/chat/behavioral-signals",
            content=b'{"session_id": "s-1", "time_on_page": ' + literal + b"}",
            headers={"Content-Type": "application/json"},
        )
        assert res.status_code == 422

    def test_a_rejected_oversized_value_is_not_echoed_back_in_full(self):
        # Reflecting the whole rejected value turns every oversized request
        # into an amplified response.
        client = _widget_client()
        payload = "x" * 200_000
        res = client.post("/chat/lead-capture", json={"session_id": "s-1", "name": payload})
        assert res.status_code == 422
        assert len(res.content) < 4096

    def test_meeting_booked_rejects_javascript_url(self):
        client = _widget_client()
        res = client.post(
            "/chat/meeting-booked",
            json={"session_id": "s-1", "booking_url": "javascript:alert(1)"},
        )
        assert res.status_code == 422

    def test_lead_capture_rejects_malformed_email(self):
        client = _widget_client()
        res = client.post("/chat/lead-capture", json={"session_id": "s-1", "email": "nope"})
        assert res.status_code == 422

    def test_path_parameter_with_an_encoded_separator_never_reaches_the_handler(self):
        # The encoded slash is decoded before routing, so this does not match
        # the single-segment route at all. A 404 is the correct refusal; what
        # matters is that no handler sees the traversal string.
        client = _widget_client()
        assert client.get("/chat/lead-info/..%2F..%2Fetc%2Fpasswd").status_code == 404

    def test_oversized_path_parameter_is_refused_by_the_schema(self):
        # Stays within one path segment, so it DOES match the route — and is
        # then rejected by ``SessionId`` rather than becoming a DB lookup.
        client = _widget_client()
        assert client.get("/chat/lead-info/" + "a" * 500).status_code == 422

    def test_path_parameter_with_control_characters_is_refused(self):
        client = _widget_client()
        assert client.get("/chat/lead-info/abc%00def").status_code == 422

    def test_duplicate_query_parameters_do_not_bypass_bounds(self):
        # Starlette resolves a repeated scalar param to one value; whichever
        # it picks still has to satisfy the constraint.
        client = _widget_client()
        res = client.get("/chat/history/s-1?limit=50&limit=99999")
        assert res.status_code == 422

    def test_array_where_scalar_expected_in_query_string(self):
        client = _widget_client()
        res = client.get("/chat/history/s-1?limit=abc")
        assert res.status_code == 422

    def test_missing_required_body_is_refused(self):
        client = _widget_client()
        assert client.post("/chat/lead-capture", json={}).status_code == 422

    def test_null_for_a_required_field_is_refused(self):
        client = _widget_client()
        assert client.post("/chat/lead-capture", json={"session_id": None}).status_code == 422

    def test_malformed_json_body_is_refused(self):
        client = _widget_client()
        res = client.post(
            "/chat/lead-capture",
            content=b"{not json",
            headers={"Content-Type": "application/json"},
        )
        assert res.status_code == 422

    def test_alternate_content_type_does_not_skip_validation(self):
        # A body sent as text/plain must not sidestep the model — it either
        # parses and validates, or it is refused. What it must never do is
        # reach the handler unvalidated.
        client = _widget_client()
        res = client.post(
            "/chat/lead-capture",
            content=json.dumps({"session_id": "s-1", "email": "nope"}),
            headers={"Content-Type": "text/plain"},
        )
        assert res.status_code == 422
