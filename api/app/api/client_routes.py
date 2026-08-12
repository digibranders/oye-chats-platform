import hmac
import logging
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, field_validator
from sqlalchemy import select

from app.api.auth import get_current_client, get_current_client_strict
from app.core.feedback import CONTEXT_KEYS, FEEDBACK_AREAS, FEEDBACK_SEVERITIES, FEEDBACK_TYPES
from app.core.rate_limit import key_from_api_key, limiter
from app.core.security import get_password_hash, verify_password
from app.db.models import Bot, Client
from app.db.session import get_session
from app.schemas.client import ClientSettingsUpdate
from app.services.email_service import send_email_change_otp, send_email_change_requested_notice

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

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
    client: Client = Depends(get_current_client_strict),
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

            # Same stamp as the primary settings patch in `bot_routes`. This
            # legacy route writes the same columns, so leaving it out would let
            # an avatar removal made through it be silently re-derived.
            from app.db.repository import stamp_manual_avatar

            stamp_manual_avatar(bot_db, update_data)

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
    category: str | None = None  # deprecated; kept for back-compat with old clients
    type: str = "other"
    area: str | None = None
    severity: str | None = None
    context: dict | None = None
    attachments: list | None = None

    @field_validator("message")
    @classmethod
    def message_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("message must not be empty")
        if len(v) > 5000:
            raise ValueError("message must be 5000 characters or fewer")
        return v

    @field_validator("type")
    @classmethod
    def type_valid(cls, v: str) -> str:
        if v not in FEEDBACK_TYPES:
            raise ValueError(f"type must be one of: {', '.join(FEEDBACK_TYPES)}")
        return v

    @field_validator("area")
    @classmethod
    def area_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in FEEDBACK_AREAS:
            raise ValueError(f"area must be one of: {', '.join(FEEDBACK_AREAS)}")
        return v

    @field_validator("severity")
    @classmethod
    def severity_valid(cls, v: str | None) -> str | None:
        if v is not None and v not in FEEDBACK_SEVERITIES:
            raise ValueError(f"severity must be one of: {', '.join(FEEDBACK_SEVERITIES)}")
        return v

    @field_validator("context")
    @classmethod
    def context_whitelist(cls, v: dict | None) -> dict | None:
        if not v:
            return None
        # Only persist the known metadata keys; coerce values to short strings.
        cleaned = {k: str(v[k])[:500] for k in CONTEXT_KEYS if v.get(k) is not None}
        return cleaned or None

    @field_validator("attachments")
    @classmethod
    def attachments_normalize(cls, v: list | None) -> list | None:
        if not v:
            return None
        out: list[dict] = []
        for item in v[:10]:  # hard cap to keep the row bounded
            if isinstance(item, str):
                out.append({"url": item})
            elif isinstance(item, dict) and item.get("url"):
                out.append(
                    {
                        "url": str(item["url"]),
                        **({"name": str(item["name"])} if item.get("name") else {}),
                        **({"content_type": str(item["content_type"])} if item.get("content_type") else {}),
                    }
                )
        return out or None


@router.post("/feedback", status_code=201)
def submit_platform_feedback(
    body: PlatformFeedbackCreate,
    client: Client = Depends(get_current_client),
):
    """Save a classified feedback entry from an admin dashboard user."""
    try:
        from app.db.repository import save_platform_feedback

        with get_session() as session:
            save_platform_feedback(
                session,
                client_id=client.id,
                message=body.message,
                attachment_url=body.attachment_url,
                category=body.category,
                type_=body.type,
                area=body.area,
                severity=body.severity,
                context=body.context,
                attachments=body.attachments,
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
    from app.core.upload_guard import read_bounded

    # Bounded read, not read-then-measure: the previous order pulled the whole
    # body into memory and only then objected to its size.
    MAX_SIZE = 10 * 1024 * 1024
    try:
        content = await read_bounded(file, MAX_SIZE)

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
    client: Client = Depends(get_current_client_strict),
):
    """Upload a logo image to R2 and return its URL.

    This endpoint previously read the whole body with no cap and passed
    arbitrary bytes to ``Image.open`` — a decompression-bomb and Pillow-CVE
    surface reachable by any authenticated customer, bounded only by nginx's
    50 MB body limit. Two sibling endpoints already had size and type checks;
    this one had neither.
    """
    from app.core.upload_guard import IMAGE_UPLOAD_TYPES, MAX_LOGO_BYTES, ensure_allowed_type, read_bounded
    from app.services.r2_service import UnsupportedImage, upload_to_b2

    # Cheap rejects first: the declared type costs nothing to check, and the
    # bounded read means an oversized upload never reaches memory in full.
    ensure_allowed_type(file, IMAGE_UPLOAD_TYPES)
    content = await read_bounded(file, MAX_LOGO_BYTES)

    try:
        file_key = upload_to_b2(content, file.filename, file.content_type)
    except UnsupportedImage as e:
        # The customer's file is wrong, not our service — 400, and say why.
        # The declared content type is forgeable, so this is the check that
        # actually decided, having decoded the bytes.
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Logo upload failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload logo.") from e

    public_url = f"{str(request.base_url).rstrip('/')}/files/{file_key}"
    return {"url": public_url}


# ── Account: profile / password / API key ────────────────────────────────────


class ClientProfilePatch(BaseModel):
    name: str | None = None
    company_name: str | None = None
    website: str | None = None

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("Name cannot be empty.")
        return v

    @field_validator("company_name", "website")
    @classmethod
    def clean_optional_str(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        return v or None


@router.patch("/profile")
def update_client_profile(
    body: ClientProfilePatch,
    client: Client = Depends(get_current_client_strict),
):
    """Update the authenticated client's display name, company name, and website.

    Email changes go through /client/change-email/* instead — that flow
    requires the current password and confirms ownership of the new inbox
    via OTP before the login email actually moves.
    """
    with get_session() as session:
        row = session.get(Client, client.id)
        if not row:
            raise HTTPException(status_code=404, detail="Account not found.")

        fields_set = body.dict(exclude_unset=True)

        if "name" in fields_set and body.name:
            row.name = body.name
        if "company_name" in fields_set:
            row.company_name = body.company_name
        if "website" in fields_set:
            row.website = body.website

        session.commit()
        session.refresh(row)
        return {
            "id": row.id,
            "name": row.name,
            "email": row.email,
            "company_name": row.company_name,
            "website": row.website,
            "pending_email": row.pending_email,
        }


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_is_strong(cls, v: str) -> str:
        if len(v) < 8 or not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError("Password must be at least 8 characters and include a letter and a number.")
        return v


@router.post("/change-password")
def change_client_password(
    body: ChangePasswordRequest,
    client: Client = Depends(get_current_client_strict),
):
    """Change the authenticated client's password (verifies the current one)."""
    with get_session() as session:
        row = session.get(Client, client.id)
        if not row:
            raise HTTPException(status_code=404, detail="Account not found.")
        if not verify_password(body.current_password, row.hashed_password or ""):
            raise HTTPException(status_code=400, detail="Current password is incorrect.")
        row.hashed_password = get_password_hash(body.new_password)
        session.commit()
        return {"ok": True}


# ── Account: email change (password-confirmed, OTP-verified) ─────────────────


class ChangeEmailRequest(BaseModel):
    new_email: str
    current_password: str

    @field_validator("new_email")
    @classmethod
    def email_looks_valid(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address.")
        return v


class ChangeEmailConfirm(BaseModel):
    otp: str


@router.post("/change-email/request")
@limiter.limit("5/minute", key_func=key_from_api_key)
def request_client_email_change(
    request: Request,
    body: ChangeEmailRequest,
    client: Client = Depends(get_current_client_strict),
):
    """Start an email change: verify the current password, then OTP-verify the new inbox.

    The login email is NOT updated here — it only moves once
    ``/change-email/confirm`` validates the code sent to ``new_email``. The
    current (old) address also gets a notice, so an attacker who has
    hijacked the session can't quietly redirect account recovery without
    the real owner finding out.
    """
    with get_session() as session:
        row = session.get(Client, client.id)
        if not row:
            raise HTTPException(status_code=404, detail="Account not found.")

        if not verify_password(body.current_password, row.hashed_password or ""):
            raise HTTPException(status_code=400, detail="Current password is incorrect.")

        if body.new_email == (row.email or "").lower():
            raise HTTPException(status_code=400, detail="That's already your current email address.")

        existing = (
            session.execute(select(Client).where(Client.email == body.new_email, Client.id != row.id)).scalars().first()
        )
        if existing:
            raise HTTPException(
                status_code=400,
                detail="An account with this email already exists. Please sign in instead.",
            )

        otp = str(secrets.randbelow(900000) + 100000)
        row.pending_email = body.new_email
        row.email_change_otp = otp
        row.email_change_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
        session.commit()

        try:
            send_email_change_otp(row.pending_email, row.name, otp)
            send_email_change_requested_notice(row.email, row.name, row.pending_email)
        except Exception as mail_err:
            logger.warning("email_change_otp_send_failed for client %s: %s", row.id, mail_err)

        return {"message": "Verification code sent to your new email address.", "pending_email": row.pending_email}


@router.post("/change-email/confirm")
@limiter.limit("10/minute", key_func=key_from_api_key)
def confirm_client_email_change(
    request: Request,
    body: ChangeEmailConfirm,
    client: Client = Depends(get_current_client_strict),
):
    """Verify the OTP sent to the pending new email and promote it to the login email."""
    with get_session() as session:
        row = session.get(Client, client.id)
        if not row:
            raise HTTPException(status_code=404, detail="Account not found.")

        if not row.pending_email or not row.email_change_otp or not row.email_change_otp_expires_at:
            raise HTTPException(status_code=400, detail="No email change is pending.")

        if datetime.now(UTC) > row.email_change_otp_expires_at:
            row.pending_email = None
            row.email_change_otp = None
            row.email_change_otp_expires_at = None
            session.commit()
            raise HTTPException(status_code=400, detail="Verification code has expired. Please request a new one.")

        if not hmac.compare_digest(row.email_change_otp, body.otp.strip()):
            # Invalidate after a wrong guess to prevent brute-force retries.
            row.email_change_otp = None
            row.email_change_otp_expires_at = None
            session.commit()
            raise HTTPException(status_code=400, detail="Invalid code. Please request a new one.")

        row.email = row.pending_email
        row.pending_email = None
        row.email_change_otp = None
        row.email_change_otp_expires_at = None
        session.commit()
        session.refresh(row)
        return {"id": row.id, "name": row.name, "email": row.email, "pending_email": None}


@router.post("/change-email/cancel")
def cancel_client_email_change(client: Client = Depends(get_current_client_strict)):
    """Abandon a pending email change before it's confirmed."""
    with get_session() as session:
        row = session.get(Client, client.id)
        if not row:
            raise HTTPException(status_code=404, detail="Account not found.")
        row.pending_email = None
        row.email_change_otp = None
        row.email_change_otp_expires_at = None
        session.commit()
        return {"ok": True}


def _mask_key(key: str | None) -> str:
    return ("••••••" + key[-4:]) if key else "—"


@router.get("/api-key")
def get_client_api_key(client: Client = Depends(get_current_client_strict)):
    """Return the authenticated client's API key in masked form."""
    return {"api_key_masked": _mask_key(client.api_key)}


@router.post("/api-key/regenerate")
def regenerate_client_api_key(client: Client = Depends(get_current_client_strict)):
    """Rotate the client's API key. Returns the full new key ONCE for copy."""
    with get_session() as session:
        row = session.get(Client, client.id)
        if not row:
            raise HTTPException(status_code=404, detail="Account not found.")
        new_key = uuid.uuid4().hex
        row.api_key = new_key
        session.commit()
        return {"ok": True, "api_key": new_key, "api_key_masked": _mask_key(new_key)}
