"""Super-admin operations routes.

Backs the operational tabs of the ``admin.oyechats.com`` command center that
the v1/v2 super-admin routers don't already cover: invoices (list / refund /
mark-paid), background-worker queue status, error summary, outbound webhook
deliveries (list / replay), document reindex, and revenue cohorts.

Conventions follow ``superadmin_routes_v2.py``:

* ``Depends(get_superadmin)`` for reads, ``_require_write`` for mutations.
* ``with get_session() as session:`` for DB access, ``.isoformat()`` for dates.
* Every mutating route writes an audit entry via ``record_audit``.
* Monetary values are normalised to USD cents via ``_to_usd_cents`` (the same
  rule the customer app and ``superadmin_plan_routes`` use).
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import desc, func, select

from app.api.auth import get_superadmin
from app.api.superadmin_plan_routes import _to_usd_cents
from app.api.superadmin_routes_v2 import _require_write
from app.db.models import (
    Bot,
    ChatMessage,
    ChatSession,
    Client,
    Document,
    Invoice,
    LeadInfo,
    MeetingBooking,
    OfflineMessage,
    Operator,
    Plan,
    Subscription,
    UsageRecord,
    VisitorEvent,
    Webhook,
    WebhookDelivery,
)
from app.db.session import get_session
from app.services.audit_service import record_audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/superadmin", tags=["superadmin-ops"])


# ── Invoices ─────────────────────────────────────────────────────────────────


def _invoice_provider(inv: Invoice) -> str:
    """Derive the billing provider from the stored gateway reference.

    A Razorpay payment id marks a real gateway charge; everything else (manual
    super-admin grants, legacy rows) is reported as ``manual``. The Stripe id
    is intentionally ignored — Stripe is the legacy fallback and the dashboard
    is Razorpay/manual only.
    """
    return "razorpay" if inv.razorpay_payment_id else "manual"


def _invoice_dict(inv: Invoice, client_name: str | None) -> dict[str, Any]:
    return {
        "id": inv.id,
        "client_id": inv.client_id,
        "client_name": client_name,
        "amount_cents": _to_usd_cents(inv.amount_cents, inv.currency),
        "currency": "USD",
        "status": inv.status,
        "provider": _invoice_provider(inv),
        "provider_invoice_id": inv.razorpay_payment_id,
        "created_at": inv.created_at.isoformat() if inv.created_at else None,
        "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
    }


@router.get("/invoices")
def list_invoices(
    status_filter: str | None = Query(default=None, alias="status"),
    client_id: int | None = None,
    _admin: Client = Depends(get_superadmin),
):
    """List invoices (USD-normalised) with optional status / client filters."""
    with get_session() as session:
        stmt = (
            select(Invoice, Client.name)
            .outerjoin(Client, Invoice.client_id == Client.id)
            .order_by(desc(Invoice.created_at))
        )
        if status_filter:
            stmt = stmt.where(Invoice.status == status_filter)
        if client_id:
            stmt = stmt.where(Invoice.client_id == client_id)
        stmt = stmt.limit(500)
        rows = session.execute(stmt).all()
        return [_invoice_dict(inv, client_name) for inv, client_name in rows]


@router.post("/invoices/{invoice_id}/refund")
def refund_invoice(
    invoice_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Refund an invoice.

    When the invoice carries a ``razorpay_payment_id`` a real Razorpay refund
    is issued for the captured amount; the ``refund.created`` webhook then claws
    back the granted credits. Invoices without a gateway reference (manual
    grants, legacy rows) are marked refunded locally and noted as manual.
    """
    _require_write(admin)
    with get_session() as session:
        inv = session.get(Invoice, invoice_id)
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found")
        if inv.status == "refunded":
            raise HTTPException(status_code=400, detail="Invoice is already refunded.")

        before = {"status": inv.status}
        manual = inv.razorpay_payment_id is None

        if not manual:
            from app.services import razorpay_service

            try:
                razorpay_service.refund_payment(inv.razorpay_payment_id, amount=inv.amount_cents)
            except razorpay_service.RazorpayBillingError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

        inv.status = "refunded"
        session.flush()

        record_audit(
            session,
            actor=admin,
            action="invoice.refund",
            target_type="invoice",
            target_id=invoice_id,
            before=before,
            after={"status": "refunded", "manual": manual},
            request=request,
        )
        session.commit()
        return {"ok": True}


@router.post("/invoices/{invoice_id}/mark-paid")
def mark_invoice_paid(
    invoice_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Mark an invoice as paid (manual reconciliation)."""
    _require_write(admin)
    with get_session() as session:
        inv = session.get(Invoice, invoice_id)
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found")

        before = {"status": inv.status, "paid_at": inv.paid_at.isoformat() if inv.paid_at else None}
        inv.status = "paid"
        inv.paid_at = datetime.now(UTC)
        session.flush()

        record_audit(
            session,
            actor=admin,
            action="invoice.mark_paid",
            target_type="invoice",
            target_id=invoice_id,
            before=before,
            after={"status": "paid", "paid_at": inv.paid_at.isoformat()},
            request=request,
        )
        session.commit()
        return {"ok": True}


# ── Worker / queue status ────────────────────────────────────────────────────


def _worker_alive() -> bool:
    """True when the worker heartbeat key is present and fresh in Redis."""
    from app.core.cache import get_redis
    from app.worker.tasks import WORKER_HEARTBEAT_KEY

    try:
        redis_client = get_redis()
        if redis_client is None:
            return False
        return redis_client.get(WORKER_HEARTBEAT_KEY) is not None
    except Exception:
        return False


@router.get("/workers/status")
def workers_status(_admin: Client = Depends(get_superadmin)):
    """Best-effort ARQ queue snapshot sourced from Redis.

    ARQ stores queued jobs in the ``oyechats`` sorted set (the configured
    ``queue_name``), in-flight jobs under ``arq:in-progress:*`` and retry-armed
    jobs under ``arq:retry:*``. Every metric is best-effort: any Redis hiccup
    degrades to ``0`` / ``False`` rather than raising, so the dashboard never
    breaks on a transient blip.
    """
    from app.core.cache import get_redis

    queue_name = "oyechats"  # matches WorkerSettings.queue_name / default_queue_name
    pending = in_flight = failed = 0
    oldest_pending_seconds = 0
    workers_alive = _worker_alive()

    try:
        redis_client = get_redis()
        if redis_client is not None:
            pending = int(redis_client.zcard(queue_name) or 0)
            in_flight = len(list(redis_client.scan_iter(match="arq:in-progress:*", count=1000)))
            failed = len(list(redis_client.scan_iter(match="arq:retry:*", count=1000)))

            # ARQ scores queued jobs by their scheduled run time (ms epoch). The
            # lowest score that is already due is the oldest waiting job.
            now_ms = datetime.now(UTC).timestamp() * 1000
            oldest = redis_client.zrange(queue_name, 0, 0, withscores=True)
            if oldest:
                _, score = oldest[0]
                age_ms = now_ms - float(score)
                oldest_pending_seconds = int(age_ms / 1000) if age_ms > 0 else 0
    except Exception:
        logger.warning("workers_status: Redis introspection failed", exc_info=True)

    return [
        {
            "queue_name": queue_name,
            "pending": pending,
            "in_flight": in_flight,
            "failed": failed,
            "workers_alive": 1 if workers_alive else 0,
            "oldest_pending_seconds": oldest_pending_seconds,
        }
    ]


# ── Errors (Sentry summary) ──────────────────────────────────────────────────


@router.get("/errors")
def list_errors(_admin: Client = Depends(get_superadmin)):
    """Recent error issues.

    The platform only configures a Sentry **DSN** (write-only ingest key); there
    is no Sentry API auth token / org / project configured, so issues cannot be
    queried back server-side. Rather than error, this returns an empty list so
    the dashboard renders an empty state gracefully. Wire up a Sentry API token
    here to populate it.
    """
    return []


# ── Outbound webhook deliveries ──────────────────────────────────────────────


def _delivery_dict(d: WebhookDelivery, *, include_payload: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": d.id,
        "webhook_id": d.webhook_id,
        "event": d.event_type,
        "status_code": d.status_code,
        "attempt": d.attempt,
        "next_retry_at": d.next_retry_at.isoformat() if d.next_retry_at else None,
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "delivered_at": d.delivered_at.isoformat() if d.delivered_at else None,
    }
    if include_payload:
        out["payload"] = d.payload
    return out


@router.get("/webhooks")
def list_webhook_deliveries(_admin: Client = Depends(get_superadmin)):
    """Recent outbound webhook delivery attempts (newest first)."""
    with get_session() as session:
        rows = (
            session.execute(select(WebhookDelivery).order_by(desc(WebhookDelivery.created_at)).limit(500))
            .scalars()
            .all()
        )
        return [_delivery_dict(d) for d in rows]


@router.post("/webhooks/{delivery_id}/replay")
def replay_webhook_delivery(
    delivery_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Re-deliver a past webhook delivery as a fresh attempt.

    Re-enqueues the original event + payload to the same webhook via
    ``webhook_service.queue_webhook_delivery`` (ARQ when the worker is enabled,
    in-process thread pool otherwise). The webhook must still exist and be
    active for the replay to land.
    """
    _require_write(admin)
    with get_session() as session:
        delivery = session.get(WebhookDelivery, delivery_id)
        if not delivery:
            raise HTTPException(status_code=404, detail="Webhook delivery not found")

        webhook = session.get(Webhook, delivery.webhook_id)
        if not webhook:
            raise HTTPException(status_code=404, detail="Parent webhook no longer exists")
        if not webhook.is_active:
            raise HTTPException(status_code=400, detail="Parent webhook is inactive; re-enable it before replaying.")

        from app.services import webhook_service

        webhook_service.queue_webhook_delivery(delivery.webhook_id, delivery.event_type, delivery.payload, attempt=1)

        record_audit(
            session,
            actor=admin,
            action="webhook.replay",
            target_type="webhook_delivery",
            target_id=delivery_id,
            after={"webhook_id": delivery.webhook_id, "event": delivery.event_type},
            request=request,
        )
        session.commit()
        return {"ok": True}


# ── Document reindex ─────────────────────────────────────────────────────────


@router.post("/documents/{document_id}/reindex")
def reindex_document(
    document_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Re-run embedding/ingestion for a single document chunk.

    Enqueues ``task_reembed_document`` on ARQ when the worker is enabled; when
    it isn't (local dev, worker down) it falls back to re-embedding inline so
    the action still completes. Either way the document's vector is recomputed
    with the current embedding provider.
    """
    _require_write(admin)
    with get_session() as session:
        doc = session.get(Document, document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found")

        record_audit(
            session,
            actor=admin,
            action="document.reindex",
            target_type="document",
            target_id=document_id,
            request=request,
        )
        session.commit()

    from app.worker.enqueue import WORKER_ENABLED

    if WORKER_ENABLED:
        from app.worker.enqueue import enqueue_sync

        enqueue_sync("task_reembed_document", document_id)
    else:
        _reembed_document_inline(document_id)

    return {"ok": True}


def _reembed_document_inline(document_id: int) -> None:
    """Recompute a single document's embedding synchronously.

    Used as the no-worker fallback for the reindex endpoint. Mirrors the SQL
    that ``task_reembed_document`` runs so behaviour is identical either way.
    """
    from sqlalchemy import text

    from app.ingestion.embedder import embed_chunks

    with get_session() as session:
        row = session.execute(
            text("SELECT content FROM documents WHERE id = :id"),
            {"id": document_id},
        ).fetchone()
        if row is None:
            return
        content = row[0] or ""

    embeddings = embed_chunks([content])
    emb_str = "[" + ",".join(str(v) for v in embeddings[0]) + "]"
    with get_session() as session:
        session.execute(
            text("UPDATE documents SET embedding = CAST(:emb AS vector) WHERE id = :id"),
            {"emb": emb_str, "id": document_id},
        )
        session.commit()


# ── Revenue cohorts ──────────────────────────────────────────────────────────

_RETAINED_STATUSES = ("active", "trialing", "past_due")


@router.get("/revenue/cohorts")
def revenue_cohorts(_admin: Client = Depends(get_superadmin)):
    """Signup-month cohorts with retention and lifetime value.

    * ``cohort``    — signup month (``YYYY-MM``).
    * ``signups``   — clients whose account was created that month.
    * ``retained``  — of those, how many still hold an active subscription.
    * ``ltv_cents`` — total USD-normalised value of *paid* invoices from that
      cohort's clients (cumulative, not per-period).
    """
    with get_session() as session:
        clients = session.execute(select(Client.id, Client.created_at)).all()

        cohort_of: dict[int, str] = {}
        signups: dict[str, int] = defaultdict(int)
        for client_id, created_at in clients:
            if created_at is None:
                continue
            cohort = created_at.strftime("%Y-%m")
            cohort_of[client_id] = cohort
            signups[cohort] += 1

        # Clients that currently hold a retained subscription.
        retained_client_ids = set(
            session.execute(
                select(Subscription.client_id).where(Subscription.status.in_(_RETAINED_STATUSES)).distinct()
            )
            .scalars()
            .all()
        )
        retained: dict[str, int] = defaultdict(int)
        for client_id, cohort in cohort_of.items():
            if client_id in retained_client_ids:
                retained[cohort] += 1

        # Paid-invoice value per cohort, normalised to USD cents.
        ltv: dict[str, int] = defaultdict(int)
        paid_invoices = session.execute(
            select(Invoice.client_id, Invoice.amount_cents, Invoice.currency).where(Invoice.status == "paid")
        ).all()
        for client_id, amount_cents, currency in paid_invoices:
            cohort = cohort_of.get(client_id)
            if cohort is None:
                continue
            ltv[cohort] += _to_usd_cents(amount_cents, currency)

        return [
            {
                "cohort": cohort,
                "signups": signups[cohort],
                "retained": retained.get(cohort, 0),
                "ltv_cents": ltv.get(cohort, 0),
            }
            for cohort in sorted(signups)
        ]


_TIMESERIES_METRICS = ("revenue", "messages", "signups")


@router.get("/stats/timeseries")
def stats_timeseries(
    metric: str = Query(default="revenue"),
    days: int = Query(default=30, ge=1, le=365),
    _admin: Client = Depends(get_superadmin),
):
    """Daily time-series for a single platform metric over a trailing window.

    Replaces the dashboard's previously-synthetic sparklines with real data.

    * ``metric=revenue``  — paid-invoice value per day, **USD cents** (by paid_at,
      falling back to created_at), normalised via ``_to_usd_cents``.
    * ``metric=messages`` — chat messages created per day.
    * ``metric=signups``  — client accounts created per day.

    Returns a gap-filled list ``[{date: "YYYY-MM-DD", value: int}]`` covering
    every day in the window (missing days are 0) so charts render continuously.
    """
    if metric not in _TIMESERIES_METRICS:
        raise HTTPException(status_code=400, detail=f"metric must be one of {_TIMESERIES_METRICS}")

    now = datetime.now(UTC)
    cutoff = now - timedelta(days=days - 1)
    start_day = cutoff.date()
    buckets: dict[str, int] = {(start_day + timedelta(days=i)).isoformat(): 0 for i in range(days)}

    with get_session() as session:
        if metric == "revenue":
            rows = session.execute(
                select(Invoice.amount_cents, Invoice.currency, Invoice.paid_at, Invoice.created_at).where(
                    Invoice.status == "paid",
                    func.coalesce(Invoice.paid_at, Invoice.created_at) >= cutoff,
                )
            ).all()
            for amount_cents, currency, paid_at, created_at in rows:
                ts = paid_at or created_at
                if ts is None:
                    continue
                key = ts.date().isoformat()
                if key in buckets:
                    buckets[key] += _to_usd_cents(amount_cents, currency)
        elif metric == "messages":
            rows = session.execute(
                select(func.date_trunc("day", ChatMessage.created_at).label("d"), func.count().label("n"))
                .where(ChatMessage.created_at >= cutoff)
                .group_by("d")
            ).all()
            for d, n in rows:
                key = d.date().isoformat() if hasattr(d, "date") else str(d)
                if key in buckets:
                    buckets[key] = int(n)
        else:  # signups
            rows = session.execute(
                select(func.date_trunc("day", Client.created_at).label("d"), func.count().label("n"))
                .where(Client.created_at >= cutoff)
                .group_by("d")
            ).all()
            for d, n in rows:
                key = d.date().isoformat() if hasattr(d, "date") else str(d)
                if key in buckets:
                    buckets[key] = int(n)

    return [{"date": day, "value": buckets[day]} for day in sorted(buckets)]


# ── Visitors (behavioral analytics) ──────────────────────────────────────────


def _mask_api_key(key: str | None) -> str:
    """Mask a credential to its last 4 chars (``••••••1a2b``); ``—`` when absent.

    Never returns the full key — only the trailing 4 characters are revealed so
    an operator can disambiguate keys without the value leaking to the client.
    """
    if not key:
        return "—"
    return "••••••" + key[-4:]


@router.get("/visitors")
def visitor_analytics(_admin: Client = Depends(get_superadmin)):
    """Aggregate behavioral ``VisitorEvent`` data for the analytics dashboard.

    Country / referrer / UTM source are pulled best-effort from the JSONB
    ``event_data`` payload (keys ``country``, ``referrer``, ``utm_source``);
    NULL / missing keys are skipped rather than surfaced as empty buckets.
    Every list is capped at the top 10 and the daily series covers the trailing
    14 days of ``page_view`` events. Empty data degrades to zeros / empty lists.
    """
    country_expr = VisitorEvent.event_data["country"].astext
    referrer_expr = VisitorEvent.event_data["referrer"].astext
    utm_expr = VisitorEvent.event_data["utm_source"].astext

    with get_session() as session:
        total_events = session.execute(select(func.count(VisitorEvent.id))).scalar() or 0
        total_sessions = session.execute(select(func.count(func.distinct(VisitorEvent.session_id)))).scalar() or 0

        by_event_type = [
            {"event_type": event_type, "count": count}
            for event_type, count in session.execute(
                select(VisitorEvent.event_type, func.count(VisitorEvent.id))
                .group_by(VisitorEvent.event_type)
                .order_by(desc(func.count(VisitorEvent.id)))
            ).all()
        ]

        top_countries = [
            {"country": country, "count": count}
            for country, count in session.execute(
                select(country_expr, func.count(VisitorEvent.id))
                .where(country_expr.isnot(None))
                .group_by(country_expr)
                .order_by(desc(func.count(VisitorEvent.id)))
                .limit(10)
            ).all()
            if country
        ]

        top_referrers = [
            {"referrer": referrer, "count": count}
            for referrer, count in session.execute(
                select(referrer_expr, func.count(VisitorEvent.id))
                .where(referrer_expr.isnot(None))
                .group_by(referrer_expr)
                .order_by(desc(func.count(VisitorEvent.id)))
                .limit(10)
            ).all()
            if referrer
        ]

        top_utm_sources = [
            {"source": source, "count": count}
            for source, count in session.execute(
                select(utm_expr, func.count(VisitorEvent.id))
                .where(utm_expr.isnot(None))
                .group_by(utm_expr)
                .order_by(desc(func.count(VisitorEvent.id)))
                .limit(10)
            ).all()
            if source
        ]

        since = datetime.now(UTC) - timedelta(days=14)
        day_expr = func.date_trunc("day", VisitorEvent.created_at)
        daily = [
            {"date": day.date().isoformat(), "count": count}
            for day, count in session.execute(
                select(day_expr.label("d"), func.count(VisitorEvent.id))
                .where(VisitorEvent.event_type == "page_view")
                .where(VisitorEvent.created_at >= since)
                .group_by("d")
                .order_by("d")
            ).all()
            if day is not None
        ]

        return {
            "total_events": total_events,
            "total_sessions": total_sessions,
            "by_event_type": by_event_type,
            "top_countries": top_countries,
            "top_referrers": top_referrers,
            "top_utm_sources": top_utm_sources,
            "daily": daily,
        }


# ── Conversion funnel ────────────────────────────────────────────────────────

_FUNNEL_PAYING_STATUSES = ("active", "past_due")


@router.get("/funnel")
def conversion_funnel(
    days: int = Query(default=30, ge=1, le=365),
    _admin: Client = Depends(get_superadmin),
):
    """Compute the visitor → paying-customer funnel over the trailing window.

    Each stage is a single grouped/aggregate query (no per-row Python loops).
    ``pct`` is each stage's value as a percentage of the first stage (Sessions),
    rounded to one decimal; it is ``0.0`` when the baseline is ``0``.
    """
    since = datetime.now(UTC) - timedelta(days=days)

    with get_session() as session:
        sessions_total = (
            session.execute(select(func.count(ChatSession.id)).where(ChatSession.created_at >= since)).scalar() or 0
        )

        # Sessions with >= 2 messages, scoped to the window via the session's
        # own created_at (one grouped subquery, no per-row loop).
        engaged = (
            session.execute(
                select(func.count()).select_from(
                    select(ChatMessage.session_id)
                    .join(ChatSession, ChatSession.id == ChatMessage.session_id)
                    .where(ChatSession.created_at >= since)
                    .group_by(ChatMessage.session_id)
                    .having(func.count(ChatMessage.id) >= 2)
                    .subquery()
                )
            ).scalar()
            or 0
        )

        # Sessions with >= 1 user message.
        asked = (
            session.execute(
                select(func.count(func.distinct(ChatMessage.session_id)))
                .join(ChatSession, ChatSession.id == ChatMessage.session_id)
                .where(ChatSession.created_at >= since)
                .where(ChatMessage.role == "user")
            ).scalar()
            or 0
        )

        leads = session.execute(select(func.count(LeadInfo.id)).where(LeadInfo.created_at >= since)).scalar() or 0

        meetings = (
            session.execute(select(func.count(MeetingBooking.id)).where(MeetingBooking.created_at >= since)).scalar()
            or 0
        )

        paying = (
            session.execute(
                select(func.count(Subscription.id))
                .where(Subscription.created_at >= since)
                .where(Subscription.status.in_(_FUNNEL_PAYING_STATUSES))
            ).scalar()
            or 0
        )

    raw_stages = [
        ("Sessions", sessions_total),
        ("Engaged", engaged),
        ("Asked a question", asked),
        ("Captured as lead", leads),
        ("Booked a meeting", meetings),
        ("Converted to paying", paying),
    ]
    baseline = sessions_total
    stages = [
        {
            "label": label,
            "value": value,
            "pct": round(value / baseline * 100, 1) if baseline else 0.0,
        }
        for label, value in raw_stages
    ]
    return {"days": days, "stages": stages}


# ── Crawl jobs ───────────────────────────────────────────────────────────────


@router.get("/crawls")
def list_crawls(_admin: Client = Depends(get_superadmin)):
    """List crawl jobs grouped from ``source == "crawl"`` document chunks.

    A single crawled URL is stored as many ``Document`` rows (one per chunk)
    that share ``(bot_id, document_name, file_hash)``. We group by ``file_hash``
    to collapse them back into one job per crawl, count the chunks, and take the
    earliest ``created_at`` as the job start. Bot / client names are batch-loaded
    in one query each to avoid N+1 lookups.
    """
    with get_session() as session:
        rows = session.execute(
            select(
                Document.file_hash,
                Document.bot_id,
                Document.document_name,
                func.count(Document.id).label("chunk_count"),
                func.min(Document.created_at).label("created_at"),
            )
            .where(Document.source == "crawl")
            .group_by(Document.file_hash, Document.bot_id, Document.document_name)
            .order_by(desc(func.min(Document.created_at)))
            .limit(200)
        ).all()

        bot_ids = {row.bot_id for row in rows if row.bot_id is not None}
        bot_names: dict[int, str | None] = {}
        client_names: dict[int, str | None] = {}
        if bot_ids:
            bot_rows = session.execute(
                select(Bot.id, Bot.name, Client.name)
                .outerjoin(Client, Bot.client_id == Client.id)
                .where(Bot.id.in_(bot_ids))
            ).all()
            for bot_id, bot_name, client_name in bot_rows:
                bot_names[bot_id] = bot_name
                client_names[bot_id] = client_name

        return [
            {
                "id": row.file_hash,
                "bot_id": row.bot_id,
                "bot_name": bot_names.get(row.bot_id),
                "client_name": client_names.get(row.bot_id),
                "url": row.document_name,
                "chunk_count": row.chunk_count,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ]


# ── API key registry ─────────────────────────────────────────────────────────


@router.get("/api-keys")
def api_key_registry(_admin: Client = Depends(get_superadmin)):
    """Masked registry of client (``X-API-Key``) and operator keys.

    Keys are never returned in full — only the trailing 4 characters are shown
    (``••••••1a2b``); a missing operator key renders as ``—``.
    """
    with get_session() as session:
        client_rows = session.execute(
            select(Client.id, Client.name, Client.email, Client.api_key, Client.created_at)
            .order_by(desc(Client.created_at))
            .limit(200)
        ).all()
        clients = [
            {
                "id": cid,
                "name": name,
                "email": email,
                "api_key_masked": _mask_api_key(api_key),
                "created_at": created_at.isoformat() if created_at else None,
            }
            for cid, name, email, api_key, created_at in client_rows
        ]

        operator_rows = session.execute(
            select(
                Operator.id,
                Operator.name,
                Client.name,
                Operator.operator_api_key,
                Operator.is_active,
            )
            .outerjoin(Client, Operator.client_id == Client.id)
            .order_by(desc(Operator.created_at))
            .limit(200)
        ).all()
        operators = [
            {
                "id": oid,
                "name": name,
                "client_name": client_name,
                "api_key_masked": _mask_api_key(operator_api_key),
                "is_active": bool(is_active),
            }
            for oid, name, client_name, operator_api_key, is_active in operator_rows
        ]

        return {"clients": clients, "operators": operators}


@router.post("/clients/{client_id}/rotate-api-key")
def rotate_client_api_key(
    client_id: int,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Regenerate a client's ``api_key``, invalidating their current key.

    SECURITY: this immediately invalidates the client's existing ``X-API-Key`` —
    any embed / integration using the old key stops authenticating until updated
    with the new value. The freshly generated key is NOT returned in the response
    body (only its masked form); retrieve the full value out-of-band if needed.
    The new key is generated with ``uuid.uuid4().hex`` — the same generator used
    when a client is first created at registration.
    """
    _require_write(admin)
    with get_session() as session:
        client = session.get(Client, client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Client not found")

        old_masked = _mask_api_key(client.api_key)
        new_key = str(uuid.uuid4().hex)
        client.api_key = new_key
        session.flush()
        new_masked = _mask_api_key(new_key)

        record_audit(
            session,
            actor=admin,
            action="client.rotate_api_key",
            target_type="client",
            target_id=client_id,
            before={"api_key_masked": old_masked},
            after={"api_key_masked": new_masked},
            request=request,
        )
        session.commit()
        return {"ok": True, "api_key_masked": new_masked}


# ── Offline messages (visitor messages left while operators offline) ──────────


_OFFLINE_STATUSES = ("new", "read", "replied")


@router.get("/offline-messages")
def list_offline_messages(
    status: str | None = None,
    bot_id: int | None = None,
    _admin: Client = Depends(get_superadmin),
):
    """Visitor contact-form submissions captured while the team was offline.

    Newest first, capped at 500. Filterable by ``status`` (new|read|replied)
    and ``bot_id``. Bot/client names are batch-loaded to avoid N+1.
    """
    with get_session() as session:
        stmt = select(OfflineMessage).order_by(OfflineMessage.created_at.desc())
        if status:
            stmt = stmt.where(OfflineMessage.status == status)
        if bot_id:
            stmt = stmt.where(OfflineMessage.bot_id == bot_id)
        messages = session.execute(stmt.limit(500)).scalars().all()

        bot_ids = {m.bot_id for m in messages}
        bots = {
            b.id: (b.name, b.client_id)
            for b in (session.execute(select(Bot).where(Bot.id.in_(bot_ids))).scalars().all() if bot_ids else [])
        }
        client_ids = {cid for _, cid in bots.values()}
        clients = {
            c.id: c.name
            for c in (
                session.execute(select(Client).where(Client.id.in_(client_ids))).scalars().all() if client_ids else []
            )
        }

        result = []
        for m in messages:
            bot_name, client_id = bots.get(m.bot_id, (None, None))
            result.append(
                {
                    "id": m.id,
                    "bot_id": m.bot_id,
                    "bot_name": bot_name,
                    "client_name": clients.get(client_id) if client_id else None,
                    "visitor_name": m.visitor_name,
                    "visitor_email": m.visitor_email,
                    "visitor_phone": m.visitor_phone,
                    "message_body": m.message_body,
                    "status": m.status,
                    "fallback_reason": m.fallback_reason,
                    "created_at": m.created_at.isoformat() if m.created_at else None,
                    "read_at": m.read_at.isoformat() if m.read_at else None,
                    "replied_at": m.replied_at.isoformat() if m.replied_at else None,
                }
            )
        return result


class OfflineMessagePatch(BaseModel):
    status: str


@router.patch("/offline-messages/{message_id}")
def update_offline_message(
    message_id: int,
    body: OfflineMessagePatch,
    request: Request,
    admin: Client = Depends(get_superadmin),
):
    """Update an offline message's status (new|read|replied), stamping the
    matching timestamp. Audit-logged."""
    _require_write(admin)
    if body.status not in _OFFLINE_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {_OFFLINE_STATUSES}")
    with get_session() as session:
        msg = session.get(OfflineMessage, message_id)
        if not msg:
            raise HTTPException(status_code=404, detail="Offline message not found")

        before = {"status": msg.status}
        msg.status = body.status
        now = datetime.now(UTC)
        if body.status == "read" and msg.read_at is None:
            msg.read_at = now
        elif body.status == "replied":
            msg.replied_at = now
            if msg.read_at is None:
                msg.read_at = now
        session.flush()

        record_audit(
            session,
            actor=admin,
            action="offline_message.update",
            target_type="offline_message",
            target_id=message_id,
            before=before,
            after={"status": msg.status},
            request=request,
        )
        session.commit()
        return {"ok": True}


# ── Usage records (per-period consumption vs plan limits) ─────────────────────


@router.get("/usage-records")
def list_usage_records(
    client_id: int | None = None,
    _admin: Client = Depends(get_superadmin),
):
    """Per-period usage vs plan limits across clients. Newest period first,
    capped at 500. Filterable by ``client_id``. Names batch-loaded."""
    with get_session() as session:
        stmt = select(UsageRecord).order_by(UsageRecord.period_start.desc())
        if client_id:
            stmt = stmt.where(UsageRecord.client_id == client_id)
        records = session.execute(stmt.limit(500)).scalars().all()

        client_ids = {r.client_id for r in records}
        clients = {
            c.id: c.name
            for c in (
                session.execute(select(Client).where(Client.id.in_(client_ids))).scalars().all() if client_ids else []
            )
        }
        plan_ids = {r.plan_id for r in records if r.plan_id}
        plans = {
            p.id: p.name
            for p in (session.execute(select(Plan).where(Plan.id.in_(plan_ids))).scalars().all() if plan_ids else [])
        }

        return [
            {
                "id": r.id,
                "client_id": r.client_id,
                "client_name": clients.get(r.client_id),
                "plan_id": r.plan_id,
                "plan_name": plans.get(r.plan_id) if r.plan_id else None,
                "period_start": r.period_start.isoformat() if r.period_start else None,
                "period_end": r.period_end.isoformat() if r.period_end else None,
                "ai_messages_used": r.ai_messages_used,
                "ai_messages_limit": r.ai_messages_limit,
                "live_chat_messages_used": r.live_chat_messages_used,
                "live_chat_messages_limit": r.live_chat_messages_limit,
                "url_scans_used": r.url_scans_used,
                "url_scans_limit": r.url_scans_limit,
                "storage_used_mb": r.storage_used_mb,
                "storage_limit_mb": r.storage_limit_mb,
                "bots_count": r.bots_count,
                "operators_count": r.operators_count,
                "overage_messages": r.overage_messages,
                "overage_amount_cents": _to_usd_cents(r.overage_amount_cents, None),
            }
            for r in records
        ]
