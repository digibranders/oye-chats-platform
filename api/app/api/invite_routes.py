"""Operator-invite endpoints + workspace-membership discovery.

Two responsibilities:

1. **Invite CRUD** — owners and admins create, list, resend, revoke invites
   for their workspace. Public airlock endpoints let the invitee view invite
   metadata by token and accept once authenticated as a Client.

2. **``GET /me/workspaces``** — returns every workspace the caller can act in
   (owned + linked-operator memberships). The frontend uses this to populate
   the workspace switcher.

RBAC + guardrails live in :mod:`app.services.invite_service`; this file is
strictly transport (HTTP → service call → JSON) with error translation.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, StringConstraints
from slowapi.util import get_remote_address
from sqlalchemy import func, select

from app.api.auth import (
    get_current_client,
    get_current_client_or_operator,
    get_current_client_strict,
    require_verified_email_for_workspace,
)
from app.config import APP_ENV, EMAIL_ENABLED, FRONTEND_URL
from app.core.rate_limit import limiter
from app.db.models import Bot, Client, Operator, OperatorInvite
from app.db.session import get_session
from app.schemas.validators import EmailAddress, RowId
from app.services import invite_service, plan_entitlements_service
from app.services.email_service import send_operator_invite_email
from app.services.invite_service import InviteError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/invites", tags=["invites"])
me_router = APIRouter(prefix="/me", tags=["me"])


# Matches the same simple pattern used in ``offline_message_routes.py`` — the
# ``EmailStr`` pydantic type would require the ``email-validator`` dep which
# isn't installed in this project, so we hand-roll a lightweight equivalent.
# Plaintext invite token as it appears in the emailed URL: 256 bits of
# ``secrets.token_urlsafe`` entropy, so a fixed charset and a tight ceiling.
# Both endpoints that take it are unauthenticated, and the bound applies
# before the database lookup runs.
InviteToken = Annotated[str, StringConstraints(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_\-]+$")]


# ── Request / response models ──────────────────────────────────────────────


class CreateInviteRequest(BaseModel):
    email: EmailAddress
    bot_id: RowId
    role: Literal["operator", "admin"] = "operator"
    department_id: RowId | None = None


class InviteView(BaseModel):
    id: int
    email: str
    role: str
    bot_id: int
    department_id: int | None
    status: str
    created_at: datetime
    expires_at: datetime
    invited_by_name: str | None
    resend_count: int
    sent_at: datetime | None
    accepted_at: datetime | None
    revoked_at: datetime | None


class InviteCreatedResponse(BaseModel):
    invite: InviteView


class PublicInviteView(BaseModel):
    """Metadata surfaced to the (unauthenticated) airlock page.

    Deliberately narrow: workspace name + inviter display name + status +
    target email. No IDs, no tokens, no personal data beyond what the invitee
    already knows (their own email).
    """

    email: str
    workspace_name: str
    inviter_name: str | None
    role: str
    status: str
    expires_at: datetime | None


class WorkspaceView(BaseModel):
    id: int
    name: str
    role: Literal["owner", "operator"]
    # ``operator_role``: the granular role attached to a linked-operator row
    # ("operator" / "admin" / "owner"); ``None`` when the caller is the actual
    # workspace owner (their client identity, not an operator record).
    operator_role: str | None = None
    bot_count: int = 0


class MeWorkspacesResponse(BaseModel):
    workspaces: list[WorkspaceView]


class SelfOperatorRequest(BaseModel):
    """Body for ``POST /me/self-operator``.

    ``bot_id`` is required because operators are bot-scoped — the owner must
    pick which bot they'll take chats for. Reactivating a previously-added
    self-op row with a different ``bot_id`` reassigns it.
    """

    bot_id: RowId


class SelfOperatorResponse(BaseModel):
    """Response for ``POST /me/self-operator`` — the owner-as-operator row."""

    operator_id: int
    role: str
    bot_id: int
    is_active: bool
    # ``was_existing`` = True when the endpoint reactivated a previously
    # self-added row instead of creating a fresh one. Frontend can use it to
    # toast "Welcome back to live chat" vs "You're now taking live chats."
    was_existing: bool


# ── Helpers ────────────────────────────────────────────────────────────────


def _accept_url_for_token(plaintext_token: str) -> str:
    """Build the fully-qualified airlock URL for the given plaintext token.

    Uses ``FRONTEND_URL`` from config which defaults to ``http://localhost:5174``
    in dev — so an invite link the developer generates locally opens the
    local dashboard, not production.
    """
    base = FRONTEND_URL.rstrip("/")
    return f"{base}/invite/{plaintext_token}"


def _dispatch_invite_email(
    *,
    target_email: str,
    accept_url: str,
    workspace_name: str,
    inviter_name: str | None,
    invite_id: RowId,
) -> None:
    """Fire the invite email through Brevo. Fire-and-forget.

    A Brevo failure never rolls back the invite row — the invite stays valid
    and the owner can Resend to regenerate the email. When Brevo isn't
    configured (``EMAIL_ENABLED = False``) the email service already
    short-circuits and logs a WARN, so no extra guard is needed here.

    Non-production runs also print the accept URL to the API terminal so a
    developer can grab it if their Brevo inbox is filtered or unavailable.
    Guarded by ``APP_ENV`` so single-use plaintext tokens never land in
    production log files.
    """
    if APP_ENV != "production":
        logger.info(
            "[dev] invite %s accept_url=%s (email %s)",
            invite_id,
            accept_url,
            "sending via Brevo" if EMAIL_ENABLED else "SKIPPED — no BREVO_API_KEY",
        )

    try:
        send_operator_invite_email(
            target_email,
            accept_url,
            workspace_name=workspace_name,
            inviter_name=inviter_name,
            expires_in_days=7,
        )
    except Exception:
        logger.exception(
            "Failed to send invite email — invite %s created but email did not go out",
            invite_id,
        )


def _invite_to_view(invite: OperatorInvite) -> InviteView:
    return InviteView(
        id=invite.id,
        email=invite.email,
        role=invite.role,
        bot_id=invite.bot_id,
        department_id=invite.department_id,
        status=invite.status,
        created_at=invite.created_at,
        expires_at=invite.expires_at,
        invited_by_name=invite.invited_by_name,
        resend_count=invite.resend_count,
        sent_at=invite.sent_at,
        accepted_at=invite.accepted_at,
        revoked_at=invite.revoked_at,
    )


def _map_invite_error(err: InviteError) -> HTTPException:
    """Translate an ``InviteError`` to a structured HTTP response the frontend
    can branch on without parsing English."""
    return HTTPException(
        status_code=err.status_code,
        detail={"error": err.code, "message": err.message},
    )


# ── Owner-facing endpoints ─────────────────────────────────────────────────


@router.post("", response_model=InviteCreatedResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("15/hour")
def create_invite(
    request: Request,  # noqa: ARG001 — required by SlowAPI decorator
    body: CreateInviteRequest,
    auth: dict = Depends(get_current_client_or_operator),
    _verified: None = Depends(require_verified_email_for_workspace),
):
    """Send an invitation to join the caller's workspace as an operator."""
    workspace_id: int = auth["client_id"]
    # The acting Client identity is either the workspace owner (``type=client``)
    # or a linked operator (``type=operator`` with a Client behind them, resolved
    # via linked_client_id). Both cases route through invite_service.
    with get_session() as session:
        if auth["type"] == "client":
            actor = auth["entity"]
            # Re-attach to this session so relationship reads work (auth entities
            # come back detached from their own transient session).
            actor = session.get(Client, actor.id)
        else:
            linked_id = auth.get("linked_client_id") or auth["entity"].linked_client_id
            if linked_id is None:
                # A legacy operator (own password, no linked Client identity) can
                # still be an admin — but they can't send invites in v1 because
                # we need a Client identity to attribute the invite to.
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "error": "legacy_operator_cannot_invite",
                        "message": (
                            "Legacy operator accounts can't send invites. Ask the workspace owner to send them instead."
                        ),
                    },
                )
            actor = session.get(Client, linked_id)
            if actor is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Actor not found.")

        try:
            invite, plaintext_token = invite_service.create_invite(
                session,
                workspace_id=workspace_id,
                email=str(body.email),
                role=body.role,
                bot_id=body.bot_id,
                department_id=body.department_id,
                invited_by=actor,
            )
        except InviteError as err:
            raise _map_invite_error(err) from err

        # Snapshot every field we need OUTSIDE the session. After ``commit()``
        # + block exit the ORM instances are detached; accessing lazy fields
        # (``actor.name``, ``invite.email``, etc.) would trigger a refresh
        # against a closed session and raise DetachedInstanceError.
        view = _invite_to_view(invite)
        workspace_name = _resolve_workspace_name(session, workspace_id)
        actor_name = actor.name
        target_email = invite.email
        session.commit()

    # Fire the email OUTSIDE the DB transaction — Brevo failures must never
    # roll back an accepted invite row.
    accept_url = _accept_url_for_token(plaintext_token)
    _dispatch_invite_email(
        target_email=target_email,
        accept_url=accept_url,
        workspace_name=workspace_name,
        inviter_name=actor_name,
        invite_id=view.id,
    )

    return InviteCreatedResponse(invite=view)


@router.get("", response_model=list[InviteView])
def list_invites(
    status_filter: Literal["pending", "accepted", "revoked", "expired", "all"] | None = None,
    auth: dict = Depends(get_current_client_or_operator),
):
    """List invites for the caller's workspace.

    Restricted to owners + admins (invite RBAC). Regular operators cannot
    enumerate pending invites.
    """
    workspace_id: int = auth["client_id"]
    with get_session() as session:
        actor = _resolve_actor_client(session, auth)
        try:
            invite_service._require_manager_role(session, actor, workspace_id)  # noqa: SLF001
        except InviteError as err:
            raise _map_invite_error(err) from err

        query = select(OperatorInvite).where(OperatorInvite.client_id == workspace_id)
        if status_filter and status_filter != "all":
            query = query.where(OperatorInvite.status == status_filter)
        rows = session.execute(query.order_by(OperatorInvite.created_at.desc())).scalars().all()
        return [_invite_to_view(r) for r in rows]


@router.post("/{invite_id}/resend", response_model=InviteCreatedResponse)
@limiter.limit("10/hour")
def resend_invite(
    request: Request,  # noqa: ARG001
    invite_id: RowId,
    auth: dict = Depends(get_current_client_or_operator),
    _verified: None = Depends(require_verified_email_for_workspace),
):
    """Rotate the invite's token and resend the email."""
    workspace_id: int = auth["client_id"]
    with get_session() as session:
        actor = _resolve_actor_client(session, auth)
        invite = session.get(OperatorInvite, invite_id)
        if invite is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "invite_not_found", "message": "Invite not found."},
            )
        try:
            plaintext_token = invite_service.resend_invite(session, invite, actor, workspace_id)
        except InviteError as err:
            raise _map_invite_error(err) from err
        view = _invite_to_view(invite)
        workspace_name = _resolve_workspace_name(session, workspace_id)
        # Snapshot every field we need OUTSIDE the session before commit — see
        # ``create_invite`` for the DetachedInstanceError rationale.
        actor_name = actor.name
        target_email = invite.email
        session.commit()

    accept_url = _accept_url_for_token(plaintext_token)
    _dispatch_invite_email(
        target_email=target_email,
        accept_url=accept_url,
        workspace_name=workspace_name,
        inviter_name=actor_name,
        invite_id=invite_id,
    )

    return InviteCreatedResponse(invite=view)


@router.delete("/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invite(
    invite_id: RowId,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Revoke a pending invite."""
    workspace_id: int = auth["client_id"]
    with get_session() as session:
        actor = _resolve_actor_client(session, auth)
        invite = session.get(OperatorInvite, invite_id)
        if invite is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "invite_not_found", "message": "Invite not found."},
            )
        try:
            invite_service.revoke_invite(session, invite, actor, workspace_id)
        except InviteError as err:
            raise _map_invite_error(err) from err
        session.commit()


# ── Public airlock endpoints ───────────────────────────────────────────────


@router.get("/by-token/{token}", response_model=PublicInviteView)
@limiter.limit("60/minute", key_func=get_remote_address)
def get_invite_public(request: Request, token: InviteToken):  # noqa: ARG001
    """Look up an invite by plaintext token.

    Unauthenticated — the airlock page uses this before login to render the
    correct state (signup vs login vs accept). Returns only workspace + inviter
    name + status + target email; no IDs or tokens are leaked.

    Rate-limited by client IP as a soft defense against token enumeration
    (the token is 256-bit so brute force is infeasible, but the rate limit
    keeps the surface honest).
    """
    with get_session() as session:
        invite = invite_service.get_invite_by_token(session, token)
        if invite is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "invite_not_found", "message": "This invite link is invalid."},
            )
        # Lazy expire — so an invite pending past its TTL surfaces as "expired"
        # here rather than silently accepting.
        invite_service._mark_expired_if_stale(session, invite)  # noqa: SLF001
        workspace_name = _resolve_workspace_name(session, invite.client_id)
        response = PublicInviteView(
            email=invite.email,
            workspace_name=workspace_name,
            inviter_name=invite.invited_by_name,
            role=invite.role,
            status=invite.status,
            expires_at=invite.expires_at,
        )
        session.commit()
        return response


class AcceptInviteResponse(BaseModel):
    workspace_id: int
    workspace_name: str
    operator_id: int
    role: str
    # Where the frontend should land after accept — the invited workspace's
    # /support page. Included so the airlock page can navigate without a
    # separate lookup.
    redirect_url: str


@router.post("/by-token/{token}/accept", response_model=AcceptInviteResponse)
@limiter.limit("30/hour", key_func=get_remote_address)
def accept_invite_public(
    request: Request,  # noqa: ARG001
    token: InviteToken,
    client: Client = Depends(get_current_client_strict),
):
    """Accept the invite as the currently-authenticated Client.

    ``X-API-Key`` ONLY — deliberately uses ``get_current_client_strict``
    instead of ``get_current_client``. The latter accepts ``X-Operator-Key``
    and resolves it to the **workspace owner's** Client, which would silently
    bind the resulting linked-Operator row to the wrong identity if a legacy
    operator (whose Client is Acme's owner) clicked their own invite link.

    A legacy operator who genuinely wants to accept an invite has to sign
    out and log in as their personal Client account first — matches the
    airlock's own "one identity per acceptance" model.

    Case-insensitive email match between the invite target and the caller's
    Client email is enforced by :func:`invite_service.accept_invite`.
    """
    with get_session() as session:
        invite = invite_service.get_invite_by_token(session, token)
        if invite is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "invite_not_found", "message": "This invite link is invalid."},
            )
        # Re-attach the client to this session so relationship reads work.
        acting_client = session.get(Client, client.id)
        if acting_client is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Account not found.",
            )
        try:
            operator = invite_service.accept_invite(session, invite, acting_client)
        except InviteError as err:
            raise _map_invite_error(err) from err
        workspace_id = invite.client_id
        workspace_name = _resolve_workspace_name(session, workspace_id)
        operator_id = operator.id
        role = operator.role
        session.commit()

    return AcceptInviteResponse(
        workspace_id=workspace_id,
        workspace_name=workspace_name,
        operator_id=operator_id,
        role=role,
        redirect_url="/support",
    )


# ── /me/workspaces ─────────────────────────────────────────────────────────


@me_router.post("/self-operator", response_model=SelfOperatorResponse, status_code=status.HTTP_201_CREATED)
def add_self_as_operator(
    body: SelfOperatorRequest,
    client: Client = Depends(get_current_client_strict),
):
    """Add the calling Client as an operator in their own workspace.

    Idempotent — returns the existing row if the caller already self-added
    (reactivating a previously left row via ``DELETE /me/self-operator``).
    The self-operator row has ``role='owner'`` and ``linked_client_id == id``
    where both point at the caller's Client identity (which is also the
    workspace ID by design).

    Feature-gated by ``live_chat`` — a Free-tier owner CANNOT self-add.

    Seat-counted like every other operator — the workspace owner acting as
    an operator consumes 1 of their plan's operator seats, same as an
    invited teammate. This matches industry-standard per-seat pricing
    (Slack, Intercom, Notion, Linear all count owner-as-agent). See
    ``invite_service._active_operator_count`` for the full rationale.

    Idempotence detail: if a self-operator row already exists AND is active,
    the endpoint returns without re-running the seat check. Only fresh
    creation and reactivation of a deactivated row consume a seat, so a
    double-click on the CTA never over-allocates.

    ``X-API-Key`` auth only (``get_current_client_strict``): a linked
    operator in some other workspace should not be able to promote
    themselves to owner via a stray X-Workspace-Id header. Only a Client
    identity authenticating as their true self can self-add.
    """
    with get_session() as session:
        # Feature gate — reuses the shared invite-service helper so the
        # rejection semantics stay in one place. Superadmin bypass applied
        # inside the helper.
        try:
            invite_service._require_live_chat_feature(session, client.id)  # noqa: SLF001
        except InviteError as err:
            raise _map_invite_error(err) from err

        # Validate the bot belongs to this workspace before touching operator
        # state — reject fast rather than accidentally binding self-op to
        # a bot the caller doesn't own.
        bot_row = session.execute(
            select(Bot.id).where(Bot.id == body.bot_id, Bot.client_id == client.id)
        ).scalar_one_or_none()
        if bot_row is None:
            raise HTTPException(status_code=404, detail="Bot not found in this workspace.")

        existing = session.execute(
            select(Operator).where(
                Operator.client_id == client.id,
                Operator.linked_client_id == client.id,
            )
        ).scalar_one_or_none()

        # Already active AND on the same bot — pure idempotent no-op. Do NOT
        # re-run the seat check; the row's existing ``is_active=True`` is
        # already in current usage. Bot mismatch falls through and reassigns.
        if existing is not None and existing.is_active and existing.bot_id == body.bot_id:
            return SelfOperatorResponse(
                operator_id=existing.id,
                role=existing.role,
                bot_id=existing.bot_id,
                is_active=True,
                was_existing=True,
            )

        # Either reactivating a soft-deleted row or creating fresh. Both
        # paths flip an inactive/absent seat to active — that consumes one
        # of the plan's operator seats, so gate on the seat check now. The
        # helper takes a ``FOR UPDATE`` lock on the workspace's subscription
        # so a concurrent invite-create + self-op race can't both squeak
        # past the limit.
        try:
            # Seats are per-bot — gate against the target bot the owner is
            # self-adding to, not the workspace-wide operator total.
            invite_service._require_seat_available(session, client.id, body.bot_id)  # noqa: SLF001
        except InviteError as err:
            raise _map_invite_error(err) from err

        if existing is not None:
            existing.is_active = True
            existing.bot_id = body.bot_id
            operator_id = existing.id
            role = existing.role
            bot_id = existing.bot_id
        else:
            op = Operator(
                client_id=client.id,
                bot_id=body.bot_id,
                linked_client_id=client.id,
                name=client.name,
                email=(client.email or "").strip().lower(),
                invited_email=None,
                role="owner",
                is_active=True,
                is_accepting_chats=True,
            )
            session.add(op)
            session.flush()
            operator_id = op.id
            role = "owner"
            bot_id = op.bot_id

        session.commit()
        plan_entitlements_service.invalidate(client.id)
        logger.info(
            "self_operator_added client=%s operator=%s bot=%s reactivated=%s",
            client.id,
            operator_id,
            bot_id,
            existing is not None,
        )
        return SelfOperatorResponse(
            operator_id=operator_id,
            role=role,
            bot_id=bot_id,
            is_active=True,
            was_existing=existing is not None,
        )


@me_router.delete("/self-operator", status_code=status.HTTP_204_NO_CONTENT)
def remove_self_as_operator(client: Client = Depends(get_current_client_strict)):
    """Deactivate the caller's self-operator row (owner leaves live chat).

    Sets ``is_active = False`` rather than deleting the row so historical
    chat sessions and audit logs still reference a stable operator. A later
    ``POST /me/self-operator`` reactivates the same row. Idempotent —
    calling this when no self-operator exists (or when it's already
    inactive) is a no-op.

    In-flight live chats aren't force-closed: the assigned chat completes
    naturally, and no new chats route to this operator once ``is_active``
    flips. If you specifically want to evict them from active chats, use
    the revocation flow (v2, task #38).
    """
    with get_session() as session:
        existing = session.execute(
            select(Operator).where(
                Operator.client_id == client.id,
                Operator.linked_client_id == client.id,
            )
        ).scalar_one_or_none()
        if existing is not None and existing.is_active:
            existing.is_active = False
            session.commit()
            plan_entitlements_service.invalidate(client.id)
            logger.info(
                "self_operator_removed client=%s operator=%s",
                client.id,
                existing.id,
            )


@me_router.get("/workspaces", response_model=MeWorkspacesResponse)
def list_my_workspaces(client: Client = Depends(get_current_client)):
    """Return every workspace the caller can act in.

    Sorted with the caller's owned workspace first, then linked-operator
    workspaces alphabetically by workspace display name. Frontend uses this
    to populate the workspace switcher; the response is small (~1 row per
    workspace) so we don't paginate.
    """
    # ``get_current_client`` returns a DETACHED Client with only a narrow set
    # of attributes eagerly loaded (id, name, email, api_key, is_superadmin,
    # suspended_at). ``company_name`` is NOT in that set, so accessing it
    # would trigger a lazy refresh on a detached instance and raise
    # ``DetachedInstanceError``. We snapshot the id up front and re-query the
    # display fields via column selects — cheaper than a full re-attach and
    # avoids depending on which attributes the auth path chose to warm.
    caller_id = client.id
    with get_session() as session:
        caller_row = session.execute(
            select(Client.company_name, Client.name, Client.email).where(Client.id == caller_id)
        ).first()
        if caller_row is None:
            # Client vanished between auth resolution and now — treat as no
            # accessible workspaces rather than 500.
            return MeWorkspacesResponse(workspaces=[])
        caller_company_name, caller_name, caller_email = caller_row

        # Owner path — the caller's own workspace. Frontend hides this entry
        # from the switcher list when ``bot_count == 0`` AND the caller is
        # invited-only (see ``isInvitedOnly`` on WorkspaceContext), but we
        # always return it so the client can compute that state.
        owner_bot_count = int(
            session.execute(
                select(func.count(Bot.id)).where(Bot.client_id == caller_id, Bot.is_active.is_(True))
            ).scalar_one()
        )
        owner_entry = WorkspaceView(
            id=caller_id,
            name=caller_company_name or caller_name or caller_email or f"Workspace #{caller_id}",
            role="owner",
            operator_role=None,
            bot_count=owner_bot_count,
        )

        # Linked-operator memberships — one row per workspace where the caller
        # holds an active linked-operator role. The partial unique index
        # ``ux_operators_linked_per_workspace`` guarantees at most one row per
        # (workspace, caller) so no dedup is needed.
        #
        # EXCLUDES the self-operator row (workspace owner acting as operator in
        # their own workspace). That row has ``client_id == linked_client_id ==
        # caller_id`` — if we let it through here it would appear as a separate
        # "operator" workspace entry alongside the owner entry we just added,
        # inflating ``workspaces.length`` and making the switcher pill show up
        # for a solo owner who has no real cross-workspace memberships.
        membership_rows = session.execute(
            select(
                Operator.client_id.label("workspace_id"),
                Operator.role.label("operator_role"),
                Client.company_name.label("owner_company_name"),
                Client.name.label("owner_display_name"),
                Client.email.label("owner_email"),
            )
            .join(Client, Client.id == Operator.client_id)
            .where(
                Operator.linked_client_id == caller_id,
                Operator.is_active.is_(True),
                # Filter out the caller's own self-operator row.
                Operator.client_id != caller_id,
            )
        ).all()

        operator_entries: list[WorkspaceView] = []
        for row in membership_rows:
            bot_count = int(
                session.execute(
                    select(func.count(Bot.id)).where(
                        Bot.client_id == row.workspace_id,
                        Bot.is_active.is_(True),
                    )
                ).scalar_one()
            )
            operator_entries.append(
                WorkspaceView(
                    id=row.workspace_id,
                    name=(
                        row.owner_company_name
                        or row.owner_display_name
                        or row.owner_email
                        or f"Workspace #{row.workspace_id}"
                    ),
                    role="operator",
                    operator_role=row.operator_role,
                    bot_count=bot_count,
                )
            )

        # Owner entry always first; operator entries alphabetical by display
        # name — mirrors the frontend switcher's own ordering.
        operator_entries.sort(key=lambda w: w.name.lower())
        return MeWorkspacesResponse(workspaces=[owner_entry, *operator_entries])


# ── Helpers ────────────────────────────────────────────────────────────────


def _resolve_actor_client(session, auth: dict) -> Client:
    """Return the acting Client identity (owner or linked operator's Client)."""
    if auth["type"] == "client":
        actor = session.get(Client, auth["entity"].id)
    else:
        linked_id = auth.get("linked_client_id") or auth["entity"].linked_client_id
        actor = session.get(Client, linked_id) if linked_id is not None else None
    if actor is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "legacy_operator_cannot_invite",
                "message": ("Legacy operator accounts can't manage invites. Ask the workspace owner to manage them."),
            },
        )
    return actor


def _resolve_workspace_name(session, workspace_id: int) -> str:
    """Best display name for a workspace — company name > client name > email."""
    row = session.execute(
        select(Client.company_name, Client.name, Client.email).where(Client.id == workspace_id)
    ).first()
    if row is None:
        return f"Workspace #{workspace_id}"
    company_name, name, email = row
    return company_name or name or email or f"Workspace #{workspace_id}"
