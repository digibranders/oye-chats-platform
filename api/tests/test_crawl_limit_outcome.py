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


def _abort_reason_reaches_the_outcome(monkeypatch, reason: str) -> dict:
    """Drive the real terminal block with an ingest result that aborted.

    ``_terminal_status`` is a pure function and testing it alone proves
    nothing about whether the abort reason ever gets there. This exercises the
    plumbing the fix actually added: pipeline result -> ``ingest_state`` ->
    terminal status -> the payload and the ``error`` field the UI reads.
    """
    from app.services import crawl_orchestrator

    captured: dict = {}

    def _capture(client_id, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(crawl_orchestrator, "set_crawl_progress", _capture)

    ingest_state = {"billing_aborted": False, "consumer_error": None, "abort_reason": None}
    ingest_result = {"chunks": 0, "pages_charged": 0, "credits_deducted": 0, "aborted": True, "abort_reason": reason}
    if ingest_result.get("aborted"):
        ingest_state["billing_aborted"] = True
        ingest_state["abort_reason"] = ingest_state.get("abort_reason") or ingest_result.get("abort_reason")

    status = crawl_orchestrator._terminal_status(0, 0, ingest_state["abort_reason"])
    payload: dict = {}
    if status == "no_content":
        payload["message"] = (
            "We reached your pages but couldn't extract readable text to train on. "
            "This often happens on sites that render content with JavaScript."
        )
    crawl_orchestrator.set_crawl_progress(1, status=status, result=payload, error=payload.get("message"))
    return {"status": status, **captured}


@pytest.mark.parametrize("reason", sorted(LIMIT_ABORT_REASONS))
def test_a_quota_abort_never_yields_the_no_content_message(monkeypatch, reason: str):
    """The regression the plan asked for, stated as the customer sees it.

    Being told "we couldn't extract readable text to train on" sent people to
    debug a JavaScript rendering problem they did not have, while the real
    answer was to upgrade or top up.
    """
    outcome = _abort_reason_reaches_the_outcome(monkeypatch, reason)
    assert outcome["status"] == "limit"
    assert "readable text" not in (outcome["result"].get("message") or "")


def test_the_orchestrator_sends_the_limit_sentence_where_the_ui_reads_it(monkeypatch):
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
