"""REST + WebSocket endpoints for the in-app notification center.

REST surface (``/api/notifications``)

  GET    /                 → recent notifications (paged via ``before_id``)
  GET    /unread-count     → integer unread count
  POST   /mark-all-read    → mark every unread notification as read
  PATCH  /{id}/read        → mark a single notification as read
  DELETE /{id}             → delete one notification
  DELETE /                 → clear the full feed

WebSocket surface

  /ws/notifications        → real-time event stream (see auth note below)

Authentication for both surfaces uses the standard dashboard credentials:
``X-API-Key`` (workspace owner) **or** ``X-Operator-Key`` (operator). WS
auth re-uses the same ``Sec-WebSocket-Protocol`` trick the live-chat
console uses (key passed as a subprotocol), since browsers can't set
arbitrary headers on a ``new WebSocket()`` call.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.api.auth import get_current_client_or_operator
from app.db.models import Client, Operator
from app.db.session import get_session
from app.services import notification_service
from app.services.notification_broadcaster import broadcaster

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
def list_notifications(
    limit: int = Query(30, ge=1, le=100),
    before_id: int | None = Query(None, ge=1),
    unread_only: bool = Query(False),
    auth=Depends(get_current_client_or_operator),
):
    with get_session() as session:
        items = notification_service.list_notifications(
            session,
            client_id=auth["client_id"],
            limit=limit,
            before_id=before_id,
            unread_only=unread_only,
        )
        unread = notification_service.unread_count(session, auth["client_id"])
    return {"items": items, "unread_count": unread}


@router.get("/unread-count")
def get_unread_count(auth=Depends(get_current_client_or_operator)):
    with get_session() as session:
        return {"unread_count": notification_service.unread_count(session, auth["client_id"])}


@router.post("/mark-all-read")
def mark_all_read(auth=Depends(get_current_client_or_operator)):
    with get_session() as session:
        updated = notification_service.mark_all_read(session, auth["client_id"])
    return {"updated": updated, "unread_count": 0}


@router.patch("/{notification_id}/read")
def mark_read(notification_id: int, auth=Depends(get_current_client_or_operator)):
    with get_session() as session:
        ok = notification_service.mark_read(session, auth["client_id"], notification_id)
        if not ok:
            # Either non-existent or already read — both are safe no-ops, so
            # return success with the current count rather than 404'ing the
            # frontend on a fast double-click.
            pass
        unread = notification_service.unread_count(session, auth["client_id"])
    return {"updated": ok, "unread_count": unread}


@router.delete("/{notification_id}")
def delete_one(notification_id: int, auth=Depends(get_current_client_or_operator)):
    with get_session() as session:
        ok = notification_service.delete_notification(session, auth["client_id"], notification_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Notification not found")
        unread = notification_service.unread_count(session, auth["client_id"])
    return {"deleted": True, "unread_count": unread}


@router.delete("")
def clear_all(auth=Depends(get_current_client_or_operator)):
    with get_session() as session:
        deleted = notification_service.clear_all(session, auth["client_id"])
    return {"deleted": deleted, "unread_count": 0}


# ── WebSocket ──────────────────────────────────────────────────────────────

ws_router = APIRouter(tags=["notifications"])


def _auth_from_subprotocol(ws: WebSocket) -> tuple[int | None, str | None]:
    """Decode the auth subprotocol the frontend sends as ``<kind>.<key>``.

    Returns ``(client_id, accepted_subprotocol)`` on success, or
    ``(None, None)`` when the credential is missing/invalid. The caller is
    responsible for ``ws.close()`` in the failure case.
    """
    raw = ws.headers.get("sec-websocket-protocol", "")
    if not raw:
        return None, None
    candidates = [t.strip() for t in raw.split(",") if t.strip()]
    if not candidates:
        return None, None

    # Match the way ws_routes.py parses /ws/operator — scan every
    # offered subprotocol. Accepts both the project-standard
    # ``api-key.``/``operator-key.`` forms and the original
    # ``client.``/``operator.`` aliases for rolling-deploy compatibility.
    with get_session() as session:
        for proto in candidates:
            if "." not in proto:
                continue
            kind, _, key = proto.partition(".")
            kind = kind.lower()
            if not key:
                continue
            if kind in ("api-key", "client", "api"):
                row = session.execute(select(Client).where(Client.api_key == key)).scalars().first()
                if row:
                    return row.id, proto
            elif kind in ("operator-key", "operator", "agent-key", "agent"):
                row = session.execute(select(Operator).where(Operator.operator_api_key == key)).scalars().first()
                if row and getattr(row, "is_active", True):
                    return row.client_id, proto
    return None, None


@ws_router.websocket("/ws/notifications")
async def notifications_ws(ws: WebSocket):
    """Push in-app notification events to a dashboard tab in real time.

    Protocol:
      • Client connects with subprotocol ``client.<api_key>`` or
        ``operator.<operator_api_key>``.
      • Server replies (after accept) with one ``hello`` frame carrying
        the initial unread count so the bell can render immediately.
      • Server then pushes ``{"event": "notification.created", ...}``
        events as they happen. Other event types may be added later.
      • Client sends ``ping`` strings every 30s; server replies ``pong``.
    """
    client_id, accepted = _auth_from_subprotocol(ws)
    if client_id is None:
        logger.warning("notifications_ws authentication failed (invalid subprotocol)")
        # 1008 = policy violation; matches the live-chat WS convention.
        await ws.close(code=1008)
        return

    await ws.accept(subprotocol=accepted)
    await broadcaster.connect(client_id, ws)

    try:
        with get_session() as session:
            unread = notification_service.unread_count(session, client_id)
        await ws.send_json({"event": "hello", "unread_count": unread})

        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_text("pong")
            # Any other inbound payload is currently ignored — the channel
            # is server-push-only.
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("notifications_ws error")
    finally:
        await broadcaster.disconnect(client_id, ws)
