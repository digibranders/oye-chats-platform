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


async def task_crawl_and_ingest(
    ctx: dict,
    client_id: int,
    bot_id: int | None,
    url: str,
    max_pages: int | None,
    use_js: bool,
    replace_source: str | None,
    cost_per_page: int,
    max_depth: int | None = None,
    concurrency: int | None = None,
    **_unused_kwargs,
) -> dict:
    """Run a full website crawl + ingestion pipeline in the background.

    Decouples the crawl (Playwright + Chromium, multi-minute, memory-heavy)
    from the HTTP request that triggered it. The route handler enqueues this
    task and returns 202 immediately; the worker owns the lock for the
    duration of the crawl and publishes terminal status to Redis so the
    frontend can pick it up via ``GET /crawl/progress``.

    The trailing ``max_depth`` / ``concurrency`` params are plan-aware crawl
    knobs added with the per-tier limits work. They're defaulted so jobs
    enqueued by an older API node (mid-rolling-deploy) still execute — they'll
    just use the subprocess env defaults instead of the caller's plan-tier
    values. ``**_unused_kwargs`` swallows legacy ``js_max_pages`` payloads
    enqueued by API nodes deployed before the route layer began clamping
    ``max_pages`` to the JS tier directly — keeps a rolling deploy safe.

    Returns the same payload that the legacy synchronous ``POST /crawl``
    used to return (so it's also visible via ``GET /ingest/status/{job_id}``
    once the job completes).
    """
    from app.services.crawl_orchestrator import run_full_crawl

    logger.info(
        "task_crawl_and_ingest: client_id=%d, bot_id=%s, url=%s, max_pages=%s, use_js=%s, max_depth=%s, concurrency=%s",
        client_id,
        bot_id,
        url,
        max_pages,
        use_js,
        max_depth,
        concurrency,
    )

    return await run_full_crawl(
        client_id=client_id,
        bot_id=bot_id,
        url=url,
        max_pages=max_pages,
        use_js=use_js,
        replace_source=replace_source,
        cost_per_page=cost_per_page,
        max_depth=max_depth,
        concurrency=concurrency,
    )


async def task_ingest_web_batch(
    ctx: dict,
    client_id: int,
    pages: list[dict],
    bot_id: int | None = None,
    cost_per_page: int = 0,
    deduct_reason: str = "url_scan",
    deduct_reference_id: int | None = None,
) -> dict:
    """Ingest a batch of web-crawled pages.

    Calls the existing synchronous ``batch_web_ingestion()`` pipeline.
    Returns ``{"chunks": int, "pages_charged": int, "credits_deducted": int}``.
    When ``cost_per_page`` is greater than zero, per-page credit deductions
    occur in the same DB transaction as the chunk inserts.
    """
    import asyncio

    from app.ingestion.pipeline import batch_web_ingestion

    logger.info("task_ingest_web_batch: client_id=%d, pages=%d, bot_id=%s", client_id, len(pages), bot_id)

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: batch_web_ingestion(
            client_id,
            pages,
            bot_id=bot_id,
            cost_per_page=cost_per_page,
            deduct_reason=deduct_reason,
            deduct_reference_id=deduct_reference_id,
        ),
    )

    logger.info(
        "task_ingest_web_batch: completed, %d chunks processed (charged: %d page(s), %d credit(s))",
        result["chunks"],
        result["pages_charged"],
        result["credits_deducted"],
    )
    return result


# ── Embedding Backfill ──────────────────────────────────────────────────────


async def task_reembed_all_documents(ctx: dict, batch_size: int = 50) -> dict:
    """Re-embed all documents using the current embed_chunks() provider.

    Run this once after the a1b2c3d4e5f6 migration to backfill 768-dim vectors
    for every document that has a NULL embedding (i.e. all rows post-migration).

    Returns a summary dict with total, succeeded, and failed counts.
    """
    import asyncio

    from sqlalchemy import text

    from app.db.database import SessionLocal
    from app.ingestion.embedder import embed_chunks

    logger.info("task_reembed_all_documents: starting (batch_size=%d)", batch_size)

    total = succeeded = failed = 0

    with SessionLocal() as session:
        # Fetch IDs of all documents with NULL embedding in ascending order.
        id_rows = session.execute(text("SELECT id FROM documents WHERE embedding IS NULL ORDER BY id")).fetchall()
        doc_ids = [r[0] for r in id_rows]

    total = len(doc_ids)
    logger.info("task_reembed_all_documents: %d documents to embed", total)

    for batch_start in range(0, total, batch_size):
        batch_ids = doc_ids[batch_start : batch_start + batch_size]

        with SessionLocal() as session:
            rows = session.execute(
                text("SELECT id, content FROM documents WHERE id = ANY(:ids)"),
                {"ids": batch_ids},
            ).fetchall()

        contents = [r[1] for r in rows]

        try:
            embeddings = await asyncio.to_thread(embed_chunks, contents)
        except Exception as exc:
            logger.error(
                "task_reembed_all_documents: batch starting id=%d failed — %s: %s",
                batch_ids[0],
                type(exc).__name__,
                exc,
            )
            failed += len(batch_ids)
            continue

        with SessionLocal() as session:
            for row, embedding in zip(rows, embeddings, strict=True):
                emb_str = "[" + ",".join(str(v) for v in embedding) + "]"
                session.execute(
                    text("UPDATE documents SET embedding = CAST(:emb AS vector) WHERE id = :id"),
                    {"emb": emb_str, "id": row[0]},
                )
            session.commit()

        succeeded += len(batch_ids)
        logger.info(
            "task_reembed_all_documents: %d/%d done (failed=%d)",
            succeeded,
            total,
            failed,
        )

    logger.info(
        "task_reembed_all_documents: complete — total=%d succeeded=%d failed=%d",
        total,
        succeeded,
        failed,
    )
    return {"total": total, "succeeded": succeeded, "failed": failed}


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
    current_period_end has been reached, then roll the period forward.

    Stripe's ``invoice.paid`` webhook is the canonical trigger for renewals;
    this cron is a safety net that catches missed webhooks (and is the *only*
    trigger for free-tier subs, since no payment ever fires there). The
    webhook handler is idempotent (skips when balance was already renewed in
    the same period), so running both is safe.

    Two important behaviours:

    1. **Catch-up**: the query matches every sub whose ``current_period_end``
       is in the past, not just "today" — so a sub that fell behind because
       the worker was down for days still gets exactly one renewal here
       (we advance one period and stop; the next run will catch the rest).
       The old "== today_utc" filter caused free subs to silently freeze
       after one missed renewal.

    2. **Roll forward**: after the grant we set
       ``current_period_start = old_end`` and
       ``current_period_end = add_months(old_end, 1)``. Without this the row
       never advances and the cron either re-fires every day (if matched on
       date) or stops firing forever (if matched on equality).

    Returns the number of subscriptions renewed.
    """
    import asyncio
    from datetime import UTC, datetime

    from sqlalchemy import func, select

    from app.core.dates import add_months
    from app.db.models import CreditLedger, Subscription
    from app.db.session import get_session
    from app.services import credit_service

    def _renew() -> int:
        now_utc = datetime.now(UTC)
        today_utc = now_utc.date()
        renewed = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.status.in_(("active", "trialing")),
                        Subscription.current_period_end <= now_utc,
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                # Period length matches the subscription's billing cycle.
                # The old code hard-coded ``1`` here, which silently renewed
                # annual subscriptions every month — twelve credit grants
                # per paid year and a customer-facing billing surprise.
                # ``billing_cycle`` is normalised to ``"monthly"`` / ``"annual"``
                # at sub creation; anything else falls through to monthly so
                # legacy / manual rows don't get stuck.
                period_months = 12 if (sub.billing_cycle or "").lower() == "annual" else 1
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
                    # Still need to roll the period forward — without this the
                    # cron would keep matching the same row every day.
                    sub.current_period_start = sub.current_period_end
                    sub.current_period_end = add_months(sub.current_period_end, period_months)
                    continue
                credit_service.reset_monthly_plan_credits(session, sub.client_id)
                credit_service.grant_for_subscription(session, sub)
                sub.current_period_start = sub.current_period_end
                sub.current_period_end = add_months(sub.current_period_end, period_months)
                renewed += 1
            session.commit()
        return renewed

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _renew)
    if count:
        logger.info("task_renew_due_subscriptions: granted credits for %d subscription(s)", count)
    return count


async def task_promote_scheduled_downgrades(ctx: dict) -> int:
    """Cron: promote subscriptions whose scheduled downgrade cutover has passed.

    Razorpay's ``subscription.completed`` webhook is the canonical trigger;
    this cron is a safety net for webhook outages and for the manual / Stripe
    legacy paths that don't emit ``completed`` cleanly. Both routes call into
    ``transition_service.promote_scheduled_change``, which is idempotent — if
    the webhook already promoted the row the cron's match-set is empty.

    Runs daily a few minutes after the renewal cron so we don't race a
    period roll-forward against a scheduled change cutover. Rows whose
    cutover is more than a day in the future are ignored.

    Returns the number of subscriptions promoted this run.
    """
    import asyncio
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.db.models import Subscription
    from app.db.session import get_session
    from app.services import transition_service

    def _run() -> int:
        now = datetime.now(UTC)
        promoted = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.scheduled_change_at.is_not(None),
                        Subscription.scheduled_change_at <= now,
                        # Only promote rows that are still alive — don't
                        # resurrect a row a human / webhook already finalised.
                        Subscription.status.in_(("active", "trialing", "past_due")),
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                try:
                    result = transition_service.promote_scheduled_change(session, sub)
                except Exception:
                    # Don't kill the loop on one bad row — log and skip so
                    # the rest of the queue still gets processed.
                    logger.exception(
                        "task_promote_scheduled_downgrades: failed for sub_id=%s",
                        sub.id,
                    )
                    continue
                if result is not None:
                    promoted += 1
            session.commit()
        return promoted

    loop = asyncio.get_running_loop()
    total = await loop.run_in_executor(None, _run)
    if total:
        logger.info("task_promote_scheduled_downgrades: promoted %d subscription(s)", total)
    return total


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


# ── Trial lifecycle (PR4) ───────────────────────────────────────────────────
#
# Three crons keep the free-trial flow honest:
#
# * ``task_expire_trials``           — hourly. Flips trialing → trial_expired
#                                      the moment ``trial_end`` lapses, sets
#                                      the 15-day data retention timestamp,
#                                      fires the "trial ended" email.
# * ``task_trial_reminder_emails``   — daily. Sends day-7 / day-11 / day-13
#                                      reminders to every trialing customer,
#                                      idempotent via ``trial_emails_sent``.
# * ``task_delete_expired_trial_data`` — daily. Hard-deletes bots / docs /
#                                      sessions for trial_expired subs once
#                                      ``data_retention_until`` is reached.
#
# All three use a sync inner function dispatched to a thread executor (the
# pattern matches ``task_renew_due_subscriptions``) so they can use the
# blocking SQLAlchemy session shape the rest of the codebase ships.


def _mark_email_sent(sub, key: str, when) -> None:
    """Idempotency marker — set ``trial_emails_sent[key] = ts``.

    JSONB columns on SQLAlchemy don't auto-detect in-place mutation; we
    rebuild the dict so the change actually flushes. Cheap, correct,
    survives every cron-vs-cron race we can throw at it.
    """
    existing = dict(sub.trial_emails_sent or {})
    existing[key] = when.isoformat()
    sub.trial_emails_sent = existing


async def task_expire_trials(ctx: dict) -> int:
    """Cron: flip trialing subscriptions whose ``trial_end`` has lapsed.

    Idempotent — the ``status`` filter naturally excludes already-expired
    rows on the next tick. The "trial ended" email fires once per
    subscription (gated by ``trial_emails_sent.trial_ended``); if the
    Brevo call fails the cron retries on the next tick.

    Returns the number of subscriptions that flipped this run.
    """
    import asyncio
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.config import TRIAL_DATA_RETENTION_DAYS
    from app.db.models import Client, Subscription
    from app.db.session import get_session
    from app.services.email_service import send_trial_ended_email

    def _run() -> int:
        now = datetime.now(UTC)
        retention_window = timedelta(days=TRIAL_DATA_RETENTION_DAYS)
        flipped = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.status == "trialing",
                        Subscription.trial_end.is_not(None),
                        Subscription.trial_end < now,
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                trial_end = sub.trial_end
                if trial_end.tzinfo is None:
                    trial_end = trial_end.replace(tzinfo=UTC)

                sub.status = "trial_expired"
                sub.data_retention_until = trial_end + retention_window

                # Email the workspace owner outside the transaction. We
                # snapshot the values we need first (owner row may live in
                # a separate query) and fire after commit.
                owner = session.get(Client, sub.client_id)
                plan_name = sub.plan.name if sub.plan else "your trial plan"

                if not (sub.trial_emails_sent or {}).get("trial_ended") and owner:
                    try:
                        send_trial_ended_email(
                            owner.email,
                            name=owner.name,
                            plan_name=plan_name,
                            data_retention_until=sub.data_retention_until,
                        )
                        _mark_email_sent(sub, "trial_ended", now)
                    except Exception as exc:
                        logger.warning(
                            "task_expire_trials: ended email failed for client %s: %s",
                            sub.client_id,
                            exc,
                        )
                flipped += 1
            session.commit()
        return flipped

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_expire_trials: flipped %d subscription(s) to trial_expired", count)
    return count


async def task_trial_reminder_emails(ctx: dict) -> int:
    """Cron: day-7 / day-11 / day-13 reminder cadence.

    Runs once a day; for every still-trialing subscription it computes
    ``days_remaining = ceil((trial_end - now) / 1 day)`` and fires the
    matching email if its marker isn't set. We use the day-bucket as the
    idempotency key so a customer who started a trial mid-day still gets
    every reminder on the right calendar day rather than 24h later.

    Returns the number of emails sent across all subscriptions.
    """
    import asyncio
    import math
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.db.models import Client, Subscription
    from app.db.session import get_session
    from app.services.email_service import send_trial_day_7_email, send_trial_days_left_email

    # ``key`` doubles as the slot in ``trial_emails_sent`` and as the
    # discriminator for which template fires. Order matters only for the
    # log line — the lookup is keyed by ``days_remaining``.
    cadence: dict[int, tuple[str, str]] = {
        # days_remaining → (marker_key, template)
        # day-7 of a 14-day trial → 7 days remaining
        7: ("day_7", "day_7"),
        # day-11 of a 14-day trial → 3 days remaining
        3: ("day_11", "days_left"),
        # day-13 of a 14-day trial → 1 day remaining
        1: ("day_13", "days_left"),
    }

    def _run() -> int:
        now = datetime.now(UTC)
        sent = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.status == "trialing",
                        Subscription.trial_end.is_not(None),
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                trial_end = sub.trial_end
                if trial_end.tzinfo is None:
                    trial_end = trial_end.replace(tzinfo=UTC)
                # ceil so a trial that ends in 0.5 days still counts as
                # "1 day left" rather than 0 — keeps the day-13 warning
                # accurate when fired in the customer's morning.
                seconds_left = (trial_end - now).total_seconds()
                if seconds_left <= 0:
                    continue
                days_remaining = max(1, math.ceil(seconds_left / 86400))

                slot = cadence.get(days_remaining)
                if slot is None:
                    continue
                marker_key, template = slot
                if (sub.trial_emails_sent or {}).get(marker_key):
                    continue

                owner = session.get(Client, sub.client_id)
                if owner is None:
                    continue
                plan_name = sub.plan.name if sub.plan else "your trial plan"

                try:
                    if template == "day_7":
                        send_trial_day_7_email(
                            owner.email,
                            name=owner.name,
                            days_remaining=days_remaining,
                            plan_name=plan_name,
                        )
                    else:
                        send_trial_days_left_email(
                            owner.email,
                            name=owner.name,
                            days_remaining=days_remaining,
                            plan_name=plan_name,
                        )
                    _mark_email_sent(sub, marker_key, now)
                    sent += 1
                except Exception as exc:
                    logger.warning(
                        "task_trial_reminder_emails: %s send failed for client %s: %s",
                        marker_key,
                        sub.client_id,
                        exc,
                    )
            session.commit()
        return sent

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_trial_reminder_emails: dispatched %d reminder(s)", count)
    return count


async def task_delete_expired_trial_data(ctx: dict) -> int:
    """Cron: hard-delete bots/documents/sessions after the retention window.

    The expiry cron sets ``data_retention_until`` when status flips to
    ``trial_expired``; once that timestamp lapses we drop every Bot owned
    by the workspace (FK cascades take down Document, ChatSession,
    ChatMessage, LeadInfo, BANTSignal, etc.) and mark the Client as
    deactivated so it never appears in any "active customers" report.

    The Client row itself stays — we keep the email and the deletion
    marker for support / audit. A future GDPR-erasure endpoint can
    fully purge it on explicit request.

    Returns the number of subscriptions processed this run.
    """
    import asyncio
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.db.models import Bot, Client, Subscription
    from app.db.session import get_session
    from app.services.email_service import send_trial_data_deleted_email

    def _run() -> int:
        now = datetime.now(UTC)
        deleted = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.status == "trial_expired",
                        Subscription.data_retention_until.is_not(None),
                        Subscription.data_retention_until < now,
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                owner = session.get(Client, sub.client_id)
                if owner is None:
                    continue

                # Owner already deactivated → already processed. Skip and
                # let the marker rest; we don't want to re-fire the email.
                if owner.deactivated_at is not None and (sub.trial_emails_sent or {}).get("data_deleted"):
                    continue

                # Wipe bot-rooted data. ondelete='CASCADE' on Document,
                # ChatSession, etc. takes care of the children.
                bot_rows = session.execute(select(Bot).where(Bot.client_id == owner.id)).scalars().all()
                for bot in bot_rows:
                    session.delete(bot)
                owner.deactivated_at = now

                try:
                    send_trial_data_deleted_email(owner.email, name=owner.name)
                    _mark_email_sent(sub, "data_deleted", now)
                except Exception as exc:
                    logger.warning(
                        "task_delete_expired_trial_data: deleted email failed for client %s: %s",
                        owner.id,
                        exc,
                    )
                deleted += 1
            session.commit()
        return deleted

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_delete_expired_trial_data: purged %d workspace(s)", count)
    return count


# ── Dunning auto-expire ─────────────────────────────────────────────────────


async def task_expire_past_due_subscriptions(ctx: dict) -> int:
    """Cron: flip ``past_due`` subscriptions to ``expired`` once the dunning
    grace window has elapsed.

    Stripe and Razorpay both retry failed payments for ~7 days. Up to that
    point ``status = 'past_due'`` keeps the customer's full access so a
    rescued card resumes service without interruption. After
    ``PAYMENT_FAILED_GRACE_DAYS`` we stop bleeding LLM / credit cost on a
    customer who isn't paying — the same ``expired`` status the gates and
    the widget already understand kicks them out of write paths and into
    polite-offline mode on visitor traffic.

    Idempotent: the query filters on ``status='past_due'``, so a row that
    flipped on the previous tick is excluded from the next.

    Returns the number of subscriptions that expired this run.
    """
    import asyncio
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.config import PAYMENT_FAILED_GRACE_DAYS
    from app.db.models import Subscription
    from app.db.session import get_session

    def _run() -> int:
        now = datetime.now(UTC)
        grace = timedelta(days=PAYMENT_FAILED_GRACE_DAYS)
        cutoff = now - grace
        flipped = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.status == "past_due",
                        # Rows without a stamped anchor — webhook-only legacy
                        # data — are NOT touched here. They'll get the
                        # anchor on the next payment-failed event and the
                        # cron picks them up from there.
                        Subscription.past_due_since.is_not(None),
                        Subscription.past_due_since < cutoff,
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                sub.status = "expired"
                # Surface the dunning end-of-life in canceled_at so the
                # billing UI's "Canceled on" badge has a date to render.
                # cancel_reason distinguishes this from a customer-initiated
                # cancel for support / analytics.
                if sub.canceled_at is None:
                    sub.canceled_at = now
                if not sub.cancel_reason:
                    sub.cancel_reason = "dunning_grace_elapsed"
                flipped += 1
            session.commit()
        return flipped

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_expire_past_due_subscriptions: expired %d subscription(s)", count)
    return count


# ── Web Push (operator notifications) ───────────────────────────────────────
#
# Two tasks drive the push pipeline:
#
# * ``task_dispatch_handoff_push`` — runs immediately when a visitor enters
#   the live-chat queue. Picks eligible operators (right department + under
#   max_concurrent_chats) who are NOT currently watching the dashboard via
#   WebSocket, and fans out a "new chat waiting" push to every subscription
#   they own. Also schedules its own ``task_handoff_escalation`` so a
#   black-holed chat doesn't leave the visitor staring at a spinner forever.
#
# * ``task_handoff_escalation`` — runs deferred (e.g. +20s). If the session
#   is still in ``waiting`` (no operator accepted), it cancels remaining
#   notifications on the operators' devices (tag-replace with "Chat ended")
#   so they don't tap a stale alert later. The visitor's queue-timeout
#   handler (``LiveChatService._start_timeout``) drives the actual fallback
#   UX; this task is purely cleanup.
#
# * ``task_send_visitor_message_email`` — fires when a visitor messages a
#   session that has no operator assigned (status="waiting"). Debounced by a
#   per-session marker in Redis so a chatty visitor doesn't flood the inbox.


async def task_dispatch_handoff_push(
    ctx: dict,
    session_id: str,
    bot_id: int,
    department_id: int | None,
    visitor_name: str | None,
    reason: str | None,
    queue_timeout_seconds: int,
) -> int:
    """Fan out a Web Push to every eligible operator who isn't currently on WS.

    Returns the total number of push deliveries (across all operators × all
    their subscribed devices). Zero is a valid outcome and just means no
    eligible operator had a subscription.
    """
    import asyncio

    from sqlalchemy import select

    from app.db.models import Bot, Operator
    from app.db.session import SessionLocal
    from app.services.live_chat_service import manager
    from app.services.push_service import send_push_to_client, send_push_to_operator

    logger.info(
        "task_dispatch_handoff_push: session=%s bot=%d dept=%s",
        session_id,
        bot_id,
        department_id,
    )

    def _run() -> int:
        if SessionLocal is None:
            return 0
        connected = set(manager.operator_connections.keys())
        with SessionLocal() as db:
            bot = db.execute(select(Bot).where(Bot.id == bot_id)).scalar_one_or_none()
            if bot is None:
                return 0

            q = select(Operator).where(
                Operator.client_id == bot.client_id,
                Operator.is_accepting_chats.is_(True),
            )
            if department_id is not None:
                # Department-scoped: only operators in that department, plus
                # ones with no department (fallback pool, matches the WS
                # routing rule in live_chat_service._should_notify_operator).
                q = q.where((Operator.department_id == department_id) | (Operator.department_id.is_(None)))
            operators = db.execute(q).scalars().all()

            # Skip operators actively watching the dashboard — they got the
            # in-dashboard toast already. Push is the *fallback* channel.
            operator_targets = [op for op in operators if op.id not in connected]

            payload = {
                "type": "handoff_request",
                "title": f"New chat from {visitor_name or 'a visitor'}",
                "body": (reason or "Visitor wants to talk to your team.")[:140],
                "session_id": session_id,
                "bot_id": bot_id,
                "bot_name": bot.name,
                "department_id": department_id,
            }
            tag = f"handoff:{session_id}"

            total = 0
            for op in operator_targets:
                total += send_push_to_operator(db, op.id, payload, tag=tag)
            # Also fan out to the workspace owner — small teams where the
            # client login is the primary chat-taker rely on this to get
            # notified at all. The owner isn't tracked in ``operator_connections``
            # the same way operators are; we always push and let the SW's
            # tag-replace semantics handle the case where they happen to be
            # watching the dashboard in another tab.
            total += send_push_to_client(db, bot.client_id, payload, tag=tag)
            db.commit()
            if total == 0:
                logger.info(
                    "Handoff push delivered nothing for session=%s — no subscribers off-WS",
                    session_id,
                )
            return total

    loop = asyncio.get_running_loop()
    delivered = await loop.run_in_executor(None, _run)
    logger.info(
        "task_dispatch_handoff_push: delivered=%d session=%s",
        delivered,
        session_id,
    )
    return delivered


async def task_handoff_escalation(ctx: dict, session_id: str) -> bool:
    """Cleanup pass after the visitor queue-timeout window has elapsed.

    Asymmetric-timeout design (visitor 30s / operator no-hard-limit):

    The visitor's wait is capped at ~30s — they either get an operator or fall
    through to the offline form. The operator's on-device notification, by
    contrast, is allowed to **persist** (``requireInteraction=true`` in the SW)
    so a late-arriving operator can still tap it minutes later. This task
    fires at t≈timeout+1 to **upgrade** the original "new chat" notification
    into one of two helpful follow-ups based on what the visitor did:

    * Visitor submitted the offline form → "Chat moved to offline message"
      with ``click_url`` pointing the operator to ``/support?tab=messages``
      so a late tap lands them on the just-arrived message, not an empty
      chat that no longer exists.

    * Visitor cancelled / closed without leaving a message → "Chat no longer
      waiting" with ``click_url=/support`` so the operator at least lands on
      the right dashboard tab. The original session row is left intact for
      audit purposes; nothing to act on.

    Returns True when cleanup fired, False when the chat was already accepted
    (operator beat the timeout — no notification update needed).
    """
    import asyncio

    from sqlalchemy import select

    from app.db.models import ChatSession, OfflineMessage, Operator
    from app.db.session import SessionLocal
    from app.services.push_service import send_push_to_client, send_push_to_operators

    def _run() -> bool:
        if SessionLocal is None:
            return False
        with SessionLocal() as db:
            cs = db.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
            if cs is None or cs.status not in {"waiting", "closed"}:
                # Operator accepted (status="live") or the session reverted to
                # bot mode — nothing to clean up.
                return False

            # Did the visitor end up leaving an offline message? The widget
            # creates an OfflineMessage row when the queue timeout fires and
            # the visitor submits the fallback form. If we find one, the
            # late-operator notification should route to /support?tab=messages
            # so they land on the message instead of an empty chat.
            offline_msg = db.execute(
                select(OfflineMessage)
                .where(OfflineMessage.session_id == session_id)
                .order_by(OfflineMessage.created_at.desc())
                .limit(1)
            ).scalar_one_or_none()

            if offline_msg is not None:
                payload = {
                    "type": "handoff_moved_to_offline",
                    "title": f"Offline message from {offline_msg.visitor_name}",
                    "body": (offline_msg.message_body or "Visitor left a message.")[:140],
                    "session_id": session_id,
                    "offline_message_id": offline_msg.id,
                    # SW reads ``click_url`` and navigates here on tap. Same
                    # origin only — the SW's notificationclick handler validates
                    # this is a relative path before opening / focusing a tab.
                    "click_url": f"/support?tab=messages&message_id={offline_msg.id}",
                }
            else:
                payload = {
                    "type": "handoff_expired",
                    "title": "Chat no longer waiting",
                    "body": "The visitor left before an operator joined.",
                    "session_id": session_id,
                    "click_url": "/support",
                }

            tag = f"handoff:{session_id}"
            if cs.bot is not None:
                operators = db.execute(select(Operator).where(Operator.client_id == cs.bot.client_id)).scalars().all()
                send_push_to_operators(db, [op.id for op in operators], payload, tag=tag)
                send_push_to_client(db, cs.bot.client_id, payload, tag=tag)
            db.commit()
            return True

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run)


async def task_send_visitor_message_email(
    ctx: dict,
    session_id: str,
    bot_id: int,
    preview: str,
) -> bool:
    """Email the operator team when a waiting visitor sends a message.

    Caller is expected to have already debounced this — we don't re-check.
    Recipients come from the bot's ``handoff_request`` notification list, the
    same routing used previously for handoff emails. If the session has been
    accepted (status != "waiting") by the time this runs, we skip — the
    operator's already in the conversation.
    """
    import asyncio

    from sqlalchemy import select

    from app.db.models import Bot, ChatSession, LeadInfo
    from app.db.session import SessionLocal
    from app.services.email_service import (
        get_notification_recipients,
        send_handoff_request_email,
    )

    def _run() -> bool:
        if SessionLocal is None:
            return False
        with SessionLocal() as db:
            cs = db.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
            if cs is None or cs.status != "waiting":
                return False
            bot = db.execute(select(Bot).where(Bot.id == bot_id)).scalar_one_or_none()
            if bot is None or not getattr(bot, "email_on_handoff", True):
                return False
            recipients = get_notification_recipients(bot, "handoff_request")
            if not recipients:
                return False
            lead = db.execute(select(LeadInfo).where(LeadInfo.session_id == session_id)).scalar_one_or_none()
            contact = None
            if lead is not None:
                contact = {"name": lead.name, "email": lead.email, "phone": lead.phone}
            reply_to = getattr(bot, "reply_to_email", None)
            # Reuse the existing handoff-request template but with the visitor's
            # *actual message* as the reason — that's the whole signal a real
            # human is waiting to talk, not a stalled queue entry.
            for recipient in recipients:
                send_handoff_request_email(
                    recipient,
                    bot.name,
                    preview,
                    contact,
                    reply_to=reply_to,
                )
            return True

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run)
