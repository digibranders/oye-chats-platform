"""Unit tests for operator RBAC enforcement.

Tests the permission helper functions used by bot and canned-response routes
to ensure regular operators are blocked from mutations while owners/admins
and clients retain full access. Uses SimpleNamespace mocks — no DB required.
"""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.bot_routes import _require_bot_management_access
from app.api.canned_response_routes import _require_canned_response_write_access

# ── Helpers ──────────────────────────────────────────────────────────────────


def _client_auth(client_id: int = 1) -> dict:
    """Simulate a workspace owner using X-API-Key auth."""
    return {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }


def _operator_auth(role: str, client_id: int = 1, operator_id: int = 10) -> dict:
    """Simulate an operator using X-Operator-Key auth with a given role."""
    return {
        "type": "operator",
        "entity": SimpleNamespace(id=operator_id, role=role, client_id=client_id),
        "client_id": client_id,
        "operator_id": operator_id,
    }


# ── Bot management RBAC ───────────────────────────────────────────────────────


class TestBotManagementAccess:
    def test_client_always_allowed(self):
        _require_bot_management_access(_client_auth())  # must not raise

    def test_owner_operator_allowed(self):
        _require_bot_management_access(_operator_auth("owner"))  # must not raise

    def test_admin_operator_allowed(self):
        _require_bot_management_access(_operator_auth("admin"))  # must not raise

    def test_regular_operator_blocked(self):
        with pytest.raises(HTTPException) as exc_info:
            _require_bot_management_access(_operator_auth("operator"))
        assert exc_info.value.status_code == 403

    def test_unknown_role_blocked(self):
        """Any role not in {'owner', 'admin'} must be blocked."""
        with pytest.raises(HTTPException) as exc_info:
            _require_bot_management_access(_operator_auth("supervisor"))
        assert exc_info.value.status_code == 403


# ── Canned response RBAC ─────────────────────────────────────────────────────


class TestCannedResponseWriteAccess:
    def test_client_always_allowed(self):
        _require_canned_response_write_access(_client_auth())  # must not raise

    def test_owner_operator_allowed(self):
        _require_canned_response_write_access(_operator_auth("owner"))  # must not raise

    def test_admin_operator_allowed(self):
        _require_canned_response_write_access(_operator_auth("admin"))  # must not raise

    def test_regular_operator_allowed(self):
        _require_canned_response_write_access(_operator_auth("operator"))  # must not raise

    def test_any_role_allowed(self):
        _require_canned_response_write_access(_operator_auth("viewer"))  # must not raise
