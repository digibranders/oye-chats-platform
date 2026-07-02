"""End-to-end crawl pipeline.

Encapsulates the steps that used to live inline inside the ``POST /crawl``
route handler, so the API and the ARQ worker can share the same code path.
The orchestrator:

1. Runs the crawl via the crawl provider (Spider primary, Jina fallback),
   emitting live per-page progress + a heartbeat so long crawls aren't reaped.
2. Ingests the discovered pages, deducting credits per page in the same DB
   transaction as the chunk insert (atomic billing). With streaming enabled
   (CRAWL_STREAM_INGEST_ENABLED) ingestion runs in waves *concurrently with*
   the scrape, followed by a dedup-protected final sweep; otherwise it is a
   single batch after the crawl completes.
3. Optionally sweeps orphan chunks for pages that were removed from the
   site since the last crawl.
4. Extracts brand tone, company context, and recommended colors from the
   first few pages and persists them on the bot (or client when no bot is
   bound).
5. Publishes the terminal ``done`` / ``failed`` status + the full result
   payload to Redis so the frontend can read it from ``/crawl/progress``,
   regardless of whether the work ran in the API or the worker process.
6. Always releases the per-client crawl lock.

The caller is expected to have already acquired the crawl lock and reserved
credits (pre-flight check); this function takes ownership of the lock from
that point and releases it at the end.
"""

import asyncio
import contextlib
import logging
import time

from app.config import CRAWL_INGEST_WAVE_PAGES, CRAWL_STREAM_INGEST_ENABLED
from app.db.models import Bot, Client, Document
from app.db.session import get_session
from app.ingestion.pipeline import batch_web_ingestion
from app.services.crawl_provider import crawl_website, fetch_urls
from app.services.crawler_service import (
    CrawlCancelled,
    CrawlerError,
    crawl_heartbeat,
    release_crawl_lock,
    set_crawl_progress,
)
from app.services.llm_service import extract_brand_tone, extract_company_context

logger = logging.getLogger(__name__)

# Path keywords used to auto-detect a "services" page from a freshly crawled site,
# in priority order. Matched against the URL path only (not querystring), so a
# blog post titled "our services" doesn't accidentally win.
_SERVICES_URL_HINTS = (
    "/services",
    "/service",
    "/solutions",
    "/what-we-do",
    "/whatwedo",
    "/offerings",
    "/products",
    "/capabilities",
)


def _pick_services_url(valid_pages: list[dict]) -> str | None:
    """Return the best services-page URL from a crawled page list, or None.

    Picks the URL whose path matches the highest-priority keyword in
    :data:`_SERVICES_URL_HINTS`. Prefers shorter paths (the canonical
    "/services" beats "/services/seo/checklist") so the admin lands on the
    section root, not a deep page. Returns ``None`` when nothing matches —
    callers leave the existing ``services_url`` untouched in that case.
    """
    from urllib.parse import urlparse

    best: tuple[int, int, str] | None = None
    for page in valid_pages:
        url = page.get("url")
        if not url:
            continue
        try:
            path = (urlparse(url).path or "/").lower().rstrip("/")
        except Exception:
            continue
        for priority, hint in enumerate(_SERVICES_URL_HINTS):
            if path.endswith(hint) or path == hint:
                candidate = (priority, len(path), url)
                if best is None or candidate < best:
                    best = candidate
                break
    return best[2] if best else None


async def run_full_crawl(
    *,
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
) -> dict:
    """Execute the full crawl pipeline end-to-end. Returns the result payload.

    Always writes a terminal ``done`` or ``failed`` state to Redis and always
    releases the per-client crawl lock — so callers don't need a try/finally
    of their own. Re-raises any underlying exception (the worker uses this to
    mark the job failed; the API surfaces it as a 5xx).

    Crawl knobs (``max_depth``, ``concurrency``) are plan-aware: the route
    layer resolves them from the client's plan and passes them through.
    ``max_pages`` is also clamped at the route layer — for JS crawls the
    route layer applies ``min(plan_max_pages, plan_js_max_pages)`` before
    forwarding, so a single capped ``max_pages`` is all the subprocess needs.
    ``None`` means "let the crawler subprocess fall back to its env defaults".
    """
    result_payload: dict | None = None
    started_at = time.time()
    # Denominator for the UI progress bar: the explicit list length for an
    # ordered crawl, else the plan-derived page cap (may be None for recursive).
    progress_max = len(ordered_urls) if ordered_urls else max_pages
    crawled_urls: list[str] = []

    def _report_page(page_url: str, ok: bool) -> None:
        """Live per-page progress for the fetch phase — this is what unfreezes
        the UI's 'Discovering URLs… 0/N' and (via set_crawl_progress) refreshes
        the heartbeat so a long fetch is never falsely reaped."""
        if ok:
            crawled_urls.append(page_url)
        set_crawl_progress(
            client_id,
            status="running",
            urls=list(crawled_urls),
            pages_crawled=len(crawled_urls),
            current_url=page_url,
            max_pages=progress_max,
            phase="Scanning pages",
            cancellable=True,
            started_at=started_at,
        )

    # ── Streaming ingestion (scrape ∥ embed) ─────────────────────────────────
    # Pages land on ``stream_queue`` as the provider finishes them; a single
    # consumer task ingests them in waves of CRAWL_INGEST_WAVE_PAGES while the
    # rest of the site is still being scraped. This overlaps the embed phase
    # with the scrape phase (wall-clock ≈ max of the two instead of their sum)
    # and keeps the per-minute embedding quota busy during the scrape.
    #
    # Safety comes from ``batch_web_ingestion`` being per-page idempotent
    # (content-hash dedup + per-URL replace + per-page commit+billing TX): the
    # final full-page sweep after the crawl re-offers every page, and anything
    # a wave already ingested is skipped by the hash check for free. So the
    # recursive-crawl path (which can't stream) and any page that slips past
    # the queue are still ingested exactly once.
    stream_queue: asyncio.Queue[dict | None] = asyncio.Queue()
    ingest_totals = {"chunks": 0, "pages_charged": 0, "credits_deducted": 0}
    billing_aborted = False  # insufficient credits / kill switch → stop embedding
    streaming = CRAWL_STREAM_INGEST_ENABLED

    def _on_result(page: dict) -> None:
        """Provider callback (event-loop thread): queue a finished page."""
        stream_queue.put_nowait(page)

    def _report_embed_stream(done_cum: int) -> None:
        """Live cumulative embed progress while the scrape may still be running."""
        set_crawl_progress(
            client_id,
            status="running",
            urls=list(crawled_urls),
            pages_crawled=len(crawled_urls),
            max_pages=progress_max,
            phase=f"Embedding — {done_cum:,} chunks so far",
            cancellable=True,
            started_at=started_at,
        )

    def _ingest_wave(wave: list[dict], chunk_offset: int) -> dict:
        return batch_web_ingestion(
            client_id,
            wave,
            bot_id=bot_id,
            cost_per_page=cost_per_page,
            deduct_reason="url_scan",
            deduct_reference_id=bot_id,
            embed_progress_cb=lambda done, _total: _report_embed_stream(chunk_offset + done),
            crawl_started_at=started_at,
        )

    async def _ingest_consumer() -> None:
        """Drain ``stream_queue`` into wave-sized ``batch_web_ingestion`` calls.

        Waves run sequentially (one executor call at a time) so DB sessions and
        chunk buffers stay bounded; parallelism lives inside the embed call.
        A ``None`` sentinel marks end-of-stream: the tail wave is flushed and
        the task returns. On a billing abort, later pages are drained and
        dropped — embedding pages the user can't pay for wastes the quota.
        """
        nonlocal billing_aborted
        loop = asyncio.get_event_loop()
        buffer: list[dict] = []
        while True:
            page = await stream_queue.get()
            done = page is None
            if not done:
                buffer.append(page)
            if billing_aborted:
                # Set either by a wave that couldn't bill or by the cancel
                # path — drop everything buffered, including pages that were
                # queued before the flag flipped.
                buffer.clear()
            if buffer and (done or len(buffer) >= CRAWL_INGEST_WAVE_PAGES):
                wave, buffer = buffer, []
                offset = ingest_totals["chunks"]
                result = await loop.run_in_executor(None, lambda w=wave, o=offset: _ingest_wave(w, o))
                ingest_totals["chunks"] += result["chunks"]
                ingest_totals["pages_charged"] += result["pages_charged"]
                ingest_totals["credits_deducted"] += result["credits_deducted"]
                if result.get("aborted"):
                    billing_aborted = True
            if done:
                return

    async def _finish_consumer(consumer: asyncio.Task | None, *, discard_pending: bool = False) -> None:
        """Signal end-of-stream and wait for in-flight waves to finish.

        ``discard_pending=True`` (cancel path) drops queued-but-uningested
        pages instead of embedding them. An executor-bound wave that already
        started cannot be interrupted; we wait it out (bounded: one wave).
        """
        nonlocal billing_aborted
        if consumer is None:
            return
        if discard_pending:
            billing_aborted = True
        stream_queue.put_nowait(None)
        await consumer

    consumer_task: asyncio.Task | None = None

    try:
        if streaming:
            consumer_task = asyncio.create_task(_ingest_consumer())
        stream_cb = _on_result if streaming else None

        # Heartbeat covers the single blocking recursive Spider /crawl call; the
        # ordered path additionally reports real per-page progress via on_page
        # and streams finished pages into ingestion via on_result.
        async with crawl_heartbeat(client_id):
            if ordered_urls:
                logger.info(
                    "Fetching %d explicit ordered URLs for client %s, bot_id=%s",
                    len(ordered_urls),
                    client_id,
                    bot_id,
                )
                crawl_data = await fetch_urls(
                    ordered_urls,
                    use_js=use_js,
                    client_id=client_id,
                    on_page=_report_page,
                    on_result=stream_cb,
                )
            else:
                logger.info("Crawling URL (sitemap-first): %s for client %s, bot_id=%s", url, client_id, bot_id)
                crawl_data = await crawl_website(
                    url,
                    max_pages=max_pages,
                    use_js=use_js,
                    client_id=client_id,
                    on_page=_report_page,
                    on_result=stream_cb,
                    max_depth=max_depth,
                    concurrency=concurrency,
                )

        results = crawl_data.get("results")
        recommended_colors = crawl_data.get("recommended_colors", [])
        # Coverage diagnostics from the crawler subprocess. ``discovered_total``
        # is every URL the crawler ever enqueued (visited + still-queued +
        # robots-blocked); ``queue_remaining`` is what was still pending when
        # the page-cap / depth-cap stopped us. The UI uses these to show the
        # customer "we found N more URLs that didn't fit your plan's cap"
        # instead of silently dropping them.
        discovered_total = int(crawl_data.get("discovered_total") or 0)
        queue_remaining = int(crawl_data.get("queue_remaining") or 0)

        if not results:
            raise CrawlerError("Failed to retrieve content from URL")

        valid_pages = [p for p in results if p.get("url") and p.get("content")]
        pages_processed = len(valid_pages)
        valid_urls = [p["url"] for p in valid_pages]

        # Publish the real page count and flip the UI to the embedding phase
        # before the (potentially multi-minute) embed step runs.
        set_crawl_progress(
            client_id,
            status="running",
            urls=valid_urls,
            pages_crawled=pages_processed,
            max_pages=progress_max,
            phase=f"Embedding {pages_processed} pages",
            cancellable=False,
            started_at=started_at,
        )

        # Flush the streaming consumer: waves already in flight finish, the
        # buffered tail is ingested, and the totals below reflect all of it.
        # Heartbeat spans the wait — the tail wave can be a multi-minute embed.
        if consumer_task is not None:
            async with crawl_heartbeat(client_id):
                await _finish_consumer(consumer_task)
            consumer_task = None

        sweep_offset = ingest_totals["chunks"]

        def _report_embed(done_chunks: int, total_chunks: int) -> None:
            """Live embed progress — keeps the UI moving through the multi-minute
            embedding phase (and refreshes the heartbeat) instead of sitting at
            'N pages scanned'. Counts are cumulative across the streamed waves."""
            set_crawl_progress(
                client_id,
                status="running",
                urls=valid_urls,
                pages_crawled=pages_processed,
                max_pages=progress_max,
                phase=f"Embedding {sweep_offset + done_chunks:,}/{sweep_offset + total_chunks:,} chunks",
                cancellable=False,
                started_at=started_at,
            )

        # Final sweep over the full page list. With streaming on, everything a
        # wave already ingested is skipped by the content-hash dedup, so this
        # only picks up stragglers (and is the sole ingest path for the
        # non-streaming / recursive-crawl cases). Skipped entirely after a
        # billing abort — those pages can't be paid for.
        loop = asyncio.get_event_loop()
        if not billing_aborted:
            logger.info("Batch ingesting %d pages (%d chunks already streamed)", pages_processed, sweep_offset)
            # Heartbeat spans the embed loop — CPU/network-bound and the phase
            # most likely to exceed the reaper's staleness window on a large crawl.
            async with crawl_heartbeat(client_id):
                ingest_result = await loop.run_in_executor(
                    None,
                    lambda: batch_web_ingestion(
                        client_id,
                        valid_pages,
                        bot_id=bot_id,
                        cost_per_page=cost_per_page,
                        deduct_reason="url_scan",
                        deduct_reference_id=bot_id,
                        embed_progress_cb=_report_embed,
                        crawl_started_at=started_at,
                    ),
                )
            ingest_totals["chunks"] += ingest_result["chunks"]
            ingest_totals["pages_charged"] += ingest_result["pages_charged"]
            ingest_totals["credits_deducted"] += ingest_result["credits_deducted"]
        total_chunks = ingest_totals["chunks"]
        pages_charged = ingest_totals["pages_charged"]
        credits_deducted = ingest_totals["credits_deducted"]

        # Orphan sweep: remove chunks for pages that disappeared from the site.
        # Only valid for a FULL re-crawl. A partial (ordered_urls) crawl fetches
        # an intentional subset, so sweeping would delete pages the user still
        # wants — skip it in that case.
        if replace_source and total_chunks > 0 and not ordered_urls:
            newly_crawled_urls = [p["url"] for p in valid_pages]
            with get_session() as del_session:
                from sqlalchemy import func as sa_func

                domain_expr = sa_func.coalesce(
                    sa_func.replace(
                        sa_func.substring(Document.document_name, r"^(https?://[^/]+)"),
                        "www.",
                        "",
                    ),
                    Document.document_name,
                )
                owner_filter = Document.bot_id == bot_id if bot_id else Document.client_id == client_id
                deleted = (
                    del_session.query(Document)
                    .filter(
                        domain_expr == replace_source,
                        owner_filter,
                        Document.document_name.notin_(newly_crawled_urls),
                    )
                    .delete(synchronize_session=False)
                )
                del_session.commit()
                logger.info(
                    "Orphan sweep: removed %d stale chunks for '%s' (%d fresh chunks retained)",
                    deleted,
                    replace_source,
                    total_chunks,
                )

        # Brand tone + company context (best-effort, non-fatal on error).
        brand_tone = None
        company_context: dict | None = None
        if valid_pages and bot_id:
            content_sample = "\n\n".join(p["content"][:1000] for p in valid_pages[:3])
            try:
                brand_tone, company_context = await asyncio.gather(
                    loop.run_in_executor(None, lambda: extract_brand_tone(content_sample)),
                    loop.run_in_executor(None, lambda: extract_company_context(content_sample)),
                )
            except Exception:
                logger.warning("brand/company extraction failed for bot %s", bot_id, exc_info=True)

        # Smart-default services URL: pick the best service-page candidate from
        # the crawled URLs. Only fills the field when the admin hasn't set one
        # yet, so re-crawls never overwrite an explicit choice.
        services_url_suggestion = _pick_services_url(valid_pages)

        if recommended_colors or brand_tone or company_context or services_url_suggestion:
            with get_session() as session:
                if bot_id:
                    bot_db = session.get(Bot, bot_id)
                    if bot_db and bot_db.client_id == client_id:
                        if recommended_colors:
                            bot_db.recommended_colors = recommended_colors
                        if brand_tone:
                            bot_db.brand_tone = brand_tone
                        if company_context:
                            if company_context.get("name"):
                                bot_db.company_name = company_context["name"]
                            if company_context.get("description"):
                                bot_db.company_description = company_context["description"]
                        if services_url_suggestion and not bot_db.services_url:
                            bot_db.services_url = services_url_suggestion
                            logger.info("Auto-suggested services_url for bot %s: %s", bot_id, services_url_suggestion)
                        session.commit()
                        logger.info(
                            "Saved crawl metadata for bot %s: colors=%d, tone=%s, company_name=%s",
                            bot_id,
                            len(recommended_colors) if recommended_colors else 0,
                            "yes" if brand_tone else "no",
                            company_context.get("name") if company_context else "no",
                        )
                elif recommended_colors:
                    client_db = session.get(Client, client_id)
                    if client_db:
                        client_db.recommended_colors = recommended_colors
                        session.commit()
                        logger.info(
                            "Saved %d recommended colors for client %s",
                            len(recommended_colors),
                            client_id,
                        )

        # ``pages_dropped`` is the headline number for the UI: how many URLs
        # we found but couldn't ingest given the plan caps. Compute it
        # defensively — never negative, even if the subprocess and the post-
        # filter disagree by a page or two.
        pages_dropped = max(0, discovered_total - pages_processed) if discovered_total else queue_remaining

        result_payload = {
            "message": "Crawling and ingestion completed successfully",
            "root_url": url,
            "pages_processed": pages_processed,
            "pages_charged": pages_charged,
            "chunks_processed": total_chunks,
            "credits_deducted": credits_deducted,
            "pages_crawled": [p["url"] for p in valid_pages],
            "recommended_colors": recommended_colors,
            "brand_tone": brand_tone,
            # Coverage visibility — UI uses these to render
            # "Ingested 200 pages. 347 more were discovered but didn't fit
            #  your plan's cap. Upgrade or split the crawl by section."
            "pages_discovered": discovered_total,
            "pages_dropped": pages_dropped,
        }
        set_crawl_progress(
            client_id,
            status="done",
            urls=[p["url"] for p in valid_pages],
            result=result_payload,
        )

        # Drop an in-app notification so the user sees the result in the bell
        # even if they navigated away. Best-effort — never fail the crawl on it.
        try:
            from app.services.notification_service import notify_crawl_completed

            with get_session() as notif_session:
                notify_crawl_completed(
                    notif_session,
                    client_id=client_id,
                    source=url,
                    pages=pages_processed,
                    chunks=total_chunks,
                    duration_seconds=round(time.time() - started_at),
                    bot_id=bot_id,
                )
        except Exception:
            logger.warning("crawl-complete notification failed (non-fatal)", exc_info=True)

        return result_payload
    except CrawlCancelled as exc:
        # User pressed Cancel — honour it FAST. We stop scraping, discard every
        # page not yet ingested (``discard_pending=True`` drops the queued
        # buffer instead of embedding it), and only wait out a wave that is
        # already mid-embed — that work is committed+billed atomically per page
        # and cannot be interrupted safely.
        #
        # Trade-off: with streaming, waves ingested *before* the cancel are
        # kept and billed — that content is already live in the bot's knowledge
        # base and the charge matches delivered work. Pages crawled but not yet
        # ingested are discarded unbilled, same as before. The payload reports
        # the real partial totals so the UI never claims 0 for work that was
        # actually delivered.
        with contextlib.suppress(Exception):
            await _finish_consumer(consumer_task, discard_pending=True)
        consumer_task = None
        partial = exc.partial_result or {}
        partial_results = partial.get("results") or []
        partial_urls = [p["url"] for p in partial_results if p.get("url")]
        result_payload = {
            "message": "Crawl cancelled by user",
            "root_url": url,
            "pages_processed": ingest_totals["pages_charged"],
            "chunks_processed": ingest_totals["chunks"],
            "credits_deducted": ingest_totals["credits_deducted"],
            "pages_crawled": partial_urls,
        }
        set_crawl_progress(
            client_id,
            status="cancelled",
            urls=partial_urls,
            result=result_payload,
        )
        logger.info(
            "Cancelled crawl for client %s: %d pages discovered, %d chunks already ingested",
            client_id,
            len(partial_urls),
            ingest_totals["chunks"],
        )
        return result_payload
    except CrawlerError as exc:
        logger.error("Crawling failed for client %s: %s", client_id, exc)
        set_crawl_progress(
            client_id,
            status="failed",
            error="Crawling failed. The target site may be unreachable.",
        )
        raise
    except Exception as exc:
        logger.exception("Crawling failed unexpectedly for client %s: %s", client_id, exc)
        set_crawl_progress(
            client_id,
            status="failed",
            error="Crawling failed. Please try again.",
        )
        raise
    finally:
        # Never leak the consumer task: on any failure path, drop pending pages
        # and wait out at most one in-flight wave (already-committed work stays
        # — it's billed atomically per page). suppress() keeps a consumer crash
        # from masking the original exception; its traceback is logged here.
        if consumer_task is not None:
            try:
                await _finish_consumer(consumer_task, discard_pending=True)
            except Exception:
                logger.exception("Streaming ingest consumer failed during crawl teardown for client %s", client_id)
        release_crawl_lock(client_id)
