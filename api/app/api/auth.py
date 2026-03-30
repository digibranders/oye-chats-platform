import logging

from fastapi import Depends, HTTPException, Query, Security, status
from fastapi.security.api_key import APIKeyHeader
from sqlalchemy import select

from app.db.models import Agent, Bot, Client
from app.db.session import get_session

logger = logging.getLogger(__name__)

# ── Client Auth (Admin Dashboard) ──
API_KEY_NAME = "X-API-Key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

# ── Agent Auth (Agent Dashboard) ──
AGENT_KEY_NAME = "X-Agent-Key"
agent_key_header = APIKeyHeader(name=AGENT_KEY_NAME, auto_error=False)

# ── Bot Auth (Widget Embed) ──
BOT_KEY_NAME = "X-Bot-Key"
bot_key_header = APIKeyHeader(name=BOT_KEY_NAME, auto_error=False)


def get_current_client(
    api_key: str = Security(api_key_header),
    bot_key: str = Security(bot_key_header),
    agent_key: str = Security(agent_key_header),
):
    """
    Dependency: Authenticate a Client via X-API-Key header.
    Also accepts:
    - X-Bot-Key: resolves the owning Client (widget backward compat).
    - X-Agent-Key: resolves the agent's workspace Client (agent dashboard access).
    Used by admin dashboard endpoints and shared endpoints.
    """
    with get_session() as session:
        # Primary: resolve via X-API-Key
        if api_key:
            stmt = select(Client).where(Client.api_key == api_key)
            client = session.execute(stmt).scalars().first()
            if client:
                # Eagerly access attributes before session closes
                _ = client.id, client.name, client.email, client.api_key, client.is_superadmin
                session.expunge(client)
                return client
            logger.warning("Failed authentication attempt with invalid API Key.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid API Key.",
            )

        # Fallback: resolve via X-Bot-Key → owning Client
        if bot_key:
            stmt = select(Bot).where(Bot.bot_key == bot_key, Bot.is_active.is_(True))
            bot = session.execute(stmt).scalars().first()
            if bot:
                client_stmt = select(Client).where(Client.id == bot.client_id)
                client = session.execute(client_stmt).scalars().first()
                if client:
                    _ = client.id, client.name, client.email, client.api_key, client.is_superadmin
                    session.expunge(client)
                    return client
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Bot Key.",
            )

        # Agent fallback: resolve via X-Agent-Key → agent's workspace Client
        # Agents belong to a workspace; this gives them read access to their workspace's
        # resources (bots, analytics, documents) through any client-scoped endpoint.
        if agent_key:
            agent = session.execute(select(Agent).where(Agent.agent_api_key == agent_key)).scalars().first()
            if agent:
                client = session.execute(select(Client).where(Client.id == agent.client_id)).scalars().first()
                if client:
                    _ = client.id, client.name, client.email, client.api_key, client.is_superadmin
                    session.expunge(client)
                    return client
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Agent Key.",
            )

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing API Key. Please provide the X-API-Key or X-Bot-Key header.",
        )


def get_current_agent(
    agent_key: str = Security(agent_key_header),
):
    """
    Dependency: Authenticate an Agent via X-Agent-Key header.
    Returns the Agent object with client_id accessible for scoping queries.
    """
    if not agent_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Agent-Key header.",
        )

    with get_session() as session:
        stmt = select(Agent).where(Agent.agent_api_key == agent_key)
        agent = session.execute(stmt).scalars().first()
        if not agent:
            logger.warning("Failed authentication attempt with invalid Agent Key.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Agent Key.",
            )
        # Eagerly access attributes before session closes
        _ = (
            agent.id,
            agent.name,
            agent.email,
            agent.client_id,
            agent.role,
            agent.department_id,
            agent.agent_api_key,
            agent.is_online,
        )
        session.expunge(agent)
        return agent


def get_current_client_or_agent(
    api_key: str = Security(api_key_header),
    agent_key: str = Security(agent_key_header),
):
    """
    Dependency: Authenticate via X-API-Key (Client) or X-Agent-Key (Agent).
    Returns a dict with 'type' ('client'|'agent'), the entity, and 'client_id'.
    Used by endpoints that both admins and agents can access.
    """
    # Try agent key first (more specific)
    if agent_key:
        with get_session() as session:
            agent = session.execute(select(Agent).where(Agent.agent_api_key == agent_key)).scalars().first()
            if agent:
                _ = (
                    agent.id,
                    agent.name,
                    agent.email,
                    agent.client_id,
                    agent.role,
                    agent.department_id,
                    agent.agent_api_key,
                    agent.is_online,
                )
                session.expunge(agent)
                return {"type": "agent", "entity": agent, "client_id": agent.client_id, "agent_id": agent.id}

    # Try client key
    if api_key:
        with get_session() as session:
            client = session.execute(select(Client).where(Client.api_key == api_key)).scalars().first()
            if client:
                _ = client.id, client.name, client.email, client.api_key, client.is_superadmin
                session.expunge(client)
                return {"type": "client", "entity": client, "client_id": client.id, "agent_id": None}

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing authentication. Provide X-API-Key or X-Agent-Key header.",
    )


def get_superadmin(client: Client = Depends(get_current_client)):
    """
    Dependency: Ensure authenticated Client is a Superadmin.
    """
    if getattr(client, "is_superadmin", False) is not True:
        logger.warning(f"Client {client.id} attempted to access a superadmin route without permission.")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have superadmin privileges to perform this action.",
        )
    return client


def get_current_bot(
    bot_key: str = Security(bot_key_header),
    api_key: str = Security(api_key_header),
):
    """
    Dependency: Resolve a Bot from the X-Bot-Key header.
    Used by widget-facing endpoints (chat, settings).

    Falls back to X-API-Key → client's default (first) bot for backward compatibility.

    NOTE: We call session.expunge(bot) to detach the object cleanly before the
    session closes, ensuring all loaded column attributes remain accessible.
    """
    with get_session() as session:
        # Primary path: resolve via bot_key
        if bot_key:
            stmt = select(Bot).where(Bot.bot_key == bot_key, Bot.is_active.is_(True))
            bot = session.execute(stmt).scalars().first()
            if bot:
                # Eagerly access key attributes before detaching
                _ = bot.id, bot.name, bot.system_prompt, bot.client_id, bot.bot_key
                _ = bot.primary_color, bot.header_color, bot.background_color
                _ = bot.bot_logo, bot.launcher_name, bot.launcher_logo
                session.expunge(bot)
                return bot
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Bot Key.",
            )

        # Fallback: resolve via api_key → client's default bot
        if api_key:
            stmt = select(Client).where(Client.api_key == api_key)
            client = session.execute(stmt).scalars().first()
            if client:
                # Get the client's first (default) bot
                bot_stmt = (
                    select(Bot).where(Bot.client_id == client.id, Bot.is_active.is_(True)).order_by(Bot.id).limit(1)
                )
                bot = session.execute(bot_stmt).scalars().first()
                if bot:
                    _ = bot.id, bot.name, bot.system_prompt, bot.client_id, bot.bot_key
                    _ = bot.primary_color, bot.header_color, bot.background_color
                    _ = bot.bot_logo, bot.launcher_name, bot.launcher_logo
                    session.expunge(bot)
                    return bot
                # No bot exists — client hasn't created one yet (expected for new accounts)
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="No active bot found. Please create a chatbot first.",
                )

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Bot-Key or X-API-Key header.",
        )


def get_client_bot(
    bot_id: int = Query(..., description="Bot ID"),
    client: Client = Depends(get_current_client),
):
    """
    Dependency: Resolve a Bot that belongs to the authenticated Client.
    Used by admin endpoints that operate on a specific bot.
    """
    with get_session() as session:
        stmt = select(Bot).where(Bot.id == bot_id, Bot.client_id == client.id)
        bot = session.execute(stmt).scalars().first()
        if not bot:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Bot not found or does not belong to your account.",
            )
        return bot
