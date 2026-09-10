"""Typed responses are the precondition for generated clients, and they are rare.

U-14 proposed replacing roughly 150 hand-written TypeScript interfaces across
the console, the super-admin console and the mobile app with types generated
from the OpenAPI schema. Measured, that would be a downgrade: FastAPI only
documents a response body where the route declares ``response_model=``, and
almost none of them do. Generating today swaps 150 accurate hand-written
interfaces for a few hundred ``any``s, and the hand-written ones would stop
being maintained the moment they looked redundant.

So the order is: declare response models, then generate. This test makes the
first half measurable and stops it going backwards. A route that loses its
``response_model``, or a new untyped route added where a typed one belongs,
moves the number the wrong way.

Raising the floor is the point. Lowering it needs saying out loud in review.
"""

from __future__ import annotations

import pytest

#: Operations declaring a typed 200 body, measured 2026-09-09. A ratchet: it
#: may go up freely and may not go down.
TYPED_RESPONSE_FLOOR = 37

#: Named response schemas in ``components``. Includes request bodies, which are
#: typed almost everywhere because they are Pydantic models on the way in.
SCHEMA_FLOOR = 169


@pytest.fixture(scope="module")
def spec():
    from app.main import app

    return app.openapi()


def _operations(spec: dict):
    for path, operations in spec["paths"].items():
        for verb, operation in operations.items():
            if verb in ("get", "post", "put", "patch", "delete"):
                yield path, verb, operation


def _has_typed_body(operation: dict) -> bool:
    response = (operation.get("responses") or {}).get("200") or {}
    schema = ((response.get("content") or {}).get("application/json") or {}).get("schema") or {}
    return bool(schema.get("$ref") or schema.get("items") or schema.get("properties"))


def test_typed_response_coverage_only_goes_up(spec):
    typed = sum(1 for _p, _v, op in _operations(spec) if _has_typed_body(op))
    assert typed >= TYPED_RESPONSE_FLOOR, (
        f"typed 200 responses fell from {TYPED_RESPONSE_FLOOR} to {typed}. "
        "A route lost its response_model, which is a step away from generated clients."
    )


def test_the_schema_catalogue_only_grows(spec):
    schemas = len((spec.get("components") or {}).get("schemas") or {})
    assert schemas >= SCHEMA_FLOOR, f"named schemas fell from {SCHEMA_FLOOR} to {schemas}"


def test_the_spec_still_builds_and_covers_the_admin_surface(spec):
    """The published artefact once carried only the public routes, which is why
    codegen looked impossible. The live app documents everything, super-admin
    included; the gap is types, not paths."""
    paths = spec["paths"]
    assert len(paths) > 250
    assert any(p.startswith("/superadmin") for p in paths)
    assert any(p.startswith("/operators") for p in paths)
