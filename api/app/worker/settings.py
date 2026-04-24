"""ARQ worker settings — configures the background task worker.

Start with: ``uv run arq app.worker.settings.WorkerSettings``

Redis connection is parsed from the same ``REDIS_URL`` env var used by the
API.  Upstash uses ``rediss://`` (TLS) which ARQ handles natively.
"""

import logging
import os

from arq import cron
from arq.connections import RedisSettings

from app.worker.tasks import (
    task_deliver_webhook,
    task_ingest_documents,
    task_ingest_web_batch,
    task_process_webhook_retries,
    task_send_email,
    task_send_template_email,
    task_worker_heartbeat,
)

logger = logging.getLogger(__name__)


def _parse_redis_settings() -> RedisSettings:
    """Parse ``REDIS_URL`` into ARQ-compatible ``RedisSettings``."""
    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        raise RuntimeError("REDIS_URL is required for the worker. Set it in .env.")
    return RedisSettings.from_dsn(redis_url)


async def startup(ctx: dict) -> None:
    """Called once when the worker starts. Initialize shared resources."""
    logging.basicConfig(level=logging.INFO)
    logger.info("OyeChats worker starting")


async def shutdown(ctx: dict) -> None:
    """Called once when the worker shuts down. Clean up resources."""
    logger.info("OyeChats worker shutting down")


class WorkerSettings:
    """ARQ worker configuration."""

    # Task functions the worker can execute
    functions = [
        task_ingest_documents,
        task_ingest_web_batch,
        task_deliver_webhook,
        task_send_email,
        task_send_template_email,
    ]

    # Cron jobs — poll for webhook retries every 30s (replaces the daemon thread)
    # and emit a heartbeat at the same cadence so /health can detect a dead worker.
    cron_jobs = [
        cron(task_process_webhook_retries, second={0, 30}),
        cron(task_worker_heartbeat, second={0, 30}),
    ]

    # Redis connection
    redis_settings = _parse_redis_settings()

    # Worker behavior
    # Default to 2 concurrent jobs on 2GB droplets. Increase to 5 on 4GB+.
    max_jobs = int(os.getenv("WORKER_MAX_JOBS", "2"))
    job_timeout = int(os.getenv("WORKER_JOB_TIMEOUT", "600"))  # 10 min
    max_tries = 3
    retry_defer = True  # Exponential backoff on retry

    # Lifecycle hooks
    on_startup = startup
    on_shutdown = shutdown

    # Queue name (namespace for multi-app Redis)
    queue_name = "oyechats"
