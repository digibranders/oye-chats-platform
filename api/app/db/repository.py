from datetime import datetime, timedelta

from sqlalchemy import Float, case, cast, desc, func, insert, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased

from app.core.exceptions import SessionOwnershipError
from app.db.models import (
    BANTSignal,
    Bot,
    BotGrowthEvent,
    ChatMessage,
    ChatSession,
    Client,
    Document,
    Event,
    LeadInfo,
    PlatformFeedback,
)

# ─────────────────────────────────────────────────────────────────────────────
# Helper: Resolve bot_id or client_id for backward compatibility
# ─────────────────────────────────────────────────────────────────────────────


def _resolve_owner(bot_id=None, client_id=None):
    """
    During migration, endpoints may pass bot_id OR client_id.
    Returns (bot_id, client_id) tuple — at least one will be set.
    """
    return bot_id, client_id


# ─────────────────────────────────────────────────────────────────────────────
# Chat Session & Message Operations
# ─────────────────────────────────────────────────────────────────────────────


def _get_session_for_bot(session, session_id: str, bot_id: int | None) -> ChatSession | None:
    """Look up a chat session by primary key and validate ownership.

    ``id`` is the primary key on ``chat_sessions`` — there can only ever be one
    row for a given ``session_id``. Earlier code filtered by ``bot_id`` in the
    ``WHERE`` clause, which silently turned ownership mismatches into PK
    collisions on subsequent INSERTs. The fix is to look up by ``id`` only and
    validate ownership in Python.

    Returns ``None`` when no row exists (caller may then INSERT). Raises
    ``SessionOwnershipError`` when a row exists but doesn't belong to
    ``bot_id`` — covers two cases:

    * ``chat_session.bot_id is None`` (legacy / pre-multi-bot data). We do not
      auto-claim these at runtime; the Alembic backfill migration handles
      unambiguous single-bot-client cases and the rest get a 404.
    * ``chat_session.bot_id != bot_id`` (cross-bot access). Reject explicitly.

    When ``bot_id`` is ``None`` the caller has opted out of validation
    (legacy ``client_id``-only flows) and any existing row is returned as-is.
    """
    chat_session = session.execute(
        select(ChatSession).where(ChatSession.id == session_id).limit(1)
    ).scalar_one_or_none()
    if chat_session is None:
        return None
    if bot_id is not None and chat_session.bot_id != bot_id:
        raise SessionOwnershipError(session_id, bot_id, chat_session.bot_id)
    return chat_session


def ensure_chat_session(
    session,
    session_id: str,
    client_id: int = None,
    bot_id: int = None,
    location: str = None,
    device: str = None,
) -> ChatSession:
    """Get-or-create a chat session, returning the row.

    * Looks up by primary key only — ``id`` uniquely identifies a session.
    * If the row exists and belongs to ``bot_id``, updates ``last_active_at``
      (plus optional ``location`` / ``device``) and returns it.
    * If the row exists but ``bot_id`` doesn't match, raises
      ``SessionOwnershipError`` (handled as HTTP 404 at the API layer).
    * If no row exists, INSERTs and returns. ``IntegrityError`` from a
      concurrent insert is caught and the winner's row is fetched instead.
    """
    chat_session = _get_session_for_bot(session, session_id, bot_id)

    if chat_session is None:
        try:
            chat_session = ChatSession(
                id=session_id,
                client_id=client_id,
                bot_id=bot_id,
                location=location,
                device=device,
            )
            session.add(chat_session)
            session.flush()
        except IntegrityError:
            # A concurrent request inserted the same session_id between our
            # SELECT and INSERT. Fall back to fetching the winning row and
            # re-validating ownership.
            session.rollback()
            chat_session = _get_session_for_bot(session, session_id, bot_id)
            if chat_session is None:
                raise
        return chat_session

    chat_session.last_active_at = func.now()
    # location/device are first-message context. Never overwrite a stored value:
    # the background geo-resolver in chat_routes upgrades the raw "IP: …" stamp
    # to "City, Country | IP" after the first turn, and subsequent chat turns
    # would otherwise clobber it back to the raw IP on every message.
    if location and not chat_session.location:
        chat_session.location = location
    if device and not chat_session.device:
        chat_session.device = device
    session.flush()
    return chat_session


_BANT_ALLOWED_FIELDS = frozenset(
    {
        "bant_need",
        "bant_timeline",
        "bant_authority",
        "bant_budget",
        "bant_need_score",
        "bant_budget_score",
        "bant_authority_score",
        "bant_timeline_score",
        "bant_score",
        "bant_tier",
        "dimensions_assessed",
        "bant_last_updated",
        "dimension_scores",
        "qualification_framework",
        "behavioral_score",
        "page_url",
        "referrer",
        "utm_params",
        "visit_count",
    }
)


def update_session_bant(session, session_id: str, client_id: int = None, bant_data: dict = None, bot_id: int = None):
    """Update the BANT qualification state for a session.

    Raises ``SessionOwnershipError`` when the session row exists but doesn't
    belong to ``bot_id`` (handled as HTTP 404 at the API layer).
    """
    chat_session = _get_session_for_bot(session, session_id, bot_id)

    if chat_session and bant_data:
        for key, value in bant_data.items():
            if key not in _BANT_ALLOWED_FIELDS:
                continue
            if hasattr(chat_session, key) and value is not None:
                setattr(chat_session, key, value)
        session.flush()
        return True
    return False


def get_bant_signals(session, session_id: str) -> list:
    """Return all BANT signal records for a session, ordered by creation time."""
    return (
        session.execute(select(BANTSignal).where(BANTSignal.session_id == session_id).order_by(BANTSignal.created_at))
        .scalars()
        .all()
    )


def add_chat_message(
    session,
    session_id: str,
    client_id: int = None,
    role: str = "",
    content: str = "",
    location: str = None,
    device: str = None,
    bot_id: int = None,
    media_card: dict | None = None,
    media_secondary: list | None = None,
):
    """Save a message to chat history. Supports both client_id (legacy) and bot_id (new).

    ``media_card`` / ``media_secondary`` persist the parsed media-card payload
    so the widget can re-render video/document cards on refresh — see
    ``ChatMessage.media_card`` for the shape. Both stay ``None`` for user
    turns and for bot answers that don't emit a card.
    """
    ensure_chat_session(session, session_id, client_id=client_id, bot_id=bot_id, location=location, device=device)
    new_message = ChatMessage(
        session_id=session_id,
        role=role,
        content=content,
        media_card=media_card,
        media_secondary=media_secondary,
    )
    session.add(new_message)
    session.flush()
    return new_message


def get_chat_history(session, session_id: str, client_id: int = None, limit=10, bot_id: int = None):
    """Get the last N messages for a session.

    Returns ``[]`` when the session does not exist. Raises
    ``SessionOwnershipError`` when the session exists but belongs to a
    different bot (handled as HTTP 404 at the API layer).
    """
    if _get_session_for_bot(session, session_id, bot_id) is None:
        return []

    stmt = (
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(desc(ChatMessage.created_at), desc(ChatMessage.id))
        .limit(limit)
    )

    results = session.execute(stmt).scalars().all()
    return results[::-1]


# ─────────────────────────────────────────────────────────────────────────────
# Lead Info Operations
# ─────────────────────────────────────────────────────────────────────────────


def create_or_update_lead_info(
    session,
    session_id: str,
    bot_id: int,
    name: str | None = None,
    email: str | None = None,
    phone: str | None = None,
    company: str | None = None,
    utm_params: dict | None = None,
    visitor_journey: list | None = None,
) -> LeadInfo:
    """Create or update lead info for a session.

    ``utm_params`` and ``visitor_journey`` are optional snapshots of the
    parent chat_session's attribution data. Caller is responsible for
    only passing them when the owning client's plan includes the Lead
    Source Attribution feature — this function does not re-check the
    entitlement, it only persists what it's given.

    The snapshots follow "first non-empty wins": once attribution is
    written on a lead, subsequent lead-form submissions on the same
    session don't overwrite it. This preserves first-touch attribution
    for a returning visitor who fills out the form multiple times.
    """
    existing = session.execute(select(LeadInfo).where(LeadInfo.session_id == session_id).limit(1)).scalar_one_or_none()

    if existing:
        if name is not None:
            existing.name = name
        if email is not None:
            existing.email = email
        if phone is not None:
            existing.phone = phone
        if company is not None:
            existing.company = company
        # Only backfill attribution — never overwrite an existing snapshot
        # so a later capture doesn't clobber first-touch data.
        if utm_params and not existing.utm_params:
            existing.utm_params = utm_params
        if visitor_journey and not existing.visitor_journey:
            existing.visitor_journey = visitor_journey
        session.flush()
        return existing

    lead = LeadInfo(
        session_id=session_id,
        bot_id=bot_id,
        name=name,
        email=email,
        phone=phone,
        company=company,
        utm_params=utm_params or None,
        visitor_journey=visitor_journey or None,
    )
    session.add(lead)
    session.flush()
    return lead


def get_lead_info_by_session(session, session_id: str) -> LeadInfo | None:
    """Get lead info for a session."""
    return session.execute(select(LeadInfo).where(LeadInfo.session_id == session_id).limit(1)).scalar_one_or_none()


# ─────────────────────────────────────────────────────────────────────────────
# Document Operations
# ─────────────────────────────────────────────────────────────────────────────


def _owner_filter(model, bot_id=None, client_id=None):
    """Return a filter scoped to bot_id AND client_id, and to ACTIVE knowledge.

    Defense-in-depth: always include client_id when available so that a bot_id
    belonging to a different client can never match, even if the caller forgets
    to validate bot ownership beforehand.

    When ``model`` carries an ``is_active`` flag (``Document`` does), the clause
    also excludes deactivated chunks — knowledge a bot keeps but no longer
    answers from after its plan lapsed to Free (see ``knowledge_state_service``).
    Every retrieval / listing path routes through here, so the active-only rule
    is enforced in one place. Dedup (``is_document_processed``) applies its own
    active guard so a Free re-crawl can rebuild fresh active chunks.

    Raises:
        ValueError: when both ``bot_id`` and ``client_id`` are missing/falsy.
            Falling through silently would return ``model.client_id IS NULL``
            which matches legacy pre-migration chunks — a cross-tenant leak
            path waiting for a caller bug. Tenant scope must fail loudly.
    """
    from sqlalchemy import and_

    if not bot_id and not client_id:
        raise ValueError("_owner_filter requires at least one of bot_id or client_id")

    if bot_id and client_id:
        tenant = and_(model.bot_id == bot_id, model.client_id == client_id)
    elif bot_id:
        tenant = model.bot_id == bot_id
    else:
        tenant = model.client_id == client_id

    active = getattr(model, "is_active", None)
    if active is not None:
        return and_(tenant, active.is_(True))
    return tenant


def get_ingested_documents(session, client_id: int = None, bot_id: int = None):
    """Get a list of unique ingested sources with page and chunk counts.

    ``page_count`` is the number of distinct pages/files under the source (for a
    website, one per crawled URL; for an uploaded file, always 1). ``chunk_count``
    is the total embedded chunks under the source. ``doc_page_count`` is the real
    page count of an uploaded file — read from the ``total_pages`` metadata stamped
    at extraction (PDF: page count; DOCX/TXT: 1) — and is ``None`` for websites and
    for legacy rows ingested before that metadata existed. ``duration_seconds`` is
    how long the most recent crawl of this source took (None for uploads / pre-timing
    crawls). The UI shows "N pages" for websites and uploaded documents alike.
    """
    root_name_expr = func.coalesce(
        func.replace(func.substring(Document.document_name, r"^(https?://[^/]+)"), "www.", ""), Document.document_name
    )
    # Epoch seconds the crawl started, stamped on each chunk at ingest time.
    started_expr = func.max(cast(Document.metadata_info["crawl_started_at"].astext, Float))

    stmt = (
        select(
            root_name_expr.label("root_name"),
            func.max(Document.created_at).label("last_ingested_at"),
            func.count(func.distinct(Document.document_name)).label("page_count"),
            func.count().label("chunk_count"),
            func.max(cast(Document.metadata_info["total_pages"].astext, Float)).label("doc_page_count"),
            started_expr.label("crawl_started_at"),
        )
        .where(_owner_filter(Document, bot_id, client_id))
        .group_by(root_name_expr)
        .order_by(desc("last_ingested_at"))
    )

    results = session.execute(stmt).all()

    def _duration(last_ingested_at, started_epoch):
        # Both maxes come from the latest crawl (its rows are newest AND have the
        # highest crawl_started_at), so the difference is that crawl's wall-clock.
        if not last_ingested_at or started_epoch is None:
            return None
        seconds = last_ingested_at.timestamp() - float(started_epoch)
        return round(seconds) if seconds >= 0 else None

    return [
        {
            "name": r.root_name,
            "ingested_at": r.last_ingested_at.isoformat() if r.last_ingested_at else None,
            "page_count": int(r.page_count),
            "chunk_count": int(r.chunk_count),
            "doc_page_count": int(r.doc_page_count) if r.doc_page_count is not None else None,
            "duration_seconds": _duration(r.last_ingested_at, r.crawl_started_at),
        }
        for r in results
    ]


def get_pages_for_source(session, source: str, bot_id: int = None, client_id: int = None) -> dict:
    """Return all unique crawled page URLs for a given root domain.

    ``source`` is the normalized root domain string returned by
    ``get_ingested_documents`` (e.g. ``"fynix.digital"``).  We reuse the same
    PostgreSQL expression so the filter matches the same rows.
    """
    root_name_expr = func.coalesce(
        func.replace(func.substring(Document.document_name, r"^(https?://[^/]+)"), "www.", ""),
        Document.document_name,
    )

    stmt = (
        select(
            Document.document_name.label("url"),
            func.max(Document.created_at).label("ingested_at"),
            func.count().label("chunk_count"),
            func.max(Document.metadata_info["title"].astext).label("title"),
        )
        .where(root_name_expr == source)
        .where(_owner_filter(Document, bot_id, client_id))
        .group_by(Document.document_name)
        .order_by(Document.document_name)
    )

    rows = session.execute(stmt).all()
    pages = [
        {
            "url": r.url,
            "title": r.title,
            "chunk_count": r.chunk_count,
            "ingested_at": r.ingested_at.isoformat() if r.ingested_at else None,
        }
        for r in rows
    ]
    return {
        "domain": source,
        "total_pages": len(pages),
        "total_chunks": sum(p["chunk_count"] for p in pages),
        "pages": pages,
    }


def count_documents_for_bot(session, bot_id: int = None, client_id: int = None) -> int:
    """Return the total number of stored chunks for a bot.

    Used by CAG-lite to decide whether to skip retrieval and inject all
    chunks directly into the prompt (when total count is small).
    """
    stmt = select(func.count()).select_from(Document).where(_owner_filter(Document, bot_id, client_id))
    return session.execute(stmt).scalar_one()


def count_knowledge_state(session, bot_id: int = None, client_id: int = None) -> dict:
    """Active vs deactivated chunk counts for a bot.

    Drives the "re-crawl to reactivate on Free" banner. Deliberately does NOT
    use ``_owner_filter`` (which now excludes inactive chunks) — this needs to
    see BOTH states. ``inactive > 0`` means a plan lapse deactivated knowledge,
    which is what distinguishes a downgraded bot from a brand-new empty one.
    """
    from sqlalchemy import and_

    if not bot_id and not client_id:
        return {"active": 0, "inactive": 0}
    if bot_id and client_id:
        scope = and_(Document.bot_id == bot_id, Document.client_id == client_id)
    elif bot_id:
        scope = Document.bot_id == bot_id
    else:
        scope = Document.client_id == client_id

    active = session.execute(
        select(func.count()).select_from(Document).where(scope, Document.is_active.is_(True))
    ).scalar_one()
    inactive = session.execute(
        select(func.count()).select_from(Document).where(scope, Document.is_active.is_(False))
    ).scalar_one()
    return {"active": int(active or 0), "inactive": int(inactive or 0)}


def get_all_documents_for_bot(session, bot_id: int = None, client_id: int = None) -> list:
    """Return every stored chunk for a bot, ordered by document name and id.

    Only called by CAG-lite when ``count_documents_for_bot`` is below the
    threshold — avoids loading thousands of chunks for large KBs.
    """
    stmt = (
        select(Document).where(_owner_filter(Document, bot_id, client_id)).order_by(Document.document_name, Document.id)
    )
    return list(session.execute(stmt).scalars())


def get_content_sample_for_bot(session, bot_id: int = None, client_id: int = None, max_chars: int = 4000) -> str:
    """Return a text sample from a bot's already-ingested documents.

    Concatenates the first document chunks (ordered by name/id) up to
    ``max_chars`` — enough context for on-demand brand-tone classification
    without loading the whole knowledge base. Returns ``""`` when the bot has no
    documents (caller treats that as "nothing crawled yet").
    """
    stmt = (
        select(Document.content)
        .where(_owner_filter(Document, bot_id, client_id))
        .order_by(Document.document_name, Document.id)
        .limit(20)
    )
    parts: list[str] = []
    total = 0
    for (content,) in session.execute(stmt):
        if not content:
            continue
        parts.append(content)
        total += len(content)
        if total >= max_chars:
            break
    return "\n\n".join(parts)[:max_chars]


def get_bot_media_urls(
    session,
    bot_id: int | None = None,
    client_id: int | None = None,
    limit: int = 100,
) -> list[dict]:
    """Return the distinct ``media_urls`` JSONB payloads across a bot's KB.

    Powers the bot-wide "AVAILABLE MEDIA" catalog in the RAG pipeline —
    so the LLM sees every video/file present anywhere in the knowledge
    base, not just the URLs that happened to ride with the top-K
    retrieved chunks. Without this, a topical mismatch between the
    retrieved chunks and the user's question (e.g. retrieval returns
    shell-less chunks for a busybox question because pypdf grouped them
    on the same page) starves the model of the right video option and
    forces it to emit whichever URL is available — a wrong-topic card.

    ``SELECT DISTINCT metadata_info->'media_urls'`` folds every chunk of
    a given page into one row (all chunks of a page share the same
    ``media_urls``), keeping the row count proportional to unique pages
    with media rather than chunks. ``LIMIT`` caps the worst case where
    a huge KB legitimately has hundreds of distinct-media pages.

    Returns a list of dicts each shaped like
    ``{"youtube": [{"video_id": "...", ...}], "files": [...]}``. Callers
    typically feed them to ``_build_media_catalog`` in rag_service.py.
    """
    if bot_id is None and client_id is None:
        return []

    if bot_id is not None:
        sql = text(
            "SELECT DISTINCT metadata_info->'media_urls' AS media "
            "FROM documents "
            "WHERE bot_id = :bot_id "
            "  AND metadata_info ? 'media_urls' "
            "LIMIT :limit"
        )
        params: dict[str, int] = {"bot_id": bot_id, "limit": limit}
    else:
        sql = text(
            "SELECT DISTINCT metadata_info->'media_urls' AS media "
            "FROM documents "
            "WHERE client_id = :client_id "
            "  AND metadata_info ? 'media_urls' "
            "LIMIT :limit"
        )
        params = {"client_id": client_id, "limit": limit}

    rows = session.execute(sql, params).fetchall()
    return [row[0] for row in rows if isinstance(row[0], dict)]


def insert_documents(
    session,
    client_id: int | None = None,
    file_name="",
    file_hash="",
    chunks=None,
    embeddings=None,
    metadatas=None,
    bot_id: int | None = None,
    source: str = "upload",
):
    """Batch insert documents. Supports both client_id (legacy) and bot_id (new).

    ``chunks``, ``embeddings`` and ``metadatas`` MUST be the same length —
    a partial embedding failure that returns fewer vectors than chunks would
    otherwise silently truncate (paid embeddings discarded, no error).

    ``source`` tags each row as ``"upload"`` or ``"crawl"`` (M7) so the
    documents quota counts uploaded files without sniffing ``document_name``.
    """
    chunks = chunks or []
    embeddings = embeddings or []
    metadatas = metadatas or []
    if not (len(chunks) == len(embeddings) == len(metadatas)):
        raise ValueError(
            f"insert_documents length mismatch: chunks={len(chunks)}, "
            f"embeddings={len(embeddings)}, metadatas={len(metadatas)}"
        )

    data = []
    for chunk, embedding, meta in zip(chunks, embeddings, metadatas, strict=True):
        row = {
            "document_name": file_name,
            "source": source,
            "file_hash": file_hash,
            "content": chunk,
            "metadata_info": meta,
            "embedding": embedding if isinstance(embedding, list) else embedding.tolist(),
        }
        if bot_id:
            row["bot_id"] = bot_id
        if client_id:
            row["client_id"] = client_id
        data.append(row)

    if not data:
        return

    stmt = insert(Document).values(data)
    session.execute(stmt)

    # Update search vectors
    if bot_id:
        session.execute(
            text("""
            UPDATE documents
            SET search_vector = to_tsvector('english', content)
            WHERE file_hash = :hash AND bot_id = :bot_id AND search_vector IS NULL
            """),
            {"hash": file_hash, "bot_id": bot_id},
        )
    elif client_id:
        session.execute(
            text("""
            UPDATE documents
            SET search_vector = to_tsvector('english', content)
            WHERE file_hash = :hash AND client_id = :client_id AND search_vector IS NULL
            """),
            {"hash": file_hash, "client_id": client_id},
        )


def delete_chunks_for_url(
    session,
    document_name: str,
    bot_id: int | None = None,
    client_id: int | None = None,
) -> int:
    """Delete all existing chunks for a specific page URL.

    Called before insert_documents() inside batch_web_ingestion to make per-URL
    ingestion idempotent. Prevents duplicate chunks when a page's content has
    changed between crawls (hash-based dedup alone would leave stale chunks).
    """
    filters = [Document.document_name == document_name]
    if bot_id:
        filters.append(Document.bot_id == bot_id)
    elif client_id:
        filters.append(Document.client_id == client_id)
    return session.query(Document).filter(*filters).delete(synchronize_session=False)


def is_document_processed(
    session, client_id: int | None = None, file_hash: str = "", bot_id: int | None = None
) -> bool:
    """Check if an ACTIVE document with the given hash already exists.

    Scoped to ``is_active`` so a Free re-crawl / re-upload after a downgrade
    (which deactivated the old chunks) is NOT skipped as a duplicate — it
    rebuilds fresh active knowledge. A later re-upgrade reactivates the old
    chunks; any resulting overlap is harmless.
    """
    stmt = select(Document.id).where(Document.file_hash == file_hash, Document.is_active.is_(True))
    if bot_id:
        stmt = stmt.where(Document.bot_id == bot_id)
    elif client_id:
        stmt = stmt.where(Document.client_id == client_id)
    stmt = stmt.limit(1)
    result = session.execute(stmt).first()
    return result is not None


def search_keyword_documents(session, client_id: int = None, query: str = "", k=5, bot_id: int = None):
    """Find documents using full-text keyword search, ranked by ts_rank relevance."""
    ts_query = func.plainto_tsquery("english", query)
    rank = func.ts_rank(Document.search_vector, ts_query).label("rank")
    stmt = (
        select(Document, rank)
        .filter(
            Document.search_vector.match(query, postgresql_regconfig="english"),
            _owner_filter(Document, bot_id, client_id),
        )
        .order_by(rank.desc())
        .limit(k)
    )

    return session.execute(stmt).all()


def search_similar_documents(
    session, client_id: int = None, query_embedding=None, k=5, bot_id: int = None, max_distance: float = 0.78
):
    """Find top-k most similar documents using vector similarity with distance threshold.

    Uses raw SQL for the vector distance calculation to bypass pgvector Python
    package version incompatibilities with the Vector type processor.

    ``max_distance`` is **cosine** distance (the ``<=>`` operator). The sole
    embedding provider is Google ``gemini-embedding-001`` (768-dim,
    Matryoshka-truncated, client-side L2-normalized — see
    ``gemini_embedding.py``; AR-37, replacing the stale BAAI/bge-base-en-v1.5 +
    OpenAI text-embedding-3-small pair this docstring used to describe), so
    cosine distance equals L2 rank ordering and is the correct metric here.

    The default 0.78 is the math-equivalent of the previously tuned
    ``L2 = 1.25`` (for unit vectors, ``cos_dist = L2² / 2``). That threshold
    was empirically chosen against bot_id=2 (Fynix Digital, 50 chunks) where
    on-topic queries cluster at cos_dist ≤ 0.7 and off-topic at ≥ 0.83. The
    earlier tight default (L2 = 0.65 → cos_dist ≈ 0.21) blocked all chunks for
    normal phrasings. The CRAG relevance judge downstream (threshold ≥ 0.55)
    provides a second filter so this primary cut-off can stay generous.
    """
    if hasattr(query_embedding, "tolist"):
        query_embedding = query_embedding.tolist()

    # Format as pgvector string literal: '[0.1,0.2,...]'
    if isinstance(query_embedding, list):
        emb_str = "[" + ",".join(str(v) for v in query_embedding) + "]"
    else:
        emb_str = str(query_embedding)

    # Execute raw SQL — bypasses pgvector Python type processor entirely.
    # Use separate static SQL strings (never interpolate into SQL text).
    # ``<=>`` is pgvector's cosine distance operator (0 = identical, 2 = opposite).
    #
    # AR-21: when both bot_id and client_id are available, AND both into the
    # WHERE clause — defense-in-depth matching the `_owner_filter` pattern
    # search_keyword_documents (and every other owner-scoped query in this
    # module) already applies. Not currently exploitable (bot_id and client_id
    # are both derived from the same authenticated Bot row on every existing
    # call path), but this is the single hottest query path in the system —
    # a future caller passing an attacker-influenced bot_id with a fixed
    # client_id would otherwise have no second gate.
    params = {"emb": emb_str, "max_dist": max_distance, "k": k}
    if bot_id and client_id:
        sql = text(
            """SELECT id, client_id, bot_id, document_name, content, metadata_info,
                      embedding <=> CAST(:emb AS vector) AS distance
               FROM documents
               WHERE bot_id = :bot_id AND client_id = :client_id AND is_active
                     AND embedding <=> CAST(:emb AS vector) < :max_dist
               ORDER BY distance
               LIMIT :k"""
        )
        params["bot_id"] = bot_id
        params["client_id"] = client_id
    elif bot_id:
        sql = text(
            """SELECT id, client_id, bot_id, document_name, content, metadata_info,
                      embedding <=> CAST(:emb AS vector) AS distance
               FROM documents
               WHERE bot_id = :owner_id AND is_active
                     AND embedding <=> CAST(:emb AS vector) < :max_dist
               ORDER BY distance
               LIMIT :k"""
        )
        params["owner_id"] = bot_id
    else:
        sql = text(
            """SELECT id, client_id, bot_id, document_name, content, metadata_info,
                      embedding <=> CAST(:emb AS vector) AS distance
               FROM documents
               WHERE client_id = :owner_id AND is_active
                     AND embedding <=> CAST(:emb AS vector) < :max_dist
               ORDER BY distance
               LIMIT :k"""
        )
        params["owner_id"] = client_id

    results = session.execute(sql, params).fetchall()

    # Wrap in SimpleNamespace so callers can access .id, .content, .document_name
    from types import SimpleNamespace

    return [
        (
            SimpleNamespace(
                id=r.id,
                client_id=r.client_id,
                bot_id=r.bot_id,
                document_name=r.document_name,
                content=r.content,
                metadata_info=r.metadata_info,
            ),
            r.distance,
        )
        for r in results
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Analytics — Support both bot_id and client_id (aggregate across all bots)
# ─────────────────────────────────────────────────────────────────────────────


def _session_owner_filter(bot_id=None, client_id=None):
    """Return filter for ChatSession based on bot_id or client_id.

    Defense-in-depth: always include client_id when available.
    """
    from sqlalchemy import and_

    if bot_id and client_id:
        return and_(ChatSession.bot_id == bot_id, ChatSession.client_id == client_id)
    if bot_id:
        return ChatSession.bot_id == bot_id
    return ChatSession.client_id == client_id


def _doc_owner_filter(bot_id=None, client_id=None):
    """Return filter for Document based on bot_id or client_id, active chunks only.

    Defense-in-depth: always include client_id when available. Scoped to
    ``is_active`` so downgraded (deactivated) knowledge drops out of dashboard
    document counts too, matching what retrieval and the KB list show.
    """
    from sqlalchemy import and_

    if bot_id and client_id:
        tenant = and_(Document.bot_id == bot_id, Document.client_id == client_id)
    elif bot_id:
        tenant = Document.bot_id == bot_id
    else:
        tenant = Document.client_id == client_id
    return and_(tenant, Document.is_active.is_(True))


def get_dashboard_stats(session, client_id: int = None, bot_id: int = None, days: int = None):
    """Fetch aggregate statistics for admin dashboard.

    Args:
        days: When provided, restricts conversation/message counts to the
              last N days.  active_users and total_documents are always live.
    """
    sf = _session_owner_filter(bot_id, client_id)
    df = _doc_owner_filter(bot_id, client_id)

    # Optional time window filter on ChatSession.created_at
    time_filter = []
    if days is not None:
        cutoff = datetime.utcnow() - timedelta(days=days)
        time_filter = [ChatSession.created_at >= cutoff]

    total_sessions = session.execute(select(func.count(ChatSession.id)).where(sf, *time_filter)).scalar() or 0

    total_messages = (
        session.execute(select(func.count(ChatMessage.id)).join(ChatSession).where(sf, *time_filter)).scalar() or 0
    )

    root_name_expr = func.coalesce(
        func.replace(func.substring(Document.document_name, r"^(https?://[^/]+)"), "www.", ""), Document.document_name
    )
    total_sources = session.execute(select(func.count(func.distinct(root_name_expr))).where(df)).scalar() or 0

    fifteen_mins_ago = datetime.utcnow() - timedelta(minutes=15)
    active_users = (
        session.execute(
            select(func.count(ChatSession.id)).where(sf, ChatSession.last_active_at >= fifteen_mins_ago)
        ).scalar()
        or 0
    )

    fb_result = session.execute(
        select(
            func.count(ChatMessage.id).label("total"),
            func.sum(case((ChatMessage.feedback == 1, 1), else_=0)).label("positive"),
        )
        .join(ChatSession)
        .where(sf, ChatMessage.role == "bot", ChatMessage.feedback.isnot(None))
    ).first()
    success_rate = 0
    if fb_result and fb_result.total > 0:
        success_rate = round((fb_result.positive / fb_result.total) * 100)

    growth_stmt = select(BotGrowthEvent.event_type, func.count(BotGrowthEvent.id).label("count")).group_by(
        BotGrowthEvent.event_type
    )
    if bot_id and client_id:
        growth_stmt = growth_stmt.join(Bot, Bot.id == BotGrowthEvent.bot_id).where(
            BotGrowthEvent.bot_id == bot_id,
            Bot.client_id == client_id,
        )
    elif bot_id:
        growth_stmt = growth_stmt.where(BotGrowthEvent.bot_id == bot_id)
    elif client_id:
        growth_stmt = growth_stmt.join(Bot, Bot.id == BotGrowthEvent.bot_id).where(Bot.client_id == client_id)

    if days is not None:
        growth_stmt = growth_stmt.where(BotGrowthEvent.created_at >= cutoff)

    growth_rows = session.execute(growth_stmt).all()
    growth_counts = {row.event_type: row.count for row in growth_rows}
    demo_shares = int(growth_counts.get("demo_share_clicked", 0) or 0)
    demo_opens = int(growth_counts.get("demo_link_opened", 0) or 0)
    demo_open_rate = round((demo_opens / demo_shares) * 100, 1) if demo_shares > 0 else 0

    return {
        "total_conversations": total_sessions,
        "total_messages": total_messages,
        "total_documents": total_sources,
        "active_users": active_users,
        "success_rate": success_rate,
        "demo_shares": demo_shares,
        "demo_opens": demo_opens,
        "demo_open_rate": demo_open_rate,
    }


def get_ratings_summary(session, client_id: int = None, bot_id: int = None):
    """Fetch post-chat visitor rating summary (avg, total, distribution by 1–5 stars)."""
    sf = _session_owner_filter(bot_id, client_id)

    rows = session.execute(
        select(ChatSession.visitor_rating, func.count(ChatSession.id).label("cnt"))
        .where(sf, ChatSession.visitor_rating.isnot(None))
        .group_by(ChatSession.visitor_rating)
    ).all()

    distribution = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    total = 0
    weighted_sum = 0

    for row in rows:
        star = int(row.visitor_rating)
        if 1 <= star <= 5:
            distribution[star] = row.cnt
            total += row.cnt
            weighted_sum += star * row.cnt

    avg = round(weighted_sum / total, 1) if total > 0 else None

    return {
        "avg": avg,
        "total": total,
        "distribution": distribution,
    }


def get_resolution_summary(session, client_id: int = None, bot_id: int = None):
    """Fetch post-chat visitor resolution summary (resolved, unresolved, rate)."""
    sf = _session_owner_filter(bot_id, client_id)

    rows = session.execute(
        select(ChatSession.visitor_resolved, func.count(ChatSession.id).label("cnt"))
        .where(sf, ChatSession.visitor_resolved.isnot(None))
        .group_by(ChatSession.visitor_resolved)
    ).all()

    resolved = 0
    unresolved = 0
    for row in rows:
        if row.visitor_resolved:
            resolved = row.cnt
        else:
            unresolved = row.cnt

    total = resolved + unresolved
    rate = round(resolved / total * 100, 1) if total > 0 else None

    return {
        "resolved": resolved,
        "unresolved": unresolved,
        "total": total,
        "rate": rate,
    }


def get_top_questions(session, client_id: int = None, limit: int = 5, bot_id: int = None):
    """Retrieve the most common user questions."""
    sf = _session_owner_filter(bot_id, client_id)
    stmt = (
        select(ChatMessage.content, func.count(ChatMessage.id).label("count"))
        .join(ChatSession)
        .where(sf, ChatMessage.role == "user")
        .group_by(ChatMessage.content)
        .having(func.count(ChatMessage.id) > 5)
        .order_by(desc("count"))
        .limit(limit)
    )

    results = session.execute(stmt).all()
    return [{"question": r.content, "count": r.count} for r in results]


def get_message_activity(session, client_id: int = None, days: int = None, bot_id: int = None):
    """Fetch message activity grouped by date."""
    sf = _session_owner_filter(bot_id, client_id)
    stmt = (
        select(
            func.date(ChatMessage.created_at).label("activity_date"), func.count(ChatMessage.id).label("message_count")
        )
        .join(ChatSession)
        .where(sf)
        .group_by("activity_date")
        .order_by("activity_date")
    )

    results = session.execute(stmt).all()
    return [{"date": str(r.activity_date), "messages": r.message_count} for r in results if r.activity_date]


def update_message_feedback(
    session, message_id: int, client_id: int = None, feedback_value: int = 0, bot_id: int = None
) -> bool:
    """Update feedback score for a specific bot message."""
    sf = _session_owner_filter(bot_id, client_id)
    stmt = (
        select(ChatMessage)
        .join(ChatSession)
        .where(ChatMessage.id == message_id, sf, ChatMessage.role == "bot")
        .limit(1)
    )

    msg = session.execute(stmt).scalar_one_or_none()
    if msg:
        msg.feedback = feedback_value
        return True
    return False


def get_feedback_data(session, client_id: int = None, bot_id: int = None):
    """Retrieve all bot messages that have received feedback.

    The preceding user question is resolved in the same query via a correlated
    subquery (audit F28): the old code ran one extra SELECT per feedback row
    (N+1), so a workspace with lots of feedback issued 1 + N round-trips.
    """
    sf = _session_owner_filter(bot_id, client_id)
    _UserMsg = aliased(ChatMessage)
    # Latest user message in the same session at or before the bot message.
    question_subq = (
        select(_UserMsg.content)
        .where(
            _UserMsg.session_id == ChatMessage.session_id,
            _UserMsg.role == "user",
            _UserMsg.created_at <= ChatMessage.created_at,
        )
        .order_by(desc(_UserMsg.created_at))
        .limit(1)
        .correlate(ChatMessage)
        .scalar_subquery()
    )
    stmt = (
        select(
            ChatMessage,
            ChatSession.id.label("session_id"),
            func.coalesce(question_subq, "Unknown Question").label("question"),
        )
        .join(ChatSession)
        .where(sf, ChatMessage.role == "bot", ChatMessage.feedback.isnot(None))
        .order_by(ChatMessage.created_at)
    )

    feedback_list = []
    for row in session.execute(stmt).all():
        bot_msg = row.ChatMessage
        feedback_list.append(
            {
                "message_id": bot_msg.id,
                "session_id": row.session_id,
                "created_at": bot_msg.created_at.isoformat(),
                "question": row.question,
                "answer": bot_msg.content,
                "feedback": bot_msg.feedback,
            }
        )

    return feedback_list


def get_global_feedback_data(session):
    """Retrieve all feedback across all clients (superadmin).

    ChatSession.client_id is nullable (legacy FK). Newer sessions carry only
    bot_id; the client must be resolved via Bot.client_id instead.  We use
    LEFT OUTER JOINs on both paths and COALESCE so every feedback row is
    returned regardless of which FK is populated.
    """
    ClientViaBot = aliased(Client)

    stmt = (
        select(
            ChatMessage,
            ChatSession.id.label("session_id"),
            func.coalesce(Client.name, ClientViaBot.name, "Unknown").label("client_name"),
        )
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .outerjoin(Client, ChatSession.client_id == Client.id)
        .outerjoin(Bot, ChatSession.bot_id == Bot.id)
        .outerjoin(ClientViaBot, Bot.client_id == ClientViaBot.id)
        .where(ChatMessage.role == "bot", ChatMessage.feedback.isnot(None))
        .order_by(ChatMessage.created_at)
    )

    results = session.execute(stmt).all()
    feedback_list = []

    for row in results:
        bot_msg = row.ChatMessage
        session_id = row.session_id
        client_name = row.client_name

        user_stmt = (
            select(ChatMessage)
            .where(
                ChatMessage.session_id == session_id,
                ChatMessage.role == "user",
                ChatMessage.created_at <= bot_msg.created_at,
            )
            .order_by(desc(ChatMessage.created_at))
            .limit(1)
        )

        user_msg = session.execute(user_stmt).scalar_one_or_none()
        question = user_msg.content if user_msg else "Unknown Question"

        feedback_list.append(
            {
                "message_id": bot_msg.id,
                "session_id": session_id,
                "client_name": client_name,
                "created_at": bot_msg.created_at.isoformat(),
                "question": question,
                "answer": bot_msg.content,
                "feedback": bot_msg.feedback,
            }
        )

    return feedback_list


def save_platform_feedback(
    session,
    client_id: int,
    message: str,
    attachment_url: str | None = None,
    category: str | None = None,
    type_: str = "other",
    area: str | None = None,
    severity: str | None = None,
    context: dict | None = None,
    attachments: list[dict] | None = None,
) -> PlatformFeedback:
    """Persist a classified feedback entry from an admin dashboard user.

    ``severity`` is bug-only — it is dropped unless ``type_`` is ``"bug"``. When
    ``attachments`` are provided, the first URL is mirrored into the legacy
    ``attachment_url`` column for back-compat with the single-attachment readers.
    """
    if attachments:
        attachment_url = attachment_url or attachments[0].get("url")
    entry = PlatformFeedback(
        client_id=client_id,
        message=message,
        attachment_url=attachment_url,
        category=category,
        type=type_,
        area=area,
        severity=severity if type_ == "bug" else None,
        context=context or None,
        attachments=attachments or None,
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return entry


def _serialize_platform_feedback(fb: PlatformFeedback) -> dict:
    """Shared serialization for a platform feedback row (taxonomy + status loop)."""
    # Coalesce the multi-attachment array from the legacy single column so old
    # rows render in the new gallery UI without a data migration.
    attachments = fb.attachments
    if not attachments:
        attachments = [{"url": fb.attachment_url}] if fb.attachment_url else []
    return {
        "id": fb.id,
        "message": fb.message,
        "attachment_url": fb.attachment_url,
        "attachments": attachments,
        "category": fb.category,
        "type": fb.type,
        "area": fb.area,
        "severity": fb.severity,
        "context": fb.context or None,
        "status": fb.status,
        "admin_response": fb.admin_response,
        "resolved_at": fb.resolved_at.isoformat() if fb.resolved_at else None,
        "created_at": fb.created_at.isoformat() if fb.created_at else None,
    }


def get_all_platform_feedback(
    session,
    status: str | None = None,
    type_: str | None = None,
    area: str | None = None,
    severity: str | None = None,
) -> list[dict]:
    """Return all platform feedback for the superadmin, newest first.

    Each of ``status`` / ``type_`` / ``area`` / ``severity`` optionally narrows
    the result to a single value.
    """
    stmt = (
        select(
            PlatformFeedback,
            Client.name.label("client_name"),
            Client.email.label("client_email"),
        )
        .outerjoin(Client, PlatformFeedback.client_id == Client.id)
        .order_by(desc(PlatformFeedback.created_at))
    )
    if status:
        stmt = stmt.where(PlatformFeedback.status == status)
    if type_:
        stmt = stmt.where(PlatformFeedback.type == type_)
    if area:
        stmt = stmt.where(PlatformFeedback.area == area)
    if severity:
        stmt = stmt.where(PlatformFeedback.severity == severity)
    results = session.execute(stmt).all()
    return [
        {
            "client_id": row.PlatformFeedback.client_id,
            "client_name": row.client_name or "Unknown",
            "client_email": row.client_email or "",
            "resolved_by": row.PlatformFeedback.resolved_by,
            **_serialize_platform_feedback(row.PlatformFeedback),
        }
        for row in results
    ]


def get_client_platform_feedback(session, client_id: int) -> list[dict]:
    """Return the given client's own feedback, newest first (status loop view)."""
    stmt = (
        select(PlatformFeedback)
        .where(PlatformFeedback.client_id == client_id)
        .order_by(desc(PlatformFeedback.created_at))
    )
    rows = session.execute(stmt).scalars().all()
    return [_serialize_platform_feedback(fb) for fb in rows]


def get_visitor_data(
    session,
    client_id: int = None,
    bot_id: int = None,
    *,
    limit: int = 500,
    offset: int = 0,
    created_after=None,
):
    """Retrieve visitor sessions for the admin dashboard (most-recent first).

    Bounded by ``limit``/``offset`` (audit F26): the query previously loaded
    every ChatSession for the workspace into memory, which grows without limit.

    ``created_after`` is the plan retention cutoff (see
    ``plan_entitlements_service.get_chat_history_retention_days``). When
    supplied, chats older than that timestamp are excluded — a Free customer
    with 7-day retention only sees the last week even if the DB holds a full
    trial's worth of transcripts. Pass ``None`` (default) to disable the
    filter for unlimited-history plans or non-admin callers.
    """
    sf = _session_owner_filter(bot_id, client_id)
    filters = [sf]
    if created_after is not None:
        filters.append(ChatSession.created_at >= created_after)
    stmt = (
        select(ChatSession, func.count(ChatMessage.id).label("message_count"))
        .outerjoin(ChatMessage)
        .where(*filters)
        .group_by(ChatSession.id)
        .order_by(ChatSession.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    results = session.execute(stmt).all()

    visitor_list = []
    for chat_session, message_count in results:
        visitor_list.append(
            {
                "session_id": chat_session.id,
                "location": chat_session.location or "Unknown",
                "device": chat_session.device or "Unknown",
                "chats": message_count,
                "created_at": chat_session.created_at.isoformat(),
                "last_active_at": chat_session.last_active_at.isoformat()
                if chat_session.last_active_at
                else chat_session.created_at.isoformat(),
                "bant": {
                    "need": chat_session.bant_need,
                    "timeline": chat_session.bant_timeline,
                    "authority": chat_session.bant_authority,
                    "budget": chat_session.bant_budget,
                },
            }
        )
    return visitor_list


# ─────────────────────────────────────────────────────────────────────────────
# Structured events (Tier 2 — SQL-backed answers to date-sensitive questions)
# ─────────────────────────────────────────────────────────────────────────────


def upsert_events(
    session,
    *,
    bot_id: int,
    source_url: str,
    events: list[dict],
    source_chunk_id: int | None = None,
) -> int:
    """Idempotently write a page's extracted events for a bot.

    Natural key is ``(bot_id, source_url, title)``: a re-crawl of the same
    page bumps ``last_seen_at`` and refreshes mutable fields; a genuinely
    new event on the same page gets inserted. Returns the number of rows
    written (inserted + updated). Caller is responsible for the commit.

    ``events`` is the list of dicts produced by
    ``ingestion.event_extractor.extract_events``.
    """
    if not bot_id or not source_url or not events:
        return 0
    from sqlalchemy.dialects.postgresql import (
        insert as pg_insert,  # local import to avoid pulling PG-specific syntax at import time in tests using SQLite
    )

    rows: list[dict] = []
    now_ts = datetime.utcnow()
    for ev in events:
        title = (ev.get("title") or "").strip()
        starts_at = ev.get("starts_at")
        if not title or starts_at is None:
            continue
        rows.append(
            {
                "bot_id": bot_id,
                "title": title,
                "starts_at": starts_at,
                "ends_at": ev.get("ends_at"),
                "url": ev.get("url"),
                "location": ev.get("location"),
                "source_url": source_url,
                "source_chunk_id": source_chunk_id,
                "last_seen_at": now_ts,
            }
        )
    if not rows:
        return 0

    stmt = pg_insert(Event).values(rows)
    stmt = stmt.on_conflict_do_update(
        constraint="uq_events_bot_source_title",
        set_={
            "starts_at": stmt.excluded.starts_at,
            "ends_at": stmt.excluded.ends_at,
            "url": stmt.excluded.url,
            "location": stmt.excluded.location,
            "source_chunk_id": stmt.excluded.source_chunk_id,
            "last_seen_at": stmt.excluded.last_seen_at,
        },
    )
    session.execute(stmt)
    return len(rows)


def get_upcoming_events(session, *, bot_id: int, limit: int = 10, now: datetime | None = None) -> list[Event]:
    """Return upcoming events for a bot, soonest first.

    ``now`` defaults to the server's current UTC time; pass an explicit
    value in tests so the fixture data is deterministic.
    """
    if not bot_id:
        return []
    now = now or datetime.utcnow()
    stmt = (
        select(Event).where(Event.bot_id == bot_id, Event.starts_at >= now).order_by(Event.starts_at.asc()).limit(limit)
    )
    return list(session.execute(stmt).scalars().all())


def prune_stale_events(session, *, retention_days: int) -> int:
    """Delete events whose source page hasn't mentioned them in a while.

    Two paths get deleted:
      * ``last_seen_at`` older than ``retention_days`` (customer removed
        the event from their site — a re-crawl would have refreshed it).
      * ``starts_at`` further than ``retention_days`` in the past
        (aged-out row we no longer care to keep for answering).

    Returns the number of rows deleted. Caller commits.
    """
    if retention_days <= 0:
        return 0
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    from sqlalchemy import delete, or_

    stmt = delete(Event).where(or_(Event.last_seen_at < cutoff, Event.starts_at < cutoff))
    result = session.execute(stmt)
    return int(result.rowcount or 0)
