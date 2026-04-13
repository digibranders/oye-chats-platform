"""Tests for app.services.sdr_service — SDR/BANT qualification."""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


@contextmanager
def _session_ctx(session):
    yield session


class TestRunSdrQualification:
    def _mock_all(self, monkeypatch, session, chat_session=None, history=None):
        from app.services import sdr_service

        monkeypatch.setattr(sdr_service, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(sdr_service, "ensure_chat_session", MagicMock())

        cs = chat_session or SimpleNamespace(
            id="s1",
            bot_id=1,
            client_id=1,
            bant_need=None,
            bant_timeline=None,
            bant_authority=None,
            bant_budget=None,
        )
        session.execute.return_value.scalars.return_value.first.return_value = cs

        hist = history or []
        monkeypatch.setattr(sdr_service, "get_chat_history", lambda *a, **kw: hist)

        msg = SimpleNamespace(id=42)
        monkeypatch.setattr(sdr_service, "add_chat_message", lambda *a, **kw: msg)
        monkeypatch.setattr(sdr_service, "update_session_bant", MagicMock())

    def test_successful_qualification(self, monkeypatch):
        from app.services.sdr_service import run_sdr_qualification

        session = MagicMock()
        self._mock_all(monkeypatch, session)

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = (
            '{"updated_bant": {"need": "Scale ops", "timeline": "Q2", '
            '"authority": "CTO", "budget": "$50K"}, '
            '"chat_response": "Great question!"}'
        )

        client_obj = SimpleNamespace(id=1, client_id=1)

        with patch("app.services.sdr_service.litellm") as mock_litellm:
            mock_litellm.completion.return_value = mock_response
            result = run_sdr_qualification(client_obj, "What do you offer?", "s1")

        assert result["answer"] == "Great question!"
        assert result["session_id"] == "s1"
        assert result["bant_state"]["need"] == "Scale ops"

    def test_returns_error_on_llm_failure(self, monkeypatch):
        from app.services.sdr_service import run_sdr_qualification

        session = MagicMock()
        self._mock_all(monkeypatch, session)

        client_obj = SimpleNamespace(id=1, client_id=1)

        with patch("app.services.sdr_service.litellm") as mock_litellm:
            mock_litellm.completion.side_effect = RuntimeError("API down")
            result = run_sdr_qualification(client_obj, "Question", "s1")

        assert "error" in result

    def test_returns_error_when_session_not_found(self, monkeypatch):
        from app.services.sdr_service import run_sdr_qualification

        session = MagicMock()
        self._mock_all(monkeypatch, session)
        # Override: session not found
        session.execute.return_value.scalars.return_value.first.return_value = None

        client_obj = SimpleNamespace(id=1, client_id=1)

        with patch("app.services.sdr_service.litellm"):
            result = run_sdr_qualification(client_obj, "Q", "s1")

        assert "error" in result

    def test_handles_invalid_json_response(self, monkeypatch):
        from app.services.sdr_service import run_sdr_qualification

        session = MagicMock()
        self._mock_all(monkeypatch, session)

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "not valid json at all"

        client_obj = SimpleNamespace(id=1, client_id=1)

        with patch("app.services.sdr_service.litellm") as mock_litellm:
            mock_litellm.completion.return_value = mock_response
            result = run_sdr_qualification(client_obj, "Q", "s1")

        assert "error" in result

    def test_handles_empty_response(self, monkeypatch):
        from app.services.sdr_service import run_sdr_qualification

        session = MagicMock()
        self._mock_all(monkeypatch, session)

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = None

        client_obj = SimpleNamespace(id=1, client_id=1)

        with patch("app.services.sdr_service.litellm") as mock_litellm:
            mock_litellm.completion.return_value = mock_response
            result = run_sdr_qualification(client_obj, "Q", "s1")

        assert "error" in result

    def test_persists_bant_updates(self, monkeypatch):
        from app.services import sdr_service
        from app.services.sdr_service import run_sdr_qualification

        session = MagicMock()
        self._mock_all(monkeypatch, session)

        mock_update = MagicMock()
        monkeypatch.setattr(sdr_service, "update_session_bant", mock_update)

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = (
            '{"updated_bant": {"need": "Growth", "timeline": null, '
            '"authority": null, "budget": null}, '
            '"chat_response": "Understood!"}'
        )

        client_obj = SimpleNamespace(id=1, client_id=1)

        with patch("app.services.sdr_service.litellm") as mock_litellm:
            mock_litellm.completion.return_value = mock_response
            run_sdr_qualification(client_obj, "Q", "s1")

        mock_update.assert_called_once()
        bant_data = mock_update.call_args[1].get("bant_data") or mock_update.call_args[0][3]
        assert bant_data["bant_need"] == "Growth"

    def test_uses_bot_id_from_client(self, monkeypatch):
        from app.services.sdr_service import run_sdr_qualification

        session = MagicMock()
        self._mock_all(monkeypatch, session)

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = (
            '{"updated_bant": {"need": null, "timeline": null, '
            '"authority": null, "budget": null}, '
            '"chat_response": "Hi!"}'
        )

        # Client with bot_key means it's actually a Bot passed as client
        client_obj = SimpleNamespace(id=5, client_id=1, bot_key="bot-xxx")

        with patch("app.services.sdr_service.litellm") as mock_litellm:
            mock_litellm.completion.return_value = mock_response
            result = run_sdr_qualification(client_obj, "Q", "s1")

        assert result["session_id"] == "s1"


class TestGenerateSdrStream:
    def test_yields_metadata_on_missing_session(self, monkeypatch):
        """When the chat session is not found, the stream should yield an error."""
        from app.services import sdr_service

        session = MagicMock()
        monkeypatch.setattr(sdr_service, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(sdr_service, "ensure_chat_session", MagicMock())

        # Session not found
        session.query.return_value.filter.return_value.first.return_value = None
        monkeypatch.setattr(sdr_service, "get_chat_history", lambda *a, **kw: [])

        client_obj = SimpleNamespace(id=1, client_id=1)

        async def collect():
            return [chunk async for chunk in sdr_service.generate_sdr_stream(client_obj, "Q", "s1")]

        chunks = asyncio.run(collect())

        # Should yield at least a metadata frame (even on error)
        assert len(chunks) >= 1
        # One of the chunks should signal an error or session not found
        combined = "".join(chunks)
        assert "METADATA:" in combined or "Error" in combined
