"""Enqueue helper — adds tasks to the ARQ queue from the API process.

Usage:
    from app.worker.enqueue import enqueue
    job = await enqueue("task_ingest_documents", client_id, folder_path, bot_id=bot_id)
    print(job.job_id)  # UUID string for status polling

For synchronous callers (webhook_service, email_service), use ``enqueue_sync()``.
"""

import asyncio
import logging
import os
import threading
from typing import Any

from arq import ArqRedis, create_pool
from arq.connections import RedisSettings

logger = logging.getLogger(__name__)

_pool: ArqRedis | None = None
_pool_lock = threading.Lock()

# Strong references to fire-and-forget enqueue tasks scheduled from sync
# callers inside an async context. Without this, the event loop holds only
# a weak reference and the task is garbage-collected mid-flight — the
# symptom is an "ERROR:asyncio:Task was destroyed but it is pending!" log
# line and the Redis enqueue never completing. Tasks auto-remove themselves
# via add_done_callback once finished.
_pending_enqueue_tasks: set[asyncio.Task[None]] = set()

# Feature flag: when False, callers fall back to their original behavior.
WORKER_ENABLED = os.getenv("WORKER_ENABLED", "false").lower() in ("1", "true", "yes")


def _get_redis_settings() -> RedisSettings:
    """Parse REDIS_URL into ARQ RedisSettings."""
    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        raise RuntimeError("REDIS_URL required for task queue")
    return RedisSettings.from_dsn(redis_url)


async def _get_pool() -> ArqRedis:
    """Lazy-init a shared ARQ Redis connection pool (async singleton)."""
    global _pool
    if _pool is None:
        _pool = await create_pool(
            _get_redis_settings(),
            default_queue_name="oyechats",
        )
    return _pool


async def enqueue(task_name: str, *args: Any, **kwargs: Any) -> Any:
    """Enqueue a task by name. Returns an ``arq.jobs.Job`` instance.

    The job_id can be used with ``get_job_status()`` for polling.
    Raises ``RuntimeError`` if the pool cannot be created.
    """
    pool = await _get_pool()
    job = await pool.enqueue_job(task_name, *args, **kwargs)
    if job is None:
        logger.warning("Task %s was deduplicated (already queued)", task_name)
        return None
    logger.info("Enqueued task %s → job_id=%s", task_name, job.job_id)
    return job


def enqueue_sync(task_name: str, *args: Any, **kwargs: Any) -> str | None:
    """Synchronous wrapper for callers outside an async context.

    Creates a temporary event loop if needed. Returns the job_id string
    or None if the task was deduplicated.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # We're inside an async context but called synchronously (e.g. from
        # a sync function called within an async route). Schedule in the
        # existing loop as a fire-and-forget task, holding a strong
        # reference so it isn't garbage-collected before the Redis enqueue
        # completes (which drops the job silently).

        async def _do_enqueue() -> None:
            try:
                await enqueue(task_name, *args, **kwargs)
            except Exception:
                logger.exception("enqueue_sync background task failed for %s", task_name)

        task = loop.create_task(_do_enqueue())
        _pending_enqueue_tasks.add(task)
        task.add_done_callback(_pending_enqueue_tasks.discard)
        # Don't block — return None and let the task fire async.
        # The job_id won't be available synchronously in this path.
        return None
    else:
        # No running loop — safe to run synchronously. We deliberately do
        # NOT reuse the module-level ``_pool`` here: ``asyncio.run`` creates
        # and closes a fresh event loop on every call, so a pool cached on
        # the first call's loop becomes a use-after-close hazard on every
        # subsequent call ("RuntimeError: Event loop is closed"). FastAPI
        # runs sync routes in a threadpool, which is exactly the path that
        # triggers this — the affiliate-invite email, the trial-welcome
        # email, anything fired via ``send_email_async`` from a sync
        # endpoint. Building + closing a per-call pool costs one extra
        # round-trip but keeps the contract intact.
        async def _run() -> Any:
            pool = await create_pool(_get_redis_settings(), default_queue_name="oyechats")
            try:
                job = await pool.enqueue_job(task_name, *args, **kwargs)
                if job is None:
                    logger.warning("Task %s was deduplicated (already queued)", task_name)
                    return None
                logger.info("Enqueued task %s → job_id=%s", task_name, job.job_id)
                return job
            finally:
                await pool.aclose()

        job = asyncio.run(_run())
        return job.job_id if job else None


async def get_job_status(job_id: str) -> dict[str, Any]:
    """Check the status of a queued/running/completed job.

    Returns a dict with: status, result, start_time, finish_time, etc.
    """
    from arq.jobs import Job, JobStatus

    pool = await _get_pool()
    job = Job(job_id, redis=pool, _queue_name="oyechats")
    info = await job.info()

    if info is None:
        return {"job_id": job_id, "status": "not_found"}

    status_map = {
        JobStatus.deferred: "queued",
        JobStatus.queued: "queued",
        JobStatus.in_progress: "in_progress",
        JobStatus.complete: "complete",
        JobStatus.not_found: "not_found",
    }

    result: dict[str, Any] = {
        "job_id": job_id,
        "status": status_map.get(info.status, str(info.status)),
        "function": info.function,
        "enqueue_time": info.enqueue_time.isoformat() if info.enqueue_time else None,
    }

    if info.start_time:
        result["start_time"] = info.start_time.isoformat()
    if info.finish_time:
        result["finish_time"] = info.finish_time.isoformat()
    if info.status == JobStatus.complete and info.result is not None:
        result["result"] = info.result
    if info.status == JobStatus.complete and not info.success:
        result["status"] = "failed"

    return result
