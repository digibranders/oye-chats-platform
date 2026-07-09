"""Unit tests for ``app.ingestion.event_extractor``.

The extractor is the Tier 2 entry point for the "upcoming events" bug fix:
these tests lock in the keyword filter, the ISO parser's error handling,
and the post-LLM sanitation (past-cutoff, dedup, empty-title guard) so a
regression can't quietly reintroduce PAST rows into the events table.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.ingestion import event_extractor


class TestIsEventsPage:
    def test_url_keyword_matches(self):
        assert event_extractor.is_events_page("https://acme.com/events", None, None) is True
        assert event_extractor.is_events_page("https://acme.com/webinars/live", None, None) is True

    def test_title_keyword_matches(self):
        assert event_extractor.is_events_page(None, "Upcoming Webinars — Acme", None) is True

    def test_body_needs_heading_and_multiple_signal_terms(self):
        # Single body term with no heading — must NOT match.
        text = "Register now for our newsletter."
        assert event_extractor.is_events_page("https://acme.com/blog", None, text) is False

        # Heading + two signal terms — matches.
        text = "## Upcoming Sessions\nRegister now.\nSpeaker: Alice.\nAgenda: 3pm."
        assert event_extractor.is_events_page("https://acme.com/community", None, text) is True

    def test_returns_false_on_all_empty(self):
        assert event_extractor.is_events_page(None, None, None) is False
        assert event_extractor.is_events_page("", "", "") is False


class TestParseIsoDatetime:
    def test_date_only_string_anchors_at_utc_midnight(self):
        parsed = event_extractor._parse_iso_datetime("2026-08-18")
        assert parsed == datetime(2026, 8, 18, tzinfo=UTC)

    def test_datetime_with_offset_normalizes_to_utc(self):
        parsed = event_extractor._parse_iso_datetime("2026-08-18T15:00:00+05:30")
        assert parsed == datetime(2026, 8, 18, 9, 30, tzinfo=UTC)

    def test_naive_datetime_gets_utc_stamped(self):
        parsed = event_extractor._parse_iso_datetime("2026-08-18T15:00:00")
        assert parsed == datetime(2026, 8, 18, 15, 0, tzinfo=UTC)

    @pytest.mark.parametrize("bad", ["", None, "not a date", "March 15 2026", "2026-13-40"])
    def test_unparseable_returns_none(self, bad):
        assert event_extractor._parse_iso_datetime(bad) is None


class TestExtractEvents:
    """The LLM call is mocked — we're testing the response-shaping code around it."""

    def _fake_response(self, payload_json: str):
        message = SimpleNamespace(content=payload_json)
        choice = SimpleNamespace(message=message)
        return SimpleNamespace(choices=[choice])

    def test_returns_empty_on_empty_input_text(self):
        assert event_extractor.extract_events("", source_url="https://acme.com") == []
        assert event_extractor.extract_events("   ", source_url="https://acme.com") == []

    def test_drops_events_without_parseable_date(self):
        payload = (
            '{"events": ['
            '{"title": "Real Event", "starts_at": "2099-01-01", "ends_at": "", "url": "", "location": ""},'
            '{"title": "Bogus Event", "starts_at": "sometime next year", "ends_at": "", "url": "", "location": ""}'
            "]}"
        )
        with patch.object(event_extractor.litellm, "completion", return_value=self._fake_response(payload)):
            out = event_extractor.extract_events("body text", source_url="https://acme.com/events")

        assert len(out) == 1
        assert out[0]["title"] == "Real Event"

    def test_drops_events_older_than_past_horizon(self):
        payload = (
            '{"events": ['
            '{"title": "Ancient Meetup", "starts_at": "2020-01-01", "ends_at": "", "url": "", "location": ""},'
            '{"title": "Recent Meetup", "starts_at": "2099-01-01", "ends_at": "", "url": "", "location": ""}'
            "]}"
        )
        today = date(2026, 7, 9)
        with patch.object(event_extractor.litellm, "completion", return_value=self._fake_response(payload)):
            out = event_extractor.extract_events("body", source_url="https://acme.com/events", today=today)

        titles = [row["title"] for row in out]
        assert "Ancient Meetup" not in titles
        assert "Recent Meetup" in titles

    def test_deduplicates_repeated_titles_on_same_date(self):
        payload = (
            '{"events": ['
            '{"title": "AI Webinar", "starts_at": "2099-08-18", "ends_at": "", "url": "", "location": ""},'
            '{"title": "AI Webinar", "starts_at": "2099-08-18", "ends_at": "", "url": "", "location": ""}'
            "]}"
        )
        with patch.object(event_extractor.litellm, "completion", return_value=self._fake_response(payload)):
            out = event_extractor.extract_events("body", source_url="https://acme.com/events")

        assert len(out) == 1

    def test_llm_error_returns_empty_list_not_exception(self):
        with patch.object(event_extractor.litellm, "completion", side_effect=RuntimeError("boom")):
            out = event_extractor.extract_events("body", source_url="https://acme.com/events")

        assert out == []

    def test_optional_fields_come_through_as_none_when_empty(self):
        payload = '{"events": [{"title": "Solo", "starts_at": "2099-08-18", "ends_at": "", "url": "", "location": ""}]}'
        with patch.object(event_extractor.litellm, "completion", return_value=self._fake_response(payload)):
            out = event_extractor.extract_events("body", source_url="https://acme.com/events")

        assert out[0]["url"] is None
        assert out[0]["location"] is None
        assert out[0]["ends_at"] is None


class TestMaybeExtractEvents:
    def test_short_circuits_when_flag_disabled(self):
        # Even a clearly-event-shaped page returns [] when the flag is off.
        with patch.object(event_extractor.config, "EVENT_EXTRACTION_ENABLED", False):
            out = event_extractor.maybe_extract_events(
                url="https://acme.com/events",
                title="Upcoming Webinars",
                text="Register now. Speaker: Alice. Agenda: 3pm.",
            )
        assert out == []

    def test_short_circuits_when_not_an_events_page(self):
        with patch.object(event_extractor.config, "EVENT_EXTRACTION_ENABLED", True):
            out = event_extractor.maybe_extract_events(
                url="https://acme.com/pricing",
                title="Pricing",
                text="Plans start at $9/month. Valid from March 15, 2026.",
            )
        assert out == []


class TestExtractionModelResolution:
    def test_falls_back_to_primary_on_gate_model_error(self):
        with (
            patch.object(event_extractor.runtime_config, "get_gate_model", side_effect=RuntimeError("no gate")),
            patch.object(event_extractor.runtime_config, "get_primary_model", return_value="openai/gpt-5.4-mini"),
        ):
            assert event_extractor._extraction_model() == "openai/gpt-5.4-mini"


class TestPastHorizonRelativeToToday:
    """Guards the horizon window from silently drifting."""

    def test_horizon_is_180_days(self):
        assert timedelta(days=180) == event_extractor._PAST_HORIZON
