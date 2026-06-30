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
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import desc, select

from app.api.auth import get_superadmin
from app.api.superadmin_plan_routes import _to_usd_cents
from app.api.superadmin_routes_v2 import _require_write
from app.db.models import Client, Document, Invoice, Subscription, Webhook, WebhookDelivery
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
