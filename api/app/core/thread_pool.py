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

    def _wrapper() -> None:
        with sentry_sdk.isolation_scope():
            try:
                fn(*args, **kwargs)
            except Exception as exc:
                logger.warning(f"Background task {fn.__name__} failed: {exc}")

    future = _pool.submit(_wrapper)
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
    """Gracefully drain the pool on application shutdown."""
    _pool.shutdown(wait=False)
