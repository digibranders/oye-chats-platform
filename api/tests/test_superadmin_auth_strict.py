"""Regression test for the operator-key -> super-admin escalation fix (roadmap §0.2).

``get_superadmin`` must depend on ``get_current_client_strict`` (X-API-Key only),
NOT ``get_current_client`` — the latter also resolves an ``X-Operator-Key`` to
its workspace's owning Client, which would let any operator of a super-admin's
workspace authenticate *as* that super-admin and reach ``/superadmin/*``.

Both checks are DB-free: strict auth rejects a missing X-API-Key before any
lookup, and the wiring is verified by signature introspection.
"""

import inspect

import pytest
from fastapi import HTTPException, Request
from fastapi.params import Depends as DependsParam

from app.api.auth import get_current_client_strict, get_superadmin


def test_get_superadmin_uses_strict_auth():
    """The dependency wired into get_superadmin must be strict (X-API-Key only)."""
    dep = inspect.signature(get_superadmin).parameters["client"].default
    assert isinstance(dep, DependsParam)
    assert dep.dependency is get_current_client_strict, (
        "get_superadmin must depend on get_current_client_strict so operator keys cannot escalate to superadmin"
    )


def test_strict_auth_rejects_operator_only_request():
    """With no X-API-Key, strict auth 401s before any DB lookup — an operator
    key alone (which get_current_client_strict ignores) can never satisfy it."""
    request = Request({"type": "http", "method": "GET", "path": "/superadmin/clients", "headers": []})
    with pytest.raises(HTTPException) as exc:
        get_current_client_strict(request, api_key="", impersonation_token=None)
    assert exc.value.status_code == 401
