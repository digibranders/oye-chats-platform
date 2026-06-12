import hashlib
import logging
import os
import re
import shutil
from datetime import datetime
from typing import Any

from app.config import ARCHIVE_DIR
from app.core.cache import cache_delete_prefix, gate_prefix_for_bot, qa_prefix_for_bot
from app.db.repository import delete_chunks_for_url, insert_documents, is_document_processed
from app.db.session import get_session
from app.ingestion.chunking import chunk_text
from app.ingestion.cleaner import clean_text
from app.ingestion.embedder import embed_chunks
from app.ingestion.enrichment import CHUNK_ENRICHMENT_ENABLED, enrich_chunks_batch
from app.ingestion.extraction import ExtractionError, load_docx, load_pdf, load_txt

logger = logging.getLogger(__name__)

_TITLE_PATTERN = re.compile(r"^#\s+(.+)", re.MULTILINE)
# Many real-world pages put the H1 in their layout header (logo / site name)
# and use ``## `` for the actual page title. Fall back to H2 when no H1 is
# present so those pages still carry a meaningful title metadata.
_TITLE_FALLBACK_PATTERN = re.compile(r"^##\s+(.+)", re.MULTILINE)


def _extract_title_from_markdown(content: str) -> str | None:
    """Extract the first top-level heading from markdown content as a page title."""
    snippet = content[:500]
    for pattern in (_TITLE_PATTERN, _TITLE_FALLBACK_PATTERN):
        match = pattern.search(snippet)
        if match:
            title = match.group(1).strip()
            # Ignore overly long or noisy "titles" (likely not a real heading)
            if 3 <= len(title) <= 120:
                return title
    return None


os.makedirs(ARCHIVE_DIR, exist_ok=True)

# Failed uploads land here so they leave the input folder and don't get
# reprocessed on every run (the "poison pill" pattern). Subfolder of
# ARCHIVE_DIR keeps the configuration surface unchanged.
QUARANTINE_DIR = os.path.join(ARCHIVE_DIR, "_quarantine")
os.makedirs(QUARANTINE_DIR, exist_ok=True)


def calculate_hash(text: str) -> str:
    """Calculate SHA-256 hash of text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _ingest_document(
    client_id: int, source_name: str, full_text: str, pages_data: list[dict[str, Any]], bot_id: int | None = None
) -> int:
    """
    Common ingestion logic for both files and web content.
    Returns the number of chunks processed (0 if skipped).
    Supports both client_id (legacy) and bot_id (new multi-bot).
    """
    # 1. Clean every page so the hash AND the chunks derive from the same
    #    text. Previously the hash was computed on ``clean_text(full_text)``
    #    while chunks were produced from the raw ``pages_data`` — meaning two
    #    templated landing pages that only differed in their nav/footer
    #    boilerplate could collide on hash and be silently skipped, even
    #    though their actual unique-content chunks differed.
    cleaned_pages_data = [{"text": clean_text(p["text"]), "metadata": p.get("metadata", {})} for p in pages_data]
    cleaned_full_text = " ".join(p["text"] for p in cleaned_pages_data)
    file_hash = calculate_hash(cleaned_full_text)

    with get_session() as session:
        already_processed = is_document_processed(session, client_id, file_hash, bot_id=bot_id)

        if already_processed:
            logger.info(f"Skipping {source_name} (Already processed for client {client_id}, bot {bot_id})")
            return 0

        # 2. Chunk the SAME cleaned text we hashed (Preserves metadata)
        chunks = chunk_text(cleaned_pages_data, document_name=source_name)

        # Extract content and metadata for external processing
        chunk_contents = [c.page_content for c in chunks]

        # 2a. Optional: contextual enrichment (CHUNK_ENRICHMENT_ENABLED=true)
        # Prepends a short LLM-generated context to each chunk before embedding.
        # One-time cost at ingestion; improves retrieval accuracy significantly.
        if CHUNK_ENRICHMENT_ENABLED and chunk_contents:
            # Use the beginning of the full text as the document summary for context
            document_summary = full_text[:2000] if full_text else ""
            chunk_contents = enrich_chunks_batch(chunk_contents, document_summary)

        # Enhance metadata with source info
        current_time = datetime.utcnow().isoformat()
        chunk_metadatas = []
        for c in chunks:
            meta = c.metadata.copy()
            meta["source"] = source_name
            meta["ingest_date"] = current_time
            chunk_metadatas.append(meta)

        # 3. Embed chunks
        if not chunk_contents:
            logger.warning(f"No content to embed for {source_name}")
            return 0

        embeddings = embed_chunks(chunk_content_list=chunk_contents)

        # 4. Save to Database with JSONB metadata
        try:
            insert_documents(
                session, client_id, source_name, file_hash, chunk_contents, embeddings, chunk_metadatas, bot_id=bot_id
            )
            session.commit()
            # Invalidate cached QA responses AND stale relevance-gate judgments
            # — the knowledge base just changed, so any prior "off-topic" cache
            # entry would otherwise haunt this bot for up to an hour.
            if bot_id:
                cache_delete_prefix(qa_prefix_for_bot(bot_id))
                cache_delete_prefix(gate_prefix_for_bot(bot_id))
        except Exception as e:
            session.rollback()
            raise e

    return len(chunk_contents)


def run_folder_ingestion(client_id: int, folder_path: str, bot_id: int | None = None):
    """
    Scan folder and ingest all supported files.
    Supports bot_id for multi-bot architecture.

    Every processed file leaves ``folder_path`` regardless of outcome:
    - successful ingest (or dedup-skip) → ``ARCHIVE_DIR``
    - any failure (extraction, embedding, DB) → ``QUARANTINE_DIR``

    Without the quarantine step, a single broken file (corrupted PDF,
    scanned-only PDF, etc.) would be reprocessed on every run and block all
    subsequent files behind it indefinitely.
    """
    supported_extensions = [".pdf", ".docx", ".txt", ".md"]
    files = [f for f in os.listdir(folder_path) if any(f.lower().endswith(ext) for ext in supported_extensions)]

    processed_count = 0
    for file_name in files:
        file_path = os.path.join(folder_path, file_name)
        ext = os.path.splitext(file_name)[1].lower()

        logger.info(f"Processing {file_name} (type: {ext})")

        failed = False
        try:
            # Step 1: Extract text and metadata based on extension
            if ext == ".pdf":
                pages_data = load_pdf(file_path)
            elif ext == ".docx":
                pages_data = load_docx(file_path)
            elif ext in [".txt", ".md"]:
                pages_data = load_txt(file_path)
            else:
                logger.warning(f"File type {ext} unexpectedly reached folder ingestion. Quarantining.")
                failed = True
                continue

            if not pages_data:
                logger.warning(f"No text extracted from {file_name}. Quarantining.")
                failed = True
                continue

            # combine text for hashing and cleaning
            full_raw_text = " ".join([p["text"] for p in pages_data])

            # Delegate to common ingestion logic
            chunks_count = _ingest_document(client_id, file_name, full_raw_text, pages_data, bot_id=bot_id)

            if chunks_count > 0:
                processed_count += 1

        except ExtractionError as e:
            # Surfaces scanned-PDF and empty-file cases with a clear message.
            logger.warning(f"Cannot extract text from {file_name}: {e}. Quarantining.")
            failed = True
        except Exception as e:
            logger.error(f"Error processing {file_name}: {e}", exc_info=True)
            failed = True
        finally:
            # ALWAYS move the file out of the upload folder. On failure go to
            # quarantine so the next run isn't blocked by the same poison pill.
            try:
                if failed:
                    move_to_quarantine(file_path, file_name)
                else:
                    move_to_archive(file_path, file_name)
            except Exception as mv_err:
                logger.error(f"Could not move {file_name} out of upload folder: {mv_err}")

    logger.info(f"Folder ingestion complete! Processed {processed_count} files.")
    return processed_count


def run_web_ingestion(client_id: int, url: str, content: str, bot_id: int | None = None) -> int:
    """
    Ingest content from a URL for a specific client.
    Supports bot_id for multi-bot architecture.
    """
    logger.info(f"Processing URL: {url} for client {client_id}, bot {bot_id}")

    try:
        # Extract page title from markdown content
        title = _extract_title_from_markdown(content)
        meta = {"page": 1, "url": url}
        if title:
            meta["title"] = title

        # Wrap content in the expected format for chunking
        # We treat the whole page as a single "page" of text
        pages_data = [{"text": content, "metadata": meta}]

        chunks_count = _ingest_document(client_id, url, content, pages_data, bot_id=bot_id)
        logger.info(f"Web ingestion complete for {url}. Chunks: {chunks_count}")
        return chunks_count

    except Exception as e:
        logger.error(f"Error processing URL {url}: {e}")
        raise e


def batch_web_ingestion(
    client_id: int,
    pages: list[dict],
    bot_id: int | None = None,
    *,
    cost_per_page: int = 0,
    deduct_reason: str = "url_scan",
    deduct_reference_id: int | None = None,
) -> dict:
    """
    Batch ingest multiple web pages: chunk all, embed all at once, insert all.
    Much faster than per-page ingestion because embedding is batched.

    Args:
        client_id: The client ID
        pages: List of {"url": str, "content": str} dicts
        bot_id: Optional bot ID
        cost_per_page: When > 0, deduct this many credits from ``client_id`` in
            the SAME transaction that inserts each page's chunks. If the
            deduction raises (insufficient credits / kill switch), the page's
            chunks are rolled back and ingestion continues with the next page.
            This guarantees the user is never charged for un-ingested chunks
            and never gets free chunks for an un-charged page.
        deduct_reason: Credit ledger reason code; ignored when ``cost_per_page``
            is 0. Defaults to ``"url_scan"``.
        deduct_reference_id: Optional reference id to write on the ledger row
            (typically ``bot_id``); ignored when ``cost_per_page`` is 0.

    Returns:
        ``{"chunks": int, "pages_charged": int, "credits_deducted": int}``.
    """
    if not pages:
        return {"chunks": 0, "pages_charged": 0, "credits_deducted": 0}

    # Local import: credit_service depends on db.models which already imports
    # heavily — keep this lazy so importing pipeline.py stays cheap and there
    # is no risk of a circular import via app.services.
    from app.services import credit_service

    all_chunk_contents: list[str] = []
    all_chunk_metadatas: list[dict] = []
    page_boundaries: list[dict] = []  # Track which chunks belong to which page
    current_time = datetime.utcnow().isoformat()

    with get_session() as session:
        for page in pages:
            url = page["url"]
            content = page["content"]

            # Clean and hash for dedup — and chunk on the SAME cleaned text so
            # the dedup fingerprint matches what's actually stored. Mismatched
            # sources let templated landing pages collide on hash and silently
            # skip the second page.
            cleaned = clean_text(content)
            file_hash = calculate_hash(cleaned)

            if is_document_processed(session, client_id, file_hash, bot_id=bot_id):
                logger.info(f"Skipping {url} (already processed)")
                continue

            # Title extraction runs on raw content — markdown ``# Title`` survives
            # cleaning and the title metadata is useful for retrieval prefix.
            title = _extract_title_from_markdown(content)
            page_meta = {"page": 1, "url": url}
            if title:
                page_meta["title"] = title
            pages_data = [{"text": cleaned, "metadata": page_meta}]
            chunks = chunk_text(pages_data, document_name=url)

            if not chunks:
                continue

            chunk_contents = [c.page_content for c in chunks]

            # Optional: contextual enrichment before embedding (mirrors _ingest_document)
            if CHUNK_ENRICHMENT_ENABLED and chunk_contents:
                document_summary = content[:2000]
                chunk_contents = enrich_chunks_batch(chunk_contents, document_summary)

            chunk_metas = []
            for c in chunks:
                meta = c.metadata.copy()
                meta["source"] = url
                meta["ingest_date"] = current_time
                chunk_metas.append(meta)

            page_boundaries.append(
                {
                    "url": url,
                    "file_hash": file_hash,
                    "start_idx": len(all_chunk_contents),
                    "count": len(chunk_contents),
                }
            )

            all_chunk_contents.extend(chunk_contents)
            all_chunk_metadatas.extend(chunk_metas)

        if not all_chunk_contents:
            logger.info("No new content to process")
            return {"chunks": 0, "pages_charged": 0, "credits_deducted": 0}

        # Batch embed ALL chunks at once (major speedup)
        logger.info(f"Batch embedding {len(all_chunk_contents)} chunks from {len(page_boundaries)} pages")

        # Sub-batch if too many chunks (memory protection)
        MAX_EMBED_BATCH = 100
        all_embeddings: list = []
        for i in range(0, len(all_chunk_contents), MAX_EMBED_BATCH):
            batch = all_chunk_contents[i : i + MAX_EMBED_BATCH]
            all_embeddings.extend(embed_chunks(chunk_content_list=batch))

        # Insert per-page with individual commits to prevent rollback cascade
        total = 0
        pages_charged = 0
        credits_deducted = 0
        for boundary in page_boundaries:
            start = boundary["start_idx"]
            count = boundary["count"]

            page_chunks = all_chunk_contents[start : start + count]
            page_embeddings = all_embeddings[start : start + count]
            page_metas = all_chunk_metadatas[start : start + count]

            try:
                # Remove stale chunks for this URL before inserting fresh ones.
                # Makes ingestion idempotent per-URL: content changes never
                # produce duplicates; hash dedup still skips unchanged pages above.
                delete_chunks_for_url(session, boundary["url"], bot_id=bot_id, client_id=client_id)
                insert_documents(
                    session,
                    client_id,
                    boundary["url"],
                    boundary["file_hash"],
                    page_chunks,
                    page_embeddings,
                    page_metas,
                    bot_id=bot_id,
                )
                # Atomic billing: deduct in the same TX as the chunk insert so
                # we never end up with chunks-without-charge or charge-without-
                # chunks if the worker dies between the two operations.
                if cost_per_page > 0:
                    credit_service.check_and_deduct(
                        session,
                        client_id,
                        cost_per_page,
                        reason=deduct_reason,
                        reference_id=deduct_reference_id,
                    )
                session.commit()
                total += count
                if cost_per_page > 0:
                    pages_charged += 1
                    credits_deducted += cost_per_page
            except credit_service.InsufficientCredits as exc:
                session.rollback()
                logger.warning(
                    "Crawl billing aborted at %s for client %s: insufficient credits "
                    "(need %d, have %d). Remaining pages will be skipped.",
                    boundary["url"],
                    client_id,
                    exc.required,
                    exc.available,
                )
                # Stop ingesting further pages — the user can't pay for them.
                break
            except credit_service.KillSwitchActive:
                session.rollback()
                logger.warning(
                    "Crawl billing aborted at %s for client %s: credit kill switch active. "
                    "Remaining pages will be skipped.",
                    boundary["url"],
                    client_id,
                )
                break
            except Exception as e:
                logger.error(f"Failed to insert chunks for {boundary['url']}: {e}")
                session.rollback()
                continue

    # Invalidate cached QA responses AND stale relevance-gate judgments —
    # the bot's knowledge base just expanded, so prior off-topic verdicts
    # should not survive the upload.
    if total > 0 and bot_id:
        cache_delete_prefix(qa_prefix_for_bot(bot_id))
        cache_delete_prefix(gate_prefix_for_bot(bot_id))

    logger.info(
        "Batch ingestion complete: %d chunks from %d pages (charged: %d page(s), %d credit(s))",
        total,
        len(page_boundaries),
        pages_charged,
        credits_deducted,
    )
    return {
        "chunks": total,
        "pages_charged": pages_charged,
        "credits_deducted": credits_deducted,
    }


def move_to_archive(file_path: str, filename: str):
    """
    Move a file to the archive directory.
    If a file with the same name exists, append a timestamp to avoid collision.
    """
    dest_path = os.path.join(ARCHIVE_DIR, filename)

    if os.path.exists(dest_path):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        name, ext = os.path.splitext(filename)
        dest_path = os.path.join(ARCHIVE_DIR, f"{name}_{timestamp}{ext}")

    try:
        shutil.move(file_path, dest_path)
        logger.info(f"Archived file to: {dest_path}")
    except Exception as e:
        logger.error(f"Failed to archive {filename}: {e}")


def move_to_quarantine(file_path: str, filename: str):
    """Move a file that failed ingestion to the quarantine folder.

    Same collision-avoidance pattern as ``move_to_archive``. Quarantining
    (rather than deleting) preserves the original for forensic review while
    ensuring the next ingestion run isn't blocked by the same poison pill.
    """
    dest_path = os.path.join(QUARANTINE_DIR, filename)

    if os.path.exists(dest_path):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        name, ext = os.path.splitext(filename)
        dest_path = os.path.join(QUARANTINE_DIR, f"{name}_{timestamp}{ext}")

    try:
        shutil.move(file_path, dest_path)
        logger.warning(f"Quarantined failed file: {dest_path}")
    except Exception as e:
        logger.error(f"Failed to quarantine {filename}: {e}")
