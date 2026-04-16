"""Chat session state machine — enforces valid transitions and logs all changes.

Valid states: bot, waiting, live, closed
Valid transitions:
    bot     → waiting   (visitor requests handoff)
    waiting → live      (operator accepts)
    waiting → bot       (visitor cancels, timeout, no operators available)
    waiting → closed    (visitor leaves while waiting)
    live    → bot       (operator closes chat, returns to AI)
    live    → closed    (visitor ends live chat)
    live    → waiting   (chat transferred to department / another operator)
"""

import logging
from typing import Final

from sqlalchemy import select

from app.db.models import ChatAuditLog, ChatSession
from app.db.session import get_session

logger = logging.getLogger(__name__)

# Allowed transitions: {current_state: {allowed_next_states}}
_TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    "bot": frozenset({"waiting"}),
    "waiting": frozenset({"live", "bot", "closed"}),
    "live": frozenset({"bot", "closed", "waiting"}),
    "closed": frozenset(),  # terminal state — no outbound transitions
}


class InvalidTransitionError(Exception):
    """Raised when a state transition is not allowed."""

    def __init__(self, session_id: str, current: str, target: str):
        self.session_id = session_id
        self.current = current
        self.target = target
        super().__init__(f"Invalid transition for session {session_id}: {current} → {target}")


def is_valid_transition(current: str, target: str) -> bool:
    """Check whether a state transition is allowed."""
    return target in _TRANSITIONS.get(current, frozenset())


def transition_session(
    session_id: str,
    target_status: str,
    *,
    operator_id: int | None = None,
    audit_action: str | None = None,
    audit_details: dict | None = None,
    expected_current: str | None = None,
) -> str:
    """Atomically transition a session to a new state with audit logging.

    Args:
        session_id: The chat session ID.
        target_status: Desired new status.
        operator_id: Operator performing the action (for audit log).
        audit_action: Action name for the audit log (e.g., "accepted", "closed").
        audit_details: Optional JSON details for the audit log.
        expected_current: If set, only transition if the current status matches this value.
            This enables atomic CAS-style transitions.

    Returns:
        The new status string on success.

    Raises:
        InvalidTransitionError: If the transition is not allowed.
        ValueError: If the session is not found.
    """
    with get_session() as db:
        chat_session = db.execute(
            select(ChatSession).where(ChatSession.id == session_id).with_for_update()
        ).scalar_one_or_none()

        if not chat_session:
            raise ValueError(f"Session {session_id} not found")

        current = chat_session.status

        # Idempotent: already in target state
        if current == target_status:
            return current

        # Validate transition
        if not is_valid_transition(current, target_status):
            raise InvalidTransitionError(session_id, current, target_status)

        # If expected_current is specified, enforce it (atomic CAS)
        if expected_current is not None and current != expected_current:
            raise InvalidTransitionError(session_id, current, target_status)

        # Apply transition
        chat_session.status = target_status
        if target_status == "live" and operator_id is not None:
            chat_session.assigned_operator_id = operator_id
        elif target_status in ("bot", "closed"):
            chat_session.assigned_operator_id = None

        # Audit log
        if audit_action:
            db.add(
                ChatAuditLog(
                    session_id=session_id,
                    operator_id=operator_id,
                    action=audit_action,
                    details=audit_details,
                )
            )

        db.commit()
        logger.info(f"Session {session_id}: {current} → {target_status} (action={audit_action})")
        return target_status
