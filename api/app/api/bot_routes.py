import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.auth import get_current_bot, get_current_client
from app.db.models import Bot, Client
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bots", tags=["bots"])


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
    bant_enabled: bool | None = None
    avatar_type: str | None = None
    orb_color: str | None = None


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
    bant_enabled: bool
    avatar_type: str
    orb_color: str | None
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
        "bant_enabled": bot.bant_enabled,
        "avatar_type": bot.avatar_type or "upload",
        "orb_color": bot.orb_color,
    }


@router.get("", response_model=list[BotResponse])
def list_bots(request: Request, client: Client = Depends(get_current_client)):
    """List all bots for the authenticated client."""
    with get_session() as session:
        stmt = select(Bot).where(Bot.client_id == client.id).order_by(Bot.id)
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
                    bant_enabled=b.bant_enabled,
                    avatar_type=b.avatar_type or "upload",
                    orb_color=b.orb_color,
                    is_active=b.is_active,
                    created_at=b.created_at.isoformat() if b.created_at else "",
                )
            )
        return bots_response


@router.post("", status_code=201)
def create_bot(request: CreateBotRequest, client: Client = Depends(get_current_client)):
    """Create a new bot for the authenticated client. Enforces max_bots limit."""
    with get_session() as session:
        # Check limit
        count = session.execute(select(Bot.id).where(Bot.client_id == client.id)).all()
        max_bots = getattr(client, "max_bots", 1) or 1
        if len(count) >= max_bots:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Bot limit reached ({max_bots}). Upgrade your plan to create more bots.",
            )

        new_bot = Bot(
            client_id=client.id,
            bot_key=f"bot-{uuid.uuid4().hex[:12]}",
            name=request.name.strip() if request.name else "AI Assistant",
            website=request.website,
            system_prompt=request.system_prompt,
            bant_enabled=request.bant_enabled,
        )
        session.add(new_bot)
        session.commit()
        session.refresh(new_bot)

        logger.info(f"Client {client.id} created bot {new_bot.id} ({new_bot.name})")

        return {
            "message": "Bot created successfully",
            "bot_id": new_bot.id,
            "bot_key": new_bot.bot_key,
            "name": new_bot.name,
        }


@router.get("/{bot_id}")
def get_bot(bot_id: int, request: Request, client: Client = Depends(get_current_client)):
    """Get details of a specific bot owned by the authenticated client."""
    with get_session() as session:
        stmt = select(Bot).where(Bot.id == bot_id, Bot.client_id == client.id)
        bot = session.execute(stmt).scalars().first()
        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found.")
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
            bant_enabled=bot.bant_enabled,
            avatar_type=bot.avatar_type or "upload",
            orb_color=bot.orb_color,
            is_active=bot.is_active,
            created_at=bot.created_at.isoformat() if bot.created_at else "",
        )


@router.patch("/{bot_id}")
def update_bot(bot_id: int, request: UpdateBotRequest, client: Client = Depends(get_current_client)):
    """Update settings for a specific bot."""
    try:
        with get_session() as session:
            stmt = select(Bot).where(Bot.id == bot_id, Bot.client_id == client.id)
            bot = session.execute(stmt).scalars().first()
            if not bot:
                raise HTTPException(status_code=404, detail="Bot not found.")

            update_data = request.dict(exclude_unset=True)
            logger.info(f"Updating bot {bot_id} | fields: {list(update_data.keys())}")

            # Sync logos
            if "bot_logo" in update_data:
                update_data["launcher_logo"] = update_data["bot_logo"]
            elif "launcher_logo" in update_data:
                update_data["bot_logo"] = update_data["launcher_logo"]

            for key, value in update_data.items():
                setattr(bot, key, value)

            session.commit()
            logger.info(f"Bot {bot_id} settings saved successfully by client {client.id}")
            return {"message": "Bot settings updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update bot {bot_id}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to save settings: {str(e)}") from e


@router.delete("/{bot_id}")
def delete_bot(bot_id: int, client: Client = Depends(get_current_client)):
    """Delete a bot and all its data (documents, sessions, messages)."""
    with get_session() as session:
        stmt = select(Bot).where(Bot.id == bot_id, Bot.client_id == client.id)
        bot = session.execute(stmt).scalars().first()
        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found.")

        # Don't allow deleting the last bot
        total_bots = len(session.execute(select(Bot.id).where(Bot.client_id == client.id)).all())
        if total_bots <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete your only bot. Create another one first."
            )

        session.delete(bot)
        session.commit()
        logger.info(f"Bot {bot_id} deleted by client {client.id}")
        return {"message": "Bot deleted successfully"}
