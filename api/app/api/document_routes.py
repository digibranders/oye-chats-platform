import asyncio
import logging
from pathlib import Path

import psutil
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile

from app.api.auth import get_current_client_or_operator
from app.config import DOCUMENTS_DIR
from app.core.rate_limit import key_from_api_key, limiter
from app.db.models import Bot, Client, Document
from app.db.repository import get_ingested_documents
from app.db.session import get_session
from app.ingestion.pipeline import batch_web_ingestion, run_folder_ingestion
from app.schemas.client import CrawlRequest
from app.services.crawler_service import CrawlerError, crawl_website
from app.services.llm_service import extract_brand_tone

logger = logging.getLogger(__name__)

router = APIRouter(tags=["documents"])

# Upload limits (bytes)
_MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB per file
_MAX_TOTAL_UPLOAD = 60 * 1024 * 1024  # 60 MB per request

# Per-client crawl locks: each customer can run 1 crawl at a time without
# blocking other customers.  Memory: ~200 bytes per lock × N clients.
_crawl_locks: dict[int, asyncio.Lock] = {}


def _get_crawl_lock(client_id: int) -> asyncio.Lock:
    """Return a per-client asyncio.Lock, creating one if needed."""
    if client_id not in _crawl_locks:
        _crawl_locks[client_id] = asyncio.Lock()
    return _crawl_locks[client_id]


def _check_memory():
    """Raise if memory usage is too high to safely run a crawl."""
    mem = psutil.virtual_memory()
    if mem.percent > 70:
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
    background_tasks.add_task(_run_ingestion_background, client_id, DOCUMENTS_DIR, bot_id)
    return {
        "message": "Documents are being processed",
        "files_uploaded": saved_files,
        "status": "processing",
    }


@router.post("/crawl")
@limiter.limit("3/hour", key_func=key_from_api_key)
async def crawl_endpoint(
    crawl_request: CrawlRequest,
    request: Request,
    bot_id: int | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Crawl a URL recursively and ingest content for a client."""
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)
    _check_memory()

    # Per-client lock: each customer can run one crawl at a time.
    # Other customers are not blocked.
    lock = _get_crawl_lock(client_id)
    if lock.locked():
        raise HTTPException(status_code=429, detail="A crawl job is already running for your account. Please wait.")

    await lock.acquire()
    try:
        logger.info(f"Crawling URL recursively: {crawl_request.url} for client {client_id}, bot_id={bot_id}")
        crawl_data = await crawl_website(crawl_request.url, max_pages=crawl_request.max_pages)

        results = crawl_data.get("results")
        recommended_colors = crawl_data.get("recommended_colors", [])

        if not results:
            raise HTTPException(status_code=400, detail="Failed to retrieve content from URL")

        valid_pages = [p for p in results if p.get("url") and p.get("content")]
        pages_processed = len(valid_pages)
        logger.info(f"Batch ingesting {pages_processed} pages")
        loop = asyncio.get_event_loop()
        total_chunks = await loop.run_in_executor(
            None,
            lambda: batch_web_ingestion(client_id, valid_pages, bot_id=bot_id),
        )

        # Extract brand tone from crawled content (non-blocking, best-effort)
        brand_tone = None
        if valid_pages and bot_id:
            content_sample = "\n\n".join(p["content"][:1000] for p in valid_pages[:3])
            brand_tone = await loop.run_in_executor(None, lambda: extract_brand_tone(content_sample))

        if recommended_colors or brand_tone:
            with get_session() as session:
                if bot_id:
                    bot_db = session.get(Bot, bot_id)
                    if bot_db and bot_db.client_id == client_id:
                        if recommended_colors:
                            bot_db.recommended_colors = recommended_colors
                        if brand_tone:
                            bot_db.brand_tone = brand_tone
                        session.commit()
                        logger.info(
                            f"Saved crawl metadata for bot {bot_id}: "
                            f"colors={len(recommended_colors) if recommended_colors else 0}, "
                            f"tone={'yes' if brand_tone else 'no'}"
                        )
                elif recommended_colors:
                    client_db = session.get(Client, client_id)
                    if client_db:
                        client_db.recommended_colors = recommended_colors
                        session.commit()
                        logger.info(f"Saved {len(recommended_colors)} recommended colors for client {client_id}")

        return {
            "message": "Crawling and ingestion completed successfully",
            "root_url": crawl_request.url,
            "pages_processed": pages_processed,
            "chunks_processed": total_chunks,
            "pages_crawled": [p["url"] for p in valid_pages],
            "recommended_colors": recommended_colors,
            "brand_tone": brand_tone,
        }
    except HTTPException:
        raise
    except CrawlerError as e:
        logger.error(f"Crawling failed: {e}")
        raise HTTPException(status_code=500, detail="Crawling failed. The target site may be unreachable.") from e
    except Exception as e:
        logger.error(f"Crawling failed unexpectedly: {e}")
        raise HTTPException(status_code=500, detail="Crawling failed. Please try again.") from e
    finally:
        lock.release()
