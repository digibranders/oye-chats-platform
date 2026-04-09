import contextlib
import html as html_lib
import json
import logging
import re
import urllib.request
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel as PydanticBaseModel
from pydantic import Field, field_validator
from sqlalchemy import select

from app.api.auth import get_current_bot, get_current_client_or_operator
from app.core.langfuse_client import get_langfuse
from app.core.rate_limit import key_from_bot_key, limiter
from app.core.thread_pool import submit_background
from app.db.models import Bot, ChatSession
from app.db.repository import (
    create_or_update_lead_info,
    ensure_chat_session,
    get_lead_info_by_session,
    update_message_feedback,
)
from app.db.session import get_session
from app.schemas.chat import ChatRequest, FeedbackRequest
from app.services.rag_service import rag_pipeline, rag_pipeline_stream
from app.services.sdr_service import run_sdr_qualification

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")
_SAFE_URL_SCHEME = re.compile(r"^https?://", re.IGNORECASE)


def _sanitize_url(url: str | None, max_len: int = 2000) -> str | None:
    """Return a truncated URL only if it uses http(s), else None."""
    if not url:
        return None
    url = url.strip()[:max_len]
    return url if _SAFE_URL_SCHEME.match(url) else None


def _redact_email(email: str | None) -> str:
    """Return a partially redacted email for safe logging (GDPR)."""
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    return f"{local[0]}***@{domain}"


def _resolve_session_id(provided: str | None, bot_id: int) -> str:
    """Return a validated session_id.

    If the caller supplies one, verify it belongs to this bot before trusting it.
    A session belonging to a different bot gets a fresh server-generated UUID so
    callers cannot hijack another bot's conversation.
    """
    if not provided:
        return str(uuid.uuid4())
    with get_session() as db:
        existing = db.execute(select(ChatSession).where(ChatSession.id == provided)).scalar_one_or_none()
    if existing is not None and existing.bot_id != bot_id:
        # Session exists but belongs to a different bot — reject and mint a fresh ID
        return str(uuid.uuid4())
    return provided


class LeadCaptureRequest(PydanticBaseModel):
    session_id: str
    name: str | None = Field(None, max_length=255)
    email: str | None = Field(None, max_length=255)
    phone: str | None = Field(None, max_length=50)
    company: str | None = Field(None, max_length=255)

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Please enter a valid email address.")
        return v


class BehavioralSignalsRequest(PydanticBaseModel):
    session_id: str
    page_url: str | None = None
    referrer: str | None = None
    utm_params: dict | None = None
    time_on_page: float | None = None  # seconds
    pages_viewed: int | None = None
    is_return_visit: bool = False


class MeetingBookedRequest(PydanticBaseModel):
    session_id: str
    booking_url: str | None = None
    meeting_time: str | None = None
    attendee_email: str | None = None


logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])


def _parse_request_context(fastapi_request: Request):
    """Extract IP address, device, and browser from the request (no blocking HTTP calls)."""
    user_agent = fastapi_request.headers.get("user-agent", "Unknown")

    ip_address = (
        fastapi_request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or fastapi_request.headers.get("x-real-ip", "")
        or (fastapi_request.client.host if fastapi_request.client else "127.0.0.1")
    )

    device = "Other"
    if "Mobi" in user_agent:
        device = "Mobile"
    elif "Tablet" in user_agent:
        device = "Tablet"
    else:
        device = "Desktop"

    browser = "Unknown Browser"
    if "Chrome" in user_agent:
        browser = "Chrome"
    elif "Firefox" in user_agent:
        browser = "Firefox"
    elif "Safari" in user_agent:
        browser = "Safari"
    elif "Edge" in user_agent:
        browser = "Edge"

    formatted_device = f"{browser} on {device}"
    return ip_address, formatted_device


def _resolve_and_update_location(session_id: str, ip_address: str):
    """Fire-and-forget: resolve geolocation from IP and update the session in DB."""
    try:
        # Resolve public IP if local
        is_local = ip_address in ("127.0.0.1", "localhost", "::1", "")
        is_private = ip_address.startswith(("10.", "192.168.", "172."))
        if is_local or is_private:
            try:
                with urllib.request.urlopen("https://api.ipify.org?format=json", timeout=2.0) as resp:
                    ip_address = json.loads(resp.read().decode()).get("ip", ip_address)
            except Exception:
                return

        if not ip_address or ip_address in ("127.0.0.1", "localhost", "::1"):
            return

        location = None

        # Try ip-api.com first
        try:
            req = urllib.request.Request(
                f"http://ip-api.com/json/{ip_address}",
                headers={"User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=3.0) as response:
                data = json.loads(response.read().decode())
                if data.get("status") == "success":
                    city = data.get("city", "")
                    country = data.get("country", "")
                    if city and country:
                        location = f"{city}, {country} | {ip_address}"
                    elif country:
                        location = f"{country} | {ip_address}"
        except Exception as e1:
            logger.warning(f"ip-api.com failed for {ip_address}: {e1}")

        # Fallback to ipinfo.io
        if not location:
            try:
                req2 = urllib.request.Request(
                    f"https://ipinfo.io/{ip_address}/json",
                    headers={"User-Agent": "Mozilla/5.0"},
                )
                with urllib.request.urlopen(req2, timeout=3.0) as response2:
                    data2 = json.loads(response2.read().decode())
                    city = data2.get("city", "")
                    country = data2.get("country", "")
                    if city and country:
                        location = f"{city}, {country} | {ip_address}"
                    elif country:
                        location = f"{country} | {ip_address}"
            except Exception as e2:
                logger.warning(f"ipinfo.io also failed for {ip_address}: {e2}")

        if location:
            with get_session() as session:
                chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
                if chat_session:
                    chat_session.location = location
                    session.commit()
                    logger.info(f"Background geolocation resolved | session={session_id} | location={location}")
    except Exception as e:
        logger.warning(f"Background geolocation failed for session {session_id}: {e}")


@router.post("/chat")
@limiter.limit("30/minute", key_func=key_from_bot_key)
def chat_endpoint(body: ChatRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """
    RAG Endpoint: Analyzes the question, retrieves relevant documents for the bot,
    and generates a standalone answer.
    Authenticated via X-Bot-Key or X-API-Key (resolves default bot).
    """
    try:
        ip_address, formatted_device = _parse_request_context(request)
        location = f"IP: {ip_address}"
        session_id = _resolve_session_id(body.session_id, bot.id)

        # Fire-and-forget geolocation (saves 2-8s per request)
        submit_background(_resolve_and_update_location, session_id, ip_address)

        logger.info(f"Chat request | bot_id={bot.id} | bot_name={bot.name} | session={session_id}")

        result = rag_pipeline(
            bot,
            body.question,
            session_id=session_id,
            location=location,
            device=formatted_device,
            bot_id=bot.id,
        )

        ans_len = len(result.get("answer", ""))
        logger.info(f"Chat response generated | session={session_id} | answer_length={ans_len}")
        return result
    except HTTPException:
        raise
    except Exception as e:
        bot_id = getattr(bot, "id", "?")
        err_type = type(e).__name__
        logger.error(f"Chat failed for bot {bot_id}: {err_type}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Chat request failed. Please try again.") from e


@router.post("/chat/stream")
@limiter.limit("30/minute", key_func=key_from_bot_key)
async def chat_stream_endpoint(body: ChatRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """
    Streaming RAG Endpoint: Streams the response token-by-token via SSE.
    Protocol: METADATA:{json} → text chunks → FINAL_METADATA:{json}
    Authenticated via X-Bot-Key or X-API-Key (resolves default bot).
    """
    ip_address, formatted_device = _parse_request_context(request)
    location = f"IP: {ip_address}"
    session_id = _resolve_session_id(body.session_id, bot.id)

    # Fire-and-forget geolocation
    submit_background(_resolve_and_update_location, session_id, ip_address)

    logger.info(f"Chat stream request | bot_id={bot.id} | bot_name={bot.name} | session={session_id}")

    return StreamingResponse(
        rag_pipeline_stream(
            bot,
            body.question,
            session_id=session_id,
            location=location,
            device=formatted_device,
            bot_id=bot.id,
        ),
        media_type="text/event-stream",
    )


@router.post("/chat/lead-capture")
@limiter.limit("10/minute", key_func=key_from_bot_key)
def lead_capture_endpoint(body: LeadCaptureRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Capture lead contact info from pre-chat or handoff form. Auth: X-Bot-Key."""
    try:
        with get_session() as session:
            ensure_chat_session(session, body.session_id, bot_id=bot.id)
            create_or_update_lead_info(
                session,
                session_id=body.session_id,
                bot_id=bot.id,
                name=body.name,
                email=body.email,
                phone=body.phone,
                company=body.company,
            )
            session.commit()
            logger.info(f"Lead captured | bot={bot.id} session={body.session_id} email={_redact_email(body.email)}")
            try:
                from app.services.webhook_service import fire_webhook

                fire_webhook(
                    bot.id,
                    "lead_captured",
                    {
                        "session_id": body.session_id,
                        "name": body.name,
                        "email": body.email,
                        "phone": body.phone,
                        "company": body.company,
                    },
                )
            except Exception as wh_err:
                logger.warning(f"Webhook dispatch failed (non-blocking): {wh_err}")
            return {"success": True, "session_id": body.session_id}
    except Exception as e:
        logger.error(f"Lead capture failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to capture lead information.") from e


@router.post("/chat/behavioral-signals")
@limiter.limit("30/minute", key_func=key_from_bot_key)
def behavioral_signals_endpoint(body: BehavioralSignalsRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Receive behavioral signals from the widget and compute a behavioral score.

    Called on session init with page context, and on beforeunload with time-on-page.
    Auth: X-Bot-Key.
    """
    from app.db.models import VisitorEvent
    from app.services.behavioral_service import score_behavioral_signals

    try:
        with get_session() as session:
            ensure_chat_session(session, body.session_id, bot_id=bot.id)
            chat_session = session.execute(
                select(ChatSession).where(ChatSession.id == body.session_id, ChatSession.bot_id == bot.id)
            ).scalar_one()

            # Store page context on the session (first call wins for URL/referrer)
            safe_page_url = _sanitize_url(body.page_url)
            if safe_page_url and not chat_session.page_url:
                chat_session.page_url = safe_page_url
            safe_referrer = _sanitize_url(body.referrer)
            if safe_referrer and not chat_session.referrer:
                chat_session.referrer = safe_referrer
            if body.utm_params and not chat_session.utm_params:
                chat_session.utm_params = body.utm_params

            # Update visit count from widget
            if body.is_return_visit and chat_session.visit_count <= 1:
                chat_session.visit_count = max(chat_session.visit_count, 2)

            # Record visitor events
            if safe_page_url:
                session.add(
                    VisitorEvent(
                        session_id=body.session_id,
                        bot_id=bot.id,
                        event_type="page_view",
                        event_data={"url": safe_page_url},
                    )
                )
            if body.utm_params and any(body.utm_params.values()):
                session.add(
                    VisitorEvent(
                        session_id=body.session_id,
                        bot_id=bot.id,
                        event_type="utm_captured",
                        event_data=body.utm_params,
                    )
                )
            if body.is_return_visit:
                session.add(
                    VisitorEvent(
                        session_id=body.session_id,
                        bot_id=bot.id,
                        event_type="return_visit",
                        event_data={"visit_count": chat_session.visit_count},
                    )
                )
            if body.time_on_page and body.time_on_page > 0:
                session.add(
                    VisitorEvent(
                        session_id=body.session_id,
                        bot_id=bot.id,
                        event_type="time_on_site",
                        event_data={"seconds": round(body.time_on_page, 1)},
                    )
                )

            # Compute and store behavioral score
            new_score = score_behavioral_signals(
                {
                    "is_return_visit": body.is_return_visit,
                    "utm_params": body.utm_params,
                    "time_on_page": body.time_on_page or 0,
                    "pages_viewed": body.pages_viewed or 0,
                    "referrer": body.referrer or "",
                },
                bot=bot,
            )
            # Only upgrade behavioral score (never downgrade)
            if new_score > chat_session.behavioral_score:
                chat_session.behavioral_score = new_score

            session.commit()
            logger.info(f"Behavioral signals recorded | bot={bot.id} session={body.session_id} score={new_score}")
            return {"success": True, "behavioral_score": chat_session.behavioral_score}
    except Exception as e:
        logger.error(f"Behavioral signals failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to record behavioral signals.") from e


@router.post("/chat/meeting-booked")
@limiter.limit("10/minute", key_func=key_from_bot_key)
def meeting_booked_endpoint(body: MeetingBookedRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    try:
        from datetime import datetime

        from app.db.models import MeetingBooking
        from app.services.webhook_service import fire_webhook

        with get_session() as session:
            ensure_chat_session(session, body.session_id, bot_id=bot.id)
            meeting_time = None
            if body.meeting_time:
                with contextlib.suppress(Exception):
                    meeting_time = datetime.fromisoformat(body.meeting_time)

            session.add(
                MeetingBooking(
                    session_id=body.session_id,
                    bot_id=bot.id,
                    booking_url=body.booking_url,
                    meeting_time=meeting_time,
                    attendee_email=body.attendee_email,
                    status="scheduled",
                )
            )
            session.commit()

            try:
                fire_webhook(
                    bot.id,
                    "meeting_booked",
                    {
                        "session_id": body.session_id,
                        "booking_url": body.booking_url,
                        "meeting_time": body.meeting_time,
                        "attendee_email": body.attendee_email,
                    },
                )
            except Exception as wh_err:
                logger.warning(f"Webhook dispatch failed (non-blocking): {wh_err}")

            return {"success": True}
    except Exception as e:
        logger.error(f"Meeting booking save failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to save meeting booking.") from e


@router.get("/chat/lead-info/{session_id}")
def get_lead_info_endpoint(session_id: str, bot: Bot = Depends(get_current_bot)):
    """
    Fetch existing lead info for a widget session. Auth: X-Bot-Key.
    Always returns HTTP 200 — non-critical endpoint that must never block widget load.
    Used by the widget to pre-fill HandoffForm fields and skip re-asking known info.
    """
    try:
        with get_session() as session:
            chat_session = session.execute(
                select(ChatSession).where(
                    ChatSession.id == session_id,
                    ChatSession.bot_id == bot.id,
                )
            ).scalar_one_or_none()
            if not chat_session:
                return {"lead_info": None}
            lead_info = get_lead_info_by_session(session, session_id)
            if not lead_info:
                return {"lead_info": None}
            return {
                "lead_info": {
                    "name": lead_info.name,
                    "email": lead_info.email,
                    "phone": lead_info.phone,
                    "company": lead_info.company,
                }
            }
    except Exception as e:
        logger.error(f"Failed to fetch lead info for session {session_id}: {e}")
        return {"lead_info": None}  # Always non-breaking for the widget


@router.post("/chat/sdr")
def chat_sdr_endpoint(body: ChatRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """
    SDR Qualification Endpoint: Qualifies leads using BANT framework.
    Authenticated via X-Bot-Key or X-API-Key (resolves default bot).
    """
    try:
        session_id = body.session_id or str(uuid.uuid4())

        with get_session() as session:
            ensure_chat_session(session, session_id, client_id=None, bot_id=bot.id)
            session.commit()

        result = run_sdr_qualification(bot, body.question, session_id, bot_id=bot.id)

        if "error" in result:
            logger.error(f"SDR qualification error: {result['error']}")
            raise HTTPException(status_code=500, detail="Chat request failed. Please try again.")

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"SDR Chat failed: {e}")
        raise HTTPException(status_code=500, detail="Chat request failed. Please try again.") from e


@router.post("/chat/feedback/{message_id}")
def submit_feedback_endpoint(
    message_id: int, body: FeedbackRequest, request: Request, bot: Bot = Depends(get_current_bot)
):
    """Submit feedback (thumbs up/down) for a specific bot reply. Also scores the Langfuse trace if available."""
    try:
        with get_session() as session:
            from app.db.models import ChatMessage as CM

            success = update_message_feedback(
                session, message_id, client_id=None, feedback_value=body.feedback, bot_id=bot.id
            )
            session.commit()
            if not success:
                raise HTTPException(status_code=404, detail="Message not found or does not belong to this bot")

            # Score the Langfuse trace if trace_id exists
            lf = get_langfuse()
            if lf:
                msg = session.query(CM).filter(CM.id == message_id).first()
                if msg and msg.trace_id:
                    try:
                        lf.create_score(
                            trace_id=msg.trace_id,
                            name="user-feedback",
                            value=float(body.feedback),
                            data_type="NUMERIC",
                        )
                    except Exception as score_err:
                        logger.warning(f"Langfuse score failed (non-breaking): {score_err}")

            return {"message": "Feedback saved successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Feedback submission failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to save feedback.") from e


@router.get("/chat/history/{session_id}")
def get_history_endpoint(
    request: Request,
    session_id: str,
    bot_id: int | None = Query(None),
    before: int | None = Query(None, description="Cursor — return messages with id < this value (for pagination)"),
    limit: int = Query(50, ge=1, le=200, description="Max messages to return"),
):
    """Retrieve chat history for a given session.

    Accepts both admin auth (X-API-Key / X-Operator-Key) and widget auth (X-Bot-Key).
    Supports cursor-based pagination via `before` param.
    """
    # Dual auth: try client/operator first, fall back to bot key (widget)
    auth = None
    resolved_bot_id = bot_id
    try:
        auth = get_current_client_or_operator(
            api_key=request.headers.get("X-API-Key"),
            operator_key=request.headers.get("X-Operator-Key"),
            legacy_agent_key=request.headers.get("X-Agent-Key"),
        )
    except (HTTPException, Exception):
        # Fall back to bot key auth for widget access
        raw_bot_key = request.headers.get("X-Bot-Key")
        if not raw_bot_key:
            raise HTTPException(status_code=401, detail="Authentication required") from None
        with get_session() as db:
            bot_obj = db.execute(
                select(Bot).where(Bot.bot_key == raw_bot_key, Bot.is_active.is_(True))
            ).scalar_one_or_none()
            if not bot_obj:
                raise HTTPException(status_code=401, detail="Invalid bot key") from None
            resolved_bot_id = bot_obj.id
            auth = {"client_id": bot_obj.client_id, "type": "bot"}

    try:
        from app.db.models import Bot as BotModel
        from app.db.models import ChatMessage, ChatSession

        with get_session() as session:
            all_history = []
            sids = session_id.split(",")

            resolve_bot_ids = []
            if not resolved_bot_id:
                query = select(BotModel.id).where(BotModel.client_id == auth["client_id"])
                bots = session.execute(query).scalars().all()
                resolve_bot_ids = list(bots)

            for sid in sids:
                # Build paginated query with cursor support
                stmt = (
                    select(ChatMessage)
                    .join(ChatSession, ChatMessage.session_id == ChatSession.id)
                    .join(BotModel, ChatSession.bot_id == BotModel.id)
                    .where(
                        ChatMessage.session_id == sid,
                        BotModel.client_id == auth["client_id"],
                    )
                )
                if resolved_bot_id:
                    stmt = stmt.where(BotModel.id == resolved_bot_id)
                elif resolve_bot_ids:
                    stmt = stmt.where(BotModel.id.in_(resolve_bot_ids))

                if before is not None:
                    stmt = stmt.where(ChatMessage.id < before)

                stmt = stmt.order_by(ChatMessage.id.desc()).limit(limit)
                history = session.execute(stmt).scalars().all()
                all_history.extend(history)

            # Reverse to chronological order (we queried desc for cursor)
            all_history.sort(key=lambda m: (m.created_at, m.id))

            return [
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "timestamp": m.created_at.isoformat(),
                }
                for m in all_history
            ]
    except Exception as e:
        logger.error(f"Failed to fetch history: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch chat history.") from e


# ── Visitor file upload — presigned B2 PUT URL ──

_ALLOWED_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
    "text/plain",
}
_MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB


class UploadUrlRequest(PydanticBaseModel):
    filename: str
    content_type: str
    size: int  # bytes — validated before issuing the URL


@router.post("/chat/upload-url")
@limiter.limit("20/minute", key_func=key_from_bot_key)
async def get_visitor_upload_url(
    body: UploadUrlRequest,
    request: Request,
    bot: Bot = Depends(get_current_bot),
):
    """Return a presigned B2 PUT URL so the widget can upload a file directly.

    Auth: X-Bot-Key header. The widget uploads via PUT (no auth needed) then
    sends the file_url over the live-chat WebSocket.
    """
    if body.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail=f"File type '{body.content_type}' is not allowed.")
    if body.size > _MAX_SIZE_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds 10 MB limit.")

    safe_name = body.filename.replace("/", "").replace("\\", "")[:100]
    ext = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else "bin"
    key = f"chat-files/{uuid.uuid4()}.{ext}"

    from app.services.b2_service import _build_public_url, generate_presigned_put

    upload_url = generate_presigned_put(key, body.content_type)
    file_url = _build_public_url(key)
    return {"upload_url": upload_url, "file_url": file_url, "key": key}


# ── Transcript Email ──


class TranscriptEmailRequest(PydanticBaseModel):
    session_id: str
    recipient_email: str

    @field_validator("recipient_email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        import re

        v = v.strip().lower()
        if not re.match(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", v):
            raise ValueError("Please enter a valid email address.")
        return v


@router.post("/chat/transcript")
@limiter.limit("3/minute", key_func=key_from_bot_key)
def send_chat_transcript(
    body: TranscriptEmailRequest,
    request: Request,
    bot: Bot = Depends(get_current_bot),
):
    """Send the chat transcript for a session to the visitor's email.

    Auth: X-Bot-Key header (widget).
    Rate limit: 3 per minute per bot key to prevent abuse.
    """
    from app.db.models import ChatMessage
    from app.services.email_service import send_transcript_email

    with get_session() as session:
        # Verify session belongs to this bot
        chat_session = session.execute(
            select(ChatSession).where(
                ChatSession.id == body.session_id,
                ChatSession.bot_id == bot.id,
            )
        ).scalar_one_or_none()
        if not chat_session:
            raise HTTPException(status_code=404, detail="Chat session not found.")

        # Fetch all messages in chronological order
        messages = (
            session.execute(
                select(ChatMessage)
                .where(ChatMessage.session_id == body.session_id)
                .order_by(ChatMessage.created_at.asc())
            )
            .scalars()
            .all()
        )
        if not messages:
            raise HTTPException(status_code=404, detail="No messages found for this session.")

        message_dicts = [
            {
                "role": msg.role,
                "content": html_lib.escape(msg.content or ""),
                "created_at": msg.created_at.isoformat() if msg.created_at else None,
            }
            for msg in messages
        ]

    send_transcript_email(
        to_email=body.recipient_email,
        bot_name=bot.name,
        messages=message_dicts,
        reply_to=bot.reply_to_email,
    )

    return {"success": True, "message": f"Transcript sent to {body.recipient_email}"}
