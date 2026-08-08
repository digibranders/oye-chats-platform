"""Web Push (VAPID) endpoints — VAPID key + subscribe / unsubscribe.

Extracted from ``operator_routes.py`` so the push surface has its own file.
URL layout is preserved (``/operators/push/*``) — the frontend and CDN clients
don't need to change.

Both operator (``X-Operator-Key``) and workspace-owner (``X-API-Key``) logins
are accepted via ``get_current_client_or_operator``. Rows in
``operator_push_subscriptions`` are bound by exactly one of ``operator_id`` or
``client_id`` (enforced by a DB CHECK constraint).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, field_validator
from sqlalchemy import delete as sa_delete
from sqlalchemy import select

from app.api.auth import get_current_client_or_operator
from app.db.models import OperatorExpoPushToken, OperatorPushSubscription
from app.db.session import get_session

router = APIRouter(prefix="/operators/push", tags=["push"])


class PushSubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscribeRequest(BaseModel):
    endpoint: str
    keys: PushSubscriptionKeys

    @field_validator("endpoint")
    @classmethod
    def _validate_endpoint(cls, v: str) -> str:
        v = v.strip()
        # Web Push endpoints are always https:// — provider-issued URLs.
        if not v.startswith("https://"):
            raise ValueError("endpoint must be an https:// URL")
        if len(v) > 2048:
            raise ValueError("endpoint too long")
        return v


class ExpoPushSubscribeRequest(BaseModel):
    token: str

    @field_validator("token")
    @classmethod
    def _validate_token(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith("ExponentPushToken[") and not v.startswith("ExpoPushToken["):
            raise ValueError("token must be a valid Expo Push Token")
        return v


@router.get("/vapid-public-key")
def get_vapid_public_key():
    """Return the server's VAPID public key (URL-safe base64).

    Public information — the frontend uses it as ``applicationServerKey`` when
    calling ``pushManager.subscribe()``. Safe to expose without auth.
    """
    from app.config import PUSH_ENABLED, VAPID_PUBLIC_KEY

    return {"public_key": VAPID_PUBLIC_KEY if PUSH_ENABLED else "", "enabled": PUSH_ENABLED}


@router.post("/subscribe")
def push_subscribe(
    body: PushSubscribeRequest,
    request: Request,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Register a Web Push subscription for the calling user.

    Accepts both operator and workspace-owner (client) logins. The row's
    ``operator_id`` or ``client_id`` is set depending on the auth type — a DB
    CHECK constraint guarantees exactly one is populated. Upsert by
    ``endpoint`` so the same browser re-subscribing simply re-binds to the
    current account (e.g. after re-login from the same machine, possibly as
    a different role).
    """
    is_operator = auth["type"] == "operator"
    subscriber_id = auth["entity"].id
    # Capture UA at subscribe-time so the user can later distinguish "Laptop
    # Chrome" from "iPhone Safari" if they ever manage devices. Truncated to
    # a safe length; browsers produce UAs in the 100-400 char range.
    ua = (request.headers.get("user-agent") or "")[:512] or None

    with get_session() as session:
        existing = session.execute(
            select(OperatorPushSubscription).where(OperatorPushSubscription.endpoint == body.endpoint)
        ).scalar_one_or_none()
        if existing is not None:
            # Re-bind the endpoint to whichever account is logged in *now*.
            # The browser reuses the same endpoint after a clean re-subscribe,
            # so an operator → owner role switch on the same device surfaces
            # correctly. Clear the other FK to satisfy the XOR check.
            if is_operator:
                existing.operator_id = subscriber_id
                existing.client_id = None
            else:
                existing.client_id = subscriber_id
                existing.operator_id = None
            existing.p256dh = body.keys.p256dh
            existing.auth = body.keys.auth
            existing.user_agent = ua
        else:
            session.add(
                OperatorPushSubscription(
                    operator_id=subscriber_id if is_operator else None,
                    client_id=None if is_operator else subscriber_id,
                    endpoint=body.endpoint,
                    p256dh=body.keys.p256dh,
                    auth=body.keys.auth,
                    user_agent=ua,
                )
            )
        session.commit()

    return {"success": True}


@router.delete("/subscribe")
def push_unsubscribe(
    body: PushSubscribeRequest,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Remove a Web Push subscription previously registered for this user.

    The frontend calls this when the user manually disables notifications or
    after ``pushManager.unsubscribe()`` returns. Idempotent: a delete on a
    non-existent endpoint is a no-op. Scoped to the calling user's own row —
    a subscriber cannot delete another account's subscription even if they
    happen to know the endpoint.
    """
    is_operator = auth["type"] == "operator"
    subscriber_id = auth["entity"].id
    scope = (
        OperatorPushSubscription.operator_id == subscriber_id
        if is_operator
        else OperatorPushSubscription.client_id == subscriber_id
    )
    with get_session() as session:
        session.execute(
            sa_delete(OperatorPushSubscription).where(
                scope,
                OperatorPushSubscription.endpoint == body.endpoint,
            )
        )
        session.commit()

    return {"success": True}


@router.post("/expo/subscribe")
def expo_push_subscribe(
    body: ExpoPushSubscribeRequest,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Register an Expo Push token for the calling user."""
    is_operator = auth["type"] == "operator"
    subscriber_id = auth["entity"].id

    with get_session() as session:
        existing = session.execute(
            select(OperatorExpoPushToken).where(OperatorExpoPushToken.token == body.token)
        ).scalar_one_or_none()
        
        if existing is not None:
            # Re-bind the endpoint to whichever account is logged in *now*.
            if is_operator:
                existing.operator_id = subscriber_id
                existing.client_id = None
            else:
                existing.client_id = subscriber_id
                existing.operator_id = None
        else:
            session.add(
                OperatorExpoPushToken(
                    operator_id=subscriber_id if is_operator else None,
                    client_id=None if is_operator else subscriber_id,
                    token=body.token,
                )
            )
        session.commit()

    return {"success": True}


@router.delete("/expo/subscribe")
def expo_push_unsubscribe(
    body: ExpoPushSubscribeRequest,
    auth: dict = Depends(get_current_client_or_operator),
):
    """Remove an Expo Push token previously registered for this user."""
    is_operator = auth["type"] == "operator"
    subscriber_id = auth["entity"].id
    scope = (
        OperatorExpoPushToken.operator_id == subscriber_id
        if is_operator
        else OperatorExpoPushToken.client_id == subscriber_id
    )
    with get_session() as session:
        session.execute(
            sa_delete(OperatorExpoPushToken).where(
                scope,
                OperatorExpoPushToken.token == body.token,
            )
        )
        session.commit()

    return {"success": True}
