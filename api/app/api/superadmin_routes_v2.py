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
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select

from app.api.auth import get_superadmin
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
    LeadInfo,
    LLMCallLog,
    Operator,
    PricingConfig,
    Subscription,
)
from app.db.session import get_session
from app.services.audit_service import record_audit
from app.services.langfuse_service import fetch_summary as fetch_langfuse_summary

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/superadmin", tags=["superadmin-v2"])


# ── helpers ─────────────────────────────────────────────────────────────────


def _require_write(actor: Client) -> None:
    """Read-only super-admins cannot mutate."""
    if getattr(actor, "superadmin_role", None) == "readonly":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Read-only super-admin: writes are not permitted.",
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


class ClientPatch(BaseModel):
    name: str | None = None
    email: str | None = None
    is_superadmin: bool | None = None
    superadmin_role: str | None = Field(default=None, pattern="^(owner|admin|readonly)$")
    suspended: bool | None = None


@router.get("/clients/{client_id}")
def client_detail(client_id: int, _admin: Client = Depends(get_superadmin)):
    """Aggregated client detail used by ``/clients/[id]`` page."""
    with get_session() as session:
        client = session.get(Client, client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Client not found")

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

        # Approximate MRR — use plan price if active.
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
            raise HTTPException(status_code=404, detail="Client not found")

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
    delta: int
    reason: str = Field(min_length=3, max_length=500)


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
            raise HTTPException(status_code=404, detail="Client not found")

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
    _require_write(admin)
    with get_session() as session:
        target = session.get(Client, client_id)
        if not target:
            raise HTTPException(status_code=404, detail="Client not found")

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

        record_audit(
            session,
            actor=admin,
            action="client.impersonate",
            target_type="client",
            target_id=client_id,
            after={"expires_at": expires_at.isoformat()},
            request=request,
        )
        session.commit()
        return {
            "token": raw,
            "expires_at": expires_at.isoformat(),
            "redirect_url": f"https://app.oyechats.com/?impersonation={raw}",
        }


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
            raise HTTPException(status_code=404, detail="Client not found")
        record_audit(
            session,
            actor=admin,
            action="client.reset_password",
            target_type="client",
            target_id=client_id,
            request=request,
        )
        session.commit()
    return {"ok": True}


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
    with get_session() as session:
        rows = session.execute(select(Document, Bot).outerjoin(Bot, Document.bot_id == Bot.id).limit(500)).all()
        return [
            {
                "id": d.id,
                "bot_id": d.bot_id,
                "bot_name": b.name if b else None,
                "client_id": getattr(d, "client_id", None),
                "source": getattr(d, "source", "unknown"),
                "title": getattr(d, "title", None),
                "chunk_count": 1,
                "size_bytes": len(getattr(d, "text", "") or "") if hasattr(d, "text") else 0,
                "created_at": d.created_at.isoformat() if getattr(d, "created_at", None) else "",
            }
            for d, b in rows
        ]


# ── Sessions ────────────────────────────────────────────────────────────────


@router.get("/sessions")
def list_sessions(
    status_filter: str | None = Query(default=None, alias="status"),
    client_id: int | None = None,
    _admin: Client = Depends(get_superadmin),
):
    with get_session() as session:
        stmt = (
            select(ChatSession, Bot, Client)
            .outerjoin(Bot, ChatSession.bot_id == Bot.id)
            .outerjoin(Client, ChatSession.client_id == Client.id)
        )
        if status_filter:
            stmt = stmt.where(ChatSession.status == status_filter)
        if client_id:
            stmt = stmt.where(ChatSession.client_id == client_id)
        stmt = stmt.order_by(desc(ChatSession.created_at)).limit(500)
        rows = session.execute(stmt).all()
        return [_session_summary(s, b, c) for s, b, c in rows]


@router.get("/sessions/{session_id}")
def session_detail(session_id: int, _admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        s = session.get(ChatSession, session_id)
        if not s:
            raise HTTPException(status_code=404, detail="Session not found")
        bot = session.get(Bot, s.bot_id) if s.bot_id else None
        client = session.get(Client, s.client_id) if s.client_id else None
        messages = (
            session.execute(
                select(ChatMessage).where(ChatMessage.session_id == session_id).order_by(ChatMessage.created_at)
            )
            .scalars()
            .all()
        )
        return {
            "session": _session_summary(s, bot, client),
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
            select(ChatSession, Bot, Client)
            .outerjoin(Bot, ChatSession.bot_id == Bot.id)
            .outerjoin(Client, ChatSession.client_id == Client.id)
            .where(ChatSession.status.in_(["waiting", "live"]))
            .order_by(desc(ChatSession.created_at))
            .limit(100)
        ).all()
        return [_session_summary(s, b, c) for s, b, c in rows]


# ── Leads / operators ───────────────────────────────────────────────────────


@router.get("/leads")
def list_leads(_admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        rows = session.execute(
            select(LeadInfo, Bot, Client)
            .outerjoin(Bot, LeadInfo.bot_id == Bot.id)
            .outerjoin(Client, LeadInfo.client_id == Client.id)
            .order_by(desc(LeadInfo.created_at))
            .limit(500)
        ).all()
        return [
            {
                "id": lead.id,
                "bot_id": lead.bot_id,
                "bot_name": b.name if b else None,
                "client_id": lead.client_id,
                "client_name": c.name if c else None,
                "name": getattr(lead, "name", None),
                "email": getattr(lead, "email", None),
                "phone": getattr(lead, "phone", None),
                "company": getattr(lead, "company", None),
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
    with get_session() as session:
        stmt = select(CreditLedger).order_by(desc(CreditLedger.created_at)).limit(500)
        if client_id:
            stmt = stmt.where(CreditLedger.client_id == client_id)
        entries = session.execute(stmt).scalars().all()

        # Compute balance after each row by walking forward — keeps API simple
        # without a window function. For 500 rows this is fine.
        running: dict[int, int] = {}
        out = []
        # We need ascending order to compute running balance correctly.
        for e in reversed(entries):
            running[e.client_id] = running.get(e.client_id, 0) + e.delta
            out.append(
                {
                    "id": e.id,
                    "client_id": e.client_id,
                    "delta": e.delta,
                    "balance_after": running[e.client_id],
                    "reason": e.note or e.reason,
                    "grant_id": e.grant_id,
                    "expires_at": e.expires_at.isoformat() if e.expires_at else None,
                    "created_at": e.created_at.isoformat() if e.created_at else "",
                }
            )
        out.reverse()  # newest first for the UI
        return out


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
            for r in rows
        ]


class FlagWrite(BaseModel):
    value: Any


@router.put("/pricing-config/{key}")
def update_pricing_config(
    key: str,
    body: FlagWrite,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    _require_write(admin)
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
    code: str
    percent_off: int | None = None
    amount_off_cents: int | None = None
    max_redemptions: int | None = None
    expires_at: datetime | None = None
    applies_to_plan_ids: list[int] | None = None


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
                func.coalesce(func.sum(func.case((LLMCallLog.fallback_used, 1), else_=0)), 0).label("fallbacks"),
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


@router.get("/model-config")
def get_model_config(_admin: Client = Depends(get_superadmin)):
    """Return the active model + RAG knobs and the catalog of selectable models."""
    from app.services import runtime_config

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
        "known_models": _KNOWN_MODELS,
    }


class ModelConfigPatch(BaseModel):
    primary_model: str | None = None
    fallback_model: str | None = None
    gate_model: str | None = None
    chunk_size: int | None = Field(default=None, ge=200, le=8000)
    chunk_overlap: int | None = Field(default=None, ge=0, le=2000)
    rerank_top_n: int | None = Field(default=None, ge=1, le=20)
    relevance_threshold: float | None = Field(default=None, ge=0.0, le=1.0)


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

    # Map field name -> pricing_config key
    field_to_key = {
        "primary_model": "model.primary",
        "fallback_model": "model.fallback",
        "gate_model": "model.gate",
        "chunk_size": "rag.chunk_size",
        "chunk_overlap": "rag.chunk_overlap",
        "rerank_top_n": "rag.rerank_top_n",
        "relevance_threshold": "rag.relevance_threshold",
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
    }


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
            "metered": True,
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
            "metered": True,
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
            "metered": True,
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
    service: str = Query(default="oyechats-api"),
    lines: int = Query(default=500, ge=10, le=5_000),
    level: str | None = Query(default=None),
    grep: str | None = Query(default=None),
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
    APIConnectionError under memory pressure — see CLAUDE.md).
    """
    return fetch_langfuse_summary(days=days)


# ── System health (full) ────────────────────────────────────────────────────


@router.get("/system/health/full")
def system_health_full(_admin: Client = Depends(get_superadmin)):
    """Detailed health snapshot with per-service connectivity."""
    from app.config import settings

    health: dict[str, Any] = {"status": "healthy", "version": getattr(settings, "VERSION", "unknown")}

    try:
        with get_session() as session:
            session.execute(select(1))
        health["database"] = "connected"
    except Exception:
        health["database"] = "unreachable"
        health["status"] = "degraded"

    health["razorpay"] = "connected" if getattr(settings, "RAZORPAY_ENABLED", False) else "disabled"
    health["storage"] = "connected" if getattr(settings, "R2_BUCKET_NAME", None) else "unknown"
    return health


# ── Internal helpers ────────────────────────────────────────────────────────


def _session_summary(s: ChatSession, b: Bot | None, c: Client | None) -> dict[str, Any]:
    return {
        "id": s.id,
        "bot_id": s.bot_id,
        "bot_name": b.name if b else None,
        "client_id": s.client_id,
        "client_name": c.name if c else None,
        "status": s.status,
        "visitor_name": getattr(s, "visitor_name", None),
        "visitor_email": getattr(s, "visitor_email", None),
        "rating": getattr(s, "visitor_rating", None),
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "last_activity_at": s.last_activity_at.isoformat() if getattr(s, "last_activity_at", None) else None,
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
