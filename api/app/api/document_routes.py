import asyncio
import logging
import re
import time
from pathlib import Path

import psutil
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile

# ``pathlib.Path`` is imported above and used throughout this module; alias
# FastAPI's path-parameter marker so the two never shadow each other.
from fastapi import Path as PathParam

from app.api.auth import (
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
    require_verified_email_for_workspace,
)
from app.config import DOCUMENTS_DIR
from app.core.cache import cache_delete_prefix, gate_prefix_for_bot, qa_prefix_for_bot
from app.core.rate_limit import key_from_operator_credential, limiter
from app.db.models import Bot, Document
from app.db.repository import (
    count_knowledge_state,
    get_ingested_documents,
    get_pages_for_source,
    sync_bot_knowledge_state,
)
from app.db.session import get_session
from app.ingestion.cleaner import clean_text
from app.ingestion.pipeline import delete_archived_copies, run_folder_ingestion
from app.schemas.client import CrawlDiffRequest, CrawlDiscoverRequest, CrawlRequest, DocumentPagesResponse
from app.schemas.validators import MAX_URL, Identifier, RowId
from app.services.crawler_service import (
    acquire_crawl_lock,
    clear_cancellation,
    crawl_lock_holder,
    get_crawl_progress,
    is_cancellation_requested,
    release_crawl_lock,
    request_cancellation,
    set_crawl_progress,
)
from app.services.knowledge_quota_service import KnowledgeQuotaExceeded, check_kb_quota

logger = logging.getLogger(__name__)

# Interactive-crawl preemption of a background auto-recrawl. When a user clicks
# Train/Recrawl while an hourly auto-recrawl is mid-run, we signal that recrawl
# to cancel and wait (bounded) for it to release the shared per-client lock,
# rather than rejecting a legitimate user action with a hard 429.
_PREEMPT_POLL_INTERVAL_S = 0.5
_PREEMPT_MAX_WAIT_S = 8.0


async def _acquire_crawl_lock_or_preempt(client_id: int) -> str | None:
    """Acquire the interactive crawl lock, preempting a background auto-recrawl.

    A user-initiated crawl should not be blocked by an hourly auto-recrawl.
    If the lock is held by a ``recrawl:`` holder we signal it to cancel and wait
    (bounded) for it to release, then take the lock. A lock held by another
    INTERACTIVE crawl is NOT preempted. That returns ``None`` so the caller
    429s. Returns the ownership token, or ``None`` if it could not be acquired
    in time.
    """
    token = acquire_crawl_lock(client_id)
    if token is not None:
        return token
    holder = crawl_lock_holder(client_id)
    if holder is None or not holder.startswith("recrawl:"):
        # Free-then-reheld race, or an interactive holder → don't preempt.
        return None
    request_cancellation(client_id)
    deadline_iterations = int(_PREEMPT_MAX_WAIT_S / _PREEMPT_POLL_INTERVAL_S)
    for _ in range(deadline_iterations):
        await asyncio.sleep(_PREEMPT_POLL_INTERVAL_S)
        token = acquire_crawl_lock(client_id)
        if token is not None:
            return token
    return None


router = APIRouter(tags=["documents"])

# Upload limits (bytes)
_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB per file
_MAX_TOTAL_UPLOAD = 60 * 1024 * 1024  # 60 MB per request

# Cap on parts in one multipart body. The byte ceilings above bound total
# volume but not part COUNT, and every part costs a filename check, a temp
# path and (in the preview endpoint) an extraction attempt, so 50,000 empty
# parts inside a small body used to be a free per-part loop.
_MAX_FILES_PER_REQUEST = 50

# Supported upload extensions, shared by /ingest and /ingest/preview-cost so
# the preview can never disagree with what the real upload accepts.
_SUPPORTED_EXTENSIONS = (".pdf", ".docx", ".txt", ".md")

# A safe stored file name: no separators, no traversal, no control bytes, and
# short enough for any filesystem. The upload path also resolves the final
# path and re-checks containment. This is the cheap first gate.
_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._\-()]{0,200}$")


def _safe_upload_filename(raw: str | None) -> str | None:
    """Return *raw* if it is a usable, contained file name, else ``None``.

    Rejects rather than rewrites. A name mangled into something "safe" is
    stored under a name the customer never chose and cannot find again, and
    two different rejects can collide onto one accepted name, so a bad name
    is skipped and reported, not repaired.
    """
    if not raw:
        return None
    if raw != raw.strip() or "\x00" in raw:
        return None
    if not _SAFE_FILENAME_RE.match(raw):
        return None
    # ``.`` / ``..`` match the charset but are not file names.
    if raw.strip(".") == "":
        return None
    return raw


def _read_upload_bounded(upload: UploadFile, max_bytes: int) -> bytes:
    """Read at most ``max_bytes + 1`` bytes from a multipart part.

    ``UploadFile.file.read()`` with no argument materialises the whole part
    before anything can object to its size, which is the exact ordering
    ``core.upload_guard`` was written to avoid. This is that helper's
    synchronous twin. These two endpoints are sync ``def`` routes, so they
    cannot await the async one. Returning one byte past the limit is enough
    for the caller to detect the breach without buffering the rest.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = upload.file.read(64 * 1024)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > max_bytes:
            break
    return b"".join(chunks)


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
            detail="Server memory too high for training. Please try again later.",
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


def resolve_crawl_pricing(session, client_id: int, bot_id: int | None) -> tuple[int, int]:
    """``(cost_per_page, free_pages_remaining)`` for a crawl about to start.

    The trial ships an allowance of FREE PAGES rather than a free first crawl.
    The old rule was a boolean — ``first_training_free`` made the whole first
    crawl cost nothing, bounded only by the plan's 100-page ceiling. At 5 credits
    a page that is 500 credits, the entire trial grant, handed to whoever
    happened to have the larger website. A fixed allowance gives every trial the
    same offer and leaves the credits for evaluating the product.

    The allowance is ``limits.free_training_pages`` on the plan row, so plan
    behaviour stays in plan data like every other limit, and a plan without the
    key simply gets none of it.

    **Pages, not chunks.** One crawled page becomes many ``Document`` rows, so
    counting rows would spend a 25-page allowance inside the first page or two.
    ``distinct(document_name)`` is the page URL for a crawl, and is how the rest
    of this codebase already counts pages.

    **Per account, not per bot.** ``bot_id`` is an OPTIONAL query parameter on
    all three crawl routes, so a per-bot allowance is farmable: one crawl with
    it omitted (documents land with a NULL ``bot_id``) and one with it set are
    two scopes, and both would come out free. Counting per account closes that
    and is what the trial means anyway, since it grants exactly one bot.

    Re-crawls are free on every tier and never reach here with a cost to pay
    (``recrawl_service`` passes 0).

    Known and accepted, carried over from the previous rule: deleting every
    crawl-sourced document makes the allowance available again, because
    eligibility is inferred from live rows rather than from a durable "consumed"
    marker. Closing it needs a billing-state change this does not carry. The
    exposure is now 25 pages per deletion rather than 100.
    """
    from sqlalchemy import distinct as _sa_distinct
    from sqlalchemy import func as _sa_func
    from sqlalchemy import select as _sa_select

    from app.services import credit_service, plan_entitlements_service

    cost_per_page = credit_service.get_credit_cost(session, "url_scan")

    entitlements = plan_entitlements_service.get_entitlements(client_id, session)
    allowance = entitlements.limit_for("free_training_pages")
    if not isinstance(allowance, int) or allowance <= 0:
        return cost_per_page, 0

    used = (
        session.execute(
            _sa_select(_sa_func.count(_sa_distinct(Document.document_name))).where(
                Document.client_id == client_id, Document.source == "crawl"
            )
        ).scalar()
        or 0
    )
    return cost_per_page, max(0, allowance - int(used))


def _tenant_documents_dir(client_id: int, bot_id: int | None) -> Path:
    """Per-tenant upload directory: ``documents/{client_id}/{bot_id}/``.

    Namespacing by tenant is a security boundary, not an optimization:
    ``run_folder_ingestion`` sweeps whichever folder it is handed, so a
    shared folder let the first job to run ingest (and archive) every
    tenant's pending files. A per-tenant path makes that sweep isolated
    by construction. ``bot_id is None`` (account-level uploads) uses a
    reserved ``_none`` segment so it can never collide with a real bot id.
    """
    base_dir = Path(DOCUMENTS_DIR).resolve()
    bot_segment = str(bot_id) if bot_id is not None else "_none"
    tenant_dir = (base_dir / str(client_id) / bot_segment).resolve()
    if not tenant_dir.is_relative_to(base_dir):
        raise HTTPException(status_code=400, detail="Invalid storage path.")
    tenant_dir.mkdir(parents=True, exist_ok=True)
    return tenant_dir


@router.get("/documents")
def get_documents_endpoint(bot_id: RowId | None = Query(None), auth: dict = Depends(get_current_client_or_operator)):
    """Retrieve a list of all ingested documents for the authenticated client."""
    _verify_bot_ownership(bot_id, auth["client_id"])
    try:
        with get_session() as session:
            docs = get_ingested_documents(session, client_id=auth["client_id"], bot_id=bot_id)
            return docs
    except Exception as e:
        logger.error(f"Failed to fetch documents: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch documents.") from e


@router.get("/documents/knowledge-state")
def get_knowledge_state_endpoint(
    bot_id: RowId | None = Query(None), auth: dict = Depends(get_current_client_or_operator)
):
    """Whether this bot's knowledge was deactivated by a plan lapse to Free.

    ``deactivated`` is true when the bot has any inactive chunk, the signal the
    admin uses to show the "re-crawl / re-upload to reactivate on Free, or
    upgrade to restore" banner. A brand-new Free bot has 0 inactive chunks and
    therefore never sees it.
    """
    _verify_bot_ownership(bot_id, auth["client_id"])
    try:
        with get_session() as session:
            counts = count_knowledge_state(session, bot_id=bot_id, client_id=auth["client_id"])
        return {
            "active_count": counts["active"],
            "inactive_count": counts["inactive"],
            "deactivated": counts["inactive"] > 0,
        }
    except Exception as e:
        logger.error(f"Failed to fetch knowledge state: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch knowledge state.") from e


@router.get("/documents/pages", response_model=DocumentPagesResponse)
def get_document_pages_endpoint(
    source: str = Query(
        ...,
        min_length=1,
        max_length=253,
        pattern=r"^[A-Za-z0-9._\-]+$",
        description="Normalized root domain (e.g. fynix.digital)",
    ),
    bot_id: RowId | None = Query(None),
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
    # A stored source name: either a crawled URL or an uploaded file name.
    # Every query built from it below binds it as a parameter, so this bound
    # is about keeping an unbounded string out of the planner and the logs,
    # not about injection.
    document_name: str = PathParam(..., min_length=1, max_length=MAX_URL),
    bot_id: RowId | None = Query(None),
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

            # Snapshot the SOURCE-level char totals before delete so we can
            # decrement ``clients.kb_characters_used`` by the exact amount that
            # went away. ``DISTINCT ON (document_name, bot_id)`` collapses the
            # replicated per-chunk values to one row per source. Otherwise a
            # 47-chunk doc would over-deduct by 47×. Same collapse logic as
            # ``knowledge_quota_service.sum_source_chars_for_client``.
            from sqlalchemy import text as _sql_text

            chars_to_free = 0
            try:
                where_sql = "d.document_name = :doc_name"
                params: dict = {"doc_name": document_name}
                if bot_id:
                    where_sql += " AND d.bot_id = :bot_id"
                    params["bot_id"] = bot_id
                else:
                    where_sql += " AND d.client_id = :client_id"
                    params["client_id"] = client_id
                # The list endpoint keys sources by the same normalized-URL
                # pattern used in ``base_filter`` above, so the delete may
                # match rows whose stored ``document_name`` isn't exactly
                # ``document_name``. Use the same regex to snapshot chars,
                # falling back to an exact match below if nothing hit.
                row = session.execute(
                    _sql_text(
                        f"""
                        SELECT COALESCE(SUM(chars), 0) AS total FROM (
                            SELECT DISTINCT ON (
                                d.document_name,
                                COALESCE(d.bot_id, -1)
                            )
                                COALESCE(d.source_char_count, 0) AS chars
                            FROM documents d
                            WHERE COALESCE(
                                REPLACE(
                                    SUBSTRING(d.document_name FROM '^(https?://[^/]+)'),
                                    'www.', ''
                                ),
                                d.document_name
                            ) = :doc_name
                            {(" AND d.bot_id = :bot_id" if bot_id else " AND d.client_id = :client_id")}
                            ORDER BY d.document_name, COALESCE(d.bot_id, -1), d.id
                        ) t
                        """
                    ),
                    params,
                ).first()
                if row and row.total is not None:
                    chars_to_free = int(row.total)
            except Exception:
                logger.debug("kb-usage snapshot failed for delete", exc_info=True)

            deleted_count = session.query(Document).filter(*base_filter).delete(synchronize_session=False)
            session.commit()
            logger.info(f"Deleted {deleted_count} records for Source: {document_name}")

            if deleted_count == 0:
                fallback_filter = [Document.document_name == document_name]
                if bot_id:
                    fallback_filter.append(Document.bot_id == bot_id)
                else:
                    fallback_filter.append(Document.client_id == client_id)
                # Same fallback for the char snapshot. Exact document_name match.
                if chars_to_free == 0:
                    try:
                        from app.services.knowledge_quota_service import chars_used_by_source

                        chars_to_free = chars_used_by_source(
                            session,
                            client_id=client_id,
                            document_name=document_name,
                            bot_id=bot_id,
                        )
                    except Exception:
                        logger.debug("kb-usage exact-name snapshot failed", exc_info=True)
                deleted_count = session.query(Document).filter(*fallback_filter).delete(synchronize_session=False)
                session.commit()

            if deleted_count == 0:
                raise HTTPException(status_code=404, detail=f"Source '{document_name}' not found.")

            # Reclaim the source's contribution from the per-account KB counter.
            # ``chars_to_free`` is 0 for pre-migration rows whose
            # ``source_char_count`` was never backfilled. Safe no-op in that
            # case; the drift-correcting recompute helper is the ultimate
            # source of truth if this ever under-reports.
            if chars_to_free > 0:
                from app.services.knowledge_quota_service import increment_kb_usage

                increment_kb_usage(session, client_id, -chars_to_free)
                session.commit()

            tenant_dir = _tenant_documents_dir(client_id, bot_id)
            file_path = (tenant_dir / document_name).resolve()
            if not file_path.is_relative_to(tenant_dir):
                raise HTTPException(status_code=403, detail="Invalid document path.")
            if file_path.exists():
                file_path.unlink()
                logger.info(f"Deleted file from disk: {file_path}")

            # Defense-in-depth: also purge the tenant's cold-storage copies made
            # during ingestion so a delete never leaves orphaned archived data
            # behind. No-op for crawled URL sources (never archived).
            delete_archived_copies(client_id, bot_id, document_name)

            # If this delete removed the last URL-typed document for the bot,
            # the "Extracted from your Website" palette becomes stale. Clear it
            # so a fresh crawl starts from a clean slate instead of showing the
            # previous website's brand colors on the Appearance tab.
            if bot_id:
                any_url_doc_left = (
                    session.query(Document.id)
                    .filter(Document.bot_id == bot_id, Document.document_name.like("http%"))
                    .first()
                )
                if any_url_doc_left is None:
                    bot = session.query(Bot).filter(Bot.id == bot_id, Bot.client_id == client_id).one_or_none()
                    if bot and bot.recommended_colors:
                        bot.recommended_colors = []
                        session.commit()
                        logger.info(f"Cleared recommended_colors for bot {bot_id} (no crawled sources remain)")

            # Invalidate cached QA responses AND relevance-gate verdicts. The
            # knowledge base just shrank, so an "on-topic" verdict cached before
            # the delete would otherwise keep sending questions down a retrieval
            # path whose content is gone.
            if bot_id:
                cache_delete_prefix(qa_prefix_for_bot(bot_id))
                cache_delete_prefix(gate_prefix_for_bot(bot_id))
                # Re-derive the bot's "trained" counters from what's left, so
                # deleting the last source stops the dashboard claiming the AI
                # is still trained on it.
                sync_bot_knowledge_state(session, bot_id)
                session.commit()
            else:
                # Client-scoped delete (no bot_id): rows were removed across an
                # unknown set of this client's bots, so every one of them needs
                # the same cache flush + counter re-derivation. Otherwise
                # ``indexed_chunk_count`` keeps claiming knowledge this request
                # just deleted, the exact staleness the sync exists to prevent.
                client_bot_ids = [row[0] for row in session.query(Bot.id).filter(Bot.client_id == client_id).all()]
                for client_bot_id in client_bot_ids:
                    cache_delete_prefix(qa_prefix_for_bot(client_bot_id))
                    cache_delete_prefix(gate_prefix_for_bot(client_bot_id))
                    sync_bot_knowledge_state(session, client_bot_id)
                session.commit()

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


@router.post("/ingest/preview-cost")
@limiter.limit("20/minute", key_func=key_from_operator_credential)
def preview_ingest_cost(
    request: Request,
    files: list[UploadFile] = File(...),
    bot_id: RowId | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Return the credit cost the customer will pay if they upload ``files``.

    Extracts each file in-memory, counts words, and returns the tiered credit
    charge per file plus the grand total - **without** saving anything,
    charging credits, or touching the ingest pipeline. The admin UI calls
    this after the user picks files so we can render a
    "Upload for N credits" confirm button.

    Same size + type validation as ``/ingest`` so the preview matches what
    would actually happen. Files that fail extraction (scanned PDFs, empty
    DOCX) show ``words: 0, credits: 0`` and a diagnostic ``reason``. Matching
    the "not billed, will be quarantined" behavior of the real upload path.

    No credit gate here, the goal is a *preview*, not a hold. Confirming
    the upload runs the real deduction on POST /ingest, which is where the
    402 for insufficient credits fires.
    """
    _require_knowledge_management_access(auth)
    client_id = auth["client_id"]
    _verify_bot_ownership(bot_id, client_id)

    if not files:
        raise HTTPException(status_code=400, detail="No files supplied.")
    if len(files) > _MAX_FILES_PER_REQUEST:
        raise HTTPException(
            status_code=413,
            detail=f"Too many files in one request (max {_MAX_FILES_PER_REQUEST}).",
        )

    import tempfile

    from app.ingestion.extraction import ExtractionError, load_docx, load_pdf, load_txt
    from app.services import credit_service

    per_file: list[dict] = []
    total_credits = 0
    total_bytes = 0

    with tempfile.TemporaryDirectory(prefix="oyechats-preview-") as tmp:
        tmp_dir = Path(tmp)
        for f in files:
            # Reject the name before it is used to build a path. The preview
            # writes each part to a scratch file so the path-based extractors
            # can run, and the previous ``fname.replace("/", "_")`` left ``..``
            # and control bytes intact.
            fname = _safe_upload_filename(f.filename)
            if fname is None:
                per_file.append(
                    {"filename": (f.filename or "unnamed")[:200], "words": 0, "credits": 0, "reason": "invalid_name"}
                )
                continue
            ext = Path(fname).suffix.lower()

            if ext not in _SUPPORTED_EXTENSIONS:
                per_file.append({"filename": fname, "words": 0, "credits": 0, "reason": "unsupported_type"})
                continue

            # Bounded read: one byte past the ceiling is enough to reject.
            content = _read_upload_bounded(f, _MAX_FILE_SIZE)
            fsize = len(content)
            total_bytes += fsize

            if fsize > _MAX_FILE_SIZE:
                per_file.append(
                    {
                        "filename": fname,
                        "words": 0,
                        "credits": 0,
                        "reason": "oversize_file",
                        "size_bytes": fsize,
                    }
                )
                continue
            if total_bytes > _MAX_TOTAL_UPLOAD:
                per_file.append(
                    {
                        "filename": fname,
                        "words": 0,
                        "credits": 0,
                        "reason": "batch_oversize",
                    }
                )
                continue

            # Write to a scratch temp path so the existing extractors (which
            # take file paths) can run. The whole tempdir is cleaned up when
            # the ``with`` block exits, nothing persists to disk. ``fname``
            # passed ``_safe_upload_filename`` above, and the containment
            # check below is the belt to that braces.
            tmp_path = (tmp_dir / fname).resolve()
            if not tmp_path.is_relative_to(tmp_dir.resolve()):
                per_file.append({"filename": fname, "words": 0, "credits": 0, "reason": "invalid_name"})
                continue
            try:
                tmp_path.write_bytes(content)
                if ext == ".pdf":
                    pages = load_pdf(str(tmp_path))
                elif ext == ".docx":
                    pages = load_docx(str(tmp_path))
                else:
                    pages = load_txt(str(tmp_path))
            except ExtractionError as exc:
                per_file.append(
                    {
                        "filename": fname,
                        "words": 0,
                        "credits": 0,
                        "reason": "extraction_failed",
                        "detail": str(exc),
                    }
                )
                continue
            except Exception:
                logger.exception(f"preview-cost extraction error for {fname}")
                per_file.append({"filename": fname, "words": 0, "credits": 0, "reason": "extraction_error"})
                continue

            text = " ".join(p.get("text", "") for p in pages)
            words = credit_service.count_words(text)
            with get_session() as db:
                credits = credit_service.get_document_upload_cost_for_size(db, words)
            per_file.append({"filename": fname, "words": words, "credits": credits})
            total_credits += credits

    # Include the current balance so the widget can show "you have X, this
    # will cost Y" without a second API round-trip.
    with get_session() as db:
        from app.db.models import Bot as _Bot

        ledger_bot_id: int | None = None
        if bot_id is not None:
            _bot = db.get(_Bot, bot_id)
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(_bot)
        current_balance = int(credit_service.get_balance(db, client_id, bot_id=ledger_bot_id) or 0)

    return {
        "per_file": per_file,
        "total_credits": total_credits,
        "current_balance": current_balance,
        "sufficient": current_balance >= total_credits,
    }


@router.post("/ingest")
@limiter.limit("10/minute", key_func=key_from_operator_credential)
def ingest_documents(
    request: Request,
    files: list[UploadFile] = File(...),
    bot_id: RowId | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    _sub=Depends(require_active_subscription_for_workspace),
    _verified=Depends(require_verified_email_for_workspace),
):
    """Ingest multiple files (PDF, DOCX, TXT, MD) for a client.

    Subscription-gated. Uploading new content into the knowledge base is
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
    if len(files) > _MAX_FILES_PER_REQUEST:
        raise HTTPException(
            status_code=413,
            detail=f"Too many files in one request (max {_MAX_FILES_PER_REQUEST}).",
        )

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

        # ── Plan enforcement: KB character quota (pre-flight) ──
        # Exact enforcement happens inside the ingestion pipeline (which knows
        # the cleaned-text length), but if the account is already AT or OVER
        # its char cap, fail fast. Avoids a silent background failure where
        # the widget just never sees the new document.
        from sqlalchemy import select as _sa_select

        from app.db.models import Client as _Client
        from app.services.knowledge_quota_service import get_kb_char_limit
        from app.services.plan_service import get_client_plan

        plan = get_client_plan(db, client_id)
        kb_char_limit_raw = get_kb_char_limit(plan)
        # Only enforce when the limit is a real int. Mocked test sessions can
        # return MagicMock sentinels here; real JSONB plan rows always store
        # ints. Same defensive posture as ``check_kb_quota``.
        if (
            isinstance(kb_char_limit_raw, int)
            and not isinstance(kb_char_limit_raw, bool)
            and kb_char_limit_raw != UNLIMITED
        ):
            kb_char_limit = int(kb_char_limit_raw)
            try:
                kb_used = int(
                    db.execute(_sa_select(_Client.kb_characters_used).where(_Client.id == client_id)).scalar_one() or 0
                )
            except (TypeError, ValueError):
                kb_used = 0
            if kb_used >= kb_char_limit:
                raise HTTPException(
                    status_code=402,
                    detail={
                        "error": "limit_reached",
                        "limit": "knowledge_characters",
                        "current": kb_used,
                        "max": kb_char_limit,
                        "current_plan": plan.slug,
                        "message": (
                            "You've reached your plan's knowledge base size limit "
                            f"({kb_used:,} / {kb_char_limit:,} characters). "
                            "Delete existing content or upgrade to add more."
                        ),
                        "upgrade_url": "/billing",
                    },
                )

    saved_paths: list[str] = []  # Track written paths for cleanup on failure
    saved_files: list[str] = []
    total_bytes = 0

    # ── Phase 1: Validate ALL file names and sizes before writing to disk ──
    file_buffers: list[tuple[str, bytes]] = []
    for file in files:
        # ``UploadFile.filename`` is Optional, and the old
        # ``file.filename.lower()`` raised ``AttributeError`` (a 500) on a
        # part without one. It is also the string this endpoint builds a
        # destination path from, so it is validated, not merely read.
        filename = _safe_upload_filename(file.filename)
        if filename is None:
            logger.warning("Skipping upload with an unusable file name: %r", file.filename)
            continue
        if not filename.lower().endswith(_SUPPORTED_EXTENSIONS):
            logger.warning(f"Skipping unsupported file: {filename}")
            continue

        # Bounded read, the previous unbounded ``.read()`` buffered the whole
        # part in memory and only then compared it against the ceiling.
        content = _read_upload_bounded(file, _MAX_FILE_SIZE)
        file_size = len(content)

        if file_size > _MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"File '{filename}' exceeds 10 MB limit.",
            )
        total_bytes += file_size
        if total_bytes > _MAX_TOTAL_UPLOAD:
            raise HTTPException(
                status_code=413,
                detail=f"Total upload exceeds 60 MB limit ({total_bytes / (1024 * 1024):.1f} MB).",
            )
        file_buffers.append((filename, content))

    if not file_buffers:
        raise HTTPException(status_code=400, detail="No valid files (PDF, DOCX, TXT, MD) supplied.")

    # ── Phase 1.5: Size-based credit pricing ──
    # Legacy flow charged a flat ``credit_cost.document_upload`` per file
    # before touching disk. The new model bills by *word count* so a 50-word
    # FAQ and a 15,000-word manual don't cost the same, the second one
    # burns proportionally more embedding + storage. To know the word count
    # we must first extract the file, so ordering is now:
    #   1. Save file to tenant_dir on disk (extraction needs a real path).
    #   2. Extract → count words → look up tiered cost per file.
    #   3. Deduct the SUMMED tiered cost in a single ledger row.
    #   4. On insufficient-credits, delete the saved files (rollback) and
    #      surface a 402 with the required amount so the widget can prompt
    #      the user to top-up before retrying.
    # Files that fail extraction (scanned PDFs, empty DOCX) are skipped for
    # billing entirely, no credits charged, no ingest attempted; the file
    # is quarantined by the background sweep on its next run.
    from app.db.models import Bot as _Bot
    from app.ingestion.extraction import ExtractionError, load_docx, load_pdf, load_txt
    from app.services import credit_service

    ledger_bot_id: int | None = None
    if bot_id is not None:
        with get_session() as db:
            _bot_for_ledger = db.get(_Bot, bot_id)
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(_bot_for_ledger)

    # ── Phase 2: Save files to disk (extraction needs a real path) ──
    tenant_dir = _tenant_documents_dir(client_id, bot_id)
    for filename, content in file_buffers:
        file_path = (tenant_dir / filename).resolve()
        if not file_path.is_relative_to(tenant_dir):
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

    # ── Phase 3: Extract each saved file, count words, price by tier ──
    # Extraction is synchronous here (typically 10-100ms per file, worst-case
    # a few seconds for a 60 MB PDF). Anything slower already sits behind the
    # 10-minute request timeout. If extraction fails for a specific file we
    # skip it in the cost calculation, the background ingest will quarantine
    # it and no credits should be charged for content we can't store.
    def _extract_words_for_cost(path: Path, ext: str) -> tuple[int, int]:
        """Return ``(word_count, cleaned_char_count)`` for one saved file.

        The char count is measured on the CLEANED text because that is the unit
        the KB quota counts (``pipeline._ingest_document``), so the pre-flight
        below gates on the same number the pipeline will later enforce.
        """
        try:
            if ext == ".pdf":
                pages = load_pdf(str(path))
            elif ext == ".docx":
                pages = load_docx(str(path))
            else:  # .txt, .md
                pages = load_txt(str(path))
        except ExtractionError as exc:
            logger.warning(f"Skipping {path.name} for billing (extraction failed): {exc}")
            return 0, 0
        except Exception:  # pragma: no cover. Pypdf/docx surprise
            logger.exception(f"Unexpected extraction error for {path.name}; skipping billing")
            return 0, 0
        raw = " ".join(p.get("text", "") for p in pages)
        cleaned = " ".join(clean_text(p.get("text", "")) for p in pages)
        return credit_service.count_words(raw), len(cleaned)

    per_file_costs: list[tuple[str, int, int]] = []  # (filename, words, credits)
    total_cost = 0
    total_chars = 0
    with get_session() as db:
        for saved_path in saved_paths:
            fname = saved_path.name
            ext = saved_path.suffix.lower()
            words, chars = _extract_words_for_cost(saved_path, ext)
            # ``words == 0`` (extraction failed or the file had no text) prices
            # at 0 inside the helper, which is what ``preview-cost`` quotes.
            cost = credit_service.get_document_upload_cost_for_size(db, words)
            per_file_costs.append((fname, words, cost))
            total_cost += cost
            total_chars += chars

    # ── KB character quota, now that the real size is known ──
    # The coarse check above only catches an account already AT its cap. This
    # one asks the question the pipeline will ask: does THIS upload fit? Run
    # before the deduction, because the worker's answer arrives after the money
    # is gone and its only recourse is to quarantine the file and refund.
    if total_chars > 0:
        with get_session() as db:
            try:
                check_kb_quota(db, client_id, total_chars)
            except KnowledgeQuotaExceeded as exc:
                for saved in saved_paths:
                    try:
                        saved.unlink(missing_ok=True)
                    except Exception:
                        logger.debug("failed to clean up saved file after 402", exc_info=True)
                raise HTTPException(
                    status_code=402,
                    detail={
                        "error": "limit_reached",
                        "limit": "knowledge_characters",
                        "current": exc.current,
                        "attempted": exc.attempted,
                        "max": exc.limit,
                        "current_plan": exc.plan_slug,
                        "message": (
                            "These documents don't fit in your plan's knowledge base "
                            f"({exc.current:,} of {exc.limit:,} characters used, "
                            f"{exc.attempted:,} more in this upload). "
                            "Delete existing content or upgrade to add more."
                        ),
                        "upgrade_url": "/billing",
                    },
                ) from exc
            finally:
                # The quota check took a row lock; nothing here writes, so drop
                # it immediately rather than holding it across the deduction.
                db.rollback()

    deducted_amount = 0
    if total_cost > 0:
        with get_session() as db:
            try:
                credit_service.check_and_deduct(
                    db,
                    client_id,
                    total_cost,
                    reason="document_upload",
                    reference_id=bot_id,
                    bot_id=ledger_bot_id,  # scope (None when pooled
                    attributed_bot_id=bot_id,  # attribution) always the real bot
                )
                db.commit()
                deducted_amount = total_cost
            except credit_service.InsufficientCredits as exc:
                db.rollback()
                # Rollback the disk writes so the customer isn't left with
                # orphaned files sitting in tenant_dir that will get picked
                # up on the next background sweep and processed for free.
                for p in saved_paths:
                    try:
                        p.unlink(missing_ok=True)
                    except Exception:
                        logger.debug("failed to clean up saved file after 402", exc_info=True)
                raise HTTPException(
                    status_code=402,
                    detail={
                        "error": "insufficient_credits",
                        "required": exc.required,
                        "available": exc.available,
                        "document_count": len(saved_files),
                        "per_file": [{"filename": name, "words": w, "credits": c} for name, w, c in per_file_costs],
                        "message": (
                            f"Uploading these {len(saved_files)} document(s) costs {exc.required} credits, "
                            f"but you only have {exc.available}. Top up or upgrade to continue."
                        ),
                    },
                ) from exc
            except credit_service.KillSwitchActive as exc:
                db.rollback()
                for p in saved_paths:
                    try:
                        p.unlink(missing_ok=True)
                    except Exception:
                        logger.debug("failed to clean up saved file after 503", exc_info=True)
                raise HTTPException(
                    status_code=503,
                    detail={
                        "error": "billing_paused",
                        "message": "Billing is temporarily paused for maintenance.",
                    },
                ) from exc

    # Files with 0 billed credits (extraction failed → will be quarantined by
    # the background pass) stay on disk; they contribute nothing to the
    # customer's ledger and the pipeline surfaces the quarantine event.

    logger.info(
        f"Starting background ingestion for {len(saved_files)} files for client {client_id}, bot_id={bot_id}..."
    )

    # Use ARQ worker when enabled, otherwise fall back to FastAPI BackgroundTasks
    from app.worker.enqueue import WORKER_ENABLED

    job_id = None
    if WORKER_ENABLED:
        from app.worker.enqueue import bucketed_job_id, enqueue_sync

        # One sweep per (client, bot) per bucket. Two uploads seconds apart both
        # land in the same tenant folder, so without this they queue two sweeps
        # of the same files and race each other. The bucket keeps ARQ's stored
        # RESULT for a finished sweep from blocking the next upload's enqueue
        # (results outlive the job by an hour), and a refusal still falls back
        # to an in-process sweep so files are never left on disk unprocessed.
        job_id = enqueue_sync(
            "task_ingest_documents",
            client_id,
            str(tenant_dir),
            bot_id,
            _job_id=bucketed_job_id(f"ingest:{client_id}", bot_id or 0),
        )
        if job_id is None:
            # Refused: a sweep with this id is already queued or running, and it
            # may have listed the folder before these files landed. Run one more
            # in-process rather than leave them on disk unprocessed; duplicate
            # work is safe, ``_ingest_document`` re-checks the content hash
            # under the client row lock and replaces a source, never doubles it.
            logger.info(
                "ingest sweep for client %s bot %s was already queued. Running one in-process too",
                client_id,
                bot_id,
            )
            background_tasks.add_task(_run_ingestion_background, client_id, str(tenant_dir), bot_id)
    else:
        background_tasks.add_task(_run_ingestion_background, client_id, str(tenant_dir), bot_id)

    response: dict = {
        "message": "Documents are being processed",
        "files_uploaded": saved_files,
        "status": "processing",
        "credits_charged": deducted_amount,
        # Per-file breakdown so the widget can render "doc A (240 words → 25
        # credits)" instead of a lump total. Replaces the old
        # ``credits_per_document`` field, which was meaningless once pricing
        # started varying per file.
        "per_file_billing": [{"filename": name, "words": w, "credits": c} for name, w, c in per_file_costs],
    }
    if job_id:
        response["job_id"] = job_id
    return response


@router.get("/ingest/status/{job_id}")
async def ingest_status_endpoint(
    # Looked up verbatim as an ARQ/Redis job key.
    job_id: Identifier,
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
    # progress write and now. Surface it immediately so the UI can flip
    # the toast to "Cancelling…" without waiting a full poll cycle.
    if payload.get("status") == "running" and is_cancellation_requested(client_id):
        payload = dict(payload)
        payload["status"] = "cancelling"
    return payload


@router.post("/crawl/cancel", status_code=202)
@limiter.limit("30/minute", key_func=key_from_operator_credential)
def crawl_cancel_endpoint(
    request: Request,
    bot_id: RowId | None = Query(None),
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
        # Nothing to cancel. Let the UI know so it doesn't get stuck in a
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


# The preview's whole time budget, across both discovery phases. Each phase
# used to get 20 seconds of its own, so a site with no usable sitemap could
# take 40 against a route that promises about 20 and a browser that gives up
# at 30. The link phase now gets what is left, never below a floor that still
# lets it find something.
_DISCOVERY_TOTAL_BUDGET = 25.0
_DISCOVERY_LINK_FLOOR = 5.0


def _link_phase_budget(elapsed: float) -> float:
    """Seconds the link scan may take once the sitemap phase spent ``elapsed``."""
    return max(_DISCOVERY_LINK_FLOOR, _DISCOVERY_TOTAL_BUDGET - elapsed)


@router.post("/crawl/discover")
@limiter.limit("120/hour", key_func=key_from_operator_credential)
async def crawl_discover_endpoint(
    discover_request: CrawlDiscoverRequest,
    request: Request,
    bot_id: RowId | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
    _verified=Depends(require_verified_email_for_workspace),
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
    from app.services.url_discovery import discover_via_links, discover_website_urls

    with get_session() as db:
        plan = plan_service.get_client_plan(db, client_id)
        crawl_limits = plan_service.get_crawl_limits(plan)
        plan_max = crawl_limits["max_crawl_pages"]
        # Credit inputs. Read before the long (network) discovery call so we
        # never hold a DB connection across it. Resolve the SAME ledger bucket
        # the crawl will actually deduct from: a per-bot subscription drains the
        # bot ledger, but a client-level/Free bot drains the client pool. Using
        # the raw bot_id here reported 0 for client-level subs (credits live in
        # the pool). Mirror batch_web_ingestion's resolve_bot_ledger_bot_id.
        cost_per_page, free_pages = resolve_crawl_pricing(db, client_id, bot_id)
        ledger_bot_id = None
        if bot_id is not None:
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(db.get(Bot, bot_id))
        balance = credit_service.get_balance(db, client_id, bot_id=ledger_bot_id)

    _DISCOVERY_HARD_CAP = 1000
    discovery_cap = _DISCOVERY_HARD_CAP if plan_max == UNLIMITED else min(plan_max, _DISCOVERY_HARD_CAP)
    started = time.monotonic()
    urls: list[str] = []
    try:
        urls = await discover_website_urls(
            discover_request.url,
            max_urls=discovery_cap,
            timeout=20.0,
        )
    except Exception as exc:
        logger.warning("URL discovery failed for %s: %s", discover_request.url, exc)
        urls = []

    # No usable sitemap → the real crawl falls back to a same-domain link scan
    # (see crawl_provider.crawl_website). Mirror that here so the page count and
    # cost estimate the customer sees match what the crawl will actually bill,
    # instead of showing "1 page" for every sitemap-less site.
    link_stats: dict = {}
    if len(urls) <= 1:
        try:
            linked = await discover_via_links(
                discover_request.url,
                max_urls=discovery_cap,
                timeout=_link_phase_budget(time.monotonic() - started),
                stats=link_stats,
            )
            if len(linked) > len(urls):
                urls = linked
        except Exception as exc:
            logger.warning("Link discovery preview failed for %s: %s", discover_request.url, exc)

    total = len(urls)

    # A free crawl affords every page found, not ``balance`` of them. The
    # clamp is only there to keep the division finite.
    per_page = max(int(cost_per_page), 1)
    # The free-training allowance comes off the top: those pages cost nothing,
    # and only what is left is metered against the balance. Quoting
    # `balance // cost` alone told a trial customer they could afford 100 pages
    # when the first 25 were free and the real answer was higher.
    chargeable = max(0, total - free_pages)
    max_affordable_pages = total if cost_per_page == 0 else min(total, free_pages + int(balance) // per_page)
    credits_required_full = chargeable * cost_per_page

    return {
        "url": discover_request.url,
        "total_found": total,
        # A list cut short by the time budget is as partial as one cut by the
        # page cap, and the UI already knows how to say "there may be more".
        "capped": total >= discovery_cap or bool(link_stats.get("truncated")),
        "plan_max": plan_max,
        "urls": urls,
        "cost_per_page": cost_per_page,
        # Pages this account may still crawl at zero credits. The UI needs it to
        # quote the split ("25 free, then 5 credits a page") rather than a
        # single price that is true of neither half.
        "free_pages": free_pages,
        "balance": balance,
        "max_affordable_pages": max_affordable_pages,
        "credits_required_full": credits_required_full,
        "exceeds_balance": credits_required_full > balance,
    }


@router.post("/crawl/diff")
@limiter.limit("30/hour", key_func=key_from_operator_credential)
async def crawl_diff_endpoint(
    diff_request: CrawlDiffRequest,
    request: Request,
    bot_id: RowId | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Diff a recrawl against the existing knowledge base for the given source.

    Runs the same robots.txt → sitemap → BFS discovery as ``/crawl/discover`` and
    compares the resulting URL set against the pages already stored under
    ``replace_source`` for this bot/client. Returns exact counts: ``unchanged``
    (URL present in both), ``new_pages`` (in sitemap but not stored), and
    ``removed_pages`` (stored but no longer in sitemap).

    Notes:
    * URL-level diff only. Actual content changes are detected per-page during
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

    from app.services import credit_service, plan_service
    from app.services.plan_service import UNLIMITED
    from app.services.url_discovery import check_urls_alive, discover_website_urls, normalize_url

    with get_session() as db:
        plan = plan_service.get_client_plan(db, client_id)
        crawl_limits = plan_service.get_crawl_limits(plan)
        plan_max = crawl_limits["max_crawl_pages"]
        # Delta preview is a Standard+ feature. Free/Starter still see the
        # button, but hitting the endpoint has to fail closed, the frontend
        # can't be the security boundary. Raised as a 403 with the same shape
        # ``plan_service.enforce_feature`` uses so the UI's shared upgrade
        # handler picks it up unchanged.
        if diff_request.mode == "delta":
            plan_service.enforce_delta_recrawl(db, client_id)

        # Credit inputs for the pre-crawl warning surfaced in the confirmation
        # banner. Read inside the ``get_session`` block so we never hold a DB
        # connection across the later (network) discovery calls. Resolve the
        # SAME ledger bucket the actual /crawl will drain (a per-bot
        # subscription drains its own bucket, everything else drains the
        # client pool) so the balance the user sees here matches what
        # gets charged. Mirrors the resolution in /crawl/discover:569-573.
        cost_per_page, free_pages = resolve_crawl_pricing(db, client_id, bot_id)
        ledger_bot_id = None
        if bot_id is not None:
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(db.get(Bot, bot_id))
        balance = credit_service.get_balance(db, client_id, bot_id=ledger_bot_id)

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
    # bare-domain ``replace_source``. That filter never matches in practice.
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
    # timeout is the dominant cost on large knowledge bases, for 500+ URLs
    # against a slow origin the wall-clock can blow past the client's 30s
    # timeout. Two mitigations:
    #   (a) Run HEAD liveness AND sitemap discovery concurrently with
    #       asyncio.gather. They share no state.
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
                "HEAD liveness check exceeded %.0fs budget for %s (%d URLs). Falling back to assume-alive",
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
    # affects how many net-new pages we can show, it cannot incorrectly
    # delete a page from the unchanged set.
    new_norm = set(discovery_norm_to_raw.keys()) - set(stored_norm_to_raw.keys())

    _PREVIEW_CAP = 500

    def _sample(norm_set: set[str], lookup: dict[str, str]) -> list[str]:
        # Show the raw URL the customer would recognise, sorted for stability.
        return sorted({lookup[n] for n in norm_set if n in lookup})[:_PREVIEW_CAP]

    # Credit preview. Surfaced in the confirmation banner. ``credits_required``
    # is the exact upper bound the caller will be billed for a full recrawl
    # (sitemap_total × cost_per_page). For delta mode the true billed amount
    # depends on how many pages actually changed at ingest time, so we don't
    # try to invent a number: the frontend only shows the exact "will charge"
    # copy for ``mode == 'full'``.
    #
    # A zero price is REAL here, not a misconfiguration: the trial carries a
    # free-training allowance. Clamping it up quoted a customer credits that
    # were never going to be charged, which is exactly the deterrent the free
    # allowance removes. The multiplication needs no clamp; the division that
    # once did is elsewhere.
    #
    # The allowance comes off the top the same way it does on the discover
    # path, so a trial account with pages still free is not quoted for them.
    chargeable_full = max(0, len(discovery_norm_to_raw) - free_pages)
    credits_required_full = chargeable_full * int(cost_per_page)

    return {
        "url": diff_request.url,
        "replace_source": diff_request.replace_source,
        "mode": diff_request.mode,
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
        # Credit preview inputs. Used by the frontend confirmation banner
        # to render "will charge X credits · you have Y" copy on the full
        # recrawl path. Emitted for both modes so the UI can show balance
        # in either flow; only the full-mode banner uses ``credits_required``.
        "cost_per_page": cost_per_page,
        "free_pages": free_pages,
        "balance": balance,
        "credits_required_full": credits_required_full,
        "exceeds_balance": credits_required_full > balance,
    }


@router.post("/crawl", status_code=202)
@limiter.limit("10/hour", key_func=key_from_operator_credential)
async def crawl_endpoint(
    crawl_request: CrawlRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    bot_id: RowId | None = Query(None),
    auth: dict = Depends(get_current_client_or_operator),
    _sub=Depends(require_active_subscription_for_workspace),
    _verified=Depends(require_verified_email_for_workspace),
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
    # didn't specify one. That's how Free-tier callers get the full
    # 20-page allowance without sending a body field.
    #
    # Paid plans (Starter/Standard) carry ``max_crawl_pages == UNLIMITED``
    # (-1) because their crawl budget is set by credits, not a per-crawl
    # page cap. For those plans we skip the over-limit gate and derive a
    # concrete ceiling from the available balance, the crawler subprocess
    # always needs an integer, and we never want a runaway "max pages
    # left blank" request to enumerate a 100k-URL sitemap.
    from app.services import credit_service, plan_service
    from app.services.plan_service import UNLIMITED

    # Safety bound so an unlimited-plan caller who passes an absurd
    # ``max_pages`` (or whose credit balance happens to be huge after a
    # large top-up) can't accidentally spawn a multi-day crawl. Sits well
    # above the largest practical customer sitemap.
    #
    # AR-45 decision: the review asked whether "unlimited pages" needs a
    # SEPARATE per-billing-period embedded-chunk quota beyond this per-crawl
    # cap, since embed_rate_limiter.py only paces shared project-wide
    # throughput (latency), not per-tenant spend volume. Evaluated and
    # deferred, not built: (1) credits already are a real per-tenant cost
    # ceiling. Every page charges `cost_per_page` credits at ingestion
    # time, so a customer literally cannot cause unbounded embedding spend
    # without first buying more credits; (2) AR-41 (pipeline.py,
    # _cap_crawled_page_content) now bounds the worst-case embed-call
    # variance PER credit-charged page, the original concern ("1 page
    # charged, but that page silently balloons into thousands of embed
    # calls") is the gap AR-41 closes, not something a separate quota
    # mechanism is needed for on top. If real usage data ever shows credits
    # aren't tracking actual Gemini spend closely enough, revisit as a
    # dedicated billing-period quota, but building one speculatively here
    # would be a new billing/product surface without evidence it's needed.
    _UNLIMITED_PLAN_SAFETY_CEILING = 10_000

    with get_session() as db:
        plan = plan_service.get_client_plan(db, client_id)
        crawl_limits = plan_service.get_crawl_limits(plan)
        plan_max_pages = crawl_limits["max_crawl_pages"]
        plan_max_depth = crawl_limits["max_crawl_depth"]
        plan_js_max_pages = crawl_limits["max_crawl_js_pages"]
        plan_concurrency = crawl_limits["max_crawl_concurrency"]
        unlimited_pages = plan_max_pages == UNLIMITED

        # Delta ("updated pages only") mode is gated to Standard+. Free/Starter
        # see the option in the UI as an upsell, but the endpoint has to fail
        # closed, the frontend can't be the security boundary. First-time
        # crawls (no ``replace_source``) are always full-mode by definition
        # and skip this gate: there is nothing to diff against yet.
        if crawl_request.mode == "delta" and crawl_request.replace_source:
            plan_service.enforce_delta_recrawl(db, client_id)

        requested_pages = crawl_request.max_pages
        # Hard plan cap rejection only fires for plans that actually have
        # a concrete cap (currently just Free). Unlimited-plan callers
        # skip straight to the credit pre-flight below. That's the real
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

        cost_per_page, free_pages = resolve_crawl_pricing(db, client_id, bot_id)
        # Resolve the SAME ledger bucket the actual crawl will drain, a
        # per-bot subscription drains its own bucket, everything else drains
        # the client pool. Both the unlimited-plan sizing fallback below and
        # the hard credit pre-flight gate must check this bucket, not the
        # client pool, or a per-bot subscriber with an empty pool but a
        # funded bot ledger gets hard-blocked even though the pipeline's
        # ``batch_web_ingestion`` (pipeline.py) would happily deduct from
        # their ledger. Mirrors the resolution in /crawl/discover and
        # /crawl/diff.
        ledger_bot_id = None
        if bot_id is not None:
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(db.get(Bot, bot_id))
        if unlimited_pages:
            # No plan cap. Let the caller request what they want, but
            # always cap at the safety ceiling so a typo can't ignite a
            # runaway job. If ``max_pages`` is omitted, fall back to what
            # the caller's current balance can afford (one page = one
            # ``cost_per_page`` deduction). ``cost_per_page`` is clamped
            # to ``>= 1`` to guard against a zero-cost misconfiguration.
            per_page = max(int(cost_per_page), 1)
            if requested_pages is not None:
                effective_max_pages = max(int(requested_pages), 1)
            else:
                available_now = credit_service.get_balance(db, client_id, bot_id=ledger_bot_id)
                effective_max_pages = max(int(available_now) // per_page, 1)
            effective_max_pages = min(effective_max_pages, _UNLIMITED_PLAN_SAFETY_CEILING)
        else:
            # Fixed-cap plan (Free): clamp to plan ceiling. Covers the
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
        # pre-flight honest, without this, a customer on a high page-limit
        # plan who passed ``max_pages=5000`` could be blocked here because we
        # mis-multiplied by the unclamped request.
        #
        # Recrawl exception: when ``replace_source`` is set the ingestion
        # pipeline SHA-256-skips every unchanged page (see
        # ingestion/pipeline.py: is_document_processed), so charging for the
        # full plan ceiling massively over-reserves. If the caller supplies
        # ``expected_new_pages`` (sourced from a server-authoritative
        # /crawl/diff call moments earlier), size the pre-flight against that
        # plus a small buffer. The atomic per-page deduction inside
        # batch_web_ingestion remains the real safety net. If the diff was
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
        elif (
            not crawl_request.replace_source
            and crawl_request.discovered_pages is not None
            and crawl_request.discovered_pages > 0
        ):
            # Initial crawl with a server-discovered sitemap count: size the
            # pre-flight to the actual page count rather than the plan ceiling,
            # so a small site (e.g. 13 pages) isn't gated at
            # (plan_max × cost_per_page), the bug where a 13-page crawl demanded
            # 100 credits (20 × 5) instead of 65 (13 × 5). Per-page atomic
            # deduction inside batch_web_ingestion stays the real safety net if
            # the live crawl finds more than the sitemap advertised.
            precheck_pages = min(effective_max_pages, max(crawl_request.discovered_pages, 1))
        required = cost_per_page * max(precheck_pages, 1)
        available = credit_service.get_balance(db, client_id, bot_id=ledger_bot_id)
        if available < required:
            if precheck_is_recrawl:
                message = (
                    f"This re-crawl needs up to {required} credits "
                    f"({cost_per_page} per page × {precheck_pages} pages. "
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

    # Full-mode recrawl: bypass the ingestion pipeline's SHA-256 dedup so
    # every discovered page is re-embedded and re-billed, the intended
    # behavior on Free/Starter, where "recrawl the entire website" must
    # charge the entire website even if only 2 pages actually changed.
    # First-time crawls (no ``replace_source``) never force-reingest: the
    # dedup skip on a fresh site is a no-op anyway.
    force_reingest = crawl_request.mode == "full" and crawl_request.replace_source is not None

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

    # Per-client crawl lock. Held in Redis so the ARQ worker and the API
    # process see the same state. SETNX with TTL means a crashed holder
    # eventually frees the lock automatically. The lock is released by
    # ``run_full_crawl``'s finally block, regardless of which process runs it.
    #
    # A user-initiated crawl preempts a background auto-recrawl holding the lock
    # (bounded wait); a lock held by another interactive crawl still 429s.
    lock_token = await _acquire_crawl_lock_or_preempt(client_id)
    if lock_token is None:
        raise HTTPException(status_code=429, detail="A training job is already running for your account. Please wait.")

    # Clear any leftover cancel flag from a PREVIOUS crawl before this one runs.
    # Without this a stale flag (TTL ~27min) makes every new crawl instantly
    # self-abort at the provider's pre-flight cancel check. Safe here: the lock
    # is held, so no other crawl for this client is in flight.
    clear_cancellation(client_id)

    # Publish an immediate "running" state so the UI's progress poll picks up
    # the job before the worker even starts. Seed started_at + max_pages so the
    # progress bar has a denominator right away, and a fresh heartbeat so the
    # reaper doesn't fire during any lag before the worker claims the job.
    import time as _time

    set_crawl_progress(
        client_id,
        status="running",
        urls=[],
        pages_crawled=0,
        max_pages=effective_max_pages,
        phase="Starting crawl",
        cancellable=True,
        started_at=_time.time(),
    )

    job_id: str | None = None
    try:
        from app.worker.enqueue import WORKER_ENABLED, enqueue

        if WORKER_ENABLED:
            # Every argument by KEYWORD. Positionally, these nine values used
            # to land one slot to the left of where they belong: the task grew
            # a `free_pages` parameter between `cost_per_page` and `max_depth`,
            # so `plan_max_depth` was received as `free_pages` and
            # `plan_concurrency` as `max_depth`, while `concurrency` silently
            # took its default. That charged a trial customer for the training
            # pages their allowance had already paid for (25 free pages became
            # 3), handed every paid account 3 free pages on every crawl, and
            # made both crawl knobs ignore the plan tier. The inline fallback
            # below always used keywords, so it was correct and local runs
            # never showed it.
            job = await enqueue(
                "task_crawl_and_ingest",
                client_id=client_id,
                bot_id=bot_id,
                url=crawl_request.url,
                max_pages=effective_max_pages,
                use_js=crawl_request.use_js,
                replace_source=crawl_request.replace_source,
                cost_per_page=cost_per_page,
                free_pages=free_pages,
                max_depth=plan_max_depth,
                concurrency=plan_concurrency,
                ordered_urls=ordered_urls,
                force_reingest=force_reingest,
                lock_token=lock_token,
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
                free_pages=free_pages,
                max_depth=plan_max_depth,
                concurrency=plan_concurrency,
                ordered_urls=ordered_urls,
                force_reingest=force_reingest,
                lock_token=lock_token,
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
        # lock. Release it here (ownership-checked with our token) so the user
        # isn't locked out indefinitely.
        release_crawl_lock(client_id, lock_token)
        set_crawl_progress(client_id, status="failed", error="Failed to start crawl.")
        logger.exception("Failed to enqueue crawl for client %s: %s", client_id, exc)
        raise HTTPException(status_code=503, detail="Could not start training. Please try again.") from exc

    response: dict = {
        "message": "Crawl started",
        "status": "running",
        "root_url": crawl_request.url,
        "poll_url": "/crawl/progress",
    }
    if job_id:
        response["job_id"] = job_id
    return response
