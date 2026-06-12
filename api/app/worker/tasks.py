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
