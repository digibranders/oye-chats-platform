import contextlib
import html as html_lib
import ipaddress
import json
import logging
import re
import time
import urllib.request
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel as PydanticBaseModel
from pydantic import Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.auth import bot_subscription_status, get_bot_for_chat, get_current_bot, get_current_client_or_operator
from app.core.exceptions import SessionOwnershipError
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

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")
_SAFE_URL_SCHEME = re.compile(r"^https?://", re.IGNORECASE)


def _sanitize_url(url: str | None, max_len: int = 2000) -> str | None:
    """Return a truncated URL only if it uses http(s), else None."""
    if not url:
        return None
    url = url.strip()[:max_len]
    return url if _SAFE_URL_SCHEME.match(url) else None


# Caps for widget-supplied visitor_journey payloads. The array reaches the
# database as JSONB and is rendered as a timeline in the admin UI — bounding
# both entry count and per-field length keeps row size predictable on
# high-navigation sites (SPA with hundreds of history.pushState calls) and
# blocks obvious injection (long strings, unexpected schemes).
_MAX_JOURNEY_ENTRIES = 50
_MAX_JOURNEY_PATH_LEN = 500
_MAX_JOURNEY_TS_LEN = 40


def _sanitize_journey(entries: list | None) -> list[dict] | None:
    """Normalize the widget's ``journey`` array into a bounded list of dicts.

    Accepts what the widget sends today — ``[{"path": "/services", "ts":
    "2026-07-09T12:00:15Z"}, ...]`` — and drops anything malformed rather
    than raising. Preserves order (matters for the timeline UI). Returns
    ``None`` when the input is empty or every entry was rejected.
    """
    if not entries:
        return None
    cleaned: list[dict] = []
    for raw in entries[:_MAX_JOURNEY_ENTRIES]:
        if not isinstance(raw, dict):
            continue
        path = raw.get("path")
        if not isinstance(path, str):
            continue
        path = path.strip()[:_MAX_JOURNEY_PATH_LEN]
        if not path:
            continue
        entry: dict = {"path": path}
        ts = raw.get("ts")
        if isinstance(ts, str):
            ts_clean = ts.strip()[:_MAX_JOURNEY_TS_LEN]
            if ts_clean:
                entry["ts"] = ts_clean
        cleaned.append(entry)
    return cleaned or None


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
    # Ordered list of ``{"path": "/services", "ts": "2026-07-09T12:00:15Z"}``
    # entries recorded by the widget as the visitor navigated between
    # pages on the host site before opening chat. Optional — omitted for
    # legacy widget builds. Capped server-side to _MAX_JOURNEY_ENTRIES
    # per session to bound row size on high-navigation sites.
    journey: list[dict] | None = None


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

    # Cloudflare sets CF-Connecting-IP to the real visitor IP. Check it first
    # before falling back to X-Forwarded-For (which Nginx rewrites to the
    # Cloudflare datacenter IP) or the loopback address of the proxy connection.
    ip_address = (
        fastapi_request.headers.get("cf-connecting-ip", "").strip()
        or fastapi_request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or fastapi_request.headers.get("x-real-ip", "")
        or (fastapi_request.client.host if fastapi_request.client else "unknown")
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
        # Validate IP format to prevent SSRF via crafted X-Forwarded-For values.
        # Without this, an attacker could inject arbitrary strings (e.g. path
        # traversal, newlines for header injection) into the geolocation URLs.
        ip_address = ip_address.strip()
        try:
            parsed_ip = ipaddress.ip_address(ip_address)
        except ValueError:
            logger.warning("Invalid IP address rejected: %r", ip_address[:100])
            return

        is_local = parsed_ip.is_loopback or parsed_ip.is_private
        if is_local:
            # Local/private IPs are from dev testing or internal health checks —
            # there is no meaningful visitor geolocation to resolve.
            return

        if not ip_address:
            return

        location = None

        # Primary: ipwho.is (10k/month free, HTTPS, no key, no per-second cap).
        try:
            req = urllib.request.Request(
                f"https://ipwho.is/{ip_address}",
                headers={"User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req, timeout=3.0) as response:
                data = json.loads(response.read().decode())
                if data.get("success"):
                    city = data.get("city", "") or ""
                    country = data.get("country", "") or ""
                    if city and country:
                        location = f"{city}, {country} | {ip_address}"
                    elif country:
                        location = f"{country} | {ip_address}"
                else:
                    logger.warning(f"ipwho.is returned failure for {ip_address}: {data.get('message')}")
        except Exception as e1:
            logger.warning(f"ipwho.is failed for {ip_address}: {e1}")

        # Fallback: ipapi.co (~30k/month free, HTTPS, no key).
        if not location:
            try:
                req2 = urllib.request.Request(
                    f"https://ipapi.co/{ip_address}/json/",
                    headers={"User-Agent": "OyeChats/1.0"},
                )
                with urllib.request.urlopen(req2, timeout=3.0) as response2:
                    data2 = json.loads(response2.read().decode())
                    if not data2.get("error"):
                        city = data2.get("city", "") or ""
                        country = data2.get("country_name", "") or ""
                        if city and country:
                            location = f"{city}, {country} | {ip_address}"
                        elif country:
                            location = f"{country} | {ip_address}"
                    else:
                        logger.warning(f"ipapi.co returned error for {ip_address}: {data2.get('reason')}")
            except Exception as e2:
                logger.warning(f"ipapi.co also failed for {ip_address}: {e2}")

        if not location:
            return

        # The ChatSession row is INSERTed by rag_pipeline on the same request
        # that spawned this thread. Geo lookups (200-1000ms) usually finish
        # after the INSERT, but a fast ip-api response can race ahead of it
        # — retry briefly so the resolved value isn't dropped on the floor.
        for _ in range(5):
            with get_session() as session:
                chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
                if chat_session:
                    # Only overwrite the raw "IP: …" stamp left by the request
                    # handler. If something else (manual edit, future resolver)
                    # has already set a richer value, leave it alone.
                    current = chat_session.location or ""
                    if not current or current.startswith("IP:"):
                        chat_session.location = location
                        session.commit()
                        logger.info(f"Background geolocation resolved | session={session_id} | location={location}")
                    return
            time.sleep(0.5)

        logger.warning(f"Background geolocation: session row never appeared | session={session_id}")
    except Exception as e:
        logger.warning(f"Background geolocation failed for session {session_id}: {e}")


_DEFAULT_OFFLINE_MESSAGE = "We're currently away. Please leave a message and we'll get back to you soon."


def _polite_offline_payload(bot: Bot, *, reason: str) -> dict:
    """Build the no-LLM response served when the bot's owner can't take traffic.

    Returns the customer-configured ``offline_message`` (falling back to a
    neutral default) wrapped in a stable schema the widget already knows
    how to render. HTTP 200 is intentional: from the visitor's point of
    view nothing is broken, the team is just away.
    """
    message = (bot.offline_message or "").strip() or _DEFAULT_OFFLINE_MESSAGE
    return {
        "answer": message,
        "status": "service_unavailable",
        "reason": reason,
        "metadata": {
            "service_unavailable": True,
            "offline": True,
            "reason": reason,
        },
    }


def _refund_ai_chat_credit(bot: Bot, cost: int) -> None:
    """Return a previously-charged ``ai_chat`` credit when generation ultimately
    produced no real answer (both LLMs exhausted / mid-stream error). The LLM
    layer never raises — it returns a canned error message — so the credit is
    committed before we know the reply failed; this reverses it.

    Best-effort: a refund failure must never mask the response or the original
    error, so all exceptions are swallowed with a log.
    """
    if cost <= 0:
        return
    from app.services import credit_service

    try:
        with get_session() as db:
            credit_service.refund(
                db,
                bot.client_id,
                cost,
                reference_id=bot.id,
                note="ai_chat generation failed",
                bot_id=credit_service.resolve_bot_ledger_bot_id(bot),
            )
            db.commit()
        logger.info("Refunded ai_chat credit (generation failed) bot_id=%s cost=%s", bot.id, cost)
    except Exception:
        logger.exception("Failed to refund ai_chat credit for bot %s", getattr(bot, "id", "?"))


def _final_metadata_failure_flag(chunk: str) -> bool | None:
    """If ``chunk`` IS a terminal ``FINAL_METADATA`` frame, return its
    ``generation_failed`` flag (bool); otherwise return None.

    The pipeline yields the terminal frame as its own ``\\nFINAL_METADATA:{...}``
    yield, so a genuine frame is exactly the marker (ignoring surrounding
    whitespace) followed by JSON. Answer text that merely *contains* the marker
    mid-sentence is NOT treated as a frame — that's why we require the stripped
    chunk to *start* with the marker rather than searching for it anywhere.
    Combined with the caller taking the LAST frame's flag (the genuine terminal
    frame is always emitted last), a forged mid-stream frame cannot cause a
    spurious refund."""
    stripped = chunk.strip()
    marker = "FINAL_METADATA:"
    if not stripped.startswith(marker):
        return None
    try:
        return bool(json.loads(stripped[len(marker) :].strip()).get("generation_failed"))
    except (ValueError, TypeError, AttributeError):
        return None


@router.post("/chat")
@limiter.limit("30/minute", key_func=key_from_bot_key)
def chat_endpoint(body: ChatRequest, request: Request, bot: Bot = Depends(get_bot_for_chat)):
    """
    RAG Endpoint: Analyzes the question, retrieves relevant documents for the bot,
    and generates a standalone answer.
    Authenticated via X-Bot-Key or X-API-Key (resolves default bot). Owner-preview
    requests (Build Studio: ?preview=true&bot_id=) resolve any owned bot and are free.
    """
    # ── Subscription gate (widget side) ──
    # When the bot owner's trial has expired (or the subscription is
    # otherwise inactive) we return HTTP 200 with the configured offline
    # message instead of a 4xx error. The visitor sees a polite "we're
    # away" reply; nothing on the customer's website breaks. Credits are
    # not deducted on this path.
    owner_status = bot_subscription_status(bot.client_id, subscription_id=getattr(bot, "subscription_id", None))
    if owner_status not in ("trialing", "active", "past_due"):
        logger.info(
            "chat_blocked_inactive_subscription bot_id=%s client_id=%s status=%s",
            bot.id,
            bot.client_id,
            owner_status,
        )
        return _polite_offline_payload(bot, reason=f"subscription_{owner_status}")

    # ── Credit enforcement: must match /chat/stream ──
    # Owner-preview (Build Studio) replies are free — skip deduction entirely.
    is_preview = getattr(bot, "_is_preview", False)
    cost = 0
    if not is_preview:
        from app.services import credit_service

        with get_session() as db:
            cost = credit_service.get_credit_cost(db, "ai_chat")
            try:
                credit_service.check_and_deduct(
                    db,
                    bot.client_id,
                    cost,
                    reason="ai_chat",
                    reference_id=bot.id,
                    bot_id=credit_service.resolve_bot_ledger_bot_id(bot),
                )
                db.commit()
            except credit_service.InsufficientCredits as exc:
                db.rollback()
                raise HTTPException(
                    status_code=402,
                    detail={
                        "error": "insufficient_credits",
                        "required": exc.required,
                        "available": exc.available,
                        "message": "You're out of credits. Upgrade your plan or buy a top-up to keep chatting.",
                    },
                ) from exc
            except credit_service.KillSwitchActive as exc:
                db.rollback()
                raise HTTPException(
                    status_code=503,
                    detail={"error": "billing_paused", "message": "Billing is temporarily paused for maintenance."},
                ) from exc

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
            cta_dimension=body.cta_dimension,
        )

        ans_len = len(result.get("answer", ""))
        logger.info(f"Chat response generated | session={session_id} | answer_length={ans_len}")
        # Refund the credit when the pipeline only produced a canned error
        # message (both LLMs exhausted) — the visitor got no real answer.
        if result.get("generation_failed") and not is_preview:
            _refund_ai_chat_credit(bot, cost)
        return result
    except HTTPException:
        raise
    except SessionOwnershipError:
        raise
    except Exception as e:
        bot_id = getattr(bot, "id", "?")
        err_type = type(e).__name__
        logger.error(f"Chat failed for bot {bot_id}: {err_type}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Chat request failed. Please try again.") from e


def _offline_stream(bot: Bot, reason: str):
    """SSE generator that mirrors the rag-pipeline protocol on the offline path.

    The widget expects ``METADATA:{...}`` → text chunks → ``FINAL_METADATA:{...}``.
    We emit a complete shape here so the widget's parser doesn't fall into
    its error path when the bot is offline — visitor sees the offline
    message rendered like a normal reply.
    """
    import json

    message = (bot.offline_message or "").strip() or _DEFAULT_OFFLINE_MESSAGE
    metadata = {
        "service_unavailable": True,
        "offline": True,
        "reason": reason,
    }
    yield f"METADATA:{json.dumps(metadata)}\n"
    yield message
    yield f"\nFINAL_METADATA:{json.dumps({**metadata, 'answer': message})}\n"


@router.post("/chat/stream")
@limiter.limit("30/minute", key_func=key_from_bot_key)
async def chat_stream_endpoint(body: ChatRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """
    Streaming RAG Endpoint: Streams the response token-by-token via SSE.
    Protocol: METADATA:{json} → text chunks → FINAL_METADATA:{json}
    Authenticated via X-Bot-Key or X-API-Key (resolves default bot).
    """
    # ── Subscription gate (widget side) ──
    # Mirror ``/chat`` — when the bot owner's subscription is inactive,
    # stream the offline message rather than running the RAG pipeline. No
    # credits are deducted; the SSE shape stays the same so the widget
    # renders the message exactly like a normal short reply.
    owner_status = bot_subscription_status(bot.client_id, subscription_id=getattr(bot, "subscription_id", None))
    if owner_status not in ("trialing", "active", "past_due"):
        logger.info(
            "chat_stream_blocked_inactive_subscription bot_id=%s client_id=%s status=%s",
            bot.id,
            bot.client_id,
            owner_status,
        )
        return StreamingResponse(
            _offline_stream(bot, reason=f"subscription_{owner_status}"),
            media_type="text/event-stream",
        )

    # ── Credit enforcement: deduct 1 credit per AI reply (configurable) ──
    from app.services import credit_service

    with get_session() as db:
        cost = credit_service.get_credit_cost(db, "ai_chat")
        try:
            credit_service.check_and_deduct(
                db,
                bot.client_id,
                cost,
                reason="ai_chat",
                reference_id=bot.id,
                bot_id=credit_service.resolve_bot_ledger_bot_id(bot),
            )
            db.commit()
        except credit_service.InsufficientCredits as exc:
            db.rollback()
            raise HTTPException(
                status_code=402,
                detail={
                    "error": "insufficient_credits",
                    "required": exc.required,
                    "available": exc.available,
                    "message": "You're out of credits. Upgrade your plan or buy a top-up to keep chatting.",
                },
            ) from exc
        except credit_service.KillSwitchActive as exc:
            db.rollback()
            raise HTTPException(
                status_code=503,
                detail={"error": "billing_paused", "message": "Billing is temporarily paused for maintenance."},
            ) from exc

    ip_address, formatted_device = _parse_request_context(request)
    location = f"IP: {ip_address}"
    session_id = _resolve_session_id(body.session_id, bot.id)

    # Fire-and-forget geolocation
    submit_background(_resolve_and_update_location, session_id, ip_address)

    logger.info(f"Chat stream request | bot_id={bot.id} | bot_name={bot.name} | session={session_id}")

    async def _stream_with_refund():
        """Proxy the RAG stream and, once it finishes, refund the credit if the
        terminal FINAL_METADATA frame flagged a failed generation (both LLMs
        exhausted / mid-stream error). A client disconnect before that frame
        cancels this generator and skips the refund — correct, since we never
        confirmed a failed reply and must never over-refund a delivered one."""
        generation_failed = False
        async for chunk in rag_pipeline_stream(
            bot,
            body.question,
            session_id=session_id,
            location=location,
            device=formatted_device,
            bot_id=bot.id,
            cta_dimension=body.cta_dimension,
        ):
            if isinstance(chunk, str):
                flag = _final_metadata_failure_flag(chunk)
                if flag is not None:
                    # Last genuine terminal frame wins; the real one is emitted
                    # last, so it overrides any earlier (even forged) frame.
                    generation_failed = flag
            yield chunk
        if generation_failed:
            _refund_ai_chat_credit(bot, cost)

    return StreamingResponse(_stream_with_refund(), media_type="text/event-stream")


@router.post("/chat/lead-capture")
@limiter.limit("10/minute", key_func=key_from_bot_key)
def lead_capture_endpoint(body: LeadCaptureRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Capture lead contact info from pre-chat or handoff form. Auth: X-Bot-Key."""
    from app.services.plan_entitlements_service import is_lead_source_attribution_enabled

    try:
        with get_session() as session:
            chat_session = ensure_chat_session(session, body.session_id, bot_id=bot.id)

            # Snapshot UTM + visitor_journey onto the lead row only when the
            # owning client's plan includes Lead Source Attribution. Free /
            # Starter clients still get their lead captured (with contact
            # info) — they just don't get the durable per-lead attribution
            # copy that Standard / Enterprise clients see in the Leads UI.
            utm_snapshot: dict | None = None
            journey_snapshot: list | None = None
            if bot.client_id and is_lead_source_attribution_enabled(bot.client_id, session):
                utm_snapshot = chat_session.utm_params or None
                journey_snapshot = chat_session.visitor_journey or None

            create_or_update_lead_info(
                session,
                session_id=body.session_id,
                bot_id=bot.id,
                name=body.name,
                email=body.email,
                phone=body.phone,
                company=body.company,
                utm_params=utm_snapshot,
                visitor_journey=journey_snapshot,
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
    except SessionOwnershipError:
        raise
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
            chat_session = ensure_chat_session(session, body.session_id, bot_id=bot.id)

            # Store page context on the session (first call wins for URL/referrer)
            safe_page_url = _sanitize_url(body.page_url)
            if safe_page_url and not chat_session.page_url:
                chat_session.page_url = safe_page_url
            safe_referrer = _sanitize_url(body.referrer)
            if safe_referrer and not chat_session.referrer:
                chat_session.referrer = safe_referrer
            if body.utm_params and not chat_session.utm_params:
                chat_session.utm_params = body.utm_params

            # First non-empty journey wins so an intermittent widget resend
            # (e.g. tab regain focus) never overwrites the earlier "before
            # they opened chat" navigation history with just the last hop.
            safe_journey = _sanitize_journey(body.journey)
            if safe_journey and not chat_session.visitor_journey:
                chat_session.visitor_journey = safe_journey

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
    except SessionOwnershipError:
        # Let the global handler turn this into a clean 404 — don't mask as 500.
        raise
    except IntegrityError as e:
        # Two near-simultaneous widget requests for a brand-new session_id can
        # race on the chat_sessions PK insert. ``ensure_chat_session`` retries
        # internally, but the retry's re-SELECT can still miss the winner if its
        # commit isn't yet visible. Behavioral signals are idempotent from the
        # widget's perspective — losing one signal is harmless and far better
        # than 500ing, which makes the widget retry and amplifies the race.
        logger.warning(f"Behavioral signals race ignored | bot={bot.id} session={body.session_id} | {e.orig}")
        return {"success": True, "behavioral_score": None}
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
    except SessionOwnershipError:
        raise
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
    # Dual auth: try client/operator first, fall back to bot key (widget).
    # Only fall back to bot-key when NO admin auth headers were provided.
    # If admin headers are present but invalid, propagate the error —
    # otherwise a deactivated operator with a valid bot key could still
    # read chat history by triggering the silent fallback.
    auth = None
    resolved_bot_id = bot_id
    has_admin_auth = bool(
        request.headers.get("X-API-Key") or request.headers.get("X-Operator-Key") or request.headers.get("X-Agent-Key")
    )
    if has_admin_auth:
        auth = get_current_client_or_operator(
            api_key=request.headers.get("X-API-Key"),
            operator_key=request.headers.get("X-Operator-Key"),
            legacy_agent_key=request.headers.get("X-Agent-Key"),
        )
    else:
        raw_bot_key = request.headers.get("X-Bot-Key")
        if not raw_bot_key:
            raise HTTPException(status_code=401, detail="Authentication required")
        with get_session() as db:
            bot_obj = db.execute(
                select(Bot).where(Bot.bot_key == raw_bot_key, Bot.is_active.is_(True))
            ).scalar_one_or_none()
            if not bot_obj:
                raise HTTPException(status_code=401, detail="Invalid bot key")
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
                    "feedback": m.feedback if hasattr(m, "feedback") else None,
                    # Media-card payloads are the whole reason a bot answer
                    # renders as a video/document card after a refresh. Return
                    # them alongside content so the widget hydrates cards
                    # from history the same way it does from a live stream.
                    "media_card": getattr(m, "media_card", None),
                    "media_secondary": getattr(m, "media_secondary", None),
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
    session_id: str  # must belong to the authenticated bot


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

    # Anti-abuse: bind the presigned CDN upload to a real chat session that
    # belongs to THIS bot. The bot key is public, so without this anyone could
    # mint upload URLs and host arbitrary content on cdn.oyechats.com under a
    # victim's key. Requiring a bot-owned session ties the capability to an
    # actual conversation (and enables per-session cleanup/accounting later).
    with get_session() as session:
        owned_session = session.execute(
            select(ChatSession.id).where(
                ChatSession.id == body.session_id,
                ChatSession.bot_id == bot.id,
            )
        ).scalar_one_or_none()
    if not owned_session:
        raise HTTPException(status_code=404, detail="Chat session not found.")

    safe_name = body.filename.replace("/", "").replace("\\", "")[:100]
    ext = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else "bin"
    key = f"chat-files/{uuid.uuid4()}.{ext}"

    from app.services.r2_service import _build_public_url, generate_presigned_post

    # Presigned POST (not PUT) so R2 enforces the 10 MB ceiling via the policy's
    # content-length-range — the request-body ``size`` is otherwise only
    # advisory and a holder of a presigned PUT could store an arbitrary-size
    # object on the public CDN.
    presigned = generate_presigned_post(key, body.content_type, _MAX_SIZE_BYTES)
    file_url = _build_public_url(key)
    return {"upload_url": presigned["url"], "fields": presigned["fields"], "file_url": file_url, "key": key}


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

        # Anti-exfiltration: recipient_email is visitor-typed free text, so on
        # its own a leaked session_id would let anyone mail another visitor's
        # conversation to an arbitrary inbox. When the session has a captured
        # lead email, the transcript may only be sent to THAT address. Sessions
        # with no lead on file keep the anonymous self-send flow (there is no
        # identity to protect beyond the session_id itself).
        lead = get_lead_info_by_session(session, body.session_id)
        lead_email = (getattr(lead, "email", None) or "").strip().lower()
        if lead_email and body.recipient_email.strip().lower() != lead_email:
            raise HTTPException(
                status_code=403,
                detail="This transcript can only be sent to the email on file for this chat.",
            )

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


# ──────────────────────────────────────────────────────────────────────────────
# Operator → visitor connect-request consent flow
#
# Operator initiates via /operators/connect-request/{session_id}; the visitor
# widget polls the GET endpoint below to discover the pending invite and posts
# back yes/no. On accept the session transitions to live chat and the operator
# is assigned. On decline (or expiry) the session keeps chatting with the AI.
# ──────────────────────────────────────────────────────────────────────────────


class ConnectRequestResponseBody(PydanticBaseModel):
    accepted: bool
    request_id: str | None = None  # optional — extra guard against stale popups


@router.get("/chat/connect-request/{session_id}")
def get_pending_connect_request(session_id: str, bot: Bot = Depends(get_current_bot)):
    """Widget polls this while in bot mode to discover operator-initiated
    connect invitations. Returns ``{ pending: false }`` when none.

    Auth: ``X-Bot-Key`` (visitor widget). The session must belong to the bot.
    """
    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            return {"pending": False}
        if chat_session.bot_id != bot.id:
            raise HTTPException(status_code=403, detail="Access denied")

    from app.services.live_chat_service import manager as live_manager

    # Widget polls this every 5s while in bot mode — perfect signal for
    # "visitor is still on the page chatting with the AI". We piggyback the
    # heartbeat here so we don't need a second endpoint for presence.
    live_manager.record_bot_session_activity(session_id)

    req = live_manager.get_connect_request(session_id)
    if not req:
        return {"pending": False}
    return {
        "pending": True,
        "request_id": req["request_id"],
        "operator_name": req["operator_name"],
        "expires_at": req["expires_at"],
    }


@router.post("/chat/connect-request/{session_id}/respond")
async def respond_to_connect_request(
    session_id: str,
    body: ConnectRequestResponseBody,
    bot: Bot = Depends(get_current_bot),
):
    """Visitor accepts or declines an operator's connect-request.

    On accept we atomically promote the session to live chat and assign it to
    the requesting operator. On decline (or stale ``request_id``) we just
    consume the pending entry — the bot conversation continues unchanged.
    """
    from sqlalchemy import update as sa_update

    from app.db.models import ChatAuditLog, Operator
    from app.services.live_chat_service import manager as live_manager

    pending = live_manager.get_connect_request(session_id)
    if not pending:
        return {"ok": True, "result": "expired"}

    # Optional request_id guard — protects against an old popup the visitor
    # left open while the operator already cancelled & re-issued.
    if body.request_id and body.request_id != pending["request_id"]:
        return {"ok": True, "result": "stale"}

    with get_session() as session:
        chat_session = session.execute(select(ChatSession).where(ChatSession.id == session_id)).scalar_one_or_none()
        if not chat_session:
            live_manager.clear_connect_request(session_id)
            raise HTTPException(status_code=404, detail="Session not found")
        if chat_session.bot_id != bot.id:
            raise HTTPException(status_code=403, detail="Access denied")

        operator_id = pending["operator_id"]
        operator_name = pending["operator_name"]
        operator = session.execute(select(Operator).where(Operator.id == operator_id)).scalar_one_or_none()
        if not operator or operator.client_id != bot.client_id:
            # Operator was removed mid-flight — clear the request and bail out.
            live_manager.clear_connect_request(session_id)
            await live_manager.notify_connect_request_resolved(operator_id, session_id, "expired", visitor_name=None)
            return {"ok": True, "result": "expired"}

        if not body.accepted:
            live_manager.clear_connect_request(session_id)
            lead = get_lead_info_by_session(session, session_id)
            visitor_name = (lead.name if lead else None) or "Visitor"
            session.add(
                ChatAuditLog(
                    session_id=session_id,
                    operator_id=operator_id,
                    action="connect_declined",
                )
            )
            session.commit()
            await live_manager.notify_connect_request_resolved(
                operator_id, session_id, "declined", visitor_name=visitor_name
            )
            return {"ok": True, "result": "declined"}

        # Accept path — must be a bot session AND still in bot status.
        if chat_session.status != "bot":
            live_manager.clear_connect_request(session_id)
            await live_manager.notify_connect_request_resolved(operator_id, session_id, "expired")
            return {"ok": True, "result": "expired"}

        claimed = session.execute(
            sa_update(ChatSession)
            .where(ChatSession.id == session_id, ChatSession.status == "bot")
            .values(status="live", assigned_operator_id=operator_id)
            .returning(ChatSession.id)
        ).scalar_one_or_none()
        if not claimed:
            live_manager.clear_connect_request(session_id)
            await live_manager.notify_connect_request_resolved(operator_id, session_id, "expired")
            return {"ok": True, "result": "expired"}

        session.add(
            ChatAuditLog(
                session_id=session_id,
                operator_id=operator_id,
                action="connect_accepted",
            )
        )

        lead = get_lead_info_by_session(session, session_id)
        visitor_name = (lead.name if lead else None) or "Visitor"
        department_id = chat_session.department_id
        session.commit()

    live_manager.clear_connect_request(session_id)
    live_manager._session_metadata[session_id] = {
        "name": visitor_name,
        "reason": "Connect-request accepted by visitor",
    }
    if department_id is not None:
        live_manager._session_departments[session_id] = department_id

    accepted_ok = await live_manager.accept_chat(session_id, operator_id, operator_name)
    if not accepted_ok:
        logger.warning(
            "DB accepted connect-request for %s → operator %s but manager rejected it. "
            "DB is authoritative — proceeding.",
            session_id,
            operator_id,
        )

    await live_manager.notify_connect_request_resolved(operator_id, session_id, "accepted", visitor_name=visitor_name)

    # Refresh the operator console's qualified-bot list — this session has
    # been removed from the "still chatting with AI" pool.
    import asyncio as _asyncio

    _asyncio.create_task(live_manager.broadcast_qualified_bot_changed(bot.client_id, session_id))

    return {
        "ok": True,
        "result": "accepted",
        "operator_name": operator_name,
        "visitor_name": visitor_name,
    }
