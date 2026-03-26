"""Tests for Pydantic request/response schemas."""

import pytest
from pydantic import ValidationError

from app.schemas.chat import ChatRequest, FeedbackRequest
from app.schemas.client import ClientSettingsUpdate, CrawlRequest


class TestChatRequest:
    def test_valid_request(self):
        req = ChatRequest(question="What is RAG?")
        assert req.question == "What is RAG?"
        assert req.session_id is None

    def test_with_session_id(self):
        req = ChatRequest(question="Hello", session_id="sess-123")
        assert req.session_id == "sess-123"

    def test_empty_question_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest(question="")

    def test_missing_question_rejected(self):
        with pytest.raises(ValidationError):
            ChatRequest()


class TestFeedbackRequest:
    def test_positive_feedback(self):
        req = FeedbackRequest(feedback=1)
        assert req.feedback == 1

    def test_negative_feedback(self):
        req = FeedbackRequest(feedback=-1)
        assert req.feedback == -1

    def test_invalid_feedback_rejected(self):
        with pytest.raises(ValidationError):
            FeedbackRequest(feedback=5)


class TestClientSettingsUpdate:
    def test_partial_update(self):
        req = ClientSettingsUpdate(bot_name="New Bot")
        assert req.bot_name == "New Bot"
        assert req.primary_color is None

    def test_empty_update_allowed(self):
        req = ClientSettingsUpdate()
        assert req.bot_name is None


class TestCrawlRequest:
    def test_valid_url(self):
        req = CrawlRequest(url="https://example.com")
        assert req.url == "https://example.com"

    def test_missing_url_rejected(self):
        with pytest.raises(ValidationError):
            CrawlRequest()
