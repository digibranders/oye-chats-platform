"""``POST /chat`` refunds the credit when the request is cancelled.

The credit is charged before the pipeline runs. ``TimeoutMiddleware`` cancels
the handler at 60 seconds, and ``asyncio.CancelledError`` is a
``BaseException``, so none of the ``except`` branches that refund on failure
ever saw it: the visitor got a 504 and stayed charged for it.

The handler is driven directly (unwrapped from the rate limiter) with every
blocking step stubbed, because what is under test is the exception path of
the coroutine, not the HTTP plumbing around it.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import Request

from app.api import chat_routes
from app.schemas.chat import ChatRequest


def _handler():
    """``limiter.limit`` wraps the coroutine with ``functools.wraps``, so the
    real endpoint is one ``__wrapped__`` down."""
    return chat_routes.chat_endpoint.__wrapped__


def _request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/chat", "headers": [], "query_string": b""})


def _bot() -> SimpleNamespace:
    return SimpleNamespace(id=7, client_id=3, name="bot", subscription_id=None)


@pytest.fixture
def refunds():
    """Every step before and after the pipeline is stubbed; the refund is a spy."""
    calls: list[tuple[int, int]] = []
    with (
        patch.object(chat_routes, "bot_subscription_status", lambda *a, **k: "active"),
        patch.object(chat_routes, "_deduct_ai_chat_credit_sync", lambda bot: 1),
        patch.object(chat_routes, "_refund_ai_chat_credit", lambda bot, cost: calls.append((bot.id, cost))),
        patch.object(chat_routes, "_parse_request_context", lambda req: ("203.0.113.9", "desktop")),
        patch.object(chat_routes, "_visitor_country_from_request", lambda req: None),
        patch.object(chat_routes, "_resolve_session_id", lambda sid, bot_id: "sess-1"),
        patch.object(chat_routes, "_resolve_visitor_language_and_update_session", lambda *a, **k: None),
        patch.object(chat_routes, "submit_background", lambda *a, **k: None),
    ):
        yield calls


def test_a_cancelled_pipeline_refunds_once_and_reraises(refunds):
    async def cancelled_pipeline(*a, **k):
        raise asyncio.CancelledError

    async def run():
        with patch.object(chat_routes, "collect_rag_pipeline", cancelled_pipeline):
            await _handler()(ChatRequest(question="hello"), _request(), _bot())

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(run())
    assert refunds == [(7, 1)]


def test_the_middleware_timeout_path_refunds(refunds):
    """The real shape: ``wait_for`` cancels the handler task while it is
    awaiting the pipeline, then waits for it to unwind."""

    async def slow_pipeline(*a, **k):
        await asyncio.sleep(30)
        return {"answer": "too late"}

    async def run():
        with patch.object(chat_routes, "collect_rag_pipeline", slow_pipeline):
            await asyncio.wait_for(_handler()(ChatRequest(question="hello"), _request(), _bot()), timeout=0.05)

    with pytest.raises(TimeoutError):
        asyncio.run(run())
    assert refunds == [(7, 1)]


def test_a_successful_turn_is_not_refunded(refunds):
    async def reply(*a, **k):
        return {"answer": "hi", "sources": []}

    async def run():
        with patch.object(chat_routes, "collect_rag_pipeline", reply):
            return await _handler()(ChatRequest(question="hello"), _request(), _bot())

    assert asyncio.run(run())["answer"] == "hi"
    assert refunds == []
