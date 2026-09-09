"""The relaxation's wiring, read from the pipeline's syntax tree.

``rag_service`` used to hold two hand-maintained copies of the chat pipeline,
and a guard added to one and not the other was this file's characteristic
failure. There is one copy now, and these tests pin its shape. The BEHAVIOUR is
covered by ``tests/test_on_scope_relax_behaviour.py``, which drives the
pipeline for real.

An AST walk rather than substring matching: a fixed-width slice of the source
confirms a token appears NEAR the call without confirming what it is bound to,
and it breaks when a comment is added above the arguments.
"""

from __future__ import annotations

import ast
import inspect
import textwrap

from app.services import rag_service as rs

# One pipeline: ``rag_pipeline`` is a collector over the streaming one, so
# the wiring below only has one place left to live.
PIPELINES = (rs.rag_pipeline_stream,)

#: Every conjunct the guard must require. ``or`` anywhere here would relax the
#: empty-retrieval case, which is the hallucination path it exists to keep shut.
_REQUIRED_CONJUNCTS = {
    "not _is_relevant",
    "not _trusted_cta",
    "not _answering_probe",
    "not _relax_topical",
    "bool(final_results)",
    "_question_is_clearly_on_scope(question, _company_name)",
}


def _tree(fn) -> ast.AST:
    return ast.parse(textwrap.dedent(inspect.getsource(fn)))


def _assignment(fn, name: str) -> ast.expr:
    for node in ast.walk(_tree(fn)):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return node.value
    raise AssertionError(f"{fn.__name__} has no `{name}` assignment")


def _names_used(fn, name: str) -> int:
    return sum(1 for node in ast.walk(_tree(fn)) if isinstance(node, ast.Name) and node.id == name)


class TestTheGuardHasTheRightShape:
    def test_it_exists(self):
        for fn in PIPELINES:
            assert _assignment(fn, "_relax_on_scope") is not None

    def test_every_conjunct_is_required_not_alternative(self):
        for fn in PIPELINES:
            value = _assignment(fn, "_relax_on_scope")
            assert isinstance(value, ast.BoolOp), f"{fn.__name__}: not a boolean expression"
            assert isinstance(value.op, ast.And), f"{fn.__name__}: uses `or`, which would relax an empty context"
            assert {ast.unparse(v) for v in value.values} == _REQUIRED_CONJUNCTS, fn.__name__

    def test_it_uses_the_strict_predicate_not_the_routing_one(self):
        """``_question_looks_on_scope`` fails soft by design: it matches bare
        pronouns and treats a script it cannot read as on-scope. That is right
        for choosing between two canned replies and wrong for deciding whether
        a rejected turn reaches the model."""
        for fn in PIPELINES:
            rendered = ast.unparse(_assignment(fn, "_relax_on_scope"))
            assert "_question_is_clearly_on_scope" in rendered, fn.__name__
            assert "_question_looks_on_scope" not in rendered, fn.__name__

    def test_there_is_only_one_place_for_it_to_live(self):
        """The guard used to exist in two hand-maintained copies. If a second
        pipeline reappears, this drift class comes back with it."""
        assert len(PIPELINES) == 1
        assert "_relax_on_scope" not in inspect.getsource(rs.rag_pipeline)


class TestTheGuardIsActuallyConsulted:
    def test_the_refusal_branch_reads_it(self):
        """Computed and ignored is how a relaxation lands green and does
        nothing: assigned once, read at least once more."""
        for fn in PIPELINES:
            assert _names_used(fn, "_relax_on_scope") >= 2, f"{fn.__name__} never reads the flag it computes"

    def test_it_is_counted(self):
        for fn in PIPELINES:
            assert "gate_relaxed_on_scope" in inspect.getsource(fn), fn.__name__


class TestTheEmptyContextPivotIsUntouched:
    """The deliberate limit of the relaxation: with nothing retrieved there is
    nothing to ground an answer in."""

    def test_the_empty_context_branch_still_exists(self):
        for fn in PIPELINES:
            src = inspect.getsource(fn)
            assert "not final_results" in src, fn.__name__
            assert "_no_info_pivot(" in src, fn.__name__


class TestTheGateCallWiring:
    """The judge must see the query retrieval ran, and the verdict must be
    keyed on the bot's current documents."""

    @staticmethod
    def _call(fn) -> tuple[list[ast.expr], dict[str, str]]:
        for node in ast.walk(_tree(fn)):
            if not isinstance(node, ast.Call):
                continue
            target = node.func
            args = list(node.args)
            if isinstance(target, ast.Attribute) and target.attr == "partial":
                if not (args and isinstance(args[0], ast.Name) and args[0].id == "check_relevance"):
                    continue
                args = args[1:]
            elif not (isinstance(target, ast.Name) and target.id == "check_relevance"):
                continue
            return args, {kw.arg: ast.unparse(kw.value) for kw in node.keywords if kw.arg}
        raise AssertionError(f"{fn.__name__} has no check_relevance call")

    def test_each_pipeline_judges_the_rewritten_query(self):
        for fn in PIPELINES:
            args, _kwargs = self._call(fn)
            assert ast.unparse(args[0]) == "search_query", fn.__name__

    def test_each_pipeline_keys_the_verdict_on_knowledge_state(self):
        for fn in PIPELINES:
            _args, kwargs = self._call(fn)
            assert kwargs.get("kb_version") == "_kb_version", fn.__name__

    def test_each_pipeline_widens_the_window_for_an_unranked_bundle(self):
        for fn in PIPELINES:
            _args, kwargs = self._call(fn)
            assert kwargs.get("max_chunks") == "len(final_results) if _use_cag_lite else None", fn.__name__

    def test_each_pipeline_computes_the_fingerprint(self):
        for fn in PIPELINES:
            src = inspect.getsource(fn)
            assert "knowledge_state_for_bot(" in src, fn.__name__
            assert "_kb_version = " in src, fn.__name__


class TestThePricingOptOutWiring:
    """Same class of bug: the opt-out is dead for every customer if either
    pipeline stops passing it."""

    @staticmethod
    def _kwargs(fn) -> dict[str, str]:
        for node in ast.walk(_tree(fn)):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "evaluate_pricing_gate"
            ):
                return {kw.arg: ast.unparse(kw.value) for kw in node.keywords if kw.arg}
        raise AssertionError(f"{fn.__name__} has no evaluate_pricing_gate call")

    def test_each_pipeline_passes_the_owner_setting(self):
        for fn in PIPELINES:
            assert self._kwargs(fn).get("answer_from_knowledge_base") == "_pricing_from_kb", fn.__name__

    def test_each_pipeline_reads_the_column(self):
        for fn in PIPELINES:
            assert "pricing_from_knowledge_base" in inspect.getsource(fn), fn.__name__
