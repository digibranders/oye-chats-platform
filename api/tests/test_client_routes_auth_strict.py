"""Regression tests for the operator-key -> account-takeover fix (audit F01/F02).

`client_routes.py` imports the permissive ``get_current_client``, which — unlike
``get_current_client_strict`` — also resolves an ``X-Operator-Key`` to its
workspace's owning ``Client`` (auth.py). That means a lowest-privilege operator
could call the account-credential/identity endpoints *as the workspace owner*:

  * ``POST /client/api-key/regenerate`` — rotate & read the owner's master key
    (F01: full account takeover + owner lockout; super-admin takeover if the
    owner is a super-admin).
  * ``GET  /client/api-key``            — read the owner's master key.
  * ``PATCH /client/profile``           — change the owner's email, then drive
    the password-reset OTP to an attacker address (F02: login takeover).
  * ``POST /client/change-password``    — belt-and-suspenders (account credential).

These endpoints must depend on ``get_current_client_strict`` (X-API-Key only).
Mirrors the DB-free signature-introspection pattern in
``test_superadmin_auth_strict.py``.
"""

import inspect

import pytest
from fastapi.params import Depends as DependsParam

from app.api import client_routes
from app.api.auth import get_current_client_strict

# Account-credential / identity / workspace-config endpoints that must be
# owner-only (X-API-Key). Includes bot/workspace mutations (settings, logo):
# an operator key must not be able to rewrite the bot's name/colors/logo
# (code-review RV5).
OWNER_ONLY_HANDLERS = [
    "get_client_api_key",
    "regenerate_client_api_key",
    "update_client_profile",
    "change_client_password",
    "update_client_settings",
    "upload_logo_endpoint",
]


@pytest.mark.parametrize("handler_name", OWNER_ONLY_HANDLERS)
def test_account_credential_endpoint_uses_strict_auth(handler_name):
    """Each account-credential/identity handler must resolve its caller via
    get_current_client_strict, so an X-Operator-Key can never satisfy it."""
    handler = getattr(client_routes, handler_name)
    dep = inspect.signature(handler).parameters["client"].default
    assert isinstance(dep, DependsParam), (
        f"{handler_name} must authenticate its caller via a Depends(...) on the `client` param"
    )
    assert dep.dependency is get_current_client_strict, (
        f"{handler_name} must depend on get_current_client_strict (X-API-Key only) — "
        "get_current_client also accepts an X-Operator-Key and would let any operator "
        "act as the workspace owner (audit F01/F02)."
    )
