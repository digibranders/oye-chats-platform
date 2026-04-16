"""Tests for meeting booking URL validation and provider resolution."""

from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from app.api.bot_routes import UpdateBotRequest
from app.services.rag_service import _resolve_meeting_booking


class TestMeetingUrlValidation:
    def test_valid_calendly_url(self):
        req = UpdateBotRequest(calendly_url="https://calendly.com/user/30min")
        assert req.calendly_url == "https://calendly.com/user/30min"

    def test_valid_zcal_url(self):
        req = UpdateBotRequest(zcal_url="https://zcal.co/user/30min")
        assert req.zcal_url == "https://zcal.co/user/30min"

    def test_rejects_http_calendly(self):
        with pytest.raises(ValidationError):
            UpdateBotRequest(calendly_url="http://calendly.com/user/30min")

    def test_rejects_wrong_domain_calendly(self):
        with pytest.raises(ValidationError):
            UpdateBotRequest(calendly_url="https://evil.com/calendly.com/user")

    def test_rejects_http_zcal(self):
        with pytest.raises(ValidationError):
            UpdateBotRequest(zcal_url="http://zcal.co/user/30min")

    def test_rejects_wrong_domain_zcal(self):
        with pytest.raises(ValidationError):
            UpdateBotRequest(zcal_url="https://evil.com/zcal.co/user")

    def test_accepts_subdomain_calendly(self):
        req = UpdateBotRequest(calendly_url="https://d.calendly.com/user")
        assert req.calendly_url is not None

    def test_accepts_subdomain_zcal(self):
        req = UpdateBotRequest(zcal_url="https://app.zcal.co/user")
        assert req.zcal_url is not None

    def test_null_urls_accepted(self):
        req = UpdateBotRequest(calendly_url=None, zcal_url=None)
        assert req.calendly_url is None
        assert req.zcal_url is None

    def test_valid_provider_values(self):
        req = UpdateBotRequest(meeting_provider="calendly")
        assert req.meeting_provider == "calendly"
        req2 = UpdateBotRequest(meeting_provider="zcal")
        assert req2.meeting_provider == "zcal"

    def test_invalid_provider_rejected(self):
        with pytest.raises(ValidationError):
            UpdateBotRequest(meeting_provider="zoom")


class TestResolveMeetingBooking:
    def _make_bot(
        self,
        enabled=True,
        provider="calendly",
        calendly_url="https://calendly.com/u",
        zcal_url=None,
    ):
        bot = MagicMock()
        bot.meeting_booking_enabled = enabled
        bot.meeting_provider = provider
        bot.calendly_url = calendly_url
        bot.zcal_url = zcal_url
        return bot

    def test_disabled_returns_empty(self):
        bot = self._make_bot(enabled=False)
        assert _resolve_meeting_booking(bot, MagicMock(), "s1", 1) == {}

    def test_no_bot_returns_empty(self):
        assert _resolve_meeting_booking(None, MagicMock(), "s1", 1) == {}

    def test_calendly_provider_returns_calendly_url(self):
        bot = self._make_bot(provider="calendly", calendly_url="https://calendly.com/u")
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = None
        result = _resolve_meeting_booking(bot, session, "s1", 1)
        assert result["show_booking"] is True
        assert result["calendly_url"] == "https://calendly.com/u"
        assert result["meeting_provider"] == "calendly"

    def test_zcal_provider_returns_zcal_url(self):
        bot = self._make_bot(provider="zcal", zcal_url="https://zcal.co/u")
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = None
        result = _resolve_meeting_booking(bot, session, "s1", 1)
        assert result["calendly_url"] == "https://zcal.co/u"
        assert result["meeting_provider"] == "zcal"

    def test_existing_booking_returns_empty(self):
        bot = self._make_bot()
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = MagicMock()
        assert _resolve_meeting_booking(bot, session, "s1", 1) == {}

    def test_no_url_returns_empty(self):
        bot = self._make_bot(calendly_url=None)
        assert _resolve_meeting_booking(bot, MagicMock(), "s1", 1) == {}
