"""WebSocket endpoints for live chat between visitors and operators."""

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.db.models import Bot, ChatSession, Client, Operator
from app.db.repository import add_chat_message, get_lead_info_by_session
from app.db.session import get_session
from app.services.live_chat_service import manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


async def _send_initial_waiting_queue(
    ws: WebSocket,
    client_id: int,
    operator_department_id: int | None = None,
):
    """Send DB-backed waiting queue snapshot on connect."""
    waiting_items: list[dict] = []

    with get_session() as session:
        waiting_sessions = session.execute(
            select(ChatSession, Bot)
            .join(Bot, ChatSession.bot_id == Bot.id)
            .where(Bot.client_id == client_id, ChatSession.status == "waiting")
            .order_by(ChatSession.created_at.asc())
        ).all()

        for chat_session, _ in waiting_sessions:
            if (
                operator_department_id
                and chat_session.department_id
                and chat_session.department_id != operator_department_id
            ):
                continue

            lead_info = get_lead_info_by_session(session, chat_session.id)
            waiting_items.append(
                {
                    "session_id": chat_session.id,
                    "name": lead_info.name if lead_info else "Anonymous",
                    "reason": chat_session.handoff_reason,
                }
            )

    await ws.send_json(
        {
            "type": "queue_update",
            "waiting": waiting_items,
            "count": len(waiting_items),
        }
    )


@router.websocket("/ws/chat/{session_id}")
async def visitor_websocket(ws: WebSocket, session_id: str, bot_key: str | None = None):
    """WebSocket for visitor (widget) side of live chat."""
    if not bot_key:
        await ws.close(code=4001, reason="Missing bot_key query param")
        return

    with get_session() as session:
        bot = session.execute(select(Bot).where(Bot.bot_key == bot_key, Bot.is_active.is_(True))).scalar_one_or_none()
        if not bot:
            await ws.close(code=4003, reason="Invalid bot key")
            return
        bot_id = bot.id

    await manager.connect_visitor(session_id, ws)

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "message":
                content = data.get("content", "").strip()
                if not content:
                    continue

                with get_session() as session:
                    add_chat_message(session, session_id, role="user", content=content, bot_id=bot_id)
                    session.commit()

                await manager.route_visitor_message(session_id, content)

            elif msg_type == "typing":
                await manager.send_typing_to_operator(session_id)

            elif msg_type == "visitor_end_chat":
                # Visitor deliberately ended the chat (clicked "End chat and return to AI").
                # Close the session immediately in DB and notify the operator — do NOT
                # start the 120s grace period, as this is an intentional user action.
                with get_session() as session:
                    chat_session = session.execute(
                        select(ChatSession).where(ChatSession.id == session_id)
                    ).scalar_one_or_none()
                    if chat_session and chat_session.status == "live":
                        bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
                        bot_name = bot.name if bot else "AI Assistant"
                        chat_session.status = "bot"
                        chat_session.assigned_operator_id = None
                        session.commit()
                        await manager.close_chat(session_id, bot_name)

    except WebSocketDisconnect:
        manager.disconnect_visitor(session_id)
    except Exception as e:
        logger.error(f"Visitor WS error for {session_id}: {e}")
        manager.disconnect_visitor(session_id)


def _resolve_operator_from_key(key: str, key_type: str) -> tuple[int, str, int, int | None, bool] | None:
    """Resolve operator_id, operator_name, client_id, department_id, is_online from an api_key or operator_key.

    Returns (operator_id, operator_name, client_id, department_id, is_online) or None if auth fails.
    """
    with get_session() as session:
        if key_type == "operator_key":
            operator = session.execute(select(Operator).where(Operator.operator_api_key == key)).scalar_one_or_none()
            if not operator:
                return None
            operator.is_online = True
            session.commit()
            return operator.id, operator.name, operator.client_id, operator.department_id, True

        # Client api_key auth — find or create the owner's operator record.
        # Use role='owner' to avoid matching sub-operators created for the same client.
        client = session.execute(select(Client).where(Client.api_key == key)).scalar_one_or_none()
        if not client:
            return None

        operator = session.execute(
            select(Operator).where(Operator.client_id == client.id, Operator.role == "owner").limit(1)
        ).scalar_one_or_none()

        if not operator:
            import uuid as _uuid

            operator = Operator(
                client_id=client.id,
                name=client.name,
                email=client.email,
                is_online=True,
                role="owner",
                operator_api_key=_uuid.uuid4().hex,
            )
            session.add(operator)
            session.commit()
            session.refresh(operator)
        else:
            operator.is_online = True
            session.commit()

        return operator.id, operator.name, client.id, operator.department_id, operator.is_online


@router.websocket("/ws/operator")
async def operator_websocket(
    ws: WebSocket,
    api_key: str | None = None,
    operator_key: str | None = None,
    agent_key: str | None = None,
):
    """WebSocket for operator (admin dashboard) side of live chat.

    Supports dual auth:
    - api_key: Client API key (owner/backward compat, resolves to first operator)
    - operator_key: Operator's own API key (for multi-operator)
    - agent_key: Legacy alias for operator_key (backward compat during transition)
    """
    effective_key = operator_key or agent_key
    if effective_key:
        result = _resolve_operator_from_key(effective_key, "operator_key")
    elif api_key:
        result = _resolve_operator_from_key(api_key, "api_key")
    else:
        await ws.close(code=4001, reason="Missing api_key or operator_key query param")
        return

    if not result:
        await ws.close(code=4003, reason="Invalid authentication key")
        return

    operator_id, operator_name, client_id, department_id, is_online = result

    await manager.connect_operator(
        operator_id,
        ws,
        department_id=department_id,
        operator_name=operator_name,
        is_online=is_online,
    )

    try:
        await _send_initial_waiting_queue(ws, client_id, department_id)
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "message":
                target_session = data.get("session_id")
                content = data.get("content", "").strip()
                if not target_session or not content:
                    continue

                with get_session() as session:
                    add_chat_message(session, target_session, role="operator", content=content, bot_id=None)
                    session.commit()

                await manager.route_operator_message(target_session, content, operator_name)

            elif msg_type == "typing":
                target_session = data.get("session_id")
                if target_session:
                    await manager.send_typing_to_visitor(target_session)

            elif msg_type == "close_chat":
                target_session = data.get("session_id")
                if target_session:
                    with get_session() as session:
                        chat_session = session.execute(
                            select(ChatSession).where(ChatSession.id == target_session)
                        ).scalar_one_or_none()
                        if chat_session:
                            bot = session.execute(select(Bot).where(Bot.id == chat_session.bot_id)).scalar_one_or_none()
                            # Ownership check: only allow the operator's own client to close
                            if not bot or bot.client_id != client_id:
                                logger.warning(
                                    f"Operator {operator_id} attempted to close session {target_session} "
                                    f"belonging to a different client — rejected"
                                )
                                continue
                            # Capture bot_name before session closes (avoid DetachedInstanceError)
                            bot_name = bot.name
                            chat_session.status = "bot"
                            chat_session.assigned_operator_id = None
                            session.commit()
                            await manager.close_chat(target_session, bot_name)

    except WebSocketDisconnect:
        # Start the grace period — do NOT immediately mark offline in DB.
        # The ConnectionManager will handle full cleanup + DB update if the operator
        # does not reconnect within OPERATOR_DISCONNECT_TIMEOUT seconds.
        await manager.disconnect_operator_and_broadcast(operator_id)
    except Exception as e:
        logger.error(f"Operator WS error for operator {operator_id}: {e}")
        await manager.disconnect_operator_and_broadcast(operator_id)


# ── Backward compat: keep /ws/agent as alias during transition ──
@router.websocket("/ws/agent")
async def legacy_agent_websocket(
    ws: WebSocket,
    api_key: str | None = None,
    agent_key: str | None = None,
    operator_key: str | None = None,
):
    """Legacy WebSocket endpoint — delegates to operator_websocket."""
    await operator_websocket(ws, api_key=api_key, operator_key=operator_key, agent_key=agent_key)
