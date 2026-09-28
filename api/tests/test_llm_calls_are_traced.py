"""Every model call under ``app/`` is traced in Langfuse, or exempt on purpose.

Event extraction, live-chat translation and every Gemini embedding reached a
provider with no Langfuse observation, so their tokens and cost were invisible.
Nothing tied a new ``litellm.completion`` to its tracing. This test reads every
call site and requires it to sit inside a ``with langfuse_generation(...)``
block in the same function, so the next untraced call fails CI instead of
going missing from the bill.

Guarded calls are LiteLLM's model entry points on the ``litellm`` module
(however it is imported) and the POST to Gemini's embedding API.
``litellm.moderation`` is not one: OpenAI's moderation endpoint is free and
reports no token usage.
"""

from __future__ import annotations

import ast
import pathlib
from dataclasses import dataclass

import pytest

_APP = pathlib.Path(__file__).resolve().parents[1] / "app"
_TRACER = "langfuse_generation"

#: LiteLLM entry points that bill tokens.
_LITELLM_ENTRY_POINTS = frozenset(
    {
        "completion",
        "acompletion",
        "text_completion",
        "atext_completion",
        "embedding",
        "aembedding",
        "responses",
        "aresponses",
    }
)

#: Marks the function that POSTs to Gemini's embedding API.
_EMBED_ENDPOINTS = (":batchEmbedContents", ":embedContent")

#: ``(path, function)`` pairs left untraced on purpose. Listing one here says the
#: call is not model usage worth seeing in Langfuse.
_UNTRACED_ON_PURPOSE = frozenset(
    {
        # /health/full probes: a "ping" every ~30s would bury real generations.
        ("app/main.py", "_llm_probe"),
        ("app/main.py", "_run_gate_probe"),
    }
)


@dataclass(frozen=True)
class _CallSite:
    path: str
    line: int
    function: str
    call: str
    traced: bool

    def __str__(self) -> str:
        return f"{self.path}:{self.line} {self.call}"


def _litellm_aliases(tree: ast.Module) -> set[str]:
    """Names the ``litellm`` module is bound to in this file (``litellm``, ``_litellm`` …)."""
    aliases: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            aliases.update(alias.asname or alias.name for alias in node.names if alias.name == "litellm")
    return aliases


def _is_tracer_with(node: ast.AST) -> bool:
    if not isinstance(node, ast.With | ast.AsyncWith):
        return False
    for item in node.items:
        call = item.context_expr
        if isinstance(call, ast.Call):
            func = call.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name == _TRACER:
                return True
    return False


def _function_mentions_embed_endpoint(function: ast.AST) -> bool:
    return any(
        isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and any(endpoint in node.value for endpoint in _EMBED_ENDPOINTS)
        for node in ast.walk(function)
    )


def _guarded_call(call: ast.Call, litellm_names: set[str], in_embed_function: bool) -> str | None:
    func = call.func
    if not isinstance(func, ast.Attribute):
        return None
    if isinstance(func.value, ast.Name) and func.value.id in litellm_names and func.attr in _LITELLM_ENTRY_POINTS:
        return f"{func.value.id}.{func.attr}"
    if in_embed_function and func.attr == "post":
        return "gemini embedding POST"
    return None


def _collect(
    node: ast.AST,
    *,
    path: str,
    litellm_names: set[str],
    function: ast.AST | None,
    traced: bool,
    embed: bool,
    sites: list[_CallSite],
) -> None:
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda):
        # A tracer around a nested def does not trace calls made later through
        # that def, so tracing never crosses a function boundary.
        function, traced, embed = node, False, _function_mentions_embed_endpoint(node)
    elif _is_tracer_with(node):
        traced = True
    if isinstance(node, ast.Call):
        label = _guarded_call(node, litellm_names, embed)
        if label is not None:
            sites.append(
                _CallSite(
                    path=path,
                    line=node.lineno,
                    function=getattr(function, "name", "<module>"),
                    call=label,
                    traced=traced,
                )
            )
    for child in ast.iter_child_nodes(node):
        _collect(
            child,
            path=path,
            litellm_names=litellm_names,
            function=function,
            traced=traced,
            embed=embed,
            sites=sites,
        )


def _call_sites() -> list[_CallSite]:
    sites: list[_CallSite] = []
    for path in sorted(_APP.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        _collect(
            tree,
            path=str(path.relative_to(_APP.parent)),
            litellm_names=_litellm_aliases(tree),
            function=None,
            traced=False,
            embed=False,
            sites=sites,
        )
    return sites


_SITES = _call_sites()


def test_the_call_sites_are_still_there_to_check():
    """A guard on the guard. If the scan stops matching, the parametrized test
    below runs on an empty list and protects nothing."""
    calls = {(site.path, site.call) for site in _SITES}
    assert ("app/services/llm_service.py", "litellm.completion") in calls
    assert ("app/services/llm_service.py", "litellm.acompletion") in calls
    assert ("app/services/gemini_embedding.py", "gemini embedding POST") in calls
    assert ("app/main.py", "_litellm.completion") in calls
    assert len(_SITES) >= 12


@pytest.mark.parametrize("site", _SITES, ids=str)
def test_every_model_call_is_traced_or_exempt(site: _CallSite):
    if (site.path, site.function) in _UNTRACED_ON_PURPOSE:
        return
    assert site.traced, (
        f"{site} (in {site.function}) calls a model outside a `with {_TRACER}(...)` block, so its tokens and "
        "cost never reach Langfuse. Wrap it and record the response with `gen.record_litellm(response)`, or, "
        "if it is deliberately not model usage, add it to _UNTRACED_ON_PURPOSE with the reason."
    )


def test_the_exemptions_are_not_stale():
    untraced = {(site.path, site.function) for site in _SITES if not site.traced}
    assert untraced >= _UNTRACED_ON_PURPOSE, "an exempt call is gone or now traced; drop its exemption"
