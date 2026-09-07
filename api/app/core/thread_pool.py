"""Shared bounded thread pool for fire-and-forget background work.

All daemon threads (geolocation lookups, BANT extraction, etc.) MUST use
this pool instead of spawning unbounded ``threading.Thread`` instances.
With 2 uvicorn workers, this caps total background threads at 6 (3 per
worker), preventing thread explosion under burst traffic.
"""

import logging
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, wait
from typing import Any

import sentry_sdk

logger = logging.getLogger(__name__)

_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="oyechats-bg")

# Outbound email gets its own workers. The shared pool above runs the per-turn
# BANT extraction (an LLM call with a 45s timeout, retried on a second model)
# and the groundedness judge, so under a burst of chat turns its queue is
# minutes deep; a signup or password-reset code (15-minute expiry) submitted
# behind that arrived late or not at all. Four workers, sized for an HTTP call
# to Brevo, not an LLM. This pool is deliberately NOT touched by
# :func:`shutdown_pool`: a BANT task still running after the app's shutdown
# event sends the qualified-lead email from here, and the interpreter joins
# these workers at exit so anything already queued is still delivered.
_email_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="oyechats-email")

# Every task in flight, by future, with the name of what it runs. Kept so the
# pool can be DRAINED: the test harness truncates every table between tests,
# and a task from an earlier test still holding a transaction turned that
# truncate into an indefinite, silent wait. Production never drains (tasks are
# fire-and-forget by contract); it only pays a dict insert and a callback.
_inflight: dict[Future[None], str] = {}
_inflight_lock = threading.Lock()


def submit_background(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
    """Submit a function to the shared background thread pool.

    Failures are logged but never propagated. This is for non-critical
    fire-and-forget work only.

    Each task runs in its own forked Sentry scope. Three threads serve every
    caller of this function, and a pool thread is a long-lived
    ``threading.Thread``: Sentry's ThreadingIntegration forks the scope once,
    when the thread is created, and every task submitted afterwards then shared
    it, for the life of the process. So a breadcrumb left by a geolocation
    lookup for one visitor (``chat_routes._resolve_and_update_location``)
    attached itself to the next error raised by an unrelated task on the same
    thread, and ``webhook_service`` dispatches its deliveries (which do report
    errors to Sentry) into this same pool. Forking per task also means no task
    can inherit a live transaction from an earlier one, which is what keeps
    outbound geolocation URLs (visitor address in the path, vendor key in the
    query, recorded unsanitised by Sentry's StdlibIntegration) from being
    emitted as spans.

    Uninitialised Sentry is fine: forking a scope is pure bookkeeping and does
    not need a client, so this costs the same nothing in tests and local dev
    that it does in production, where the work it wraps is an HTTP round trip.
    """

    _submit(_pool, fn, args, kwargs)


def submit_email(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
    """Submit an outbound email send to the dedicated email pool.

    Same fire-and-forget contract as :func:`submit_background` (own Sentry
    scope, failures logged, tracked for the test harness's drain), on workers
    that never queue behind LLM work. Once the interpreter has begun shutting
    the executor down, a submit raises ``RuntimeError``; the send then runs on
    a plain thread instead of being dropped, which is what the caller was
    promised when it fired and forgot.
    """
    try:
        _submit(_email_pool, fn, args, kwargs)
    except RuntimeError:
        logger.warning("Email pool is shut down; sending %s on a fallback thread", getattr(fn, "__name__", fn))
        threading.Thread(target=_isolated(fn, args, kwargs), name="oyechats-email-fallback", daemon=True).start()


def _isolated(fn: Callable[..., Any], args: tuple, kwargs: dict) -> Callable[[], None]:
    def _wrapper() -> None:
        with sentry_sdk.isolation_scope():
            try:
                fn(*args, **kwargs)
            except Exception as exc:
                logger.warning(f"Background task {fn.__name__} failed: {exc}")

    return _wrapper


def _submit(pool: ThreadPoolExecutor, fn: Callable[..., Any], args: tuple, kwargs: dict) -> None:
    future = pool.submit(_isolated(fn, args, kwargs))
    name = getattr(fn, "__name__", repr(fn))
    with _inflight_lock:
        _inflight[future] = name

    def _forget(done: Future[None]) -> None:
        with _inflight_lock:
            _inflight.pop(done, None)

    future.add_done_callback(_forget)


def pending_background() -> list[str]:
    """Names of the tasks submitted and not yet finished, oldest first."""
    with _inflight_lock:
        return list(_inflight.values())


def drain_background(timeout: float) -> bool:
    """Wait up to ``timeout`` seconds for every submitted task to finish.

    Returns ``True`` when the pool is idle, ``False`` when something is still
    running when the time is up. It never raises and never cancels: the caller
    decides what an undrained pool means (the test harness fails the test and
    names the task; see :func:`pending_background`).
    """
    with _inflight_lock:
        futures = list(_inflight)
    if not futures:
        return True
    wait(futures, timeout=timeout)
    return all(f.done() for f in futures)


def shutdown_pool() -> None:
    """Gracefully drain the pool on application shutdown.

    Only the shared pool. The email pool stays open so a task still finishing
    here can send its notification; the interpreter joins it at exit.
    """
    _pool.shutdown(wait=False)
