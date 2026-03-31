import json
import logging
import urllib.request
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel as PydanticBaseModel

from app.api.auth import get_current_bot, get_current_client
from app.core.langfuse_client import get_langfuse
from app.db.models import Bot
from app.db.repository import create_or_update_lead_info, ensure_chat_session, get_chat_history, update_message_feedback
from app.db.session import get_session
from app.schemas.chat import ChatRequest, FeedbackRequest
from app.services.rag_service import rag_pipeline
from app.services.sdr_service import run_sdr_qualification


class LeadCaptureRequest(PydanticBaseModel):
    session_id: str
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    company: str | None = None


logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])


@router.post("/chat")
def chat_endpoint(request: ChatRequest, fastapi_request: Request, bot: Bot = Depends(get_current_bot)):
    """
    RAG Endpoint: Analyzes the question, retrieves relevant documents for the bot,
    and generates a standalone answer.
    Authenticated via X-Bot-Key or X-API-Key (resolves default bot).
    """
    try:
        user_agent = fastapi_request.headers.get("user-agent", "Unknown")

        ip_address = (
            fastapi_request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or fastapi_request.headers.get("x-real-ip", "")
            or (fastapi_request.client.host if fastapi_request.client else "127.0.0.1")
        )

        if ip_address in ("127.0.0.1", "localhost", "::1", "") or ip_address.startswith(("10.", "192.168.", "172.")):
            try:
                with urllib.request.urlopen("https://api.ipify.org?format=json", timeout=2.0) as resp:
                    ip_address = json.loads(resp.read().decode()).get("ip", ip_address)
            except Exception:
                pass

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
        location = f"IP: {ip_address}"

        try:
            if ip_address and ip_address not in ("127.0.0.1", "localhost", "::1"):
                geo_success = False

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
                                geo_success = True
                            elif country:
                                location = f"{country} | {ip_address}"
                                geo_success = True
                except Exception as e1:
                    logger.warning(f"ip-api.com failed for {ip_address}: {e1}")

                if not geo_success:
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
        except Exception as e:
            logger.warning(f"Failed to geolocate IP {ip_address}: {e}")

        session_id = request.session_id or str(uuid.uuid4())

        logger.info(f"Chat request | bot_id={bot.id} | bot_name={bot.name} | session={session_id}")

        result = rag_pipeline(
            bot,
            request.question,
            session_id=session_id,
            location=location,
            device=formatted_device,
            bot_id=bot.id,
        )

        logger.info(f"Chat response generated | session={session_id} | answer_length={len(result.get('answer', ''))}")
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Chat failed for bot {getattr(bot, 'id', '?')}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/chat/lead-capture")
def lead_capture_endpoint(request: LeadCaptureRequest, bot: Bot = Depends(get_current_bot)):
    """Capture lead contact info from pre-chat or handoff form. Auth: X-Bot-Key."""
    try:
        with get_session() as session:
            ensure_chat_session(session, request.session_id, bot_id=bot.id)
            create_or_update_lead_info(
                session,
                session_id=request.session_id,
                bot_id=bot.id,
                name=request.name,
                email=request.email,
                phone=request.phone,
                company=request.company,
            )
            session.commit()
            logger.info(f"Lead captured | bot={bot.id} session={request.session_id} email={request.email}")
            return {"success": True, "session_id": request.session_id}
    except Exception as e:
        logger.error(f"Lead capture failed: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/chat/sdr")
def chat_sdr_endpoint(request: ChatRequest, bot: Bot = Depends(get_current_bot)):
    """
    SDR Qualification Endpoint: Qualifies leads using BANT framework.
    Authenticated via X-Bot-Key or X-API-Key (resolves default bot).
    """
    try:
        session_id = request.session_id or str(uuid.uuid4())

        with get_session() as session:
            ensure_chat_session(session, session_id, client_id=None, bot_id=bot.id)
            session.commit()

        result = run_sdr_qualification(bot, request.question, session_id, bot_id=bot.id)

        if "error" in result:
            raise HTTPException(status_code=500, detail=result["error"])

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"SDR Chat failed: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/chat/feedback/{message_id}")
def submit_feedback_endpoint(message_id: int, request: FeedbackRequest, bot: Bot = Depends(get_current_bot)):
    """Submit feedback (thumbs up/down) for a specific bot reply. Also scores the Langfuse trace if available."""
    try:
        with get_session() as session:
            from app.db.models import ChatMessage as CM

            success = update_message_feedback(
                session, message_id, client_id=None, feedback_value=request.feedback, bot_id=bot.id
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
                            value=float(request.feedback),
                            data_type="NUMERIC",
                        )
                    except Exception as score_err:
                        logger.warning(f"Langfuse score failed (non-breaking): {score_err}")

            return {"message": "Feedback saved successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Feedback submission failed: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/chat/history/{session_id}")
def get_history_endpoint(
    session_id: str,
    bot_id: int | None = Query(None),
    client=Depends(get_current_client),
):
    """Retrieve chat history for a given session."""
    try:
        from sqlalchemy import select

        from app.db.models import Bot as BotModel
        from app.db.models import ChatMessage, ChatSession

        with get_session() as session:
            all_history = []
            sids = session_id.split(",")

            resolve_bot_ids = []
            if not bot_id:
                bots = session.execute(select(BotModel.id).where(BotModel.client_id == client.id)).scalars().all()
                resolve_bot_ids = list(bots)

            for sid in sids:
                if bot_id:
                    history = get_chat_history(session, sid, client_id=client.id, limit=50, bot_id=bot_id)
                elif resolve_bot_ids:
                    history = []
                    for bid in resolve_bot_ids:
                        history = get_chat_history(session, sid, client_id=client.id, limit=50, bot_id=bid)
                        if history:
                            break
                else:
                    history = get_chat_history(session, sid, client_id=client.id, limit=50)

                if not history:
                    # Ownership-validated fallback: join through session → bot to enforce client scope
                    stmt = (
                        select(ChatMessage)
                        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
                        .join(BotModel, ChatSession.bot_id == BotModel.id)
                        .where(
                            ChatMessage.session_id == sid,
                            BotModel.client_id == client.id,
                        )
                        .order_by(ChatMessage.created_at)
                        .limit(50)
                    )
                    history = session.execute(stmt).scalars().all()

                all_history.extend(history)

            all_history.sort(key=lambda m: m.created_at)

            return [{"role": m.role, "content": m.content, "timestamp": m.created_at.isoformat()} for m in all_history]
    except Exception as e:
        logger.error(f"Failed to fetch history: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e
