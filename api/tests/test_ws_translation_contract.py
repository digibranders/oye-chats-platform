"""Phase 4 WebSocket frame-contract tests.

The socket schemas are the trust boundary between a public widget and the
server, so the important assertions here are about what the server refuses to
accept, not what it accepts.
"""

from app.schemas.ws import (
    OPERATOR_FRAMES,
    VISITOR_FRAMES,
    OperatorMessageFrame,
    VisitorMessageFrame,
    parse_frame,
)


class TestFrameSplit:
    def test_each_socket_has_its_own_message_frame(self):
        # Previously one shared class, so a field added for one socket was
        # silently accepted from the other.
        assert VISITOR_FRAMES["message"] is VisitorMessageFrame
        assert OPERATOR_FRAMES["message"] is OperatorMessageFrame
        assert VISITOR_FRAMES["message"] is not OPERATOR_FRAMES["message"]

    def test_existing_visitor_message_still_parses_unchanged(self):
        frame, reason = parse_frame(
            {"type": "message", "content": "मुझे pricing चाहिए", "client_msg_id": "c-1"},
            VISITOR_FRAMES,
        )
        assert reason is None
        assert frame.content == "मुझे pricing चाहिए"
        assert frame.client_msg_id == "c-1"

    def test_existing_operator_message_still_parses_unchanged(self):
        frame, reason = parse_frame(
            {"type": "message", "content": "Our plan starts at...", "session_id": "sess-1"},
            OPERATOR_FRAMES,
        )
        assert reason is None
        assert frame.session_id == "sess-1"


class TestVisitorLanguageMetadataIsNotTrusted:
    def test_visitor_supplied_language_fields_are_ignored_not_stored(self):
        """A widget may send anything; none of it becomes server state.

        ``_Frame`` ignores unknown keys by design (clients roll forward
        independently of the API), so these do not break the connection. The
        point is that they are not DECLARED, so no handler can ever read them:
        the language for a session comes from ``ChatSession.language_code``,
        resolved server-side in Phase 2.
        """
        frame, reason = parse_frame(
            {
                "type": "message",
                "content": "hello",
                "source_language": "de",
                "source_locale": "de-DE",
                "locale": "de-DE",
                "target_locale": "de-DE",
            },
            VISITOR_FRAMES,
        )
        assert reason is None
        for forbidden in ("source_language", "source_locale", "locale", "target_locale"):
            assert not hasattr(frame, forbidden), f"{forbidden} must not be a declared field"

    def test_no_language_field_is_declared_on_either_socket(self):
        for model in (VisitorMessageFrame, OperatorMessageFrame):
            fields = set(model.model_fields)
            assert fields.isdisjoint({"source_language", "source_locale", "locale", "target_locale"})


class TestRejectionsKeepTheSocketUsable:
    def test_malformed_message_is_refused_with_a_reason(self):
        frame, reason = parse_frame({"type": "message", "content": 123}, VISITOR_FRAMES)
        assert frame is None
        assert reason and "content" in reason

    def test_unknown_frame_type_is_refused(self):
        # `message_translation` is server -> operator only. A client sending it
        # inbound must be refused rather than reaching a handler.
        frame, reason = parse_frame(
            {"type": "message_translation", "message_id": 1, "content": "x"},
            OPERATOR_FRAMES,
        )
        assert frame is None
        assert "Unsupported frame type" in reason

    def test_visitor_cannot_send_a_message_translation_either(self):
        frame, reason = parse_frame({"type": "message_translation", "message_id": 1}, VISITOR_FRAMES)
        assert frame is None
        assert reason is not None
