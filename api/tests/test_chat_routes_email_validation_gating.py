"""Plan gating for real-time email validation (Standard + Professional).

A Free/Starter bot must never fire the paid Reoon call, not just have its
result hidden. Both the real-time widget endpoint and the background
lead-enrichment path are covered.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.chat_routes import router


@pytest.fixture(autouse=True)
def _no_verdict_cache(monkeypatch):
    """Take the Reoon verdict cache out of the picture for this module.

    These tests assert whether the VENDOR was called; the endpoint caches that
    verdict in a live Redis keyed only on the address, so the first run of
    `test_runs_reoon_when_plan_has_feature_and_agent_opted_in` cached
    "undeliverable" for `junk@disposable-mail.test` and every run for the rest
    of the TTL then read the cache and never reached the mock, a test that
    passed on a clean Redis and failed for hours afterwards. The cache's own
    behaviour is covered in `test_reoon_verdict_cache.py`.
    """
    monkeypatch.setattr("app.core.cache.cache_get", lambda _key: None)
    monkeypatch.setattr("app.core.cache.cache_set", lambda *_a, **_k: True)


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

    def test_runs_reoon_when_plan_has_feature_and_agent_opted_in(self, monkeypatch):
        from app.api import chat_routes

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
        monkeypatch.setattr(chat_routes, "_agent_enrichment_opt_in", lambda *_a, **_k: True)
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

    def test_skips_reoon_when_agent_opted_out(self, monkeypatch):
        """Plan allows it, but the agent's Advanced toggle is off → no Reoon."""
        from app.api import chat_routes

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
        monkeypatch.setattr(chat_routes, "_agent_enrichment_opt_in", lambda *_a, **_k: False)
        with patch("app.services.reoon_service.verify_email") as mock_verify:
            response = TestClient(_build_app(_bot())).post(
                "/chat/validate-email", json={"email": "junk@disposable-mail.test"}
            )

        assert response.status_code == 200
        assert response.json() == {"valid": True}
        mock_verify.assert_not_called()


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
            # The company leg is not what these test. Left unpatched it spawns
            # a real background thread that outlives the test and holds a
            # connection, so the fixture's DROP DATABASE fails at teardown.
            patch("app.api.chat_routes._queue_lead_company_resolution"),
        ):
            mock_get_session.return_value.__enter__.return_value = session
            chat_routes._enrich_lead_in_background("sess-1", "person@acme.com", bot_id=1)

        mock_domain.assert_called_once()  # free. Always runs
        mock_verify.assert_not_called()  # paid. Gated

    def test_reoon_runs_for_bot_with_feature_and_credits(self, monkeypatch):
        from app.api import chat_routes
        from app.db.models import LeadInfo

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
        monkeypatch.setattr(chat_routes, "_agent_enrichment_opt_in", lambda *_a, **_k: True)

        lead = MagicMock(spec=LeadInfo)
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = lead

        with (
            patch("app.services.email_domain_service.extract_company_domain", return_value="acme.com"),
            patch(
                "app.services.reoon_service.verify_email",
                return_value={"status": "safe", "is_valid_syntax": True},
            ) as mock_verify,
            # Credits successfully reserved → Reoon fires.
            patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as mock_charge,
            patch("app.api.chat_routes.get_session") as mock_get_session,
            # The company leg is not what these test. Left unpatched it spawns
            # a real background thread that outlives the test and holds a
            # connection, so the fixture's DROP DATABASE fails at teardown.
            patch("app.api.chat_routes._queue_lead_company_resolution"),
        ):
            mock_get_session.return_value.__enter__.return_value = session
            chat_routes._enrich_lead_in_background("sess-1", "person@acme.com", bot_id=1)

        # The idempotency key is required, not incidental. /chat/lead-capture is
        # POSTed by the widget from BOTH the pre-chat form and the handoff form,
        # so one visitor produces two calls and one lead; and the endpoint is
        # rate-limited per bot key, which is public and embedded in the widget,
        # so an unkeyed charge is a drain vector (10/min x 10 credits =
        # 6,000/hour). Asserting only the positional args would let the key be
        # dropped silently.
        assert mock_charge.call_count == 1
        assert mock_charge.call_args.args == (1, "email_verification")
        key = mock_charge.call_args.kwargs.get("idempotency_key")
        assert key and key.startswith("enrich:email_verification:"), (
            f"the Reoon charge must be keyed per lead; got {key!r}"
        )
        mock_verify.assert_called_once()

    def test_reoon_skipped_when_agent_opted_out(self, monkeypatch):
        """Plan allows it, but the agent's Advanced toggle is off → skip silently."""
        from app.api import chat_routes
        from app.db.models import LeadInfo

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
        monkeypatch.setattr(chat_routes, "_agent_enrichment_opt_in", lambda *_a, **_k: False)

        lead = MagicMock(spec=LeadInfo)
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = lead

        with (
            patch("app.services.email_domain_service.extract_company_domain", return_value="acme.com") as mock_domain,
            patch("app.services.reoon_service.verify_email") as mock_verify,
            patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as mock_charge,
            patch("app.api.chat_routes.get_session") as mock_get_session,
            # The company leg is not what these test. Left unpatched it spawns
            # a real background thread that outlives the test and holds a
            # connection, so the fixture's DROP DATABASE fails at teardown.
            patch("app.api.chat_routes._queue_lead_company_resolution"),
        ):
            mock_get_session.return_value.__enter__.return_value = session
            chat_routes._enrich_lead_in_background("sess-1", "person@acme.com", bot_id=1)

        mock_domain.assert_called_once()  # free. Still runs
        mock_charge.assert_not_called()  # never even reaches the charge
        mock_verify.assert_not_called()  # metered. Skipped when opted out

    def test_reoon_skipped_when_credits_insufficient(self, monkeypatch):
        """Plan + agent opt-in OK, but the ledger can't cover the charge → skip."""
        from app.api import chat_routes
        from app.db.models import LeadInfo

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
        monkeypatch.setattr(chat_routes, "_agent_enrichment_opt_in", lambda *_a, **_k: True)

        lead = MagicMock(spec=LeadInfo)
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = lead

        with (
            patch("app.services.email_domain_service.extract_company_domain", return_value="acme.com") as mock_domain,
            patch("app.services.reoon_service.verify_email") as mock_verify,
            # Charge fails (empty balance / feature off) → Reoon must not fire.
            patch("app.api.chat_routes._charge_for_enrichment", return_value=False),
            patch("app.api.chat_routes.get_session") as mock_get_session,
            # The company leg is not what these test. Left unpatched it spawns
            # a real background thread that outlives the test and holds a
            # connection, so the fixture's DROP DATABASE fails at teardown.
            patch("app.api.chat_routes._queue_lead_company_resolution"),
        ):
            mock_get_session.return_value.__enter__.return_value = session
            chat_routes._enrich_lead_in_background("sess-1", "person@acme.com", bot_id=1)

        mock_domain.assert_called_once()  # free. Still runs
        mock_verify.assert_not_called()  # metered. Skipped when unpaid
