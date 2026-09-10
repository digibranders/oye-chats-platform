"""The super-admin surface is five routers; it must behave like one.

They all mount ``prefix="/superadmin"`` and they are five files because they
were written at five different times, not because they cover five different
things: clients are split across three of them, invoices across two, discounts
across two. That split had done real damage to the shared gates.

* ``_require_write`` existed twice, with two docstrings, because one file was
  the last to learn that the read-only tier is real. A read-only super-admin
  could mint accounts and read back their api_key from that file.
* Three routers imported that private name across a module boundary from a
  fourth, so the dependency graph ran through a leading underscore.
* The UTC coercer had three implementations under two names.

These tests pin the shape rather than the routes. Merging 105 endpoints into
one 6,500-line module would not be an improvement; having one definition of who
may write, and 105 endpoints that all prove who is calling, is.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

_API = pathlib.Path(__file__).resolve().parents[1] / "app" / "api"
_ROUTERS = sorted(_API.glob("superadmin_*routes*.py"))


def _tree(path: pathlib.Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"))


def test_the_routers_are_all_present():
    """A guard on the guard: if the glob stops matching, every test below
    passes vacuously."""
    assert len(_ROUTERS) == 5, [p.name for p in _ROUTERS]


class TestOneDefinitionOfWhoMayWrite:
    def test_the_gates_live_in_exactly_one_module(self):
        from app.api import superadmin_common

        assert callable(superadmin_common.require_write)
        assert callable(superadmin_common.require_owner)

    @pytest.mark.parametrize("path", _ROUTERS, ids=lambda p: p.name)
    def test_no_router_defines_its_own_gate(self, path):
        defined = {
            node.name for node in ast.walk(_tree(path)) if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        }
        assert "require_write" not in defined
        assert "_require_write" not in defined
        assert "require_owner" not in defined

    @pytest.mark.parametrize("path", _ROUTERS, ids=lambda p: p.name)
    def test_no_router_imports_a_private_name_from_another_router(self, path):
        offenders = [
            f"{node.module}.{alias.name}"
            for node in ast.walk(_tree(path))
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("app.api.superadmin")
            for alias in node.names
            if alias.name.startswith("_")
        ]
        assert offenders == []


class TestOneUtcCoercer:
    def test_it_lives_in_core(self):
        from datetime import UTC, datetime

        from app.core.dates import as_utc

        assert as_utc(None) is None
        assert as_utc(datetime(2026, 1, 1)).tzinfo is UTC
        aware = datetime(2026, 1, 1, tzinfo=UTC)
        assert as_utc(aware) is aware

    def test_nothing_redefines_it(self):
        from app.api import superadmin_plan_routes, superadmin_promotion_routes
        from app.services import promotion_service

        for module in (superadmin_plan_routes, superadmin_promotion_routes, promotion_service):
            assert not hasattr(module, "_as_utc"), module.__name__
            assert not hasattr(module, "_ensure_utc"), module.__name__


class TestEveryEndpointProvesWhoIsCalling:
    """``get_superadmin`` on every route, with no exceptions.

    An endpoint added to any of these files without it is reachable by any
    authenticated customer, and the file it lands in is decided by whoever
    edits last. A count that has to match is the only thing that catches it.
    """

    @pytest.mark.parametrize("path", _ROUTERS, ids=lambda p: p.name)
    def test_no_route_is_missing_the_super_admin_dependency(self, path):
        unguarded: list[str] = []
        for node in ast.walk(_tree(path)):
            if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            is_route = any(
                isinstance(dec, ast.Call)
                and isinstance(dec.func, ast.Attribute)
                and dec.func.attr in {"get", "post", "patch", "put", "delete"}
                for dec in node.decorator_list
            )
            if not is_route:
                continue
            source = ast.unparse(node.args)
            if "get_superadmin" not in source:
                unguarded.append(node.name)
        assert unguarded == [], f"{path.name} has routes with no super-admin dependency: {unguarded}"
