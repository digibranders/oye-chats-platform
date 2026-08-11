"""The two RAG quality gates must be able to produce output at all.

Both call an LLM for a tiny JSON verdict and both are deliberately fail-open:
any exception means "let the answer through". That is the right posture — a
gate outage must not break chat — and it is exactly why this went unnoticed.

`GATE_MODEL` defaults to `gemini/gemini-2.5-flash`, a REASONING model: it
spends output tokens thinking before emitting any text. Both gates capped
`max_tokens` at 20, so the whole budget went to reasoning and the content came
back empty. Measured against the live API:

    max_tokens=20   content=''                completion=17   reasoning=17  text=0
    max_tokens=200  content='{"score": 1.0}'  completion=116  reasoning=108 text=8
    thinking off,
    max_tokens=20   content='{"score":1}'     completion=5    reasoning=none

The call SUCCEEDS every time — nothing raises — so the empty string failed JSON
parsing and both gates fell through to fail-open on every request. Production
logged 41 consecutive failures across both gates, at a perfect 1:1 ratio,
visible only as a WARNING.

These tests pin the two properties that make output possible at all. They
cannot verify the vendor's behaviour without calling it, so they assert the
request we send — which is the part we control and the part that was wrong.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.services import groundedness_gate, relevance_gate


def _response(content: str) -> MagicMock:
    """A minimal litellm response carrying `content`."""
    response = MagicMock()
    response.choices = [MagicMock(message=MagicMock(content=content))]
    return response


def _invoke(module) -> dict:
    """Run the gate for real against a stubbed vendor, return the request kwargs.

    Asserting on the REQUEST, not on the module source: an earlier version of
    this file parsed `max_tokens=` out of the source text and matched the
    number inside a comment. The request is what the vendor actually sees.
    """
    verdict = '{"score": 0.9}'
    chunks = [{"text": "We build AI chatbots.", "score": 0.5}]

    with (
        patch.object(module.litellm, "completion", return_value=_response(verdict)) as completion,
        # No cache, so the gate is forced to make the call.
        patch.object(module, "cache_get", return_value=None, create=True),
    ):
        if module is relevance_gate:
            module.check_relevance("what are your services", chunks)
        else:
            module.check_groundedness("what are your services", "We build chatbots.", chunks)

    assert completion.call_count == 1, "the gate did not reach the vendor"
    return completion.call_args.kwargs


GATES = (
    pytest.param(relevance_gate, id="relevance"),
    pytest.param(groundedness_gate, id="groundedness"),
)


@pytest.mark.parametrize("module", GATES)
def test_the_gate_disables_reasoning(module):
    """A gate is a cheap classification; reasoning tokens are pure waste here,
    and at a small budget they crowd out the answer entirely."""
    kwargs = _invoke(module)

    assert kwargs.get("reasoning_effort") == "disable", (
        "without this, a reasoning GATE_MODEL spends the whole token budget thinking and returns an empty string"
    )


@pytest.mark.parametrize("module", GATES)
def test_the_token_budget_can_hold_the_verdict(module):
    """20 was the budget that caused the outage. Truncation reads as a parse
    failure, which reads as fail-open, which reads as no gate at all."""
    kwargs = _invoke(module)

    assert kwargs["max_tokens"] >= 32, f"max_tokens={kwargs['max_tokens']} leaves no room for the verdict"


@pytest.mark.parametrize("module", GATES)
def test_an_empty_response_still_fails_open(module):
    """The exact production symptom: the vendor returns '' and the call does
    NOT raise. The gate must let the answer through rather than block chat —
    that posture is why this bug was survivable, and it stays."""
    chunks = [{"text": "We build AI chatbots.", "score": 0.5}]

    with (
        patch.object(module.litellm, "completion", return_value=_response("")),
        patch.object(module, "cache_get", return_value=None, create=True),
    ):
        if module is relevance_gate:
            passed, score = module.check_relevance("q", chunks)
        else:
            passed, score = module.check_groundedness("q", "a", chunks)

    assert passed is True, "a gate outage must never block an answer"
    assert score == 1.0
