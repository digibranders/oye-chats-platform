"""A read-only super-admin must not be able to create or destroy accounts.

`get_superadmin` proves the caller is A super-admin, not that they may WRITE.
`superadmin_role == "readonly"` is a real tier: it is a live column, it is
assignable from the owner-gated client PATCH, and every other super-admin
module enforces it on every mutation. This module enforced it on feedback
triage and nowhere else, so the two most destructive routes on the platform
were open to the tier created specifically to be harmless. `DELETE
/superadmin/clients/{id}` CASCADEs away the account's bots, documents,
conversations and messages; `POST /superadmin/clients` mints an account and
returns its fresh `api_key` in the response body.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.superadmin_routes import _require_write


def _admin(role):
    return SimpleNamespace(id=1, email="admin@oyechats.com", superadmin_role=role)


def test_a_readonly_superadmin_is_refused():
    with pytest.raises(HTTPException) as exc:
        _require_write(_admin("readonly"))
    assert exc.value.status_code == 403


@pytest.mark.parametrize("role", ["owner", "admin", None])
def test_every_writing_tier_is_allowed(role):
    _require_write(_admin(role))


def test_an_account_row_without_the_column_still_writes():
    """Absence is not read-only. Failing closed here would lock out any caller
    whose row predates the column."""
    _require_write(SimpleNamespace(id=1, email="a@b.c"))


def test_both_destructive_client_routes_call_the_gate():
    """The helper is only worth having if the routes actually invoke it.

    Asserted against the source, because exercising these two routes for real
    means standing up a full super-admin session and then deleting an account.
    """
    import inspect

    from app.api import superadmin_routes

    for fn in (superadmin_routes.create_client, superadmin_routes.delete_client):
        body = inspect.getsource(fn)
        assert "_require_write(superadmin)" in body, f"{fn.__name__} does not gate writes"
