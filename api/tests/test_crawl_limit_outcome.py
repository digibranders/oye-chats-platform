"""A crawl stopped by a limit must not be reported as unreadable content.

When ingestion aborts because the customer ran out of credits or hit their
plan's knowledge-character ceiling, the crawl ends with nothing indexed. That
looked identical to a JS-rendered site the HTTP fetch could not read, so the
customer was told "we couldn't extract readable text to train on" and sent to
troubleshoot a rendering problem they do not have, while the real answer was to
upgrade or top up.

Pure-Python: the terminal-status decision is a function of counts and the abort
reason, so no database and no crawl are involved.
"""

from __future__ import annotations

import pytest

from app.services.crawl_orchestrator import LIMIT_ABORT_REASONS, _terminal_status


def test_no_content_still_means_no_content():
    """An unaborted crawl that indexed nothing is still the rendering case."""
    assert _terminal_status(0, 0, None) == "no_content"


def test_a_crawl_that_indexed_something_is_done():
    assert _terminal_status(12, 0, None) == "done"
    assert _terminal_status(0, 40, None) == "done"


@pytest.mark.parametrize("reason", sorted(LIMIT_ABORT_REASONS))
def test_a_limit_abort_with_nothing_indexed_reports_a_limit(reason: str):
    assert _terminal_status(0, 0, reason) == "limit"


@pytest.mark.parametrize("reason", sorted(LIMIT_ABORT_REASONS))
def test_a_limit_abort_that_still_indexed_pages_is_done(reason: str):
    """Partial success is success. The pages that landed are real knowledge."""
    assert _terminal_status(12, 0, reason) == "done"
    assert _terminal_status(0, 40, reason) == "done"


def test_an_unrecognised_abort_reason_does_not_claim_a_limit():
    """Only the reasons that ARE limits may produce the upgrade message.

    A cancellation or an unknown abort must fall back to the honest
    no-content answer rather than telling the customer to buy something.
    """
    assert _terminal_status(0, 0, "cancelled") == "no_content"


def test_the_limit_reasons_are_the_ones_the_pipeline_can_report():
    """Guards the two ends of the contract drifting apart."""
    from app.ingestion.pipeline import ABORT_REASON_CREDITS, ABORT_REASON_KILL_SWITCH, ABORT_REASON_KNOWLEDGE_QUOTA

    assert frozenset({ABORT_REASON_CREDITS, ABORT_REASON_KNOWLEDGE_QUOTA, ABORT_REASON_KILL_SWITCH}) == (
        LIMIT_ABORT_REASONS
    )


def _drive_terminal_block(monkeypatch, reason: str | None) -> dict:
    """Run the orchestrator's REAL terminal block for one abort reason.

    The previous version of this helper re-implemented the block inline and
    copied only its ``no_content`` branch, so the payload was always empty and
    the "does not say readable text" assertion compared against "". It passed
    with the production limit branch deleted. This executes the actual source
    of the block, so deleting either branch changes the answer.
    """
    import ast
    import inspect
    import textwrap

    from app.services import crawl_orchestrator

    source = inspect.getsource(crawl_orchestrator.run_full_crawl)
    tree = ast.parse(textwrap.dedent(source))
    block: list[ast.stmt] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Call)
            and getattr(node.value.func, "id", None) == "_terminal_status"
        ):
            parent = next(
                body for body in (getattr(n, "body", []) for n in ast.walk(tree)) if any(stmt is node for stmt in body)
            )
            start = parent.index(node)
            block = parent[start : start + 2]
            break
    assert len(block) == 2, "could not locate the terminal-status block in run_full_crawl"

    namespace: dict = {
        "_terminal_status": crawl_orchestrator._terminal_status,
        "total_chunks": 0,
        "bot_content_count": 0,
        "ingest_state": {"abort_reason": reason},
        "result_payload": {},
        "ABORT_REASON_CREDITS": crawl_orchestrator.ABORT_REASON_CREDITS,
        "ABORT_REASON_KILL_SWITCH": crawl_orchestrator.ABORT_REASON_KILL_SWITCH,
        "ABORT_REASON_KNOWLEDGE_QUOTA": crawl_orchestrator.ABORT_REASON_KNOWLEDGE_QUOTA,
    }
    exec(compile(ast.Module(body=block, type_ignores=[]), "<terminal-block>", "exec"), namespace)  # noqa: S102
    return {"status": namespace["crawl_status"], "payload": namespace["result_payload"]}


@pytest.mark.parametrize("reason", sorted(LIMIT_ABORT_REASONS))
def test_a_quota_abort_never_yields_the_no_content_message(monkeypatch, reason: str):
    """The regression the plan asked for, stated as the customer sees it.

    Being told "we couldn't extract readable text to train on" sent people to
    debug a JavaScript rendering problem they did not have, while the real
    answer was to upgrade or top up.
    """
    outcome = _drive_terminal_block(monkeypatch, reason)
    assert outcome["status"] == "limit"
    message = outcome["payload"].get("message") or ""
    assert message, "a limit outcome must carry a sentence of its own"
    assert "readable text" not in message
    assert outcome["payload"].get("limit_reason") == reason


def test_an_unaborted_empty_crawl_still_gets_the_rendering_message(monkeypatch):
    outcome = _drive_terminal_block(monkeypatch, None)
    assert outcome["status"] == "no_content"
    assert "readable text" in (outcome["payload"].get("message") or "")


def test_the_orchestrator_sends_the_limit_sentence_where_the_ui_reads_it():
    """``result`` alone is not enough: the banner reads ``error``.

    Written into the result payload only, the specific sentence naming WHICH
    limit was reached never reached a customer.
    """
    import inspect

    from app.services import crawl_orchestrator

    source = inspect.getsource(crawl_orchestrator.run_full_crawl)
    assert 'error=result_payload.get("message") if crawl_status == "limit" else None' in source, (
        "the limit sentence must travel in `error`, the only field CrawlContext surfaces"
    )
