"""ARQ worker settings. Configures the background task worker.

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

# Import app.config eagerly so its module-level load_dotenv() runs before
# _parse_redis_settings() (below) reads REDIS_URL at class-body time. Task
# modules only import app.config lazily inside function bodies, so without
# this the worker sees an empty environment and fails at import with
# "REDIS_URL is required".
import app.config  # noqa: F401

# Same fix as app/main.py. Silently drop provider-unsupported params
# (e.g. temperature=0 on gpt-5 family) so background tasks that share
# llm_service.py (BANT extraction, brand-tone extraction, etc.) don't
# crash on UnsupportedParamsError. Must be set before app.worker.tasks
# is imported because tasks.py transitively imports llm_service.
litellm.drop_params = True

from app.worker.tasks import (  # noqa: E402  (litellm config must precede)
    task_auto_recrawl_bot,
    task_auto_recrawl_sweep,
    task_capture_demo_screenshot,
    task_crawl_and_ingest,
    task_delete_expired_trial_data,
    task_deliver_webhook,
    task_dispatch_handoff_push,
    task_dispatch_offline_message_push,
    task_dispatch_transfer_push,
    task_dunning_emails,
    task_execute_pending_cancellations,
    task_expire_old_topups,
    task_expire_past_due_subscriptions,
    task_expire_trials,
    task_gateway_reconciliation,
    task_handoff_escalation,
    task_ingest_documents,
    task_ingest_web_batch,
    task_invoice_reconciliation_alert,
    task_probe_bot_installs,
    task_process_webhook_retries,
    task_promo_precharge_reminders,
    task_promote_scheduled_downgrades,
    task_prune_processed_webhooks,
    task_prune_stale_events,
    task_reconcile_orphaned_seat_addons,
    task_reembed_document,
    task_refresh_promo_free_credits,
    task_render_invoice_pdfs,
    task_renew_due_subscriptions,
    task_resolve_lead_company,
    task_send_email,
    task_send_quotation_visitor_email,
    task_send_template_email,
    task_send_visitor_message_email,
    task_trial_reminder_emails,
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
    webhook delivery, email send, document ingestion) never reach Sentry.
    They only end up in ``journalctl`` on the droplet.

    Tagged as ``service: worker`` so events can be filtered apart from the API.
    Production-only, same as the API. See ``app.config.sentry_enabled``.
    """
    from app.config import APP_ENV, SENTRY_DSN, SENTRY_ENABLED
    from app.core.sentry_scrub import scrub_event

    if not SENTRY_ENABLED:
        reason = f"APP_ENV={APP_ENV}, production only" if SENTRY_DSN else "no DSN configured"
        logger.info(f"Sentry disabled in worker ({reason})")
        return

    import sentry_sdk

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=APP_ENV,
        release=os.getenv("SENTRY_RELEASE") or None,
        send_default_pii=False,
        # Errors + light tracing only. Profiling and logs stay off on the free
        # plan. See the matching note in app/main.py.
        traces_sample_rate=0.1,
        # PRIVACY, the same scrubber the API installs. The worker serves no
        # HTTP request of its own, so it has no headers to strip today; it is
        # wired anyway so there is ONE place to audit what leaves for Sentry
        # rather than two that have to be kept in step, and so an ASGI-shaped
        # request block arriving here later (an inbound webhook replayed into a
        # task, a future HTTP entry point) is covered on arrival rather than
        # after someone notices. See ``app.core.sentry_scrub``.
        before_send=scrub_event,
        before_send_transaction=scrub_event,
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
        task_crawl_and_ingest,
        task_capture_demo_screenshot,
        task_probe_bot_installs,
        task_deliver_webhook,
        task_resolve_lead_company,
        task_send_email,
        task_send_template_email,
        task_renew_due_subscriptions,
        task_execute_pending_cancellations,
        task_refresh_promo_free_credits,
        task_promo_precharge_reminders,
        task_promote_scheduled_downgrades,
        task_expire_old_topups,
        task_expire_trials,
        task_trial_reminder_emails,
        task_delete_expired_trial_data,
        task_dunning_emails,
        task_expire_past_due_subscriptions,
        task_dispatch_handoff_push,
        task_dispatch_offline_message_push,
        task_dispatch_transfer_push,
        task_handoff_escalation,
        task_send_quotation_visitor_email,
        task_send_visitor_message_email,
        task_reembed_document,
        task_render_invoice_pdfs,
        task_invoice_reconciliation_alert,
        task_reconcile_orphaned_seat_addons,
        task_auto_recrawl_sweep,
        task_auto_recrawl_bot,
        task_prune_stale_events,
    ]

    # Cron jobs:
    # • webhook retry poll + worker heartbeat (every 30s
    # • pending-cancellation sweep) once a day at 00:03 UTC, BEFORE renewals
    # • subscription renewal safety net. Once a day at 00:05 UTC
    # • top-up expiry sweep. Once a day at 00:10 UTC (offset to avoid lock contention)
    # • trial expiry. Hourly at :15 so a customer whose trial ends at, say,
    #   13:42 UTC flips within ~30 min instead of waiting until midnight
    # • trial reminders. Once a day at 09:00 UTC (≈ business morning across
    #   IN/EU/US), so day-7 / day-11 / day-13 land at a useful hour
    # • data hard-delete. Once a day at 00:20 UTC, after renewals + top-up
    #   sweep so a same-day reactivation has a chance to rescue the data
    cron_jobs = [
        cron(task_process_webhook_retries, second={0, 30}),
        cron(task_worker_heartbeat, second={0, 30}),
        # Issue the irreversible Razorpay cancel for subscriptions the customer
        # cancelled and whose paid period is nearly over. Runs BEFORE the
        # renewal cron: a subscription ending today must be stopped at the
        # gateway before anything considers renewing it.
        cron(task_execute_pending_cancellations, hour=0, minute=3),
        cron(task_renew_due_subscriptions, hour=0, minute=5),
        # Launch-promo free-window credit refresh. Runs just after the renewal
        # cron. Grants each free month's credits for subs whose deferred charge
        # (and thus no ``subscription.charged``) means the renewal cron skips
        # them. Keyed on aligned free-month boundaries, so no double-grant.
        cron(task_refresh_promo_free_credits, hour=0, minute=6),
        # Scheduled-downgrade safety net. Runs after the renewal cron so a
        # row whose period just rolled forward via renewal isn't picked up
        # for promotion in the same tick. The Razorpay
        # ``subscription.completed`` webhook is the primary trigger; this
        # cron only catches missed webhooks.
        cron(task_promote_scheduled_downgrades, hour=0, minute=7),
        cron(task_expire_old_topups, hour=0, minute=10),
        cron(task_delete_expired_trial_data, hour=0, minute=20),
        # Webhook + billing telemetry retention (weekly, quiet hours): prunes
        # processed_webhooks past any realistic Razorpay retry horizon, plus
        # reconciliation_runs, billing_funnel_events, and the outbound
        # webhook_deliveries log, which holds visitor PII for 90 days.
        cron(task_prune_processed_webhooks, weekday=0, hour=1, minute=30),
        # Blueprint §7 safety net: daily diff of Razorpay captured payments /
        # live mandates against local invoices, grants and subscription rows.
        # 02:00 UTC. After the whole 00:0x billing cron train has settled.
        cron(task_gateway_reconciliation, hour=2, minute=0),
        cron(task_expire_trials, minute=15),
        cron(task_trial_reminder_emails, hour=9, minute=0),
        # Launch-promo pre-charge reminder, a working-hours send ~10 days before
        # the free period ends, so the first real charge is never a surprise.
        cron(task_promo_precharge_reminders, hour=9, minute=15),
        # Dunning auto-expire. Once a day at 00:25 UTC, after the trial
        # crons so a same-day card rescue beats the grace-elapsed cut.
        cron(task_expire_past_due_subscriptions, hour=0, minute=25),
        # Dunning cadence. 09:30 UTC = 15:00 IST, a working-hours send for
        # the Indian customer base, and deliberately hours AFTER the 00:25
        # expiry sweep so a subscription that dies today gets the suspension
        # email rather than a cadence email.
        cron(task_dunning_emails, hour=9, minute=30),
        # Invoice PDF sweep. Every 5 min; renders/uploads documents for
        # freshly finalized invoices (invoicing v2, no-op while flag is off).
        cron(task_render_invoice_pdfs, minute=set(range(1, 60, 5))),
        # Invoice anomaly sweep. Daily at 01:00 UTC, after the midnight
        # billing crons have settled.
        cron(task_invoice_reconciliation_alert, hour=1, minute=0),
        # Orphaned seat-add-on sweep. Daily at 01:20 UTC, offset from the
        # invoice anomaly sweep. Cancels ₹499/seat add-on subscriptions whose
        # parent plan is gone (best-effort inline cancels that failed, or a
        # cutover re-create stranded by a rolled-back activation).
        cron(task_reconcile_orphaned_seat_addons, hour=1, minute=20),
        # Auto-recrawl sweep. Hourly at :05. Fires ``task_auto_recrawl_bot``
        # for every bot whose ``next_recrawl_at`` has elapsed. Offset from
        # the :00/:30 webhook / heartbeat crons and the :01/… invoice-PDF
        # sweep so the minute boundary isn't concurrency-starved.
        cron(task_auto_recrawl_sweep, minute=5),
        # Stale-event pruning. Once a day at 00:35 UTC, after the midnight
        # billing crons have settled. Removes Event rows whose source page
        # no longer mentions them (customer took the event down) or whose
        # start date has aged past the retention window.
        cron(task_prune_stale_events, hour=0, minute=35),
    ]

    # Redis connection
    redis_settings = _parse_redis_settings()

    # Worker behavior
    # Default to 2 concurrent jobs on 2GB droplets. Increase to 5 on 4GB+.
    max_jobs = int(os.getenv("WORKER_MAX_JOBS", "5"))
    # ~27 min. Matches CRAWL_SUBPROCESS_TIMEOUT so ARQ never kills a crawl
    # that the subprocess itself is still allowed to run. Sized to fit
    # Standard plan's 1500-page advertised cap with margin and to give
    # large single-shot crawls a usable ceiling until auto-
    # segmentation (Tier 3) ships.
    job_timeout = int(os.getenv("WORKER_JOB_TIMEOUT", "1600"))
    # Max attempts for a job that raises arq.worker.Retry (e.g. email tasks.
    # Audit F13). Note: ARQ does NOT retry on a plain exception, only on Retry.
    # ``retry_defer`` was a no-op attribute (not an ARQ setting), the per-retry
    # backoff is set by the task via Retry(defer=...), so it has been removed.
    max_tries = 3

    # Lifecycle hooks
    on_startup = startup
    on_shutdown = shutdown

    # Queue name (namespace for multi-app Redis)
    queue_name = "oyechats"
