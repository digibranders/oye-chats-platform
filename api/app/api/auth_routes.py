import logging
import random
import re
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select

from app.core.security import get_password_hash, verify_password
from app.db.models import Client
from app.db.session import get_session
from app.services.email_service import send_password_reset_email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# ── Request / Response Models ──


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    client_id: int
    name: str
    is_superadmin: bool


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str
    company_name: str | None = None

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v):
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v

    @field_validator("email")
    @classmethod
    def valid_email(cls, v):
        v = v.strip().lower()
        pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
        if not re.match(pattern, v):
            raise ValueError("Please enter a valid email address.")
        return v

    @field_validator("password")
    @classmethod
    def strong_password(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        if not re.search(r"[A-Za-z]", v):
            raise ValueError("Password must contain at least one letter.")
        if not re.search(r"[0-9]", v):
            raise ValueError("Password must contain at least one number.")
        return v


class RegisterResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    client_id: int
    name: str
    is_superadmin: bool = False
    message: str = "Account created successfully"


# ── Endpoints ──

class RequestPasswordResetRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    email: str
    otp: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def strong_password(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        if not re.search(r"[A-Za-z]", v):
            raise ValueError("Password must contain at least one letter.")
        if not re.search(r"[0-9]", v):
            raise ValueError("Password must contain at least one number.")
        return v


@router.post("/login", response_model=LoginResponse)
def login(request: LoginRequest):
    """
    Authenticate a Client via Email and Password for Admin Dashboard access.
    Returns the Client's API Key to be used as a Bearer/API token for subsequent requests.
    """
    try:
        with get_session() as session:
            stmt = select(Client).where(Client.email == request.email.strip().lower()).limit(1)
            client = session.execute(stmt).scalars().first()

            if not client:
                logger.warning(f"Login failed: Unknown email {request.email}")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Incorrect email or password",
                )

            if not verify_password(request.password, client.hashed_password):
                logger.warning(f"Login failed: Incorrect password for {request.email}")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Incorrect email or password",
                )

            logger.info(f"Successful dashboard login for client {client.id} ({client.name})")

            return {
                "access_token": client.api_key,
                "token_type": "bearer",
                "client_id": client.id,
                "name": client.name,
                "is_superadmin": getattr(client, "is_superadmin", False),
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"LOGIN FAILED for {request.email}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Login failed: {str(e)}",
        ) from e


@router.post("/register", response_model=RegisterResponse)
def register(request: RegisterRequest):
    """
    Self-service client registration.
    Creates a new client account and returns an API key for immediate login.
    """
    try:
        with get_session() as session:
            # Check for duplicate email
            stmt = select(Client).where(Client.email == request.email).limit(1)
            existing = session.execute(stmt).scalars().first()
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="An account with this email already exists. Please sign in instead.",
                )

            # Create the client
            new_client = Client(
                name=request.name.strip(),
                email=request.email,  # already lowercased by validator
                hashed_password=get_password_hash(request.password),
                api_key=str(uuid.uuid4().hex),
                website=None,
                is_superadmin=False,
            )

            session.add(new_client)
            session.flush()  # Get the client ID
            logger.info(f"Client INSERT flushed: id={new_client.id}, email={new_client.email}")

            session.commit()
            logger.info(f"Transaction committed successfully for client {new_client.id}")

            session.refresh(new_client)

            logger.info(
                f"New client registered: {new_client.id} ({new_client.name}, {new_client.email}) — no default bot (client will create manually)"
            )

            return {
                "access_token": new_client.api_key,
                "token_type": "bearer",
                "client_id": new_client.id,
                "name": new_client.name,
                "is_superadmin": False,
                "message": "Account created successfully",
            }
    except HTTPException:
        raise  # Re-raise 409 (duplicate email) and other HTTP errors as-is
    except Exception as e:
        logger.error(f"REGISTRATION FAILED for {request.email}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Registration failed: {str(e)}",
        ) from e


@router.post("/request-password-reset")
def request_password_reset(request: RequestPasswordResetRequest):
    """Generates an OTP and sends it via email."""
    try:
        with get_session() as session:
            stmt = select(Client).where(Client.email == request.email.strip().lower()).limit(1)
            client = session.execute(stmt).scalars().first()
            if not client:
                # Return success anyway to avoid email enumeration
                return {"message": "If an account exists, a reset link has been sent."}

            otp = str(random.randint(100000, 999999))
            client.reset_otp = otp
            client.reset_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
            session.commit()

            send_password_reset_email(client.email, otp)
            return {"message": "If an account exists, a reset link has been sent."}
    except Exception as e:
        logger.error(f"Failed to request password reset for {request.email}: {e}")
        raise HTTPException(status_code=500, detail="An error occurred.") from e


@router.post("/reset-password")
def reset_password(request: ResetPasswordRequest):
    """Verifies OTP and resets the password."""
    try:
        with get_session() as session:
            stmt = select(Client).where(Client.email == request.email.strip().lower()).limit(1)
            client = session.execute(stmt).scalars().first()

            if not client or not client.reset_otp or not client.reset_otp_expires_at:
                raise HTTPException(status_code=400, detail="Invalid or expired reset code.")

            if client.reset_otp != request.otp.strip():
                raise HTTPException(status_code=400, detail="Invalid reset code.")

            if datetime.now(UTC) > client.reset_otp_expires_at:
                raise HTTPException(status_code=400, detail="Reset code has expired.")

            client.hashed_password = get_password_hash(request.new_password)
            client.reset_otp = None
            client.reset_otp_expires_at = None
            session.commit()

            return {"message": "Password successfully reset."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset password for {request.email}: {e}")
        raise HTTPException(status_code=500, detail="An error occurred.") from e
