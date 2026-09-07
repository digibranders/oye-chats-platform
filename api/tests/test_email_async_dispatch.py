"""``send_email_async`` / ``send_template_async`` without the ARQ worker.

Production sets ``WORKER_ENABLED`` and enqueues durably. Without the worker the
send goes to the dedicated email pool (``thread_pool.submit_email``): its
workers are joined at interpreter exit, so an email accepted seconds before a
restart is still delivered, and it is separate from the shared background pool
whose three workers run the per-turn LLM calls, so a signup or password-reset
code never waits behind a BANT extraction.
"""

from unittest.mock import patch

from app.services import email_service


def _run_dispatch(fn, *args, **kwargs):
    with (
        patch("app.worker.enqueue.WORKER_ENABLED", False),
        patch("app.core.thread_pool.submit_email") as submit,
        patch("app.core.thread_pool.submit_background") as shared,
    ):
        fn(*args, **kwargs)
    submit.assert_called_once()
    shared.assert_not_called()
    (work,), _ = submit.call_args
    assert callable(work)
    return work


def test_raw_email_uses_the_email_pool_without_the_worker():
    work = _run_dispatch(email_service.send_email_async, "to@example.com", "Subject", "<p>hi</p>", reply_to="r@x.io")
    with patch.object(email_service, "_send_raw_email") as send:
        work()
    send.assert_called_once_with(
        "to@example.com", "Subject", "<p>hi</p>", reply_to="r@x.io", sender_name=None, attachments=None
    )


def test_template_email_uses_the_email_pool_without_the_worker():
    work = _run_dispatch(email_service.send_template_async, "to@example.com", 7, {"k": "v"})
    with patch.object(email_service, "_send_brevo_template") as send:
        work()
    send.assert_called_once_with("to@example.com", 7, {"k": "v"}, reply_to=None, sender_name=None)


def test_worker_path_still_enqueues_durably():
    with (
        patch("app.worker.enqueue.WORKER_ENABLED", True),
        patch("app.worker.enqueue.enqueue_sync") as enqueue,
        patch("app.core.thread_pool.submit_email") as submit,
    ):
        email_service.send_email_async("to@example.com", "Subject", "<p>hi</p>")
    enqueue.assert_called_once()
    submit.assert_not_called()
