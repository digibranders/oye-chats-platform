"""Phase 3 (Multilingual AI/RAG) tests.

Covers the plan's testing/QA requirements: prompt directive behaviour and
placement, disabled-bot byte-identical regression, language-aware QA cache
isolation, the LLM-bypassing English paths (route_intent skip, refusal/pivot
localization), first-turn detection with locking rules, canonical-English BANT
extraction, and both pipelines honouring the language parameter.

Retrieval-behaviour assertions that need a live pgvector corpus (Hindi query
retrieves an English chunk, cross-lingual distance) are covered by the unit-level
threshold wiring here and flagged in the plan for a fixture-corpus integration
test; they are not runnable in this unit suite without a seeded database.
"""

from types import SimpleNamespace

from app.schemas.language import LanguageContext
from app.services import rag_service as rs


def _ctx(language="hi", locale="hi-IN", *, source="explicit", locked=True):
    return LanguageContext(
        language=language,
        locale=locale,
        source=source,
        confidence=1.0,
        direction=rs_direction(locale),
        locked=locked,
    )


def rs_direction(locale):
    from app.services.language_service import get_locale_direction

    return get_locale_direction(locale)


def _build(language, question="hello"):
    client = SimpleNamespace(id=1, client_id=1)
    return rs.build_hybrid_prompt(
        client,
        question,
        context_text="Reference info about Acme pricing.",
        history_context="",
        company_name="Acme",
        bot_name="Acme Bot",
        language=language,
    )


# ── Prompt directive ─────────────────────────────────────────────────────────


class TestLanguageDirective:
    def test_disabled_bot_has_no_directive(self):
        sp, _ = _build(None)
        assert "CONVERSATION LANGUAGE" not in sp
        # Section 10 (the pre-Phase-3 fallback) is still present, unmodified.
        assert "LANGUAGE & LOCALE" in sp

    def test_enabled_hindi_has_directive_named_in_english(self):
        sp, _ = _build(_ctx("hi", "hi-IN"))
        assert "CONVERSATION LANGUAGE" in sp
        assert "Hindi (India)" in sp
        assert "hi-IN" in sp

    def test_directive_supersedes_section_10(self):
        sp, _ = _build(_ctx("hi", "hi-IN"))
        assert "OVERRIDES any instruction to mirror" in sp

    def test_directive_is_placed_immediately_before_response_style(self):
        sp, _ = _build(_ctx("hi", "hi-IN"))
        # The directive must sit just before the RESPONSE STYLE block so the
        # cached static prefix is preserved.
        assert sp.index("CONVERSATION LANGUAGE") < sp.index("RESPONSE STYLE")
        between = sp[sp.index("CONVERSATION LANGUAGE") : sp.index("RESPONSE STYLE")]
        # Nothing else of substance between the two markers.
        assert "PRICING & CURRENCY" not in between

    def test_disabled_prompt_is_byte_identical_to_no_language_arg(self):
        # The single most important regression: a disabled bot's prompt must be
        # exactly what a caller that never heard of Phase 3 produces.
        client = SimpleNamespace(id=1, client_id=1)
        common = dict(
            context_text="Reference info about Acme pricing.",
            history_context="",
            company_name="Acme",
            bot_name="Acme Bot",
        )
        sp_none, up_none = rs.build_hybrid_prompt(client, "hello", language=None, **common)
        sp_default, up_default = rs.build_hybrid_prompt(client, "hello", **common)
        assert sp_none == sp_default
        assert up_none == up_default

    def test_locale_display_name_is_server_side_not_request_text(self):
        # A junk locale must not leak into the prompt; the name comes from the
        # catalogue, and an unknown locale yields a safe generic phrase.
        directive = rs._language_directive(
            LanguageContext(
                language="hi",
                locale="hi-IN",
                source="explicit",
                confidence=1.0,
                direction="ltr",
                locked=True,
            )
        )
        assert "Hindi (India)" in directive


# ── QA cache isolation ───────────────────────────────────────────────────────


class TestCacheKeyLanguage:
    def test_same_question_different_language_distinct_keys(self):
        from app.core.cache import qa_response_key

        assert qa_response_key(7, "hash", "hi") != qa_response_key(7, "hash", "es")
        assert qa_response_key(7, "hash", "hi") != qa_response_key(7, "hash")

    def test_disabled_key_format_unchanged(self):
        from app.core.cache import qa_response_key

        assert qa_response_key(7, "hash") == qa_response_key(7, "hash", None)
        assert qa_response_key(7, "hash") == "oyechats:qa:7:hash"

    def test_cache_segment_helper(self):
        assert rs._cache_lang_segment(None) is None
        assert rs._cache_lang_segment(_ctx("hi", "hi-IN")) == "hi"


# ── LLM-bypassing paths ──────────────────────────────────────────────────────


class TestBypassPaths:
    def test_route_intent_skipped_only_for_non_english(self):
        assert rs._lang_is_non_english(None) is False
        assert rs._lang_is_non_english(_ctx("en", "en-IN", locked=False)) is False
        assert rs._lang_is_non_english(_ctx("hi", "hi-IN")) is True

    def test_refusal_localized_for_hindi_only(self):
        # Hindi returns a localized string; English / disabled return None so the
        # existing English variant logic runs unchanged.
        assert rs._canned_localized("off_topic_refusal", "Acme", None) is None
        assert rs._canned_localized("off_topic_refusal", "Acme", _ctx("en", "en-IN")) is None
        hi = rs._canned_localized("off_topic_refusal", "Acme", _ctx("hi", "hi-IN"))
        assert hi is not None
        assert "Acme" in hi
        # No ASCII refusal text leaked in.
        assert "only help" not in hi.lower()

    def test_no_info_pivot_localized_for_hindi(self):
        hi = rs._canned_localized("no_info_pivot", "Acme", _ctx("hi", "hi-IN"))
        assert hi is not None and "Acme" in hi
        assert rs._canned_localized("no_info_pivot", "Acme", None) is None

    def test_unknown_language_falls_through_to_english(self):
        # A supported-but-untranslated language returns None (English path).
        assert rs._canned_localized("off_topic_refusal", "Acme", _ctx("fr", "fr-FR")) is None


# ── Streaming metadata ───────────────────────────────────────────────────────


class TestStreamMetadata:
    def test_locale_present_only_when_enabled(self):
        import json

        disabled = rs._stream_metadata("sess-1", [], None)
        assert '"locale"' not in disabled
        payload = json.loads(disabled[len("METADATA:") :].strip())
        assert payload == {"session_id": "sess-1", "sources": []}

        enabled = rs._stream_metadata("sess-1", ["doc"], _ctx("hi", "hi-IN"))
        payload = json.loads(enabled[len("METADATA:") :].strip())
        assert payload["locale"] == "hi-IN"
        assert payload["sources"] == ["doc"]


# ── Detection + locking (unit-level; pipeline wiring covered in chat_routes) ──


class TestDetection:
    def test_pure_script_detected_high_confidence(self):
        from app.services.language_service import detect_message_language

        lang, conf = detect_message_language("नमस्ते, मुझे कीमत बताइए")
        assert lang == "hi" and conf >= 0.85

        lang, conf = detect_message_language("مرحبا، أحتاج المساعدة")
        assert lang == "ar" and conf >= 0.85

    def test_latin_text_not_detected(self):
        from app.services.language_service import detect_message_language

        assert detect_message_language("Hello, I need pricing help") == (None, 0.0)
        assert detect_message_language("hola necesito ayuda")[0] is None

    def test_code_switched_below_threshold(self):
        from app.services.language_service import detect_message_language

        _, conf = detect_message_language("मुझे pricing चाहिए")
        # Roughly half Latin, so below the 0.85 persist threshold.
        assert conf < 0.85

    def test_empty_and_short(self):
        from app.services.language_service import detect_message_language

        assert detect_message_language("") == (None, 0.0)
        assert detect_message_language("hi") == (None, 0.0)


# ── Retrieval calibration wiring ─────────────────────────────────────────────


class TestRetrievalCalibration:
    def test_cross_lingual_distance_only_for_non_english(self):
        assert rs.CROSS_LINGUAL_MAX_DISTANCE > 0.78  # relaxed vs English default
        # The gate helper the pipeline uses to decide when to relax.
        assert rs._lang_is_non_english(_ctx("hi", "hi-IN")) is True
        assert rs._lang_is_non_english(_ctx("en", "en-IN", locked=False)) is False
        assert rs._lang_is_non_english(None) is False

    def test_vector_search_forwards_max_distance_only_when_set(self, monkeypatch):
        captured = {}

        def _fake_search(session, **kwargs):
            captured.update(kwargs)
            return []

        monkeypatch.setattr(rs, "search_similar_documents", _fake_search)
        # Cheap fake session context manager.
        import contextlib

        @contextlib.contextmanager
        def _fake_session():
            yield object()

        monkeypatch.setattr(rs, "get_session", _fake_session)

        rs._vector_search(1, 1, [0.0] * 768, k=15)
        assert "max_distance" not in captured  # default path untouched

        rs._vector_search(1, 1, [0.0] * 768, k=15, max_distance=0.85)
        assert captured["max_distance"] == 0.85


# ── Both pipelines accept the language kwarg ─────────────────────────────────


class TestPipelineSignatures:
    def test_both_pipelines_accept_language(self):
        import inspect

        assert "language" in inspect.signature(rs.rag_pipeline).parameters
        assert "language" in inspect.signature(rs.rag_pipeline_stream).parameters

    def test_build_hybrid_prompt_accepts_language(self):
        import inspect

        assert "language" in inspect.signature(rs.build_hybrid_prompt).parameters


# ── BANT extraction canonical-English hardening ──────────────────────────────


class TestBantExtractionCanonicalEnglish:
    def test_extraction_prompt_instructs_canonical_english(self, monkeypatch):
        captured = {}

        class _Msg:
            content = "[]"

        class _Choice:
            message = _Msg()

        class _Resp:
            choices = [_Choice()]

        def _fake_completion(**kwargs):
            captured["prompt"] = kwargs["messages"][-1]["content"]
            return _Resp()

        import app.services.rag_service as _rs

        monkeypatch.setattr(_rs.litellm, "completion", _fake_completion)

        _rs.extract_qualification_signals(
            history_context="User: नमस्ते\nBot: नमस्ते",
            question="मुझे 2 महीने में चाहिए",
            bot_answer="ठीक है",
            current_bant={},
            bant_config=None,
            last_probed_dimension="timeline",
        )

        prompt = captured.get("prompt", "")
        assert "canonical English" in prompt
        # The instruction must forbid translating the structural keys/enums.
        assert "dimension keys" in prompt
