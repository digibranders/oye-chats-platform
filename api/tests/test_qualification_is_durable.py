"""Lead qualification survives a deploy.

BANT/MEDDIC extraction ran only on ``core.thread_pool.submit_background``: three
workers, an unbounded queue, and ``main.py`` shuts it down with
``wait=False``. Everything queued at restart was dropped, and with it the
turn's qualification signals, the ``tier_transition`` webhook and the
qualified-lead email. Lead scoring is a paid product; it cannot be the thing
that quietly stops during a release.

It now goes to ARQ, which is durable, and falls back to the pool only when no
worker is configured, which is local development.
"""

from __future__ import annotations

import ast
import inspect
import textwrap

from app.services import rag_service as rs

# One pipeline: ``rag_pipeline`` is a collector over the streaming one, so
# the wiring below only has one place left to live.
PIPELINES = (rs.rag_pipeline_stream,)


def _calls_named(fn, name: str) -> list[ast.Call]:
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == name
    ]


class TestTheTurnIsQueuedDurably:
    def test_extraction_is_not_left_on_the_pool(self):
        for fn in PIPELINES:
            for call in _calls_named(fn, "submit_background"):
                first = ast.unparse(call.args[0]) if call.args else ""
                assert first != "_background_bant_extraction", (
                    f"{fn.__name__} still queues qualification on the non-durable pool"
                )

    def test_it_uses_the_shared_enqueue_helper(self):
        for fn in PIPELINES:
            assert _calls_named(fn, "_enqueue_qualification"), fn.__name__

    def test_the_call_site_passes_every_argument_the_task_needs(self):
        call = _calls_named(PIPELINES[0], "_enqueue_qualification")[0]
        rendered = [ast.unparse(a) for a in call.args]

        assert rendered[:5] == ["session_id", "cid", "bid", "history_context", "question"]
        assert rendered[5] in {"answer", "full_answer"}
        assert len(rendered) == 11, "the task's signature and the call site have drifted"


class TestTheTaskIsRegistered:
    def test_the_worker_knows_the_task(self):
        from app.worker.settings import WorkerSettings

        names = {getattr(f, "name", getattr(f, "__name__", "")) for f in WorkerSettings.functions}
        assert "task_extract_qualification" in names

    def test_the_task_name_matches_what_the_pipeline_enqueues(self):
        source = inspect.getsource(rs._enqueue_qualification)

        assert '"task_extract_qualification"' in source


class TestTheFallbackIsDeliberate:
    def test_it_falls_back_to_the_pool_when_no_worker_is_configured(self, monkeypatch):
        submitted: list = []
        monkeypatch.setattr(rs, "WORKER_ENABLED", False)
        monkeypatch.setattr(rs, "submit_background", lambda fn, *a, **k: submitted.append(fn))

        rs._enqueue_qualification("sess", 1, 2, "", "q", "a", {}, {}, 3)

        assert submitted == [rs._background_bant_extraction]

    def test_it_enqueues_when_a_worker_is_configured(self, monkeypatch):
        enqueued: list = []
        monkeypatch.setattr(rs, "WORKER_ENABLED", True)
        monkeypatch.setattr(rs, "enqueue_sync", lambda name, *a: enqueued.append(name))
        monkeypatch.setattr(rs, "submit_background", lambda *a, **k: pytest_fail())

        rs._enqueue_qualification("sess", 1, 2, "", "q", "a", {}, {}, 3)

        assert enqueued == ["task_extract_qualification"]

    def test_a_broken_queue_still_runs_the_work(self, monkeypatch):
        """A Redis outage must not silently lose the signals it was meant to
        protect."""
        submitted: list = []

        def boom(*_a, **_k):
            raise RuntimeError("redis is down")

        monkeypatch.setattr(rs, "WORKER_ENABLED", True)
        monkeypatch.setattr(rs, "enqueue_sync", boom)
        monkeypatch.setattr(rs, "submit_background", lambda fn, *a, **k: submitted.append(fn))
        monkeypatch.setattr(rs, "_safety_net_metric", lambda *a, **k: None)

        rs._enqueue_qualification("sess", 1, 2, "", "q", "a", {}, {}, 3)

        assert submitted == [rs._background_bant_extraction]


def pytest_fail():
    raise AssertionError("the pool must not be used when a worker is configured")
