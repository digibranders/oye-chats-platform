from datetime import datetime, timedelta

from sqlalchemy import case, desc, func, insert, select, text

from app.db.models import ChatMessage, ChatSession, Client, Document, LeadInfo

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


def ensure_chat_session(
    session, session_id: str, client_id: int = None, bot_id: int = None, location: str = None, device: str = None
):
    """
    Check if a session exists, if not create it.
    Updates last_active_at if it exists.
    Supports both client_id (legacy) and bot_id (new).
    """
    # Try to find existing session
    stmt = select(ChatSession).where(ChatSession.id == session_id).limit(1)
    if bot_id:
        stmt = stmt.where(ChatSession.bot_id == bot_id)
    elif client_id:
        stmt = stmt.where(ChatSession.client_id == client_id)

    chat_session = session.execute(stmt).scalar_one_or_none()

    if not chat_session:
        new_session = ChatSession(id=session_id, client_id=client_id, bot_id=bot_id, location=location, device=device)
        session.add(new_session)
        session.flush()
    else:
        chat_session.last_active_at = func.now()
        if location:
            chat_session.location = location
        if device:
            chat_session.device = device
        # Backfill bot_id if missing
        if bot_id and not chat_session.bot_id:
            chat_session.bot_id = bot_id
        session.flush()


def update_session_bant(session, session_id: str, client_id: int = None, bant_data: dict = None, bot_id: int = None):
    """Update the BANT qualification state for a session."""
    stmt = select(ChatSession).where(ChatSession.id == session_id).limit(1)
    if bot_id:
        stmt = stmt.where(ChatSession.bot_id == bot_id)
    elif client_id:
        stmt = stmt.where(ChatSession.client_id == client_id)

    chat_session = session.execute(stmt).scalar_one_or_none()

    if chat_session and bant_data:
        for key, value in bant_data.items():
            if hasattr(chat_session, key) and value is not None:
                setattr(chat_session, key, value)
        session.flush()
        return True
    return False


def add_chat_message(
    session,
    session_id: str,
    client_id: int = None,
    role: str = "",
    content: str = "",
    location: str = None,
    device: str = None,
    bot_id: int = None,
):
    """Save a message to chat history. Supports both client_id (legacy) and bot_id (new)."""
    ensure_chat_session(session, session_id, client_id=client_id, bot_id=bot_id, location=location, device=device)
    new_message = ChatMessage(session_id=session_id, role=role, content=content)
    session.add(new_message)
    session.flush()
    return new_message


def get_chat_history(session, session_id: str, client_id: int = None, limit=10, bot_id: int = None):
    """Get the last N messages for a session."""
    # Verify session belongs to client/bot
    stmt_check = select(ChatSession.id).where(ChatSession.id == session_id)
    if bot_id:
        stmt_check = stmt_check.where(ChatSession.bot_id == bot_id)
    elif client_id:
        stmt_check = stmt_check.where(ChatSession.client_id == client_id)

    if not session.execute(stmt_check).first():
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
) -> LeadInfo:
    """Create or update lead info for a session."""
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
        session.flush()
        return existing

    lead = LeadInfo(
        session_id=session_id,
        bot_id=bot_id,
        name=name,
        email=email,
        phone=phone,
        company=company,
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
    """Return a filter clause for bot_id or client_id on the given model."""
    if bot_id:
        return model.bot_id == bot_id
    return model.client_id == client_id


def get_ingested_documents(session, client_id: int = None, bot_id: int = None):
    """Get a list of unique ingested documents and their chunk counts."""
    root_name_expr = func.coalesce(
        func.replace(func.substring(Document.document_name, r"^(https?://[^/]+)"), "www.", ""), Document.document_name
    )

    stmt = (
        select(root_name_expr.label("root_name"), func.max(Document.created_at).label("last_ingested_at"))
        .where(_owner_filter(Document, bot_id, client_id))
        .group_by(root_name_expr)
        .order_by(desc("last_ingested_at"))
    )

    results = session.execute(stmt).all()
    return [
        {"name": r.root_name, "ingested_at": r.last_ingested_at.isoformat() if r.last_ingested_at else None}
        for r in results
    ]


def insert_documents(
    session,
    client_id: int = None,
    file_name="",
    file_hash="",
    chunks=None,
    embeddings=None,
    metadatas=None,
    bot_id: int = None,
):
    """Batch insert documents. Supports both client_id (legacy) and bot_id (new)."""
    data = []
    for chunk, embedding, meta in zip(chunks or [], embeddings or [], metadatas or [], strict=False):
        row = {
            "document_name": file_name,
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


def is_document_processed(session, client_id: int = None, file_hash: str = "", bot_id: int = None) -> bool:
    """Check if a document with the given hash already exists."""
    stmt = select(Document.id).where(Document.file_hash == file_hash)
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
    session, client_id: int = None, query_embedding=None, k=5, bot_id: int = None, max_distance: float = 0.55
):
    """Find top-k most similar documents using vector similarity with distance threshold.

    Uses raw SQL for the vector distance calculation to bypass pgvector Python
    package version incompatibilities with the Vector type processor.
    """
    if hasattr(query_embedding, "tolist"):
        query_embedding = query_embedding.tolist()

    # Format as pgvector string literal: '[0.1,0.2,...]'
    if isinstance(query_embedding, list):
        emb_str = "[" + ",".join(str(v) for v in query_embedding) + "]"
    else:
        emb_str = str(query_embedding)

    # Execute raw SQL — bypasses pgvector Python type processor entirely
    if bot_id:
        where_clause = "WHERE bot_id = :owner_id"
        owner_id = bot_id
    else:
        where_clause = "WHERE client_id = :owner_id"
        owner_id = client_id

    results = session.execute(
        text(
            f"""SELECT id, client_id, bot_id, document_name, content, metadata_info,
                       embedding <-> CAST(:emb AS vector) AS distance
                FROM documents
                {where_clause} AND embedding <-> CAST(:emb AS vector) < :max_dist
                ORDER BY distance
                LIMIT :k"""
        ),
        {"emb": emb_str, "owner_id": owner_id, "max_dist": max_distance, "k": k},
    ).fetchall()

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
    """Return filter for ChatSession based on bot_id or client_id."""
    if bot_id:
        return ChatSession.bot_id == bot_id
    return ChatSession.client_id == client_id


def _doc_owner_filter(bot_id=None, client_id=None):
    """Return filter for Document based on bot_id or client_id."""
    if bot_id:
        return Document.bot_id == bot_id
    return Document.client_id == client_id


def get_dashboard_stats(session, client_id: int = None, bot_id: int = None):
    """Fetch aggregate statistics for admin dashboard."""
    sf = _session_owner_filter(bot_id, client_id)
    df = _doc_owner_filter(bot_id, client_id)

    total_sessions = session.execute(select(func.count(ChatSession.id)).where(sf)).scalar() or 0

    total_messages = session.execute(select(func.count(ChatMessage.id)).join(ChatSession).where(sf)).scalar() or 0

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

    return {
        "total_conversations": total_sessions,
        "total_messages": total_messages,
        "total_documents": total_sources,
        "active_users": active_users,
        "success_rate": success_rate,
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
    """Retrieve all bot messages that have received feedback."""
    sf = _session_owner_filter(bot_id, client_id)
    stmt = (
        select(ChatMessage, ChatSession.id.label("session_id"))
        .join(ChatSession)
        .where(sf, ChatMessage.role == "bot", ChatMessage.feedback.isnot(None))
        .order_by(ChatMessage.created_at)
    )

    results = session.execute(stmt).all()
    feedback_list = []

    for row in results:
        bot_msg = row.ChatMessage
        session_id = row.session_id

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
                "created_at": bot_msg.created_at.isoformat(),
                "question": question,
                "answer": bot_msg.content,
                "feedback": bot_msg.feedback,
            }
        )

    return feedback_list


def get_global_feedback_data(session):
    """Retrieve all feedback across all clients (superadmin)."""
    stmt = (
        select(ChatMessage, ChatSession.id.label("session_id"), Client.name.label("client_name"))
        .join(ChatSession)
        .join(Client, ChatSession.client_id == Client.id)
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


def get_visitor_data(session, client_id: int = None, bot_id: int = None):
    """Retrieve all visitor sessions for admin dashboard."""
    sf = _session_owner_filter(bot_id, client_id)
    stmt = (
        select(ChatSession, func.count(ChatMessage.id).label("message_count"))
        .outerjoin(ChatMessage)
        .where(sf)
        .group_by(ChatSession.id)
        .order_by(ChatSession.created_at)
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
