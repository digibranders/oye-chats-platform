"""The per-turn predicates are free, and they must stay free.

O-2 proposed collapsing the routing predicates in ``rag_service`` into a single
LLM classifier. Measured, that is a downgrade in every direction that matters:

* there are 45 of them and **all 45 are pure string or regex work**. Not one
  makes a model call today;
* not one is dead. Every one has a call site;
* they run on the hot path. A classifier there adds a network round trip, a
  bill, and a new failure mode to every single turn of every bot, in exchange
  for deleting code that costs nothing and cannot fail.

The relevance and groundedness judges already fail open, which is the right
behaviour and also the reason a 41-request outage once ran unnoticed. Adding a
third model dependency to the same path, this time for control flow rather than
for a check that may be skipped, is the opposite of what this session's work on
those judges was for.

So the invariant is the thing worth keeping, and this is it: routing decisions
are made without asking a model. Someone will eventually be tempted to reach
for one inside a predicate because it is the easy way to handle an awkward
case. This test is what says no.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

_SOURCE = pathlib.Path(__file__).resolve().parents[1] / "app" / "services" / "rag_service.py"

#: Anything that reaches a language model, directly or through the service layer.
_MODEL_CALLS = ("litellm", "acompletion", "completion(", "generate_response", "check_relevance")


def _predicates() -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    tree = ast.parse(_SOURCE.read_text(encoding="utf-8"))
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        returns_bool = isinstance(node.returns, ast.Name) and node.returns.id == "bool"
        named_like_one = node.name.startswith(("_is_", "_looks_", "_has_", "_should_"))
        if returns_bool or named_like_one:
            found.append(node)
    return found


def test_the_predicates_are_still_there_to_check():
    """A guard on the guard. If the shape stops matching, the test below passes
    on an empty list and protects nothing."""
    assert len(_predicates()) >= 40


@pytest.mark.parametrize("predicate", _predicates(), ids=lambda node: node.name)
def test_a_routing_predicate_does_not_call_a_model(predicate):
    body = ast.unparse(predicate)
    offenders = [marker for marker in _MODEL_CALLS if marker in body]
    assert offenders == [], (
        f"{predicate.name} (line {predicate.lineno}) reaches a model. "
        "These run on every turn; a round trip here is paid for by every visitor "
        "of every bot, and it introduces a failure mode into control flow that "
        "currently cannot fail."
    )


def test_every_predicate_has_a_caller():
    """None of them is dead weight, which was the other half of the finding."""
    import re

    source = _SOURCE.read_text(encoding="utf-8")
    orphans = [node.name for node in _predicates() if len(re.findall(rf"\b{re.escape(node.name)}\b", source)) <= 1]
    assert orphans == [], f"predicates with no call site: {orphans}"
