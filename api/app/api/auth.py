import hashlib
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import TypeVar

from fastapi import Depends, HTTPException, Query, Request, Security, status
from fastapi.security.api_key import APIKeyHeader
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.cache import BOT_CONFIG_TTL, bot_config_key, cache_get, cache_set
from app.core.origin_check import extract_hostname, is_origin_allowed, origin_check_applies
from app.db.models import Affiliate, Bot, Client, ImpersonationToken, Operator, Subscription
from app.db.session import get_session
from app.schemas.validators import RowId
from app.services import plan_service
from app.services.audit_service import record_audit
from app.services.runtime_config import is_impersonation_enabled

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

# ── Impersonation (super-admin support sessions) ──
# A super-admin mints a short-lived token via /superadmin/clients/{id}/impersonate
# and the customer app then carries it on every request as X-Impersonation-Token.
# Validity (not revoked, not expired) is re-checked per request, so the "Exit"
# control in the super-admin console kills an in-flight session immediately.
IMPERSONATION_TOKEN_NAME = "X-Impersonation-Token"
impersonation_token_header = APIKeyHeader(name=IMPERSONATION_TOKEN_NAME, auto_error=False)

# One message for expired / revoked / unknown / malformed tokens, the caller
# already holds the token, so distinguishing the failure modes would only help
# someone probing with tokens they never had.
IMPERSONATION_REJECTED_DETAIL = "Impersonation session expired or revoked."

# ── Credential shape ─────────────────────────────────────────────────────────
#
# Every credential above is a header, and headers get none of the schema
# validation a request body does. ``APIKeyHeader`` hands the value through
# verbatim. Each one is then used as an equality filter in a DB query and, for
# the bot key, as a Redis cache-key fragment. A megabyte-long header is
# therefore a megabyte-long cache key and a megabyte-long query parameter, and
# a header carrying control characters lands in log lines unaltered.
#
# The two properties worth enforcing are LENGTH and the absence of control
# characters. Those are what actually cause harm here: length because the
# value becomes a cache key and a query parameter, control characters because
# they reach log lines verbatim.
#
# Deliberately NOT a charset allow-list. Every credential this platform mints
# today is a ``uuid4().hex``, so a hex-only rule would fit, but seeded and
# legacy accounts carry other shapes, and narrowing the charset would lock
# those accounts out to prevent nothing: a key that does not match a stored
# credential already fails the lookup. Guessing at a format the platform never
# promised trades real availability for no security.
#
# A rejected header is treated as an ABSENT one, so the caller falls through to
# its normal "missing credential" path. An oversized header is therefore
# indistinguishable from no header at all, and nothing about this check is
# observable to someone probing.
_MAX_CREDENTIAL_LEN = 256
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


def _usable_credential(raw: object) -> str | None:
    """Return *raw* if it could be one of our credentials, else ``None``.

    Typed ``object``, not ``str | None``, on purpose. These resolvers are also
    invoked DIRECTLY rather than through ``Depends`` (see the call in
    ``chat_routes.get_history_endpoint``), and an argument the caller leaves
    unfilled arrives as a ``fastapi.params.Security`` sentinel, an object that
    is truthy and has no string methods. Treating a non-string as "no
    credential" is both the safe reading and the one that matches how those
    call sites already expect unfilled parameters to behave.
    """
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or len(raw) > _MAX_CREDENTIAL_LEN or _CONTROL_CHARS_RE.search(raw):
        return None
    return raw


# Methods an impersonated session may always use. They cannot mutate the
# customer's Account.
_IMPERSONATION_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Structured 403 detail, matching the ``require_active_subscription`` /
# ``require_verified_email`` contract so the admin app can branch on ``error``
# without parsing English.
_IMPERSONATION_WRITE_DENIED_DETAIL = {
    "error": "impersonation_read_only",
    "message": "This action is not available during a super-admin impersonation session.",
}

_EndpointT = TypeVar("_EndpointT", bound=Callable[..., object])


def impersonation_writable(fn: _EndpointT) -> _EndpointT:
    """Permit this endpoint to be called by an impersonated super-admin session.

    Impersonation is **default-deny** for anything that is not a safe HTTP
    method: without this marker a mutating route is inert under impersonation.
    A denylist would fail *open* (a route added later is permitted until someone
    remembers to list it); this inverts the failure mode.

    MUST be applied BELOW the route decorator, so the router registers the
    already-marked function and the guard can read the attribute back off
    ``request.scope["route"].endpoint``::

        @router.post("/bots/{bot_id}/canned-responses")
        @impersonation_writable
        def create_canned_response(...): ...

    (FastAPI's route decorators happen to return the undecorated function, so
    today the marker survives the other order too, but that is an
    implementation detail of the framework, not a guarantee. Any wrapping
    decorator placed between the two would register a function the marker was
    never set on, and the endpoint would silently stay denied. Keep it below.)
    """
    fn.impersonation_writable = True
    return fn


def find_active_impersonation_token(session: Session, raw_token: str | None) -> ImpersonationToken | None:
    """Return the live ``ImpersonationToken`` for a raw token, else ``None``.

    "Live" means present, not revoked, and not expired, the single predicate
    every impersonation entry point (per-request auth and the redeem endpoint)
    must agree on. Lookup is by sha256 equality on the indexed unique
    ``token_hash`` column, so the raw token is never compared in Python.
    Blank / missing input short-circuits to ``None`` instead of hashing.
    """
    if raw_token is None:
        return None
    raw_token = raw_token.strip()
    if not raw_token:
        return None

    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    return (
        session.execute(
            select(ImpersonationToken).where(
                ImpersonationToken.token_hash == token_hash,
                ImpersonationToken.revoked_at.is_(None),
                ImpersonationToken.expires_at > datetime.now(UTC),
            )
        )
        .scalars()
        .first()
    )


def _enforce_impersonation_write_guard(request: Request, *, actor_id: int, target_id: int) -> bool:
    """Reject a mutating request from an impersonated session (403), fail-closed.

    Returns ``True`` when the request is a **permitted mutation** (so the caller
    must write an audit row), ``False`` for a safe method. Denials raise.

    Safe methods pass unconditionally. Everything else is denied unless the
    matched endpoint carries the :func:`impersonation_writable` marker.

    The matched route is read from ``request.scope["route"]``, which Starlette
    populates before dependencies resolve. (``scope["endpoint"]`` is *not* part
    of the contract we rely on. ``scope["route"].endpoint`` is the function the
    router registered, which is the object the marker was set on.)
    """
    if request.method.upper() in _IMPERSONATION_SAFE_METHODS:
        return False

    endpoint = getattr(request.scope.get("route"), "endpoint", None)
    if getattr(endpoint, "impersonation_writable", False) is True:
        return True

    logger.warning(
        "impersonation_write_denied actor_id=%s target_id=%s method=%s path=%s",
        actor_id,
        target_id,
        request.method,
        request.scope.get("path"),
    )
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=dict(_IMPERSONATION_WRITE_DENIED_DETAIL),
    )


def _resolve_impersonated_client(request: Request, impersonation_token: str) -> Client:
    """Resolve the Account behind an ``X-Impersonation-Token`` header.

    Returns the target ``Client``, detached from its session and tagged with
    ``_impersonator_id`` / ``_impersonation_token_id`` so downstream code (and
    ``record_audit``) can tell "the customer did this" from "an admin did this
    as the customer". Raises 401 when the token is expired, revoked, unknown or
    malformed, and 403 when the request would mutate an unmarked endpoint.

    Two deliberate departures from the ordinary X-API-Key path:

    * ``_ensure_client_authenticatable`` is **not** called. Impersonating a
      suspended or deactivated Account is allowed on purpose (design decision
      D-2). Debugging *why* an Account is suspended is a real support need, and
      the write guard caps the damage.
    * ``api_key`` is scrubbed from the returned instance. It is a permanent,
      unrevocable credential (design constraint 3.1); handing it to a support
      session would outlive the 30-minute window and ignore ``revoked_at``,
      making expiry and revocation decorative. Nothing in the request path may
      echo it back.
    """
    # Kill switch (design §14). Checked before the token lookup so flipping it
    # ends every session already in flight, not just new redemptions, the
    # whole point of an emergency switch. The 401 (rather than 403) is
    # deliberate: the customer app already treats 401 as "session ended" and
    # renders its terminal notice, so an operator flipping this cleanly
    # ejects every impersonated tab instead of leaving dead sessions browsable.
    if not is_impersonation_enabled():
        logger.warning("Rejected an impersonation request: impersonation is disabled.")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=IMPERSONATION_REJECTED_DETAIL,
        )

    with get_session() as session:
        record = find_active_impersonation_token(session, impersonation_token)
        if record is None:
            logger.warning("Rejected an expired, revoked, or unknown impersonation token.")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )

        actor_id = record.actor_id
        target_id = record.target_id
        token_id = record.id

        # Load target AND actor in one round trip, both are needed for the
        # privilege re-checks below, and this keeps the per-request cost at two
        # queries rather than three.
        rows = session.execute(select(Client).where(Client.id.in_({target_id, actor_id}))).scalars().all()
        by_id = {row.id: row for row in rows}
        client = by_id.get(target_id)
        actor = by_id.get(actor_id)

        if client is None:
            logger.warning("Impersonation token %s targets a missing Account %s.", token_id, target_id)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )

        # ── Privilege re-checks, evaluated per request (defence in depth) ──
        #
        # The mint endpoint already refuses to issue a token for a super-admin
        # target, but a point-in-time check at mint is NOT sufficient:
        #
        #   * a target promoted to super-admin AFTER minting would, for the rest
        #     of the 30-minute window, resolve to a super-admin Client, and
        #     ``get_superadmin`` only inspects the RESOLVED client, so the
        #     session would reach ``/superadmin/*``. Every read there is a safe
        #     method, which the write guard waves through by design, so the
        #     escalation hands over the whole platform's data, not one Account.
        #   * token rows predating the mint-time check (or created by any other
        #     path) are not covered by it at all.
        #
        # Re-checking here closes both. Likewise the actor: a super-admin who is
        # demoted or offboarded must not keep acting through tokens they minted
        # while still privileged.
        if client.is_superadmin:
            logger.error(
                "Blocked impersonation token %s: target Account %s is a super-admin (privilege escalation).",
                token_id,
                target_id,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )

        if actor is None or not actor.is_superadmin:
            logger.error(
                "Blocked impersonation token %s: actor %s is no longer a super-admin.",
                token_id,
                actor_id,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )

        # Guard runs after the privilege re-checks so a token that should not
        # exist can never produce an "authorised write" audit row.
        is_permitted_write = _enforce_impersonation_write_guard(request, actor_id=actor_id, target_id=target_id)

        if is_permitted_write:
            # Audit centrally, here, rather than per-endpoint. The design's
            # compensating control for allowing writes at all is that every one
            # of them is attributable to the super-admin who made it, and a
            # per-route ``record_audit`` call is exactly the kind of thing that
            # gets forgotten on the next endpoint someone marks writable. This
            # sits on the one code path every permitted mutation must traverse,
            # so coverage is structural instead of conventional.
            #
            # Timing caveat, stamped into the row as ``phase``: this commits
            # during dependency resolution, BEFORE the endpoint's own authz
            # (ownership, plan gating, 404s) or business logic runs. It is
            # therefore a record that the write was AUTHORIZED to proceed, not
            # proof it succeeded, an endpoint that subsequently 403s/404s or
            # rolls back still leaves this row. Recording post-hoc instead
            # would under-report (a handler crash after mutating state loses
            # the trail entirely), which is the worse failure for the control
            # this exists to be. Readers answering "what did this admin
            # actually change" must join against the endpoint's own audit
            # rows / state, not treat ``phase=authorized`` as a completed
            # mutation.
            record_audit(
                session,
                actor=actor,
                action="impersonation.write",
                target_type="client",
                target_id=target_id,
                after={
                    "method": request.method.upper(),
                    "path": request.scope.get("path"),
                    "impersonated_client_id": target_id,
                    "impersonation_token_id": token_id,
                    "phase": "authorized",
                },
                request=request,
            )
            session.commit()

        # Eagerly access attributes before the session closes.
        _ = (
            client.id,
            client.name,
            client.email,
            client.is_superadmin,
            client.suspended_at,
            client.deactivated_at,
        )
        session.expunge(client)

    # Mutate only after detaching, so the scrubbed api_key can never be flushed
    # back onto the customer's row.
    client.api_key = None
    client._impersonator_id = actor_id
    client._impersonation_token_id = token_id
    return client


def _resolve_operator_key(
    operator_key: str | None,
    legacy_agent_key: str | None,
) -> str | None:
    """Return the effective operator key, preferring the new header over the legacy one."""
    return operator_key or legacy_agent_key


def _parse_workspace_id(raw: str | None) -> int | None:
    """Coerce the X-Workspace-Id header to an int; ``None`` if absent or malformed.

    Malformed values are treated as absent (legacy behavior) rather than 4xx so
    a bugged frontend doesn't hard-fail every API call, the downstream check
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
    out of the console, so they are exempt even in the defensive case where a
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


def _ensure_not_deactivated(client: Client) -> None:
    """Reject a deactivated client with HTTP 403 ``account_deleted``.

    ``Client.deactivated_at`` is stamped by ``task_delete_expired_trial_data``
    once the 15-day post-trial retention window elapses without an upgrade.
    At that point the workspace's bots, documents, and chat history have all
    been hard-deleted; the Client row is kept only for support / audit.
    Letting the customer authenticate past that point drops them into a
    ghost dashboard with no way back. Friendlier to fail closed here with a
    clear reason the frontend can render ("your account was deleted; please
    contact support to restore or start a new signup").

    Superadmins are exempt for the same reason as suspension. They are
    platform staff, not customers, and must never be locked out.
    """
    if getattr(client, "is_superadmin", False):
        return
    if getattr(client, "deactivated_at", None) is not None:
        logger.warning("Deactivated client %s attempted authentication.", getattr(client, "id", None))
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="account_deleted",
        )


def _ensure_client_authenticatable(client: Client) -> None:
    """One-call funnel for every reason a client row must be rejected at auth.

    Callers assume the client has been fetched from a live session and the
    relevant status columns (``suspended_at``, ``deactivated_at``) were
    eagerly loaded before session-close, so no lazy-load hits DetachedInstance.
    Superadmin exemption is delegated to the individual checkers.
    """
    _ensure_not_suspended(client)
    _ensure_not_deactivated(client)


def get_current_client(
    request: Request,
    api_key: str = Security(api_key_header),
    operator_key: str = Security(operator_key_header),
    legacy_agent_key: str = Security(legacy_agent_key_header),
    impersonation_token: str = Security(impersonation_token_header),
):
    """
    Dependency: Authenticate a Client via X-API-Key header.
    Also accepts:
    - X-Operator-Key / X-Agent-Key: resolves the operator's workspace Client.
    - X-Impersonation-Token: resolves a super-admin support session to the
      impersonated Account. It takes precedence over every other credential,
      the frontend sends only one, and the backend is explicit so the ambiguity
      has a defined answer.

    The public ``X-Bot-Key`` header is intentionally NOT accepted here. Bot keys
    are embedded in widget script tags and visible to every site visitor, so they
    must never resolve to a Client identity. Widget-facing endpoints use
    ``get_current_bot`` instead; admin-only endpoints requiring strict client
    auth should use ``get_current_client_strict``.
    """
    # Header credentials get no schema validation. Normalise every one to a
    # usable shape (or None) before it reaches a query, a cache key or a log
    # line. See ``_usable_credential``.
    api_key = _usable_credential(api_key)
    operator_key = _usable_credential(operator_key)
    legacy_agent_key = _usable_credential(legacy_agent_key)
    impersonation_token = _usable_credential(impersonation_token)
    if impersonation_token:
        return _resolve_impersonated_client(request, impersonation_token)

    effective_operator_key = _resolve_operator_key(operator_key, legacy_agent_key)

    with get_session() as session:
        # Primary: resolve via X-API-Key (permanent api_key UUID).
        if api_key:
            stmt = select(Client).where(Client.api_key == api_key)
            client = session.execute(stmt).scalars().first()
            if client:
                # Eagerly access attributes before session closes
                _ = (
                    client.id,
                    client.name,
                    client.email,
                    client.api_key,
                    client.is_superadmin,
                    client.suspended_at,
                    client.deactivated_at,
                )
                _ensure_client_authenticatable(client)
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
                    _ = (
                        client.id,
                        client.name,
                        client.email,
                        client.api_key,
                        client.is_superadmin,
                        client.suspended_at,
                        client.deactivated_at,
                    )
                    _ensure_client_authenticatable(client)
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
    # Header credentials get no schema validation. Normalise every one to a
    # usable shape (or None) before it reaches a query, a cache key or a log
    # line. See ``_usable_credential``.
    operator_key = _usable_credential(operator_key)
    legacy_agent_key = _usable_credential(legacy_agent_key)
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
    request: Request,
    api_key: str = Security(api_key_header),
    operator_key: str = Security(operator_key_header),
    legacy_agent_key: str = Security(legacy_agent_key_header),
    workspace_id_raw: str = Security(workspace_id_header),
    impersonation_token: str = Security(impersonation_token_header),
):
    """
    Dependency: Authenticate via X-API-Key (Client) or X-Operator-Key (Operator).
    Returns a dict with 'type' ('client'|'operator'), the entity, and 'client_id'.
    Used by endpoints that both admins and operators can access.

    An ``X-Impersonation-Token`` takes precedence over both and always presents
    as ``type="client"``. Impersonating an Operator is out of scope, so a
    support session always acts as the Account owner.

    Workspace-aware routing
    -----------------------
    When called with ``X-API-Key`` AND ``X-Workspace-Id`` naming a workspace that
    is NOT the caller's own, the resolver looks up the caller's linked-operator
    row for that workspace and returns ``type="operator"`` scoped to it. This
    lets one Client identity act as an operator in another workspace via the
    invite flow, while every existing endpoint that scopes on ``auth["client_id"]``
    continues to work unchanged, the workspace's owner id lands there.

    Legacy ``X-Operator-Key`` sessions ignore ``X-Workspace-Id`` (they're
    implicitly scoped to their one workspace). ``X-API-Key`` sessions without
    an ``X-Workspace-Id`` header default to the caller's own workspace.
    """
    # Header credentials get no schema validation. Normalise every one to a
    # usable shape (or None) before it reaches a query, a cache key or a log
    # line. See ``_usable_credential``.
    api_key = _usable_credential(api_key)
    operator_key = _usable_credential(operator_key)
    legacy_agent_key = _usable_credential(legacy_agent_key)
    impersonation_token = _usable_credential(impersonation_token)
    if impersonation_token:
        client = _resolve_impersonated_client(request, impersonation_token)
        return {
            "type": "client",
            "entity": client,
            "client_id": client.id,
            "operator_id": None,
        }

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
                    operator.bot_id,
                    operator.role,
                    operator.department_id,
                    operator.operator_api_key,
                    operator.is_online,
                )
                # An operator's access is governed by the owning client's
                # standing, a suspended workspace locks out its operators too.
                owner = session.execute(select(Client).where(Client.id == operator.client_id)).scalars().first()
                if owner is not None:
                    _ = owner.id, owner.is_superadmin, owner.suspended_at, owner.deactivated_at
                    _ensure_client_authenticatable(owner)
                session.expunge(operator)
                return {
                    "type": "operator",
                    "entity": operator,
                    "client_id": operator.client_id,
                    "operator_id": operator.id,
                    # Operator↔bot one-to-one binding. Downstream routes use
                    # it to scope bot lists, chat routing, and accept guards.
                    "bot_id": operator.bot_id,
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
            _ = (
                client.id,
                client.name,
                client.email,
                client.api_key,
                client.is_superadmin,
                client.suspended_at,
                client.deactivated_at,
            )
            _ensure_client_authenticatable(client)

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

            # Cross-workspace request. Validate the caller has a linked-operator
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

            # Workspace owner's standing gates every operator's access, a
            # suspended workspace locks out its linked operators too.
            owner = session.execute(select(Client).where(Client.id == requested_workspace_id)).scalars().first()
            if owner is not None:
                _ = owner.id, owner.is_superadmin, owner.suspended_at, owner.deactivated_at
                _ensure_client_authenticatable(owner)

            _ = (
                operator.id,
                operator.name,
                operator.email,
                operator.client_id,
                operator.bot_id,
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
                # Workspace's owning client_id. Every existing downstream query
                # that scopes ``WHERE ... client_id = auth["client_id"]`` keeps
                # working transparently.
                "client_id": requested_workspace_id,
                "operator_id": operator.id,
                # Operator↔bot one-to-one binding. Downstream routes use it to
                # scope bot lists, chat routing, and accept guards.
                "bot_id": operator.bot_id,
                # New: the underlying Client identity, useful for auditing and
                # for cache-key invalidation across workspaces.
                "linked_client_id": client.id,
            }

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing authentication. Provide X-API-Key or X-Operator-Key header.",
    )


def get_current_client_strict(
    request: Request,
    api_key: str = Security(api_key_header),
    impersonation_token: str = Security(impersonation_token_header),
):
    """
    Dependency: Authenticate a Client via X-API-Key ONLY.
    Does NOT fall back to X-Bot-Key or X-Operator-Key.
    Use this for admin-only endpoints (billing, subscription, sensitive account settings)
    where operator access must be explicitly blocked.

    An ``X-Impersonation-Token`` is accepted here too, and takes precedence over
    ``X-API-Key``: strict auth exists to exclude *operator* and *bot* keys, not
    to exclude super-admin support sessions. The write guard still applies, so
    the sensitive mutations these routes carry stay denied unless explicitly
    marked with :func:`impersonation_writable`.
    """
    # Header credentials get no schema validation. Normalise every one to a
    # usable shape (or None) before it reaches a query, a cache key or a log
    # line. See ``_usable_credential``.
    api_key = _usable_credential(api_key)
    impersonation_token = _usable_credential(impersonation_token)
    if impersonation_token:
        return _resolve_impersonated_client(request, impersonation_token)

    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-API-Key header. This endpoint requires account (admin) authentication.",
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
        _ = (
            client.id,
            client.name,
            client.email,
            client.api_key,
            client.is_superadmin,
            client.suspended_at,
            client.deactivated_at,
        )
        _ensure_client_authenticatable(client)
        session.expunge(client)
        return client


def get_superadmin(client: Client = Depends(get_current_client_strict)):
    """
    Dependency: Ensure authenticated Client is a Superadmin.

    Uses ``get_current_client_strict`` (X-API-Key only). NOT ``get_current_client``.
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

    Uses ``get_current_client_strict`` (X-API-Key only). Bot keys and
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
        # Quotation catalog — the admin-defined service list + BANT trigger for
        # the pre-handoff quote flow. Omitting it here silently strips the
        # column on every cache hit, which flips ``catalog.enabled`` to False
        # in quotation_routes and the widget's quote card never fires (root
        # cause of the "quote not showing" bug tracked to 2026-08-22).
        "quotation_catalog": bot.quotation_catalog,
        "avatar_type": bot.avatar_type,
        "orb_color": bot.orb_color,
        "lead_form_enabled": bot.lead_form_enabled,
        "lead_form_fields": bot.lead_form_fields,
        # The two metered-enrichment toggles. Omitting them here does NOT fall
        # back to the column default: `_bot_from_cache_dict` builds a bare
        # `Bot()`, and SQLAlchemy's `default=True` is an INSERT-time default,
        # so an unserialized attribute is None and `bool(None)` is False. Every
        # cache hit on GET /bot/settings would report both switches OFF, for a
        # customer whose database row says ON, with no TTL at which it corrects
        # itself.
        "email_verification_enabled": bot.email_verification_enabled,
        "company_lookup_enabled": bot.company_lookup_enabled,
        # Three more the public settings endpoint publishes and this dict
        # forgot, found by the round-trip test rather than by inspection:
        #  * calcom_url, the widget's meeting-booking link simply vanishes on
        #    every cache hit.
        #  * widget_installed_at. Read as None forever, so the install-stamp
        #    branch in get_bot_settings_public fires on EVERY external-origin
        #    widget load, issuing a pointless UPDATE + commit on the hottest
        #    endpoint in the product. Its comment claims the cache
        #    invalidation makes later loads skip it; that was never true,
        #    because the field was never cached.
        "calcom_url": bot.calcom_url,
        "widget_installed_at": bot.widget_installed_at.isoformat() if bot.widget_installed_at else None,
        # Widget liveness heartbeat. Cached alongside ``widget_installed_at``
        # so a cache hit serves the same install picture the DB holds. Neither
        # gates anything on the widget path: the heartbeat's own throttle is a
        # Redis key, not this value, so a stale read here cannot cause an extra
        # write. ``widget_last_seen_at`` must also appear in
        # ``_CACHED_DATETIME_FIELDS`` or it round-trips as a string.
        #
        # Read through ``getattr`` with a default, like ``session_share_domain``
        # and ``answer_links`` below, because this function does not only see
        # freshly-loaded ORM rows. It also re-serializes bots rebuilt by
        # ``_bot_from_cache_dict`` and lightweight stand-ins, neither of which
        # carries a column added after the entry was written. A bare attribute
        # read would raise on exactly the deploy this column ships in — every
        # warm pre-deploy cache entry — and it would raise on the widget
        # bootstrap path, i.e. a 500 for live visitors.
        "widget_last_seen_at": (
            _seen.isoformat() if (_seen := getattr(bot, "widget_last_seen_at", None)) is not None else None
        ),
        "widget_last_origin": getattr(bot, "widget_last_origin", None),
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
        "language_config": getattr(bot, "language_config", None),
        "widget_messages": bot.widget_messages,
        "widget_config": bot.widget_config,
        "branding_text": bot.branding_text,
        "branding_url": bot.branding_url,
        "is_active": bot.is_active,
        "recommended_colors": bot.recommended_colors,
        "allowed_domains": list(bot.allowed_domains or []),
        "domain_check_enabled": bool(bot.domain_check_enabled),
        "session_share_domain": getattr(bot, "session_share_domain", None),
        # Smart-link keyword→URL map. Cached so the public settings endpoint can
        # publish `smart_link_urls` on a cache hit; without it every cached load
        # reports an empty list and the widget's "don't re-link a clicked smart
        # link" behaviour silently never engages.
        "answer_links": getattr(bot, "answer_links", None),
        "created_at": bot.created_at.isoformat() if bot.created_at else None,
    }


_CACHED_DATETIME_FIELDS = frozenset({"created_at", "widget_installed_at", "widget_last_seen_at"})


def _bot_from_cache_dict(data: dict) -> Bot:
    """Reconstruct a detached Bot object from a cached dict."""
    from datetime import datetime

    bot = Bot()
    for key, value in data.items():
        # Datetimes are stored ISO-encoded (cache_set JSON-dumps with
        # default=str, so an un-encoded datetime would come back as a string
        # anyway. Being explicit on both sides keeps the round trip typed).
        if key in _CACHED_DATETIME_FIELDS and isinstance(value, str):
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
    enabled = bool(getattr(bot, "domain_check_enabled", False))
    if not enabled:
        return
    if request is None:
        # Defensive: dependencies are always called with a Request, but if a
        # caller invokes get_current_bot programmatically without one we still
        # fail closed rather than silently allowing the request.
        #
        # Deliberately ordered BEFORE the allowlist check, as it always has
        # been: a programmatic call with the flag set is a caller bug and must
        # not benefit from the empty-allowlist fail-open.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="origin_not_allowed",
        )

    allowed: list[str] = list(getattr(bot, "allowed_domains", None) or [])
    if not origin_check_applies(domain_check_enabled=enabled, allowed=allowed):
        # Fail-open on an empty allowlist: enforcement only bites when an
        # allowlist is actually configured. This lets us default the flag ON
        # for new bots (and backfill it for configured ones) without bricking
        # any bot that has ``domain_check_enabled`` set but no domains listed.
        # The condition lives in ``origin_check_applies`` so the visitor
        # WebSocket decides this identically.
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
    """Reject a widget request whose owning client is suspended or
    deactivated (403).

    ``get_current_bot`` runs on the hot chat path, so this adds one narrow
    ``suspended_at`` / ``deactivated_at`` / ``is_superadmin`` lookup keyed
    by ``client_id`` rather than loading the whole Client row. A missing
    owner (client row already purged) is treated as not-suspended, the
    surrounding bot lookup already validated the bot exists, and the
    hard-delete cron leaves the Client row in place anyway.
    """
    owner = (
        session.execute(
            select(Client.is_superadmin, Client.suspended_at, Client.deactivated_at).where(Client.id == client_id)
        )
        .tuples()
        .first()
    )
    if owner is None:
        return
    _ensure_client_authenticatable(
        SimpleNamespace(
            id=client_id,
            is_superadmin=owner[0],
            suspended_at=owner[1],
            deactivated_at=owner[2],
        )
    )


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
    # Header credentials get no schema validation. Normalise every one to a
    # usable shape (or None) before it reaches a query, a cache key or a log
    # line. See ``_usable_credential``.
    bot_key = _usable_credential(bot_key)
    api_key = _usable_credential(api_key)
    # Fast path: check Redis cache for bot_key lookups
    if bot_key:
        cached = cache_get(bot_config_key(bot_key))
        if cached:
            bot = _bot_from_cache_dict(cached)
            # Enforce owner suspension even on cache hits, a suspended customer's
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
                _ = client.id, client.is_superadmin, client.suspended_at, client.deactivated_at
                _ensure_client_authenticatable(client)
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
                # No bot exists. Client hasn't created one yet (expected for new accounts)
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="No active bot found. Please create an AI chatbot first.",
                )

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Bot-Key or X-API-Key header.",
        )


def _resolve_preview_client(
    session: Session,
    api_key: str | None,
    impersonation_token: str | None,
) -> Client:
    """Resolve the owning Client for an owner-preview chat request.

    Accepts either the owner's own ``X-API-Key`` or a live impersonation
    token. The impersonated path exists so a super-admin debugging an Account
    can actually exercise its AI Agent, the most common support question on a
    chatbot platform is "why did it answer that?", which is unanswerable
    without sending a message.

    This is the ONLY chat path an impersonated caller may take. It is safe
    precisely because the returned bot carries ``_is_preview``, so the reply
    skips credit deduction entirely: it cannot spend the Account's money. The
    paid widget path on the same endpoint stays unreachable, the impersonation
    token is deliberately never forwarded to :func:`get_current_bot`.

    Suspension is enforced for a real owner but deliberately NOT for an
    impersonated super-admin (design decision D-2): debugging *why* an Account
    is suspended is a core support need, and a preview reply costs nothing.
    """
    if impersonation_token:
        # Kill switch (design §14), the preview path is a second entry point
        # into impersonation and must honour it too.
        if not is_impersonation_enabled():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )
        record = find_active_impersonation_token(session, impersonation_token)
        if not record:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )
        client = session.execute(select(Client).where(Client.id == record.target_id)).scalars().first()
        if not client:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Bot not found or does not belong to your account.",
            )
        _ = client.id, client.is_superadmin, client.suspended_at

        # Same per-request privilege re-checks as ``_resolve_impersonated_client``
        # . This is a second entry point into impersonation and a mint-time
        # check cannot cover a target promoted mid-session, a legacy token row,
        # or an actor demoted after minting.
        if client.is_superadmin:
            logger.error(
                "Blocked impersonated preview: target Account %s is a super-admin.",
                record.target_id,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )

        actor = session.execute(select(Client).where(Client.id == record.actor_id)).scalars().first()
        if actor is None or not actor.is_superadmin:
            logger.error(
                "Blocked impersonated preview: actor %s is no longer a super-admin.",
                record.actor_id,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=IMPERSONATION_REJECTED_DETAIL,
            )
        return client

    client = session.execute(select(Client).where(Client.api_key == api_key)).scalars().first()
    if not client:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Bot not found or does not belong to your account.",
        )
    _ = client.id, client.is_superadmin, client.suspended_at
    _ensure_not_suspended(client)
    return client


def get_bot_for_chat(
    request: Request,
    preview: bool = Query(False, description="Owner-preview mode (Build Studio)"),
    bot_id: RowId | None = Query(None, description="Bot ID (owner-preview only)"),
    bot_key: str = Security(bot_key_header),
    api_key: str = Security(api_key_header),
    impersonation_token: str = Security(impersonation_token_header),
):
    """Resolve the Bot for a chat request, with an optional owner-preview branch.

    Default behaviour is identical to :func:`get_current_bot` (widget path:
    X-Bot-Key with origin enforcement, or X-API-Key → default bot). The chat
    endpoints depend on this instead of ``get_current_bot`` so a logged-in
    client can test *any of their own bots* from the dashboard's Build Studio:

    When ``preview`` is true AND ``bot_id`` is given AND the caller presents an
    owner credential, either ``X-API-Key`` or a live ``X-Impersonation-Token``
    (see :func:`_resolve_preview_client`), the bot is resolved by id and its
    owner asserted to be that client (404 otherwise). The origin/``allowed_domains`` check
    is intentionally skipped (the caller is the authenticated owner, not an
    anonymous widget visitor) and the returned bot carries ``_is_preview =
    True`` so the chat endpoints can serve the reply for free (no credit
    deduction). Every other request falls through to ``get_current_bot``
    unchanged, so existing (non-preview) widget traffic is unaffected.
    """
    # Header credentials get no schema validation. Normalise every one to a
    # usable shape (or None) before it reaches a query, a cache key or a log
    # line. See ``_usable_credential``.
    bot_key = _usable_credential(bot_key)
    api_key = _usable_credential(api_key)
    impersonation_token = _usable_credential(impersonation_token)
    if preview and bot_id is not None and (api_key or impersonation_token):
        with get_session() as session:
            client = _resolve_preview_client(session, api_key, impersonation_token)

            bot = session.execute(select(Bot).where(Bot.id == bot_id, Bot.client_id == client.id)).scalars().first()
            if not bot:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Bot not found or does not belong to your account.",
                )

            # Eager-load the same attributes get_current_bot does before detaching,
            # so the RAG pipeline can read them after the session closes.
            _ = bot.id, bot.name, bot.system_prompt, bot.client_id, bot.bot_key
            _ = bot.primary_color, bot.header_color, bot.background_color
            _ = bot.bot_logo, bot.launcher_name, bot.launcher_logo
            _ = bot.allowed_domains, bot.domain_check_enabled
            # Pre-resolve the ledger scope exactly like get_current_bot so credit
            # routing never lazy-loads bot.subscription on a detached object,
            # even though preview replies skip deduction, downstream code that
            # inspects _subscription_bot_id stays consistent.
            if bot.subscription_id:
                bot._subscription_bot_id = session.scalar(
                    select(Subscription.bot_id).where(Subscription.id == bot.subscription_id)
                )
            else:
                bot._subscription_bot_id = None
            session.expunge(bot)
            # Owner-preview: origin check is bypassed (no _enforce_bot_origin) and
            # the reply is free.
            bot._is_preview = True
            return bot

    return get_current_bot(request, bot_key, api_key)


def get_client_bot(
    bot_id: RowId = Query(..., description="Bot ID"),
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
# paying customer can. ``past_due`` is intentionally treated as "active".
# We don't yank functionality the moment a card retry fails; the dunning
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
    must NOT depend on this. Pair it only with explicitly gated routes.
    """
    # Superadmins are platform staff, not customers. They never need a
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
        # resolver (remediation H2). Reuse it so the gate agrees with the rest
        # of the billing stack.
        sub = plan_service.get_client_subscription(session, client.id)

        # No subscription at all is treated as "needs to pick a plan",
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
    governed by the *owner's* subscription state. When the owner's trial
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
        # Same active-row resolution as :func:`require_active_subscription`,
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


# ── Email-verification gate (B2) ────────────────────────────────────────────
# Defers (never walls) a small set of sensitive mutations until the account
# proves ownership of its email. Onboarding (bot create, crawl, ingest, chat)
# and all reads stay open so an unverified user can still explore and reach the
# billing/upgrade prompts; only the money-committing checkout and the outbound
# invite-send are held back. Structured 403 detail mirrors the
# ``require_active_subscription`` contract so the dashboard routes every gate
# failure through one flow.

_EMAIL_VERIFICATION_REQUIRED_DETAIL = {
    "error": "email_verification_required",
    "message": "Please verify your email to continue.",
    "verify_url": "/verify-email",
}


def require_verified_email(client: Client = Depends(get_current_client_strict)) -> Client:
    """Dependency: gate a sensitive mutation behind a verified email.

    Strict (``X-API-Key`` only) variant, for routes whose client is already
    resolved via :func:`get_current_client_strict`. Returns the client so a
    handler can reuse it; raises a structured ``403 email_verification_required``
    for an un-verified account.
    """
    # Superadmins are platform staff and may be provisioned outside the
    # email-verify OAuth path (``is_verified`` never flipped), never 403 them,
    # mirroring the bypass in :func:`require_verified_email_for_workspace`.
    if getattr(client, "is_superadmin", False):
        return client
    if not client.is_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=dict(_EMAIL_VERIFICATION_REQUIRED_DETAIL),
        )
    return client


def require_verified_email_for_workspace(
    auth: dict = Depends(get_current_client_or_operator),
) -> None:
    """Workspace-aware variant of :func:`require_verified_email`.

    Endpoints that accept both client (``X-API-Key``) and operator
    (``X-Operator-Key``) callers gate on the *workspace owner's* email
    verification: an operator can only act while the owning client's email is
    verified. Mirrors :func:`require_active_subscription_for_workspace` so an
    or-operator route is never accidentally narrowed to X-API-Key-only auth.
    """
    # Superadmin clients bypass the gate (platform staff). Short-circuit before
    # any DB lookup, matching the subscription workspace gate.
    if auth["type"] == "client":
        client = auth["entity"]
        if getattr(client, "is_superadmin", False):
            return None

    client_id = auth["client_id"]
    with get_session() as session:
        owner = session.get(Client, client_id)
        if owner is None or not owner.is_verified:
            logger.info(
                "workspace_email_gate_denied client_id=%s actor=%s",
                client_id,
                auth["type"],
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=dict(_EMAIL_VERIFICATION_REQUIRED_DETAIL),
            )
    return None


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
