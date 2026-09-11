"""The suite-wide guard in ``conftest.py`` refuses real model calls.

A test that reaches LiteLLM's completion client without stubbing it fails, even
when the service it called swallowed the error and answered with a canned string.
"""

import threading

import litellm
import pytest

from app.services import llm_service
from tests.conftest import ALLOW_REAL_LLM_CALL, RealModelCallError


def test_a_sync_completion_call_is_refused_and_recorded(_no_real_llm_calls):
    with pytest.raises(RealModelCallError, match=ALLOW_REAL_LLM_CALL):
        litellm.completion(model="openai/gpt-test", messages=[])

    assert _no_real_llm_calls == [
        f"litellm.completion(model='openai/gpt-test') on thread {threading.current_thread().name!r}"
    ]
    # This test made the call on purpose; the guard would otherwise fail it at teardown.
    _no_real_llm_calls.clear()


@pytest.mark.asyncio
async def test_an_async_completion_call_is_refused_and_recorded(_no_real_llm_calls):
    with pytest.raises(RealModelCallError):
        await litellm.acompletion(model="openai/gpt-test", messages=[], stream=True)

    assert len(_no_real_llm_calls) == 1
    assert _no_real_llm_calls[0].startswith("litellm.acompletion(model='openai/gpt-test') on thread ")
    _no_real_llm_calls.clear()


def test_a_call_the_service_swallows_is_still_recorded(_no_real_llm_calls):
    """``generate_response_checked`` catches every provider error and returns a
    canned failure, so the raise alone would not fail the test that made it."""
    _text, failed = llm_service.generate_response_checked("hi", model="openai/gpt-test", timeout=1, num_retries=0)

    assert failed is True
    assert len(_no_real_llm_calls) == 1
    assert _no_real_llm_calls[0].startswith("litellm.completion(model='openai/gpt-test') on thread ")
    _no_real_llm_calls.clear()


@pytest.mark.allow_real_llm_call
def test_the_marker_leaves_the_real_client_in_place(_no_real_llm_calls):
    assert "_no_real_llm_calls" not in getattr(litellm.completion, "__qualname__", "")
    assert "_no_real_llm_calls" not in getattr(litellm.acompletion, "__qualname__", "")
