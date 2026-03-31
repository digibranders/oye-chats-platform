import logging
import random
import re
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select

from app.api.auth import get_current_agent
from app.core.security import get_password_hash, verify_password
from app.db.models import Agent, Bot, ChatSession, Client, Document
from app.db.session import get_session
from app.services.email_service import send_password_reset_email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


def _normalize_workspace_stats(
    client_ids: set[int], workspace_stats: dict[int, dict[str, int]] | None
) -> dict[int, dict[str, int]]:
    """Ensure every candidate client has a complete zero-filled stats record."""
    normalized = {
        client_id: {
            "bot_count": 0,
            "agent_count": 0,
            "website_bot_count": 0,
            "document_count": 0,
            "session_count": 0,
        }
        for client_id in client_ids
    }
    if not workspace_stats:
        return normalized

    for client_id, stats in workspace_stats.items():
        base = normalized.setdefault(
            client_id,
            {
                "bot_count": 0,
                "agent_count": 0,
                "website_bot_count": 0,
                "document_count": 0,
                "session_count": 0,
            },
        )
        base.update({key: int(value or 0) for key, value in stats.items()})

    return normalized


def _build_workspace_stats(session, client_ids: set[int]) -> dict[int, dict[str, int]]:
    """Collect signals that indicate which duplicate-email workspace is actually in use."""
    stats = _normalize_workspace_stats(client_ids, None)
    if not client_ids:
        return stats

    bot_rows = session.execute(
        select(Bot.id, Bot.client_id, Bot.website).where(Bot.client_id.in_(client_ids), Bot.is_active.is_(True))
    ).all()

    bot_client_lookup: dict[int, int] = {}
    for bot_id, client_id, website in bot_rows:
        bot_client_lookup[bot_id] = client_id
        stats[client_id]["bot_count"] += 1
        if website and website.strip():
            stats[client_id]["website_bot_count"] += 1

    agent_count_rows = session.execute(
        select(Agent.client_id, func.count(Agent.id)).where(Agent.client_id.in_(client_ids)).group_by(Agent.client_id)
    ).all()
    for client_id, count in agent_count_rows:
        stats[client_id]["agent_count"] = int(count or 0)

    if not bot_client_lookup:
        return stats

    bot_ids = list(bot_client_lookup.keys())

    document_count_rows = session.execute(
        select(Document.bot_id, func.count(Document.id)).where(Document.bot_id.in_(bot_ids)).group_by(Document.bot_id)
    ).all()
    for bot_id, count in document_count_rows:
        stats[bot_client_lookup[bot_id]]["document_count"] += int(count or 0)

    session_count_rows = session.execute(
        select(ChatSession.bot_id, func.count(ChatSession.id))
        .where(ChatSession.bot_id.in_(bot_ids))
        .group_by(ChatSession.bot_id)
    ).all()
    for bot_id, count in session_count_rows:
        stats[bot_client_lookup[bot_id]]["session_count"] += int(count or 0)

    return stats


def _workspace_connection_score(workspace_stats: dict[str, int]) -> tuple:
    """Rank workspaces by how likely they are to be the real connected customer workspace."""
    website_bot_count = workspace_stats.get("website_bot_count", 0)
    session_count = workspace_stats.get("session_count", 0)
    document_count = workspace_stats.get("document_count", 0)
    bot_count = workspace_stats.get("bot_count", 0)
    agent_count = workspace_stats.get("agent_count", 0)
    has_connected_bot = website_bot_count > 0 or session_count > 0 or document_count > 0

    return (
        has_connected_bot,
        website_bot_count > 0,
        session_count > 0,
        website_bot_count,
        session_count,
        document_count,
        bot_count,
        agent_count,
    )


def _agent_login_score(agent: Agent, workspace_stats: dict[int, dict[str, int]] | None = None, **legacy_stats) -> tuple:
    """Prefer the workspace with the strongest evidence of a real linked bot setup."""
    client_ids = {agent.client_id}
    if workspace_stats is None:
        workspace_stats = _normalize_workspace_stats(client_ids, legacy_stats)
    else:
        workspace_stats = _normalize_workspace_stats(client_ids, workspace_stats)

    connection_score = _workspace_connection_score(workspace_stats.get(agent.client_id, {}))
    created_at = agent.created_at or datetime.min.replace(tzinfo=UTC)
    return (*connection_score, created_at, agent.id)


def _choose_best_agent_candidate(
    candidates: list[Agent], workspace_stats: dict[int, dict[str, int]] | None = None, **legacy_stats
) -> Agent:
    client_ids = {agent.client_id for agent in candidates}
    if workspace_stats is None:
        workspace_stats = _normalize_workspace_stats(client_ids, legacy_stats)
    else:
        workspace_stats = _normalize_workspace_stats(client_ids, workspace_stats)

    return max(candidates, key=lambda agent: _agent_login_score(agent, workspace_stats))


def _choose_default_workspace_bot(bots: list[Bot], bot_activity: dict[int, dict[str, int]] | None = None) -> Bot | None:
    """Choose the bot that best represents the workspace's existing linked setup."""
    if not bots:
        return None

    bot_activity = bot_activity or {}

    def score(bot: Bot) -> tuple:
        activity = bot_activity.get(bot.id, {})
        website_present = bool(bot.website and bot.website.strip())
        session_count = int(activity.get("session_count", 0) or 0)
        document_count = int(activity.get("document_count", 0) or 0)
        created_at = bot.created_at or datetime.min.replace(tzinfo=UTC)
        return (
            website_present,
            session_count > 0,
            document_count > 0,
            session_count,
            document_count,
            created_at,
            bot.id,
        )

    return max(bots, key=score)


def _get_default_workspace_bot(session, client_id: int) -> Bot | None:
    """Fetch the best default bot to hydrate immediately after agent login."""
    bots = (
        session.execute(
            select(Bot)
            .where(Bot.client_id == client_id, Bot.is_active.is_(True))
            .order_by(Bot.created_at.asc(), Bot.id.asc())
        )
        .scalars()
        .all()
    )
    if not bots:
        return None

    bot_ids = [bot.id for bot in bots]
    bot_activity: dict[int, dict[str, int]] = {bot.id: {"document_count": 0, "session_count": 0} for bot in bots}

    document_rows = session.execute(
        select(Document.bot_id, func.count(Document.id)).where(Document.bot_id.in_(bot_ids)).group_by(Document.bot_id)
    ).all()
    for bot_id, count in document_rows:
        bot_activity[bot_id]["document_count"] = int(count or 0)

    session_rows = session.execute(
        select(ChatSession.bot_id, func.count(ChatSession.id))
        .where(ChatSession.bot_id.in_(bot_ids))
        .group_by(ChatSession.bot_id)
    ).all()
    for bot_id, count in session_rows:
        bot_activity[bot_id]["session_count"] = int(count or 0)

    return _choose_default_workspace_bot(bots, bot_activity)


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
    company_name: str | None = None


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
    company_name: str | None = None
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
                "company_name": getattr(client, "company_name", None),
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
                company_name=request.company_name.strip() if request.company_name else None,
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
                "company_name": new_client.company_name,
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


# ── Agent Authentication ──


class AgentLoginRequest(BaseModel):
    email: str
    password: str


class AgentLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    agent_id: int
    client_id: int
    default_bot_id: int | None = None
    name: str
    role: str
    department_id: int | None = None
    company_name: str | None = None


class AgentChangePasswordRequest(BaseModel):
    current_password: str
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


@router.post("/agent-login", response_model=AgentLoginResponse)
def agent_login(request: AgentLoginRequest):
    """
    Authenticate an Agent via email and password.
    Returns the Agent's API Key for subsequent requests via X-Agent-Key header.
    """
    try:
        with get_session() as session:
            email = request.email.strip().lower()
            agents = (
                session.execute(
                    select(Agent).where(Agent.email == email).order_by(Agent.created_at.desc(), Agent.id.desc())
                )
                .scalars()
                .all()
            )

            valid_agents = [
                agent
                for agent in agents
                if agent.hashed_password and verify_password(request.password, agent.hashed_password)
            ]

            if not valid_agents:
                logger.warning(f"Agent login failed: unknown email or no password set for {request.email}")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Incorrect email or password",
                )

            if len(valid_agents) == 1:
                agent = valid_agents[0]
            else:
                client_ids = {agent.client_id for agent in valid_agents}
                workspace_stats = _build_workspace_stats(session, client_ids)
                agent = _choose_best_agent_candidate(valid_agents, workspace_stats)

                logger.warning(
                    "Duplicate agent email resolved during login | email=%s | chosen_agent_id=%s | chosen_client_id=%s | candidates=%s | workspace_stats=%s",
                    email,
                    agent.id,
                    agent.client_id,
                    [(candidate.id, candidate.client_id) for candidate in valid_agents],
                    workspace_stats,
                )

            # Backfill missing API keys for older agent records so subsequent
            # authenticated requests don't immediately fail with 401.
            if not agent.agent_api_key:
                agent.agent_api_key = uuid.uuid4().hex
                session.commit()
                session.refresh(agent)

            default_bot = _get_default_workspace_bot(session, agent.client_id)

            workspace = session.execute(select(Client).where(Client.id == agent.client_id)).scalars().first()

            logger.info(f"Successful agent login for agent {agent.id} ({agent.name})")

            return {
                "access_token": agent.agent_api_key,
                "token_type": "bearer",
                "agent_id": agent.id,
                "client_id": agent.client_id,
                "default_bot_id": default_bot.id if default_bot else None,
                "name": agent.name,
                "role": agent.role,
                "department_id": agent.department_id,
                "company_name": getattr(workspace, "company_name", None) if workspace else None,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"AGENT LOGIN FAILED for {request.email}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Login failed: {str(e)}",
        ) from e


@router.post("/agent-change-password")
def agent_change_password(
    request: AgentChangePasswordRequest,
    agent: Agent = Depends(get_current_agent),
):
    """Agent changes their own password."""
    try:
        with get_session() as session:
            db_agent = session.execute(select(Agent).where(Agent.id == agent.id)).scalar_one_or_none()
            if not db_agent or not db_agent.hashed_password:
                raise HTTPException(status_code=400, detail="Agent account not properly configured.")

            if not verify_password(request.current_password, db_agent.hashed_password):
                raise HTTPException(status_code=400, detail="Current password is incorrect.")

            db_agent.hashed_password = get_password_hash(request.new_password)
            session.commit()

            return {"message": "Password changed successfully."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Agent password change failed for agent {agent.id}: {e}")
        raise HTTPException(status_code=500, detail="An error occurred.") from e
