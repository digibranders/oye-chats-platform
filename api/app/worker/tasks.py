"""ARQ task functions — executed by the background worker process.

Each function receives an ARQ context dict as the first argument (``ctx``),
followed by the task-specific arguments. Functions must be async.

Naming convention: ``task_<action>`` — matches the string used in
``enqueue("task_<action>", ...)``.
"""

import logging

logger = logging.getLogger(__name__)


# ── Document Ingestion ──────────────────────────────────────────────────────


async def task_ingest_documents(ctx: dict, client_id: int, folder_path: str, bot_id: int | None = None) -> int:
    """Ingest documents from a folder (PDF, DOCX, TXT, MD).

    Calls the existing synchronous ``run_folder_ingestion()`` pipeline.
    Returns the number of files processed.
    """
    import asyncio

    from app.ingestion.pipeline import run_folder_ingestion

    logger.info("task_ingest_documents: client_id=%d, folder=%s, bot_id=%s", client_id, folder_path, bot_id)

    # run_folder_ingestion is synchronous — run in executor to avoid blocking
    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(
        None,
        lambda: run_folder_ingestion(client_id, folder_path, bot_id=bot_id),
    )

    logger.info("task_ingest_documents: completed, processed %d files", count)
    return count


async def task_ingest_web_batch(
    ctx: dict,
    client_id: int,
    pages: list[dict],
    bot_id: int | None = None,
) -> int:
    """Ingest a batch of web-crawled pages.

    Calls the existing synchronous ``batch_web_ingestion()`` pipeline.
    Returns the total number of chunks processed.
    """
    import asyncio

    from app.ingestion.pipeline import batch_web_ingestion

    logger.info("task_ingest_web_batch: client_id=%d, pages=%d, bot_id=%s", client_id, len(pages), bot_id)

    loop = asyncio.get_running_loop()
    chunk_count = await loop.run_in_executor(
        None,
        lambda: batch_web_ingestion(client_id, pages, bot_id=bot_id),
    )

    logger.info("task_ingest_web_batch: completed, %d chunks processed", chunk_count)
    return chunk_count


# ── Webhook Delivery ────────────────────────────────────────────────────────


async def task_deliver_webhook(
    ctx: dict, webhook_id: int, event_type: str, payload_data: dict, attempt: int = 1
) -> bool:
    """Deliver a single webhook. Returns True on success.

    On failure, ARQ's built-in retry (max_tries=3, exponential backoff)
    handles re-execution automatically.
    """
    import asyncio

    from app.services.webhook_service import _deliver_webhook

    logger.info("task_deliver_webhook: webhook_id=%d, event=%s, attempt=%d", webhook_id, event_type, attempt)

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        None,
        lambda: _deliver_webhook(webhook_id, event_type, payload_data, attempt),
    )

    return True


async def task_process_webhook_retries(ctx: dict) -> int:
    """Cron task: poll for due webhook retries and re-enqueue them.

    Replaces the old daemon thread retry worker. Runs every 30s via ARQ cron.
    """
    from app.services.webhook_service import process_pending_retries

    count = process_pending_retries()
    if count:
        logger.info("task_process_webhook_retries: re-queued %d retries", count)
    return count


# ── Credit lifecycle ────────────────────────────────────────────────────────


async def task_renew_due_subscriptions(ctx: dict) -> int:
    """Cron task: grant the new month's plan credits for subscriptions whose
    current_period_end is today.

    Stripe's ``invoice.paid`` webhook is the canonical trigger for renewals;
    this cron is a safety net that catches missed webhooks. The webhook handler
    is idempotent (skips when balance was already renewed in the same period),
    so running both is safe.

    Returns the number of subscriptions renewed.
    """
    import asyncio
    from datetime import UTC, datetime

    from sqlalchemy import func, select

    from app.db.models import CreditLedger, Subscription
    from app.db.session import get_session
    from app.services import credit_service

    def _renew() -> int:
        today_utc = datetime.now(UTC).date()
        renewed = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.status.in_(("active", "trialing")),
                        func.date(Subscription.current_period_end) == today_utc,
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                # Skip if a plan_grant already exists for today (webhook beat us to it).
                already_granted = (
                    session.execute(
                        select(func.count())
                        .select_from(CreditLedger)
                        .where(
                            CreditLedger.client_id == sub.client_id,
                            CreditLedger.reason == "plan_grant",
                            CreditLedger.delta > 0,
                            func.date(CreditLedger.created_at) == today_utc,
                        )
                    ).scalar()
                    or 0
                )
                if already_granted:
                    continue
                credit_service.reset_monthly_plan_credits(session, sub.client_id)
                credit_service.grant_for_subscription(session, sub)
                renewed += 1
            session.commit()
        return renewed

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _renew)
    if count:
        logger.info("task_renew_due_subscriptions: granted credits for %d subscription(s)", count)
    return count


async def task_expire_old_topups(ctx: dict) -> int:
    """Cron task: write off any unredeemed credits in top-up grants that are
    past their 12-month expiry. Runs daily; idempotent (already-expired grants
    are skipped).

    Returns the total number of credits expired across all clients.
    """
    import asyncio

    from app.db.session import get_session
    from app.services import credit_service

    def _expire() -> int:
        with get_session() as session:
            expired = credit_service.expire_old_topups(session)
            session.commit()
            return expired

    loop = asyncio.get_running_loop()
    total = await loop.run_in_executor(None, _expire)
    if total:
        logger.info("task_expire_old_topups: expired %d credit(s)", total)
    return total


# ── Worker Heartbeat ────────────────────────────────────────────────────────

WORKER_HEARTBEAT_KEY = "oyechats:worker:heartbeat"
WORKER_HEARTBEAT_TTL = 120  # seconds — 2× the cron interval, so a missed tick
#                              is still healthy but two missed ticks flag dead.


async def task_worker_heartbeat(ctx: dict) -> bool:
    """Cron task: write a freshness marker to Redis every 30s.

    The API ``/health`` endpoint reads this key — if it's missing or stale,
    the worker is considered unhealthy and the deploy/monitor can alert.
    """
    from datetime import UTC, datetime

    from app.core.cache import get_redis

    client = get_redis()
    if client is None:
        return False

    client.set(WORKER_HEARTBEAT_KEY, datetime.now(UTC).isoformat(), ex=WORKER_HEARTBEAT_TTL)
    return True


# ── Email Sending ───────────────────────────────────────────────────────────


async def task_send_email(
    ctx: dict,
    to_email: str,
    subject: str,
    html_body: str,
    reply_to: str | None = None,
    sender_name: str | None = None,
) -> bool:
    """Send a raw HTML email via Brevo. Returns True on success."""
    import asyncio

    from app.services.email_service import _send_brevo_email

    logger.info("task_send_email: to=%s, subject=%s", to_email, subject[:50])

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: _send_brevo_email(to_email, subject, html_body, reply_to=reply_to, sender_name=sender_name),
    )

    if not result:
        raise RuntimeError(f"Email delivery failed: to={to_email}, subject={subject[:50]}")

    return True


async def task_send_template_email(
    ctx: dict,
    to_email: str,
    template_id: int,
    params: dict | None = None,
    reply_to: str | None = None,
    sender_name: str | None = None,
) -> bool:
    """Send a Brevo template email. Returns True on success."""
    import asyncio

    from app.services.email_service import _send_brevo_template

    logger.info("task_send_template_email: to=%s, template=%d", to_email, template_id)

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: _send_brevo_template(to_email, template_id, params or {}, reply_to=reply_to, sender_name=sender_name),
    )

    if not result:
        raise RuntimeError(f"Template email delivery failed: to={to_email}, template={template_id}")

    return True
