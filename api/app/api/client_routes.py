import logging

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, field_validator

from app.api.auth import get_current_client
from app.db.models import Bot, Client
from app.db.session import get_session
from app.schemas.client import ClientSettingsUpdate

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/client", tags=["client"])


@router.get("/settings")
def get_client_settings(
    request: Request,
    bot_id: int | None = Query(None),
    client: Client = Depends(get_current_client),
):
    """Retrieve chatbot customization settings."""
    with get_session() as session:
        if bot_id:
            bot_db = session.query(Bot).filter(Bot.id == bot_id, Bot.client_id == client.id).first()
        else:
            bot_db = session.query(Bot).filter(Bot.client_id == client.id).order_by(Bot.id).first()

        if not bot_db:
            client_db = session.query(Client).get(client.id)
            return {
                "bot_name": getattr(client_db, "bot_name", "AI Assistant"),
                "bot_logo": getattr(client_db, "bot_logo", None),
                "launcher_name": getattr(client_db, "launcher_name", "Have Questions?"),
                "launcher_logo": getattr(client_db, "launcher_logo", None),
                "primary_color": getattr(client_db, "primary_color", "#ba68c8"),
                "background_color": getattr(client_db, "background_color", "#ffffff"),
                "header_color": getattr(client_db, "header_color", "#3A0CA3"),
                "recommended_colors": getattr(client_db, "recommended_colors", []) or [],
            }

        logo_url = None
        if bot_db.bot_logo:
            if bot_db.bot_logo.startswith("http"):
                logo_url = bot_db.bot_logo
            else:
                logo_url = f"{str(request.base_url).rstrip('/')}/files/{bot_db.bot_logo}"

        launcher_logo_url = None
        if bot_db.launcher_logo:
            if bot_db.launcher_logo.startswith("http"):
                launcher_logo_url = bot_db.launcher_logo
            else:
                launcher_logo_url = f"{str(request.base_url).rstrip('/')}/files/{bot_db.launcher_logo}"

        return {
            "bot_name": bot_db.name,
            "bot_logo": logo_url,
            "launcher_name": bot_db.launcher_name or "Have Questions?",
            "launcher_logo": launcher_logo_url,
            "primary_color": bot_db.primary_color or "#ba68c8",
            "background_color": bot_db.background_color or "#ffffff",
            "header_color": bot_db.header_color or "#3A0CA3",
            "recommended_colors": bot_db.recommended_colors or [],
        }


@router.patch("/settings")
def update_client_settings(
    request: ClientSettingsUpdate,
    bot_id: int | None = Query(None),
    client: Client = Depends(get_current_client),
):
    """Update chatbot customization settings."""
    try:
        with get_session() as session:
            if bot_id:
                bot_db = session.query(Bot).filter(Bot.id == bot_id, Bot.client_id == client.id).first()
            else:
                bot_db = session.query(Bot).filter(Bot.client_id == client.id).order_by(Bot.id).first()

            if not bot_db:
                raise HTTPException(status_code=404, detail="Bot not found")

            update_data = request.dict(exclude_unset=True)

            if "bot_logo" in update_data:
                update_data["launcher_logo"] = update_data["bot_logo"]
            elif "launcher_logo" in update_data:
                update_data["bot_logo"] = update_data["launcher_logo"]

            field_mapping = {"bot_name": "name"}

            for key, value in update_data.items():
                bot_key = field_mapping.get(key, key)
                if hasattr(bot_db, bot_key):
                    if (bot_key in ("bot_logo", "launcher_logo")) and value and "/files/" in value:
                        value = value.split("/files/")[-1]
                    setattr(bot_db, bot_key, value)

            session.commit()
            return {"message": "Settings updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update settings: {e}")
        raise HTTPException(status_code=500, detail="Failed to update settings.") from e


class PlatformFeedbackCreate(BaseModel):
    message: str
    attachment_url: str | None = None
    category: str | None = None

    @field_validator("message")
    @classmethod
    def message_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("message must not be empty")
        if len(v) > 5000:
            raise ValueError("message must be 5000 characters or fewer")
        return v


@router.post("/feedback", status_code=201)
def submit_platform_feedback(
    body: PlatformFeedbackCreate,
    client: Client = Depends(get_current_client),
):
    """Save free-text feedback from an admin dashboard user."""
    try:
        from app.db.repository import save_platform_feedback

        with get_session() as session:
            save_platform_feedback(
                session,
                client_id=client.id,
                message=body.message,
                attachment_url=body.attachment_url,
                category=body.category,
            )
        return {"ok": True}
    except Exception as e:
        logger.error(f"Failed to save platform feedback: {e}")
        raise HTTPException(status_code=500, detail="Failed to save feedback.") from e


@router.get("/feedback")
def list_my_feedback(client: Client = Depends(get_current_client)):
    """List the logged-in client's own platform feedback, newest first.

    Includes the resolution ``status`` and the superadmin's ``admin_response``
    so the customer can see that their issue was handled.
    """
    try:
        from app.db.repository import get_client_platform_feedback

        with get_session() as session:
            return get_client_platform_feedback(session, client_id=client.id)
    except Exception as e:
        logger.error(f"Failed to fetch client feedback: {e}")
        raise HTTPException(status_code=500, detail="Failed to load feedback.") from e


@router.post("/feedback/upload")
async def upload_feedback_attachment(
    request: Request,
    file: UploadFile = File(...),
    client: Client = Depends(get_current_client),
):
    """Upload a feedback attachment (max 10MB) to R2 and return the URL."""
    # Max file size: 10MB
    MAX_SIZE = 10 * 1024 * 1024
    try:
        content = await file.read()
        if len(content) > MAX_SIZE:
            raise HTTPException(status_code=400, detail="File size exceeds the 10MB limit.")

        from app.services.r2_service import upload_chat_file

        file_key = upload_chat_file(content, file.filename, file.content_type)
        public_url = f"{str(request.base_url).rstrip('/')}/files/{file_key}"

        return {"url": public_url}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Feedback attachment upload failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload attachment.") from e


@router.post("/upload-logo")
async def upload_logo_endpoint(
    request: Request,
    file: UploadFile = File(...),
    bot_id: int | None = Query(None),
    client: Client = Depends(get_current_client),
):
    """Upload a logo to Backblaze B2 and return the URL."""
    try:
        from app.services.r2_service import upload_to_b2

        content = await file.read()
        file_key = upload_to_b2(content, file.filename, file.content_type)
        public_url = f"{str(request.base_url).rstrip('/')}/files/{file_key}"

        return {"url": public_url}
    except Exception as e:
        logger.error(f"Logo upload failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload logo.") from e
