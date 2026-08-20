"""Super-admin v2 routes.

This module adds the endpoints needed by the new ``admin.oyechats.com``
command center. Existing v1 routes (``superadmin_routes.py``,
``superadmin_plan_routes.py``) remain untouched; the new routes coexist under
the same ``/superadmin`` prefix because there is no conflict in path names.

Every mutating route writes to ``audit_logs`` via ``record_audit``.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import case, desc, func, select

from app.api.auth import get_superadmin
from app.config import APP_URL, CHECKOUT_TEST_CLIENT_IDS, IMPERSONATION_ENABLED
from app.core.csv_safety import csv_safe
from app.core.pricing import charge_currency
from app.db.models import (
    AuditLog,
    Bot,
    ChatMessage,
    ChatSession,
    Client,
    Coupon,
    CreditLedger,
    Document,
    ImpersonationToken,
    Invoice,
    LeadInfo,
    LLMCallLog,
    Operator,
    Plan,
    PricingConfig,
    Subscription,
)
from app.db.session import get_session
from app.schemas.validators import EmailAddress, RequiredName, RowId, SessionId, bounded_list
from app.services.audit_service import record_audit
from app.services.discount_service import resolve_customer_discount_bps
from app.services.email_service import send_password_reset_email
from app.services.langfuse_service import fetch_summary as fetch_langfuse_summary
from app.services.runtime_config import is_impersonation_enabled
from app.services.seller_profile_service import (
    SellerProfile,
    SellerProfileError,
    get_seller_profile,
    save_seller_profile,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/superadmin", tags=["superadmin-v2"])

# ── helpers ─────────────────────────────────────────────────────────────────


def _app_base_url() -> str:
    """Origin of the customer app the impersonation hand-off points at.

    Deliberately reuses the shared ``APP_URL`` setting rather than introducing
    a second env var for the same concept: ``APP_URL`` already defaults to the
    production host and is already pointed at localhost by the dev ``.env``, so
    impersonation resolves correctly in every environment with no extra
    configuration. A separate knob would leave impersonation pointing at
    production from a developer machine until someone set it twice.

    Read at call time (module global, not a captured local) so tests can
    monkeypatch it, and re-stripped defensively so a patched or misconfigured
    value can never produce a double slash.
    """
    return APP_URL.rstrip("/")


def _require_write(actor: Client) -> None:
    """Read-only super-admins cannot mutate."""
    if getattr(actor, "superadmin_role", None) == "readonly":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Read-only super-admin: writes are not permitted.",
        )


def _require_owner(actor: Client) -> None:
    """Only owner-tier super-admins may grant or change super-admin privileges.

    ``superadmin_role`` is one of ``owner|admin|readonly``; ``_require_write``
    alone only blocks ``readonly``, which would let an ``admin``-tier actor
    promote themselves or any other account to super-admin. Privilege writes
    (``is_superadmin`` / ``superadmin_role``) must additionally pass this gate.
    """
    if getattr(actor, "superadmin_role", None) != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an owner-tier super-admin may change super-admin privileges.",
        )


def _client_summary(c: Client) -> dict[str, Any]:
    return {
        "id": c.id,
        "name": c.name,
        "email": c.email,
        "is_superadmin": c.is_superadmin,
        "superadmin_role": getattr(c, "superadmin_role", None),
        "suspended_at": c.suspended_at.isoformat() if getattr(c, "suspended_at", None) else None,
        "website": c.website,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


# ── Clients ─────────────────────────────────────────────────────────────────


# Ceiling on a single super-admin credit adjustment, in credits.
_MAX_MANUAL_CREDIT_DELTA = 10_000_000

# Plans one coupon may be scoped to.
_MAX_COUPON_PLANS = 50

# A coupon code as typed at checkout.
CouponCodeStr = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_\-]+$"),
]

# A LiteLLM model identifier, e.g. "openai/gpt-5.4-mini".
ModelId = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_./\-]+$"),
]


class ClientPatch(BaseModel):
    name: RequiredName | None = None
    # A super-admin can retarget an account's login address; it must still be
    # a well-formed address, since it is the account's identity and the
    # destination for every notification it receives.
    email: EmailAddress | None = None
    is_superadmin: bool | None = None
    superadmin_role: str | None = Field(default=None, pattern="^(owner|admin|readonly)$")
    suspended: bool | None = None


@router.get("/clients/{client_id}")
def client_detail(client_id: int, _admin: Client = Depends(get_superadmin)):
    """Aggregated client detail used by ``/clients/[id]`` page."""
    with get_session() as session:
        client = session.get(Client, client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Account not found")

        bots = session.execute(select(Bot).where(Bot.client_id == client_id)).scalars().all()
        sub = (
            session.execute(
                select(Subscription)
                .where(Subscription.client_id == client_id)
                .order_by(desc(Subscription.created_at))
                .limit(1)
            )
            .scalars()
            .first()
        )
        msg_count = (
            session.execute(
                select(func.count(ChatMessage.id))
                .join(ChatSession, ChatMessage.session_id == ChatSession.id)
                .where(ChatSession.client_id == client_id)
            ).scalar()
            or 0
        )
        sess_count = (
            session.execute(select(func.count(ChatSession.id)).where(ChatSession.client_id == client_id)).scalar() or 0
        )
        balance = (
            session.execute(
                select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(CreditLedger.client_id == client_id)
            ).scalar()
            or 0
        )

        # Approximate MRR. Use plan price if active.
        mrr_cents = 0
        if sub and sub.status in {"active", "trialing"} and sub.plan_id:
            from app.db.models import Plan

            plan = session.get(Plan, sub.plan_id)
            if plan:
                mrr_cents = (
                    plan.monthly_price_cents if sub.billing_cycle == "monthly" else plan.annual_price_cents // 12
                ) * (sub.operator_quantity or 1)

        return {
            **_client_summary(client),
            "bots": [
                {
                    "id": b.id,
                    "bot_key": b.bot_key,
                    "name": b.name,
                    "client_id": b.client_id,
                    "client_name": client.name,
                    "is_active": getattr(b, "is_active", True),
                    "primary_color": getattr(b, "primary_color", None),
                    "created_at": b.created_at.isoformat() if b.created_at else None,
                }
                for b in bots
            ],
            "subscription": _subscription_summary(session, sub) if sub else None,
            "mrr_cents": mrr_cents,
            "total_sessions": sess_count,
            "total_messages": msg_count,
            "credits_balance": int(balance),
        }


@router.patch("/clients/{client_id}")
def patch_client(
    client_id: int,
    body: ClientPatch,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    _require_write(admin)
    with get_session() as session:
        client = session.get(Client, client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Account not found")

        # Privilege writes (is_superadmin / superadmin_role) are a separate,
        # stricter gate than ordinary field edits: only an owner-tier actor
        # may grant or change another account's super-admin status, and no
        # actor (not even an owner) may change their OWN privilege fields
        # through this endpoint (blocks self-escalation and accidental
        # self-lockout). Checked before any mutation is applied.
        if body.is_superadmin is not None or body.superadmin_role is not None:
            if client.id == admin.id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="You cannot change your own super-admin privileges via this endpoint.",
                )
            _require_owner(admin)

        before = _client_summary(client)
        if body.name is not None:
            client.name = body.name
        if body.email is not None:
            client.email = body.email
        if body.is_superadmin is not None:
            client.is_superadmin = body.is_superadmin
        if body.superadmin_role is not None:
            client.superadmin_role = body.superadmin_role
        if body.suspended is not None:
            client.suspended_at = datetime.now(UTC) if body.suspended else None

        session.flush()
        record_audit(
            session,
            actor=admin,
            action="client.update",
            target_type="client",
            target_id=client.id,
            before=before,
            after=_client_summary(client),
            request=request,
        )
        session.commit()
        return _client_summary(client)


class CreditsGrant(BaseModel):
    # A manual ledger adjustment. Bounded in both directions: the ledger is
    # append-only and event-sourced, so an unbounded grant cannot be undone by
    # editing a row, it takes a compensating entry.
    delta: int = Field(..., ge=-_MAX_MANUAL_CREDIT_DELTA, le=_MAX_MANUAL_CREDIT_DELTA)
    reason: str = Field(min_length=3, max_length=500)


class BillingCountryOverride(BaseModel):
    country: str = Field(min_length=2, max_length=2, pattern=r"^[A-Za-z]{2}$")
    reason: str = Field(min_length=1, max_length=500)


@router.post("/clients/{client_id}/billing-country")
def override_billing_country(
    client_id: int,
    body: BillingCountryOverride,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Relocate an account's billing country, the ONLY path while a mandate is live.

    ``PUT /billing-details`` freezes ``billing_country`` under a live Razorpay
    mandate (it is the tax-classification fact for every invoice. P0-2), so a
    genuine relocation is an ops action: verify the customer, re-point the
    mandate to the new rail, then record the new country here with a reason.
    Audit-logged; the same GSTIN⇒IN consistency rule as the customer route
    applies (a domestic GST registration cannot bill from abroad).
    """
    _require_write(admin)
    country = body.country.strip().upper()
    with get_session() as session:
        client = session.get(Client, client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Account not found")
        if client.gstin and country != "IN":
            raise HTTPException(
                status_code=422,
                detail="Account has a GSTIN on record. Clear it before moving billing_country off IN.",
            )
        before = {"billing_country": client.billing_country}
        client.billing_country = country
        session.flush()
        record_audit(
            session,
            actor=admin,
            action="client.billing_country.override",
            target_type="client",
            target_id=client_id,
            before=before,
            after={"billing_country": country, "reason": body.reason},
            request=request,
        )
        session.commit()
        return {"billing_country": country}


@router.get("/reconciliation/gateway")
def gateway_reconciliation_runs(
    limit: int = Query(default=7, ge=1, le=60),
    _admin: Client = Depends(get_superadmin),
):
    """Latest gateway-reconciliation runs (blueprint §7). Read-only; the
    newest run's ``report.deltas`` names exactly what disagrees between
    Razorpay and local money state, an empty list means the daily safety net
    ran and found nothing."""
    from app.db.models import ReconciliationRun

    with get_session() as session:
        rows = (
            session.execute(select(ReconciliationRun).order_by(ReconciliationRun.ran_at.desc()).limit(limit))
            .scalars()
            .all()
        )
        return {
            "runs": [
                {
                    "id": row.id,
                    "ran_at": row.ran_at.isoformat() if row.ran_at else None,
                    "delta_count": row.delta_count,
                    "report": row.report,
                }
                for row in rows
            ]
        }


@router.get("/billing-funnel")
def billing_funnel(
    days: int = Query(default=7, ge=1, le=90),
    limit: int = Query(default=50, ge=1, le=200),
    _admin: Client = Depends(get_superadmin),
):
    """Payment-funnel drop-offs: who opened a Razorpay sheet and bailed (or
    got declined), aggregated per surface for the window. Read-only.
    Readonly-role superadmins can see it."""
    from app.db.models import BillingFunnelEvent

    since = datetime.now(UTC) - timedelta(days=days)
    with get_session() as session:
        counts = [
            {"surface": surface, "event": event, "count": int(count)}
            for surface, event, count in session.execute(
                select(
                    BillingFunnelEvent.surface,
                    BillingFunnelEvent.event,
                    func.count(BillingFunnelEvent.id),
                )
                .where(BillingFunnelEvent.created_at >= since)
                .group_by(BillingFunnelEvent.surface, BillingFunnelEvent.event)
                .order_by(func.count(BillingFunnelEvent.id).desc())
            ).all()
        ]
        recent = [
            {
                "id": row.id,
                "client_id": row.client_id,
                "client_email": email,
                "event": row.event,
                "surface": row.surface,
                "meta": row.meta,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row, email in session.execute(
                select(BillingFunnelEvent, Client.email)
                .join(Client, Client.id == BillingFunnelEvent.client_id)
                .where(BillingFunnelEvent.created_at >= since)
                .order_by(BillingFunnelEvent.created_at.desc(), BillingFunnelEvent.id.desc())
                .limit(limit)
            ).all()
        ]
    return {"days": days, "counts": counts, "recent": recent}


@router.post("/clients/{client_id}/credits")
def grant_credits(
    client_id: int,
    body: CreditsGrant,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    _require_write(admin)
    if body.delta == 0:
        raise HTTPException(status_code=400, detail="delta must be non-zero")
    with get_session() as session:
        client = session.get(Client, client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Account not found")

        entry = CreditLedger(
            client_id=client_id,
            delta=body.delta,
            reason="manual_adjust",
            note=body.reason,
            created_by=admin.id,
        )
        session.add(entry)
        session.flush()
        balance = (
            session.execute(
                select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(CreditLedger.client_id == client_id)
            ).scalar()
            or 0
        )
        record_audit(
            session,
            actor=admin,
            action="credits.grant",
            target_type="client",
            target_id=client_id,
            after={"delta": body.delta, "reason": body.reason, "balance": int(balance)},
            request=request,
        )
        session.commit()
        return {"balance": int(balance), "entry_id": entry.id}


@router.post("/clients/{client_id}/impersonate")
def impersonate(
    client_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Mint a short-lived impersonation token for an Account.

    The raw token is returned once (and embedded in ``redirect_url``); only its
    sha256 is stored, so it can never be read back out of the database.

    A Client whose ``is_superadmin`` is set is **not** impersonable: the token
    would let its holder act with the target's privileges, which is a lateral
    privilege escalation between super-admins (and, for a self-target, a way to
    launder one's own actions). The super-admin UI already hides these rows,
    but a UI filter is not a control. Reject here, before any row is written.

    Honours the impersonation kill switch (design §14). Minting is blocked
    while it is off so an admin gets a clear error instead of a working-looking
    link that dies at redemption. Revocation deliberately stays available,
    it only ever reduces privilege, and an operator may need to revoke
    outstanding tokens *because* they flipped the switch.
    """
    if not is_impersonation_enabled():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Impersonation is temporarily disabled.",
        )
    _require_write(admin)
    with get_session() as session:
        target = session.get(Client, client_id)
        if not target:
            raise HTTPException(status_code=404, detail="Account not found")
        if target.is_superadmin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Super-admin accounts cannot be impersonated.",
            )

        raw = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        expires_at = datetime.now(UTC) + timedelta(minutes=30)
        record = ImpersonationToken(
            token_hash=token_hash,
            actor_id=admin.id,
            target_id=client_id,
            expires_at=expires_at,
        )
        session.add(record)
        session.flush()  # assign record.id so it can be returned for revocation

        record_audit(
            session,
            actor=admin,
            action="client.impersonate",
            target_type="client",
            target_id=client_id,
            after={"token_id": record.id, "expires_at": expires_at.isoformat()},
            request=request,
        )
        session.commit()
        return {
            "token": raw,
            "token_id": record.id,
            "expires_at": expires_at.isoformat(),
            # ``raw`` comes from ``secrets.token_urlsafe``. Already restricted
            # to URL-safe characters, so it needs no percent-encoding.
            "redirect_url": f"{_app_base_url()}/?impersonation={raw}",
        }


@router.post("/impersonation/{token_id}/revoke")
def revoke_impersonation(
    token_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Revoke an impersonation token server-side (audit F16).

    Marks ``revoked_at`` on the ``impersonation_tokens`` row so the token can
    no longer be redeemed. Any redemption path MUST require
    ``revoked_at IS NULL AND expires_at > now()``. The raw token itself never
    reaches this endpoint; revocation is by row id, so the dashboard can exit
    without holding the sensitive credential.

    Authorization: the super-admin who issued the token may always revoke it
    (including read-only admins. Revocation strictly reduces privilege);
    revoking another admin's token requires a write-capable super-admin role.
    Idempotent: revoking an already-revoked token is a no-op success.
    """
    with get_session() as session:
        token = session.get(ImpersonationToken, token_id)
        if not token:
            raise HTTPException(status_code=404, detail="Impersonation token not found")

        if token.actor_id != admin.id:
            _require_write(admin)

        if token.revoked_at is None:
            token.revoked_at = datetime.now(UTC)
            record_audit(
                session,
                actor=admin,
                action="client.impersonate_revoke",
                target_type="client",
                target_id=token.target_id,
                after={"token_id": token.id, "revoked_at": token.revoked_at.isoformat()},
                request=request,
            )
            session.commit()

        return {"ok": True, "revoked_at": token.revoked_at.isoformat()}


@router.post("/clients/{client_id}/reset-password")
def reset_password(
    client_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    _require_write(admin)
    with get_session() as session:
        target = session.get(Client, client_id)
        if not target:
            raise HTTPException(status_code=404, detail="Account not found")

        # Issue a real password-reset: generate a 6-digit OTP (15-min TTL) and
        # email it to the customer, reusing the same mechanism as the customer
        # self-service /auth/request-password-reset + /auth/reset-password flow.
        # The customer sets their own new password, the super-admin never sees
        # or sets it. (Previously this endpoint only audit-logged and no-op'd.)
        otp = str(secrets.randbelow(900000) + 100000)
        target.reset_otp = otp
        target.reset_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)

        record_audit(
            session,
            actor=admin,
            action="client.reset_password",
            target_type="client",
            target_id=client_id,
            request=request,
        )
        session.commit()
        target_email = target.email

    try:
        send_password_reset_email(target_email, otp)
    except Exception as exc:  # noqa: BLE001  Surface a clean 502 to the caller
        logger.error("Failed to send password-reset email for client %s: %s", client_id, exc)
        raise HTTPException(
            status_code=502,
            detail="Could not send the password-reset email. Please try again.",
        ) from exc

    return {"ok": True, "message": "Password-reset email sent to the customer."}


# ── Bots ────────────────────────────────────────────────────────────────────


@router.get("/bots")
def list_bots(_admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        rows = session.execute(select(Bot, Client).join(Client, Bot.client_id == Client.id)).all()
        return [
            {
                "id": b.id,
                "bot_key": b.bot_key,
                "name": b.name,
                "client_id": b.client_id,
                "client_name": c.name,
                "is_active": getattr(b, "is_active", True),
                "primary_color": getattr(b, "primary_color", None),
                "created_at": b.created_at.isoformat() if b.created_at else None,
            }
            for b, c in rows
        ]


@router.get("/bots/{bot_id}")
def bot_detail(bot_id: int, _admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        bot = session.get(Bot, bot_id)
        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found")
        client = session.get(Client, bot.client_id)
        sess_count = (
            session.execute(select(func.count(ChatSession.id)).where(ChatSession.bot_id == bot_id)).scalar() or 0
        )
        msg_count = (
            session.execute(
                select(func.count(ChatMessage.id))
                .join(ChatSession, ChatMessage.session_id == ChatSession.id)
                .where(ChatSession.bot_id == bot_id)
            ).scalar()
            or 0
        )
        return {
            "id": bot.id,
            "bot_key": bot.bot_key,
            "name": bot.name,
            "client_id": bot.client_id,
            "client_name": client.name if client else None,
            "is_active": getattr(bot, "is_active", True),
            "primary_color": getattr(bot, "primary_color", None),
            "total_sessions": sess_count,
            "total_messages": msg_count,
            "created_at": bot.created_at.isoformat() if bot.created_at else None,
        }


# ── Documents ───────────────────────────────────────────────────────────────


@router.get("/documents")
def list_documents(_admin: Client = Depends(get_superadmin)):
    """Ingested knowledge, one row per SOURCE document rather than per chunk.

    ``Document`` stores one row per chunk, so a listing of raw rows tells a
    super-admin nothing actionable: fifty rows for one PDF and no way to see
    the file they came from. Rows are grouped by
    ``(file_hash, bot_id, document_name)`` exactly as
    ``superadmin_ops_routes.list_crawls`` groups crawl jobs, collapsing a
    source back into one row.

    Field notes, because three of these are not what a caller would guess:

    * ``id`` is the source's ``file_hash``, **not** a ``documents.id``. This
      list is grouped, so no single row id identifies it. Anything that needs
      a chunk id (the per-chunk ``POST /superadmin/documents/{id}/reindex``)
      must resolve one itself.
    * ``content_chars`` is ``SUM(length(content))`` across the source's
      chunks, i.e. post-chunk characters. It runs a little ahead of the
      original file because the chunker overlaps chunks. The pre-chunk figure,
      ``source_char_count``, is replicated onto EVERY chunk of a source, so
      summing it multiplies by the chunk count; it is deliberately not summed.
    * ``is_active`` is ``bool_and`` over the chunks. A source is live only when
      every chunk of it is. ``knowledge_state_service`` deactivates per bot, so
      a half-deactivated source is a defect worth surfacing, not rounding away.
    """
    with get_session() as session:
        rows = session.execute(
            select(
                Document.file_hash,
                Document.bot_id,
                Document.document_name,
                Bot.name.label("bot_name"),
                # Aggregated, not grouped. Every chunk of one source carries the
                # same ``client_id`` / ``source``, but grouping on them would
                # split a source into two rows if one chunk ever disagreed
                # (a half-migrated legacy ``client_id``, say) instead of showing
                # the one source that is really there.
                func.min(Document.client_id).label("client_id"),
                func.min(Document.source).label("source"),
                func.count(Document.id).label("chunk_count"),
                func.coalesce(func.sum(func.length(Document.content)), 0).label("content_chars"),
                func.bool_and(Document.is_active).label("is_active"),
                func.min(Document.created_at).label("created_at"),
            )
            .outerjoin(Bot, Document.bot_id == Bot.id)
            .group_by(
                Document.file_hash,
                Document.bot_id,
                Document.document_name,
                Bot.name,
            )
            .order_by(desc(func.min(Document.created_at)))
            .limit(500)
        ).all()
        return [
            {
                "id": r.file_hash,
                "bot_id": r.bot_id,
                "bot_name": r.bot_name,
                "client_id": r.client_id,
                "source": r.source,
                "title": r.document_name,
                "chunk_count": int(r.chunk_count or 0),
                "content_chars": int(r.content_chars or 0),
                "is_active": bool(r.is_active),
                "created_at": r.created_at.isoformat() if r.created_at else "",
            }
            for r in rows
        ]


# ── Sessions ────────────────────────────────────────────────────────────────


@router.get("/sessions")
def list_sessions(
    status_filter: str | None = Query(default=None, alias="status", max_length=64),
    client_id: int | None = None,
    _admin: Client = Depends(get_superadmin),
):
    with get_session() as session:
        stmt = (
            select(ChatSession, Bot, Client, LeadInfo)
            .outerjoin(Bot, ChatSession.bot_id == Bot.id)
            .outerjoin(Client, ChatSession.client_id == Client.id)
            # ``lead_info.session_id`` is UNIQUE, so this is a 1:1 outer join:
            # no fan-out, no extra rows, and no per-session follow-up query.
            .outerjoin(LeadInfo, LeadInfo.session_id == ChatSession.id)
        )
        if status_filter:
            stmt = stmt.where(ChatSession.status == status_filter)
        if client_id:
            stmt = stmt.where(ChatSession.client_id == client_id)
        stmt = stmt.order_by(desc(ChatSession.created_at)).limit(500)
        rows = session.execute(stmt).all()
        return [_session_summary(s, b, c, lead) for s, b, c, lead in rows]


@router.get("/sessions/{session_id}")
def session_detail(session_id: SessionId, _admin: Client = Depends(get_superadmin)):
    """One conversation with its full message history.

    ``session_id`` is a :data:`~app.schemas.validators.SessionId`, not an int.
    ``chat_sessions.id`` is a String primary key holding a UUID-shaped token,
    so an ``int`` annotation rejected every real conversation id with a 422
    before the handler ran. ``SessionId`` is the bounded ``Identifier`` shape
    every other session-scoped route uses. A path segment that reaches a
    primary-key lookup stays length- and charset-bounded rather than becoming
    a bare ``str``.
    """
    with get_session() as session:
        s = session.get(ChatSession, session_id)
        if not s:
            raise HTTPException(status_code=404, detail="Session not found")
        bot = session.get(Bot, s.bot_id) if s.bot_id else None
        client = session.get(Client, s.client_id) if s.client_id else None
        lead = session.execute(select(LeadInfo).where(LeadInfo.session_id == session_id)).scalars().first()
        messages = (
            session.execute(
                select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.created_at)
            )
            .scalars()
            .all()
        )
        return {
            "session": _session_summary(s, bot, client, lead),
            "messages": [
                {
                    "id": m.id,
                    "session_id": m.session_id,
                    "role": m.role,
                    "content": m.content,
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                    "trace_id": getattr(m, "trace_id", None),
                }
                for m in messages
            ],
        }


@router.get("/live/queue")
def live_queue(_admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        rows = session.execute(
            select(ChatSession, Bot, Client, LeadInfo)
            .outerjoin(Bot, ChatSession.bot_id == Bot.id)
            .outerjoin(Client, ChatSession.client_id == Client.id)
            .outerjoin(LeadInfo, LeadInfo.session_id == ChatSession.id)
            .where(ChatSession.status.in_(["waiting", "live"]))
            .order_by(desc(ChatSession.created_at))
            .limit(100)
        ).all()
        return [_session_summary(s, b, c, lead) for s, b, c, lead in rows]


# ── Leads / operators ───────────────────────────────────────────────────────


@router.get("/leads")
def list_leads(_admin: Client = Depends(get_superadmin)):
    """Captured leads across every tenant, newest first, capped at 500.

    ``LeadInfo`` has **no** ``client_id`` column. The owning account is reached
    through the bot (``LeadInfo -> Bot -> Client``), the same path
    ``superadmin_ops_routes.list_crawls`` takes. Joining on a column that does
    not exist is what made this endpoint 500 on every call.

    The response key stays ``client_id`` (the console types it) but its value
    now comes from ``bots.client_id``. ``session_id`` is included so support
    can jump straight to the conversation the lead was captured in.
    """
    with get_session() as session:
        rows = session.execute(
            select(LeadInfo, Bot, Client)
            .outerjoin(Bot, LeadInfo.bot_id == Bot.id)
            .outerjoin(Client, Bot.client_id == Client.id)
            .order_by(desc(LeadInfo.created_at))
            .limit(500)
        ).all()
        return [
            {
                "id": lead.id,
                "session_id": lead.session_id,
                "bot_id": lead.bot_id,
                "bot_name": b.name if b else None,
                "client_id": b.client_id if b else None,
                "client_name": c.name if c else None,
                "name": lead.name,
                "email": lead.email,
                "phone": lead.phone,
                "company": lead.company,
                "created_at": lead.created_at.isoformat() if lead.created_at else "",
            }
            for lead, b, c in rows
        ]


@router.get("/operators")
def list_operators(_admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        rows = session.execute(select(Operator, Client).outerjoin(Client, Operator.client_id == Client.id)).all()
        return [
            {
                "id": o.id,
                "client_id": o.client_id,
                "client_name": c.name if c else None,
                "name": o.name,
                "email": o.email,
                "role": o.role,
                "department_id": getattr(o, "department_id", None),
                "is_active": getattr(o, "is_active", True),
                "max_concurrent_chats": getattr(o, "max_concurrent_chats", None),
                "created_at": o.created_at.isoformat() if getattr(o, "created_at", None) else None,
            }
            for o, c in rows
        ]


# ── Credits / pricing config / feature flags ───────────────────────────────


@router.get("/credits/ledger")
def credits_ledger(
    client_id: int | None = None,
    _admin: Client = Depends(get_superadmin),
):
    """Credit ledger entries, newest first, capped at 500.

    ``balance_after`` is a SQL window function over the account's **whole**
    history, partitioned by ``(client_id, bot_id)`` and ordered by
    ``(created_at, id)``; the 500-row page is applied *outside* the window.
    Both halves of that matter, and the previous implementation got both wrong
    by walking the returned page forward from zero:

    * Walking a page starts the running total at zero, so on any account with
      more than one page of history every number was fiction.
    * ``CreditLedger`` is scoped per ``(client_id, bot_id)`` under per-bot
      billing (see ``credit_service._scope_clause``): ``bot_id IS NULL`` is the
      client pool, a non-null ``bot_id`` is that bot's isolated ledger. A walk
      keyed on ``client_id`` alone blends a workspace's pooled ledger with each
      of its per-bot ledgers and reports a balance no scope actually holds.
      Postgres partitions NULLs together, so ``PARTITION BY client_id, bot_id``
      reproduces ``_scope_clause`` exactly.

    ``bot_id`` is on every row so a reader can tell which ledger a line belongs
    to; without it two interleaved running totals look like a corrupted one.

    Caveat worth stating: this is the running sum of ``delta``, which is the
    ledger's own arithmetic. ``credit_service.get_balance`` is the platform's
    single source of truth for the *spendable* balance and additionally
    subtracts the unconsumed remainder of top-up grants that have expired but
    which the daily sweep has not yet zeroed. The two agree except inside that
    window. Anything making a decision about spend must call ``get_balance``,
    not read this column.

    ``client_id`` stays optional, and the unfiltered listing is served in two
    steps rather than one. Computing the window first and paging it afterwards
    is correct but reads the WHOLE table on every unfiltered call: with no
    predicate and no inner limit, Postgres materialises the running sum for
    every row in ``credit_ledger`` and sorts the lot before taking 500. There
    is no index on bare ``created_at`` (only ``(client_id, created_at DESC)``),
    and the console calls this endpoint unfiltered by default.

    So: pick the 500 rows of the page first (a top-N sort, no window), then run
    the window only over the accounts those rows belong to, then keep the page.
    The running balance is still computed over each partition's FULL history,
    not over the page, so ``balance_after`` is unchanged and the response
    contract is identical — only the number of rows the window chews through
    moves. The narrowed pass filters on ``client_id``, the leading column of
    the index that does exist.

    The bound is honest about what it is: "the accounts on this page", not a
    constant. A ledger whose newest 500 rows come from 500 different accounts
    still windows all 500 accounts' history. It is bounded by the page, which
    the old shape was not, and on a realistic ledger (a few busy accounts
    producing most of the newest rows) the window's input drops by orders of
    magnitude. The remaining cost is the top-N sort over an unindexed
    ``created_at``; removing that needs an index, which is a migration and not
    this endpoint's to make.
    """
    with get_session() as session:
        # Step 1: the page itself, ids only. Ordering is total (``id`` breaks
        # the ``created_at`` ties that rows written in one transaction share),
        # so the same 500 rows come back every time.
        page_stmt = select(CreditLedger.id, CreditLedger.client_id)
        if client_id:
            page_stmt = page_stmt.where(CreditLedger.client_id == client_id)
        page = session.execute(
            page_stmt.order_by(desc(CreditLedger.created_at), desc(CreditLedger.id)).limit(500)
        ).all()
        if not page:
            return []
        page_ids = [row.id for row in page]
        page_client_ids = sorted({row.client_id for row in page})

        # Step 2: the window, over the full history of only the accounts that
        # page actually touches. The ids come back to Python and go out as an
        # explicit ``IN`` list (at most 500 of them) rather than staying a
        # sub-select on purpose: given real values the planner knows how few
        # accounts are involved and drives ``ix_credit_ledger_client_created``,
        # where a nested sub-select falls back to its default selectivity guess
        # and seq-scans the whole ledger to feed the window anyway. One extra
        # round trip buys an index scan over a full-table scan.
        #
        # ``PARTITION BY client_id, bot_id`` still reproduces
        # ``credit_service._scope_clause`` exactly (Postgres partitions NULLs
        # together), and every partition a page row belongs to is present in
        # FULL, because the input is narrowed by account, never by row. So
        # ``balance_after`` is unchanged from windowing the whole table.
        running_balance = (
            func.sum(CreditLedger.delta)
            .over(
                partition_by=(CreditLedger.client_id, CreditLedger.bot_id),
                order_by=(CreditLedger.created_at, CreditLedger.id),
            )
            .label("balance_after")
        )
        windowed = (
            select(
                CreditLedger.id,
                CreditLedger.client_id,
                CreditLedger.bot_id,
                CreditLedger.delta,
                CreditLedger.reason,
                CreditLedger.note,
                CreditLedger.grant_id,
                CreditLedger.expires_at,
                CreditLedger.created_at,
                running_balance,
            )
            .where(CreditLedger.client_id.in_(page_client_ids))
            .subquery()
        )

        # Step 3: keep the page. Filtering on the ids chosen in step 1 means
        # this can only return rows that query already chose.
        rows = session.execute(
            select(windowed)
            .where(windowed.c.id.in_(page_ids))
            .order_by(desc(windowed.c.created_at), desc(windowed.c.id))
        ).all()
        return [
            {
                "id": r.id,
                "client_id": r.client_id,
                "bot_id": r.bot_id,
                "delta": r.delta,
                "balance_after": int(r.balance_after or 0),
                "reason": r.note or r.reason,
                "grant_id": r.grant_id,
                "expires_at": r.expires_at.isoformat() if r.expires_at else None,
                "created_at": r.created_at.isoformat() if r.created_at else "",
            }
            for r in rows
        ]


@router.get("/pricing-config")
def list_pricing_config(_admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        rows = session.execute(select(PricingConfig)).scalars().all()
        return [
            {
                "key": r.key,
                "value": r.value,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            # ``billing.*`` documents (e.g. the seller profile) have their own
            # validated endpoints; keep them out of the raw key/value editor so
            # they can't be corrupted with an unvalidated write.
            for r in rows
            if not r.key.startswith("billing.")
        ]


class FlagWrite(BaseModel):
    value: Any


def _validate_credit_cost_write(key: str, value: Any) -> None:
    """Reject a ``credit_cost.*`` value that is not a whole number of credits.

    ``value`` is untyped JSONB, and this editor is a free-text field, so a
    cleared box, a typo'd sign, a decimal or a stray word all used to land in
    the database exactly as typed. Both readers survive that now
    (``credit_service._coerce_credit_cost`` fails closed and
    ``_credit_costs_payload`` serves what the ledger charges), but surviving is
    not the same as being right: a super admin who typed ``fre`` into
    ``credit_cost.ai_chat`` saw the panel accept it, while chats went on being
    charged the fail-closed default. The panel's own confirmation was the lie.

    Refusing at the boundary is what makes the saved value mean what it says.
    The read-side clamps stay as defence in depth: rows written before this
    check, seeds, and direct SQL are all still possible.

    Every ``credit_cost.*`` key is a whole non-negative number of credits, and
    ``document_upload_words_per_credit`` is additionally a divisor, so 0 is
    refused there rather than silently falling back to the shipped rate.
    """
    if not key.startswith("credit_cost."):
        return
    if isinstance(value, bool) or not isinstance(value, int):
        raise HTTPException(
            status_code=422,
            detail=f"'{key}' must be a whole number of credits (got {value!r}).",
        )
    if value < 0:
        raise HTTPException(
            status_code=422,
            detail=f"'{key}' cannot be negative (got {value!r}).",
        )
    if key == "credit_cost.document_upload_words_per_credit" and value == 0:
        raise HTTPException(
            status_code=422,
            detail=f"'{key}' is a divisor and must be at least 1 (got {value!r}).",
        )


@router.put("/pricing-config/{key}")
def update_pricing_config(
    key: str,
    body: FlagWrite,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    _require_write(admin)
    if key.startswith("billing."):
        raise HTTPException(
            status_code=422,
            detail=f"'{key}' has a dedicated validated endpoint; use PUT /superadmin/billing/... instead.",
        )
    _validate_credit_cost_write(key, body.value)
    with get_session() as session:
        existing = session.get(PricingConfig, key)
        before = existing.value if existing else None
        if existing:
            existing.value = body.value
            existing.updated_by = admin.id
        else:
            session.add(PricingConfig(key=key, value=body.value, updated_by=admin.id))
        record_audit(
            session,
            actor=admin,
            action="pricing_config.update",
            target_type="pricing_config",
            target_id=key,
            before={"value": before},
            after={"value": body.value},
            request=request,
        )
        session.commit()
    # Finding O2: the pricing/kill-switch config is read through a 60s in-memory
    # cache. Without invalidating it here, a super-admin toggle (e.g. the credit
    # kill switch) would take up to 60s to take effect, a fail-open window where
    # deductions keep running after the switch is flipped on. Invalidate now so
    # the change is immediate.
    from app.services.credit_service import invalidate_pricing_cache

    invalidate_pricing_cache()
    return {"key": key, "value": body.value}


@router.get("/feature-flags")
def list_feature_flags(admin: Client = Depends(get_superadmin)):
    # Reuse pricing_config for simplicity; flags live alongside other tunables.
    return list_pricing_config(_admin=admin)  # type: ignore[arg-type]


@router.put("/feature-flags/{key}")
def update_feature_flag(
    key: str,
    body: FlagWrite,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    return update_pricing_config(key=key, body=body, request=request, admin=admin)


# ── Audit ───────────────────────────────────────────────────────────────────


@router.get("/audit")
def list_audit(
    actor: str | None = None,
    action: str | None = None,
    _admin: Client = Depends(get_superadmin),
):
    with get_session() as session:
        stmt = select(AuditLog).order_by(desc(AuditLog.created_at)).limit(500)
        if actor:
            stmt = stmt.where(AuditLog.actor_name == actor)
        if action:
            stmt = stmt.where(AuditLog.action == action)
        rows = session.execute(stmt).scalars().all()
        return [
            {
                "id": r.id,
                "actor_id": r.actor_id,
                "actor_name": r.actor_name,
                "action": r.action,
                "target_type": r.target_type,
                "target_id": r.target_id,
                "before": r.before,
                "after": r.after,
                "ip": r.ip,
                "user_agent": r.user_agent,
                "created_at": r.created_at.isoformat() if r.created_at else "",
            }
            for r in rows
        ]


# ── Coupons (CRUD stub) ─────────────────────────────────────────────────────


class CouponCreate(BaseModel):
    code: CouponCodeStr
    # A discount, so both bounds matter: ``percent_off`` above 100 or a
    # negative ``amount_off_cents`` would each turn a coupon into a credit.
    percent_off: int | None = Field(default=None, ge=0, le=100)
    amount_off_cents: int | None = Field(default=None, ge=0, le=100_000_000)
    max_redemptions: int | None = Field(default=None, ge=1, le=1_000_000)
    expires_at: datetime | None = None
    applies_to_plan_ids: Annotated[list[RowId], bounded_list(_MAX_COUPON_PLANS)] | None = None


class CouponPatch(BaseModel):
    code: CouponCodeStr | None = None
    percent_off: int | None = Field(default=None, ge=0, le=100)
    amount_off_cents: int | None = Field(default=None, ge=0, le=100_000_000)
    max_redemptions: int | None = Field(default=None, ge=1, le=1_000_000)
    expires_at: datetime | None = None
    applies_to_plan_ids: Annotated[list[RowId], bounded_list(_MAX_COUPON_PLANS)] | None = None
    is_active: bool | None = None


@router.get("/coupons")
def list_coupons(_admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        rows = session.execute(select(Coupon).order_by(desc(Coupon.created_at))).scalars().all()
        return [_coupon_dict(r) for r in rows]


@router.post("/coupons")
def create_coupon(
    body: CouponCreate,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    _require_write(admin)
    if body.percent_off is None and body.amount_off_cents is None:
        raise HTTPException(status_code=400, detail="Either percent_off or amount_off_cents must be set.")
    with get_session() as session:
        coupon = Coupon(
            code=body.code,
            percent_off=body.percent_off,
            amount_off_cents=body.amount_off_cents,
            max_redemptions=body.max_redemptions,
            expires_at=body.expires_at,
            applies_to_plan_ids=body.applies_to_plan_ids,
        )
        session.add(coupon)
        session.flush()
        record_audit(
            session,
            actor=admin,
            action="coupon.create",
            target_type="coupon",
            target_id=coupon.id,
            after=_coupon_dict(coupon),
            request=request,
        )
        session.commit()
        return _coupon_dict(coupon)


@router.patch("/coupons/{coupon_id}")
def update_coupon(
    coupon_id: int,
    body: CouponPatch,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Partial update of a coupon. Only provided fields are modified."""
    _require_write(admin)
    with get_session() as session:
        coupon = session.get(Coupon, coupon_id)
        if not coupon:
            raise HTTPException(status_code=404, detail="Coupon not found")

        update_data = body.model_dump(exclude_unset=True)
        if not update_data:
            return _coupon_dict(coupon)

        # A coupon must always carry exactly one discount kind. Validate the
        # resulting state (post-merge) so a PATCH can't leave it with both or
        # neither. Mirrors the create-time guard.
        percent_off = update_data.get("percent_off", coupon.percent_off)
        amount_off_cents = update_data.get("amount_off_cents", coupon.amount_off_cents)
        if percent_off is None and amount_off_cents is None:
            raise HTTPException(status_code=400, detail="Either percent_off or amount_off_cents must be set.")

        before = _coupon_dict(coupon)
        for field, value in update_data.items():
            setattr(coupon, field, value)
        session.flush()

        record_audit(
            session,
            actor=admin,
            action="coupon.update",
            target_type="coupon",
            target_id=coupon.id,
            before=before,
            after=_coupon_dict(coupon),
            request=request,
        )
        session.commit()
        return _coupon_dict(coupon)


@router.delete("/coupons/{coupon_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_coupon(
    coupon_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Delete a coupon.

    A coupon that was never redeemed is hard-deleted. Once it has redemptions
    it is instead soft-deactivated (``is_active=False``) so historical
    attribution stays intact, same reasoning as the plan soft-delete.
    """
    _require_write(admin)
    with get_session() as session:
        coupon = session.get(Coupon, coupon_id)
        if not coupon:
            raise HTTPException(status_code=404, detail="Coupon not found")

        before = _coupon_dict(coupon)
        soft_deleted = (coupon.redemptions or 0) > 0
        if soft_deleted:
            coupon.is_active = False
        else:
            session.delete(coupon)
        session.flush()

        record_audit(
            session,
            actor=admin,
            action="coupon.deactivate" if soft_deleted else "coupon.delete",
            target_type="coupon",
            target_id=coupon_id,
            before=before,
            request=request,
        )
        session.commit()


# ── LLM usage (read-only) ───────────────────────────────────────────────────


@router.get("/llm/usage")
def llm_usage(
    days: int = Query(default=30, ge=1, le=365),
    model: str | None = None,
    _admin: Client = Depends(get_superadmin),
):
    cutoff = datetime.now(UTC) - timedelta(days=days)
    with get_session() as session:
        stmt = (
            select(
                func.date_trunc("day", LLMCallLog.created_at).label("d"),
                LLMCallLog.model,
                func.count().label("calls"),
                func.coalesce(func.sum(LLMCallLog.prompt_tokens), 0).label("pt"),
                func.coalesce(func.sum(LLMCallLog.completion_tokens), 0).label("ct"),
                func.coalesce(func.sum(LLMCallLog.cost_cents), 0).label("cost"),
                func.percentile_disc(0.5).within_group(LLMCallLog.latency_ms).label("p50"),
                func.percentile_disc(0.95).within_group(LLMCallLog.latency_ms).label("p95"),
                # ``case`` is a standalone SQLAlchemy construct, NOT a member of
                # ``func``. ``func.case(...)`` builds a generic SQL function named
                # "case", which rejects ``else_`` with
                # "Function.__init__() got an unexpected keyword argument 'else_'"
                # and 500s the whole endpoint.
                func.coalesce(func.sum(case((LLMCallLog.fallback_used, 1), else_=0)), 0).label("fallbacks"),
                func.coalesce(func.sum(case((LLMCallLog.error.isnot(None), 1), else_=0)), 0).label("errors"),
            )
            .where(LLMCallLog.created_at >= cutoff)
            .group_by("d", LLMCallLog.model)
            .order_by("d")
        )
        if model:
            stmt = stmt.where(LLMCallLog.model == model)
        try:
            rows = session.execute(stmt).all()
        except Exception:
            # The case() helper signature differs across SQLAlchemy versions; if
            # it fails we fall back to a simpler query without fallbacks count.
            simple = (
                select(
                    func.date_trunc("day", LLMCallLog.created_at).label("d"),
                    LLMCallLog.model,
                    func.count().label("calls"),
                    func.coalesce(func.sum(LLMCallLog.prompt_tokens), 0).label("pt"),
                    func.coalesce(func.sum(LLMCallLog.completion_tokens), 0).label("ct"),
                    func.coalesce(func.sum(LLMCallLog.cost_cents), 0).label("cost"),
                )
                .where(LLMCallLog.created_at >= cutoff)
                .group_by("d", LLMCallLog.model)
                .order_by("d")
            )
            rows = session.execute(simple).all()
            return [
                {
                    "date": r.d.date().isoformat() if hasattr(r.d, "date") else str(r.d),
                    "model": r.model,
                    "calls": int(r.calls),
                    "prompt_tokens": int(r.pt),
                    "completion_tokens": int(r.ct),
                    "cost_cents": int(r.cost),
                }
                for r in rows
            ]
        return [
            {
                "date": r.d.date().isoformat() if hasattr(r.d, "date") else str(r.d),
                "model": r.model,
                "calls": int(r.calls),
                "prompt_tokens": int(r.pt),
                "completion_tokens": int(r.ct),
                "cost_cents": int(r.cost),
                "p50_latency_ms": int(r.p50) if r.p50 is not None else None,
                "p95_latency_ms": int(r.p95) if r.p95 is not None else None,
                "fallback_count": int(r.fallbacks),
                "error_count": int(r.errors),
            }
            for r in rows
        ]


# ── Model & RAG runtime config ──────────────────────────────────────────────


_KNOWN_MODELS = [
    # OpenAI
    {"id": "openai/gpt-5-mini", "label": "GPT-5 Mini", "provider": "OpenAI", "tier": "fast"},
    {"id": "openai/gpt-5", "label": "GPT-5", "provider": "OpenAI", "tier": "frontier"},
    {"id": "openai/gpt-5-nano", "label": "GPT-5 Nano", "provider": "OpenAI", "tier": "cheap"},
    {"id": "openai/gpt-5.4-mini", "label": "GPT-5.4 Mini", "provider": "OpenAI", "tier": "fast"},
    {"id": "openai/gpt-4o-mini", "label": "GPT-4o Mini", "provider": "OpenAI", "tier": "fast"},
    {"id": "openai/gpt-4o", "label": "GPT-4o", "provider": "OpenAI", "tier": "frontier"},
    # Google
    {"id": "gemini/gemini-2.5-flash", "label": "Gemini 2.5 Flash", "provider": "Google", "tier": "fast"},
    {"id": "gemini/gemini-2.5-pro", "label": "Gemini 2.5 Pro", "provider": "Google", "tier": "frontier"},
    {"id": "gemini/gemini-1.5-flash", "label": "Gemini 1.5 Flash", "provider": "Google", "tier": "cheap"},
    # Anthropic (LiteLLM-compatible)
    {"id": "anthropic/claude-sonnet-4.5", "label": "Claude Sonnet 4.5", "provider": "Anthropic", "tier": "frontier"},
    {"id": "anthropic/claude-haiku-4.5", "label": "Claude Haiku 4.5", "provider": "Anthropic", "tier": "fast"},
]


_KNOWN_CRAWL_PROVIDERS = [
    {
        "id": "spider",
        "label": "Spider.cloud",
        "notes": "Bulk scraper with JS rendering and a recursive link-crawl mode (used when a site has no sitemap).",
    },
    {
        "id": "jina",
        "label": "Jina Reader",
        "notes": "PAYG markdown-native reader (r.jina.ai). Renders JS server-side; no recursive mode.",
    },
]


@router.get("/model-config")
def get_model_config(_admin: Client = Depends(get_superadmin)):
    """Return the active model + RAG knobs and the catalog of selectable models."""
    from app.services import runtime_config

    crawl_primary = runtime_config.get_crawl_provider_primary()
    return {
        "primary_model": runtime_config.get_primary_model(),
        "fallback_model": runtime_config.get_fallback_model(),
        "gate_model": runtime_config.get_gate_model(),
        "rag": {
            "chunk_size": runtime_config.get_chunk_size(),
            "chunk_overlap": runtime_config.get_chunk_overlap(),
            "rerank_top_n": runtime_config.get_rerank_top_n(),
            "relevance_threshold": runtime_config.get_relevance_threshold(),
        },
        "embed": {
            "concurrency": runtime_config.get_embed_concurrency(),
        },
        "crawler": {
            "primary_provider": crawl_primary,
            "fallback_provider": "jina" if crawl_primary == "spider" else "spider",
            "jina_fetch_concurrency": runtime_config.get_jina_fetch_concurrency(),
            "spider_fetch_concurrency": runtime_config.get_spider_fetch_concurrency(),
        },
        "impersonation": {
            # Effective state (env floor AND runtime row), so the UI shows what
            # is actually in force rather than just the DB row.
            "enabled": runtime_config.is_impersonation_enabled(),
            # When the env floor is off, the runtime toggle cannot turn it back
            # on, the UI should render the control disabled and say why.
            "locked_by_env": not IMPERSONATION_ENABLED,
        },
        "known_models": _KNOWN_MODELS,
        "known_crawl_providers": _KNOWN_CRAWL_PROVIDERS,
    }


class ModelConfigPatch(BaseModel):
    # LiteLLM model identifiers ("openai/gpt-5.4-mini"). Free-form because the
    # catalog is a vendor's, not ours, but bounded and charset-pinned, since
    # the value is persisted to runtime config and passed to the router on
    # every completion.
    primary_model: ModelId | None = None
    fallback_model: ModelId | None = None
    gate_model: ModelId | None = None
    chunk_size: int | None = Field(default=None, ge=200, le=8000)
    chunk_overlap: int | None = Field(default=None, ge=0, le=2000)
    rerank_top_n: int | None = Field(default=None, ge=1, le=20)
    relevance_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    embed_concurrency: int | None = Field(default=None, ge=1, le=64)
    crawl_provider_primary: Literal["spider", "jina"] | None = None
    jina_fetch_concurrency: int | None = Field(default=None, ge=1, le=50)
    spider_fetch_concurrency: int | None = Field(default=None, ge=1, le=50)
    # Impersonation kill switch (design §14). Lives here because this is the
    # runtime-config write path, the one that persists to pricing_config AND
    # invalidates the cache. Without an entry here the switch would have no way
    # to be flipped short of a deploy, which defeats the point.
    # NOTE: this is the fast lever only. The ``IMPERSONATION_ENABLED`` env var
    # is the floor and cannot be overridden from here.
    impersonation_enabled: bool | None = None


@router.put("/model-config")
def patch_model_config(
    body: ModelConfigPatch,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Update LLM models or RAG knobs at runtime.

    Each set of changes lands in ``pricing_config`` (the existing super-admin
    key/value store) and the runtime_config in-memory cache is invalidated so
    new chat requests see the change within a few seconds.
    """
    _require_write(admin)
    from app.services import runtime_config

    # Cross-field validation: chunk_size/chunk_overlap are independently
    # range-checked by ModelConfigPatch's Field(ge=..., le=...), but that
    # can't catch two separately-valid PUTs leaving overlap >= size (e.g. one
    # admin PUTs chunk_overlap=500 while chunk_size is still the 300 default
    # from an earlier PUT). An invalid combo crashes RecursiveCharacterTextSplitter
    # with an uncaught ValueError on the next ingestion (upload or crawl),
    # a platform-wide outage, not a per-request error. Validate the EFFECTIVE
    # post-patch values (new value if patched, else the current stored one)
    # before writing anything.
    effective_chunk_size = body.chunk_size if body.chunk_size is not None else runtime_config.get_chunk_size()
    effective_chunk_overlap = (
        body.chunk_overlap if body.chunk_overlap is not None else runtime_config.get_chunk_overlap()
    )
    if (
        body.chunk_size is not None or body.chunk_overlap is not None
    ) and effective_chunk_overlap >= effective_chunk_size:
        raise HTTPException(
            status_code=400,
            detail=(
                f"chunk_overlap ({effective_chunk_overlap}) must be less than "
                f"chunk_size ({effective_chunk_size}). This combination would crash "
                "ingestion (RecursiveCharacterTextSplitter) on the next upload or crawl."
            ),
        )

    # Map field name -> pricing_config key
    field_to_key = {
        "primary_model": "model.primary",
        "fallback_model": "model.fallback",
        "gate_model": "model.gate",
        "chunk_size": "rag.chunk_size",
        "chunk_overlap": "rag.chunk_overlap",
        "rerank_top_n": "rag.rerank_top_n",
        "relevance_threshold": "rag.relevance_threshold",
        "embed_concurrency": "embed.concurrency",
        "crawl_provider_primary": "crawl.provider_primary",
        "jina_fetch_concurrency": "crawl.jina_fetch_concurrency",
        "spider_fetch_concurrency": "crawl.spider_fetch_concurrency",
        "impersonation_enabled": "impersonation.enabled",
    }

    changed: dict[str, Any] = {}
    with get_session() as session:
        for field, key in field_to_key.items():
            new_value = getattr(body, field)
            if new_value is None:
                continue
            existing = session.get(PricingConfig, key)
            before = existing.value if existing else None
            if existing:
                existing.value = new_value
                existing.updated_by = admin.id
            else:
                session.add(PricingConfig(key=key, value=new_value, updated_by=admin.id))
            changed[key] = {"before": before, "after": new_value}

        if changed:
            record_audit(
                session,
                actor=admin,
                action="model_config.update",
                target_type="model_config",
                target_id="*",
                before={k: v["before"] for k, v in changed.items()},
                after={k: v["after"] for k, v in changed.items()},
                request=request,
            )
        session.commit()

    runtime_config.invalidate_runtime_config_cache()

    return {
        "ok": True,
        "changed": list(changed.keys()),
        "primary_model": runtime_config.get_primary_model(),
        "fallback_model": runtime_config.get_fallback_model(),
        "gate_model": runtime_config.get_gate_model(),
        "crawl_provider_primary": runtime_config.get_crawl_provider_primary(),
    }


# ── Safety-net metrics (AR-13) ───────────────────────────────────────────────

# Mirrors the `_safety_net_metric` call sites in rag_service.py. Kept as a
# plain list here (not imported) to avoid a superadmin_routes_v2 <-> rag_service
# coupling for what is otherwise a self-contained read-only reporting route.
_SAFETY_NET_METRIC_NAMES = [
    "bant_extraction_failed",
    "groundedness_check",
    "handoff_safety_net_triggered",
    "injection_attempt",
    "intent_router_short_circuit",
    "leave_message_card_rendered",
    "leave_message_safety_net_triggered",
    "moderation_block",
    "no_info_pivot",
    "off_topic_refusal",
    "output_moderation_block",
    "system_prompt_leak",
    # AR-15/AR-16: LLM call-outcome metrics (llm_service.py), included here
    # for a single unified reporting endpoint even though they're not
    # rag_service.py safety-net firings.
    "llm_config_error",
    "llm_transient_error",
    "llm_unknown_error",
    "llm_fallback_triggered",
    # AR-26: real per-bot token volume for FinOps visibility into the flat
    # 1-credit `ai_chat` charge. See `_meter_token_usage` (llm_service.py).
    "llm_tokens_prompt",
    "llm_tokens_completion",
    # AR-40: how often the zero-result multi-query fallback actually
    # recovers chunks a single embedding shot missed.
    "multi_query_fallback_recovered",
]


@router.get("/safety-net-metrics")
def safety_net_metrics(
    hours: int = Query(default=24, ge=1, le=168),
    bot_id: RowId | None = Query(default=None),
    _admin: Client = Depends(get_superadmin),
):
    """Rolling hourly counts for every safety-net metric (AR-13), the
    previously-missing "consumer" for `_safety_net_metric`'s log lines.
    Optionally scoped to a single bot via ``bot_id``."""
    from app.core.metrics import get_metric_counts

    totals: dict[str, int] = {}
    series: dict[str, dict[str, int]] = {}
    for name in _SAFETY_NET_METRIC_NAMES:
        counts = get_metric_counts(name, bot_id=bot_id, hours=hours)
        series[name] = counts
        totals[name] = sum(counts.values())

    return {"hours": hours, "bot_id": bot_id, "totals": totals, "series": series}


# ── Email templates (Brevo) ─────────────────────────────────────────────────


@router.get("/email-templates")
def email_templates(_admin: Client = Depends(get_superadmin)):
    """Catalog of every Brevo template the platform sends.

    Pulls the constants from ``email_service`` so this list stays in sync
    automatically whenever a developer registers a new template ID.
    """
    from app.services import email_service as es

    items = [
        {
            "id": es.TEMPLATE_PASSWORD_RESET,
            "key": "password_reset",
            "name": "Password reset",
            "audience": "client",
            "category": "auth",
            "description": "OTP code email sent when a customer requests a password reset.",
            "trigger": "POST /auth/forgot-password",
            "metered": False,
            "sender_fn": "send_password_reset_email",
        },
        {
            "id": es.TEMPLATE_QUALIFIED_LEAD,
            "key": "qualified_lead",
            "name": "Qualified lead alert",
            "audience": "client",
            "category": "lead",
            "description": "Notifies the customer when a chat conversation crosses the BANT/MEDDIC qualification threshold.",
            "trigger": "qualification_service tier transition",
            "metered": False,
            "sender_fn": "send_qualified_lead_email",
        },
        {
            "id": es.TEMPLATE_HANDOFF_REQUEST,
            "key": "handoff_request",
            "name": "Handoff request",
            "audience": "operator",
            "category": "live_chat",
            "description": "Pings operators that a visitor is waiting in the live-chat queue.",
            "trigger": "live_chat_service when a visitor enters waiting state",
            "metered": False,
            "sender_fn": "send_handoff_request_email",
        },
        {
            "id": es.TEMPLATE_MISSED_CALLBACK,
            "key": "missed_callback",
            "name": "Missed callback",
            "audience": "visitor",
            "category": "live_chat",
            "description": "Apology + reschedule link sent when no operator picked up before the queue timeout.",
            "trigger": "live_chat_service queue timeout",
            "metered": False,
            "sender_fn": "send_unavailable_callback_email",
        },
        {
            "id": es.TEMPLATE_OFFLINE_MESSAGE,
            "key": "offline_message",
            "name": "Offline message",
            "audience": "client",
            "category": "live_chat",
            "description": "Delivers a visitor's contact-form submission when the team is offline.",
            "trigger": "POST /offline-messages",
            "metered": False,
            "sender_fn": "send_offline_message_email",
        },
        {
            "id": es.TEMPLATE_CHAT_TRANSCRIPT,
            "key": "chat_transcript",
            "name": "Chat transcript",
            "audience": "visitor",
            "category": "post_chat",
            "description": "On-demand conversation transcript emailed to the visitor at session end.",
            "trigger": "Visitor opt-in at session close",
            "metered": False,
            "sender_fn": "send_transcript_email",
        },
        {
            "id": es.TEMPLATE_VISITOR_CONFIRMATION,
            "key": "visitor_confirmation",
            "name": "Visitor confirmation",
            "audience": "visitor",
            "category": "live_chat",
            "description": "Auto-reply confirming the visitor's message reached the team.",
            "trigger": "Offline / handoff form submit",
            "metered": False,
            "sender_fn": "send_visitor_confirmation_email",
        },
    ]

    return {
        "provider": "Brevo",
        "manage_url": "https://app.brevo.com/templates/listing",
        "from_address": getattr(__import__("app.config", fromlist=["EMAIL_FROM_ADDRESS"]), "EMAIL_FROM_ADDRESS", None),
        "from_name": getattr(__import__("app.config", fromlist=["EMAIL_FROM_NAME"]), "EMAIL_FROM_NAME", None),
        "enabled": getattr(__import__("app.config", fromlist=["EMAIL_ENABLED"]), "EMAIL_ENABLED", False),
        "templates": items,
    }


# ── Server logs (journalctl) ────────────────────────────────────────────────


@router.get("/logs")
def server_logs(
    # Allow-listed in ``logs_service.fetch_logs`` against ``ALLOWED_SERVICES``
    # (mapped to a 400 naming the permitted units). That check is what keeps
    # this value out of a subprocess argument, so it stays the single source
    # of truth; this only bounds the string.
    service: str = Query(default="oyechats-api", max_length=64),
    lines: int = Query(default=500, ge=10, le=5_000),
    level: Literal["debug", "info", "warning", "error", "critical"] | None = Query(default=None),
    grep: str | None = Query(default=None, max_length=200),
    _admin: Client = Depends(get_superadmin),
):
    """Tail journalctl for the API or worker systemd unit.

    Saves the operator from SSH-ing in for routine log checks. The service
    name is allowlisted inside ``logs_service.fetch_logs`` so this endpoint
    cannot be coerced into reading arbitrary units.
    """
    from app.services.logs_service import ALLOWED_SERVICES, fetch_logs

    try:
        return fetch_logs(service=service, lines=lines, level=level, grep=grep)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc
    finally:
        _ = ALLOWED_SERVICES  # imported for side-effect only; keep ruff quiet


# ── AI observability (Langfuse) ─────────────────────────────────────────────


@router.get("/observability/langfuse")
def langfuse_summary(
    days: int = Query(default=7, ge=1, le=30),
    _admin: Client = Depends(get_superadmin),
):
    """Recent Langfuse traces, scores, and daily metrics.

    Read-only proxy to the Langfuse public API so the dashboard can show
    LLM activity without re-enabling the SDK on the server (which causes
    APIConnectionError under memory pressure. See CLAUDE.md).
    """
    return fetch_langfuse_summary(days=days)


# ── System health (full) ────────────────────────────────────────────────────


@router.get("/system/health/full")
def system_health_full(_admin: Client = Depends(get_superadmin)):
    """Detailed health snapshot with per-service connectivity."""
    from importlib.metadata import PackageNotFoundError
    from importlib.metadata import version as _pkg_version

    from app.core.cache import get_redis
    from app.worker.enqueue import WORKER_ENABLED
    from app.worker.tasks import WORKER_HEARTBEAT_KEY

    # ``app.config`` is a module of constants, not a settings object, a
    # previous ``from app.config import settings`` would have thrown an
    # ImportError the first time this endpoint fired. Read the version
    # from the installed package metadata instead (matches pyproject.toml
    # ``[project].version``), with a defensive fallback for editable
    # installs that haven't been ``uv sync``'d.
    try:
        _api_version = _pkg_version("oyechats-api")
    except PackageNotFoundError:
        _api_version = "unknown"
    health: dict[str, Any] = {"status": "healthy", "version": _api_version}

    try:
        with get_session() as session:
            session.execute(select(1))
        health["database"] = "connected"
    except Exception:
        health["database"] = "unreachable"
        health["status"] = "degraded"

    # -- Redis --
    redis_ok = False
    redis_client = None
    try:
        redis_client = get_redis()
        if redis_client is not None:
            redis_client.ping()
            redis_ok = True
    except Exception:
        redis_ok = False
    health["redis"] = "connected" if redis_ok else "unreachable"
    if not redis_ok:
        health["status"] = "degraded"

    # -- Worker heartbeat: the ARQ worker refreshes WORKER_HEARTBEAT_KEY on a
    # short interval, so a present key means it checked in within the TTL. --
    if not WORKER_ENABLED:
        health["worker"] = "disabled"
    else:
        worker_alive = False
        if redis_ok and redis_client is not None:
            try:
                worker_alive = redis_client.get(WORKER_HEARTBEAT_KEY) is not None
            except Exception:
                worker_alive = False
        health["worker"] = "connected" if worker_alive else "unreachable"
        if not worker_alive:
            health["status"] = "degraded"

    # ``app.config`` is a module of top-level constants, not a settings
    # object, the previous ``getattr(settings, …)`` lookups would have
    # thrown ImportError inside the function. Read the constants directly.
    from app.config import R2_BUCKET_NAME, RAZORPAY_ENABLED

    health["razorpay"] = "connected" if RAZORPAY_ENABLED else "disabled"
    health["storage"] = "connected" if R2_BUCKET_NAME else "unknown"
    return health


# ── Internal helpers ────────────────────────────────────────────────────────


def _session_summary(s: ChatSession, b: Bot | None, c: Client | None, lead: LeadInfo | None) -> dict[str, Any]:
    """One session row for the sessions list, the live queue and session detail.

    ``lead`` is the session's ``LeadInfo`` row, or ``None`` when the visitor
    never identified themselves. It is a required argument, not an optional
    one: every call site outer-joins it (``lead_info.session_id`` is UNIQUE,
    so the join is 1:1 with no fan-out), and a default of ``None`` would let a
    future call site quietly serve nulls again.

    Two deliberate non-obvious choices:

    * Attributes are read directly, never through ``getattr(s, ..., None)``.
      This payload shipped three permanently-null fields (``visitor_name``,
      ``visitor_email``, ``last_activity_at``) precisely because a defaulted
      read turns a wrong column name into a silent null instead of an
      ``AttributeError`` on the first request.
    * The wire key stays ``last_activity_at`` while the column read is the real
      ``ChatSession.last_active_at``. The console types the key; renaming it
      costs a coordinated deploy and buys nothing.
    """
    return {
        "id": s.id,
        "bot_id": s.bot_id,
        "bot_name": b.name if b else None,
        "client_id": s.client_id,
        "client_name": c.name if c else None,
        "status": s.status,
        "visitor_name": lead.name if lead else None,
        "visitor_email": lead.email if lead else None,
        "rating": s.visitor_rating,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "last_activity_at": s.last_active_at.isoformat() if s.last_active_at else None,
    }


def _subscription_summary(session, sub) -> dict[str, Any] | None:
    if not sub:
        return None
    from app.db.models import Plan

    plan = session.get(Plan, sub.plan_id) if sub.plan_id else None
    return {
        "id": sub.id,
        "client_id": sub.client_id,
        "client_name": "",
        "plan_id": sub.plan_id,
        "plan_name": plan.name if plan else "",
        "status": sub.status,
        "billing_cycle": sub.billing_cycle,
        "operator_quantity": sub.operator_quantity,
        "payment_provider": sub.payment_provider,
        "current_period_start": sub.current_period_start.isoformat() if sub.current_period_start else None,
        "current_period_end": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "trial_end": sub.trial_end.isoformat() if sub.trial_end else None,
        "canceled_at": sub.canceled_at.isoformat() if sub.canceled_at else None,
        "created_at": sub.created_at.isoformat() if sub.created_at else None,
    }


def _coupon_dict(c: Coupon) -> dict[str, Any]:
    return {
        "id": c.id,
        "code": c.code,
        "percent_off": c.percent_off,
        "amount_off_cents": c.amount_off_cents,
        "max_redemptions": c.max_redemptions,
        "redemptions": c.redemptions,
        "expires_at": c.expires_at.isoformat() if c.expires_at else None,
        "applies_to_plan_ids": c.applies_to_plan_ids,
        "is_active": c.is_active,
        "created_at": c.created_at.isoformat() if c.created_at else "",
    }


# ── billing: seller-of-record profile ───────────────────────────────────────


class SellerProfileBody(BaseModel):
    # All optional for PATCH semantics. Omitted fields keep their stored value
    # (legal_name's required-on-first-save rule is enforced by the service).
    # ``exclude_unset`` in the handler preserves the omitted-vs-explicit-null
    # distinction so a field can be intentionally cleared with ``null``.
    legal_name: str | None = None
    trade_name: str | None = None
    gstin: str | None = None
    address_lines: list[str] | None = None
    state_code: str | None = None
    country: str | None = None
    sac_code: str | None = None
    tax_rate_bps: int | None = None
    price_inclusive: bool | None = None
    lut_active: bool | None = None
    lut_number: str | None = None
    invoice_prefix: str | None = None
    logo_url: str | None = None


def _profile_dict(profile: SellerProfile) -> dict[str, Any]:
    return {
        "configured": profile.configured,
        "gst_enabled": profile.gst_enabled,
        "legal_name": profile.legal_name,
        "trade_name": profile.trade_name,
        "gstin": profile.gstin,
        "address_lines": profile.address_lines,
        "state_code": profile.state_code,
        "country": profile.country,
        "sac_code": profile.sac_code,
        "tax_rate_bps": profile.tax_rate_bps,
        "price_inclusive": profile.price_inclusive,
        "lut_active": profile.lut_active,
        "lut_number": profile.lut_number,
        "invoice_prefix": profile.invoice_prefix,
        "logo_url": profile.logo_url,
        # Companies Act s.12(3)(c) identity. Omitting these from the serializer
        # made the console render them blank no matter what was stored, so an
        # operator saving a CIN saw it vanish on the next load.
        "cin": profile.cin,
        "phone": profile.phone,
        "website": profile.website,
        "support_email": profile.support_email,
    }


@router.get("/billing/seller-profile")
def read_seller_profile(_admin: Client = Depends(get_superadmin)):
    """Seller identity printed on tax invoices (invoicing v2 Phase 0)."""
    with get_session() as session:
        return _profile_dict(get_seller_profile(session))


@router.put("/billing/seller-profile")
def update_seller_profile(
    body: SellerProfileBody,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    _require_write(admin)
    with get_session() as session:
        before = _profile_dict(get_seller_profile(session))
        try:
            profile = save_seller_profile(
                session,
                body.model_dump(exclude_unset=True),
                actor_id=admin.id,
            )
        except SellerProfileError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        after = _profile_dict(profile)
        record_audit(
            session,
            actor=admin,
            action="billing.seller_profile.update",
            target_type="pricing_config",
            target_id="billing.seller_profile",
            before=before,
            after=after,
            request=request,
        )
        session.commit()
        return after


# ── billing: invoice console (invoicing v2 Phase 6) ─────────────────────────


def _send_invoice_email_now(to_email: str, invoice: Invoice, pdf_url: str) -> None:
    """Indirection point (tests substitute it) around the invoice email."""
    from app.services.email_service import send_invoice_email

    send_invoice_email(to_email, invoice, pdf_url)


def _invoice_row(inv: Invoice, client_name: str | None) -> dict[str, Any]:
    return {
        "id": inv.id,
        "client_id": inv.client_id,
        "client_name": client_name,
        "invoice_number": inv.invoice_number,
        "invoice_type": inv.invoice_type,
        "status": inv.status,
        "amount_cents": inv.amount_cents,
        "currency": inv.currency,
        "taxable_value_minor": inv.taxable_value_minor,
        "total_tax_minor": inv.total_tax_minor,
        "supply_kind": inv.supply_kind,
        "is_export": inv.is_export,
        "pdf_url": inv.pdf_url,
        "credit_note_of_id": inv.credit_note_of_id,
        "issued_at": inv.issued_at.isoformat() if inv.issued_at else None,
        "created_at": inv.created_at.isoformat() if inv.created_at else None,
    }


@router.get("/invoices")
def list_all_invoices(
    _admin: Client = Depends(get_superadmin),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    invoice_type: Literal["tax_invoice", "credit_note", "receipt", "legacy"] | None = Query(None),
    client_id: RowId | None = Query(None),
    search: str | None = Query(None, max_length=120),
    include_legacy: bool = Query(False),
):
    """All issued documents (tax invoices / credit notes / receipts), newest first.

    Legacy payment-history rows are excluded by default. They are not legal
    documents; flip ``include_legacy`` for the raw payment mirror.
    """
    with get_session() as session:
        stmt = select(Invoice, Client.name).join(Client, Invoice.client_id == Client.id)
        if not include_legacy:
            stmt = stmt.where(Invoice.invoice_number.isnot(None))
        if invoice_type:
            stmt = stmt.where(Invoice.invoice_type == invoice_type)
        if client_id:
            stmt = stmt.where(Invoice.client_id == client_id)
        if search:
            escaped = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            needle = f"%{escaped}%"
            stmt = stmt.where(
                Invoice.invoice_number.ilike(needle) | Client.email.ilike(needle) | Client.name.ilike(needle)
            )
        total = session.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
        rows = session.execute(stmt.order_by(desc(Invoice.id)).offset((page - 1) * limit).limit(limit)).all()
        return {
            "total": int(total),
            "page": page,
            "limit": limit,
            "items": [_invoice_row(inv, client_name) for inv, client_name in rows],
        }


@router.get("/invoices/{invoice_id}")
def invoice_detail(invoice_id: int, _admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        inv = session.get(Invoice, invoice_id)
        if inv is None:
            raise HTTPException(status_code=404, detail="Invoice not found")
        client = session.get(Client, inv.client_id)
        return {
            **_invoice_row(inv, client.name if client else None),
            "razorpay_payment_id": inv.razorpay_payment_id,
            "razorpay_invoice_id": inv.razorpay_invoice_id,
            "tax_rate_bps": inv.tax_rate_bps,
            "cgst_minor": inv.cgst_minor,
            "sgst_minor": inv.sgst_minor,
            "igst_minor": inv.igst_minor,
            "hsn_sac": inv.hsn_sac,
            "place_of_supply": inv.place_of_supply,
            "seller_snapshot": inv.seller_snapshot,
            "buyer_snapshot": inv.buyer_snapshot,
            "line_items": inv.line_items,
            "description": inv.description,
            "period_start": inv.period_start.isoformat() if inv.period_start else None,
            "period_end": inv.period_end.isoformat() if inv.period_end else None,
            "invoice_url": inv.invoice_url,
        }


@router.post("/invoices/{invoice_id}/resend-email")
def resend_invoice_email(invoice_id: int, request: Request, admin: Client = Depends(get_superadmin)):
    """Re-send the document email to the buyer (e.g. after a lost delivery)."""
    _require_write(admin)
    from app import config as app_config

    # The kill switch governs ALL customer-facing delivery, a resend while
    # it's off would email a document whose serial the customer API is
    # deliberately hiding.
    if not app_config.INVOICE_EMAILS_ENABLED:
        raise HTTPException(status_code=409, detail="Invoice emails are disabled (INVOICE_EMAILS_ENABLED).")
    with get_session() as session:
        inv = session.get(Invoice, invoice_id)
        if inv is None:
            raise HTTPException(status_code=404, detail="Invoice not found")
        if not inv.invoice_number or not inv.pdf_url:
            raise HTTPException(
                status_code=409,
                detail="No rendered PDF yet, the sweep renders within ~5 minutes; retry shortly.",
            )
        to_email = (inv.buyer_snapshot or {}).get("email")
        if not to_email:
            raise HTTPException(status_code=409, detail="Invoice has no buyer email on record.")
        _send_invoice_email_now(to_email, inv, inv.pdf_url)
        inv.emailed_at = datetime.now(UTC)
        record_audit(
            session,
            actor=admin,
            action="billing.invoice.resend_email",
            target_type="invoice",
            target_id=inv.id,
            after={"to": to_email, "invoice_number": inv.invoice_number},
            request=request,
        )
        session.commit()
        return {"sent_to": to_email, "invoice_number": inv.invoice_number}


@router.post("/invoices/{invoice_id}/regenerate-pdf")
def regenerate_invoice_pdf(invoice_id: int, request: Request, admin: Client = Depends(get_superadmin)):
    """Queue a fresh PDF render (template fix, corrupted object, …).

    Clears ``pdf_url`` so the 5-minute worker sweep re-renders and re-uploads
    under a NEW capability URL; the old R2 object simply becomes unreferenced.
    The document data itself is immutable. Only the rendering is redone.
    """
    _require_write(admin)
    with get_session() as session:
        inv = session.get(Invoice, invoice_id)
        if inv is None:
            raise HTTPException(status_code=404, detail="Invoice not found")
        if not inv.invoice_number:
            raise HTTPException(status_code=409, detail="Legacy rows have no document to regenerate.")
        before = {"pdf_url": inv.pdf_url}
        inv.pdf_url = None
        inv.invoice_url = None
        record_audit(
            session,
            actor=admin,
            action="billing.invoice.regenerate_pdf",
            target_type="invoice",
            target_id=inv.id,
            before=before,
            request=request,
        )
        session.commit()
        return {"invoice_number": inv.invoice_number, "queued": True}


# ── billing: GSTR export + reconciliation (invoicing v2 Phase 7) ────────────


@router.get("/billing/gstr-export")
def gstr_export_csv(
    month: str = Query(..., pattern=r"^\d{4}-\d{2}$", description="IST calendar month, e.g. 2026-07"),
    _admin: Client = Depends(get_superadmin),
):
    """Document-level GSTR-1-style CSV for the CA (B2B / B2CS / B2CL / EXP /
    CDNR / CDNUR sections + per-section summary). Amounts in RUPEES (two
    decimals), the filing is rupee-denominated, unlike the API's minor units."""
    import csv
    import io

    from fastapi.responses import PlainTextResponse

    from app.services import invoice_reports

    with get_session() as session:
        try:
            rows = invoice_reports.gstr_document_rows(session, month)
            summary = invoice_reports.gstr_summary(session, month)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    def _r(minor: int | None) -> str:
        # Blank, not "0.00", for a genuinely absent figure, a rupee column
        # that could not be derived (a tampered export with no FX mirror) must
        # look absent to the CA, not like a zero-value supply.
        if minor is None:
            return ""
        return f"{minor / 100:.2f}"

    # ``csv_safe`` is applied cell by cell, deliberately NOT through
    # ``csv_safe_row``. The row funnel would also reach the money columns, and
    # every one of them is a string produced by ``_r``, a negative figure
    # renders as ``-5.00``, whose leading ``-`` is a formula trigger, so the
    # funnel would quote a tax amount and hand the CA a text cell where the
    # return needs a number. Only the six identity columns below carry
    # customer-controlled text; the rest are server-formatted.

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "section",
            "invoice_number",
            "invoice_date",
            "buyer_name",
            "buyer_gstin",
            "place_of_supply",
            "hsn_sac",
            "rate_percent",
            "gross_value",
            "taxable_value",
            "cgst",
            "sgst",
            "igst",
            "total_tax",
            # Denomination of the document the customer actually holds. On an
            # export these differ from the rupee columns above, which are what
            # goes on the return (Rule 34(2) conversion at the time of supply).
            "doc_currency",
            "doc_gross_value",
            "doc_taxable_value",
            "doc_total_tax",
            "fx_rate",
            "against_invoice",
            "against_invoice_date",
        ]
    )
    for row in rows:
        writer.writerow(
            [
                row["section"],
                csv_safe(row["invoice_number"]),
                row["invoice_date"] or "",
                csv_safe(row["buyer_name"]),
                csv_safe(row["buyer_gstin"]),
                csv_safe(row["place_of_supply"]),
                csv_safe(row["hsn_sac"]),
                f"{(row['rate_bps'] or 0) / 100:.2f}",
                _r(row["gross_minor"]),
                _r(row["taxable_minor"]),
                _r(row["cgst_minor"]),
                _r(row["sgst_minor"]),
                _r(row["igst_minor"]),
                _r(row["total_tax_minor"]),
                row["currency"],
                _r(row["doc_gross_minor"]),
                _r(row["doc_taxable_minor"]),
                _r(row["doc_total_tax_minor"]),
                f"{row['fx_rate_micros'] / 1_000_000:.4f}" if row["fx_rate_micros"] else "",
                csv_safe(row["against_invoice"]),
                row["against_invoice_date"] or "",
            ]
        )
    writer.writerow([])
    writer.writerow(["SUMMARY", "section", "count", "gross_value", "taxable_value", "total_tax"])
    for name, bucket in sorted(summary["sections"].items()):
        writer.writerow(
            [
                "SUMMARY",
                name,
                bucket["count"],
                _r(bucket["gross_minor"]),
                _r(bucket["taxable_minor"]),
                _r(bucket["total_tax_minor"]),
            ]
        )
    grand = summary["grand_total"]
    writer.writerow(
        [
            "SUMMARY",
            "TOTAL",
            grand["count"],
            _r(grand["gross_minor"]),
            _r(grand["taxable_minor"]),
            _r(grand["total_tax_minor"]),
        ]
    )
    # UTF-8 BOM so Excel opens Devanagari / non-ASCII legal names correctly.
    return PlainTextResponse(
        "﻿" + buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="gstr-{month}.csv"'},
    )


def _cycle_at_risk_minor(
    plan: Plan | None,
    billing_cycle: str | None,
    currency: str,
    discount_bps: int = 0,
) -> int | None:
    """The ONE billing cycle a past-due subscription is about to lose, in minor units.

    ``currency`` is the rail the customer is actually charged on, so the price
    column has to match it: the INR columns for an INR-rail customer, the
    ``*_usd_cents`` columns for a USD-rail one. ``billing_cycle`` picks annual
    or monthly; reading ``monthly_price_cents`` regardless of cycle understates
    an annual subscription by a factor of roughly twelve.

    ``discount_bps`` is the third axis, and it is not decoration either. A
    standing referral discount is applied by swapping in a DISCOUNTED Razorpay
    plan (``razorpay_service.resolve_discounted_plan``), so it recurs on every
    cycle, while ENTITLEMENTS deliberately follow the base ``plan_id``. Reading
    the base plan's price column therefore quotes list price for a customer who
    has never paid it: at the platform's 50% cap
    (``affiliate_service.MAX_CUSTOMER_DISCOUNT_BPS``) that is double the truth,
    in a field a super admin reads as money at risk, and in the
    ``at_risk_by_currency`` totals built from it. The arithmetic is
    ``resolve_discounted_plan``'s own — ``base - floor(base × bps / 10000)`` —
    so the two cannot round apart.

    Returns ``None`` when the amount cannot be stated honestly:

    * no plan row at all, or
    * a plan whose price column for this rail and cycle carries no usable
      amount. On the USD rail ``Plan.monthly_price_usd_cents`` /
      ``annual_price_usd_cents`` are nullable and a NULL on a paid plan is a
      config defect (``app.core.pricing`` says so in as many words). On the INR
      rail ``monthly_price_cents`` / ``annual_price_cents`` are ``NOT NULL
      DEFAULT 0``, so the very same defect — an annual subscription against a
      plan that only ever had its monthly price filled in — surfaces as ``0``
      rather than as NULL.

    Both rails are therefore read through ONE expression and one test: a
    missing or non-positive price is ``None``. Answering ``0`` for the INR half
    of the identical defect was the dishonest reading — it printed "₹0.00 at
    risk" for a customer who is about to lose a real billing cycle, and counted
    that row in the currency total as if nothing were at stake, which is
    exactly what the paragraph below argues against. Falling back to the INR
    figure on a USD row would be the other way to lie: a rupee amount under a
    ``USD`` label.

    A ``None`` row is excluded from the totals rather than counted as zero, so
    a broken plan row shows up as a gap instead of quietly shrinking the queue.
    """
    if plan is None:
        return None
    annual = (billing_cycle or "monthly").strip().lower() == "annual"
    if currency == "USD":
        price = plan.annual_price_usd_cents if annual else plan.monthly_price_usd_cents
    else:
        price = plan.annual_price_cents if annual else plan.monthly_price_cents
    if price is None or int(price) <= 0:
        return None
    price = int(price)
    if discount_bps:
        price -= (price * int(discount_bps)) // 10000
    return price


@router.get("/billing/dunning")
def dunning_overview(_admin: Client = Depends(get_superadmin)):
    """Who is currently failing payment, how far into grace, and what it is worth.

    The operator's save-call queue. ``emails_sent`` shows how far the automated
    cadence has got, so support can see whether a customer has already been
    warned before phoning them.

    **What the money field is.** ``cycle_at_risk_minor`` is the value of the
    ONE billing cycle this subscription is about to lose, in the minor units of
    ``currency``, NET of any standing referral discount. It is not arrears and
    not "amount owed": Razorpay does NOT re-attempt the missed charge when a
    halted subscription returns to active, so a recovery leaves that one cycle
    uncollected unless somebody charges it manually. A customer three cycles
    into failure still shows one cycle here. ``discount_bps`` is served beside
    it so a figure below the plan's list price is explicable on the row rather
    than looking like a bug.

    **Where the discount comes from.** ``discount_service.resolve_customer_discount_bps``,
    the same resolver the checkout path uses, read live off the customer's
    attributed referral code. There is no stored per-subscription amount to read
    instead: ``Subscription.razorpay_billing_plan_id`` was added for exactly
    this and is never written by any code path. So a code whose percentage was
    edited, or deactivated, AFTER this subscription was created resolves to
    today's value while the Razorpay mandate keeps billing the amount it was
    minted at. That residual gap is a fraction of the up-to-2x one it replaces,
    and it closes properly only by persisting the billed plan (see the column's
    own comment).

    **Where the currency comes from.** ``Plan.currency`` is not the answer, and
    reading it was wrong in both the number and the label: the plan routes
    reject any plan currency but INR (``superadmin_plan_routes`` raises on a
    non-INR create *and* update), so every plan row says "INR" while a USD-rail
    customer is charged from the ``*_usd_cents`` columns. The rail is
    ``core.pricing.charge_currency(client.billing_country)``, which is the same
    function the charge path uses.

    **No cross-currency total.** ``at_risk_by_currency`` is a per-currency
    breakdown; the old scalar ``at_risk_minor_total`` added paise to cents and
    reported a number that was not an amount of anything. There is deliberately
    no FX conversion into a single figure either: a dunning screen showing a
    converted total invites someone to book it as revenue, and there is no live
    FX anywhere in the charge path to convert it with.
    """
    from app.config import PAYMENT_FAILED_GRACE_DAYS

    with get_session() as session:
        rows = session.execute(
            # The whole ``Client``, not two columns: the standing discount is
            # resolved off ``Client.referral_code_id``.
            select(Subscription, Client, Plan)
            .join(Client, Subscription.client_id == Client.id)
            .outerjoin(Plan, Subscription.plan_id == Plan.id)
            .where(Subscription.status == "past_due")
            .order_by(Subscription.past_due_since)
        ).all()

        now = datetime.now(UTC)
        items: list[dict[str, Any]] = []
        totals: dict[str, int] = {}
        for sub, client, plan in rows:
            since = sub.past_due_since
            if since is not None and since.tzinfo is None:
                since = since.replace(tzinfo=UTC)
            elapsed = (now - since).days if since else None
            currency = charge_currency(client.billing_country)
            # Mirrors the checkout path, which skips the discount for QA
            # clients so their flows quote list price.
            discount_bps = 0
            if client.id not in CHECKOUT_TEST_CLIENT_IDS:
                discount_bps, _ = resolve_customer_discount_bps(session, client)
            at_risk = _cycle_at_risk_minor(plan, sub.billing_cycle, currency, discount_bps)
            if at_risk is not None:
                totals[currency] = totals.get(currency, 0) + at_risk
            items.append(
                {
                    "subscription_id": sub.id,
                    "client_id": sub.client_id,
                    "client_email": client.email,
                    "plan_name": plan.name if plan else None,
                    "billing_cycle": sub.billing_cycle,
                    "past_due_since": since.isoformat() if since else None,
                    "days_elapsed": elapsed,
                    "days_left": max(0, PAYMENT_FAILED_GRACE_DAYS - elapsed) if elapsed is not None else None,
                    "emails_sent": sorted((sub.dunning_emails_sent or {}).keys()),
                    "cycle_at_risk_minor": at_risk,
                    "discount_bps": discount_bps,
                    "currency": currency,
                }
            )
        return {
            "count": len(items),
            "at_risk_by_currency": [{"currency": code, "minor": minor} for code, minor in sorted(totals.items())],
            "grace_days": PAYMENT_FAILED_GRACE_DAYS,
            "items": items,
        }


@router.get("/billing/reconciliation")
def billing_reconciliation(_admin: Client = Depends(get_superadmin)):
    """Anomaly report. Every list should be empty in a healthy system."""
    from app.services import invoice_reports

    with get_session() as session:
        anomalies = invoice_reports.reconciliation_anomalies(session)
    return {"counts": {k: len(v) for k, v in anomalies.items()}, **anomalies}
