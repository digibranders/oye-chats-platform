import logging
from types import SimpleNamespace

from fastapi import Depends, HTTPException, Query, Request, Security, status
from fastapi.security.api_key import APIKeyHeader
from sqlalchemy import select

from app.core.cache import BOT_CONFIG_TTL, bot_config_key, cache_get, cache_set
from app.core.origin_check import extract_hostname, is_origin_allowed
from app.db.models import Affiliate, Bot, Client, Operator, Subscription
from app.db.session import get_session
from app.services import plan_service

logger = logging.getLogger(__name__)

# ── Client Auth (Admin Dashboard) ──
API_KEY_NAME = "X-API-Key"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

# ── Operator Auth (Operator Dashboard) ──
OPERATOR_KEY_NAME = "X-Operator-Key"
operator_key_header = APIKeyHeader(name=OPERATOR_KEY_NAME, auto_error=False)

# ── Backward compat: accept old X-Agent-Key during transition ──
LEGACY_AGENT_KEY_NAME = "X-Agent-Key"
legacy_agent_key_header = APIKeyHeader(name=LEGACY_AGENT_KEY_NAME, auto_error=False)

# ── Bot Auth (Widget Embed) ──
BOT_KEY_NAME = "X-Bot-Key"
bot_key_header = APIKeyHeader(name=BOT_KEY_NAME, auto_error=False)

# ── Workspace context (invite-based multi-workspace) ──
# When a caller presents X-API-Key together with X-Workspace-Id, the resolver
# looks up the linked-operator row for that workspace and returns
# ``type="operator"`` so role-escalation guards and RBAC see the operator's
# role, not the Client's implicit "unrestricted" status. Absent header ⇒ the
# caller is acting as the owner of their own workspace (legacy behavior).
WORKSPACE_ID_NAME = "X-Workspace-Id"
workspace_id_header = APIKeyHeader(name=WORKSPACE_ID_NAME, auto_error=False)


def _resolve_operator_key(
    operator_key: str | None,
    legacy_agent_key: str | None,
) -> str | None:
    """Return the effective operator key, preferring the new header over the legacy one."""
    return operator_key or legacy_agent_key


def _parse_workspace_id(raw: str | None) -> int | None:
    """Coerce the X-Workspace-Id header to an int; ``None`` if absent or malformed.

    Malformed values are treated as absent (legacy behavior) rather than 4xx so
    a bugged frontend doesn't hard-fail every API call — the downstream check
    against the actual workspace ownership will still catch cross-tenant leaks.
    """
    if raw is None:
        return None
    raw = raw.strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _resolve_linked_operator_for_workspace(
    session,
    caller_client_id: int,
    workspace_id: int,
) -> Operator | None:
    """Look up the linked Operator row that grants ``caller_client_id`` access
    to ``workspace_id``.

    Returns ``None`` when no such role exists (auth should 403). The caller is
    responsible for checking ``is_active`` on the returned operator.
    """
    return (
        session.execute(
            select(Operator).where(
                Operator.client_id == workspace_id,
                Operator.linked_client_id == caller_client_id,
            )
        )
        .scalars()
        .first()
    )


def _ensure_not_suspended(client: Client) -> None:
    """Reject a suspended client with HTTP 403 ``account_suspended``.

    A superadmin sets ``client.suspended_at`` to a timestamp when suspending a
    customer (see ``superadmin_routes_v2.py``); a null value means the account
    is in good standing. Every client-resolving auth dependency funnels through
    this helper so a suspended customer's API key, bot keys, and operators all
    stop working uniformly.

    Superadmins are platform staff, never customers, and must never be locked
    out of the console — so they are exempt even in the defensive case where a
    ``suspended_at`` timestamp is somehow present on a superadmin row.
    """
    if getattr(client, "is_superadmin", False):
        return
    if getattr(client, "suspended_at", None) is not None:
        logger.warning("Suspended client %s attempted authentication.", getattr(client, "id", None))
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="account_suspended",
        )


def get_current_client(
    api_key: str = Security(api_key_header),
    operator_key: str = Security(operator_key_header),
    legacy_agent_key: str = Security(legacy_agent_key_header),
):
    """
    Dependency: Authenticate a Client via X-API-Key header.
    Also accepts:
    - X-Operator-Key / X-Agent-Key: resolves the operator's workspace Client.

    The public ``X-Bot-Key`` header is intentionally NOT accepted here. Bot keys
    are embedded in widget script tags and visible to every site visitor, so they
    must never resolve to a Client identity. Widget-facing endpoints use
    ``get_current_bot`` instead; admin-only endpoints requiring strict client
    auth should use ``get_current_client_strict``.
    """
    effective_operator_key = _resolve_operator_key(operator_key, legacy_agent_key)

    with get_session() as session:
        # Primary: resolve via X-API-Key (permanent api_key UUID).
        if api_key:
            stmt = select(Client).where(Client.api_key == api_key)
            client = session.execute(stmt).scalars().first()
            if client:
                # Eagerly access attributes before session closes
                _ = client.id, client.name, client.email, client.api_key, client.is_superadmin, client.suspended_at
                _ensure_not_suspended(client)
                session.expunge(client)
                return client
            logger.warning("Failed authentication attempt with invalid API Key.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid API Key.",
            )

        # Operator fallback: resolve via X-Operator-Key → operator's workspace Client
        # Operators belong to a workspace; this gives them read access to their workspace's
        # resources (bots, analytics, documents) through any client-scoped endpoint.
        if effective_operator_key:
            operator = (
                session.execute(select(Operator).where(Operator.operator_api_key == effective_operator_key))
                .scalars()
                .first()
            )
            if operator:
                client = session.execute(select(Client).where(Client.id == operator.client_id)).scalars().first()
                if client:
                    _ = client.id, client.name, client.email, client.api_key, client.is_superadmin, client.suspended_at
                    _ensure_not_suspended(client)
                    session.expunge(client)
                    return client
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Operator Key.",
            )

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing API Key. Please provide the X-API-Key or X-Operator-Key header.",
        )


def get_current_operator(
    operator_key: str = Security(operator_key_header),
    legacy_agent_key: str = Security(legacy_agent_key_header),
):
    """
    Dependency: Authenticate an Operator via X-Operator-Key header.
    Returns the Operator object with client_id accessible for scoping queries.
    """
    effective_key = _resolve_operator_key(operator_key, legacy_agent_key)
    if not effective_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Operator-Key header.",
        )

    with get_session() as session:
        stmt = select(Operator).where(Operator.operator_api_key == effective_key)
        operator = session.execute(stmt).scalars().first()
        if not operator:
            logger.warning("Failed authentication attempt with invalid Operator Key.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Operator Key.",
            )
        # Block deactivated operators
        if not getattr(operator, "is_active", True):
            logger.warning(f"Deactivated operator {operator.id} attempted authentication.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="This operator account has been deactivated.",
            )
        # Eagerly access attributes before session closes
        _ = (
            operator.id,
            operator.name,
            operator.email,
            operator.client_id,
            operator.role,
            operator.department_id,
            operator.operator_api_key,
            operator.is_online,
            getattr(operator, "is_active", True),
        )
        session.expunge(operator)
        return operator


def get_current_client_or_operator(
    api_key: str = Security(api_key_header),
    operator_key: str = Security(operator_key_header),
    legacy_agent_key: str = Security(legacy_agent_key_header),
    workspace_id_raw: str = Security(workspace_id_header),
):
    """
    Dependency: Authenticate via X-API-Key (Client) or X-Operator-Key (Operator).
    Returns a dict with 'type' ('client'|'operator'), the entity, and 'client_id'.
    Used by endpoints that both admins and operators can access.

    Workspace-aware routing
    -----------------------
    When called with ``X-API-Key`` AND ``X-Workspace-Id`` naming a workspace that
    is NOT the caller's own, the resolver looks up the caller's linked-operator
    row for that workspace and returns ``type="operator"`` scoped to it. This
    lets one Client identity act as an operator in another workspace via the
    invite flow, while every existing endpoint that scopes on ``auth["client_id"]``
    continues to work unchanged — the workspace's owner id lands there.

    Legacy ``X-Operator-Key`` sessions ignore ``X-Workspace-Id`` (they're
    implicitly scoped to their one workspace). ``X-API-Key`` sessions without
    an ``X-Workspace-Id`` header default to the caller's own workspace.
    """
    effective_operator_key = _resolve_operator_key(operator_key, legacy_agent_key)
    requested_workspace_id = _parse_workspace_id(workspace_id_raw)

    # Try operator key first (more specific)
    if effective_operator_key:
        with get_session() as session:
            operator = (
                session.execute(select(Operator).where(Operator.operator_api_key == effective_operator_key))
                .scalars()
                .first()
            )
            if operator:
                if not getattr(operator, "is_active", True):
                    logger.warning(f"Deactivated operator {operator.id} attempted authentication.")
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="This operator account has been deactivated.",
                    )
                _ = (
                    operator.id,
                    operator.name,
                    operator.email,
                    operator.client_id,
                    operator.role,
                    operator.department_id,
                    operator.operator_api_key,
                    operator.is_online,
                )
                # An operator's access is governed by the owning client's
                # standing — a suspended workspace locks out its operators too.
                owner = session.execute(select(Client).where(Client.id == operator.client_id)).scalars().first()
                if owner is not None:
                    _ = owner.id, owner.is_superadmin, owner.suspended_at
                    _ensure_not_suspended(owner)
                session.expunge(operator)
                return {
                    "type": "operator",
                    "entity": operator,
                    "client_id": operator.client_id,
                    "operator_id": operator.id,
                }

    # Try client key
    if api_key:
        with get_session() as session:
            client = session.execute(select(Client).where(Client.api_key == api_key)).scalars().first()
            if client is None:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid API Key.",
                )
            _ = client.id, client.name, client.email, client.api_key, client.is_superadmin, client.suspended_at
            _ensure_not_suspended(client)

            # No workspace header, or caller pointing at their own workspace →
            # act as owner (legacy path).
            if requested_workspace_id is None or requested_workspace_id == client.id:
                session.expunge(client)
                return {
                    "type": "client",
                    "entity": client,
                    "client_id": client.id,
                    "operator_id": None,
                }

            # Cross-workspace request — validate the caller has a linked-operator
            # role there, and present as operator so downstream role guards see
            # the operator's role (not the Client's unrestricted status).
            operator = _resolve_linked_operator_for_workspace(session, client.id, requested_workspace_id)
            if operator is None:
                logger.info(
                    "Client %s attempted to act in workspace %s without a linked operator role.",
                    client.id,
                    requested_workspace_id,
                )
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "error": "workspace_access_denied",
                        "workspace_id": requested_workspace_id,
                        "message": "You do not have access to this workspace.",
                    },
                )
            if not getattr(operator, "is_active", True):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "error": "workspace_access_denied",
                        "workspace_id": requested_workspace_id,
                        "message": "Your operator role in this workspace has been revoked.",
                    },
                )

            # Workspace owner's standing gates every operator's access — a
            # suspended workspace locks out its linked operators too.
            owner = session.execute(select(Client).where(Client.id == requested_workspace_id)).scalars().first()
            if owner is not None:
                _ = owner.id, owner.is_superadmin, owner.suspended_at
                _ensure_not_suspended(owner)

            _ = (
                operator.id,
                operator.name,
                operator.email,
                operator.client_id,
                operator.role,
                operator.department_id,
                operator.operator_api_key,
                operator.is_online,
                operator.linked_client_id,
            )
            session.expunge(operator)
            return {
                "type": "operator",
                "entity": operator,
                # Workspace's owning client_id — every existing downstream query
                # that scopes ``WHERE ... client_id = auth["client_id"]`` keeps
                # working transparently.
                "client_id": requested_workspace_id,
                "operator_id": operator.id,
                # New: the underlying Client identity — useful for auditing and
                # for cache-key invalidation across workspaces.
                "linked_client_id": client.id,
            }

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing authentication. Provide X-API-Key or X-Operator-Key header.",
    )


def get_current_client_strict(
    api_key: str = Security(api_key_header),
):
    """
    Dependency: Authenticate a Client via X-API-Key ONLY.
    Does NOT fall back to X-Bot-Key or X-Operator-Key.
    Use this for admin-only endpoints (billing, subscription, sensitive account settings)
    where operator access must be explicitly blocked.
    """
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-API-Key header. This endpoint requires client (admin) authentication.",
        )

    with get_session() as session:
        stmt = select(Client).where(Client.api_key == api_key)
        client = session.execute(stmt).scalars().first()
        if not client:
            logger.warning("Failed strict authentication attempt with invalid API Key.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid API Key.",
            )
        _ = client.id, client.name, client.email, client.api_key, client.is_superadmin, client.suspended_at
        _ensure_not_suspended(client)
        session.expunge(client)
        return client


def get_superadmin(client: Client = Depends(get_current_client_strict)):
    """
    Dependency: Ensure authenticated Client is a Superadmin.

    Uses ``get_current_client_strict`` (X-API-Key only) — NOT ``get_current_client``.
    The latter also resolves an ``X-Operator-Key`` to its workspace's owning Client,
    which would let any operator of a super-admin's workspace authenticate *as* that
    super-admin and reach ``/superadmin/*``. The super-admin console authenticates
    with X-API-Key, so strict auth is the correct (and only legitimate) path here.
    """
    if getattr(client, "is_superadmin", False) is not True:
        logger.warning(f"Client {client.id} attempted to access a superadmin route without permission.")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have superadmin privileges to perform this action.",
        )
    return client


def get_current_affiliate(
    client: Client = Depends(get_current_client_strict),
) -> Affiliate:
    """Dependency: Authenticate a Client and verify they are an active affiliate.

    Uses ``get_current_client_strict`` (X-API-Key only) — bot keys and
    operator keys cannot impersonate an affiliate for code management.
    Resolves the affiliate row in a fresh session and detaches it so the
    caller can use the fields after the session closes.

    Raises 403 when the client has no affiliates row, or that row is
    deactivated.
    """
    with get_session() as session:
        affiliate = (
            session.execute(
                select(Affiliate).where(
                    Affiliate.client_id == client.id,
                    Affiliate.deactivated_at.is_(None),
                )
            )
            .scalars()
            .first()
        )
        if affiliate is None:
            logger.warning(
                "non_affiliate_accessed_affiliate_route",
                extra={"client_id": client.id},
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are not enrolled in the OyeChats affiliate program.",
            )
        # Eagerly read all fields before the session closes so route handlers
        # can use the object freely after detaching.
        _ = (
            affiliate.id,
            affiliate.client_id,
            affiliate.invited_by,
            affiliate.max_active_codes,
            affiliate.created_at,
            affiliate.deactivated_at,
        )
        session.expunge(affiliate)
        return affiliate


def _bot_to_cache_dict(bot: Bot) -> dict:
    """Serialize a Bot ORM object to a JSON-safe dict for Redis caching."""
    return {
        "id": bot.id,
        "client_id": bot.client_id,
        "bot_key": bot.bot_key,
        "name": bot.name,
        "system_prompt": bot.system_prompt,
        "subscription_id": bot.subscription_id,
        "is_legacy_pooled": getattr(bot, "is_legacy_pooled", False),
        "_subscription_bot_id": getattr(bot, "_subscription_bot_id", None),
        "brand_tone": bot.brand_tone,
        "company_description": bot.company_description,
        "website": bot.website,
        "bot_logo": bot.bot_logo,
        "launcher_name": bot.launcher_name,
        "launcher_logo": bot.launcher_logo,
        "primary_color": bot.primary_color,
        "background_color": bot.background_color,
        "header_color": bot.header_color,
        "user_bubble_color": bot.user_bubble_color,
        "bant_enabled": bot.bant_enabled,
        "bant_config": bot.bant_config,
        "avatar_type": bot.avatar_type,
        "orb_color": bot.orb_color,
        "lead_form_enabled": bot.lead_form_enabled,
        "lead_form_fields": bot.lead_form_fields,
        "notification_email": bot.notification_email,
        "notification_emails": bot.notification_emails,
        "reply_to_email": bot.reply_to_email,
        "email_on_qualified": bot.email_on_qualified,
        "email_on_handoff": bot.email_on_handoff,
        "email_on_offline": bot.email_on_offline,
        "email_visitor_confirmation": bot.email_visitor_confirmation,
        "live_chat_enabled": bot.live_chat_enabled,
        "operator_timeout_seconds": bot.operator_timeout_seconds,
        "visitor_disconnect_timeout": bot.visitor_disconnect_timeout,
        "operator_disconnect_timeout": bot.operator_disconnect_timeout,
        "business_hours": bot.business_hours,
        "welcome_title": bot.welcome_title,
        "welcome_subtitle": bot.welcome_subtitle,
        "waiting_message": bot.waiting_message,
        "offline_message": bot.offline_message,
        "handoff_delay_seconds": bot.handoff_delay_seconds,
        "calendly_url": bot.calendly_url,
        "zcal_url": bot.zcal_url,
        "meeting_provider": bot.meeting_provider,
        "meeting_booking_enabled": bot.meeting_booking_enabled,
        "feature_flags": bot.feature_flags,
        "widget_messages": bot.widget_messages,
        "widget_config": bot.widget_config,
        "branding_text": bot.branding_text,
        "branding_url": bot.branding_url,
        "is_active": bot.is_active,
        "recommended_colors": bot.recommended_colors,
        "allowed_domains": list(bot.allowed_domains or []),
        "domain_check_enabled": bool(bot.domain_check_enabled),
        "created_at": bot.created_at.isoformat() if bot.created_at else None,
    }


def _bot_from_cache_dict(data: dict) -> Bot:
    """Reconstruct a detached Bot object from a cached dict."""
    from datetime import datetime

    bot = Bot()
    for key, value in data.items():
        if key == "created_at" and isinstance(value, str):
            value = datetime.fromisoformat(value)
        setattr(bot, key, value)
    return bot


def _enforce_bot_origin(bot: Bot, request: Request | None) -> None:
    """Reject widget requests whose Origin/Referer is not in ``bot.allowed_domains``.

    No-op when ``domain_check_enabled`` is false, and also fails open when the
    flag is true but ``allowed_domains`` is empty -- enforcement only bites once
    an allowlist is actually configured. When enforcing, the ``Origin`` header
    is the source of truth; ``Referer`` is used as a fallback for older clients
    that omit ``Origin`` on same-origin POSTs. Missing both headers is a hard
    reject so a non-browser client cannot bypass the check by simply omitting
    the headers.
    """
    if not getattr(bot, "domain_check_enabled", False):
        return
    if request is None:
        # Defensive: dependencies are always called with a Request, but if a
        # caller invokes get_current_bot programmatically without one we still
        # fail closed rather than silently allowing the request.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="origin_not_allowed",
        )

    allowed: list[str] = list(bot.allowed_domains or [])
    if not allowed:
        # Fail-open on an empty allowlist: enforcement only bites when an
        # allowlist is actually configured. This lets us default the flag ON
        # for new bots (and backfill it for configured ones) without bricking
        # any bot that has ``domain_check_enabled`` set but no domains listed.
        return

    origin = request.headers.get("origin") or request.headers.get("referer")
    hostname = extract_hostname(origin)
    if not is_origin_allowed(hostname, allowed):
        logger.info(
            "Widget request rejected by origin check: bot_id=%s origin=%r hostname=%r",
            getattr(bot, "id", None),
            origin,
            hostname,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="origin_not_allowed",
        )


def _ensure_bot_owner_not_suspended(session, client_id: int) -> None:
    """Reject a widget request whose owning client is suspended (403).

    ``get_current_bot`` runs on the hot chat path, so this adds one narrow
    ``suspended_at``/``is_superadmin`` lookup keyed by ``client_id`` rather than
    loading the whole Client row. A missing owner (deleted client) is treated as
    not-suspended — the surrounding bot lookup already validated the bot exists.
    """
    owner = (
        session.execute(select(Client.is_superadmin, Client.suspended_at).where(Client.id == client_id))
        .tuples()
        .first()
    )
    if owner is None:
        return
    _ensure_not_suspended(SimpleNamespace(id=client_id, is_superadmin=owner[0], suspended_at=owner[1]))


def get_current_bot(
    request: Request,
    bot_key: str = Security(bot_key_header),
    api_key: str = Security(api_key_header),
):
    """
    Dependency: Resolve a Bot from the X-Bot-Key header.
    Used by widget-facing endpoints (chat, settings).

    Falls back to X-API-Key → client's default (first) bot for backward compatibility.

    Bot configs are cached in Redis (if configured) to avoid a DB query on every
    widget request.  Cache is invalidated when bot settings are updated.

    When the bot has ``domain_check_enabled`` set, the request's ``Origin`` /
    ``Referer`` hostname is matched against ``bot.allowed_domains`` and a 403 is
    returned on mismatch. The X-API-Key fallback path is intentionally exempt
    (the admin dashboard manages its own bot from inside the dashboard).
    """
    # Fast path: check Redis cache for bot_key lookups
    if bot_key:
        cached = cache_get(bot_config_key(bot_key))
        if cached:
            bot = _bot_from_cache_dict(cached)
            # Enforce owner suspension even on cache hits — a suspended customer's
            # cached bots must stop serving immediately, not only after TTL expiry.
            with get_session() as session:
                _ensure_bot_owner_not_suspended(session, bot.client_id)
            _enforce_bot_origin(bot, request)
            return bot

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
                _ = bot.allowed_domains, bot.domain_check_enabled
                # Pre-resolve which ledger scope this bot drains. bot.subscription
                # is a lazy relationship that can't be accessed after expunge(), so
                # we pull subscription.bot_id here and stash it for credit routing.
                if bot.subscription_id:
                    bot._subscription_bot_id = session.scalar(
                        select(Subscription.bot_id).where(Subscription.id == bot.subscription_id)
                    )
                else:
                    bot._subscription_bot_id = None
                # Cache for future requests
                cache_set(bot_config_key(bot_key), _bot_to_cache_dict(bot), BOT_CONFIG_TTL)
                session.expunge(bot)
                _ensure_bot_owner_not_suspended(session, bot.client_id)
                _enforce_bot_origin(bot, request)
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
                _ = client.id, client.is_superadmin, client.suspended_at
                _ensure_not_suspended(client)
                # Get the client's first (default) bot
                bot_stmt = (
                    select(Bot).where(Bot.client_id == client.id, Bot.is_active.is_(True)).order_by(Bot.id).limit(1)
                )
                bot = session.execute(bot_stmt).scalars().first()
                if bot:
                    _ = bot.id, bot.name, bot.system_prompt, bot.client_id, bot.bot_key
                    _ = bot.primary_color, bot.header_color, bot.background_color
                    _ = bot.bot_logo, bot.launcher_name, bot.launcher_logo
                    if bot.subscription_id:
                        bot._subscription_bot_id = session.scalar(
                            select(Subscription.bot_id).where(Subscription.id == bot.subscription_id)
                        )
                    else:
                        bot._subscription_bot_id = None
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


# Subscription statuses that grant full feature access. ``trialing`` is
# included so prospects evaluating the product can exercise everything a
# paying customer can. ``past_due`` is intentionally treated as "active" —
# we don't yank functionality the moment a card retry fails; the dunning
# cron handles that escalation separately.
_ACTIVE_SUBSCRIPTION_STATUSES = frozenset({"trialing", "active", "past_due"})


def require_active_subscription(client: Client = Depends(get_current_client)):
    """Dependency: gate an endpoint behind a live subscription.

    Resolves the authenticated client's current subscription and admits
    only ``trialing``, ``active``, or ``past_due`` callers. Anything else
    (``trial_expired``, ``canceled``, ``expired``, ``paused``) returns a
    structured 403 the admin dashboard uses to route the user to billing.

    The structured ``detail`` is intentionally a dict instead of a plain
    string so frontends can branch on ``error`` without parsing English.
    Existing routes that should accept any authenticated client unchanged
    must NOT depend on this — pair it only with explicitly gated routes.
    """
    # Superadmins are platform staff, not customers — they never need a
    # paying subscription to manage the system. Free pass.
    if getattr(client, "is_superadmin", False):
        return None

    with get_session() as session:
        # Resolve the client's ACTIVE subscription (highest tier among
        # active/trialing/past_due rows), NOT merely the most-recently-created
        # row. A paying customer may carry a newer terminal sibling (an
        # ``expired`` promoted-old row, or a ``canceled`` row from re-checkout)
        # while an older row is still live; ordering by ``created_at`` alone
        # would 403 them. ``get_client_subscription`` is the shared active-row
        # resolver (remediation H2) — reuse it so the gate agrees with the rest
        # of the billing stack.
        sub = plan_service.get_client_subscription(session, client.id)

        # No subscription at all is treated as "needs to pick a plan" —
        # the same UX as an expired trial. Should never happen for a
        # self-serve signup once PR1 is live; defensive for legacy rows.
        sub_status = sub.status if sub else "missing"

        if sub_status in _ACTIVE_SUBSCRIPTION_STATUSES:
            if sub is not None:
                # Eagerly read the few fields a handler might want before
                # we drop the session, so we don't force the caller to
                # reopen one just to read ``status``.
                _ = sub.id, sub.status, sub.plan_id, sub.trial_end, sub.current_period_end
                session.expunge(sub)
            return sub

        logger.info(
            "subscription_gate_denied client_id=%s status=%s",
            client.id,
            sub_status,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "subscription_required",
                "subscription_status": sub_status,
                "message": (
                    "Your trial has ended."
                    if sub_status == "trial_expired"
                    else "An active subscription is required to use this feature."
                ),
                "reactivate_url": "/billing",
            },
        )


def require_active_subscription_for_workspace(
    auth: dict = Depends(get_current_client_or_operator),
):
    """Workspace-aware variant of :func:`require_active_subscription`.

    Endpoints that accept both client (``X-API-Key``) and operator
    (``X-Operator-Key``) callers should depend on this. The subscription
    belongs to the workspace's owning client, so an operator's access is
    governed by the *owner's* subscription state — when the owner's trial
    expires, every operator in that workspace also loses access.

    Returns the resolved ``Subscription`` (or ``None`` for superadmins) so
    handlers can branch on the status without reopening a session.
    """
    client_id = auth["client_id"]

    # Superadmin clients bypass the gate (platform staff).
    if auth["type"] == "client":
        client = auth["entity"]
        if getattr(client, "is_superadmin", False):
            return None

    with get_session() as session:
        # Same active-row resolution as :func:`require_active_subscription` —
        # the workspace owner's live subscription, not their newest row (which
        # may be a terminal sibling). See that function for the rationale.
        sub = plan_service.get_client_subscription(session, client_id)
        sub_status = sub.status if sub else "missing"

        if sub_status in _ACTIVE_SUBSCRIPTION_STATUSES:
            if sub is not None:
                _ = sub.id, sub.status, sub.plan_id, sub.trial_end, sub.current_period_end
                session.expunge(sub)
            return sub

        logger.info(
            "workspace_subscription_gate_denied client_id=%s status=%s actor=%s",
            client_id,
            sub_status,
            auth["type"],
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "subscription_required",
                "subscription_status": sub_status,
                "message": (
                    "Your workspace's trial has ended."
                    if sub_status == "trial_expired"
                    else "An active subscription is required to use this feature."
                ),
                "reactivate_url": "/billing",
            },
        )


def bot_subscription_status(client_id: int, subscription_id: int | None = None) -> str:
    """Return the bot owner's current subscription status as a string.

    Read-only helper for widget-facing code paths (chat, public settings)
    that need to short-circuit to a polite offline response when the owning
    client's subscription is not live. Returns ``"missing"`` if no
    subscription row exists, never raises.

    Centralised so chat_routes.py and bot_routes.py share one source of
    truth for "is this bot allowed to serve traffic right now?".

    Pass ``subscription_id=bot.subscription_id`` for per-bot billing bots so
    we check that specific subscription rather than the latest for the client
    (which could be a sibling bot's expired sub on multi-bot accounts).
    """
    with get_session() as session:
        if subscription_id is not None:
            # Per-bot path: check the exact subscription that funds this bot.
            sub = session.get(Subscription, subscription_id)
            return sub.status if sub else "missing"
        sub = (
            session.execute(
                select(Subscription)
                .where(Subscription.client_id == client_id)
                .order_by(Subscription.created_at.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        return sub.status if sub else "missing"


def is_bot_serving(client_id: int) -> bool:
    """Convenience predicate: True when the bot owner can serve widget traffic."""
    return bot_subscription_status(client_id) in _ACTIVE_SUBSCRIPTION_STATUSES


# ── Plan entitlement dependencies ──────────────────────────────────────────
# Drop-in FastAPI dependencies that check feature flags + numeric limits
# against the resolved plan entitlements. Errors follow the same structured
# 403/402 contract the frontend already handles for subscription gating.


def require_feature(feature_name: str):
    """Return a FastAPI dependency that 403s when the feature is not on the plan.

    Usage::

        @router.post("/webhooks")
        def create_webhook(
            payload: ...,
            client: Client = Depends(get_current_client),
            _: None = Depends(require_feature("webhooks")),
        ):
            ...

    Superadmins always pass. The structured detail payload mirrors the
    ``require_active_subscription`` 403 shape so the admin app can route
    every gate failure through one upgrade flow.
    """

    def _dependency(client: Client = Depends(get_current_client)):
        if getattr(client, "is_superadmin", False):
            return None

        with get_session() as session:
            from app.services.plan_entitlements_service import get_entitlements

            entitlements = get_entitlements(client.id, session)

        if entitlements.has_feature(feature_name):
            return None

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "feature_locked",
                "feature": feature_name,
                "current_plan": entitlements.plan_slug,
                "message": (
                    f"The '{feature_name}' feature is not included in your current plan. Upgrade to unlock it."
                ),
                "upgrade_url": "/billing",
            },
        )

    return _dependency


def enforce_limit(limit_name: str, current_count_callable=None):
    """Return a FastAPI dependency that 403s when the resource would exceed the plan limit.

    Caller must pass a ``current_count_callable(client_id, db_session) -> int``
    so the dependency knows how many of this resource already exist. Common
    counts are computed inline by the route (e.g. ``len(existing_bots)``);
    the callable shape lets routes that already have the data avoid a
    duplicate DB hit. When omitted, falls back to the usage numbers the
    entitlements service computes generically (``bots``, ``operators``,
    ``documents``, ``leads``).

    Returns ``None`` on success so it composes cleanly as ``Depends(...)``.
    """

    def _dependency(client: Client = Depends(get_current_client)):
        if getattr(client, "is_superadmin", False):
            return None

        with get_session() as session:
            from app.services.plan_entitlements_service import UNLIMITED, get_entitlements

            entitlements = get_entitlements(client.id, session, include_usage=True)
            limit = entitlements.limit_for(limit_name)

            if limit == UNLIMITED:
                return None

            if current_count_callable is not None:
                current = int(current_count_callable(client.id, session))
            else:
                current = int(entitlements.usage.get(limit_name, 0))

            if current < limit:
                return None

            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "error": "limit_reached",
                    "limit": limit_name,
                    "current": current,
                    "max": limit,
                    "current_plan": entitlements.plan_slug,
                    "message": (
                        f"You've reached your plan's '{limit_name}' limit ({current}/{limit}). Upgrade to add more."
                    ),
                    "upgrade_url": "/billing",
                },
            )

    return _dependency
