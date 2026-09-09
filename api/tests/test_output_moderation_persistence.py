"""A moderation-flagged answer must not be persisted or cached (AR-46).

`check_generated_answer_safety` is unit-tested on its own, and one pipeline
test asserts it is called off the event loop with a stub that always passes.
Nothing drove the stream with a FLAGGED answer, so the half that matters was
untested: the bytes are already on their way to the visitor and cannot be
recalled, and the entire point of the guard is that the flagged text does not
reach the database or the answer cache, where it would be replayed to the next
visitor who asks the same question.

The two skip conditions matter as much as the guard. If the leak guard already
fired, `full_answer` is a refusal and re-moderating it is wasted latency on
every turn; if the stream errored, there is no answer to judge.
"""

from __future__ import annotations

import pytest

from app.services import rag_service as rs
from tests.test_rag_pipeline_defects import (
    _anonymous_visitor,
    _Cache,
    _doc,
    _drive_stream,
    _make_bot,
    _make_client,
    _make_session,
    _messages,
    _stub_pipeline,
)

FLAGGED = "Our hours are 9 to 5."


def _flag_every_answer(monkeypatch) -> list:
    """Judge every answer unsafe, and report what was judged.

    Called AFTER ``_stub_pipeline``, which installs its own pass-through for
    this function. Patching first is silently overwritten, and the test then
    passes for the wrong reason.
    """
    seen: list = []

    def _reject(answer, **kwargs):
        seen.append((answer, kwargs))
        return False, "harassment"

    monkeypatch.setattr(rs, "check_generated_answer_safety", _reject)
    return seen


class TestAFlaggedAnswerIsNotKept:
    @pytest.mark.asyncio
    async def test_the_persisted_message_is_the_refusal(self, db, monkeypatch):
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-flag-1")
        _stub_pipeline(monkeypatch, chunks=(FLAGGED,), retrieved=(_doc("Acme opens at 9."),))
        _flag_every_answer(monkeypatch)

        await _drive_stream(bot, "when do you open", "sess-flag-1")

        stored = [m.content for m in _messages(db, "sess-flag-1", role="bot")]
        assert stored, "the turn must have been persisted"
        assert FLAGGED not in " ".join(stored)

    @pytest.mark.asyncio
    async def test_the_answer_cache_never_holds_it(self, db, monkeypatch):
        cache = _Cache()
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-flag-2")
        _stub_pipeline(monkeypatch, chunks=(FLAGGED,), retrieved=(_doc("Acme opens at 9."),), cache=cache)
        _flag_every_answer(monkeypatch)

        await _drive_stream(bot, "when do you open", "sess-flag-2")

        assert FLAGGED not in " ".join(str(v) for v in cache.store.values())

    @pytest.mark.asyncio
    async def test_the_guard_actually_ran(self, db, monkeypatch):
        """A guard on the guard: if the stub is never called, the two tests
        above pass for the wrong reason."""
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-flag-3")
        _stub_pipeline(monkeypatch, chunks=(FLAGGED,), retrieved=(_doc("Acme opens at 9."),))
        flagged = _flag_every_answer(monkeypatch)

        await _drive_stream(bot, "when do you open", "sess-flag-3")

        assert flagged, "check_generated_answer_safety was never reached"
        assert flagged[0][1].get("path") == "stream"


class TestTheGuardIsSkippedWhenThereIsNothingToJudge:
    @pytest.mark.asyncio
    async def test_a_failed_stream_is_not_moderated(self, db, monkeypatch):
        """``_stream_error`` means the generator raised part-way through, so
        what is in hand is a fragment plus an error notice, not an answer. A
        moderation call on that is a wasted 10s round trip on the turn the
        visitor is already having the worst experience of."""
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-flag-4")
        _stub_pipeline(monkeypatch, chunks=(FLAGGED,), retrieved=(_doc("Acme opens at 9."),))
        flagged = _flag_every_answer(monkeypatch)

        async def _explode(prompt, **kwargs):
            yield FLAGGED
            raise RuntimeError("the provider dropped the connection")

        monkeypatch.setattr(rs, "generate_response_stream", _explode)

        await _drive_stream(bot, "when do you open", "sess-flag-4")

        assert flagged == [], "an errored stream has no answer worth judging"


class TestTheCacheKeyIsNormalised:
    """AR-25. The normaliser is well tested as a pure function and nothing
    asserted the cache key is built from it, so it could be reverted to
    `question.lower().strip()` with the whole suite still green. The cost is a
    silent cache-miss rate, which is exactly the kind of regression that never
    gets noticed."""

    @pytest.mark.asyncio
    async def test_punctuation_and_quotes_do_not_change_the_key(self, db, monkeypatch):
        cache = _Cache()
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-key-1")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),), cache=cache)
        # Only an impersonal answer is cacheable at all: the default stub is a
        # returning visitor whose "Welcome back, Tester!" opener the cache is
        # required to refuse.
        _anonymous_visitor(monkeypatch)

        await _drive_stream(bot, "when do you open", "sess-key-1")
        first = set(cache.store)

        cache.store.clear()
        _make_session(db, bot, client, "sess-key-2")
        await _drive_stream(bot, "  When do you open???  ", "sess-key-2")

        assert first, "the first turn must have written a cache entry"
        assert set(cache.store) == first, "trailing punctuation and case must hash to the same key"

    @pytest.mark.asyncio
    async def test_a_different_question_gets_a_different_key(self, db, monkeypatch):
        cache = _Cache()
        client = _make_client(db)
        bot = _make_bot(db, client)
        _make_session(db, bot, client, "sess-key-3")
        _stub_pipeline(monkeypatch, retrieved=(_doc("Acme opens at 9."),), cache=cache)
        # Only an impersonal answer is cacheable at all: the default stub is a
        # returning visitor whose "Welcome back, Tester!" opener the cache is
        # required to refuse.
        _anonymous_visitor(monkeypatch)

        await _drive_stream(bot, "when do you open", "sess-key-3")
        first = set(cache.store)

        cache.store.clear()
        _make_session(db, bot, client, "sess-key-4")
        await _drive_stream(bot, "what do you charge", "sess-key-4")

        assert set(cache.store) != first
