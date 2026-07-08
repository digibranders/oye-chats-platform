"""Tests for the embedding-backfill worker task (AR-44).

Before this, batches ran strictly sequentially — batch N+1 waited for batch
N's full embed+commit even though each embed_chunks() call is itself
internally concurrent and the shared project-wide rate limiter already
paces actual request volume regardless of how many concurrent batches are
in flight. These tests pin: batches within one concurrency window run
concurrently (not one-at-a-time), a single bad batch doesn't abort the run
or corrupt other batches' counts, and the final summary counts are correct
across multiple windows.
"""

import asyncio
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from app.worker.tasks import _REEMBED_CONCURRENT_BATCHES, task_reembed_all_documents


@contextmanager
def _session_ctx(session):
    yield session


def _make_null_embedding_session(doc_ids, contents_by_id):
    """A session whose .execute() answers both queries this task issues:
    the initial NULL-embedding id scan, and each batch's id+content fetch."""
    session = MagicMock()

    def fake_execute(stmt, params=None):
        sql = str(stmt)
        result = MagicMock()
        if "SELECT id FROM documents WHERE embedding IS NULL" in sql:
            result.fetchall.return_value = [(i,) for i in doc_ids]
        elif "SELECT id, content FROM documents WHERE id = ANY" in sql:
            ids = params["ids"]
            result.fetchall.return_value = [(i, contents_by_id[i]) for i in ids]
        else:
            result.fetchall.return_value = []
        return result

    session.execute.side_effect = fake_execute
    return session


class TestConcurrentBatchWindows:
    @pytest.mark.asyncio
    async def test_batches_within_a_window_run_concurrently(self, monkeypatch):
        """The exact AR-44 regression target: with 2 batches and a window of
        3, both batches' embed calls must be in flight at the same time, not
        one waiting for the other to fully finish first."""
        doc_ids = list(range(1, 11))  # 10 docs
        contents_by_id = {i: f"content-{i}" for i in doc_ids}
        session = _make_null_embedding_session(doc_ids, contents_by_id)

        in_flight = []
        max_concurrent = 0

        async def fake_embed_via_to_thread(contents):
            in_flight.append(1)
            nonlocal max_concurrent
            max_concurrent = max(max_concurrent, len(in_flight))
            await asyncio.sleep(0.02)  # hold the slot so overlap is observable
            in_flight.pop()
            return [[0.1] for _ in contents]

        async def fake_to_thread(func, *args):
            # embed_chunks is called via asyncio.to_thread(embed_chunks, contents)
            return await fake_embed_via_to_thread(*args)

        with (
            patch("app.db.session.get_session", side_effect=lambda: _session_ctx(session)),
            patch("asyncio.to_thread", side_effect=fake_to_thread),
        ):
            result = await task_reembed_all_documents({}, batch_size=5)

        # 10 docs / batch_size=5 -> 2 batches, both fit in one window of 3.
        assert max_concurrent == 2
        assert result == {"total": 10, "succeeded": 10, "failed": 0}

    @pytest.mark.asyncio
    async def test_one_failing_batch_does_not_abort_or_corrupt_other_batches(self, monkeypatch):
        doc_ids = list(range(1, 11))
        contents_by_id = {i: f"content-{i}" for i in doc_ids}
        session = _make_null_embedding_session(doc_ids, contents_by_id)

        async def fake_to_thread(func, contents):
            # First batch (ids 1-5) fails; second batch (ids 6-10) succeeds.
            if contents[0] == "content-1":
                raise RuntimeError("embed API error")
            return [[0.1] for _ in contents]

        with (
            patch("app.db.session.get_session", side_effect=lambda: _session_ctx(session)),
            patch("asyncio.to_thread", side_effect=fake_to_thread),
        ):
            result = await task_reembed_all_documents({}, batch_size=5)

        assert result == {"total": 10, "succeeded": 5, "failed": 5}

    @pytest.mark.asyncio
    async def test_more_batches_than_the_concurrency_window_still_all_complete(self, monkeypatch):
        """5 batches with a window of _REEMBED_CONCURRENT_BATCHES (3) must
        process in multiple windows and still account for every document."""
        batch_size = 2
        num_batches = _REEMBED_CONCURRENT_BATCHES + 2  # forces >1 window
        doc_ids = list(range(1, num_batches * batch_size + 1))
        contents_by_id = {i: f"content-{i}" for i in doc_ids}
        session = _make_null_embedding_session(doc_ids, contents_by_id)

        async def fake_to_thread(func, contents):
            return [[0.1] for _ in contents]

        with (
            patch("app.db.session.get_session", side_effect=lambda: _session_ctx(session)),
            patch("asyncio.to_thread", side_effect=fake_to_thread),
        ):
            result = await task_reembed_all_documents({}, batch_size=batch_size)

        assert result == {"total": len(doc_ids), "succeeded": len(doc_ids), "failed": 0}

    @pytest.mark.asyncio
    async def test_no_documents_to_embed(self, monkeypatch):
        session = _make_null_embedding_session([], {})

        with patch("app.db.session.get_session", return_value=_session_ctx(session)):
            result = await task_reembed_all_documents({}, batch_size=50)

        assert result == {"total": 0, "succeeded": 0, "failed": 0}
