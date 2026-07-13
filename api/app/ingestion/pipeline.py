import hashlib
import logging
import os
import re
import shutil
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from app.config import ARCHIVE_DIR
from app.core.cache import cache_delete_prefix, gate_prefix_for_bot, qa_prefix_for_bot
from app.db.repository import delete_chunks_for_url, insert_documents, is_document_processed, upsert_events
from app.db.session import get_session
from app.ingestion.chunking import chunk_text
from app.ingestion.cleaner import clean_text, extract_media_urls
from app.ingestion.embedder import embed_chunks
from app.ingestion.enrichment import CHUNK_ENRICHMENT_ENABLED, enrich_chunks_batch
from app.ingestion.event_extractor import maybe_extract_events
from app.ingestion.extraction import ExtractionError, load_docx, load_pdf, load_txt
from app.ingestion.youtube_metadata import (
    enrich_media_urls_with_channel_videos,
    enrich_media_urls_with_durations,
)

logger = logging.getLogger(__name__)

_TITLE_PATTERN = re.compile(r"^#\s+(.+)", re.MULTILINE)
# Many real-world pages put the H1 in their layout header (logo / site name)
# and use ``## `` for the actual page title. Fall back to H2 when no H1 is
# present so those pages still carry a meaningful title metadata.
_TITLE_FALLBACK_PATTERN = re.compile(r"^##\s+(.+)", re.MULTILINE)

# AR-41: discovery fetches are size-capped (5MB/50MB via fetch_text_safely),
# but the actual crawled page BODY (Spider/Jina scrape result) had no size
# cap before clean_text/chunk_text/embed_chunks. A pathologically large page
# (a mis-rendered SPA dump, or a maliciously crafted one) produced unbounded
# chunks and embed calls for a single page — consuming disproportionate
# embed-RPM quota — while the credit ledger still charged only one page's
# worth, a cost/quota mismatch. 750KB is comfortably above any legitimate
# marketing/docs page's text content (a 750KB *cleaned-text* page would
# already be tens of thousands of words) while bounding the pathological case.
_MAX_CRAWLED_PAGE_CHARS = 750_000


def _cap_crawled_page_content(content: str, url: str) -> str:
    """Truncate a single crawled page's raw content to ``_MAX_CRAWLED_PAGE_CHARS``,
    logging when truncation actually occurs."""
    if len(content) <= _MAX_CRAWLED_PAGE_CHARS:
        return content
    logger.warning(
        "Crawled page content exceeds %d chars (%d) — truncating: %s",
        _MAX_CRAWLED_PAGE_CHARS,
        len(content),
        url,
    )
    return content[:_MAX_CRAWLED_PAGE_CHARS]


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


# Failed uploads are quarantined (rather than archived) so they leave the
# input folder and don't get reprocessed on every run (the "poison pill"
# pattern). Both archive and quarantine are namespaced per tenant — see
# ``_tenant_archive_dir`` / ``_tenant_quarantine_dir`` — so one tenant's cold
# storage can never mix with another's, mirroring the per-tenant upload dir.
_QUARANTINE_SUBDIR = "_quarantine"


def calculate_hash(text: str) -> str:
    """Calculate SHA-256 hash of text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ── Dedup-hash normalisation ───────────────────────────────────────────────
# The dedup hash must be stable across re-crawls that change ONLY volatile
# boilerplate (copyright year, "Last updated" timestamp, etc.). Without this,
# every monthly re-crawl re-ingests and re-bills pages whose substantive
# content didn't change just because the footer copyright ticked over.
#
# Conversely, real content edits MUST still flip the hash so genuine updates
# land in the knowledge base. The normaliser is intentionally narrow: it only
# touches patterns that are reliably date- or timestamp-shaped, never anything
# that could plausibly be substantive content.

# Common date formats. All become "<DATE>" before hashing.
_DEDUP_DATE_PATTERNS = (
    # ISO 8601: 2026-01-15 (optionally with time)
    re.compile(r"\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?)?\b"),
    # Slash dates: 15/01/2026, 01/15/2026, 15/01/26
    re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b"),
    # Dot dates (common in EU): 15.01.2026
    re.compile(r"\b\d{1,2}\.\d{1,2}\.\d{4}\b"),
    # "January 15, 2026" / "Jan 15 2026" / "January 15th, 2026"
    re.compile(
        r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b",
        re.IGNORECASE,
    ),
    # "15 January 2026" / "15th January 2026"
    re.compile(
        r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b",
        re.IGNORECASE,
    ),
)

# Whole-line patterns to drop entirely (the line is essentially metadata).
_DEDUP_TIMESTAMP_LINE_PATTERNS = (
    # "Last updated: ...", "Last modified ...", "Published on ...", "Posted: ..."
    re.compile(
        r"(?im)^[\s>\-*\"'|]*"
        r"(?:last\s+(?:updated|modified|reviewed)|published(?:\s+on)?|updated(?:\s+on)?|posted(?:\s+on)?|created(?:\s+on)?|copyright|©)"
        r"\s*[:\-—]?\s*.*$"
    ),
    # Bare "(c) 2026" / "© 2026 Company Name" footer lines
    re.compile(r"(?im)^[\s>\-*\"'|]*(?:©|\(c\))\s*\d{4}.*$"),
)


def _normalize_for_dedup_hash(text: str) -> str:
    """Strip volatile-boilerplate patterns before computing the dedup hash.

    The *stored* content always preserves the original text — only the hash
    uses the normalised form. This means:
      * A re-crawl where only "© 2025" → "© 2026" changed produces the SAME
        hash → page is skipped → no credits charged. ✓
      * A re-crawl where a real paragraph changed produces a DIFFERENT hash
        → page is re-ingested → updated content reaches the KB. ✓

    Conservative on purpose: only patterns that are reliably date-shaped or
    sit in a clearly-metadata sentence get scrubbed. Numbers embedded in
    prose ("Q4 2026 revenue grew 12%") are untouched because they could be
    substantive content.
    """
    out = text
    for pattern in _DEDUP_TIMESTAMP_LINE_PATTERNS:
        out = pattern.sub("", out)
    for pattern in _DEDUP_DATE_PATTERNS:
        out = pattern.sub("<DATE>", out)
    # Collapse the whitespace we may have left behind so the hash is stable
    # against minor formatting drift (extra newlines, trailing spaces).
    out = re.sub(r"\n\s*\n+", "\n\n", out).strip()
    return out


def _ingest_document(
    client_id: int,
    source_name: str,
    full_text: str,
    pages_data: list[dict[str, Any]],
    bot_id: int | None = None,
    source: str = "upload",
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
    #    Media URL extraction runs on the *raw* page text (pre-clean) because
    #    the cleaner strips ``[label](url)`` markdown link wrappers — capture
    #    YouTube/downloadable URLs first, attach them to page metadata, and
    #    let chunking propagate that metadata to every chunk of the page.
    cleaned_pages_data: list[dict[str, Any]] = []
    cleaned_texts: list[str] = []
    for p in pages_data:
        page_meta = dict(p.get("metadata", {}))
        media = extract_media_urls(p["text"])
        if media:
            # Layer 1.5 auto-discover: when a channel URL was captured on
            # this page (e.g. "Follow us on YouTube: youtube.com/@brand"),
            # expand it into every video on that channel BEFORE the
            # metadata scrape below so the newly-discovered videos also
            # get title+duration filled in. In-process cached so a
            # channel URL appearing on many pages only fetches once.
            enrich_media_urls_with_channel_videos(media)
            # Fetch YouTube durations + titles once per video at ingest
            # time so the widget can render a duration pill and the LLM
            # can match by title. Cached in-process; failures are silent.
            enrich_media_urls_with_durations(media)
            page_meta["media_urls"] = media
        cleaned_text = clean_text(p["text"])
        cleaned_texts.append(cleaned_text)
        cleaned_pages_data.append({"text": cleaned_text, "metadata": page_meta})
    # Parallel ``list[str]`` of the text values so ``str.join`` type-checks —
    # ``cleaned_pages_data`` has mixed value types (str + dict), so a bare
    # ``p["text"] for p in cleaned_pages_data`` widens to ``str | dict``.
    cleaned_full_text = " ".join(cleaned_texts)
    # Hash the boilerplate-normalised form so harmless footer-date drift
    # between re-crawls doesn't trigger re-ingest + re-billing. See
    # ``_normalize_for_dedup_hash`` for the patterns being stripped.
    file_hash = calculate_hash(_normalize_for_dedup_hash(cleaned_full_text))

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
        current_time = datetime.now(UTC).isoformat()
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
                session,
                client_id,
                source_name,
                file_hash,
                chunk_contents,
                embeddings,
                chunk_metadatas,
                bot_id=bot_id,
                source=source,
            )
            # 4a. Structured event extraction (Tier 2). Only meaningful for
            # crawled pages: uploaded PDFs/DOCX are almost never event
            # calendars, and the ``source_url`` we need as part of the
            # dedup key isn't available for uploads anyway. Extraction
            # failures never abort ingestion — the extractor already
            # swallows LLM errors and returns [] on any problem.
            if bot_id and source == "crawl":
                for page in cleaned_pages_data:
                    page_meta = page.get("metadata") or {}
                    page_url = page_meta.get("url")
                    if not page_url:
                        continue
                    extracted = maybe_extract_events(
                        url=page_url,
                        title=page_meta.get("title"),
                        text=page.get("text", ""),
                    )
                    if extracted:
                        written = upsert_events(
                            session,
                            bot_id=bot_id,
                            source_url=page_url,
                            events=extracted,
                        )
                        logger.info(
                            "event_extractor: upserted %d event(s) for bot=%s url=%s",
                            written,
                            bot_id,
                            page_url,
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
    if not os.path.isdir(folder_path):
        logger.info("run_folder_ingestion: folder %s does not exist — nothing to ingest", folder_path)
        return 0
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
                    move_to_quarantine(file_path, file_name, client_id=client_id, bot_id=bot_id)
                else:
                    move_to_archive(file_path, file_name, client_id=client_id, bot_id=bot_id)
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
        content = _cap_crawled_page_content(content, url)
        # Extract page title from markdown content
        title = _extract_title_from_markdown(content)
        meta = {"page": 1, "url": url}
        if title:
            meta["title"] = title

        # Wrap content in the expected format for chunking
        # We treat the whole page as a single "page" of text
        pages_data = [{"text": content, "metadata": meta}]

        chunks_count = _ingest_document(client_id, url, content, pages_data, bot_id=bot_id, source="crawl")
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
    embed_progress_cb: Callable[[int, int], None] | None = None,
    crawl_started_at: float | None = None,
    force_reingest: bool = False,
    crawl_job_id: str | None = None,
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
        force_reingest: When True, skip the SHA-256 content dedup check so every
            page is re-embedded and re-charged even if its content is identical
            to what's already stored. Set by the ``mode=full`` path on
            ``POST /crawl`` — the intended behavior on Free/Starter, where a
            "recrawl the entire website" action must bill for the entire
            website regardless of what actually changed. Standard+ delta-mode
            leaves this False so the dedup skip continues to make unchanged
            pages free.
        crawl_job_id: Stable id of the enclosing crawl job (the ARQ ``job_id``),
            constant across a job's retries but fresh per user-initiated crawl.
            When set (and ``cost_per_page`` > 0), each page's deduction carries a
            per-(job, url) idempotency key so an ARQ retry of a partially-charged
            crawl never re-charges pages it already billed (finding H) — even in
            ``force_reingest`` mode where the content dedup that normally makes a
            re-run free is deliberately bypassed. ``None`` (non-ARQ callers) keeps
            per-page charging exactly as before.

    Returns:
        ``{"chunks": int, "pages_charged": int, "credits_deducted": int,
        "aborted": bool}`` — ``aborted`` is True when ingestion stopped early
        because billing can no longer proceed (insufficient credits / kill
        switch). Streaming callers use it to stop scheduling further waves
        instead of wasting embedding quota on pages that can't be paid for.
    """
    if not pages:
        return {"chunks": 0, "pages_charged": 0, "credits_deducted": 0, "aborted": False}

    # Local import: credit_service depends on db.models which already imports
    # heavily — keep this lazy so importing pipeline.py stays cheap and there
    # is no risk of a circular import via app.services.
    from app.db.models import Bot
    from app.services import credit_service

    all_chunk_contents: list[str] = []
    all_chunk_metadatas: list[dict] = []
    page_boundaries: list[dict] = []  # Track which chunks belong to which page
    current_time = datetime.now(UTC).isoformat()

    with get_session() as session:
        # Resolve the bot's ledger scope once so every page in the batch
        # charges the same bucket. Per-bot subscriptions drain their
        # isolated ledger; legacy / Free bots drain the client pool
        # (bot_id=None). Done inside the same session as ingestion so
        # tests that mock ``get_session`` with a single-use context
        # manager keep working.
        ledger_bot_id: int | None = None
        if bot_id is not None and cost_per_page > 0:
            _bot_for_ledger = session.get(Bot, bot_id)
            ledger_bot_id = credit_service.resolve_bot_ledger_bot_id(_bot_for_ledger)

        for page in pages:
            url = page["url"]
            content = _cap_crawled_page_content(page["content"], url)

            # Clean and hash for dedup — and chunk on the SAME cleaned text so
            # the dedup fingerprint matches what's actually stored. Mismatched
            # sources let templated landing pages collide on hash and silently
            # skip the second page.
            #
            # Hash the boilerplate-normalised form (see _normalize_for_dedup_hash)
            # so harmless re-crawl noise like "© 2025" → "© 2026" or a bumped
            # "Last updated" timestamp doesn't re-bill the customer for content
            # that didn't actually change.
            cleaned = clean_text(content)
            file_hash = calculate_hash(_normalize_for_dedup_hash(cleaned))

            # ``force_reingest`` (mode=full recrawl) skips the dedup skip on
            # purpose: Free/Starter's "full recrawl" is spec'd to charge for
            # every page, even ones whose content hasn't changed since the
            # last crawl. Delta-mode (Standard+) leaves this False so the
            # dedup skip still makes truly-unchanged pages a no-op.
            if not force_reingest and is_document_processed(session, client_id, file_hash, bot_id=bot_id):
                logger.info(f"Skipping {url} (already processed)")
                continue

            # Title extraction runs on raw content — markdown ``# Title`` survives
            # cleaning and the title metadata is useful for retrieval prefix.
            title = _extract_title_from_markdown(content)
            page_meta = {"page": 1, "url": url}
            if title:
                page_meta["title"] = title
            if crawl_started_at is not None:
                # Stamp the crawl start on every chunk so the source's total time
                # taken = max(created_at) - crawl_started_at can be read back later.
                page_meta["crawl_started_at"] = crawl_started_at
            # Media URL extraction MUST run on the raw ``content`` (pre-clean)
            # because ``clean_text`` strips ``[label](url)`` markdown link
            # wrappers, which is how most crawled pages format video and file
            # references. Capture here, enrich YouTube entries with duration
            # (one-time per video, cached), propagate via chunk metadata.
            media = extract_media_urls(content)
            if media:
                enrich_media_urls_with_durations(media)
                page_meta["media_urls"] = media
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
            return {"chunks": 0, "pages_charged": 0, "credits_deducted": 0, "aborted": False}

        # Embed all chunks. embed_chunks sub-batches internally and runs the
        # batches concurrently (EMBED_CONCURRENCY), which is the main lever on
        # large-crawl wall-clock. It drives embed_progress_cb(done, total) as
        # batches complete so the UI keeps moving through this phase.
        logger.info(f"Batch embedding {len(all_chunk_contents)} chunks from {len(page_boundaries)} pages")
        all_embeddings: list = embed_chunks(
            chunk_content_list=all_chunk_contents,
            progress_cb=embed_progress_cb,
        )

        # Insert per-page with individual commits to prevent rollback cascade
        total = 0
        pages_charged = 0
        credits_deducted = 0
        aborted = False
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
                    source="crawl",
                )
                # Atomic billing: deduct in the same TX as the chunk insert so
                # we never end up with chunks-without-charge or charge-without-
                # chunks if the worker dies between the two operations.
                if cost_per_page > 0:
                    # Per-(job, url) idempotency (finding H): a retry of this
                    # crawl job re-runs the same URL with the same key, so the
                    # second charge is a no-op. Keyed on URL (not loop index)
                    # because the content-dedup skip can shift indices between
                    # attempts; the URL is the page's stable identity. Scope
                    # (client/bot) is embedded so keys never collide across
                    # ledgers. Absent job id → per-page charging as before.
                    idem_key = None
                    if crawl_job_id:
                        url_hash = hashlib.sha256(boundary["url"].encode("utf-8")).hexdigest()[:24]
                        idem_key = f"ingest:{client_id}:{ledger_bot_id}:{crawl_job_id}:{url_hash}"
                    credit_service.check_and_deduct(
                        session,
                        client_id,
                        cost_per_page,
                        reason=deduct_reason,
                        reference_id=deduct_reference_id,
                        bot_id=ledger_bot_id,
                        idempotency_key=idem_key,
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
                aborted = True
                break
            except credit_service.KillSwitchActive:
                session.rollback()
                logger.warning(
                    "Crawl billing aborted at %s for client %s: credit kill switch active. "
                    "Remaining pages will be skipped.",
                    boundary["url"],
                    client_id,
                )
                aborted = True
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
        "aborted": aborted,
    }


def _tenant_storage_dir(client_id: int, bot_id: int | None, *segments: str, create: bool = True) -> str:
    """Resolve a per-tenant cold-storage directory rooted at ``ARCHIVE_DIR``.

    Layout mirrors the per-tenant upload dir (``documents/{client_id}/{bot_id}/``):
    archive/quarantine live at ``{ARCHIVE_DIR}/{client_id}/{bot_id}/[...]`` so one
    tenant's processed/failed files can never mix with another's. ``bot_id is
    None`` (account-level uploads) uses a reserved ``_none`` segment that can
    never collide with a real bot id.

    Path components are integers (or the literal ``_quarantine``), so this can't
    be traversed; the ``is_relative_to`` guard is defense-in-depth to guarantee
    the result stays inside the archive root even if that ever changes.
    """
    base_dir = os.path.realpath(ARCHIVE_DIR)
    bot_segment = str(bot_id) if bot_id is not None else "_none"
    tenant_dir = os.path.realpath(os.path.join(base_dir, str(client_id), bot_segment, *segments))
    if os.path.commonpath([tenant_dir, base_dir]) != base_dir:
        raise ValueError(f"Refusing storage path outside archive root: {tenant_dir}")
    if create:
        os.makedirs(tenant_dir, exist_ok=True)
    return tenant_dir


def _tenant_archive_dir(client_id: int, bot_id: int | None, *, create: bool = True) -> str:
    """Per-tenant archive directory: ``{ARCHIVE_DIR}/{client_id}/{bot_id}/``."""
    return _tenant_storage_dir(client_id, bot_id, create=create)


def _tenant_quarantine_dir(client_id: int, bot_id: int | None, *, create: bool = True) -> str:
    """Per-tenant quarantine directory (a subfolder of the tenant archive dir)."""
    return _tenant_storage_dir(client_id, bot_id, _QUARANTINE_SUBDIR, create=create)


def _dest_with_collision_suffix(dest_dir: str, filename: str) -> str:
    """Return a destination path in ``dest_dir``, appending a timestamp only if
    ``filename`` already exists there (keeps both copies instead of clobbering).
    """
    dest_path = os.path.join(dest_dir, filename)
    if os.path.exists(dest_path):
        timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        name, ext = os.path.splitext(filename)
        dest_path = os.path.join(dest_dir, f"{name}_{timestamp}{ext}")
    return dest_path


def move_to_archive(file_path: str, filename: str, *, client_id: int, bot_id: int | None):
    """
    Move a processed file to the tenant's archive directory.
    If a file with the same name exists, append a timestamp to avoid collision.
    """
    dest_path = _dest_with_collision_suffix(_tenant_archive_dir(client_id, bot_id), filename)

    try:
        shutil.move(file_path, dest_path)
        logger.info(f"Archived file to: {dest_path}")
    except Exception as e:
        logger.error(f"Failed to archive {filename}: {e}")


def move_to_quarantine(file_path: str, filename: str, *, client_id: int, bot_id: int | None):
    """Move a file that failed ingestion to the tenant's quarantine folder.

    Same collision-avoidance pattern as ``move_to_archive``. Quarantining
    (rather than deleting) preserves the original for forensic review while
    ensuring the next ingestion run isn't blocked by the same poison pill.
    """
    dest_path = _dest_with_collision_suffix(_tenant_quarantine_dir(client_id, bot_id), filename)

    try:
        shutil.move(file_path, dest_path)
        logger.warning(f"Quarantined failed file: {dest_path}")
    except Exception as e:
        logger.error(f"Failed to quarantine {filename}: {e}")


def delete_archived_copies(client_id: int, bot_id: int | None, filename: str) -> int:
    """Remove a tenant's archived and quarantined copies of ``filename``.

    Called from the document-delete path so deleting a document also purges its
    cold-storage copies instead of leaving orphaned tenant data behind. Matches
    both the verbatim archived name and any ``{stem}_{timestamp}{ext}`` copies
    produced by the collision-avoidance suffix. Best-effort: logs and continues
    on individual failures, and is a harmless no-op for sources that were never
    archived (e.g. crawled URLs). Returns the number of files removed.
    """
    base_name = os.path.basename(filename)
    if not base_name:
        return 0

    stem, ext = os.path.splitext(base_name)
    # Precisely matches the collision-renamed variants (see
    # ``_dest_with_collision_suffix``) so we never delete an unrelated file the
    # same tenant happens to have named ``{stem}_something{ext}``.
    collision_pattern = re.compile(rf"^{re.escape(stem)}_\d{{8}}_\d{{6}}{re.escape(ext)}$")

    removed = 0
    for directory in (
        _tenant_archive_dir(client_id, bot_id, create=False),
        _tenant_quarantine_dir(client_id, bot_id, create=False),
    ):
        if not os.path.isdir(directory):
            continue
        try:
            entries = os.listdir(directory)
        except OSError as e:
            logger.error(f"Could not scan archive dir {directory}: {e}")
            continue
        for name in entries:
            if name != base_name and not collision_pattern.fullmatch(name):
                continue
            target = os.path.join(directory, name)
            if not os.path.isfile(target):
                continue
            try:
                os.remove(target)
                removed += 1
                logger.info(f"Removed archived copy: {target}")
            except OSError as e:
                logger.error(f"Failed to remove archived copy {target}: {e}")
    return removed
