"""ARQ worker settings — configures the background task worker.

Start with: ``uv run arq app.worker.settings.WorkerSettings``

Redis connection is parsed from the same ``REDIS_URL`` env var used by the
API. Both ``redis://`` (loopback / plain TCP) and ``rediss://`` (TLS) DSNs
are handled natively by ARQ.
"""

import logging
import os

import litellm
from arq import cron
from arq.connections import RedisSettings

# Same fix as app/main.py — silently drop provider-unsupported params
# (e.g. temperature=0 on gpt-5 family) so background tasks that share
# llm_service.py (BANT extraction, brand-tone extraction, etc.) don't
# crash on UnsupportedParamsError. Must be set before app.worker.tasks
# is imported because tasks.py transitively imports llm_service.
litellm.drop_params = True

from app.worker.tasks import (  # noqa: E402  (litellm config must precede)
    task_deliver_webhook,
    task_expire_old_topups,
    task_ingest_documents,
    task_ingest_web_batch,
    task_process_webhook_retries,
    task_renew_due_subscriptions,
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


def _init_sentry_for_worker() -> None:
    """Initialise Sentry inside the ARQ worker process.

    The API process initialises Sentry in ``app.main`` at module load. The
    worker is a separate process (``arq`` CLI entry point) and never imports
    ``app.main``, so without this call background-task errors (BANT extraction,
    webhook delivery, email send, document ingestion) never reach Sentry —
    they only end up in ``journalctl`` on the droplet.

    Tagged as ``service: worker`` so events can be filtered apart from the API.
    """
    from app.config import APP_ENV, SENTRY_DSN, SENTRY_ENABLED

    if not SENTRY_ENABLED:
        logger.info("Sentry disabled in worker (no DSN configured)")
        return

    import sentry_sdk

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=APP_ENV,
        release=os.getenv("SENTRY_RELEASE") or None,
        send_default_pii=False,
        enable_logs=True,
        traces_sample_rate=0.1,
        profile_session_sample_rate=0.1,
        profile_lifecycle="trace",
    )
    sentry_sdk.set_tag("service", "worker")
    logger.info(f"Sentry error tracking enabled in worker | env={APP_ENV}")


async def startup(ctx: dict) -> None:
    """Called once when the worker starts. Initialize shared resources."""
    logging.basicConfig(level=logging.INFO)
    _init_sentry_for_worker()
    logger.info("OyeChats worker starting")

    # Emit a heartbeat immediately so /health turns green without waiting
    # for the first cron tick (cron fires at :00 and :30 of each minute,
    # so a post-deploy window of up to 30s would otherwise return 503).
    from app.worker.tasks import task_worker_heartbeat

    try:
        await task_worker_heartbeat(ctx)
    except Exception:
        logger.warning("initial worker heartbeat failed", exc_info=True)


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
        task_renew_due_subscriptions,
        task_expire_old_topups,
    ]

    # Cron jobs:
    # • webhook retry poll + worker heartbeat — every 30s
    # • subscription renewal safety net — once a day at 00:05 UTC
    # • top-up expiry sweep — once a day at 00:10 UTC (offset to avoid lock contention)
    cron_jobs = [
        cron(task_process_webhook_retries, second={0, 30}),
        cron(task_worker_heartbeat, second={0, 30}),
        cron(task_renew_due_subscriptions, hour=0, minute=5),
        cron(task_expire_old_topups, hour=0, minute=10),
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
