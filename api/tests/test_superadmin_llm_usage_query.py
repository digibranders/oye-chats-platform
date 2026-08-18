"""Regression guard for GET /superadmin/llm/usage.

This endpoint 500'd in production with::

    TypeError: Function.__init__() got an unexpected keyword argument 'else_'

Cause: the query used ``func.case(...)``. ``case`` is a standalone SQLAlchemy
construct, not a member of ``func``. ``func.case(...)`` builds a *generic SQL
function* named "case", which has no ``else_`` parameter. The failure happens
at statement-CONSTRUCTION time, before any database is touched, so it needs no
DB to reproduce and no DB to guard against.

The endpoint had zero test coverage, which is exactly why a broken query
reached production. These tests pin the construction so the same typo cannot
ship again.
"""

from __future__ import annotations

import pytest
from sqlalchemy import case, func, select
from sqlalchemy.dialects import postgresql

from app.db.models import LLMCallLog


def _conditional_sum():
    """The aggregate shape used by /superadmin/llm/usage."""
    return func.coalesce(func.sum(case((LLMCallLog.error.isnot(None), 1), else_=0)), 0).label("errors")


def test_conditional_count_statement_builds():
    """The fixed form must construct without raising."""
    stmt = select(_conditional_sum()).where(LLMCallLog.id.isnot(None))
    assert stmt is not None


def test_conditional_count_compiles_to_a_real_case_expression():
    """Compile to Postgres and assert we emit SQL `CASE WHEN`, not a bogus
    `case(...)` function call, the distinction that broke production."""
    stmt = select(_conditional_sum())
    sql = str(stmt.compile(dialect=postgresql.dialect())).upper()
    assert "CASE WHEN" in sql
    assert "COALESCE" in sql
    assert "SUM(" in sql


def test_func_case_is_the_bug_and_still_raises():
    """Pin the ORIGINAL defect so nobody 'simplifies' the fix back into it.

    If a future SQLAlchemy release ever makes ``func.case(else_=...)`` legal,
    this test fails loudly and someone re-reads the comment in the route
    rather than silently reintroducing a generic-function CASE.
    """
    with pytest.raises(TypeError, match="else_"):
        func.case((LLMCallLog.error.isnot(None), 1), else_=0)


def test_route_module_does_not_use_func_case():
    """Belt-and-braces: no ``func.case(`` in the superadmin v2 routes' CODE.

    Comments are stripped before matching, the route carries an explanatory
    comment naming the bad construct, and flagging that would make the guard
    unusable exactly where it is most needed.
    """
    from pathlib import Path

    import app.api.superadmin_routes_v2 as mod

    code_lines = [
        line
        for line in Path(mod.__file__).read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    ]
    offenders = [line.strip() for line in code_lines if "func.case(" in line]
    assert not offenders, f"func.case( reintroduced. Use the standalone case() construct: {offenders}"
