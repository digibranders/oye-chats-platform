import asyncio
import logging
from pathlib import Path

import psutil
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile

from app.api.auth import get_current_client_or_operator, require_active_subscription_for_workspace
from app.config import DOCUMENTS_DIR
from app.core.cache import cache_delete_prefix, qa_prefix_for_bot
from app.core.rate_limit import key_from_api_key, limiter
from app.db.models import Bot, Document
from app.db.repository import get_ingested_documents, get_pages_for_source
from app.db.session import get_session
from app.ingestion.pipeline import run_folder_ingestion
from app.schemas.client import CrawlDiffRequest, CrawlDiscoverRequest, CrawlRequest, DocumentPagesResponse
from app.services.crawler_service import (
    acquire_crawl_lock,
    get_crawl_progress,
    is_cancellation_requested,
    release_crawl_lock,
    request_cancellation,
    set_crawl_progress,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["documents"])

# Upload limits (bytes)
_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB per file
_MAX_TOTAL_UPLOAD = 60 * 1024 * 1024  # 60 MB per request


def _check_memory():
    """Raise if memory usage is too high to safely run a crawl.

    Threshold is configurable via CRAWL_MEMORY_THRESHOLD env var (default 90).
    Raise the default on local dev machines where >70% is normal; lower it
    on memory-constrained production servers if needed.
    """
    import os

    threshold = int(os.getenv("CRAWL_MEMORY_THRESHOLD", "90"))
    mem = psutil.virtual_memory()
    if mem.percent > threshold:
        raise HTTPException(
            status_code=503,
            detail="Server memory too high for crawling. Please try again later.",
            headers={"Retry-After": "60"},
        )


def _require_knowledge_management_access(auth: dict) -> None:
    """Only workspace owners, admins, and direct client logins can manage knowledge sources."""
    if auth["type"] == "client":
        return
    if getattr(auth["entity"], "role", "agent") not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="You do not have permission to manage knowledge sources.")


def _verify_bot_ownership(bot_id: int | None, client_id: int) -> None:
    """Verify that bot_id belongs to client_id. Prevents cross-workspace access (IDOR)."""
    if bot_id is None:
        return
    from sqlalchemy import select as sa_select

    with get_session() as session:
        bot = session.execute(sa_select(Bot).where(Bot.id == bot_id, Bot.client_id == client_id)).scalar_one_or_none()
        if not bot:
            raise HTTPException(status_code=403, detail="Bot not found or access denied.")


@router.get("/documents")
def get_documents_endpoint(bot_id: int | None = Query(None), auth: dict = Depends(get_current_client_or_operator)):
    """Retrieve a list of all ingested documents for the authenticated client."""
    _verify_bot_ownership(bot_id, auth["client_id"])
    try:
        with get_session() as session:
            docs = get_ingested_documents(session, client_id=auth["client_id"], bot_id=bot_id)
            return docs
    except Exception as e:
        logger.error(f"Failed to fetch documents: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch documents.") from e


@router.get("/documents/pages", response_model=DocumentPagesResponse)
def get_document_pages_endpoint(
    source: str = Query(..., description="Normalized root domain (e.g. fynix.digital)"),
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Return all crawled page URLs for a website source, with per-page chunk counts and titles."""
    _verify_bot_ownership(bot_id, auth["client_id"])
    try:
        with get_session() as session:
            result = get_pages_for_source(session, source=source, bot_id=bot_id, client_id=auth["client_id"])
            return result
    except Exception as e:
        logger.error(f"Failed to fetch pages for source '{source}': {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch source pages.") from e


@router.delete("/documents/{document_name:path}")
def delete_document_endpoint(
    document_name: str,
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Delete all documents associated with a document name for the authenticated client."""
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)
    logger.info(f"Deletion request for client {client_id}, bot_id={bot_id}, source: {document_name}")
    try:
        from sqlalchemy import func

        with get_session() as session:
            pattern = func.coalesce(
                func.replace(func.substring(Document.document_name, r"^(https?://[^/]+)"), "www.", ""),
                Document.document_name,
            )

            base_filter = [pattern == document_name]
            if bot_id:
                base_filter.append(Document.bot_id == bot_id)
            else:
                base_filter.append(Document.client_id == client_id)

            deleted_count = session.query(Document).filter(*base_filter).delete(synchronize_session=False)
            session.commit()
            logger.info(f"Deleted {deleted_count} records for Source: {document_name}")

            if deleted_count == 0:
                fallback_filter = [Document.document_name == document_name]
                if bot_id:
                    fallback_filter.append(Document.bot_id == bot_id)
                else:
                    fallback_filter.append(Document.client_id == client_id)
                deleted_count = session.query(Document).filter(*fallback_filter).delete(synchronize_session=False)
                session.commit()

            if deleted_count == 0:
                raise HTTPException(status_code=404, detail=f"Source '{document_name}' not found.")

            base_dir = Path(DOCUMENTS_DIR).resolve()
            file_path = (base_dir / document_name).resolve()
            if not file_path.is_relative_to(base_dir):
                raise HTTPException(status_code=403, detail="Invalid document path.")
            if file_path.exists():
                file_path.unlink()
                logger.info(f"Deleted file from disk: {file_path}")

            # Invalidate cached QA responses — knowledge base has changed
            if bot_id:
                cache_delete_prefix(qa_prefix_for_bot(bot_id))

            logger.info(f"Deleted {deleted_count} chunks for document '{document_name}' (client {client_id})")
            return {"message": f"Successfully deleted '{document_name}'", "chunks_removed": deleted_count}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete document '{document_name}': {e}")
        raise HTTPException(status_code=500, detail="Failed to delete document.") from e


def _run_ingestion_background(client_id: int, documents_dir: str, bot_id: int | None):
    """Background task: run document ingestion pipeline."""
    try:
        count = run_folder_ingestion(client_id, documents_dir, bot_id=bot_id)
        logger.info(f"Background ingestion completed: {count} documents processed for client {client_id}")
    except Exception as e:
        logger.error(f"Background ingestion failed for client {client_id}: {e}")


@router.post("/ingest")
@limiter.limit("10/minute", key_func=key_from_api_key)
def ingest_documents(
    request: Request,
    files: list[UploadFile] = File(...),
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    _sub=Depends(require_active_subscription_for_workspace),
):
    """Ingest multiple files (PDF, DOCX, TXT, MD) for a client.

    Subscription-gated — uploading new content into the knowledge base is
    a paid-feature action. Customers with an expired trial can still see
    and delete what they already uploaded, just not add more until they
    reactivate.

    Credit-metered at ``credit_cost.document_upload`` per file (default 2).
    Cost is calculated against the post-validation file count so unsupported
    extensions and oversize files don't burn credits. Deduction happens
    BEFORE the disk write so we never persist a file we can't bill for; if
    a write later fails, the per-file cost is refunded.
    """
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)

    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

    # ── Plan enforcement: cap on total documents per workspace ──
    # The credit gate further down stops a Free user from spending more
    # credits than they have; this plan-level check stops them from
    # uploading more documents than their tier allows (5/15/35/unlimited)
    # regardless of credit balance. Run BEFORE expensive file reads.
    from app.services.plan_entitlements_service import UNLIMITED, get_entitlements

    with get_session() as db:
        entitlements = get_entitlements(client_id, db, include_usage=True)
        docs_limit = entitlements.limit_for("documents")
        if docs_limit != UNLIMITED:
            current_docs = int(entitlements.usage.get("documents", 0))
            attempted = len(files)
            if current_docs + attempted > docs_limit:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "error": "limit_reached",
                        "limit": "documents",
                        "current": current_docs,
                        "max": docs_limit,
                        "attempted": attempted,
                        "current_plan": entitlements.plan_slug,
                        "message": (
                            f"You've reached your plan's document limit "
                            f"({current_docs}/{docs_limit}). "
                            f"Delete existing documents or upgrade to add more."
                        ),
                        "upgrade_url": "/billing",
                    },
                )

    supported_extensions = [".pdf", ".docx", ".txt", ".md"]
    saved_paths: list[str] = []  # Track written paths for cleanup on failure
    saved_files: list[str] = []
    total_bytes = 0

    # ── Phase 1: Validate ALL file sizes before writing anything to disk ──
    file_buffers: list[tuple[str, bytes]] = []
    for file in files:
        if not any(file.filename.lower().endswith(ext) for ext in supported_extensions):
            logger.warning(f"Skipping unsupported file: {file.filename}")
            continue

        content = file.file.read()
        file_size = len(content)

        if file_size > _MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"File '{file.filename}' exceeds 10 MB limit ({file_size / (1024 * 1024):.1f} MB).",
            )
        total_bytes += file_size
        if total_bytes > _MAX_TOTAL_UPLOAD:
            raise HTTPException(
                status_code=413,
                detail=f"Total upload exceeds 60 MB limit ({total_bytes / (1024 * 1024):.1f} MB).",
            )
        file_buffers.append((file.filename, content))

    if not file_buffers:
        raise HTTPException(status_code=400, detail="No valid files (PDF, DOCX, TXT, MD) supplied.")

    # ── Phase 1.5: Credit pre-flight ──
    # Charge upfront so a client with insufficient credits can't slip
    # past validation, write 60 MB to disk, and only fail at ingest time.
    # Refund happens below if any file write actually fails.
    from app.db.models import Bot as _Bot
    from app.services import credit_service

    # Resolve per-bot ledger scope ONCE so deduct + refund agree on which
    # bucket to charge / repay. Per-bot subscriptions get their own
    # isolated ledger; legacy-pooled and Free bots drain the client pool.
    ledger_bot_id: int | None = None
    if bot_id is not None:
        with get_session() as db:
            _bot_for_ledger = db.get(_Bot, bot_id)
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(_bot_for_ledger)

    per_doc_cost = 0
    deducted_amount = 0
    with get_session() as db:
        per_doc_cost = credit_service.get_credit_cost(db, "document_upload")
        total_cost = per_doc_cost * len(file_buffers)
        if total_cost > 0:
            try:
                credit_service.check_and_deduct(
                    db,
                    client_id,
                    total_cost,
                    reason="document_upload",
                    reference_id=bot_id,
                    bot_id=ledger_bot_id,
                )
                db.commit()
                deducted_amount = total_cost
            except credit_service.InsufficientCredits as exc:
                db.rollback()
                raise HTTPException(
                    status_code=402,
                    detail={
                        "error": "insufficient_credits",
                        "required": exc.required,
                        "available": exc.available,
                        "per_document_cost": per_doc_cost,
                        "document_count": len(file_buffers),
                        "message": (
                            f"Uploading {len(file_buffers)} document(s) costs {exc.required} credits, "
                            f"but you only have {exc.available}. Top up or upgrade to continue."
                        ),
                    },
                ) from exc
            except credit_service.KillSwitchActive as exc:
                db.rollback()
                raise HTTPException(
                    status_code=503,
                    detail={
                        "error": "billing_paused",
                        "message": "Billing is temporarily paused for maintenance.",
                    },
                ) from exc

    # ── Phase 2: All files validated + credits secured — write to disk ──
    base_dir = Path(DOCUMENTS_DIR).resolve()
    for filename, content in file_buffers:
        file_path = (base_dir / filename).resolve()
        if not file_path.is_relative_to(base_dir):
            logger.warning(f"Blocked path traversal attempt in upload: {filename}")
            continue
        try:
            with open(file_path, "wb") as buffer:
                buffer.write(content)
            saved_paths.append(file_path)
            saved_files.append(filename)
            logger.info(f"Saved file: {filename} ({len(content) / 1024:.0f} KB)")
        except Exception as e:
            logger.error(f"Failed to save {filename}: {e}")

    # Refund credits for any files that failed to save. The pre-flight
    # charged for ``len(file_buffers)`` but only ``len(saved_files)`` are
    # actually being ingested. The delta is unfair to bill for.
    failed_count = len(file_buffers) - len(saved_files)
    if failed_count > 0 and per_doc_cost > 0:
        refund_amount = per_doc_cost * failed_count
        with get_session() as db:
            try:
                credit_service.refund(
                    db,
                    client_id,
                    refund_amount,
                    reference_id=bot_id or 0,
                    note=f"document_upload partial failure ({failed_count} files)",
                    bot_id=ledger_bot_id,
                )
                db.commit()
                deducted_amount -= refund_amount
            except Exception as refund_err:
                # Refund failure is non-fatal — log loudly so it can be
                # reconciled manually if it ever happens.
                logger.error(
                    "Document upload refund failed for client=%s amount=%s: %s",
                    client_id,
                    refund_amount,
                    refund_err,
                )

    if not saved_files:
        raise HTTPException(status_code=400, detail="No valid files (PDF, DOCX, TXT, MD) saved.")

    logger.info(
        f"Starting background ingestion for {len(saved_files)} files for client {client_id}, bot_id={bot_id}..."
    )

    # Use ARQ worker when enabled, otherwise fall back to FastAPI BackgroundTasks
    from app.worker.enqueue import WORKER_ENABLED

    job_id = None
    if WORKER_ENABLED:
        from app.worker.enqueue import enqueue_sync

        job_id = enqueue_sync("task_ingest_documents", client_id, DOCUMENTS_DIR, bot_id)
    else:
        background_tasks.add_task(_run_ingestion_background, client_id, DOCUMENTS_DIR, bot_id)

    response: dict = {
        "message": "Documents are being processed",
        "files_uploaded": saved_files,
        "status": "processing",
        "credits_charged": deducted_amount,
        "credits_per_document": per_doc_cost,
    }
    if job_id:
        response["job_id"] = job_id
    return response


@router.get("/ingest/status/{job_id}")
async def ingest_status_endpoint(
    job_id: str,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Poll the status of a background ingestion job.

    Returns the job's current state: queued, in_progress, complete, or failed.
    Only available when WORKER_ENABLED=true (ARQ task queue).
    """
    from app.worker.enqueue import WORKER_ENABLED

    if not WORKER_ENABLED:
        raise HTTPException(
            status_code=501,
            detail="Job status tracking requires WORKER_ENABLED=true",
        )

    from app.worker.enqueue import get_job_status

    status = await get_job_status(job_id)
    return status


@router.get("/crawl/progress")
def crawl_progress_endpoint(auth: dict = Depends(get_current_client_or_operator)):
    """Return live progress + terminal status for the caller's crawl.

    Polled by the frontend every few seconds. Reads from Redis so the same
    state is visible whether the crawl is running in this API process or in
    the ARQ worker. The response always contains ``status`` (one of
    ``"idle" | "running" | "cancelling" | "cancelled" | "done" | "failed"``)
    and ``urls`` (list of URLs discovered so far). When ``status="running"``
    the response also contains ``pages_crawled``, ``max_pages``,
    ``current_url``, ``started_at`` (epoch seconds), and ``cancellable``
    (bool) so the UI can render a real progress bar, an ETA, and a Cancel
    button. When ``status="done"`` / ``"cancelled"`` the response contains
    ``result`` with the ingestion payload; when ``"failed"`` it contains
    ``error``.
    """
    client_id = auth["client_id"]
    payload = get_crawl_progress(client_id)
    # A cancel may have been requested between the orchestrator's last
    # progress write and now — surface it immediately so the UI can flip
    # the toast to "Cancelling…" without waiting a full poll cycle.
    if payload.get("status") == "running" and is_cancellation_requested(client_id):
        payload = dict(payload)
        payload["status"] = "cancelling"
    return payload


@router.post("/crawl/cancel", status_code=202)
@limiter.limit("30/minute", key_func=key_from_api_key)
def crawl_cancel_endpoint(
    request: Request,
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Request cancellation of the caller's in-flight crawl.

    Returns 202 immediately. The orchestrator (running in the ARQ worker or
    inline) sees the cancel flag within ~1s, asks the crawler subprocess to
    stop cooperatively between URLs (fast, clean, no leaked Chromium), and
    falls back to SIGTERM if the subprocess doesn't honour it within a few
    seconds. Any pages that were crawled before the cancel landed are still
    ingested so we don't throw away work the customer already paid for.

    Idempotent: calling cancel twice is fine; the flag is a single Redis key
    that auto-expires when the crawl finishes (or after ``CRAWL_SUBPROCESS
    _TIMEOUT + 60s`` if everything goes sideways).
    """
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)

    progress = get_crawl_progress(client_id)
    if progress.get("status") not in {"running", "cancelling"}:
        # Nothing to cancel — let the UI know so it doesn't get stuck in a
        # "Cancelling…" state. Returns 200 with a clear message, not an error.
        return {"status": progress.get("status", "idle"), "message": "No crawl in progress."}

    request_cancellation(client_id)
    # Flip the visible status immediately for snappier UI feedback. The
    # orchestrator's final write (``cancelled`` + result payload) lands within
    # a few seconds via the normal progress write path.
    set_crawl_progress(
        client_id,
        status="cancelling",
        urls=progress.get("urls", []),
        started_at=progress.get("started_at"),
        pages_crawled=progress.get("pages_crawled"),
        max_pages=progress.get("max_pages"),
        current_url=progress.get("current_url"),
        cancellable=False,
    )
    logger.info("Crawl cancellation requested for client %s (bot_id=%s)", client_id, bot_id)
    return {"status": "cancelling", "message": "Cancel requested. Crawl will stop within a few seconds."}


@router.post("/crawl/discover")
@limiter.limit("120/hour", key_func=key_from_api_key)
async def crawl_discover_endpoint(
    discover_request: CrawlDiscoverRequest,
    request: Request,
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Discover the number of crawlable pages on a site without ingesting content.

    Fetches robots.txt → sitemaps → falls back to a 1-level HTML BFS if no
    sitemap is found. Returns within ~20 seconds. Used by the frontend to show
    "Found X pages. Ready to crawl?" before the user commits to a full crawl.

    The ``total_found`` count is capped at the caller's plan ``max_crawl_pages``
    ceiling so the number is always actionable and never exceeds what the plan
    allows. ``capped=true`` signals that there may be more pages than shown.

    Paid plans (Starter/Standard) carry an UNLIMITED (-1) page cap because
    crawling is metered purely by credits; for them the discovery query falls
    back to a fixed 1000-URL ceiling so the preview stays bounded.
    """
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)
    _check_memory()

    from app.services import credit_service, plan_service
    from app.services.plan_service import UNLIMITED
    from app.services.url_discovery import discover_website_urls

    with get_session() as db:
        plan = plan_service.get_client_plan(db, client_id)
        crawl_limits = plan_service.get_crawl_limits(plan)
        plan_max = crawl_limits["max_crawl_pages"]
        # Credit inputs — read before the long (network) discovery call so we
        # never hold a DB connection across it. Balance is bot-scoped so per-bot
        # subscriptions get the ledger they will actually be charged against.
        cost_per_page = credit_service.get_credit_cost(db, "url_scan")
        balance = credit_service.get_balance(db, client_id, bot_id=bot_id)

    _DISCOVERY_HARD_CAP = 1000
    discovery_cap = _DISCOVERY_HARD_CAP if plan_max == UNLIMITED else min(plan_max, _DISCOVERY_HARD_CAP)
    urls: list[str] = []
    try:
        urls = await discover_website_urls(
            discover_request.url,
            max_urls=discovery_cap,
            timeout=20.0,
        )
        total = len(urls)
    except Exception as exc:
        logger.warning("URL discovery failed for %s: %s", discover_request.url, exc)
        total = 0

    per_page = max(int(cost_per_page), 1)
    max_affordable_pages = int(balance) // per_page
    credits_required_full = total * cost_per_page

    return {
        "url": discover_request.url,
        "total_found": total,
        "capped": total >= discovery_cap,
        "plan_max": plan_max,
        "urls": urls,
        "cost_per_page": cost_per_page,
        "balance": balance,
        "max_affordable_pages": max_affordable_pages,
        "credits_required_full": credits_required_full,
        "exceeds_balance": credits_required_full > balance,
    }


@router.post("/crawl/diff")
@limiter.limit("30/hour", key_func=key_from_api_key)
async def crawl_diff_endpoint(
    diff_request: CrawlDiffRequest,
    request: Request,
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Diff a recrawl against the existing knowledge base for the given source.

    Runs the same robots.txt → sitemap → BFS discovery as ``/crawl/discover`` and
    compares the resulting URL set against the pages already stored under
    ``replace_source`` for this bot/client. Returns exact counts: ``unchanged``
    (URL present in both), ``new_pages`` (in sitemap but not stored), and
    ``removed_pages`` (stored but no longer in sitemap).

    Notes:
    * URL-level diff only — actual content changes are detected per-page during
      the crawl itself via the SHA-256 dedup hash in the ingestion pipeline. This
      endpoint is fast (no page fetches) and is purely for the pre-recrawl
      confirmation UI.
    * Numbers are exact within the discovery cap; if ``capped`` is true the
      sitemap exceeded the plan ceiling and only the first ``plan_max`` URLs
      were considered.
    """
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)
    _check_memory()

    from urllib.parse import urlparse

    from app.services import plan_service
    from app.services.crawler_script import normalize_url
    from app.services.plan_service import UNLIMITED
    from app.services.url_discovery import check_urls_alive, discover_website_urls

    with get_session() as db:
        plan = plan_service.get_client_plan(db, client_id)
        crawl_limits = plan_service.get_crawl_limits(plan)
        plan_max = crawl_limits["max_crawl_pages"]

    _DISCOVERY_HARD_CAP = 1000
    discovery_cap = _DISCOVERY_HARD_CAP if plan_max == UNLIMITED else min(plan_max, _DISCOVERY_HARD_CAP)

    # Stored ``document_name`` values were written through the crawler's
    # ``normalize_url`` (strip www., drop tracking params, remove trailing
    # slash + ``/index.html``, sort query string). Discovery returns raw
    # sitemap/HTML URLs, so we MUST run them through the same function or
    # nothing will ever line up.
    def _normalize(u: str) -> str:
        try:
            return normalize_url(u.strip())
        except Exception:
            return u.strip().rstrip("/").lower()

    # ── Step 1: pull every URL-typed Document for this scope ──────────────
    # Filter by hostname in Python. The legacy SQL ``domain_expr`` in the
    # orphan sweep extracts ``https://host`` and compares it against the
    # bare-domain ``replace_source`` — that filter never matches in practice.
    target_host = diff_request.replace_source.lower().removeprefix("www.")
    owner_filter = Document.bot_id == bot_id if bot_id else Document.client_id == client_id
    with get_session() as db:
        url_rows = (
            db.query(Document.document_name).filter(owner_filter, Document.document_name.like("http%")).distinct().all()
        )

    # Map normalized URL → canonical raw URL we'll HEAD-check. Two stored
    # variants (e.g. ``/about/`` and ``/about``) collapse to one normalized
    # key so we only probe the origin once per page.
    stored_norm_to_raw: dict[str, str] = {}
    for row in url_rows:
        raw = row[0]
        if not raw:
            continue
        try:
            host = urlparse(raw).netloc.lower().removeprefix("www.")
        except Exception:
            continue
        if host != target_host:
            continue
        norm = _normalize(raw)
        stored_norm_to_raw.setdefault(norm, raw)

    # ── Steps 2 & 3 run concurrently with an overall budget ──────────────
    # HEAD-checking N stored URLs at concurrency=15 with an 8s per-request
    # timeout is the dominant cost on large knowledge bases — for 500+ URLs
    # against a slow origin the wall-clock can blow past the client's 30s
    # timeout. Two mitigations:
    #   (a) Run HEAD liveness AND sitemap discovery concurrently with
    #       asyncio.gather — they share no state.
    #   (b) Cap the whole liveness pass at 20s. Anything not resolved in
    #       time inherits the existing "assume alive" fallback policy,
    #       which is conservative (never recommends deleting a page on a
    #       transient blip) and matches the existing exception handler.
    HEAD_BUDGET_SECONDS = 20.0
    DISCOVERY_BUDGET_SECONDS = 20.0
    head_partial = False
    raw_urls_to_check = list(stored_norm_to_raw.values())

    async def _liveness_with_budget() -> dict[str, bool]:
        nonlocal head_partial
        if not raw_urls_to_check:
            return {}
        try:
            return await asyncio.wait_for(
                check_urls_alive(raw_urls_to_check),
                timeout=HEAD_BUDGET_SECONDS,
            )
        except TimeoutError:
            logger.warning(
                "HEAD liveness check exceeded %.0fs budget for %s (%d URLs) — falling back to assume-alive",
                HEAD_BUDGET_SECONDS,
                diff_request.url,
                len(raw_urls_to_check),
            )
            head_partial = True
            return {raw: True for raw in raw_urls_to_check}
        except Exception as exc:
            logger.warning("HEAD liveness check failed for %s: %s", diff_request.url, exc)
            head_partial = True
            return {raw: True for raw in raw_urls_to_check}

    async def _discovery_with_budget() -> list[str]:
        try:
            return await asyncio.wait_for(
                discover_website_urls(
                    diff_request.url,
                    max_urls=discovery_cap,
                    timeout=DISCOVERY_BUDGET_SECONDS,
                ),
                timeout=DISCOVERY_BUDGET_SECONDS + 2.0,
            )
        except TimeoutError:
            logger.warning(
                "URL discovery exceeded %.0fs budget for %s",
                DISCOVERY_BUDGET_SECONDS,
                diff_request.url,
            )
            return []
        except Exception as exc:
            logger.warning("URL discovery failed for %s: %s", diff_request.url, exc)
            return []

    liveness, sitemap_urls = await asyncio.gather(
        _liveness_with_budget(),
        _discovery_with_budget(),
    )

    unchanged_norm: set[str] = set()
    removed_norm: set[str] = set()
    for norm, raw in stored_norm_to_raw.items():
        if liveness.get(raw, True):
            unchanged_norm.add(norm)
        else:
            removed_norm.add(norm)

    discovery_norm_to_raw: dict[str, str] = {}
    for u in sitemap_urls:
        if not u:
            continue
        discovery_norm_to_raw.setdefault(_normalize(u), u)

    # "New" = discovered but not previously stored. Discovery's reach only
    # affects how many net-new pages we can show — it cannot incorrectly
    # delete a page from the unchanged set.
    new_norm = set(discovery_norm_to_raw.keys()) - set(stored_norm_to_raw.keys())

    _PREVIEW_CAP = 500

    def _sample(norm_set: set[str], lookup: dict[str, str]) -> list[str]:
        # Show the raw URL the customer would recognise, sorted for stability.
        return sorted({lookup[n] for n in norm_set if n in lookup})[:_PREVIEW_CAP]

    return {
        "url": diff_request.url,
        "replace_source": diff_request.replace_source,
        "sitemap_total": len(discovery_norm_to_raw),
        "existing_total": len(stored_norm_to_raw),
        "unchanged": len(unchanged_norm),
        "new_pages": len(new_norm),
        "removed_pages": len(removed_norm),
        "unchanged_urls": _sample(unchanged_norm, stored_norm_to_raw),
        "new_urls": _sample(new_norm, discovery_norm_to_raw),
        "removed_urls": _sample(removed_norm, stored_norm_to_raw),
        "preview_cap": _PREVIEW_CAP,
        "capped": len(discovery_norm_to_raw) >= discovery_cap,
        "plan_max": plan_max,
        # True when the HEAD liveness pass timed out or errored and we fell
        # back to "assume alive" for some/all stored URLs. The UI uses this
        # to hint the removed-count may be undercounted.
        "head_partial": head_partial,
    }


@router.post("/crawl", status_code=202)
@limiter.limit("10/hour", key_func=key_from_api_key)
async def crawl_endpoint(
    crawl_request: CrawlRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
    _sub=Depends(require_active_subscription_for_workspace),
):
    """Start a crawl + ingestion job for a client.

    The actual crawl runs in the ARQ worker (or as a FastAPI BackgroundTask
    when WORKER_ENABLED=false), so this endpoint returns 202 immediately
    with a ``job_id``. Callers poll ``GET /crawl/progress`` to read live URL
    discovery and the terminal ``done`` / ``failed`` state.
    """
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)
    _check_memory()

    # ── Plan-aware crawl limits ──
    # Resolve the client's plan-tier crawl knobs *before* the credit
    # pre-flight so an over-the-limit request is rejected with a clear
    # upgrade signal instead of a generic "out of credits" error. The
    # ceiling is also used to fill in ``max_pages`` when the request
    # didn't specify one — that's how Free-tier callers get the full
    # 20-page allowance without sending a body field.
    #
    # Paid plans (Starter/Standard) carry ``max_crawl_pages == UNLIMITED``
    # (-1) because their crawl budget is set by credits, not a per-crawl
    # page cap. For those plans we skip the over-limit gate and derive a
    # concrete ceiling from the available balance — the crawler subprocess
    # always needs an integer, and we never want a runaway "max pages
    # left blank" request to enumerate a 100k-URL sitemap.
    from app.services import credit_service, plan_service
    from app.services.plan_service import UNLIMITED

    # Safety bound so an unlimited-plan caller who passes an absurd
    # ``max_pages`` (or whose credit balance happens to be huge after a
    # large top-up) can't accidentally spawn a multi-day crawl. Sits well
    # above the largest practical customer sitemap.
    _UNLIMITED_PLAN_SAFETY_CEILING = 10_000

    with get_session() as db:
        plan = plan_service.get_client_plan(db, client_id)
        crawl_limits = plan_service.get_crawl_limits(plan)
        plan_max_pages = crawl_limits["max_crawl_pages"]
        plan_max_depth = crawl_limits["max_crawl_depth"]
        plan_js_max_pages = crawl_limits["max_crawl_js_pages"]
        plan_concurrency = crawl_limits["max_crawl_concurrency"]
        unlimited_pages = plan_max_pages == UNLIMITED

        requested_pages = crawl_request.max_pages
        # Hard plan cap rejection only fires for plans that actually have
        # a concrete cap (currently just Free). Unlimited-plan callers
        # skip straight to the credit pre-flight below — that's the real
        # gate on Starter/Standard.
        if not unlimited_pages and requested_pages is not None and int(requested_pages) > plan_max_pages:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "plan_limit_exceeded",
                    "limit_type": "max_crawl_pages",
                    "plan_slug": plan.slug,
                    "plan_name": plan.name,
                    "plan_max": plan_max_pages,
                    "requested": int(requested_pages),
                    "upgrade_url": "/billing",
                    "message": (
                        f"Your {plan.name} plan allows up to {plan_max_pages} pages per crawl. "
                        f"You requested {int(requested_pages)}. Upgrade to crawl more."
                    ),
                },
            )

        cost_per_page = credit_service.get_credit_cost(db, "url_scan")
        if unlimited_pages:
            # No plan cap — let the caller request what they want, but
            # always cap at the safety ceiling so a typo can't ignite a
            # runaway job. If ``max_pages`` is omitted, fall back to what
            # the caller's current balance can afford (one page = one
            # ``cost_per_page`` deduction). ``cost_per_page`` is clamped
            # to ``>= 1`` to guard against a zero-cost misconfiguration.
            per_page = max(int(cost_per_page), 1)
            if requested_pages is not None:
                effective_max_pages = max(int(requested_pages), 1)
            else:
                available_now = credit_service.get_balance(db, client_id)
                effective_max_pages = max(int(available_now) // per_page, 1)
            effective_max_pages = min(effective_max_pages, _UNLIMITED_PLAN_SAFETY_CEILING)
        else:
            # Fixed-cap plan (Free): clamp to plan ceiling — covers the
            # None case so callers that didn't specify ``max_pages`` get
            # the full tier allowance.
            effective_max_pages = min(int(requested_pages or plan_max_pages), plan_max_pages)

        if crawl_request.use_js:
            # JS mode is memory-bound regardless of plan tier, so the
            # JS-specific cap always applies on top.
            effective_max_pages = min(effective_max_pages, plan_js_max_pages)

        # ── Credit pre-flight: reserve enough for the worst-case crawl ──
        # We charge per page actually ingested (not per request), so the
        # pre-flight uses ``effective_max_pages * cost_per_page`` as an upper
        # bound. The real deduction happens per-page atomically inside
        # batch_web_ingestion. Using the post-clamp value keeps the
        # pre-flight honest — without this, an Enterprise customer who
        # passed ``max_pages=5000`` could be blocked here because we
        # mis-multiplied by the unclamped request.
        #
        # Recrawl exception: when ``replace_source`` is set the ingestion
        # pipeline SHA-256-skips every unchanged page (see
        # ingestion/pipeline.py: is_document_processed), so charging for the
        # full plan ceiling massively over-reserves. If the caller supplies
        # ``expected_new_pages`` (sourced from a server-authoritative
        # /crawl/diff call moments earlier), size the pre-flight against that
        # plus a small buffer. The atomic per-page deduction inside
        # batch_web_ingestion remains the real safety net — if the diff was
        # stale or new pages appeared in between, ingestion stops cleanly on
        # InsufficientCredits at that point.
        # ``cost_per_page`` was already resolved above so we could derive
        # the unlimited-plan ceiling from the caller's balance; reuse it.
        precheck_pages = effective_max_pages
        precheck_is_recrawl = False
        if crawl_request.replace_source and crawl_request.expected_new_pages is not None:
            # 10-page buffer absorbs minor drift between diff time and crawl
            # time without re-opening the over-reservation hole.
            RECRAWL_PRECHECK_BUFFER = 10
            precheck_pages = min(
                effective_max_pages,
                max(crawl_request.expected_new_pages + RECRAWL_PRECHECK_BUFFER, 1),
            )
            precheck_is_recrawl = True
        required = cost_per_page * max(precheck_pages, 1)
        available = credit_service.get_balance(db, client_id)
        if available < required:
            if precheck_is_recrawl:
                message = (
                    f"This re-crawl needs up to {required} credits "
                    f"({cost_per_page} per page × {precheck_pages} pages — "
                    f"{crawl_request.expected_new_pages} new + buffer). "
                    f"You have {available}. Upgrade your plan or buy a top-up to proceed."
                )
            else:
                message = (
                    f"This crawl needs up to {required} credits "
                    f"({cost_per_page} per page × {precheck_pages} pages). "
                    f"You have {available}. Upgrade your plan or buy a top-up to proceed."
                )
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "insufficient_credits",
                    "required": required,
                    "available": available,
                    "message": message,
                },
            )

    # Explicit ordered-URL slice (credit-aware partial crawl). Validate the
    # client-supplied list is same-origin as the seed (blocks SSRF / crawling
    # someone else's domain on this client's credits) and cap it to what the
    # credit pre-flight above reserved, so it can never overspend.
    ordered_urls = crawl_request.ordered_urls
    if ordered_urls:
        from urllib.parse import urlparse

        seed_host = urlparse(str(crawl_request.url)).netloc.lower().removeprefix("www.")
        same_origin = [u for u in ordered_urls if urlparse(u).netloc.lower().removeprefix("www.") == seed_host]
        if not same_origin:
            raise HTTPException(status_code=400, detail={"error": "ordered_urls_off_domain"})
        ordered_urls = same_origin[:effective_max_pages]

    # Per-client crawl lock — held in Redis so the ARQ worker and the API
    # process see the same state. SETNX with TTL means a crashed holder
    # eventually frees the lock automatically. The lock is released by
    # ``run_full_crawl``'s finally block, regardless of which process runs it.
    if not acquire_crawl_lock(client_id):
        raise HTTPException(status_code=429, detail="A crawl job is already running for your account. Please wait.")

    # Publish an immediate "running" state so the UI's progress poll picks up
    # the job before the worker even starts.
    set_crawl_progress(client_id, status="running", urls=[])

    job_id: str | None = None
    try:
        from app.worker.enqueue import WORKER_ENABLED, enqueue

        if WORKER_ENABLED:
            job = await enqueue(
                "task_crawl_and_ingest",
                client_id,
                bot_id,
                crawl_request.url,
                effective_max_pages,
                crawl_request.use_js,
                crawl_request.replace_source,
                cost_per_page,
                plan_max_depth,
                plan_concurrency,
                ordered_urls=ordered_urls,
            )
            job_id = job.job_id if job is not None else None
            logger.info(
                "Crawl enqueued for client %s: %s (job_id=%s, plan=%s, pages=%d, depth=%d)",
                client_id,
                crawl_request.url,
                job_id,
                plan.slug,
                effective_max_pages,
                plan_max_depth,
            )
        else:
            # Local-dev fallback: run inline as a FastAPI BackgroundTask so
            # the response still fires immediately and the existing polling
            # behaviour matches production.
            from app.services.crawl_orchestrator import run_full_crawl

            background_tasks.add_task(
                run_full_crawl,
                client_id=client_id,
                bot_id=bot_id,
                url=crawl_request.url,
                max_pages=effective_max_pages,
                use_js=crawl_request.use_js,
                replace_source=crawl_request.replace_source,
                cost_per_page=cost_per_page,
                max_depth=plan_max_depth,
                concurrency=plan_concurrency,
                ordered_urls=ordered_urls,
            )
            logger.info(
                "Crawl scheduled inline (WORKER_ENABLED=false) for client %s (plan=%s, pages=%d, depth=%d)",
                client_id,
                plan.slug,
                effective_max_pages,
                plan_max_depth,
            )
    except Exception as exc:
        # Enqueue failed before the orchestrator could take ownership of the
        # lock — release it here so the user isn't locked out indefinitely.
        release_crawl_lock(client_id)
        set_crawl_progress(client_id, status="failed", error="Failed to start crawl.")
        logger.exception("Failed to enqueue crawl for client %s: %s", client_id, exc)
        raise HTTPException(status_code=503, detail="Could not start crawl. Please try again.") from exc

    response: dict = {
        "message": "Crawl started",
        "status": "running",
        "root_url": crawl_request.url,
        "poll_url": "/crawl/progress",
    }
    if job_id:
        response["job_id"] = job_id
    return response
