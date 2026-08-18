"""The docs plan matrix is generated from this repo. Keep the generator honest.

``scripts/export_plan_matrix.py`` feeds the public documentation's plan and
capability tables. The website repo cannot import Python, so a rename or a
retiered plan here would otherwise surface as silently stale published tables.

These tests do not check the website's committed copy (a different repo). They
check the thing that would make that copy wrong: the exporter drifting from the
constants it reads.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "export_plan_matrix.py"


def _load_exporter():
    spec = importlib.util.spec_from_file_location("export_plan_matrix", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def matrix() -> dict:
    return _load_exporter().build_matrix()


def test_every_seeded_plan_is_exported(matrix: dict) -> None:
    from app.services.plan_entitlements_service import _SEEDED_PLAN_SLUGS

    assert {p["slug"] for p in matrix["plans"]} == set(_SEEDED_PLAN_SLUGS)


def test_capability_slugs_are_real_plans(matrix: dict) -> None:
    """A typo'd or retired slug would render an all-dashes row in the docs."""
    known = {p["slug"] for p in matrix["plans"]}
    for capability in matrix["capabilities"]:
        unknown = set(capability["slugs"]) - known
        assert not unknown, f"{capability['key']} references unknown plans: {unknown}"


def test_no_capability_is_empty(matrix: dict) -> None:
    """Every published capability belongs to at least one tier.

    An empty row means the feature was retired, renamed, or never seeded, and
    the docs would advertise something no plan can reach.
    """
    empty = [c["key"] for c in matrix["capabilities"] if not c["slugs"]]
    assert not empty, f"capabilities gated to no plan: {empty}"


def test_labelled_features_still_exist_on_the_seeded_plans(matrix: dict) -> None:
    """Guards a rename of a ``Plan.features`` key the docs publish."""
    exporter = _load_exporter()
    seeded_feature_keys: set[str] = set()
    for plan in exporter._load_seed_plans():
        seeded_feature_keys |= set(plan["features"])

    missing = set(exporter._FEATURE_LABELS) - seeded_feature_keys
    assert not missing, f"docs label features absent from seed_plans: {missing}"


def test_labelled_limits_still_exist_on_the_seeded_plans() -> None:
    exporter = _load_exporter()
    seeded_limit_keys: set[str] = set()
    for plan in exporter._load_seed_plans():
        seeded_limit_keys |= set(plan["limits"])

    missing = {key for key, _ in exporter._LIMIT_LABELS} - seeded_limit_keys
    assert not missing, f"docs label limits absent from seed_plans: {missing}"


def test_external_gates_match_the_live_constants(matrix: dict) -> None:
    """The capabilities gated outside ``Plan.features`` are the ones that drifted
    before. Assert the exported slugs equal the constants the platform enforces.
    """
    from app.services.plan_entitlements_service import (
        EMAIL_VERIFICATION_SLUGS,
        JOURNEY_ANALYTICS_SLUGS,
        LEAD_SOURCE_ATTRIBUTION_SLUGS,
        VISITOR_INTELLIGENCE_SLUGS,
    )
    from app.services.plan_service import _DELTA_RECRAWL_PLAN_SLUGS

    expected = {
        "journey_analytics": JOURNEY_ANALYTICS_SLUGS,
        "lead_source_attribution": LEAD_SOURCE_ATTRIBUTION_SLUGS,
        "email_verification": EMAIL_VERIFICATION_SLUGS,
        "visitor_intelligence": VISITOR_INTELLIGENCE_SLUGS,
        "delta_recrawl": _DELTA_RECRAWL_PLAN_SLUGS,
    }
    by_key = {c["key"]: c for c in matrix["capabilities"]}

    for key, slugs in expected.items():
        assert key in by_key, f"{key} missing from the exported matrix"
        assert set(by_key[key]["slugs"]) == set(slugs)


def test_prices_are_not_exported(matrix: dict) -> None:
    """Docs deliberately carry no prices. They are geo-gated and live on /pricing."""
    blob = repr(matrix)
    for banned in ("price_cents", "monthly_price", "annual_price", "usd_cents"):
        assert banned not in blob
