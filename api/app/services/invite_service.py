"""Operator invite lifecycle — create, accept, revoke, resend, expire.

Invitations replace the legacy "create operator with password" flow. An owner
or admin sends an email invite; the invitee either signs up (creating a fresh
Client) or logs in with an existing Client. On acceptance, a linked Operator
row is created in the target workspace with ``linked_client_id`` pointing at
the invitee's Client identity — so the invitee authenticates via their Client
``X-API-Key`` plus ``X-Workspace-Id`` (see :mod:`app.api.auth`).

Security guarantees
-------------------
* **Token opacity** — only the SHA-256 hex hash of the plaintext token is
  persisted. The plaintext appears exactly once (in the email link) and is
  never logged. Verification hashes the presented token and compares to the
  stored hash.
* **Race safety** — seat-limit checks acquire a ``SELECT ... FOR UPDATE`` on
  the workspace's active subscription so two concurrent invite creations
  can't both squeak past a limit boundary.
* **Superadmin protection** — the target email is checked against superadmin
  Client rows; a superadmin can never be invited as an operator into a
  customer workspace.
* **RBAC** — only Client identities holding an owner/admin role in the
  workspace (either as the workspace's actual owner Client OR via a linked
  operator with role owner/admin) can send/revoke invites.
* **Idempotent status transitions** — revoke on an already-resolved invite
  is a no-op; accept on a resolved invite raises a clear error.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Bot, Client, Operator, OperatorInvite, Subscription
from app.services import plan_entitlements_service
from app.services.plan_entitlements_service import UNLIMITED, get_entitlements

# ``live_chat`` is the plan feature that gates operator creation. Both the
# invite flow and the self-operator flow check this before doing anything else,
# so an owner without live-chat access can't create operators via any code
# path. Kept as a module-level constant to make the gate obvious in one place.
LIVE_CHAT_FEATURE = "live_chat"

logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────────

# 256-bit random token → 43-char base64url string → 64-char SHA-256 hex hash.
TOKEN_BYTES = 32

INVITE_TTL = timedelta(days=7)

# Hard cap on invite-scoped resend attempts. Not a rolling window — a bit
# blunter than the plan doc's "3/hour" but keeps things stateless. Raise if
# operators need repeated resends.
MAX_RESEND_PER_INVITE = 5

VALID_INVITE_ROLES = frozenset({"operator", "admin"})


# ── Errors ─────────────────────────────────────────────────────────────────


class InviteError(Exception):
    """User-facing invite failure.

    ``code`` is a stable machine-readable slug the frontend can branch on
    without parsing English. ``message`` is the display string.
    ``status_code`` maps to the HTTP response.
    """

    def __init__(self, code: str, message: str, *, status_code: int = 400):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


# ── Token helpers ──────────────────────────────────────────────────────────


def _hash_token(token: str) -> str:
    """SHA-256 hex digest of the plaintext token."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _generate_invite_token() -> tuple[str, str]:
    """Return ``(plaintext, sha256_hash)``.

    The plaintext travels ONCE — in the invite email link. The hash is the
    persistent identifier. Callers must never log the plaintext.
    """
    plaintext = secrets.token_urlsafe(TOKEN_BYTES)
    return plaintext, _hash_token(plaintext)


def _normalize_email(email: str) -> str:
    """Lowercase + strip — every email comparison and write must go through this."""
    return email.strip().lower()


# ── DB probes (kept small, one query each) ─────────────────────────────────


def _lock_active_subscription_for_workspace(session: Session, client_id: int) -> Subscription | None:
    """Acquire a row-level lock on the workspace's active subscription.

    Returns the locked row, or ``None`` if no active subscription exists.
    Serializes concurrent invite-create transactions against the same
    workspace so the seat check + operator row insert are effectively a
    critical section — no two concurrent invites can both slip past a limit
    boundary. On workspaces with no subscription row we skip locking (the
    seat check will look at limits derived from the free tier).
    """
    return (
        session.execute(
            select(Subscription)
            .where(Subscription.client_id == client_id)
            .where(Subscription.status.in_(["active", "trialing", "past_due"]))
            .order_by(Subscription.created_at.desc())
            .limit(1)
            .with_for_update()
        )
        .scalars()
        .first()
    )


def _active_operator_count(session: Session, workspace_id: int, bot_id: int) -> int:
    """Live seat usage for a single bot in a workspace.

    Operator seats are allocated **per bot**: each bot in the workspace has
    its own operator allowance (the plan's operator limit applies to every
    bot independently), so this counts only the active operators bound to
    ``bot_id`` — not the workspace-wide total. Switching bots therefore shows
    a distinct seat count and roster for each one.

    Every active operator row on the bot consumes exactly one of that bot's
    seats, including the workspace owner acting as their own operator.
    Rationale: per-seat pricing (Starter includes N seats) is undercut if the
    owner gets a free +1 — every real SaaS with per-seat pricing (Slack,
    Intercom, Notion, Linear) counts the owner-as-agent. The frontend "Take
    chats yourself" CTA makes the trade-off explicit so the owner knows a
    self-add consumes a seat just like inviting a teammate.

    Excluded from the count:
      * Pending invites — the invite row lives in ``operator_invites`` and
        no ``Operator`` row exists until acceptance, so this filter needs
        no extra clause for that. Note this leaves a small over-invite
        window (create N pending invites when N-1 seats free); the
        acceptance path re-checks under lock to catch the tail.
      * Deactivated operators — ``is_active=False`` rows are historical and
        do not consume a seat. Reactivating (self-op reactivate, invite
        accept on a stale row) re-runs the seat check.
    """
    return int(
        session.execute(
            select(func.count(Operator.id)).where(
                Operator.client_id == workspace_id,
                Operator.bot_id == bot_id,
                Operator.is_active.is_(True),
            )
        ).scalar_one()
    )


def _require_seat_available(session: Session, workspace_id: int, bot_id: int) -> None:
    """Raise ``InviteError('seat_limit_reached')`` when a new active operator
    would push ``bot_id`` past its plan's operator limit.

    Seats are per-bot: the plan's operator limit applies to each bot
    independently, so the check counts only the target bot's active
    operators — one bot being full never blocks adding operators to another.

    Acquires a ``SELECT ... FOR UPDATE`` lock on the workspace's active
    subscription so concurrent invite creations + self-op adds serialize.
    Two callers racing to grab the last seat on a bot will see one succeed
    and the other reject with a clean error — no silent over-allocation.

    Shared between :func:`create_invite` and the ``POST /me/self-operator``
    endpoint so both paths enforce the same per-seat semantics.
    """
    _lock_active_subscription_for_workspace(session, workspace_id)
    entitlements = get_entitlements(workspace_id, session, include_usage=True)
    operator_limit = entitlements.limit_for("operators")
    if operator_limit == UNLIMITED:
        return
    current = _active_operator_count(session, workspace_id, bot_id)
    if current >= operator_limit:
        raise InviteError(
            "seat_limit_reached",
            f"You've reached this agent's operator limit ({current}/{operator_limit}). "
            "Upgrade or free a seat to add more.",
            status_code=403,
        )


def _target_is_superadmin(session: Session, email: str) -> bool:
    row = session.execute(select(Client.is_superadmin).where(func.lower(Client.email) == email)).scalar_one_or_none()
    return bool(row)


def _target_is_workspace_owner(session: Session, workspace_id: int, email: str) -> bool:
    row = session.execute(
        select(Client.id).where(
            Client.id == workspace_id,
            func.lower(Client.email) == email,
        )
    ).scalar_one_or_none()
    return row is not None


def _has_active_operator_for_email(session: Session, workspace_id: int, email: str) -> bool:
    row = session.execute(
        select(Operator.id).where(
            Operator.client_id == workspace_id,
            func.lower(Operator.email) == email,
            Operator.is_active.is_(True),
        )
    ).scalar_one_or_none()
    return row is not None


def _pending_invite_exists(session: Session, workspace_id: int, email: str) -> bool:
    row = session.execute(
        select(OperatorInvite.id).where(
            OperatorInvite.client_id == workspace_id,
            OperatorInvite.email == email,
            OperatorInvite.status == "pending",
        )
    ).scalar_one_or_none()
    return row is not None


def _resolve_existing_linked_operator(session: Session, workspace_id: int, caller_client_id: int) -> Operator | None:
    return session.execute(
        select(Operator).where(
            Operator.client_id == workspace_id,
            Operator.linked_client_id == caller_client_id,
        )
    ).scalar_one_or_none()


# ── Feature gate ───────────────────────────────────────────────────────────


def _require_live_chat_feature(session: Session, workspace_id: int) -> None:
    """Raise ``InviteError('live_chat_locked')`` when the workspace's plan
    does not include the ``live_chat`` feature.

    Called by every path that creates or modifies an operator so a Free-tier
    workspace can't gain operators through any backdoor (invite CREATE,
    self-operator ADD, or a future bulk-import endpoint). Superadmins are
    exempt — they can act in any workspace regardless of plan for support
    and audit purposes.
    """
    from app.db.models import Client as _Client

    # Superadmin exemption — check via the owner Client row.
    owner_is_superadmin = session.execute(
        select(_Client.is_superadmin).where(_Client.id == workspace_id)
    ).scalar_one_or_none()
    if owner_is_superadmin:
        return

    entitlements = get_entitlements(workspace_id, session)
    if not entitlements.has_feature(LIVE_CHAT_FEATURE):
        raise InviteError(
            "live_chat_locked",
            "Live chat isn't included on your plan. Upgrade to invite operators.",
            status_code=403,
        )


# ── RBAC ───────────────────────────────────────────────────────────────────


def _require_manager_role(session: Session, actor: Client, workspace_id: int) -> None:
    """Raise ``InviteError('insufficient_permissions')`` if ``actor`` can't
    manage invites for ``workspace_id``.

    Managers are: the workspace-owning Client itself, and Client identities
    holding an active linked-operator role of ``owner`` or ``admin`` in that
    workspace. Regular operators cannot send invites.
    """
    if actor.id == workspace_id:
        return
    linked = session.execute(
        select(Operator).where(
            Operator.client_id == workspace_id,
            Operator.linked_client_id == actor.id,
            Operator.is_active.is_(True),
        )
    ).scalar_one_or_none()
    if linked is None or linked.role not in ("owner", "admin"):
        raise InviteError(
            "insufficient_permissions",
            "Only workspace owners and admins can manage invites.",
            status_code=403,
        )


# ── Public API ─────────────────────────────────────────────────────────────


def create_invite(
    session: Session,
    *,
    workspace_id: int,
    email: str,
    role: str,
    bot_id: int,
    department_id: int | None,
    invited_by: Client,
) -> tuple[OperatorInvite, str]:
    """Create a pending invite for ``email`` to join ``workspace_id`` as an operator.

    Returns ``(invite, plaintext_token)``. The plaintext is used exactly once
    to build the email link — the caller must not persist or log it after
    handing it to the email service.

    Raises :class:`InviteError` for any guardrail failure (dup, RBAC, seat,
    superadmin, invalid role). Callers are responsible for translating the
    error to an HTTP response.
    """
    email = _normalize_email(email)

    if role not in VALID_INVITE_ROLES:
        raise InviteError(
            "invalid_role",
            f"Role must be one of: {sorted(VALID_INVITE_ROLES)}.",
        )

    # Validate the bot exists in this workspace — an invite scoped to a bot
    # in a different workspace would let the invitee accept into a bot they
    # were never authorised for. Reject at CREATE, not just at accept.
    target_bot = session.execute(
        select(Bot.id).where(Bot.id == bot_id, Bot.client_id == workspace_id)
    ).scalar_one_or_none()
    if target_bot is None:
        raise InviteError(
            "bot_not_found",
            "The selected bot doesn't exist in this workspace.",
            status_code=404,
        )

    _require_manager_role(session, invited_by, workspace_id)

    # Feature gate — ``live_chat`` is a paid-plan feature. Explicitly rejecting
    # here gives a clearer error than the seat-limit fall-through (which on
    # Free tier reads as "You've reached your 0/0 operator limit" — technically
    # correct but the reason is really the feature, not the count).
    _require_live_chat_feature(session, workspace_id)

    if _target_is_superadmin(session, email):
        raise InviteError(
            "cannot_invite_superadmin",
            "This email belongs to a platform superadmin and cannot be invited as an operator.",
            status_code=403,
        )
    if _target_is_workspace_owner(session, workspace_id, email):
        raise InviteError(
            "cannot_invite_owner",
            "You already own this workspace — no invite needed.",
        )
    if _has_active_operator_for_email(session, workspace_id, email):
        raise InviteError(
            "operator_already_exists",
            "An operator with this email already exists in this workspace.",
            status_code=409,
        )
    if _pending_invite_exists(session, workspace_id, email):
        raise InviteError(
            "invite_already_pending",
            "An invite is already pending for this email. Resend or revoke it first.",
            status_code=409,
        )

    # Seat-limit check — shared with the self-op endpoint via a helper so
    # both paths enforce identical per-seat semantics under the same
    # FOR UPDATE lock. Scoped to the invite's target bot: seats are per-bot,
    # so the check counts only that bot's operators. Pending invites
    # intentionally don't count toward usage; see ``_active_operator_count``
    # for the full rationale.
    _require_seat_available(session, workspace_id, bot_id)

    plaintext, token_hash = _generate_invite_token()
    now = datetime.now(UTC)
    invite = OperatorInvite(
        client_id=workspace_id,
        bot_id=bot_id,
        email=email,
        role=role,
        department_id=department_id,
        token_hash=token_hash,
        status="pending",
        expires_at=now + INVITE_TTL,
        invited_by_client_id=invited_by.id,
        invited_by_name=invited_by.name,
        sent_at=now,
        resend_count=0,
    )
    session.add(invite)
    session.flush()

    logger.info(
        "invite_created workspace=%s email=%s role=%s invited_by=%s invite_id=%s",
        workspace_id,
        email,
        role,
        invited_by.id,
        invite.id,
    )
    return invite, plaintext


def get_invite_by_token(session: Session, plaintext_token: str) -> OperatorInvite | None:
    """Resolve an invite by presented plaintext token (hashed internally).

    Returns ``None`` when no invite matches. Does NOT check status/expiry —
    that's the caller's job so the airlock page can render a distinct
    "expired" / "revoked" state.
    """
    if not plaintext_token or not plaintext_token.strip():
        return None
    token_hash = _hash_token(plaintext_token.strip())
    return session.execute(select(OperatorInvite).where(OperatorInvite.token_hash == token_hash)).scalars().first()


def _mark_expired_if_stale(session: Session, invite: OperatorInvite) -> None:
    """Lazy-flip a pending invite to ``expired`` when it's past ``expires_at``.

    Cheaper than a sweep task and self-healing. Callers should invoke this
    before any state-transition check so ``status == "pending"`` truly means
    "still actionable."
    """
    expires_at = invite.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if invite.status == "pending" and expires_at is not None and expires_at < datetime.now(UTC):
        invite.status = "expired"
        session.flush()


def accept_invite(
    session: Session,
    invite: OperatorInvite,
    accepting_client: Client,
) -> Operator:
    """Bind ``accepting_client`` as an operator in the invite's workspace.

    * Rejects an accept from a Client whose email does not match the invite's
      email (case-insensitive).
    * Idempotent-ish: if the caller already holds a linked-operator row in
      the workspace (rare race), re-activates it instead of duplicating.
    * Invalidates the workspace's entitlements cache so seat usage refreshes
      immediately for the operator-create UI.

    Race safety
    -----------
    Re-fetches the invite under ``SELECT ... FOR UPDATE`` so a concurrent
    revoke can't race an accept. Without the lock, both transactions could
    read ``status='pending'`` in their MVCC snapshot, both proceed past the
    status check, and the last commit would silently overwrite the first —
    the invite could end up ``status='accepted'`` after a revoke that
    thought it succeeded, or a duplicate operator row could survive across
    two near-simultaneous accepts of the same token. The lock serialises
    the writers: whoever grabs it first wins, the other sees the committed
    status and errors cleanly.
    """
    invite = session.execute(
        select(OperatorInvite).where(OperatorInvite.id == invite.id).with_for_update()
    ).scalar_one_or_none()
    if invite is None:
        # Row vanished between airlock lookup and now — treat as invalid so
        # the frontend renders the "invalid invite" state.
        raise InviteError(
            "invite_not_found",
            "This invite is no longer available.",
            status_code=404,
        )
    if invite.status == "revoked":
        raise InviteError("invite_revoked", "This invite has been revoked.", status_code=410)
    if invite.status == "accepted":
        raise InviteError(
            "invite_already_accepted",
            "This invite has already been accepted.",
            status_code=410,
        )
    _mark_expired_if_stale(session, invite)
    if invite.status == "expired":
        raise InviteError(
            "invite_expired",
            "This invite has expired. Ask the owner to send a new one.",
            status_code=410,
        )

    accepting_email = _normalize_email(accepting_client.email)
    if accepting_email != invite.email:
        raise InviteError(
            "email_mismatch",
            f"This invite is for {invite.email}. Sign in with that account to accept.",
            status_code=403,
        )

    # Idempotence for a rare race — if a linked-op row already exists here
    # (e.g. the invitee accepted twice near-simultaneously, or an earlier
    # invite was accepted then the operator was deactivated), reuse the row
    # rather than raising a partial-unique-index violation.
    existing = _resolve_existing_linked_operator(session, invite.client_id, accepting_client.id)

    # Fully-idempotent no-op: an active linked operator already exists for
    # this accepting client in this workspace. Mark the invite accepted
    # without consuming a seat (nothing changed in seat usage). Guards
    # against a double-click on the airlock's Accept button burning through
    # limit headroom for a row that was already counted.
    if existing is not None and existing.is_active:
        invite.status = "accepted"
        invite.accepted_at = datetime.now(UTC)
        invite.accepted_by_client_id = accepting_client.id
        session.flush()
        plan_entitlements_service.invalidate(invite.client_id)
        logger.info(
            "invite_accepted (already-active idempotent) invite_id=%s operator_id=%s client=%s workspace=%s",
            invite.id,
            existing.id,
            accepting_client.id,
            invite.client_id,
        )
        return existing

    # Every remaining branch flips an inactive/absent seat to active, so it
    # consumes one of the workspace's operator seats. Gate on the shared
    # seat helper — same FOR UPDATE lock as the invite CREATE path, so a
    # concurrent race between two acceptances of two pending invites (or
    # an invite accept + a self-op add) resolves cleanly: one succeeds,
    # the other rejects with a structured ``seat_limit_reached`` error.
    # Scoped to the invite's target bot — seats are allocated per-bot.
    _require_seat_available(session, invite.client_id, invite.bot_id)

    if existing is not None:
        # Reactivating a previously-soft-deleted linked operator row.
        # Common on repeat cycles: user accepted, was later revoked
        # (soft delete), then invited again and accepts again.
        #
        # Apply the NEW invite's role + department to the reactivated row —
        # otherwise a re-invite with an intentional promotion (operator ->
        # admin) or a department reassignment would silently drop those
        # changes and the row would keep whatever it had before revoke.
        # Also refresh ``invited_email`` snapshot in case the invite went
        # to a different (but case-equivalent) email surface.
        existing.is_active = True
        existing.role = invite.role
        # Re-invite may target a different bot than the previous run — apply
        # the current invite's binding so the reactivated row lands on the
        # bot the invite was actually sent for.
        existing.bot_id = invite.bot_id
        existing.department_id = invite.department_id
        existing.invited_email = invite.email
        invite.status = "accepted"
        invite.accepted_at = datetime.now(UTC)
        invite.accepted_by_client_id = accepting_client.id
        session.flush()
        plan_entitlements_service.invalidate(invite.client_id)
        logger.info(
            "invite_accepted (reactivated) invite_id=%s operator_id=%s client=%s workspace=%s role=%s dept=%s",
            invite.id,
            existing.id,
            accepting_client.id,
            invite.client_id,
            invite.role,
            invite.department_id,
        )
        return existing

    operator = Operator(
        client_id=invite.client_id,
        bot_id=invite.bot_id,
        linked_client_id=accepting_client.id,
        name=accepting_client.name,
        email=accepting_email,
        invited_email=invite.email,
        role=invite.role,
        department_id=invite.department_id,
        is_active=True,
        is_accepting_chats=True,
        # No hashed_password / operator_api_key — linked operators authenticate
        # via their Client's X-API-Key plus X-Workspace-Id header. They cannot
        # log in through /auth/operator-login (which filters out rows with
        # NULL hashed_password anyway — see auth_routes.py).
    )
    session.add(operator)
    session.flush()

    invite.status = "accepted"
    invite.accepted_at = datetime.now(UTC)
    invite.accepted_by_client_id = accepting_client.id

    plan_entitlements_service.invalidate(invite.client_id)

    logger.info(
        "invite_accepted invite_id=%s operator_id=%s client=%s workspace=%s",
        invite.id,
        operator.id,
        accepting_client.id,
        invite.client_id,
    )
    return operator


def revoke_invite(session: Session, invite: OperatorInvite, actor: Client, workspace_id: int) -> None:
    """Mark a pending invite as revoked. No-op for already-resolved invites.

    Enforces RBAC — only workspace owners/admins can revoke.

    Re-fetches the invite under ``SELECT ... FOR UPDATE`` so a concurrent
    accept can't slip past the status check and produce an operator row on
    a revoked invite. See :func:`accept_invite` for the full race rationale
    and lock ordering.
    """
    _require_manager_role(session, actor, workspace_id)
    if invite.client_id != workspace_id:
        # Belt and braces: the route already scoped by workspace, but guard
        # against a caller passing a foreign invite id.
        raise InviteError(
            "invite_not_found",
            "Invite does not belong to this workspace.",
            status_code=404,
        )
    invite = session.execute(
        select(OperatorInvite).where(OperatorInvite.id == invite.id).with_for_update()
    ).scalar_one_or_none()
    if invite is None or invite.status != "pending":
        # Idempotent — either gone entirely or already resolved (accepted /
        # revoked / expired). Silent no-op matches the pre-lock behaviour.
        return
    invite.status = "revoked"
    invite.revoked_at = datetime.now(UTC)
    invite.revoked_by_client_id = actor.id
    logger.info("invite_revoked invite_id=%s actor=%s workspace=%s", invite.id, actor.id, workspace_id)


def resend_invite(session: Session, invite: OperatorInvite, actor: Client, workspace_id: int) -> str:
    """Rotate the invite's token and return the new plaintext.

    Rotation makes the resend email a fresh magic link — the old link stops
    working immediately, which is the desired security posture. Rate-limited
    per invite (``MAX_RESEND_PER_INVITE``) to prevent abuse.

    Re-fetches the invite under ``SELECT ... FOR UPDATE`` so a concurrent
    accept or revoke can't observe a partially-mutated token during the
    rotation, and so two concurrent resends can't both rotate the token
    to different values (only one succeeds; the other sees the fresh
    ``resend_count`` and stops).
    """
    _require_manager_role(session, actor, workspace_id)
    if invite.client_id != workspace_id:
        raise InviteError(
            "invite_not_found",
            "Invite does not belong to this workspace.",
            status_code=404,
        )
    invite = session.execute(
        select(OperatorInvite).where(OperatorInvite.id == invite.id).with_for_update()
    ).scalar_one_or_none()
    if invite is None:
        raise InviteError(
            "invite_not_found",
            "Invite not found.",
            status_code=404,
        )
    if invite.status != "pending":
        raise InviteError(
            "invite_not_pending",
            "Only pending invites can be resent.",
            status_code=400,
        )
    _mark_expired_if_stale(session, invite)
    if invite.status == "expired":
        raise InviteError(
            "invite_expired",
            "This invite has expired. Revoke it and send a new one.",
            status_code=410,
        )

    if invite.resend_count >= MAX_RESEND_PER_INVITE:
        raise InviteError(
            "resend_limit_reached",
            "This invite has been resent too many times. Revoke and send a new one.",
            status_code=429,
        )

    plaintext, token_hash = _generate_invite_token()
    invite.token_hash = token_hash
    invite.sent_at = datetime.now(UTC)
    invite.resend_count += 1
    logger.info(
        "invite_resent invite_id=%s workspace=%s actor=%s attempt=%s",
        invite.id,
        workspace_id,
        actor.id,
        invite.resend_count,
    )
    return plaintext
