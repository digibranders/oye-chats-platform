"""ARQ task functions. Executed by the background worker process.

Each function receives an ARQ context dict as the first argument (``ctx``),
followed by the task-specific arguments. Functions must be async.

Naming convention: ``task_<action>``. Matches the string used in
``enqueue("task_<action>", ...)``.
"""

import logging

logger = logging.getLogger(__name__)

# Upper bound on one dunning pass. Each due subscription costs a serial
# Razorpay fetch plus a Brevo hand-off, so an unbounded first-run batch (when
# every existing past_due row has an empty marker map) could outlive the ARQ
# job timeout. Oldest-first ordering means a truncated batch still serves the
# customers closest to suspension; the rest are picked up on the next tick.
DUNNING_BATCH_LIMIT = 200


# ── Document Ingestion ──────────────────────────────────────────────────────


async def task_ingest_documents(ctx: dict, client_id: int, folder_path: str, bot_id: int | None = None) -> int:
    """Ingest documents from a folder (PDF, DOCX, TXT, MD).

    Calls the existing synchronous ``run_folder_ingestion()`` pipeline.
    Returns the number of files processed.

    ``folder_path`` is a per-tenant scoped path (``documents/{client_id}/
    {bot_id}/``, ``_none`` when bot_id is None), produced by
    ``document_routes._tenant_documents_dir``. The scoping is a security
    boundary (P0-2): the sweep only ever sees this tenant's own files, so a
    job can never ingest or archive another tenant's pending uploads.
    """
    import asyncio

    from app.ingestion.pipeline import run_folder_ingestion

    logger.info("task_ingest_documents: client_id=%d, folder=%s, bot_id=%s", client_id, folder_path, bot_id)

    # run_folder_ingestion is synchronous, run in executor to avoid blocking
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
    ordered_urls: list[str] | None = None,
    force_reingest: bool = False,
    lock_token: str | None = None,
    **_unused_kwargs,
) -> dict:
    """Run a full website crawl + ingestion pipeline in the background.

    Decouples the crawl (Spider.cloud + Jina Reader, multi-minute, can involve
    hundreds of pages) from the HTTP request that triggered it. The route handler enqueues this
    task and returns 202 immediately; the worker owns the lock for the
    duration of the crawl and publishes terminal status to Redis so the
    frontend can pick it up via ``GET /crawl/progress``.

    The trailing ``max_depth`` / ``concurrency`` params are plan-aware crawl
    knobs added with the per-tier limits work. They're defaulted so jobs
    enqueued by an older API node (mid-rolling-deploy) still execute. They'll
    just use the subprocess env defaults instead of the caller's plan-tier
    values. ``**_unused_kwargs`` swallows legacy ``js_max_pages`` payloads
    enqueued by API nodes deployed before the route layer began clamping
    ``max_pages`` to the JS tier directly. Keeps a rolling deploy safe.

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
        ordered_urls=ordered_urls,
        force_reingest=force_reingest,
        # Ownership token for the per-client crawl lock: the orchestrator's
        # finally block releases with it so only this run can free the lock.
        # ``None`` for jobs enqueued by an older API node (rolling-deploy safe).
        lock_token=lock_token,
        # Stable across ARQ retries → per-page charge idempotency (finding H).
        crawl_job_id=ctx.get("job_id"),
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

    # ARQ stamps a stable job_id that survives retries. Use it as the crawl
    # idempotency scope so a retried batch never re-charges pages it billed on
    # the first attempt (finding H).
    crawl_job_id = ctx.get("job_id")
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
            crawl_job_id=crawl_job_id,
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


# AR-44: how many batches run concurrently in task_reembed_all_documents.
# Each embed_chunks() call is itself internally concurrent (a ThreadPoolExecutor
# inside gemini_embedding.py), but consecutive BATCHES previously ran strictly
# sequentially. Batch N+1 waited for batch N's full embed+commit even though
# the network-bound embed calls could overlap under the same project-wide
# rate limiter (embed_rate_limiter paces requests regardless of how many
# concurrent callers there are, so widening this is safe, not just faster).
# Kept small. This is an offline backfill task, not latency-sensitive; the
# win is fewer idle gaps waiting on one batch's DB round-trip while the next
# batch's embed call could already be in flight.
_REEMBED_CONCURRENT_BATCHES = 3


async def _reembed_one_batch(batch_ids: list[int]) -> tuple[int, int]:
    """Embed + persist one batch of documents. Returns (succeeded, failed)
    counts for this batch, never raises; a batch-level failure is caught
    and counted as fully failed so one bad batch doesn't abort the run.
    """
    import asyncio

    from sqlalchemy import text

    from app.db.session import get_session
    from app.ingestion.embedder import embed_chunks

    with get_session() as session:
        rows = session.execute(
            text("SELECT id, content FROM documents WHERE id = ANY(:ids)"),
            {"ids": batch_ids},
        ).fetchall()

    contents = [r[1] for r in rows]

    try:
        embeddings = await asyncio.to_thread(embed_chunks, contents)
    except Exception as exc:
        logger.error(
            "task_reembed_all_documents: batch starting id=%d failed - %s: %s",
            batch_ids[0],
            type(exc).__name__,
            exc,
        )
        return 0, len(batch_ids)

    with get_session() as session:
        for row, embedding in zip(rows, embeddings, strict=True):
            emb_str = "[" + ",".join(str(v) for v in embedding) + "]"
            session.execute(
                text("UPDATE documents SET embedding = CAST(:emb AS vector) WHERE id = :id"),
                {"emb": emb_str, "id": row[0]},
            )
        session.commit()

    return len(batch_ids), 0


async def task_reembed_all_documents(ctx: dict, batch_size: int = 50) -> dict:
    """Re-embed all documents using the current embed_chunks() provider.

    Run this once after the a1b2c3d4e5f6 migration to backfill 768-dim vectors
    for every document that has a NULL embedding (i.e. all rows post-migration).

    Batches run in windows of ``_REEMBED_CONCURRENT_BATCHES`` concurrently
    (AR-44) rather than strictly one at a time. Safe because the shared
    project-wide embed rate limiter paces actual request volume regardless
    of how many concurrent batches are in flight.

    Returns a summary dict with total, succeeded, and failed counts.
    """
    import asyncio

    from sqlalchemy import text

    from app.db.session import get_session

    logger.info(
        "task_reembed_all_documents: starting (batch_size=%d, concurrent_batches=%d)",
        batch_size,
        _REEMBED_CONCURRENT_BATCHES,
    )

    with get_session() as session:
        # Fetch IDs of all documents with NULL embedding in ascending order.
        id_rows = session.execute(text("SELECT id FROM documents WHERE embedding IS NULL ORDER BY id")).fetchall()
        doc_ids = [r[0] for r in id_rows]

    total = len(doc_ids)
    logger.info("task_reembed_all_documents: %d documents to embed", total)

    batches = [doc_ids[i : i + batch_size] for i in range(0, total, batch_size)]
    succeeded = failed = 0

    for window_start in range(0, len(batches), _REEMBED_CONCURRENT_BATCHES):
        window = batches[window_start : window_start + _REEMBED_CONCURRENT_BATCHES]
        results = await asyncio.gather(*(_reembed_one_batch(b) for b in window))
        for batch_succeeded, batch_failed in results:
            succeeded += batch_succeeded
            failed += batch_failed
        logger.info(
            "task_reembed_all_documents: %d/%d done (failed=%d)",
            succeeded,
            total,
            failed,
        )

    logger.info(
        "task_reembed_all_documents: complete. Total=%d succeeded=%d failed=%d",
        total,
        succeeded,
        failed,
    )
    return {"total": total, "succeeded": succeeded, "failed": failed}


async def task_reembed_document(ctx: dict, document_id: int) -> dict:
    """Re-run embedding for a single document row.

    Documents are stored one chunk per row (``documents.content`` +
    ``documents.embedding``). Super-admin "reindex" recomputes the chunk's
    vector with the current embedding provider, useful after a provider /
    dimension change or when a row's embedding is stale or NULL.

    Returns a summary dict the ARQ result store keeps for status polling.
    """
    import asyncio

    from sqlalchemy import text

    from app.db.session import get_session
    from app.ingestion.embedder import embed_chunks

    logger.info("task_reembed_document: document_id=%d", document_id)

    with get_session() as session:
        row = session.execute(
            text("SELECT content FROM documents WHERE id = :id"),
            {"id": document_id},
        ).fetchone()

    if row is None:
        logger.warning("task_reembed_document: document %d not found", document_id)
        return {"document_id": document_id, "status": "not_found"}

    content = row[0] or ""
    try:
        embeddings = await asyncio.to_thread(embed_chunks, [content])
    except Exception as exc:
        logger.error(
            "task_reembed_document: embedding failed for document %d - %s: %s",
            document_id,
            type(exc).__name__,
            exc,
        )
        return {"document_id": document_id, "status": "failed", "error": str(exc)}

    emb_str = "[" + ",".join(str(v) for v in embeddings[0]) + "]"
    with get_session() as session:
        session.execute(
            text("UPDATE documents SET embedding = CAST(:emb AS vector) WHERE id = :id"),
            {"emb": emb_str, "id": document_id},
        )
        session.commit()

    logger.info("task_reembed_document: document %d re-embedded", document_id)
    return {"document_id": document_id, "status": "complete"}


# ── Webhook Delivery ────────────────────────────────────────────────────────


async def task_deliver_webhook(
    ctx: dict, webhook_id: int, event_type: str, payload_data: dict, attempt: int = 1
) -> bool:
    """Deliver a single webhook. Returns True on success.

    Retries are handled by the webhook subsystem itself, NOT by ARQ: on failure
    ``_deliver_webhook`` records a ``WebhookDelivery`` row with ``next_retry_at``
    and ``task_process_webhook_retries`` (30s cron) re-enqueues due attempts.
    (ARQ would only retry on a raised ``Retry``; this task never raises.)
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


async def task_resolve_lead_company(ctx: dict, session_id: str, domain: str, bot_id: int) -> bool:
    """Resolve a lead's email domain to its company identity.

    Why this is a QUEUED task and not a tail call on the request-adjacent
    thread pool, which is where it started:

    ``/chat/lead-capture`` is authenticated by the widget's bot key, which is
    embedded in customer pages and therefore public, and is rate-limited at
    10/min per key. The resolution charges only for an ANSWER (deliberately,
    so nobody pays for the many visitors whose domain names no employer) so
    an unresolvable domain costs the caller nothing. Posting fresh session ids
    with random domains therefore bought unlimited crawls at roughly 70s of one
    worker each (two crawl legs, then an LLM), against a ``max_workers=3`` pool
    shared platform-wide with geolocation, BANT extraction and, when the worker
    is down, webhook delivery. One abusive widget key could stall those for
    every bot in the process.

    A durable queue fixes the part that hurts OTHER customers: this work now
    waits its turn behind a bounded queue instead of occupying a slot that
    visitor-facing enrichment needs. It also gets retries and survives a
    restart.

    It does NOT by itself stop an attacker burning our own crawl quota. That
    is a cost question rather than an availability one, bounded by the existing
    rate limit, and is tracked separately.

    Runs the synchronous resolver in an executor, matching
    ``task_deliver_webhook``: the whole path underneath is blocking (a
    requests-style crawl, then a blocking LLM call).
    """
    import asyncio

    from app.api.chat_routes import _resolve_lead_company

    logger.info("task_resolve_lead_company: session=%s domain=%s bot_id=%s", session_id, domain, bot_id)

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: _resolve_lead_company(session_id, domain, bot_id))
    return True


async def task_capture_demo_screenshot(ctx: dict, bot_id: int, force: bool = False) -> bool:
    """Capture the bot's own website and store it as its demo-page backdrop.

    This is what lets ``GET /demo/{bot_key}`` show the customer's real site
    instead of a generic hero page. It runs here, on the worker, because a
    full-page capture of a JavaScript-heavy homepage routinely takes several
    seconds; putting that on the demo page's request path would mean every
    prospect who opened a shared link waited for a third-party render.

    The work itself lives in ``screenshot_service.refresh_bot_capture``, which
    is also what runs inline when ``WORKER_ENABLED`` is false. Keeping one
    implementation is what stops the two paths drifting into different
    behaviour for the same button.

    Synchronous underneath (DB, then two HTTP legs, then an upload), so it runs
    in an executor rather than blocking the worker's event loop and delaying
    every other queued job.
    """
    import asyncio

    from app.services.screenshot_service import refresh_bot_capture

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: refresh_bot_capture(bot_id, force))


async def task_process_webhook_retries(ctx: dict) -> int:
    """Cron task: poll for due webhook retries and re-enqueue them.

    Replaces the old daemon thread retry worker. Runs every 30s via ARQ cron.
    ``process_pending_retries`` is synchronous (DB + HTTP), so it runs in an
    executor (L-1). Inline it blocked the worker's event loop and delayed
    every other queued job for the duration of the sweep.
    """
    import asyncio

    from app.services.webhook_service import process_pending_retries

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, process_pending_retries)
    if count:
        logger.info("task_process_webhook_retries: re-queued %d retries", count)
    return count


# ── Credit lifecycle ────────────────────────────────────────────────────────


async def task_gateway_reconciliation(ctx: dict) -> int:
    """Daily cron: the blueprint §7 safety net. Diff Razorpay against local
    money state and ERROR on any delta. Report-only; see
    ``services.gateway_reconciliation`` for what each delta means. Returns the
    delta count (0 = clean)."""
    import asyncio

    from app.db.session import get_session
    from app.services.gateway_reconciliation import run_gateway_reconciliation

    def _run() -> int:
        with get_session() as session:
            report = run_gateway_reconciliation(session)
        return int(report.get("delta_count") or 0)

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run)


async def task_prune_processed_webhooks(ctx: dict) -> int:
    """Cron: prune processed_webhooks rows older than 180 days.

    The table exists for replay dedup; Razorpay's own retry horizon is days,
    not months, so half-a-year-old rows dedup nothing and only grow the table
    (and its two unique indexes) forever. Safe now that the payload-digest key
    gives the money handlers a second layer for anything genuinely replayed
    later. Batched DELETE so a first run over years of backlog cannot hold a
    long transaction.
    """
    import asyncio
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import delete, select

    from app.db.models import ProcessedWebhook
    from app.db.session import get_session

    def _run() -> int:
        cutoff = datetime.now(UTC) - timedelta(days=180)
        total = 0
        with get_session() as session:
            while True:
                batch_ids = (
                    session.execute(
                        select(ProcessedWebhook.event_id).where(ProcessedWebhook.processed_at < cutoff).limit(5000)
                    )
                    .scalars()
                    .all()
                )
                if not batch_ids:
                    break
                session.execute(delete(ProcessedWebhook).where(ProcessedWebhook.event_id.in_(batch_ids)))
                session.commit()
                total += len(batch_ids)

            # Reconciliation run reports: keep 180 days. Enough to answer
            # "when did this delta first appear", nothing depends on them.
            from app.db.models import ReconciliationRun

            recon_cutoff = datetime.now(UTC) - timedelta(days=180)
            recon_deleted = session.execute(
                delete(ReconciliationRun).where(ReconciliationRun.ran_at < recon_cutoff)
            ).rowcount
            session.commit()
            total += int(recon_deleted or 0)

            # Funnel telemetry ages out too (90d, the superadmin view caps
            # its window at 90). Same batched pattern; prunable by design.
            from app.db.models import BillingFunnelEvent

            funnel_cutoff = datetime.now(UTC) - timedelta(days=90)
            while True:
                funnel_ids = (
                    session.execute(
                        select(BillingFunnelEvent.id).where(BillingFunnelEvent.created_at < funnel_cutoff).limit(5000)
                    )
                    .scalars()
                    .all()
                )
                if not funnel_ids:
                    break
                session.execute(delete(BillingFunnelEvent).where(BillingFunnelEvent.id.in_(funnel_ids)))
                session.commit()
                total += len(funnel_ids)
        return total

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_prune_processed_webhooks: pruned %d rows older than 180d", count)
    return count


async def task_renew_due_subscriptions(ctx: dict) -> int:
    """Cron task: grant the new month's plan credits for subscriptions whose
    current_period_end has been reached, then roll the period forward.

    Razorpay's ``subscription.charged`` webhook is the canonical trigger for renewals;
    this cron is a safety net that catches missed webhooks (and is the *only*
    trigger for free-tier subs, since no payment ever fires there). The
    webhook handler is idempotent (skips when balance was already renewed in
    the same period), so running both is safe.

    Two important behaviours:

    1. **Catch-up**: the query matches every sub whose ``current_period_end``
       is in the past, not just "today", so a sub that fell behind because
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
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.core.dates import add_months
    from app.db.models import Invoice, Subscription, plan_charge_only_clauses
    from app.db.session import get_session
    from app.services import credit_service

    def _renew() -> int:
        now_utc = datetime.now(UTC)
        renewed = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        # ``trialing`` is deliberately excluded: trials never
                        # "renew", the hourly expiry cron owns them. Including
                        # them handed a lapsed trial a free full-plan grant in
                        # the 00:05→00:15 window before expiry flipped it (and
                        # a free month every day if the expiry cron broke).
                        Subscription.status == "active",
                        Subscription.current_period_end <= now_utc,
                        # A cancel-pending row must NEVER be renewed here. Its
                        # status stays "active" until Razorpay's cancelled
                        # webhook lands at cycle end, so without this filter a
                        # webhook running even a few hours late let this cron
                        # hand out a full free month of credits and roll the
                        # period forward on a subscription the customer had
                        # already cancelled and will not be charged for.
                        Subscription.cancel_at_period_end.is_(False),
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                # Isolate each subscription: commit per-row and skip on error so
                # one bad subscription (plan/ledger error) can't roll back the
                # grants + period rolls of every other subscription in the run,
                # nor make the cron re-fail the whole batch daily (audit F14).
                try:
                    # Period length matches the subscription's billing cycle.
                    # The old code hard-coded ``1`` here, which silently renewed
                    # annual subscriptions every month. Twelve credit grants
                    # per paid year and a customer-facing billing surprise.
                    # ``billing_cycle`` is normalised to ``"monthly"`` /
                    # ``"annual"`` at sub creation; anything else falls through
                    # to monthly so legacy / manual rows don't get stuck.
                    period_months = 12 if (sub.billing_cycle or "").lower() == "annual" else 1
                    new_period_end = add_months(sub.current_period_end, period_months)

                    # Gateway-billed rows renew only against payment evidence: a
                    # captured invoice near the boundary (Razorpay may debit up
                    # to ~2 days early for e-mandate execution windows). With no
                    # invoice we grant NOTHING and leave the period un-rolled so
                    # the row re-matches tomorrow. Granting on elapsed time
                    # alone handed out unbounded free service whenever webhooks
                    # were down AND the charge had actually failed (F2). If the
                    # charge truly failed, the pending/halted webhook flips the
                    # row to past_due and it drops out of this query; recovery
                    # for fully-lost webhooks is Razorpay's redelivery + the
                    # dead-letter replay tooling, not a blind grant.
                    if sub.razorpay_subscription_id:
                        paid = session.execute(
                            select(Invoice.id)
                            .where(
                                Invoice.subscription_id == sub.id,
                                Invoice.status == "paid",
                                Invoice.paid_at.is_not(None),
                                Invoice.paid_at >= sub.current_period_end - timedelta(days=2),
                                # PLAN charges only. Add-on invoices (seats,
                                # branding removal) stamp the main sub's id but
                                # pay for the add-on, and a withheld charge
                                # explicitly funded nothing. A ₹449 seat or
                                # ₹499 branding debit must not evidence a full
                                # plan renewal (same masking class as the F5
                                # revoke probe).
                                *plan_charge_only_clauses(),
                                Invoice.kind.is_distinct_from("withheld_charge"),
                            )
                            .limit(1)
                        ).first()
                        if paid is None:
                            logger.warning(
                                "task_renew_due_subscriptions: no captured payment for gateway "
                                "subscription %s (client %s) period ending %s. Grant withheld, "
                                "will re-check next run",
                                sub.id,
                                sub.client_id,
                                sub.current_period_end,
                            )
                            continue

                    # Grant this period's credits at most once, keyed on the
                    # per-scope + per-period marker the webhook path uses
                    # (``last_granted_period_end``). CRITICAL: key on the NEW
                    # period end, the same value ``subscription.charged`` uses
                    # (Razorpay's ``current_end``). Keying on the OLD end left
                    # the marker behind the webhook's value, so a delayed
                    # redelivery re-ran reset+grant for a period this cron had
                    # already granted, wiping the customer's consumption (P1-3).
                    granted = credit_service.grant_subscription_period_once(session, sub, new_period_end)
                    # Roll the period forward, without this the cron re-matches
                    # the same row every day.
                    sub.current_period_start = sub.current_period_end
                    sub.current_period_end = new_period_end
                    session.commit()
                    if granted:
                        renewed += 1
                except Exception:
                    logger.exception(
                        "Renewal failed for subscription %s (client %s); skipping",
                        getattr(sub, "id", "?"),
                        getattr(sub, "client_id", "?"),
                    )
                    session.rollback()
        return renewed

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _renew)
    if count:
        logger.info("task_renew_due_subscriptions: granted credits for %d subscription(s)", count)
    return count


async def task_execute_pending_cancellations(ctx: dict) -> int:
    """Cron: issue the real Razorpay cancel for subscriptions nearing period end.

    ``POST /subscriptions/cancel`` records only the customer's INTENT to churn
    (``cancel_at_period_end``) and leaves the mandate live, because Razorpay has
    no un-cancel: cancelling at the gateway on click destroyed the mandate ~30
    days early and forced "Reactivate" to mint a fresh subscription that
    Razorpay starts and charges immediately, a second payment for days the
    customer had already bought. This cron closes the loop, issuing the
    irreversible cancel only once the paid period is nearly over.

    Runs at 00:03, deliberately BEFORE ``task_renew_due_subscriptions`` (00:05):
    a subscription whose period ends today must be cancelled at the gateway
    before anything considers renewing it.

    ``execute_gateway_cancellation`` is idempotent on
    ``gateway_cancel_executed_at``, so a re-run (or a row ``/cancel`` already
    handled inline) is a no-op rather than a double cancel.

    Backstop: if this cron is down long enough for Razorpay to debit the next
    cycle anyway, ``_handle_subscription_charged`` catches the charge, cancels
    immediately, withholds the credit grant and logs for refund, so the worst
    case is bounded at one cycle rather than an open-ended subscription.

    Returns the number of subscriptions cancelled at the gateway this run.
    """
    import asyncio
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app import config
    from app.db.models import Subscription
    from app.db.session import get_session
    from app.services import transition_service
    from app.services.plan_service import lock_client_for_billing

    def _sweep() -> int:
        cutoff = datetime.now(UTC) + timedelta(days=config.GATEWAY_CANCEL_LEAD_DAYS)
        cancelled = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.cancel_at_period_end.is_(True),
                        Subscription.gateway_cancel_executed_at.is_(None),
                        Subscription.status.in_(("active", "trialing", "past_due")),
                        Subscription.razorpay_subscription_id.isnot(None),
                        Subscription.current_period_end <= cutoff,
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                # Isolate each subscription: commit per-row and skip on error so
                # one unreachable mandate can't roll back the cancellations of
                # every other subscription in the run (audit F14 pattern).
                try:
                    # Take the SAME advisory lock every billing mutation takes.
                    # Without it this cron races ``/subscriptions/resume``: resume
                    # asks Razorpay "is the mandate live?", we cancel it and stamp
                    # the marker, and resume then clears ``cancel_at_period_end``
                    # against a mandate that is now dead, the row promises a
                    # renewal that will never happen, which is the exact lie the
                    # whole two-field design exists to prevent. Re-reading the row
                    # under the lock also drops it if resume won the race.
                    lock_client_for_billing(session, sub.client_id)
                    session.refresh(sub)
                    if not sub.cancel_at_period_end or sub.gateway_cancel_executed_at is not None:
                        session.commit()
                        continue
                    if transition_service.execute_gateway_cancellation(session, sub):
                        cancelled += 1
                    session.commit()
                except Exception:
                    logger.exception(
                        "Gateway cancellation FAILED for subscription %s (client %s); will retry "
                        "next run. If this keeps failing the customer stays billable past their "
                        "cancellation date and needs manual reconciliation.",
                        getattr(sub, "id", "?"),
                        getattr(sub, "client_id", "?"),
                    )
                    session.rollback()
        return cancelled

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _sweep)
    if count:
        logger.info("task_execute_pending_cancellations: cancelled %d subscription(s) at the gateway", count)
    return count


async def task_refresh_promo_free_credits(ctx: dict) -> int:
    """Cron: refresh monthly plan credits for subscriptions inside a launch-promo
    free window.

    During the free period Razorpay fires no ``subscription.charged`` events, and
    a deferred sub carries ``current_period_end = None`` so
    ``task_renew_due_subscriptions`` skips it. Without this cron the customer
    gets one month of credits for a multi-month free window and runs dry.

    Each run grants the CURRENT free month's allowance, at most once, keyed on
    the aligned free-month boundary (``current_free_period_end``). Those
    boundaries land on ``promo_free_until`` and earlier, so they never collide
    with the first paid charge (keyed on Razorpay's later period end) or the
    auth-time grant (keyed on the first boundary). Idempotent per period via
    ``last_granted_period_end``, and per-row isolated so one bad sub can't abort
    the batch.

    Returns the number of subscriptions that received a fresh grant.
    """
    import asyncio
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.db.models import Subscription
    from app.db.session import get_session
    from app.services import credit_service
    from app.services.promotion_service import current_free_period_end

    def _refresh() -> int:
        now_utc = datetime.now(UTC)
        refreshed = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.status == "active",
                        Subscription.promotion_id.is_not(None),
                        Subscription.promo_free_until.is_not(None),
                        Subscription.promo_free_until > now_utc,
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                try:
                    period_end = current_free_period_end(sub.promo_free_until, now_utc)
                    if credit_service.grant_subscription_period_once(session, sub, period_end):
                        refreshed += 1
                    session.commit()
                except Exception:
                    logger.exception(
                        "Promo free-credit refresh failed for subscription %s (client %s); skipping",
                        getattr(sub, "id", "?"),
                        getattr(sub, "client_id", "?"),
                    )
                    session.rollback()
        return refreshed

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _refresh)
    if count:
        logger.info("task_refresh_promo_free_credits: refreshed credits for %d subscription(s)", count)
    return count


async def task_promo_precharge_reminders(ctx: dict) -> int:
    """Cron: remind a launch-promo customer before their first real charge.

    Fires once, ~10 days before ``promo_free_until``, so the month-4 charge is
    never a surprise (chargeback prevention). Idempotent via
    ``promo_reminder_sent['pre_charge']`` and per-row isolated. Best-effort like
    every other lifecycle email: a Brevo failure is logged and the marker still
    advances so a broken send never re-fires daily.

    Returns the number of reminders sent.
    """
    import asyncio
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.db.models import Client, Subscription
    from app.db.session import get_session
    from app.services.email_service import send_promo_precharge_reminder_email

    remind_days = 10

    def _run() -> int:
        now = datetime.now(UTC)
        window_end = now + timedelta(days=remind_days)
        sent = 0
        with get_session() as session:
            subs = (
                session.execute(
                    select(Subscription).where(
                        Subscription.status == "active",
                        Subscription.promotion_id.is_not(None),
                        Subscription.promo_free_until.is_not(None),
                        Subscription.promo_free_until > now,  # not yet charged
                        Subscription.promo_free_until <= window_end,  # within the reminder window
                    )
                )
                .scalars()
                .all()
            )
            # One read for the whole batch, so two customers reminded in the
            # same pass can never be quoted different tax.
            from app.services.razorpay_service import charged_price_display
            from app.services.seller_profile_service import charge_tax_rate_bps

            seller_rate_bps = charge_tax_rate_bps(session)

            for sub in subs:
                if (sub.promo_reminder_sent or {}).get("pre_charge"):
                    continue
                owner = session.get(Client, sub.client_id)
                if owner is None or not owner.email:
                    continue
                plan = sub.plan
                plan_name = plan.name if plan else "your plan"
                price_minor = (plan.monthly_price_cents if plan else 0) or 0
                # The GROSS. This email exists to warn the customer what is
                # about to leave their account when the free period ends, so
                # quoting the ex-GST base would understate the first charge by
                # the tax and hand them a number their statement contradicts.
                # Also drops the hand-rolled "₹{x // 100}" formatting, which
                # truncated any paisa and was rupee-only regardless of rail.
                amount_display = charged_price_display(
                    owner, price_minor, seller_rate_bps, currency=(plan.currency if plan else None) or "INR"
                )
                pfu = sub.promo_free_until
                if pfu.tzinfo is None:
                    pfu = pfu.replace(tzinfo=UTC)
                charge_date = f"{pfu.day} {pfu:%b %Y}"
                try:
                    send_promo_precharge_reminder_email(
                        owner.email,
                        name=owner.name,
                        plan_name=plan_name,
                        charge_date=charge_date,
                        amount_display=amount_display,
                    )
                    _mark_marker(sub, "promo_reminder_sent", "pre_charge", now)
                    sent += 1
                except Exception as exc:
                    logger.warning("task_promo_precharge_reminders: send failed for client %s: %s", sub.client_id, exc)
            session.commit()
        return sent

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_promo_precharge_reminders: sent %d reminder(s)", count)
    return count


async def task_promote_scheduled_downgrades(ctx: dict) -> int:
    """Cron: promote subscriptions whose scheduled downgrade cutover has passed.

    Razorpay's ``subscription.completed`` webhook is the canonical trigger;
    this cron is a safety net for webhook outages and for the manual
    legacy paths that don't emit ``completed`` cleanly. Both routes call into
    ``transition_service.promote_scheduled_change``, which is idempotent. If
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
                        # Scope tightly to rows that still carry a queued change.
                        # This is what lets us safely re-include ``canceled``
                        # rows below without resurrecting ordinary cancels, a
                        # promoted row has already had its scheduled trio cleared.
                        Subscription.scheduled_plan_id.is_not(None),
                        Subscription.scheduled_change_at.is_not(None),
                        Subscription.scheduled_change_at <= now,
                        # ``canceled`` is included because a ``cancel_at_cycle_end``
                        # mandate fires ``subscription.cancelled`` (not
                        # ``completed``) at cutover; if that webhook was dropped
                        # the row is ``canceled`` but the downgrade is still
                        # pending. This is the backstop for BL-1.
                        Subscription.status.in_(("active", "trialing", "past_due", "canceled")),
                    )
                )
                .scalars()
                .all()
            )
            for sub in subs:
                try:
                    result = transition_service.promote_scheduled_change(session, sub)
                    # Per-row commit: one row's success must not depend on the
                    # rest of the batch (and must not be lost to a later row's
                    # failure).
                    session.commit()
                except Exception:
                    # Roll back THIS row's partial promotion before moving on.
                    # promote_scheduled_change flushes the terminal flip +
                    # cleared schedule + seat retirement BEFORE its gateway
                    # create; without the rollback the end-of-loop commit
                    # persisted that half-promotion (downgrade silently
                    # destroyed, no replacement checkout, no re-auth email).
                    # Deterministic for USD-rail rows while
                    # INTL_PAYMENTS_ENABLED is off (IntlPaymentsDisabled).
                    session.rollback()
                    logger.exception(
                        "task_promote_scheduled_downgrades: failed for sub_id=%s",
                        sub.id,
                    )
                    continue
                if result is not None:
                    promoted += 1
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


async def task_prune_stale_events(ctx: dict) -> int:
    """Cron task: delete Event rows whose source page hasn't mentioned them
    within the retention window, or whose start date is more than that same
    window in the past.

    Runs daily. Idempotent, a subsequent run over the same DB state deletes
    zero rows. Retention is controlled by ``config.EVENT_RETENTION_DAYS``.
    """
    import asyncio

    from app import config
    from app.db import repository
    from app.db.session import get_session

    def _prune() -> int:
        with get_session() as session:
            deleted = repository.prune_stale_events(session, retention_days=config.EVENT_RETENTION_DAYS)
            session.commit()
            return deleted

    loop = asyncio.get_running_loop()
    total = await loop.run_in_executor(None, _prune)
    if total:
        logger.info("task_prune_stale_events: deleted %d event(s)", total)
    return total


# ── Worker Heartbeat ────────────────────────────────────────────────────────

WORKER_HEARTBEAT_KEY = "oyechats:worker:heartbeat"
WORKER_HEARTBEAT_TTL = 120  # seconds. 2× the cron interval, so a missed tick
#                              is still healthy but two missed ticks flag dead.


async def task_worker_heartbeat(ctx: dict) -> bool:
    """Cron task: write a freshness marker to Redis every 30s.

    The API ``/health`` endpoint reads this key. If it's missing or stale,
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
    attachments: list[dict] | None = None,
) -> bool:
    """Send a raw HTML email via the configured provider (Brevo or SES). Returns True on success."""
    import asyncio

    from app.services.email_service import _send_raw_email, redact_email

    # PRIVACY, the recipient can be a visitor (the chat follow-up in
    # lead_routes, the offline-message reply), and Sentry's LoggingIntegration
    # turns this INFO record into a breadcrumb on the next event the worker
    # reports. The domain survives, which is what makes a delivery problem
    # diagnosable; see ``email_service.redact_email``.
    logger.info("task_send_email: to=%s, subject=%s", redact_email(to_email), subject[:50])

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: _send_raw_email(
            to_email, subject, html_body, reply_to=reply_to, sender_name=sender_name, attachments=attachments
        ),
    )

    if not result:
        # Send failed (usually transient). ARQ only retries on Retry, a plain
        # raise is marked permanently failed, silently dropping the email
        # (audit F13). Defer with backoff; max_tries (3) bounds the attempts.
        from arq.worker import Retry

        job_try = ctx.get("job_try", 1)
        raise Retry(defer=min(10 * 2 ** (job_try - 1), 300))

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

    from app.services.email_service import _send_brevo_template, redact_email

    # PRIVACY. See ``task_send_email`` above.
    logger.info("task_send_template_email: to=%s, template=%d", redact_email(to_email), template_id)

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: _send_brevo_template(to_email, template_id, params or {}, reply_to=reply_to, sender_name=sender_name),
    )

    if not result:
        # See task_send_email: ARQ retries only on Retry, not a plain raise (F13).
        from arq.worker import Retry

        job_try = ctx.get("job_try", 1)
        raise Retry(defer=min(10 * 2 ** (job_try - 1), 300))

    return True


# ── Trial lifecycle (PR4) ───────────────────────────────────────────────────
#
# Three crons keep the free-trial flow honest:
#
# * ``task_expire_trials``          . Hourly. Flips trialing → trial_expired
#                                      the moment ``trial_end`` lapses, sets
#                                      the 15-day data retention timestamp,
#                                      fires the "trial ended" email.
# * ``task_trial_reminder_emails``  . Daily. Sends day-7 / day-11 / day-13
#                                      reminders to every trialing customer,
#                                      idempotent via ``trial_emails_sent``.
# * ``task_delete_expired_trial_data``. Daily. Hard-deletes bots / docs /
#                                      sessions for trial_expired subs once
#                                      ``data_retention_until`` is reached.
#
# All three use a sync inner function dispatched to a thread executor (the
# pattern matches ``task_renew_due_subscriptions``) so they can use the
# blocking SQLAlchemy session shape the rest of the codebase ships.


def _mark_marker(sub, field: str, key: str, when) -> None:
    """Idempotency marker. Set ``<field>[key] = ts`` on a JSONB column.

    The target column is explicit because ``Subscription`` now carries TWO
    independent marker maps (``trial_emails_sent`` and ``dunning_emails_sent``).
    A helper hardcoded to one of them silently writes dunning markers into the
    trial map: no exception, no type error, and the dunning cadence would
    simply never fire.

    JSONB columns on SQLAlchemy don't auto-detect in-place mutation; we
    rebuild the dict so the change actually flushes. Cheap, correct,
    survives every cron-vs-cron race we can throw at it.
    """
    existing = dict(getattr(sub, field) or {})
    existing[key] = when.isoformat()
    setattr(sub, field, existing)


def _mark_email_sent(sub, key: str, when) -> None:
    """Trial-lifecycle marker. See :func:`_mark_marker`."""
    _mark_marker(sub, "trial_emails_sent", key, when)


def _mark_dunning_sent(sub, key: str, when) -> None:
    """Dunning-cadence marker. See :func:`_mark_marker`."""
    _mark_marker(sub, "dunning_emails_sent", key, when)


async def task_expire_trials(ctx: dict) -> int:
    """Cron: flip trialing subscriptions whose ``trial_end`` has lapsed.

    Idempotent, the ``status`` filter naturally excludes already-expired
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
    """Cron: 7-day trial reminder cadence (halfway / T-1 / final day).

    Runs once a day; for every still-trialing subscription it computes
    ``days_remaining = ceil((trial_end - now) / 1 day)`` and fires the
    matching email if its marker isn't set. We use the day-bucket as the
    idempotency key so a customer who started a trial mid-day still gets
    every reminder on the right calendar day rather than 24h later.

    Marker keys (``day_7``, ``day_11``, ``day_13``) are preserved from
    the previous 14-day cadence so historical subscriptions with those
    slots already set on ``trial_emails_sent`` aren't spammed a second
    time after this rescale ships. The trigger (``days_remaining``)
    is what changed.

    Returns the number of emails sent across all subscriptions.
    """
    import asyncio
    import math
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.db.models import Client, Subscription
    from app.db.session import get_session
    from app.services.email_service import send_trial_days_left_email, send_trial_halfway_email

    # ``key`` doubles as the slot in ``trial_emails_sent`` and as the
    # discriminator for which template fires.
    cadence: dict[int, tuple[str, str]] = {
        # days_remaining → (marker_key, template)
        # Halfway check-in on a 7-day trial.
        4: ("day_7", "day_7"),
        # T-2 warning.
        2: ("day_11", "days_left"),
        # Final-day alarm.
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
                # "1 day left" rather than 0. Keeps the day-13 warning
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
                        # Legacy template key "day_7" is now the halfway
                        # slot on a 7-day trial (T-4). Marker key preserved
                        # for backward-compat with in-flight trials whose
                        # ``trial_emails_sent`` was set under the old name.
                        send_trial_halfway_email(
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

    The Client row itself stays. We keep the email and the deletion
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

                # Defence-in-depth: if the customer already subscribed to a
                # paid plan during the retention window, they should have had
                # this trial_expired row canceled at activation
                # (razorpay_service.py account-level activation branch). If
                # for any reason the cancel didn't happen, a lost webhook, a
                # manual DB fix that recreated the row, a future code path
                # that inserts without going through the standard activation
                # . We must NOT delete a paying customer's workspace. Bail
                # out and null the retention marker so this row stops
                # triggering the cron; a human can investigate the orphan.
                has_active_sibling = session.execute(
                    select(Subscription.id)
                    .where(
                        Subscription.client_id == owner.id,
                        Subscription.status.in_(("active", "trialing", "past_due")),
                    )
                    .limit(1)
                ).first()
                if has_active_sibling is not None:
                    logger.warning(
                        "task_delete_expired_trial_data: skipping delete for client %s. "
                        "trial_expired sub %s co-exists with an active subscription. "
                        "Nulling data_retention_until to stop re-firing; investigate the orphan.",
                        owner.id,
                        sub.id,
                    )
                    sub.data_retention_until = None
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

    Razorpay retries failed payments for ~7 days. Up to that
    point ``status = 'past_due'`` keeps the customer's full access so a
    rescued card resumes service without interruption. After
    ``PAYMENT_FAILED_GRACE_DAYS`` we stop bleeding LLM / credit cost on a
    customer who isn't paying, the same ``expired`` status the gates and
    the widget already understand kicks them out of write paths and into
    polite-offline mode on visitor traffic.

    Idempotent: the query filters on ``status='past_due'``, so a row that
    flipped on the previous tick is excluded from the next.

    Returns the number of subscriptions that expired this run.
    """
    import asyncio

    from app.db.session import get_session

    def _run() -> int:
        with get_session() as session:
            return _expire_past_due_cycle(session)

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_expire_past_due_subscriptions: expired %d subscription(s)", count)
    return count


def _expire_past_due_cycle(session) -> int:
    """One expiry pass. Extracted from the cron so it is directly testable,
    the state change is load-bearing and the suspension email is not, and that
    ordering needs a test rather than a promise."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.config import PAYMENT_FAILED_GRACE_DAYS
    from app.db.models import Client, Subscription
    from app.services.dunning_service import SUSPENDED_MARKER

    now = datetime.now(UTC)
    cutoff = now - timedelta(days=PAYMENT_FAILED_GRACE_DAYS)
    flipped = 0
    subs = (
        session.execute(
            select(Subscription).where(
                Subscription.status == "past_due",
                # Rows without a stamped anchor (webhook-only legacy
                # data) are NOT touched here. They'll get the
                # anchor on the next payment-failed event and the
                # cron picks them up from there.
                Subscription.past_due_since.is_not(None),
                Subscription.past_due_since < cutoff,
            )
        )
        .scalars()
        .all()
    )
    # Pass 1, the load-bearing state change, committed BEFORE any network I/O.
    # Razorpay and Brevo calls take seconds each; if the job were killed (ARQ
    # job_timeout) or the final commit failed midway, a single trailing commit
    # would roll the whole expiry back while the suspension emails had already
    # gone out. Customers told their agents are offline while still fully
    # entitled, and re-told tomorrow.
    from app.services.knowledge_state_service import deactivate_bot_knowledge

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
        # Paid → Free: deactivate this bot's knowledge (reversible) so it stops
        # answering from a paid-tier KB. Data is retained, not deleted. getattr:
        # legacy account-level subs (bot_id=None) and no-op for tests' mocks.
        deactivate_bot_knowledge(session, getattr(sub, "bot_id", None))
        flipped += 1
    session.commit()

    # Pass 2. Retire the gateway mandate. Best-effort and AFTER the load-bearing
    # commit, for the same reason the email is: a Razorpay outage must not leave
    # a customer entitled to a plan they stopped paying for.
    #
    # Without this the mandate stayed live and merely ``halted`` — which is a
    # RECOVERABLE gateway state, so the suspension email below rendered a
    # working "recover your subscription" button. A customer who pressed it (or
    # a Razorpay retry that finally landed) was CHARGED, got an invoice, and
    # got nothing: ``_handle_subscription_charged`` refuses to reactivate an
    # expired row and stamps the charge ``withheld_charge``. Money in, no
    # service, recoverable only by a manual refund somebody had to notice.
    #
    # Cancelled immediately, not at cycle end: the grace window has already
    # elapsed unpaid, so there is no paid period left to protect, and a
    # cycle-end cancel leaves the retries running until the boundary. This also
    # retires the seat and branding add-on mandates, which this cron previously
    # left billing forever.
    from app.services.transition_service import DOWNGRADE_REAUTH_GRACE_REASON, execute_gateway_cancellation

    for sub in subs:
        try:
            execute_gateway_cancellation(session, sub, at_period_end=False)
            session.commit()
        except Exception:  # noqa: BLE001  the expiry is what must survive
            session.rollback()
            logger.error(
                "Gateway cancel FAILED for expired subscription %s (client %s). The mandate is "
                "STILL LIVE at Razorpay and can debit a customer who now has no service. "
                "gateway_cancel_executed_at is unstamped, so the deferred-cancellation sweep "
                "retries it.",
                sub.id,
                sub.client_id,
                exc_info=True,
            )

    # Pass 3. Best-effort notification. Each success is committed on its own
    # so one bad row cannot cost another its marker. Runs AFTER the cancel so
    # the recovery link resolves against the real (now dead) mandate state and
    # the email falls back to prose instead of offering a button that charges.
    for sub in subs:
        if (sub.dunning_emails_sent or {}).get(SUSPENDED_MARKER):
            continue
        # A downgrade re-auth grace row that lapsed is NOT a failed-payment
        # suspension, the customer chose to downgrade and simply never
        # re-authorized. The Pass-1 flip above already dropped them to Free;
        # sending a "your <plan> subscription was suspended" email here would be
        # wrong copy (and there is no mandate to build a recovery link from).
        if sub.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON:
            continue
        try:
            owner = session.get(Client, sub.client_id)
            if not owner or not owner.email:
                continue
            url = _suspension_recovery_url(sub)
            from app.services.email_service import send_subscription_suspended_email

            if send_subscription_suspended_email(
                owner.email,
                name=owner.name,
                plan_name=sub.plan.name if sub.plan else "your plan",
                recovery_url=url,
            ):
                _mark_dunning_sent(sub, SUSPENDED_MARKER, now)
                session.commit()
        except Exception:  # noqa: BLE001  the expiry is what must survive
            # rollback() before continuing: a failed flush would otherwise
            # poison the session and take out every remaining row.
            session.rollback()
            logger.warning("suspension email failed for sub %s", sub.id, exc_info=True)

    return flipped


def _suspension_recovery_url(sub) -> str | None:
    """Best-effort recovery link for the suspension email.

    Returns ``None`` rather than raising: an unreachable gateway must not stop
    the customer being told their service stopped. The email falls back to
    prose instead of rendering a dead button.
    """
    from app.services.dunning_service import get_recovery_link

    try:
        link = get_recovery_link(sub.razorpay_subscription_id)
    except Exception:  # noqa: BLE001
        logger.warning("suspension: could not resolve recovery link for sub %s", sub.id, exc_info=True)
        return None
    return link.url if link.recoverable else None


# ── Web Push (operator notifications) ───────────────────────────────────────
#
# Two tasks drive the push pipeline:
#
# * ``task_dispatch_handoff_push``. Runs immediately when a visitor enters
#   the live-chat queue. Picks eligible operators (right department + under
#   max_concurrent_chats) who are NOT currently watching the dashboard via
#   WebSocket, and fans out a "new chat waiting" push to every subscription
#   they own. Also schedules its own ``task_handoff_escalation`` so a
#   black-holed chat doesn't leave the visitor staring at a spinner forever.
#
# * ``task_handoff_escalation``. Runs deferred (e.g. +20s). If the session
#   is still in ``waiting`` (no operator accepted), it cancels remaining
#   notifications on the operators' devices (tag-replace with "Chat ended")
#   so they don't tap a stale alert later. The visitor's queue-timeout
#   handler (``LiveChatService._start_timeout``) drives the actual fallback
#   UX; this task is purely cleanup.
#
# * ``task_send_visitor_message_email``. Fires when a visitor messages a
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
    from app.services.operator_presence_service import get_online_operator_ids
    from app.services.push_service import (
        client_wants_push,
        filter_operators_by_push_prefs,
        send_push_to_client,
        send_push_to_operator,
    )

    logger.info(
        "task_dispatch_handoff_push: session=%s bot=%d dept=%s",
        session_id,
        bot_id,
        department_id,
    )

    def _run() -> int:
        if SessionLocal is None:
            return 0
        with SessionLocal() as db:
            bot = db.execute(select(Bot).where(Bot.id == bot_id)).scalar_one_or_none()
            if bot is None:
                return 0

            # "Currently on WS" must be read from Redis presence, not
            # ``manager.operator_connections``. The ARQ worker runs in a
            # different process than the API, so its ``manager`` singleton
            # is a fresh instance whose ``operator_connections`` map is
            # always empty, which used to make this filter a no-op and
            # every online operator got both a WS toast AND a push.
            connected = get_online_operator_ids(bot.client_id)

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

            # Operators watching the dashboard already got the in-page toast, so
            # web push would duplicate it, but a browser toast is invisible on a
            # phone, so Expo push must still go out. Presence therefore mutes one
            # transport, not the operator. (A mobile client holds its WebSocket
            # open while backgrounded, so "connected" says nothing about whether
            # a human is actually looking.)
            candidates = [op.id for op in operators]
            allowed = set(filter_operators_by_push_prefs(db, candidates, "handoff_request"))
            operator_targets = [op for op in operators if op.id in allowed]

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
                total += send_push_to_operator(db, op.id, payload, tag=tag, web=op.id not in connected, expo=True)
            # Also fan out to the workspace owner. Small teams where the
            # client login is the primary chat-taker rely on this to get
            # notified at all. The owner isn't tracked in ``operator_connections``
            # the same way operators are; we always push and let the SW's
            # tag-replace semantics handle the case where they happen to be
            # watching the dashboard in another tab.
            #
            # The owner is a real recipient, so their opt-outs and quiet hours
            # apply exactly as an operator's do.
            if client_wants_push(db, bot.client_id, "handoff_request"):
                total += send_push_to_client(db, bot.client_id, payload, tag=tag)
            db.commit()
            if total == 0:
                logger.info(
                    "Handoff push delivered nothing for session=%s, no subscribers off-WS",
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

    The visitor's wait is capped at ~30s. They either get an operator or fall
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
    (operator beat the timeout, no notification update needed).
    """
    import asyncio

    from sqlalchemy import select

    from app.db.models import ChatSession, OfflineMessage, Operator
    from app.db.session import SessionLocal
    from app.services.push_service import (
        client_wants_push,
        filter_operators_by_push_prefs,
        send_push_to_client,
        send_push_to_operators,
    )

    def _run() -> bool:
        if SessionLocal is None:
            return False
        with SessionLocal() as db:
            cs = db.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
            if cs is None or cs.status not in {"waiting", "closed"}:
                # Operator accepted (status="live") or the session reverted to
                # bot mode, nothing to clean up.
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
                    # origin only, the SW's notificationclick handler validates
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
                allowed = filter_operators_by_push_prefs(db, [op.id for op in operators], payload["type"])
                send_push_to_operators(db, allowed, payload, tag=tag)
                if client_wants_push(db, cs.bot.client_id, payload["type"]):
                    send_push_to_client(db, cs.bot.client_id, payload, tag=tag)
            db.commit()
            return True

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run)


async def task_send_quotation_visitor_email(ctx: dict, session_id: str, bot_id: int) -> bool:
    """Send the priced "Your quotation" document email (with PDF) to the
    **visitor**, deferred ~10 min after the visitor accepted the quote. The
    owner notification and the visitor's "Your quote request" acknowledgement
    both fire immediately at accept time and are not handled here.

    (The task name is kept for scheduler/registration compatibility; its job is
    now the deferred document email rather than the plain acknowledgement.)

    Scheduled by ``quotation_routes._schedule_quotation_emails`` with an
    ``_defer_by`` window (``QUOTATION_EMAIL_DELAY_SECONDS``). The dispatcher
    re-reads the session + bot at send time so a late lead edit is reflected,
    and swallows its own errors, so this task is a thin async wrapper that runs
    the blocking DB + email + PDF work off the event loop.
    """
    import asyncio

    from app.api.quotation_routes import dispatch_quotation_document_email_for_session

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, dispatch_quotation_document_email_for_session, session_id, bot_id)
    return True


async def task_send_visitor_message_email(
    ctx: dict,
    session_id: str,
    bot_id: int,
    preview: str,
) -> bool:
    """Email the operator team when a waiting visitor sends a message.

    Caller is expected to have already debounced this. We don't re-check.
    Recipients come from the bot's ``handoff_request`` notification list, the
    same routing used previously for handoff emails. If the session has been
    accepted (status != "waiting") by the time this runs, we skip, the
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
            # *actual message* as the reason. That's the whole signal a real
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


async def task_dispatch_transfer_push(
    ctx: dict,
    session_id: str,
    new_operator_id: int,
    new_operator_name: str,
    visitor_name: str | None,
) -> int:
    """Push notify an operator who just had a chat transferred to them.

    Only fires when the target operator is NOT reachable via WebSocket per
    Redis presence. Otherwise the ``chat_accepted`` WS frame emitted inline by
    ``live_chat_service.transfer_chat`` already handled the alert. Presence
    lookup is cross-process, so this works whether the transfer originated in
    the same gunicorn worker as the target's WS or a different one.

    Payload uses ``type=chat_transferred`` and ``tag=transfer:<session_id>`` so
    a re-transfer (rare) replaces the previous notification on the device.
    """
    import asyncio

    from sqlalchemy import select

    from app.db.models import Operator
    from app.db.session import SessionLocal
    from app.services.operator_presence_service import get_online_operator_ids
    from app.services.push_service import filter_operators_by_push_prefs, send_push_to_operator

    def _run() -> int:
        if SessionLocal is None:
            return 0
        with SessionLocal() as db:
            operator = db.execute(select(Operator).where(Operator.id == new_operator_id)).scalar_one_or_none()
            if operator is None:
                return 0
            # A live WS carried the transfer to whatever surface is connected, so
            # web push would duplicate it. Expo still goes out: the operator may
            # be connected from a backgrounded phone, where nothing was shown.
            on_ws = new_operator_id in get_online_operator_ids(operator.client_id)
            if not filter_operators_by_push_prefs(db, [new_operator_id], "chat_transferred"):
                return 0

            payload = {
                "type": "chat_transferred",
                "title": "Chat transferred to you",
                "body": f"You now own the chat with {visitor_name or 'a visitor'}.",
                "session_id": session_id,
                "click_url": f"/support?session={session_id}",
            }
            tag = f"transfer:{session_id}"
            delivered = send_push_to_operator(db, new_operator_id, payload, tag=tag, web=not on_ws, expo=True)
            db.commit()
            return delivered

    loop = asyncio.get_running_loop()
    delivered = await loop.run_in_executor(None, _run)
    logger.info(
        "task_dispatch_transfer_push: delivered=%d session=%s operator=%d",
        delivered,
        session_id,
        new_operator_id,
    )
    return delivered


async def task_dispatch_offline_message_push(
    ctx: dict,
    offline_message_id: int,
) -> int:
    """Fan out a Web Push when a visitor submits the offline form.

    Complements the existing email fan-out in ``offline_message_routes.submit``
    so operators get a real-time OS notification too. Otherwise an out-of-hours
    lead sits silently in the inbox until someone thinks to look. Push routes
    the operator to ``/support?tab=messages&message_id=<id>`` on tap.

    Skips operators currently reachable via WebSocket (they already got the in-
    dashboard ``offline_message_received`` frame from ``submit_offline_message``).
    Always fires to the workspace owner: their ``client_id`` isn't in the
    presence roster, and the small-team case (client login IS the primary chat-
    taker) needs coverage.

    Returns the number of successful push deliveries; zero is a valid outcome
    for a workspace with no push subscribers.
    """
    import asyncio

    from sqlalchemy import select

    from app.db.models import Bot, OfflineMessage, Operator
    from app.db.session import SessionLocal
    from app.services.operator_presence_service import get_online_operator_ids
    from app.services.push_service import (
        client_wants_push,
        filter_operators_by_push_prefs,
        send_push_to_client,
        send_push_to_operator,
    )

    logger.info("task_dispatch_offline_message_push: message=%d", offline_message_id)

    def _run() -> int:
        if SessionLocal is None:
            return 0
        with SessionLocal() as db:
            msg = db.execute(select(OfflineMessage).where(OfflineMessage.id == offline_message_id)).scalar_one_or_none()
            if msg is None:
                return 0
            bot = db.execute(select(Bot).where(Bot.id == msg.bot_id)).scalar_one_or_none()
            if bot is None:
                return 0

            # Same cross-process presence lookup as task_dispatch_handoff_push.
            connected = get_online_operator_ids(bot.client_id)

            q = select(Operator).where(
                Operator.client_id == bot.client_id,
                Operator.is_accepting_chats.is_(True),
            )
            if msg.department_id is not None:
                # Department-scoped: operators in that department plus those
                # with no department (fallback pool). Matches the routing rule
                # used by handoff push above.
                q = q.where((Operator.department_id == msg.department_id) | (Operator.department_id.is_(None)))
            operators = db.execute(q).scalars().all()
            # Same split as handoff: presence mutes web push only.
            candidates = [op.id for op in operators]
            allowed = set(filter_operators_by_push_prefs(db, candidates, "offline_message_received"))
            operator_targets = [op for op in operators if op.id in allowed]

            preview = (msg.message_body or "").strip()[:140]
            payload = {
                "type": "offline_message_received",
                "title": f"Offline message from {msg.visitor_name}",
                "body": preview or "Visitor left a message.",
                "bot_id": bot.id,
                "bot_name": bot.name,
                "offline_message_id": msg.id,
                # SW opens this deep-link on tap and postMessages the target
                # to the live tab if one is focused.
                "click_url": f"/support?tab=messages&message_id={msg.id}",
            }
            tag = f"offline:{msg.id}"

            total = 0
            for op in operator_targets:
                total += send_push_to_operator(db, op.id, payload, tag=tag, web=op.id not in connected, expo=True)
            if client_wants_push(db, bot.client_id, "offline_message_received"):
                total += send_push_to_client(db, bot.client_id, payload, tag=tag)
            db.commit()
            if total == 0:
                logger.info(
                    "Offline-message push delivered nothing for message=%d, no subscribers off-WS",
                    offline_message_id,
                )
            return total

    loop = asyncio.get_running_loop()
    delivered = await loop.run_in_executor(None, _run)
    logger.info(
        "task_dispatch_offline_message_push: delivered=%d message=%d",
        delivered,
        offline_message_id,
    )
    return delivered


# ── Invoicing v2: PDF rendering sweep (Phase 4) ──────────────────────────────
#
# Indirection points (module-level so tests can substitute them): the sweep is
# a self-healing cron rather than a per-webhook enqueue. Any invoice that
# finalizes gets its PDF within one sweep interval, failures retry for free on
# the next tick, and nothing threads through the payment transaction.


def _invoice_pdf_session():
    from app.db.session import get_session

    return get_session()


def _utcnow():
    from datetime import UTC, datetime

    return datetime.now(UTC)


def _probe_pdf_renderer() -> None:
    """Raise if WeasyPrint (or its system pango libraries) is unavailable.

    Probed ONCE per sweep so a missing-pango environment produces a single
    clear error instead of 25 per-invoice stack traces every 5 minutes that
    read like data bugs.
    """
    import weasyprint  # noqa: F401  Import raises OSError when pango is missing


def _render_invoice_pdf(invoice) -> bytes:
    from app.services.invoice_pdf import render_invoice_pdf

    return render_invoice_pdf(invoice)


def _upload_invoice_pdf(data: bytes, key: str) -> str:
    from app.services.r2_service import upload_invoice_pdf

    return upload_invoice_pdf(data, key)


def _send_invoice_email(to_email: str, invoice, url: str, pdf_bytes: bytes | None = None) -> None:
    from app.services.email_service import send_invoice_email

    send_invoice_email(to_email, invoice, url, pdf_bytes=pdf_bytes)


def _stored_invoice_pdf_bytes(invoice) -> bytes | None:
    """Fetch the PUBLISHED invoice PDF bytes from R2, or None if unreadable.

    The object key embeds a random capability token (see ``_invoice_pdf_key``),
    so it cannot be re-derived from the invoice number, it must be parsed
    from the stored ``pdf_url``. The body stream is always closed.
    """
    from contextlib import closing
    from urllib.parse import urlparse

    from app.services.r2_service import get_object as _r2_get_object

    try:
        key = urlparse(str(invoice.pdf_url or "")).path.lstrip("/")
        if not key:
            return None
        body, _ct = _r2_get_object(key)
        with closing(body):
            return body.read()
    except Exception:
        return None


def _invoice_pdf_key(invoice_number: str) -> str:
    """R2 object key for an invoice PDF.

    Serials are sequential, and the bucket is served from a public CDN, a
    predictable key would make every customer's invoice enumerable. A random
    token turns the URL into an unguessable capability (the Stripe
    hosted-invoice pattern). Slashes in the legal serial are folded to dashes.
    """
    import secrets

    safe = invoice_number.replace("/", "-")
    fy = invoice_number.split("/")[1] if invoice_number.count("/") == 2 else "misc"
    return f"invoices/{fy}/{safe}-{secrets.token_hex(8)}.pdf"


async def task_render_invoice_pdfs(ctx: dict) -> int:
    """Cron sweep: render + store the PDF for finalized invoices lacking one.

    Picks numbered invoices with ``pdf_url IS NULL``, renders the Rule-46
    document, uploads to R2 under a capability URL, and stamps
    ``pdf_url``/``invoice_url``. Emails the customer only when
    ``INVOICE_EMAILS_ENABLED`` (shadow mode keeps documents admin-only).
    A recovery pass then re-attempts delivery for rendered-but-unmailed
    documents so a post-render email failure is never permanent (audit F43).
    Per-invoice failures are logged and left for the next sweep; the money
    path is never involved. Returns the number of PDFs produced.
    """
    import asyncio
    from datetime import timedelta

    from sqlalchemy import or_ as sa_or
    from sqlalchemy import select as sa_select
    from sqlalchemy import update as sa_update

    from app import config
    from app.db.models import Invoice as InvoiceModel
    from app.services import invoice_service

    if not config.INVOICING_V2_ENABLED:
        return 0

    try:
        _probe_pdf_renderer()
    except Exception:  # noqa: BLE001
        logger.error(
            "task_render_invoice_pdfs: PDF renderer unavailable (weasyprint/pango missing?). "
            "skipping sweep; install libpango on this host"
        )
        return 0

    def _run() -> int:
        done = 0
        with _invoice_pdf_session() as session:
            # Self-heal pass (finding H-B): re-number any paid charge left
            # un-numbered by a finalize that returned False, the pre-seller-
            # config window or a transient error. Runs BEFORE the PDF sweep so a
            # row numbered here gets its PDF in this same run. Safe/idempotent:
            # finalize's own gates no-op rows that still can't be numbered.
            try:
                healed = invoice_service.backfill_unnumbered_invoices(session)
                session.commit()
                if healed:
                    logger.info("task_render_invoice_pdfs: re-numbered %d previously un-numbered invoice(s)", healed)
            except Exception:  # noqa: BLE001  Self-heal must never block the PDF sweep
                session.rollback()
                logger.exception("task_render_invoice_pdfs: un-numbered invoice backfill failed; will retry")

            pending = (
                session.execute(
                    sa_select(InvoiceModel)
                    .where(InvoiceModel.invoice_number.isnot(None), InvoiceModel.pdf_url.is_(None))
                    .order_by(InvoiceModel.id)
                    .limit(25)
                )
                .scalars()
                .all()
            )
            for invoice in pending:
                try:
                    pdf = _render_invoice_pdf(invoice)
                    url = _upload_invoice_pdf(pdf, _invoice_pdf_key(invoice.invoice_number))
                    # Guarded UPDATE: a slow sweep can overlap the next cron
                    # tick (or a second worker) on the same pending set. Only
                    # the run that wins the NULL→url transition emails, the
                    # loser rowcount-0s and skips, so the customer never gets
                    # the document twice.
                    claimed = session.execute(
                        sa_update(InvoiceModel)
                        .where(InvoiceModel.id == invoice.id, InvoiceModel.pdf_url.is_(None))
                        .values(pdf_url=url, invoice_url=url)
                    ).rowcount
                    session.commit()
                except Exception:  # noqa: BLE001  one bad invoice must not block the sweep
                    session.rollback()
                    logger.exception("task_render_invoice_pdfs: failed for invoice %s; will retry", invoice.id)
                    continue
                if not claimed:
                    logger.info("task_render_invoice_pdfs: invoice %s already rendered by another run", invoice.id)
                    continue
                done += 1
                # Auto-email ONLY on first delivery (emailed_at NULL): an admin
                # "regenerate PDF" clears pdf_url and re-enters this sweep, and
                # must never re-email the customer. Best-effort post-commit; a
                # lost email is re-sendable from the superadmin console.
                if config.INVOICE_EMAILS_ENABLED and invoice.emailed_at is None:
                    try:
                        to_email = (invoice.buyer_snapshot or {}).get("email")
                        if to_email:
                            # ``pdf`` was just rendered above in this iteration.
                            # Attach those exact bytes to the email.
                            _send_invoice_email(to_email, invoice, url, pdf_bytes=pdf)
                            invoice.emailed_at = _utcnow()
                            session.commit()
                    except Exception:  # noqa: BLE001
                        session.rollback()
                        logger.exception("task_render_invoice_pdfs: email failed for invoice %s", invoice.id)
            # Recovery pass (audit F43): a failed send above leaves the invoice
            # OUTSIDE the pdf_url-IS-NULL sweep forever, the customer would
            # silently never receive their tax invoice. Re-attempt delivery for
            # rendered-but-unmailed documents. Snapshots with no email address
            # are excluded in SQL so they can't starve the batch (they surface
            # via reconciliation_anomalies instead).
            if config.INVOICE_EMAILS_ENABLED:
                claim_stale_before = _utcnow() - timedelta(hours=1)
                unmailed = (
                    session.execute(
                        sa_select(InvoiceModel)
                        .where(
                            InvoiceModel.invoice_number.isnot(None),
                            InvoiceModel.pdf_url.isnot(None),
                            InvoiceModel.emailed_at.is_(None),
                            # A live claim belongs to a concurrent sweep; a
                            # STALE claim (>1h) is a crashed worker. Re-sweep
                            # it, or the invoice is silently lost forever.
                            sa_or(
                                InvoiceModel.email_claimed_at.is_(None),
                                InvoiceModel.email_claimed_at < claim_stale_before,
                            ),
                            InvoiceModel.buyer_snapshot["email"].astext.isnot(None),
                        )
                        .order_by(InvoiceModel.id)
                        .limit(10)
                    )
                    .scalars()
                    .all()
                )
                for invoice in unmailed:
                    # M-5: CLAIM the send via guarded UPDATE on the dedicated
                    # claim column. Overlapping sweeps can't double-send, and
                    # because ``emailed_at`` is stamped only AFTER the send
                    # returns, a crash between claim and send leaves the row
                    # visible to the emails_pending alert and re-sweepable once
                    # the claim goes stale. (The first M-5 cut claimed via
                    # emailed_at itself, which turned a crash into silent
                    # permanent loss of a tax document.)
                    claimed = session.execute(
                        sa_update(InvoiceModel)
                        .where(
                            InvoiceModel.id == invoice.id,
                            InvoiceModel.emailed_at.is_(None),
                            sa_or(
                                InvoiceModel.email_claimed_at.is_(None),
                                InvoiceModel.email_claimed_at < claim_stale_before,
                            ),
                        )
                        .values(email_claimed_at=_utcnow())
                    ).rowcount
                    session.commit()
                    if not claimed:
                        continue
                    try:
                        # L-8: attach the STORED R2 bytes, the customer must
                        # receive the exact document that was published (a
                        # re-render can differ if templates changed since).
                        # The object key is parsed from pdf_url (the key
                        # embeds a random capability token, so it cannot be
                        # re-derived from the invoice number). Re-render only
                        # when the stored object is unreadable.
                        pdf = _stored_invoice_pdf_bytes(invoice)
                        if pdf is None:
                            logger.warning(
                                "task_render_invoice_pdfs: stored PDF unreadable for invoice %s. Re-rendering",
                                invoice.id,
                            )
                            pdf = _render_invoice_pdf(invoice)
                        _send_invoice_email(invoice.buyer_snapshot["email"], invoice, invoice.pdf_url, pdf_bytes=pdf)
                        invoice.emailed_at = _utcnow()
                        invoice.email_claimed_at = None
                        session.commit()
                        logger.info("task_render_invoice_pdfs: recovered email for invoice %s", invoice.id)
                    except Exception:  # noqa: BLE001  Retried next sweep; alerted daily via emails_pending
                        session.rollback()
                        # Release the claim so the NEXT sweep retries promptly
                        # (a crash before this line is covered by staleness).
                        session.execute(
                            sa_update(InvoiceModel).where(InvoiceModel.id == invoice.id).values(email_claimed_at=None)
                        )
                        session.commit()
                        logger.exception("task_render_invoice_pdfs: recovery email failed for invoice %s", invoice.id)
        return done

    loop = asyncio.get_running_loop()
    total = await loop.run_in_executor(None, _run)
    if total:
        logger.info("task_render_invoice_pdfs: rendered %d invoice PDF(s)", total)
    return total


# ── Auto-recrawl (weekly refresh of previously-crawled URLs) ────────────────
#
# Two tasks drive the pipeline:
#
# * ``task_auto_recrawl_sweep``   . Hourly cron. Queries bots whose
#   ``next_recrawl_at`` has elapsed and enqueues a per-bot task for each.
#   The partial index ``ix_bots_next_recrawl_due`` keeps the read cheap.
#
# * ``task_auto_recrawl_bot``     . Per-bot fan-out. Loads the bot, checks
#   the plan gate one more time (a downgrade between sweep and execution
#   auto-disables the toggle), then delegates to ``recrawl_service`` which
#   returns the summary that gets persisted back onto the bot row.
#
# The sweep runs every hour at :05 (offset from the invoice-PDF sweep at
# :01 and the webhook-retry poll at :00/:30 so ARQ concurrency isn't
# starved on the minute boundary).

# Max bots the hourly sweep may enqueue in a single tick. Cohort surprise
# safety net (see ``task_auto_recrawl_sweep`` docstring). Kept as a module
# constant, not an env var. Ops never tunes this per deploy; the value
# below is the deliberate default backed by the concurrency analysis in
# the recrawl RFC / issue tracker.
_SWEEP_HOURLY_CAP: int = 3


async def task_auto_recrawl_sweep(ctx: dict) -> int:
    """Cron: enqueue an auto-recrawl for every bot whose weekly window has elapsed.

    Bounded by ``_SWEEP_HOURLY_CAP``, a sweep tick picks at most N bots
    ordered by ``next_recrawl_at ASC`` (oldest-due first, fairness). Any
    bot left behind stays past-due, so the next hourly tick re-picks it
    naturally without any bookkeeping. This is the hard safety net against
    a cohort surprise (e.g. 20 bots enabled in one sitting all coming due
    in the same UTC hour a week later); the per-toggle jitter in
    ``compute_next_recrawl_at`` is the primary scattering, this cap is
    the belt-and-braces limit for whatever slips past it.

    Idempotent within an hour bucket via ``_job_id``, two sweeps that fire
    in the same clock hour (e.g. a redeploy overlap) can't double-enqueue
    the same bot. Returns the number of bots enqueued this tick.
    """
    import asyncio
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.db.models import Bot
    from app.db.session import get_session
    from app.worker.enqueue import enqueue

    # How many bots the sweep may enqueue in a single hourly tick. Held as
    # a local module constant (mirrors the ``RECRAWL_JITTER_HOURS`` +
    # ``RECRAWL_CADENCE_DAYS`` pattern in ``recrawl_service``): ops never
    # tunes this per deploy, and a runtime env var would only complicate
    # the test that monkeypatches it.
    cap = _SWEEP_HOURLY_CAP

    def _due_bot_ids() -> tuple[list[int], int]:
        """Return ``(picked, total_due)``, the capped slice we'll enqueue
        this tick and how many were eligible in total, so the log line can
        surface when the cap is actively engaged."""
        with get_session() as session:
            total_due = (
                session.execute(
                    select(Bot.id).where(
                        Bot.recrawl_enabled.is_(True),
                        Bot.next_recrawl_at.is_not(None),
                        Bot.next_recrawl_at <= datetime.now(UTC),
                        Bot.is_active.is_(True),
                    )
                )
                .scalars()
                .all()
            )
            if not total_due:
                return [], 0
            picked = list(
                session.execute(
                    select(Bot.id)
                    .where(
                        Bot.recrawl_enabled.is_(True),
                        Bot.next_recrawl_at.is_not(None),
                        Bot.next_recrawl_at <= datetime.now(UTC),
                        Bot.is_active.is_(True),
                    )
                    .order_by(Bot.next_recrawl_at.asc())
                    .limit(cap)
                )
                .scalars()
                .all()
            )
            return picked, len(total_due)

    loop = asyncio.get_running_loop()
    bot_ids, total_due = await loop.run_in_executor(None, _due_bot_ids)

    if not bot_ids:
        return 0

    # Dedup key: (bot_id, hour_bucket). A second sweep firing in the same
    # UTC hour for the same bot is a no-op; the next hourly tick re-enqueues
    # cleanly if the previous job dropped for any reason.
    hour_bucket = datetime.now(UTC).strftime("%Y%m%d%H")
    enqueued = 0
    for bot_id in bot_ids:
        try:
            job = await enqueue(
                "task_auto_recrawl_bot",
                bot_id,
                _job_id=f"auto_recrawl:{bot_id}:{hour_bucket}",
            )
        except Exception:
            logger.exception("task_auto_recrawl_sweep: enqueue failed for bot %s", bot_id)
            continue
        if job is not None:
            enqueued += 1

    if enqueued:
        deferred = max(0, total_due - enqueued)
        if deferred:
            logger.info(
                "task_auto_recrawl_sweep: enqueued %d of %d due bot(s) (cap=%d, %d deferred to next tick)",
                enqueued,
                total_due,
                cap,
                deferred,
            )
        else:
            logger.info("task_auto_recrawl_sweep: enqueued auto-recrawl for %d bot(s)", enqueued)
    return enqueued


async def task_auto_recrawl_bot(ctx: dict, bot_id: int) -> dict:
    """Refresh every previously-crawled URL for one bot.

    Re-validates the plan gate on entry: if the client downgraded between
    the sweep read and this task running, the toggle is force-disabled and
    the run is skipped rather than silently continuing on a paid feature.
    """
    import asyncio

    from app.db.models import Bot
    from app.db.session import get_session
    from app.services.plan_entitlements_service import get_entitlements
    from app.services.recrawl_service import recrawl_bot

    def _plan_check() -> tuple[bool, str | None]:
        """Return (should_run, reason_if_skip)."""
        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is None:
                return False, "bot_not_found"
            if not bot.recrawl_enabled:
                return False, "toggle_off"
            entitlements = get_entitlements(bot.client_id, session)
            if not entitlements.has_feature("auto_recrawl"):
                # Plan lost the entitlement (downgrade / lapsed sub). Auto-
                # disable so the sweep stops picking this bot up until the
                # customer re-enables after re-upgrading.
                bot.recrawl_enabled = False
                bot.next_recrawl_at = None
                session.commit()
                return False, "plan_downgraded"
            return True, None

    loop = asyncio.get_running_loop()
    should_run, skip_reason = await loop.run_in_executor(None, _plan_check)
    if not should_run:
        logger.info("task_auto_recrawl_bot: bot %s skipped (%s)", bot_id, skip_reason)
        return {"status": "skipped", "reason": skip_reason}

    summary = await recrawl_bot(bot_id)
    logger.info(
        "task_auto_recrawl_bot: bot %s finished. Status=%s changed=%s failed=%s",
        bot_id,
        summary.get("status"),
        summary.get("changed_pages"),
        summary.get("failed"),
    )
    return summary


async def task_invoice_reconciliation_alert(ctx: dict) -> int:
    """Daily cron: surface invoice anomalies loudly (error-level → Sentry).

    The issuing pipeline deliberately tolerates some failures inline (a
    savepoint-swallowed credit note, a stuck PDF render) so the money path is
    never blocked. This sweep is the guarantee those never stay silent.
    Returns the total anomaly count.
    """
    import asyncio

    from app import config
    from app.services import invoice_reports

    if not config.INVOICING_V2_ENABLED:
        return 0

    def _run() -> int:
        with _invoice_pdf_session() as session:
            anomalies = invoice_reports.reconciliation_anomalies(session)
        total = sum(len(v) for v in anomalies.values())
        if total:
            logger.error(
                "invoice reconciliation anomalies: %s",
                {k: [r["invoice_number"] or r["id"] for r in v] for k, v in anomalies.items() if v},
            )
        return total

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run)


async def task_reconcile_orphaned_seat_addons(ctx: dict) -> int:
    """Daily cron: cancel add-ons whose parent subscription is gone.

    Covers BOTH add-on kinds (operator seats and branding removal), despite the
    task's seat-era name, which is kept because it is the registered cron
    identity. Each add-on is a separate Razorpay subscription. The cancel,
    plan-cutover, and scheduled-downgrade paths all cancel it best-effort and
    only log on failure, and the cutover re-create is an external call a
    rolled-back activation can strand. Any of which leaves an orphan billing a
    churned or plan-changed customer every month forever. This sweep reconciles
    the gateway against local state, auto-cancels each orphan, and surfaces the
    outcome loudly (error → Sentry). Returns the number cancelled.
    """
    import asyncio

    from app import config
    from app.db.session import get_session
    from app.services import seat_addon_reports

    if not config.RAZORPAY_ENABLED:
        return 0

    def _run() -> int:
        with get_session() as session:
            result = seat_addon_reports.reconcile_orphaned_addons(session)
            session.commit()
        cancelled = result["cancelled"]
        failed = result["failed"]
        if cancelled or failed:
            logger.error(
                "orphaned add-on reconciliation: cancelled=%s failed=%s by_addon=%s",
                cancelled,
                failed,
                {name: {"cancelled": r["cancelled"], "failed": r["failed"]} for name, r in result["by_addon"].items()},
            )
        return len(cancelled)

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run)


def _dunning_send(marker: str, *, owner, sub, plan_name: str, days_left: int, rate_bps: int) -> bool:
    """Send the email for ``marker``. Returns True when it was handed off.

    Split out so the cron's control flow is testable without Brevo or Razorpay,
    and returns a bool so the caller writes the idempotency marker ONLY on
    success. ``due_email`` catches up to the newest unsent bucket, so a marker
    written after a failed send would skip straight past that email.

    Returns False rather than raising: one bad address or one gateway blip must
    not abort the loop and starve every other customer.
    """
    from app.services.dunning_service import get_recovery_link
    from app.services.email_service import (
        send_payment_action_required_email,
        send_payment_failed_email,
        send_payment_final_warning_email,
    )

    try:
        # Inside the try on purpose: ``sub.plan`` is a lazy relationship, so a
        # DB blip here would otherwise escape the whole cycle and roll back
        # every marker already earned in this batch, with those emails already
        # handed to Brevo.
        amount = ""
        if sub.plan:
            # All three axes — cycle, rail, standing discount — through the
            # SAME helper the super-admin at-risk queue prices with, so the
            # operator's console and the customer's inbox can never disagree
            # about one charge. This used to read the INR columns and honour
            # only the cycle, so a referral-discounted customer was quoted
            # roughly double their real debit and a USD customer was quoted
            # rupees under a dollar sign.
            from sqlalchemy.orm import object_session

            from app.services import discount_service
            from app.services import dunning_service as _dunning
            from app.services.razorpay_service import charge_currency, charged_price_display

            currency = charge_currency(getattr(owner, "billing_country", None))
            discount_bps = 0
            try:
                session = object_session(sub)
                if session is not None:
                    discount_bps, _ = discount_service.resolve_customer_discount_bps(session, owner)
            except Exception:  # noqa: BLE001 - a discount lookup must not cost the email
                logger.debug("dunning: discount lookup failed for sub %s", sub.id, exc_info=True)
            minor = _dunning.cycle_charge_minor(sub.plan, sub.billing_cycle, currency, discount_bps)
            if minor is not None:
                # The GROSS, not the base. Prices are published exclusive of
                # GST, so the base is neither what Razorpay attempted nor what
                # the statement shows. A mismatch there is what makes a dunning
                # email look like a phishing attempt.
                amount = charged_price_display(owner, minor, rate_bps, currency=currency)

        if marker == "failed_0":
            # Day 0 asks for nothing, so it needs no recovery link, which also
            # spares one gateway call per past-due customer per pass, for the
            # majority of cases that resolve on Razorpay's own retry.
            return send_payment_failed_email(owner.email, name=owner.name, plan_name=plan_name, amount=amount)

        link = get_recovery_link(sub.razorpay_subscription_id)
        if not link.recoverable or not link.url:
            # Both remaining templates require a working link; sending one with
            # a dead button is worse than staying silent. Marker stays unset so
            # the next tick retries.
            logger.info(
                "dunning: sub %s not recoverable (gateway=%s). Skipping %s",
                sub.id,
                link.gateway_status,
                marker,
            )
            return False

        if marker == "halted_3":
            return send_payment_action_required_email(
                owner.email,
                name=owner.name,
                plan_name=plan_name,
                amount=amount,
                recovery_url=link.url,
                days_left=days_left,
            )
        return send_payment_final_warning_email(
            owner.email,
            name=owner.name,
            plan_name=plan_name,
            recovery_url=link.url,
            days_left=days_left,
        )
    except Exception:  # noqa: BLE001  one customer must not break the batch
        logger.warning("dunning: %s send failed for sub %s", marker, sub.id, exc_info=True)
        return False


def _run_dunning_cycle(session) -> int:
    """One pass over past_due subscriptions. Returns emails sent."""
    from datetime import UTC, datetime

    from sqlalchemy import select
    from sqlalchemy.orm import joinedload

    from app.config import PAYMENT_FAILED_GRACE_DAYS
    from app.db.models import Client, Subscription
    from app.services.dunning_service import due_email

    now = datetime.now(UTC)
    sent = 0
    subs = (
        session.execute(
            select(Subscription)
            .options(joinedload(Subscription.plan))
            .where(
                Subscription.status == "past_due",
                Subscription.past_due_since.is_not(None),
                # Dunning recovers a FAILED GATEWAY CHARGE, so it only applies to
                # rows with a real mandate. Excluding NULL-mandate rows keeps the
                # short-lived downgrade re-auth grace row (created by
                # ``transition_service.promote_scheduled_change`` with no
                # ``razorpay_subscription_id``) out of the "your payment failed"
                # cadence, it is awaiting a first authorization, not a rescue.
                Subscription.razorpay_subscription_id.is_not(None),
            )
            # Oldest first so the customers closest to suspension are served
            # even if the batch is truncated. The limit bounds the FIRST run
            # after deploy, when every existing past_due row has an empty
            # marker map and therefore a due bucket. Each of those costs a
            # serial Razorpay fetch plus a Brevo hand-off.
            .order_by(Subscription.past_due_since)
            .limit(DUNNING_BATCH_LIMIT)
        )
        .scalars()
        .all()
    )
    # One read for the whole pass: the rate cannot shift between two customers'
    # dunning emails in the same run.
    from app.services.seller_profile_service import charge_tax_rate_bps

    seller_rate_bps = charge_tax_rate_bps(session)

    for sub in subs:
        since = sub.past_due_since
        if since.tzinfo is None:
            since = since.replace(tzinfo=UTC)
        # Fractional days on purpose: due_email compares with <=, so a tick at
        # 3.4 days still resolves the day-3 bucket instead of matching nothing.
        days = (now - since).total_seconds() / 86400
        marker = due_email(days, sub.dunning_emails_sent)
        if marker is None:
            continue

        owner = session.get(Client, sub.client_id)
        if owner is None or not owner.email:
            continue

        plan_name = sub.plan.name if sub.plan else "your plan"
        days_left = max(0, PAYMENT_FAILED_GRACE_DAYS - int(days))

        if _dunning_send(
            marker, owner=owner, sub=sub, plan_name=plan_name, days_left=days_left, rate_bps=seller_rate_bps
        ):
            _mark_dunning_sent(sub, marker, now)
            # Commit the marker BEFORE any further I/O. The email is already
            # irreversible; if anything downstream fails and rolls the session
            # back, the customer gets the same email again tomorrow.
            session.commit()
            sent += 1
            try:
                from app.services.notification_service import notify_payment_failed

                notify_payment_failed(
                    session,
                    client_id=sub.client_id,
                    plan_name=plan_name,
                    days_left=days_left,
                    recoverable=marker != "failed_0",
                )
            except Exception:  # noqa: BLE001  a notification must never cost us the email
                # rollback() is REQUIRED, not tidiness: create_notification
                # flushes internally, and a failed flush leaves the session in
                # a rollback-required state. Swallowing that would make the
                # NEXT iteration's session.get raise PendingRollbackError,
                # starving every remaining subscription in the batch.
                session.rollback()
                logger.warning("dunning: in-app notification failed for sub %s", sub.id, exc_info=True)
    session.commit()
    return sent


async def task_dunning_emails(ctx: dict) -> int:
    """Cron: dunning cadence for past_due subscriptions.

    Runs daily. Razorpay retries the charge on its own for ~3 days and sends
    its own card-update email; this adds the product context Razorpay cannot
    know. That the customer's AI agents stop responding when OUR grace window
    elapses.
    """
    import asyncio

    from app.db.session import get_session

    def _run() -> int:
        with get_session() as session:
            return _run_dunning_cycle(session)

    loop = asyncio.get_running_loop()
    count = await loop.run_in_executor(None, _run)
    if count:
        logger.info("task_dunning_emails: sent %d dunning email(s)", count)
    return count
