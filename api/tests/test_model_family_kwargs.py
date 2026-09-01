"""Thinking models must be told not to think when the budget is one word.

A reasoning model spends output tokens on hidden thinking BEFORE it emits any
visible text, so a small ``max_tokens`` returns an empty string rather than a
short answer. `_apply_model_family_kwargs` already handled that for the gpt-5
family. Gemini 2.5 behaves identically and was not covered, which broke
"Detect from my site" on the Experience page:

    max_tokens=10, gemini-2.5-flash
      -> text=''  finish=MAX_TOKENS  thoughtsTokenCount=7

The answer is literally one token ("professional"). Seven tokens of thinking
consumed the whole cap, `classify_brand_tone` saw '' and returned None, and the
route 422'd "Couldn't detect a tone; pick one manually." Nothing was wrong with
the key, the credits or the content -- verified live: the same call with
thinking disabled returns "Professional" at the same cap.

`disable`, not `none`: `none` is the gpt-5.4 sentinel, and LiteLLM maps
`disable` to Gemini's `thinkingBudget: 0`. Confirmed against litellm 1.89.4 --
`thinking={"type": "disabled"}` is NOT honoured on this path and still returns
''.
"""

from __future__ import annotations

import pytest

from app.services.llm_service import _apply_model_family_kwargs


@pytest.mark.parametrize(
    "model",
    [
        "gemini/gemini-2.5-flash",
        "gemini/gemini-2.5-pro",
        "gemini-2.5-flash",
        "vertex_ai/gemini-2.5-flash",
    ],
)
def test_gemini_25_is_told_not_to_think(model):
    kwargs: dict = {"max_tokens": 10}
    _apply_model_family_kwargs(kwargs, model)
    assert kwargs["reasoning_effort"] == "disable"


@pytest.mark.parametrize("model", ["gemini/gemini-2.0-flash", "gemini/gemini-1.5-pro"])
def test_older_gemini_is_left_alone(model):
    # Not reasoning models. Sending the parameter would be noise at best and a
    # provider rejection at worst.
    kwargs: dict = {"max_tokens": 10}
    _apply_model_family_kwargs(kwargs, model)
    assert "reasoning_effort" not in kwargs


def test_an_explicit_choice_is_never_overridden():
    # `setdefault`, like the gpt-5 branches: a caller that deliberately wants
    # the model to reason must be able to say so.
    kwargs: dict = {"max_tokens": 2000, "reasoning_effort": "high"}
    _apply_model_family_kwargs(kwargs, "gemini/gemini-2.5-flash")
    assert kwargs["reasoning_effort"] == "high"


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("openai/gpt-5.4-mini", "none"),
        ("openai/gpt-5-mini", "minimal"),
        ("gemini/gemini-2.5-flash", "disable"),
    ],
)
def test_each_family_gets_its_own_sentinel(model, expected):
    # The three families reject each other's values, so one shared constant
    # would break two of the three.
    kwargs: dict = {}
    _apply_model_family_kwargs(kwargs, model)
    assert kwargs["reasoning_effort"] == expected


def test_a_non_reasoning_model_gets_nothing():
    kwargs: dict = {}
    _apply_model_family_kwargs(kwargs, "openai/gpt-4o-mini")
    assert kwargs == {}
