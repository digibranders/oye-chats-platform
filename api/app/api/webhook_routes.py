import ipaddress
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, HttpUrl
from sqlalchemy import desc, func, select

from app.api.auth import get_current_client_or_operator
from app.db.models import Bot, Webhook, WebhookDelivery
from app.db.session import get_session
from app.schemas.client import _is_public_hostname
from app.services.webhook_service import SUPPORTED_EVENTS, generate_webhook_secret, queue_webhook_delivery

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


class CreateWebhookRequest(BaseModel):
    url: HttpUrl
    events: list[str]
    is_active: bool = True


class UpdateWebhookRequest(BaseModel):
    url: HttpUrl | None = None
    events: list[str] | None = None
    is_active: bool | None = None


def _get_owned_bot(session, bot_id: int, client_id: int) -> Bot:
    bot = session.execute(select(Bot).where(Bot.id == bot_id, Bot.client_id == client_id)).scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found.")
    return bot


def _get_owned_webhook(session, webhook_id: int, client_id: int) -> Webhook:
    webhook = session.execute(
        select(Webhook).join(Bot, Webhook.bot_id == Bot.id).where(Webhook.id == webhook_id, Bot.client_id == client_id)
    ).scalar_one_or_none()
    if not webhook:
        raise HTTPException(status_code=404, detail="Webhook not found.")
    return webhook


def _validate_webhook_url(url: str) -> None:
    """Block webhook URLs that target internal/private networks (SSRF protection)."""
    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=422, detail="Webhook URL must contain a valid hostname.")

    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
            raise HTTPException(
                status_code=422, detail="Webhook URLs targeting internal or private network addresses are not allowed."
            )
    except ValueError:
        # hostname is not a literal IP — resolve DNS and verify all results are public
        if not _is_public_hostname(hostname):
            raise HTTPException(
                status_code=422,
                detail="Webhook URL resolves to a private/internal address and is not allowed.",
            ) from None


def _validate_events(events: list[str]) -> None:
    if not events:
        raise HTTPException(status_code=422, detail="At least one event must be selected.")
    invalid = [event for event in events if event not in SUPPORTED_EVENTS]
    if invalid:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported events: {', '.join(invalid)}. Supported: {', '.join(SUPPORTED_EVENTS)}",
        )


@router.get("")
def list_webhooks(
    bot_id: int = Query(...),
    auth: dict = Depends(get_current_client_or_operator),
):
    with get_session() as session:
        _get_owned_bot(session, bot_id, auth["client_id"])
        webhooks = (
            session.execute(select(Webhook).where(Webhook.bot_id == bot_id).order_by(desc(Webhook.created_at)))
            .scalars()
            .all()
        )
        return [
            {
                "id": webhook.id,
                "bot_id": webhook.bot_id,
                "url": webhook.url,
                "events": webhook.events or [],
                "is_active": webhook.is_active,
                "secret": "••••••••" if webhook.secret else None,
                "created_at": webhook.created_at,
            }
            for webhook in webhooks
        ]


@router.post("")
def create_webhook(
    body: CreateWebhookRequest,
    bot_id: int = Query(...),
    auth: dict = Depends(get_current_client_or_operator),
):
    # ── Plan enforcement: check webhooks feature ──
    from app.services.plan_service import enforce_feature

    with get_session() as db:
        enforce_feature(db, auth["client_id"], "webhooks")
        db.commit()

    _validate_events(body.events)
    _validate_webhook_url(str(body.url))
    with get_session() as session:
        _get_owned_bot(session, bot_id, auth["client_id"])
        webhook = Webhook(
            bot_id=bot_id,
            url=str(body.url),
            secret=generate_webhook_secret(),
            events=body.events,
            is_active=body.is_active,
        )
        session.add(webhook)
        session.commit()
        session.refresh(webhook)
        return {
            "id": webhook.id,
            "url": webhook.url,
            "events": webhook.events,
            "secret": webhook.secret,
            "is_active": webhook.is_active,
            "created_at": webhook.created_at,
        }


@router.patch("/{webhook_id}")
def update_webhook(
    webhook_id: int,
    body: UpdateWebhookRequest,
    auth: dict = Depends(get_current_client_or_operator),
):
    with get_session() as session:
        webhook = _get_owned_webhook(session, webhook_id, auth["client_id"])

        if body.events is not None:
            _validate_events(body.events)
            webhook.events = body.events
        if body.url is not None:
            _validate_webhook_url(str(body.url))
            webhook.url = str(body.url)
        if body.is_active is not None:
            webhook.is_active = body.is_active

        session.commit()
        return {"success": True}


@router.delete("/{webhook_id}")
def delete_webhook(webhook_id: int, auth: dict = Depends(get_current_client_or_operator)):
    with get_session() as session:
        webhook = _get_owned_webhook(session, webhook_id, auth["client_id"])
        session.delete(webhook)
        session.commit()
        return {"success": True}


@router.get("/{webhook_id}/deliveries")
def get_webhook_deliveries(
    webhook_id: int,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    auth: dict = Depends(get_current_client_or_operator),
):
    with get_session() as session:
        _get_owned_webhook(session, webhook_id, auth["client_id"])

        total = session.execute(
            select(func.count(WebhookDelivery.id)).where(WebhookDelivery.webhook_id == webhook_id)
        ).scalar_one()

        offset = (page - 1) * limit
        deliveries = (
            session.execute(
                select(WebhookDelivery)
                .where(WebhookDelivery.webhook_id == webhook_id)
                .order_by(desc(WebhookDelivery.created_at))
                .offset(offset)
                .limit(limit)
            )
            .scalars()
            .all()
        )

        return {
            "deliveries": [
                {
                    "id": delivery.id,
                    "event_type": delivery.event_type,
                    "status_code": delivery.status_code,
                    "attempt": delivery.attempt,
                    "created_at": delivery.created_at,
                    "delivered_at": delivery.delivered_at,
                    "next_retry_at": delivery.next_retry_at,
                }
                for delivery in deliveries
            ],
            "total": total,
            "page": page,
            "limit": limit,
        }


@router.post("/{webhook_id}/test")
def test_webhook(webhook_id: int, auth: dict = Depends(get_current_client_or_operator)):
    with get_session() as session:
        webhook = _get_owned_webhook(session, webhook_id, auth["client_id"])
        queue_webhook_delivery(
            webhook.id,
            "tier_transition",
            {
                "session_id": "test_session",
                "old_tier": "mql",
                "new_tier": "sql",
                "score": 82,
                "behavioral_score": 12,
                "test": True,
            },
        )
        return {"success": True, "message": "Test event dispatched"}
