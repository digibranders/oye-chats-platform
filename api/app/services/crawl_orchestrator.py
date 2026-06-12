"""End-to-end crawl pipeline.

Encapsulates the steps that used to live inline inside the ``POST /crawl``
route handler, so the API and the ARQ worker can share the same code path.
The orchestrator:

1. Runs the crawler subprocess via :func:`crawler_service.crawl_website`.
2. Batch-ingests the discovered pages, deducting credits per page in the
   same DB transaction as the chunk insert (atomic billing).
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
import logging

from app.db.models import Bot, Client, Document
from app.db.session import get_session
from app.ingestion.pipeline import batch_web_ingestion
from app.services.crawler_service import (
    CrawlCancelled,
    CrawlerError,
    crawl_website,
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
    try:
        logger.info("Crawling URL recursively: %s for client %s, bot_id=%s", url, client_id, bot_id)
        crawl_data = await crawl_website(
            url,
            max_pages=max_pages,
            use_js=use_js,
            client_id=client_id,
            max_depth=max_depth,
            concurrency=concurrency,
        )

        results = crawl_data.get("results")
        recommended_colors = crawl_data.get("recommended_colors", [])

        if not results:
            raise CrawlerError("Failed to retrieve content from URL")

        valid_pages = [p for p in results if p.get("url") and p.get("content")]
        pages_processed = len(valid_pages)
        logger.info("Batch ingesting %d pages", pages_processed)
        loop = asyncio.get_event_loop()
        ingest_result = await loop.run_in_executor(
            None,
            lambda: batch_web_ingestion(
                client_id,
                valid_pages,
                bot_id=bot_id,
                cost_per_page=cost_per_page,
                deduct_reason="url_scan",
                deduct_reference_id=bot_id,
            ),
        )
        total_chunks = ingest_result["chunks"]
        pages_charged = ingest_result["pages_charged"]
        credits_deducted = ingest_result["credits_deducted"]

        # Orphan sweep: remove chunks for pages that disappeared from the site.
        if replace_source and total_chunks > 0:
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
        }
        set_crawl_progress(
            client_id,
            status="done",
            urls=[p["url"] for p in valid_pages],
            result=result_payload,
        )
        return result_payload
    except CrawlCancelled as exc:
        # User pressed Cancel — honour it FAST. Cancel must feel instant; we
        # do not run any further work (especially not OpenAI embeddings,
        # which take seconds per chunk and stall the UI for minutes when the
        # subprocess collected dozens of pages before stopping). We simply
        # write the terminal status and return.
        #
        # Trade-off: pages that were crawled but not yet ingested are
        # discarded. That matches user intent — they clicked Cancel because
        # they wanted the work to stop. Credits are deducted per page inside
        # ``batch_web_ingestion``, so by skipping the ingest we also skip the
        # charge for those pages. Nothing the user paid for is lost; we just
        # didn't bill them for work they asked us to abandon.
        partial = exc.partial_result or {}
        partial_results = partial.get("results") or []
        partial_urls = [p["url"] for p in partial_results if p.get("url")]
        result_payload = {
            "message": "Crawl cancelled by user",
            "root_url": url,
            "pages_processed": 0,
            "chunks_processed": 0,
            "credits_deducted": 0,
            "pages_crawled": partial_urls,
        }
        set_crawl_progress(
            client_id,
            status="cancelled",
            urls=partial_urls,
            result=result_payload,
        )
        logger.info("Cancelled crawl for client %s: %d pages discovered, none ingested", client_id, len(partial_urls))
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
        release_crawl_lock(client_id)
