"""Plan gating for real-time email validation (Standard + Professional).

A Free/Starter bot must never fire the paid Reoon call — not just have its
result hidden. Both the real-time widget endpoint and the background
lead-enrichment path are covered.
"""

from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.chat_routes import router


def _bot(bot_id: int = 1):
    return MagicMock(id=bot_id, bot_key="bot-1", client_id=1)


def _build_app(bot):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    return app


class TestValidateEmailEndpointGating:
    def test_skips_reoon_and_returns_valid_when_plan_lacks_feature(self, monkeypatch):
        from app.api import chat_routes

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: False)
        with patch("app.services.reoon_service.verify_email") as mock_verify:
            response = TestClient(_build_app(_bot())).post(
                "/chat/validate-email", json={"email": "junk@disposable-mail.test"}
            )

        assert response.status_code == 200
        assert response.json() == {"valid": True}
        mock_verify.assert_not_called()

    def test_runs_reoon_when_plan_has_feature(self, monkeypatch):
        from app.api import chat_routes

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
        with patch(
            "app.services.reoon_service.verify_email",
            return_value={"is_valid_syntax": True, "is_disposable": True},
        ) as mock_verify:
            response = TestClient(_build_app(_bot())).post(
                "/chat/validate-email", json={"email": "junk@disposable-mail.test"}
            )

        assert response.status_code == 200
        assert response.json()["valid"] is False
        mock_verify.assert_called_once()


class TestBackgroundEnrichmentGating:
    def test_reoon_skipped_for_bot_without_feature(self, monkeypatch):
        from app.api import chat_routes
        from app.db.models import LeadInfo

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: False)

        lead = MagicMock(spec=LeadInfo)
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = lead

        with (
            patch("app.services.email_domain_service.extract_company_domain", return_value="acme.com") as mock_domain,
            patch("app.services.reoon_service.verify_email") as mock_verify,
            patch("app.api.chat_routes.get_session") as mock_get_session,
        ):
            mock_get_session.return_value.__enter__.return_value = session
            chat_routes._enrich_lead_in_background("sess-1", "person@acme.com", bot_id=1)

        mock_domain.assert_called_once()  # free — always runs
        mock_verify.assert_not_called()  # paid — gated

    def test_reoon_runs_for_bot_with_feature(self, monkeypatch):
        from app.api import chat_routes
        from app.db.models import LeadInfo

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)

        lead = MagicMock(spec=LeadInfo)
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = lead

        with (
            patch("app.services.email_domain_service.extract_company_domain", return_value="acme.com"),
            patch(
                "app.services.reoon_service.verify_email",
                return_value={"status": "safe", "is_valid_syntax": True},
            ) as mock_verify,
            patch("app.api.chat_routes.get_session") as mock_get_session,
        ):
            mock_get_session.return_value.__enter__.return_value = session
            chat_routes._enrich_lead_in_background("sess-1", "person@acme.com", bot_id=1)

        mock_verify.assert_called_once()
