"""Tests for client-suspension enforcement in auth dependencies (finding SUSP).

When a superadmin suspends a client, ``Client.suspended_at`` is set to a
timestamp. The auth dependencies in ``app.api.auth`` must refuse to resolve a
suspended client (its API key, its operators, and its bots) with HTTP 403
``account_suspended``. While non-suspended clients and superadmins keep
working.

These tests exercise the resolution logic directly by monkeypatching
``auth.get_session`` (the same pattern as ``test_auth_routes.py``), so they run
without a live database.
"""

from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException, Request

from app.api import auth


@contextmanager
def _session_ctx(session):
    yield session


def _request(method: str = "GET") -> Request:
    """A minimal ASGI request.

    Every client-resolving dependency takes one so the impersonation write
    guard can inspect the matched route; these tests exercise the ordinary
    (non-impersonated) credential paths, where it is never consulted.
    """
    return Request({"type": "http", "method": method, "path": "/test", "headers": []})


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value


class _ExecuteResult:
    def __init__(self, value, tuple_value=None):
        self._value = value
        self._tuple_value = tuple_value

    def scalars(self):
        return _ScalarResult(self._value)

    def tuples(self):
        return _ScalarResult(self._tuple_value)


def _owner_tuple(*, suspended: bool, is_superadmin: bool = False, deactivated: bool = False):
    """Row shape returned by ``select(Client.is_superadmin, Client.suspended_at, Client.deactivated_at)``."""
    now = datetime.now(UTC)
    return (is_superadmin, now if suspended else None, now if deactivated else None)


def _client(
    *,
    suspended: bool,
    is_superadmin: bool = False,
    deactivated: bool = False,
    **extra,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        name="Acme",
        email="acme@example.com",
        api_key="client-key-123",
        is_superadmin=is_superadmin,
        suspended_at=datetime.now(UTC) if suspended else None,
        deactivated_at=datetime.now(UTC) if deactivated else None,
        **extra,
    )


def _bot(*, client_id: int = 1) -> SimpleNamespace:
    """A Bot stub carrying every field ``_bot_to_cache_dict`` serializes."""
    return SimpleNamespace(
        id=1,
        client_id=client_id,
        bot_key="bot-abc123",
        name="Bot",
        system_prompt="hi",
        subscription_id=None,
        is_legacy_pooled=False,
        _subscription_bot_id=None,
        brand_tone=None,
        company_description=None,
        website="https://example.com",
        bot_logo=None,
        launcher_name=None,
        launcher_logo=None,
        primary_color="#000",
        background_color="#fff",
        header_color="#000",
        user_bubble_color="#000",
        bant_enabled=False,
        bant_config=None,
        quotation_catalog=None,
        avatar_type=None,
        orb_color=None,
        lead_form_enabled=False,
        lead_form_fields=None,
        email_verification_enabled=True,
        company_lookup_enabled=True,
        calcom_url=None,
        widget_installed_at=None,
        notification_email=None,
        notification_emails=None,
        reply_to_email=None,
        email_on_qualified=False,
        email_on_handoff=False,
        email_on_offline=False,
        email_visitor_confirmation=False,
        live_chat_enabled=False,
        operator_timeout_seconds=0,
        visitor_disconnect_timeout=0,
        operator_disconnect_timeout=0,
        business_hours=None,
        welcome_title=None,
        welcome_subtitle=None,
        waiting_message=None,
        offline_message=None,
        handoff_delay_seconds=0,
        calendly_url=None,
        zcal_url=None,
        meeting_provider=None,
        meeting_booking_enabled=False,
        feature_flags={},
        widget_messages={},
        widget_config={},
        branding_text=None,
        branding_url=None,
        is_active=True,
        recommended_colors=None,
        allowed_domains=[],
        domain_check_enabled=False,
        created_at=None,
    )


def _patch_session(monkeypatch, session):
    monkeypatch.setattr(auth, "get_session", lambda: _session_ctx(session))


# ── get_current_client (X-API-Key) ───────────────────────────────────────────


class TestGetCurrentClient:
    def test_suspended_client_api_key_rejected(self, monkeypatch):
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(_client(suspended=True))
        _patch_session(monkeypatch, session)

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client(
                _request(), api_key="client-key-123", operator_key=None, legacy_agent_key=None, impersonation_token=None
            )

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_suspended"

    def test_active_client_api_key_allowed(self, monkeypatch):
        client = _client(suspended=False)
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client)
        _patch_session(monkeypatch, session)

        result = auth.get_current_client(
            _request(), api_key="client-key-123", operator_key=None, legacy_agent_key=None, impersonation_token=None
        )
        assert result is client

    def test_superadmin_never_suspended_allowed(self, monkeypatch):
        # Defensive: even if suspended_at were somehow set, a superadmin must
        # never be locked out of the console.
        admin = _client(suspended=True, is_superadmin=True)
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(admin)
        _patch_session(monkeypatch, session)

        result = auth.get_current_client(
            _request(), api_key="client-key-123", operator_key=None, legacy_agent_key=None, impersonation_token=None
        )
        assert result is admin

    def test_invalid_api_key_rejected_with_401(self, monkeypatch):
        """An X-API-Key that matches no Client row must raise 401 ``Invalid API
        Key.``, it must never resolve to ``None`` (which would drop an
        unauthenticated caller into the endpoint) nor silently fall through to
        the operator path. Pins the auth contract the whole suite otherwise
        only asserted for the ``/auth/login`` route, not this dependency
        (mutation AUTH2)."""
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(None)  # no client matches the key
        _patch_session(monkeypatch, session)

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client(
                _request(), api_key="bogus-key", operator_key=None, legacy_agent_key=None, impersonation_token=None
            )

        assert exc.value.status_code == 401
        assert exc.value.detail == "Invalid API Key."

    def test_suspended_client_via_operator_key_rejected(self, monkeypatch):
        operator = SimpleNamespace(id=9, client_id=1, operator_api_key="op-key")
        suspended_owner = _client(suspended=True)
        session = MagicMock()
        # First execute() → operator lookup, second → owning client lookup.
        session.execute.side_effect = [
            _ExecuteResult(operator),
            _ExecuteResult(suspended_owner),
        ]
        _patch_session(monkeypatch, session)

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client(
                _request(), api_key=None, operator_key="op-key", legacy_agent_key=None, impersonation_token=None
            )

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_suspended"


# ── get_current_client_strict (X-API-Key only) ───────────────────────────────


class TestGetCurrentClientStrict:
    def test_suspended_client_rejected(self, monkeypatch):
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(_client(suspended=True))
        _patch_session(monkeypatch, session)

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client_strict(_request(), api_key="client-key-123", impersonation_token=None)

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_suspended"

    def test_active_client_allowed(self, monkeypatch):
        client = _client(suspended=False)
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client)
        _patch_session(monkeypatch, session)

        result = auth.get_current_client_strict(_request(), api_key="client-key-123", impersonation_token=None)
        assert result is client


# ── get_current_client_or_operator ───────────────────────────────────────────


class TestGetCurrentClientOrOperator:
    def test_suspended_client_key_rejected(self, monkeypatch):
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(_client(suspended=True))
        _patch_session(monkeypatch, session)

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client_or_operator(
                _request(),
                api_key="client-key-123",
                operator_key=None,
                legacy_agent_key=None,
                workspace_id_raw=None,
                impersonation_token=None,
            )

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_suspended"

    def test_active_client_key_allowed(self, monkeypatch):
        client = _client(suspended=False)
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(client)
        _patch_session(monkeypatch, session)

        result = auth.get_current_client_or_operator(
            _request(),
            api_key="client-key-123",
            operator_key=None,
            legacy_agent_key=None,
            workspace_id_raw=None,
            impersonation_token=None,
        )
        assert result["type"] == "client"
        assert result["entity"] is client

    def test_operator_of_suspended_workspace_rejected(self, monkeypatch):
        # ``bot_id`` mirrors the DB column added when operators became
        # bot-scoped. Auth.get_current_client_or_operator dereferences it
        # to populate the returned dict's ``bot_id`` field. The mock has
        # to carry it or the getattr chain in auth.py raises.
        operator = SimpleNamespace(
            id=9,
            name="Op",
            email="op@example.com",
            client_id=1,
            bot_id=42,
            role="operator",
            department_id=None,
            operator_api_key="op-key",
            is_online=False,
            is_active=True,
        )
        suspended_owner = _client(suspended=True)
        session = MagicMock()
        # execute() calls: operator lookup, then owning-client suspension lookup.
        session.execute.side_effect = [
            _ExecuteResult(operator),
            _ExecuteResult(suspended_owner),
        ]
        _patch_session(monkeypatch, session)

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client_or_operator(
                _request(),
                api_key=None,
                operator_key="op-key",
                legacy_agent_key=None,
                workspace_id_raw=None,
                impersonation_token=None,
            )

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_suspended"


# ── get_current_bot (X-Bot-Key) ──────────────────────────────────────────────


class TestGetCurrentBot:
    def test_suspended_owner_bot_key_rejected_db_path(self, monkeypatch):
        bot = _bot(client_id=1)
        session = MagicMock()
        # execute() calls: bot lookup (scalars), then owner suspension (tuples).
        session.execute.side_effect = [
            _ExecuteResult(bot),
            _ExecuteResult(None, tuple_value=_owner_tuple(suspended=True)),
        ]
        session.scalar.return_value = None
        _patch_session(monkeypatch, session)
        # Ensure no Redis cache short-circuit.
        monkeypatch.setattr(auth, "cache_get", lambda key: None)
        monkeypatch.setattr(auth, "cache_set", lambda *a, **k: None)

        request = SimpleNamespace(headers={})
        with pytest.raises(HTTPException) as exc:
            auth.get_current_bot(request=request, bot_key="bot-abc123", api_key=None)

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_suspended"

    def test_active_owner_bot_key_allowed_db_path(self, monkeypatch):
        bot = _bot(client_id=1)
        session = MagicMock()
        session.execute.side_effect = [
            _ExecuteResult(bot),
            _ExecuteResult(None, tuple_value=_owner_tuple(suspended=False)),
        ]
        session.scalar.return_value = None
        _patch_session(monkeypatch, session)
        monkeypatch.setattr(auth, "cache_get", lambda key: None)
        monkeypatch.setattr(auth, "cache_set", lambda *a, **k: None)

        request = SimpleNamespace(headers={})
        result = auth.get_current_bot(request=request, bot_key="bot-abc123", api_key=None)
        assert result is bot

    def test_suspended_owner_bot_key_rejected_cache_path(self, monkeypatch):
        """A Redis cache hit must still enforce owner suspension."""
        bot = _bot(client_id=1)
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(None, tuple_value=_owner_tuple(suspended=True))
        _patch_session(monkeypatch, session)

        # Serve the bot from cache so the primary DB path is skipped.
        monkeypatch.setattr(auth, "cache_get", lambda key: auth._bot_to_cache_dict(bot))

        request = SimpleNamespace(headers={})
        with pytest.raises(HTTPException) as exc:
            auth.get_current_bot(request=request, bot_key="bot-abc123", api_key=None)

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_suspended"


# ── Deactivated-client enforcement (post-trial hard-delete) ──────────────────
#
# ``Client.deactivated_at`` is set by ``task_delete_expired_trial_data`` after
# the 15-day retention window. Every auth path that accepts a Client identity
# must refuse to resolve a deactivated row with HTTP 403 ``account_deleted``.
# Otherwise a customer whose workspace was hard-deleted would authenticate
# into a ghost dashboard. Superadmins remain exempt.


class TestGetCurrentClientDeactivated:
    def test_deactivated_client_api_key_rejected(self, monkeypatch):
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(_client(suspended=False, deactivated=True))
        _patch_session(monkeypatch, session)

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client(
                _request(), api_key="client-key-123", operator_key=None, legacy_agent_key=None, impersonation_token=None
            )

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_deleted"

    def test_deactivated_client_via_operator_key_rejected(self, monkeypatch):
        operator = SimpleNamespace(id=9, client_id=1, operator_api_key="op-key")
        deactivated_owner = _client(suspended=False, deactivated=True)
        session = MagicMock()
        session.execute.side_effect = [
            _ExecuteResult(operator),
            _ExecuteResult(deactivated_owner),
        ]
        _patch_session(monkeypatch, session)

        with pytest.raises(HTTPException) as exc:
            auth.get_current_client(
                _request(), api_key=None, operator_key="op-key", legacy_agent_key=None, impersonation_token=None
            )

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_deleted"

    def test_superadmin_never_deactivated_locked_out(self, monkeypatch):
        """Defensive: even if ``deactivated_at`` were somehow set on a
        superadmin row, the console must stay reachable."""
        admin = _client(suspended=False, deactivated=True, is_superadmin=True)
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(admin)
        _patch_session(monkeypatch, session)

        result = auth.get_current_client(
            _request(), api_key="client-key-123", operator_key=None, legacy_agent_key=None, impersonation_token=None
        )
        assert result is admin


class TestGetCurrentBotDeactivatedOwner:
    def test_deactivated_owner_bot_key_rejected(self, monkeypatch):
        """Widget requests must stop working when the owning client is
        deactivated. Otherwise a hard-deleted workspace's embed keeps
        serving 200s against a dashboard the customer can't reach."""
        bot = _bot(client_id=1)
        session = MagicMock()
        # Bot lookup returns the bot; the owner-standing tuple lookup returns
        # a deactivated row.
        session.execute.side_effect = [
            _ExecuteResult(bot),
            _ExecuteResult(None, tuple_value=_owner_tuple(suspended=False, deactivated=True)),
        ]
        _patch_session(monkeypatch, session)
        monkeypatch.setattr(auth, "cache_get", lambda key: None)
        monkeypatch.setattr(auth, "cache_set", lambda *a, **k: None)

        request = SimpleNamespace(headers={})
        with pytest.raises(HTTPException) as exc:
            auth.get_current_bot(request=request, bot_key="bot-abc123", api_key=None)

        assert exc.value.status_code == 403
        assert exc.value.detail == "account_deleted"
