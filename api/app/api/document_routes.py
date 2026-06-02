import logging
from pathlib import Path

import psutil
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile

from app.api.auth import get_current_client_or_operator
from app.config import DOCUMENTS_DIR
from app.core.cache import cache_delete_prefix, qa_prefix_for_bot
from app.core.rate_limit import key_from_api_key, limiter
from app.db.models import Bot, Document
from app.db.repository import get_ingested_documents, get_pages_for_source
from app.db.session import get_session
from app.ingestion.pipeline import run_folder_ingestion
from app.schemas.client import CrawlRequest, DocumentPagesResponse
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
_MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB per file
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
):
    """Ingest multiple files (PDF, DOCX, TXT, MD) for a client."""
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)

    # File ingestion is no longer credit-metered (URL crawling is the metered
    # ingest path; uploads are unlimited within the plan). The legacy
    # ``knowledge_pages`` limit was a soft storage cap that's been retired
    # along with the per-metric ``UsageRecord`` table.
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")

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
                detail=f"File '{file.filename}' exceeds 20 MB limit ({file_size / (1024 * 1024):.1f} MB).",
            )
        total_bytes += file_size
        if total_bytes > _MAX_TOTAL_UPLOAD:
            raise HTTPException(
                status_code=413,
                detail=f"Total upload exceeds 60 MB limit ({total_bytes / (1024 * 1024):.1f} MB).",
            )
        file_buffers.append((file.filename, content))

    # ── Phase 2: All files validated — write to disk ──
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


@router.post("/crawl", status_code=202)
@limiter.limit("3/hour", key_func=key_from_api_key)
async def crawl_endpoint(
    crawl_request: CrawlRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
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

    # ── Credit pre-flight: reserve enough for the worst-case crawl ──
    # We charge per page actually ingested (not per request), so the pre-flight
    # uses ``max_pages * cost_per_page`` as an upper bound. The real deduction
    # happens per-page atomically inside batch_web_ingestion.
    from app.services import credit_service

    with get_session() as db:
        cost_per_page = credit_service.get_credit_cost(db, "url_scan")
        required = cost_per_page * max(int(crawl_request.max_pages or 1), 1)
        available = credit_service.get_balance(db, client_id)
        if available < required:
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "insufficient_credits",
                    "required": required,
                    "available": available,
                    "message": (
                        f"This crawl needs up to {required} credits "
                        f"({cost_per_page} per page × {crawl_request.max_pages} pages). "
                        f"You have {available}. Upgrade your plan or buy a top-up to proceed."
                    ),
                },
            )

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
                crawl_request.max_pages,
                crawl_request.use_js,
                crawl_request.replace_source,
                cost_per_page,
            )
            job_id = job.job_id if job is not None else None
            logger.info("Crawl enqueued for client %s: %s (job_id=%s)", client_id, crawl_request.url, job_id)
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
                max_pages=crawl_request.max_pages,
                use_js=crawl_request.use_js,
                replace_source=crawl_request.replace_source,
                cost_per_page=cost_per_page,
            )
            logger.info("Crawl scheduled inline (WORKER_ENABLED=false) for client %s", client_id)
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
