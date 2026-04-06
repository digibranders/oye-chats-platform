import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from app.api.auth import get_current_bot, get_current_client_or_operator
from app.db.models import Bot
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bots", tags=["bots"])


def _get_workspace_bot(session, bot_id: int, client_id: int) -> Bot:
    bot = session.execute(select(Bot).where(Bot.id == bot_id, Bot.client_id == client_id)).scalars().first()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found.")
    return bot


def _require_bot_management_access(auth: dict) -> None:
    """Allow workspace owners/admins to manage bots while keeping regular agents read-only."""
    if auth["type"] == "client":
        return

    if getattr(auth["entity"], "role", "operator") not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="You do not have permission to manage bots.")


# ── Request / Response Models ──


class CreateBotRequest(BaseModel):
    name: str = "AI Assistant"
    website: str | None = None
    system_prompt: str | None = None
    bant_enabled: bool = True


class UpdateBotRequest(BaseModel):
    name: str | None = None
    system_prompt: str | None = None
    website: str | None = None
    bot_logo: str | None = None
    launcher_name: str | None = None
    launcher_logo: str | None = None
    primary_color: str | None = None
    background_color: str | None = None
    header_color: str | None = None
    user_bubble_color: str | None = None
    bant_enabled: bool | None = None
    bant_config: dict | None = None
    avatar_type: str | None = None
    orb_color: str | None = None
    # Lead form settings
    lead_form_enabled: bool | None = None
    lead_form_fields: list[dict] | None = None
    # Email notification settings
    notification_email: str | None = None
    email_on_qualified: bool | None = None
    email_on_handoff: bool | None = None
    # Live chat settings
    live_chat_enabled: bool | None = None
    operator_timeout_seconds: int | None = None
    # Business hours
    business_hours: dict | None = None
    # Feature flags — partial merge applied on PATCH (existing flags are preserved)
    feature_flags: dict | None = None
    # Configurable visitor-facing messages
    welcome_title: str | None = None
    welcome_subtitle: str | None = None
    waiting_message: str | None = None
    offline_message: str | None = None
    handoff_delay_seconds: int | None = None


class BotResponse(BaseModel):
    id: int
    bot_key: str
    name: str
    website: str | None
    system_prompt: str | None
    bot_logo: str | None
    launcher_name: str
    launcher_logo: str | None
    primary_color: str
    background_color: str
    header_color: str
    recommended_colors: list | None
    user_bubble_color: str = "#DBE9FF"
    bant_enabled: bool
    bant_config: dict | None = None
    avatar_type: str
    orb_color: str | None
    lead_form_enabled: bool = False
    lead_form_fields: list[dict] | None = None
    notification_email: str | None = None
    email_on_qualified: bool = True
    email_on_handoff: bool = True
    live_chat_enabled: bool = True
    operator_timeout_seconds: int = 120
    business_hours: dict | None = None
    feature_flags: dict = {}
    # Configurable visitor-facing messages
    welcome_title: str = "Hi there 👋"
    welcome_subtitle: str = "How can we help you today?"
    waiting_message: str = "Connecting you to support..."
    offline_message: str = "Our team is currently unavailable."
    handoff_delay_seconds: int = 0
    is_active: bool
    created_at: str

    class Config:
        from_attributes = True


# ── Endpoints ──

# IMPORTANT: Static sub-paths MUST be defined before /{bot_id} dynamic routes
# to prevent FastAPI from trying to parse "settings" as an integer bot_id.


@router.get("/settings/public")
def get_bot_settings_public(request: Request, bot: Bot = Depends(get_current_bot)):
    """
    Public endpoint for the widget to fetch bot settings.
    Authenticated via X-Bot-Key or X-API-Key (backward compat).
    """
    # Construct backend file URL for relative logos
    logo_url = bot.bot_logo
    if logo_url and not logo_url.startswith("http"):
        logo_url = f"{str(request.base_url).rstrip('/')}/files/{logo_url}"

    launcher_logo_url = bot.launcher_logo
    if launcher_logo_url and not launcher_logo_url.startswith("http"):
        launcher_logo_url = f"{str(request.base_url).rstrip('/')}/files/{launcher_logo_url}"

    return {
        "bot_name": bot.name,
        "bot_logo": logo_url,
        "launcher_name": bot.launcher_name or "Have Questions?",
        "launcher_logo": launcher_logo_url,
        "primary_color": bot.primary_color or "#ba68c8",
        "background_color": bot.background_color or "#ffffff",
        "header_color": bot.header_color or "#3A0CA3",
        "recommended_colors": bot.recommended_colors or [],
        "user_bubble_color": bot.user_bubble_color or "#DBE9FF",
        "bant_enabled": bot.bant_enabled,
        "avatar_type": bot.avatar_type or "upload",
        "orb_color": bot.orb_color,
        "lead_form_enabled": bot.lead_form_enabled,
        "lead_form_fields": bot.lead_form_fields,
        "live_chat_enabled": bot.live_chat_enabled,
        "business_hours": bot.business_hours,
        "feature_flags": bot.feature_flags or {},
        "welcome_title": bot.welcome_title or "Hi there 👋",
        "welcome_subtitle": bot.welcome_subtitle or "How can we help you today?",
        "waiting_message": bot.waiting_message or "Connecting you to support...",
        "offline_message": bot.offline_message or "Our team is currently unavailable.",
        "handoff_delay_seconds": bot.handoff_delay_seconds or 0,
        "bant_cta_options": _build_public_cta_options(bot),
    }


def _build_public_cta_options(bot) -> dict:
    """Build sanitized CTA options for the widget (no scoring rubric exposed)."""
    from app.services.lead_service import get_bant_config

    config = get_bant_config(bot)
    cta_options = {}
    for dim in ["need", "timeline", "authority", "budget"]:
        dim_config = config.get(dim, {})
        if dim_config.get("cta_enabled", False):
            cta_options[dim] = {
                "prompt": dim_config.get("cta_prompt", ""),
                "options": [o["label"] for o in dim_config.get("options", [])],
            }
    return cta_options


@router.get("", response_model=list[BotResponse])
def list_bots(request: Request, auth=Depends(get_current_client_or_operator)):
    """List all bots for the authenticated client or agent's client."""
    client_id = auth["client_id"]
    with get_session() as session:
        stmt = select(Bot).where(Bot.client_id == client_id).order_by(Bot.id)
        bots = session.execute(stmt).scalars().all()
        bots_response = []
        for b in bots:
            bl = b.bot_logo
            if bl and not bl.startswith("http"):
                bl = f"{str(request.base_url).rstrip('/')}/files/{bl}"
            ll = b.launcher_logo
            if ll and not ll.startswith("http"):
                ll = f"{str(request.base_url).rstrip('/')}/files/{ll}"

            bots_response.append(
                BotResponse(
                    id=b.id,
                    bot_key=b.bot_key,
                    name=b.name,
                    website=b.website,
                    system_prompt=b.system_prompt,
                    bot_logo=bl,
                    launcher_name=b.launcher_name or "Have Questions?",
                    launcher_logo=ll,
                    primary_color=b.primary_color or "#ba68c8",
                    background_color=b.background_color or "#ffffff",
                    header_color=b.header_color or "#3A0CA3",
                    recommended_colors=b.recommended_colors or [],
                    user_bubble_color=b.user_bubble_color or "#DBE9FF",
                    bant_enabled=b.bant_enabled,
                    bant_config=b.bant_config,
                    avatar_type=b.avatar_type or "upload",
                    orb_color=b.orb_color,
                    lead_form_enabled=b.lead_form_enabled,
                    lead_form_fields=b.lead_form_fields,
                    notification_email=b.notification_email,
                    email_on_qualified=b.email_on_qualified,
                    email_on_handoff=b.email_on_handoff,
                    live_chat_enabled=b.live_chat_enabled,
                    operator_timeout_seconds=b.operator_timeout_seconds,
                    business_hours=b.business_hours,
                    feature_flags=b.feature_flags or {},
                    welcome_title=b.welcome_title or "Hi there 👋",
                    welcome_subtitle=b.welcome_subtitle or "How can we help you today?",
                    waiting_message=b.waiting_message or "Connecting you to support...",
                    offline_message=b.offline_message or "Our team is currently unavailable.",
                    handoff_delay_seconds=b.handoff_delay_seconds or 0,
                    is_active=b.is_active,
                    created_at=b.created_at.isoformat() if b.created_at else "",
                )
            )
        return bots_response


@router.post("", status_code=201)
def create_bot(request: CreateBotRequest, auth=Depends(get_current_client_or_operator)):
    """Create a new bot for the authenticated workspace."""
    _require_bot_management_access(auth)
    with get_session() as session:
        new_bot = Bot(
            client_id=auth["client_id"],
            bot_key=f"bot-{uuid.uuid4().hex[:12]}",
            name=request.name.strip() if request.name else "AI Assistant",
            website=request.website,
            system_prompt=request.system_prompt,
            bant_enabled=request.bant_enabled,
        )
        session.add(new_bot)
        session.commit()
        session.refresh(new_bot)

        logger.info(f"Workspace {auth['client_id']} created bot {new_bot.id} ({new_bot.name})")

        return {
            "message": "Bot created successfully",
            "bot_id": new_bot.id,
            "bot_key": new_bot.bot_key,
            "name": new_bot.name,
        }


@router.get("/{bot_id}")
def get_bot(bot_id: int, request: Request, auth=Depends(get_current_client_or_operator)):
    """Get details of a specific bot owned by the authenticated workspace."""
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        bl = bot.bot_logo
        if bl and not bl.startswith("http"):
            bl = f"{str(request.base_url).rstrip('/')}/files/{bl}"
        ll = bot.launcher_logo
        if ll and not ll.startswith("http"):
            ll = f"{str(request.base_url).rstrip('/')}/files/{ll}"

        return BotResponse(
            id=bot.id,
            bot_key=bot.bot_key,
            name=bot.name,
            website=bot.website,
            system_prompt=bot.system_prompt,
            bot_logo=bl,
            launcher_name=bot.launcher_name or "Have Questions?",
            launcher_logo=ll,
            primary_color=bot.primary_color or "#ba68c8",
            background_color=bot.background_color or "#ffffff",
            header_color=bot.header_color or "#3A0CA3",
            recommended_colors=bot.recommended_colors or [],
            user_bubble_color=bot.user_bubble_color or "#DBE9FF",
            bant_enabled=bot.bant_enabled,
            bant_config=bot.bant_config,
            avatar_type=bot.avatar_type or "upload",
            orb_color=bot.orb_color,
            lead_form_enabled=bot.lead_form_enabled,
            lead_form_fields=bot.lead_form_fields,
            notification_email=bot.notification_email,
            email_on_qualified=bot.email_on_qualified,
            email_on_handoff=bot.email_on_handoff,
            live_chat_enabled=bot.live_chat_enabled,
            operator_timeout_seconds=bot.operator_timeout_seconds,
            business_hours=bot.business_hours,
            feature_flags=bot.feature_flags or {},
            welcome_title=bot.welcome_title or "Hi there 👋",
            welcome_subtitle=bot.welcome_subtitle or "How can we help you today?",
            waiting_message=bot.waiting_message or "Connecting you to support...",
            offline_message=bot.offline_message or "Our team is currently unavailable.",
            handoff_delay_seconds=bot.handoff_delay_seconds or 0,
            is_active=bot.is_active,
            created_at=bot.created_at.isoformat() if bot.created_at else "",
        )


@router.patch("/{bot_id}")
def update_bot(bot_id: int, request: UpdateBotRequest, auth=Depends(get_current_client_or_operator)):
    """Update settings for a specific bot."""
    try:
        _require_bot_management_access(auth)
        with get_session() as session:
            bot = _get_workspace_bot(session, bot_id, auth["client_id"])

            update_data = request.dict(exclude_unset=True)
            logger.info(f"Updating bot {bot_id} | fields: {list(update_data.keys())}")

            # Sync logos
            if "bot_logo" in update_data:
                update_data["launcher_logo"] = update_data["bot_logo"]
            elif "launcher_logo" in update_data:
                update_data["bot_logo"] = update_data["launcher_logo"]

            # Merge feature_flags — partial updates must not wipe existing flags
            if "feature_flags" in update_data and update_data["feature_flags"] is not None:
                current_flags = dict(bot.feature_flags or {})
                current_flags.update(update_data.pop("feature_flags"))
                bot.feature_flags = current_flags

            for key, value in update_data.items():
                setattr(bot, key, value)

            session.commit()
            logger.info(f"Bot {bot_id} settings saved successfully by workspace {auth['client_id']}")
            return {"message": "Bot settings updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update bot {bot_id}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save bot settings.") from e


@router.delete("/{bot_id}")
def delete_bot(bot_id: int, auth=Depends(get_current_client_or_operator)):
    """Delete a bot and all its data (documents, sessions, messages)."""
    _require_bot_management_access(auth)
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])

        session.delete(bot)
        session.commit()
        logger.info(f"Bot {bot_id} deleted by workspace {auth['client_id']}")
        return {"message": "Bot deleted successfully"}
