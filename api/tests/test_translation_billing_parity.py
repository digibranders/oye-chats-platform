"""Every translation charge site meters the same way.

``docs/multilingual/phase-4-operator-translation.md`` specifies that the
manual-retry endpoint is "credit-metered exactly like the socket path". The
socket paths were given a cache probe and a refund; the transcript backfill and
``POST /operators/translate`` were not, so opening one Hindi conversation in
the inbox charged a credit per message even when every one of them was already
in the shared cache, and a degraded provider kept the money.

This locks the contract at the source level, across all four sites, so a future
change to one of them cannot silently reintroduce the split. It is a static
check by design: the four call sites live in two modules behind a WebSocket, an
ARQ-spawned coroutine and an HTTP route, and asserting the shared contract in
one place is worth more than three bespoke harnesses that each drift on their
own.
"""

import ast
import pathlib

_API = pathlib.Path(__file__).resolve().parents[1] / "app"
_SERVICE = _API / "services" / "translation_service.py"
_ROUTES = _API / "api" / "operator_routes.py"


def _function_named(path: pathlib.Path, name: str) -> ast.AST:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"{name} not found in {path.name} — did it get renamed?")


def _calls_in(node: ast.AST) -> set[str]:
    """Every function name called anywhere inside `node`, attribute or bare."""
    names: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            fn = sub.func
            if isinstance(fn, ast.Name):
                names.add(fn.id)
            elif isinstance(fn, ast.Attribute):
                names.add(fn.attr)
    return names


CHARGE_SITES = [
    (_SERVICE, "_translate_incoming"),
    (_SERVICE, "translate_outgoing"),
    (_SERVICE, "_backfill_transcript"),
    (_ROUTES, "translate_for_session"),
]


def _resolve_site(path: pathlib.Path, name: str) -> ast.AST:
    try:
        return _function_named(path, name)
    except AssertionError:
        # The route handler's name is the one thing here that is cosmetic;
        # find it by the charge call instead so a rename doesn't fake a pass.
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and "charge_for_translation" in _calls_in(
                node
            ):
                return node
        raise


def test_every_charge_site_probes_the_cache_first():
    """A cache hit must cost no credit, on all four paths."""
    missing = []
    for path, name in CHARGE_SITES:
        calls = _calls_in(_resolve_site(path, name))
        if "charge_for_translation" in calls and "translation_is_free" not in calls:
            missing.append(f"{path.name}::{name}")
    assert not missing, f"charge sites that bill a cache hit: {missing}"


def test_every_charge_site_refunds_a_provider_failure():
    """A translation the visitor never received must not be kept."""
    missing = []
    for path, name in CHARGE_SITES:
        calls = _calls_in(_resolve_site(path, name))
        if "charge_for_translation" in calls and "refund_translation_charge" not in calls:
            missing.append(f"{path.name}::{name}")
    assert not missing, f"charge sites that keep the credit on failure: {missing}"


def test_the_four_sites_are_still_the_only_ones():
    """A new charge site must be added to this contract, not slipped past it."""
    found: set[str] = set()
    for path in (_SERVICE, _ROUTES):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and "charge_for_translation" in _calls_in(
                node
            ):
                found.add(f"{path.name}::{node.name}")
    expected = {
        "translation_service.py::_translate_incoming",
        "translation_service.py::translate_outgoing",
        "translation_service.py::_backfill_transcript",
        "operator_routes.py::translate_for_session",
    }
    assert found == expected, (
        "the set of translation charge sites changed; add the new one to "
        f"CHARGE_SITES so it is held to the same metering contract. found={found}"
    )
