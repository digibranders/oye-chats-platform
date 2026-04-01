"""Shared bounded thread pool for fire-and-forget background work.

All daemon threads (geolocation lookups, BANT extraction, etc.) MUST use
this pool instead of spawning unbounded ``threading.Thread`` instances.
With 2 uvicorn workers, this caps total background threads at 6 (3 per
worker), preventing thread explosion under burst traffic.
"""

import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

logger = logging.getLogger(__name__)

_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="oyechat-bg")


def submit_background(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
    """Submit a function to the shared background thread pool.

    Failures are logged but never propagated — this is for non-critical
    fire-and-forget work only.
    """

    def _wrapper() -> None:
        try:
            fn(*args, **kwargs)
        except Exception as exc:
            logger.warning(f"Background task {fn.__name__} failed: {exc}")

    _pool.submit(_wrapper)


def shutdown_pool() -> None:
    """Gracefully drain the pool on application shutdown."""
    _pool.shutdown(wait=False)
