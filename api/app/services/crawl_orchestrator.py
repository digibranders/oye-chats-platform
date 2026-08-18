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
from collections.abc import Callable

from app.config import CRAWL_FAVICON_AVATAR_ENABLED, CRAWL_INGEST_WAVE_PAGES, CRAWL_STREAM_INGEST_ENABLED
from app.core.cache import bot_config_key, cache_delete
from app.db.models import Bot, Client, Document
from app.db.repository import AVATAR_SOURCE_DERIVED
from app.db.session import get_session
from app.ingestion.pipeline import batch_web_ingestion
from app.services.brand_color_extractor import fetch_recommended_colors
from app.services.brand_tone import preset_text
from app.services.crawl_provider import crawl_website, fetch_urls
from app.services.crawler_service import (
    CrawlCancelled,
    CrawlerError,
    crawl_heartbeat,
    is_cancellation_requested,
    release_crawl_lock,
    set_crawl_progress,
)
from app.services.footer_harvester import harvest_footer_media
from app.services.llm_service import classify_brand_tone, extract_company_context

logger = logging.getLogger(__name__)


def _record_bot_crawl_state(bot_id: int | None, status: str) -> None:
    """Persist the bot's durable ingestion ("trained") state after a terminal crawl.

    Best-effort, a failure here must never fail or mask the crawl result.

    ``last_crawl_status`` records this ATTEMPT, so it is written on every
    terminal status including a hard failure (the frontend needs to tell "tried
    and failed" from "never trained"). The trained counters are then recomputed
    from what the bot actually stores rather than from this crawl's delta: a
    delta recrawl of an unchanged site legitimately ingests zero new chunks
    while the bot keeps all of its prior content, and gating the stamp on this
    job's output left such a bot reading "Nothing learned yet" forever.

    Recomputing on a failed crawl is deliberate too, a failure doesn't destroy
    previously ingested content, so the bot stays correctly marked as trained.
    """
    if not bot_id:
        return
    try:
        # Local import: app.db.repository pulls in the service layer, so a
        # module-level import here would close an import cycle.
        from app.db.repository import sync_bot_knowledge_state

        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is None:
                return
            bot.last_crawl_status = status
            sync_bot_knowledge_state(session, bot_id)
            session.commit()
    except Exception:
        logger.warning("failed to record durable crawl state for bot %s (non-fatal)", bot_id, exc_info=True)


def _terminal_status(total_chunks: int, existing_count: int) -> str:
    """Decide a crawl's terminal status from new-chunk and existing-content counts.

    ``no_content`` means the bot has NO usable knowledge after this crawl,
    not merely that this particular crawl added nothing. A delta recrawl of an
    unchanged site legitimately produces ``total_chunks == 0`` (SHA-256 dedup
    skipped every page) while the bot still holds all its prior content; that
    is a success, not a JS-render failure. Only report ``no_content`` when
    both this crawl's new chunks and the bot's pre-existing indexed content
    are zero.
    """
    return "done" if (total_chunks > 0 or existing_count > 0) else "no_content"


def _precompute_seed_questions(bot_id: int | None) -> None:
    """Warm the bot's seed-question cache right after ingestion completes.

    Seed generation is an LLM call + several embedding round-trips. Running it
    here (in the worker / background crawl task, off the request path) means the
    Build Studio Prove step reads a cached value instead of paying that latency
    while the user waits. Best-effort; the on-demand endpoint stays as a fallback
    if this hasn't finished (or failed) by the time the user asks. Only caches an
    authoritative result. Mirrors the endpoint's guard so an empty list is never
    persisted before content exists (documents do exist here, but stay defensive).
    """
    if not bot_id:
        return
    try:
        from app.db.repository import count_documents_for_bot
        from app.services.seed_questions_service import build_seed_questions

        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is None or bot.seed_questions is not None:
                return  # already computed (or bot gone), never recompute here
            questions = build_seed_questions(session, bot)
            if questions or count_documents_for_bot(session, bot_id=bot.id, client_id=bot.client_id) > 0:
                bot.seed_questions = questions
                session.commit()
    except Exception:
        logger.warning("seed-question precompute failed for bot %s (non-fatal)", bot_id, exc_info=True)


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
    section root, not a deep page. Returns ``None`` when nothing matches.
    Callers leave the existing ``services_url`` untouched in that case.
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


def _apply_crawl_metadata_to_bot(
    bot_db: Bot,
    *,
    recommended_colors: list | None,
    brand_tone: str | None,
    company_context: dict | None,
    services_url_suggestion: str | None,
    brand_tone_preset: str | None = None,
) -> list[str]:
    """Write crawl-extracted metadata onto a loaded ``Bot``, honoring locks.

    Fields the customer edited by hand are recorded in
    ``bot_db.manual_field_overrides`` (see
    ``bot_routes._reconcile_manual_overrides``); the crawl must refresh only the
    fields they haven't claimed. When ``brand_tone`` is written its matching
    ``brand_tone_preset`` key is written alongside it. ``recommended_colors`` is
    always refreshed and ``services_url`` is only ever auto-filled when empty (an
    explicit choice is never overwritten). Mutates ``bot_db`` in place; the
    caller owns the commit.

    Returns the list of field names actually written (for logging / assertions).
    """
    overrides = set(bot_db.manual_field_overrides or [])
    written: list[str] = []
    # Always refresh ``recommended_colors``, even when the extractor came
    # back empty. A re-crawl of a site whose palette can no longer be
    # extracted MUST clear the stale colors from the previous site, otherwise
    # the widget keeps rendering with the wrong brand until the customer
    # notices and re-picks manually. There's no ``manual_field_overrides``
    # guard here because ``recommended_colors`` is a suggestion surface, not
    # a user-editable field. Customers pick from it into the actual color
    # settings, which live on separate fields the helper never touches.
    normalized_colors = recommended_colors or []
    if bot_db.recommended_colors != normalized_colors:
        bot_db.recommended_colors = normalized_colors
        written.append("recommended_colors")
    if brand_tone and "brand_tone" not in overrides:
        bot_db.brand_tone = brand_tone
        bot_db.brand_tone_preset = brand_tone_preset
        written.append("brand_tone")
    if company_context:
        if company_context.get("name") and "company_name" not in overrides:
            bot_db.company_name = company_context["name"]
            written.append("company_name")
        if company_context.get("description") and "company_description" not in overrides:
            bot_db.company_description = company_context["description"]
            written.append("company_description")
    if services_url_suggestion and not bot_db.services_url:
        bot_db.services_url = services_url_suggestion
        written.append("services_url")
    return written


# Absolute wall-clock budget for the whole favicon step. Discovery, every
# candidate download, the R2 upload. Small on purpose: this runs after the
# crawl is already complete and billed, so its only job is to not linger.
_FAVICON_TOTAL_BUDGET_S = 25.0


async def _maybe_apply_favicon_avatar(bot_id: int | None, client_id: int, url: str) -> None:
    """Set the site's favicon as the bot's avatar when none is chosen yet.

    Best-effort and non-fatal, a failure here must never affect the crawl
    result. Runs for any bot-scoped crawl, full or partial: the icon is read
    from the homepage, so which pages the customer ticked is irrelevant to it.

    Three things must all hold, and the check is the first thing this does, so
    a re-crawl of a bot that fails any of them costs one indexed lookup and no
    network at all:

    * ``bot_logo_source`` is NULL. Nobody has ever set this avatar. A customer
      who uploaded one, or who REMOVED one, is stamped ``manual`` by both
      settings patches, and removal is the case ``bot_logo IS NULL`` alone
      cannot see: without provenance this step read a deliberate deletion as an
      empty slot and re-derived the picture on the next crawl.
    * ``bot_logo`` is empty. Belt and braces, and what makes this free for the
      overwhelmingly common re-crawl of an agent that already has an avatar.
    * ``avatar_type`` is still ``upload``, a customer who picked Orb or Mascot
      has ``bot_logo`` NULL by design.

    The favicon bytes are pushed through the same logo pipeline as a manual
    upload (:func:`upload_to_r2` square-crops + resizes to a 512x512 PNG), so the
    stored key and ``avatar_type='upload'`` render identically to a hand-uploaded
    logo everywhere the avatar is shown; ``bot_logo_source='derived'`` is what
    tells them apart afterwards.
    """
    if not CRAWL_FAVICON_AVATAR_ENABLED or not bot_id:
        return
    try:
        # Cheap pre-check: skip the network fetch entirely if an avatar exists.
        # Mirrors the authoritative post-fetch check below rather than being a
        # weaker subset of it, an orb/mascot bot is never going to pass that
        # check, and now that this runs on every crawl rather than only full
        # ones, letting it fetch a homepage and upload to R2 first would burn
        # the budget on every re-crawl to reach a foregone conclusion.
        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is None or bot.client_id != client_id or bot.bot_logo:
                return
            if bot.bot_logo_source is not None:
                logger.info("bot %s avatar was set by %s, not deriving one", bot_id, bot.bot_logo_source)
                return
            if (bot.avatar_type or "upload") != "upload":
                logger.info("bot %s uses the %s avatar. Leaving it alone", bot_id, bot.avatar_type)
                return

        from app.services.favicon_extractor import fetch_favicon_image

        image_bytes = await fetch_favicon_image(url)
        if not image_bytes:
            return

        from app.services.r2_service import upload_to_r2

        loop = asyncio.get_event_loop()
        logo_key = await loop.run_in_executor(
            None,
            lambda: upload_to_r2(image_bytes, "favicon.png", "image/png"),
        )
        if not logo_key:
            return

        # Re-check under a fresh session: the customer may have chosen an
        # avatar while we were fetching. Only claim a genuinely empty slot.
        with get_session() as session:
            bot = session.get(Bot, bot_id)
            if bot is None or bot.client_id != client_id or bot.bot_logo:
                return
            # Re-checked, not just pre-checked: the customer can remove their
            # avatar (stamping `manual`) during the seconds the fetch takes,
            # and that removal has to win.
            if bot.bot_logo_source is not None:
                logger.info("bot %s avatar was set by %s, not deriving one", bot_id, bot.bot_logo_source)
                return
            # `bot_logo` being empty is NOT the same as "no avatar chosen".
            # `avatar_type` has three legal values (upload / orb / mascot)
            # and a customer who picked Orb has bot_logo NULL. The old guard
            # checked only bot_logo, so it passed, then flipped avatar_type
            # from 'orb' to 'upload' and silently replaced a deliberate choice
            # with their favicon.
            if (bot.avatar_type or "upload") != "upload":
                logger.info("bot %s uses the %s avatar. Leaving it alone", bot_id, bot.avatar_type)
                return
            bot.bot_logo = logo_key
            bot.bot_logo_source = AVATAR_SOURCE_DERIVED
            # Write BOTH. `bot_routes` keeps these in lockstep on every API
            # write and the widget's launcher reads `launcher_logo`, so
            # setting only bot_logo left the in-chat avatar as the favicon
            # while the launcher bubble still showed the fallback robot.
            if not bot.launcher_logo:
                bot.launcher_logo = logo_key
            bot_key = bot.bot_key
            session.commit()
            # The widget reads bot_logo / launcher_logo out of a 10-minute
            # config cache, so a commit alone leaves the customer's site
            # showing the fallback robot for up to BOT_CONFIG_TTL. Every
            # mutating route in `bot_routes` drops this key after its commit;
            # this write is no different just because a crawl made it.
            cache_delete(bot_config_key(bot_key))
            logger.info("Set favicon avatar for bot %s from %s", bot_id, url)
    except Exception:
        logger.warning("favicon avatar acquisition failed for bot %s (non-fatal)", bot_id, exc_info=True)


async def _consume_ingest_stream(
    queue: "asyncio.Queue[dict | None]",
    *,
    wave_pages: int,
    ingest_wave: Callable[[list[dict], int], dict],
    cancel_requested: Callable[[], bool],
    totals: dict[str, int],
    state: dict,
    client_id: int | None = None,
) -> None:
    """Drain ``queue`` into wave-sized ingest calls until the ``None`` sentinel.

    Extracted from ``run_full_crawl`` so it can be unit-tested for the streaming
    deadlock in isolation. Waves run sequentially (one executor call at a time)
    so DB sessions and chunk buffers stay bounded; parallelism lives inside the
    ``ingest_wave`` call. A ``None`` sentinel marks end-of-stream: the tail wave
    is flushed and the coroutine returns.

    Shared mutable state (so the producer, the finish-signal helper, and the
    main flow all observe the same flags):

    * ``totals``. Accumulates ``chunks`` / ``pages_charged`` /
      ``credits_deducted`` across waves.
    * ``state['billing_aborted']``. Set by a wave that couldn't bill, by the
      cancel path, or by the finish helper; later pages are drained and dropped
      because embedding pages the user can't pay for wastes the quota.
    * ``state['consumer_error']``. Set to the first ingest exception. This is
      the deadlock-breaker: the moment an ingest wave raises we record the
      error, log it, and switch to *drain mode* (keep ``get``-ing and
      discarding pages until the sentinel) so the producer's bounded ``put``
      is always released instead of blocking forever on a full queue. The main
      flow then turns a non-null ``consumer_error`` into a fast crawl failure.
    """
    loop = asyncio.get_event_loop()
    buffer: list[dict] = []
    while True:
        page = await queue.get()
        done = page is None

        # Drain mode: an earlier wave already failed. Keep releasing the
        # producer's bounded put() by discarding pages until the sentinel.
        if state.get("consumer_error") is not None:
            if done:
                return
            continue

        if not done:
            buffer.append(page)
        # Stop embedding further waves the moment a cancel lands, the main
        # flow raises CrawlCancelled at its next checkpoint; here we just avoid
        # spending the embed budget on a crawl that's being cancelled.
        if not state["billing_aborted"] and not done and cancel_requested():
            logger.info("Ingest consumer halting embeds (cancel requested) client=%s", client_id)
            state["billing_aborted"] = True
        if state["billing_aborted"]:
            # Set either by a wave that couldn't bill or by the cancel path.
            # Drop everything buffered, including pages queued before the flag
            # flipped.
            buffer.clear()
        if buffer and (done or len(buffer) >= wave_pages):
            wave, buffer = buffer, []
            offset = totals["chunks"]
            try:
                result = await loop.run_in_executor(None, lambda w=wave, o=offset: ingest_wave(w, o))
            except Exception as exc:
                # An embed/ingest failure must NOT kill the consumer and strand
                # the producer on a full bounded queue (that was the ~27-minute
                # "running" hang). Record the error, then fall into drain mode.
                state["consumer_error"] = exc
                logger.exception("Ingest wave failed during crawl (client=%s). Draining stream", client_id)
                if done:
                    return
                continue
            totals["chunks"] += result["chunks"]
            totals["pages_charged"] += result["pages_charged"]
            totals["credits_deducted"] += result["credits_deducted"]
            if result.get("aborted"):
                state["billing_aborted"] = True
        if done:
            return


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
    force_reingest: bool = False,
    crawl_job_id: str | None = None,
    lock_token: str | None = None,
) -> dict:
    """Execute the full crawl pipeline end-to-end. Returns the result payload.

    Always writes a terminal ``done`` or ``failed`` state to Redis and always
    releases the per-client crawl lock, so callers don't need a try/finally
    of their own. Re-raises any underlying exception (the worker uses this to
    mark the job failed; the API surfaces it as a 5xx).

    Crawl knobs (``max_depth``, ``concurrency``) are plan-aware: the route
    layer resolves them from the client's plan and passes them through.
    ``max_pages`` is also clamped at the route layer, for JS crawls the
    route layer applies ``min(plan_max_pages, plan_js_max_pages)`` before
    forwarding, so a single capped ``max_pages`` is all the subprocess needs.
    ``None`` means "let the crawler subprocess fall back to its env defaults".
    """
    result_payload: dict | None = None
    started_at = time.time()
    # Denominator for the UI progress bar. Only ever a real, known page count
    # (the explicit ordered-crawl list length), never `max_pages`, which is
    # a plan/credit-derived *ceiling*, not a discovered total. A small site
    # with no sitemap (ordered_urls empty) falls into the recursive crawl
    # below with no discovered count at all; showing that site's progress as
    # "1/2398 pages" because 2398 happens to be this account's crawl budget
    # reads as "we found 2398 pages on your 20-page site" and is just wrong.
    # `None` here means "total unknown", the UI shows pages crawled so far
    # with no (fabricated) denominator instead.
    progress_max = len(ordered_urls) if ordered_urls else None
    crawled_urls: list[str] = []

    def _report_page(page_url: str, ok: bool) -> None:
        """Live per-page progress for the fetch phase. This is what unfreezes
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
    #
    # AR-23: bounded to a small multiple of the wave size. Fetch throughput
    # structurally outpaces embed throughput for any reasonably-sized site
    # (10-15 concurrent HTTP fetches vs. a shared, rate-limited embed budget),
    # so an unbounded queue here means the mismatch shows up as unbounded
    # worker-process memory growth instead of real backpressure. `_on_result`
    # is now async and awaited by the provider (spider_service.py /
    # jina_service.py) from inside its own per-page fetch coroutine, so
    # `await stream_queue.put(page)` naturally suspends just THAT page's
    # fetch slot when the queue is full. Other concurrent fetches (bounded
    # by the provider's own semaphore) keep running, and the event loop is
    # never blocked.
    stream_queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=CRAWL_INGEST_WAVE_PAGES * 2)
    ingest_totals = {"chunks": 0, "pages_charged": 0, "credits_deducted": 0}
    # Shared mutable state between the producer (``_on_result``), the consumer
    # (``_consume_ingest_stream``), the finish helper, and the main flow.
    #   billing_aborted: insufficient credits / kill switch / cancel → stop embedding.
    #   consumer_error:  first ingest exception → drain + fail the crawl fast
    #                    (instead of deadlocking the producer on a full queue).
    ingest_state: dict = {"billing_aborted": False, "consumer_error": None}
    streaming = CRAWL_STREAM_INGEST_ENABLED

    async def _on_result(page: dict) -> None:
        """Provider callback. Awaited from inside the provider's per-page
        fetch coroutine (see spider_service.py/jina_service.py). Suspends
        (does not block the event loop) once the bounded queue is full,
        providing real producer-side backpressure."""
        # Fast-fail: if ingestion has already failed, stop scraping the rest of
        # the site rather than pointlessly filling a queue whose consumer is
        # only draining-and-discarding. The consumer's drain mode is the actual
        # deadlock guarantee; this just aborts the scrape early. (If the
        # provider swallows callback exceptions, the drain still prevents any
        # hang and the main flow still fails the crawl.)
        if ingest_state["consumer_error"] is not None:
            raise CrawlerError("Embedding failed during crawl")
        await stream_queue.put(page)

    def _report_embed_stream(done_cum: int) -> None:
        """Live cumulative embed progress while the scrape may still be running."""
        set_crawl_progress(
            client_id,
            status="running",
            urls=list(crawled_urls),
            pages_crawled=len(crawled_urls),
            max_pages=progress_max,
            phase=f"Embedding - {done_cum:,} chunks so far",
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
            crawl_job_id=crawl_job_id,
            embed_progress_cb=lambda done, _total: _report_embed_stream(chunk_offset + done),
            crawl_started_at=started_at,
            force_reingest=force_reingest,
        )

    async def _ingest_consumer() -> None:
        """Drain ``stream_queue`` into wave-sized ``batch_web_ingestion`` calls.

        Thin closure over the module-level :func:`_consume_ingest_stream`,
        binding this crawl's queue, wave size, ingest callable, cancel check,
        and the shared ``ingest_totals`` / ``ingest_state`` so the producer and
        the finish helper observe the same flags. The extracted function owns
        the drain-on-error logic that breaks the streaming deadlock.
        """
        await _consume_ingest_stream(
            stream_queue,
            wave_pages=CRAWL_INGEST_WAVE_PAGES,
            ingest_wave=_ingest_wave,
            cancel_requested=lambda: is_cancellation_requested(client_id),
            totals=ingest_totals,
            state=ingest_state,
            client_id=client_id,
        )

    async def _finish_consumer(consumer: asyncio.Task | None, *, discard_pending: bool = False) -> None:
        """Signal end-of-stream and wait for in-flight waves to finish.

        ``discard_pending=True`` (cancel path) drops queued-but-uningested
        pages instead of embedding them. An executor-bound wave that already
        started cannot be interrupted; we wait it out (bounded: one wave).
        """
        if consumer is None:
            return
        if discard_pending:
            ingest_state["billing_aborted"] = True
        # await, not put_nowait, the queue is now bounded (AR-23) and could
        # legitimately be full at this exact moment.
        await stream_queue.put(None)
        await consumer

    consumer_task: asyncio.Task | None = None
    # Phase 1 footer harvest. Runs in parallel with the main crawl. Only
    # fires for a URL crawl (ordered_urls is a partial re-scrape that already
    # has an explicit page list, so a site-wide footer pass would be off
    # topic there). Log-only for now: the awaited result is emitted to the
    # crawl log so we can validate signal quality on real customer sites
    # before wiring the media into the ingest pipeline. Failure modes are
    # all silent + bounded (30s timeout below, cancel on teardown) so no
    # kill switch is needed at this stage.
    footer_task: asyncio.Task | None = None
    if not ordered_urls:
        footer_task = asyncio.create_task(harvest_footer_media(url))

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

        # Await the parallel footer harvest and log its findings. Bounded
        # wait so a hung Spider scrape here can never delay the crawl's
        # completion beyond the main scrape's own budget. Cancels and
        # swallows on timeout. This is a diagnostic side channel.
        if footer_task is not None:
            try:
                footer_media = await asyncio.wait_for(footer_task, timeout=30.0)
            except TimeoutError:
                footer_task.cancel()
                with contextlib.suppress(BaseException):
                    await footer_task
                footer_media = {}
                logger.info("footer_harvest timeout url=%s", url)
            except Exception:
                footer_media = {}
                logger.warning("footer_harvest failed url=%s", url, exc_info=True)
            finally:
                footer_task = None
            if footer_media:
                logger.info(
                    "footer_harvest url=%s youtube_videos=%d youtube_channels=%d files=%d",
                    url,
                    len(footer_media.get("youtube") or []),
                    len(footer_media.get("youtube_channels") or []),
                    len(footer_media.get("files") or []),
                )
            else:
                logger.info("footer_harvest url=%s no media found", url)

        results = crawl_data.get("results")
        recommended_colors = crawl_data.get("recommended_colors") or []
        # The active crawl providers (Spider, Jina) return markdown, not HTML,
        # so their ``recommended_colors`` is always empty. Fetch the seed URL's
        # raw HTML once and extract the brand palette from its CSS/inline
        # styles. Best-effort, a fetch failure keeps ``recommended_colors``
        # empty, which then correctly clears any stale palette on the bot.
        if not recommended_colors:
            try:
                recommended_colors = await fetch_recommended_colors(url)
            except Exception:
                logger.warning("brand color extraction failed for %s", url, exc_info=True)
                recommended_colors = []

        # A cancel that landed just as the scrape finished (so the provider
        # returned normally instead of raising) still stops here. Before we
        # spend the embed budget on the final sweep. Runs AFTER the color
        # fallback so a mid-cancel run still surfaces whatever palette we
        # managed to extract for the retry attempt.
        if is_cancellation_requested(client_id):
            raise CrawlCancelled({"results": results or [], "recommended_colors": recommended_colors})
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
        # Heartbeat spans the wait, the tail wave can be a multi-minute embed.
        if consumer_task is not None:
            async with crawl_heartbeat(client_id):
                await _finish_consumer(consumer_task)
            consumer_task = None
            # An ingest wave raised during streaming: the consumer drained the
            # rest of the queue (no deadlock) but embedding genuinely failed.
            # Route it into the ``except CrawlerError`` path below so the crawl
            # terminates FAST as ``failed`` instead of hanging until the ARQ
            # job timeout, and the frontend shows its error branch.
            if ingest_state["consumer_error"] is not None:
                raise CrawlerError("Embedding failed during crawl") from ingest_state["consumer_error"]

        # A cancel that landed during the streamed embed above stops here rather
        # than running the (potentially multi-minute) final sweep.
        if is_cancellation_requested(client_id):
            raise CrawlCancelled({"results": valid_pages, "recommended_colors": recommended_colors})

        sweep_offset = ingest_totals["chunks"]

        def _report_embed(done_chunks: int, total_chunks: int) -> None:
            """Live embed progress. Keeps the UI moving through the multi-minute
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
        # billing abort. Those pages can't be paid for.
        loop = asyncio.get_event_loop()
        if not ingest_state["billing_aborted"]:
            logger.info("Batch ingesting %d pages (%d chunks already streamed)", pages_processed, sweep_offset)
            # Heartbeat spans the embed loop. CPU/network-bound and the phase
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
                        force_reingest=force_reingest,
                        crawl_job_id=crawl_job_id,
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
        # wants. Skip it in that case.
        if replace_source and total_chunks > 0 and not ordered_urls:
            newly_crawled_urls = [p["url"] for p in valid_pages]
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

            # Candidate stale pages: stored under this source but absent from the
            # current crawl. "Absent from this crawl" is NOT the same as "removed
            # from the site", a transient discovery shortfall (e.g. the sitemap
            # was briefly unreachable and we fell back to a shallower link/
            # recursive crawl) would otherwise mass-delete pages that still
            # exist. So we confirm each candidate is actually gone before
            # deleting; check_urls_alive is conservative (only a confirmed
            # 404/410 counts as dead. Timeouts, 5xx, and blocks are kept).
            with get_session() as del_session:
                candidate_urls = [
                    row[0]
                    for row in del_session.query(Document.document_name)
                    .filter(
                        domain_expr == replace_source,
                        owner_filter,
                        Document.document_name.notin_(newly_crawled_urls),
                    )
                    .distinct()
                    .all()
                ]

            dead_urls: list[str] = []
            if candidate_urls:
                from app.services.url_discovery import check_urls_alive

                async with crawl_heartbeat(client_id):
                    liveness = await check_urls_alive(candidate_urls)
                dead_urls = [u for u, alive in liveness.items() if not alive]

            deleted = 0
            if dead_urls:
                with get_session() as del_session:
                    deleted = (
                        del_session.query(Document)
                        .filter(
                            domain_expr == replace_source,
                            owner_filter,
                            Document.document_name.in_(dead_urls),
                        )
                        .delete(synchronize_session=False)
                    )
                    del_session.commit()
            logger.info(
                "Orphan sweep for '%s': %d pages missing from this crawl, %d confirmed gone "
                "(%d chunks removed), %d retained as still-live",
                replace_source,
                len(candidate_urls),
                len(dead_urls),
                deleted,
                len(candidate_urls) - len(dead_urls),
            )

        # Brand tone (classified into a preset) + company context
        # (best-effort, non-fatal on error).
        brand_tone_key = None
        company_context: dict | None = None
        if valid_pages and bot_id:
            content_sample = "\n\n".join(p["content"][:1000] for p in valid_pages[:3])
            try:
                brand_tone_key, company_context = await asyncio.gather(
                    loop.run_in_executor(None, lambda: classify_brand_tone(content_sample)),
                    loop.run_in_executor(None, lambda: extract_company_context(content_sample)),
                )
            except Exception:
                logger.warning("brand/company extraction failed for bot %s", bot_id, exc_info=True)

        # Smart-default services URL: pick the best service-page candidate from
        # the crawled URLs. Only fills the field when the admin hasn't set one
        # yet, so re-crawls never overwrite an explicit choice.
        services_url_suggestion = _pick_services_url(valid_pages)

        # Resolve the classified preset key to its canonical, prompt-ready text.
        brand_tone_text = preset_text(brand_tone_key)

        # Persist crawl metadata. For a bot-scoped crawl we ALWAYS run through
        # the helper (even when everything extracted was empty) so a re-crawl
        # that yields no palette resets the stale colors from a prior site
        # instead of silently keeping them. See the ``recommended_colors``
        # handling inside ``_apply_crawl_metadata_to_bot``. For the client-
        # fallback path (bot_id is None) we keep the original "only touch DB
        # when there's data" behavior, nothing user-visible depends on
        # clearing the client-level palette between crawls.
        should_persist = (
            bot_id is not None or recommended_colors or brand_tone_text or company_context or services_url_suggestion
        )
        if should_persist:
            with get_session() as session:
                if bot_id:
                    bot_db = session.get(Bot, bot_id)
                    if bot_db and bot_db.client_id == client_id:
                        written = _apply_crawl_metadata_to_bot(
                            bot_db,
                            recommended_colors=recommended_colors,
                            brand_tone=brand_tone_text,
                            brand_tone_preset=brand_tone_key,
                            company_context=company_context,
                            services_url_suggestion=services_url_suggestion,
                        )
                        session.commit()
                        logger.info("Saved crawl metadata for bot %s: wrote %s", bot_id, written or "nothing")
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
        # defensively, never negative, even if the subprocess and the post-
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
            "brand_tone": brand_tone_text,
            "brand_tone_preset": brand_tone_key,
            # Coverage visibility. UI uses these to render
            # "Ingested 200 pages. 347 more were discovered but didn't fit
            #  your plan's cap. Upgrade or split the crawl by section."
            "pages_discovered": discovered_total,
            "pages_dropped": pages_dropped,
        }
        # A crawl that fetched pages but extracted zero readable text (common on
        # JS-rendered sites where the HTTP-only fetch never sees the hydrated
        # DOM) must NOT report success. There is no knowledge for the bot to
        # answer from. But ``total_chunks == 0`` alone conflates two different
        # things: a fresh crawl that genuinely found no readable content vs. a
        # delta recrawl of an unchanged site where SHA-256 dedup skipped every
        # page while the bot still holds all its prior content. Use the bot's
        # real indexed document count as the ground truth. ``no_content`` only
        # when the bot has NO usable knowledge at all, never latching the
        # durable "trained" marker in that case (see the ``chunk_count`` guard
        # in ``_record_bot_crawl_state``).
        bot_content_count = 0
        if total_chunks == 0 and bot_id is not None:
            try:
                from app.db.repository import count_documents_for_bot

                with get_session() as _count_session:
                    bot_content_count = count_documents_for_bot(_count_session, bot_id=bot_id)
            except Exception:
                logger.warning(
                    "no_content check: failed to count documents for bot %s (treating as done)",
                    bot_id,
                    exc_info=True,
                )
                bot_content_count = 1  # fail safe toward "done", never show a false no-content error
        crawl_status = _terminal_status(total_chunks, bot_content_count)
        if crawl_status == "no_content":
            result_payload["message"] = (
                "We reached your pages but couldn't extract readable text to train on. "
                "This often happens on sites that render content with JavaScript."
            )
            result_payload["no_content"] = True
        set_crawl_progress(
            client_id,
            status=crawl_status,
            urls=[p["url"] for p in valid_pages],
            result=result_payload,
        )
        _record_bot_crawl_state(bot_id, crawl_status)
        if crawl_status == "done":
            # Warm the seed-question cache now (worker/background), so the Prove
            # step reads a cached value instead of paying LLM + embedding latency
            # live. Skipped for a no-content crawl. There's nothing to seed from.
            _precompute_seed_questions(bot_id)

        # Drop an in-app notification so the user sees the result in the bell
        # even if they navigated away. Best-effort, never fail the crawl on it.
        # Suppressed for zero-content: that isn't a "crawl completed
        # successfully" event and shouldn't read as one in the notification feed.
        if crawl_status == "done":
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

        # Auto-avatar: harvest the site's icon and set it as the bot's avatar
        # when the customer has not chosen one.
        #
        # LAST, and hard-bounded. It used to sit above the result payload and
        # the terminal status write, unbounded: a homepage with 300 <link
        # rel="icon"> tags produced 302 sequential candidates at up to 10s
        # each, far past the worker's job timeout. An ARQ cancellation raises
        # CancelledError (a BaseException, so neither the `except Exception`
        # here nor the "failed" handler below catches it) and the crawl was
        # already fetched, ingested and BILLED. The customer's spinner hung
        # forever on completed work, and a retry re-ran the whole crawl.
        #
        # Now nothing before this point depends on it, and the budget holds
        # regardless of how many candidates a site declares.
        #
        # One caveat on "bounded", because `wait_for` only interrupts at an
        # await point: `core/ssrf` resolves DNS with a blocking
        # `socket.getaddrinfo` (validate + pin, per hop, per candidate). A
        # blackholed authoritative nameserver stalls the whole event loop past
        # this budget, and the crawl lock below is released in `finally`, so it
        # is held for that time too. That is a property of the shared SSRF
        # helpers rather than of this step, and it applies equally to the
        # footer harvest and the colour extractor above, but it is the reason
        # this budget is a backstop, not a guarantee.
        #
        # NOT gated on `ordered_urls`, unlike the footer harvest above. That
        # exclusion exists because a partial re-scrape has an explicit PAGE
        # list, so re-running page-level site work would be off topic. The
        # favicon is SITE work: it is read from the homepage and has nothing
        # to do with which pages were ticked. Gating it on `ordered_urls` made
        # it dead code for the flow that matters, the admin panel pre-ticks
        # every discovered page, so `ordered_urls` is set on essentially every
        # crawl started from it, INCLUDING a customer's first one, which is
        # exactly when the bot has no avatar and this is worth anything.
        #
        # The real gate is "this bot has no avatar yet", which
        # `_maybe_apply_favicon_avatar` already applies as its first cheap
        # pre-check, one indexed primary-key SELECT, before any network call.
        # So a re-crawl of a bot that already has an avatar costs one query,
        # and only a bot still missing one pays for the homepage fetch, capped
        # at `_FAVICON_TOTAL_BUDGET_S` and after the terminal result is out.
        try:
            await asyncio.wait_for(
                _maybe_apply_favicon_avatar(bot_id, client_id, url),
                timeout=_FAVICON_TOTAL_BUDGET_S,
            )
        except TimeoutError:
            logger.info("favicon avatar timed out for bot %s. Crawl already complete", bot_id)
        except Exception:
            logger.warning("favicon avatar failed for bot %s (non-fatal)", bot_id, exc_info=True)

        return result_payload
    except CrawlCancelled as exc:
        # User pressed Cancel. Honour it FAST. We stop scraping, discard every
        # page not yet ingested (``discard_pending=True`` drops the queued
        # buffer instead of embedding it), and only wait out a wave that is
        # already mid-embed. That work is committed+billed atomically per page
        # and cannot be interrupted safely.
        #
        # Trade-off: with streaming, waves ingested *before* the cancel are
        # kept and billed. That content is already live in the bot's knowledge
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
        _record_bot_crawl_state(bot_id, "cancelled")
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
        _record_bot_crawl_state(bot_id, "failed")
        raise
    except Exception as exc:
        logger.exception("Crawling failed unexpectedly for client %s: %s", client_id, exc)
        set_crawl_progress(
            client_id,
            status="failed",
            error="Crawling failed. Please try again.",
        )
        _record_bot_crawl_state(bot_id, "failed")
        raise
    finally:
        # Never leak the consumer task: on any failure path, drop pending pages
        # and wait out at most one in-flight wave (already-committed work stays
        # , it's billed atomically per page). suppress() keeps a consumer crash
        # from masking the original exception; its traceback is logged here.
        if consumer_task is not None:
            try:
                await _finish_consumer(consumer_task, discard_pending=True)
            except Exception:
                logger.exception("Streaming ingest consumer failed during crawl teardown for client %s", client_id)
        # Never leak the footer harvest task either. It only survives here on
        # a failure path (the happy path awaits + nulls it above); cancel and
        # drain silently so a stray Spider POST can't outlive the crawl.
        if footer_task is not None:
            footer_task.cancel()
            with contextlib.suppress(BaseException):
                await footer_task
        # Ownership-checked release: only frees the lock if this run still owns
        # it. ``lock_token=None`` (job enqueued by an older API node during a
        # rolling deploy) falls back to the legacy unconditional delete.
        release_crawl_lock(client_id, lock_token)
