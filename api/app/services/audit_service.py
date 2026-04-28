"""Super-admin audit trail helper.

``record_audit`` writes a single immutable row to ``audit_logs``. Routes that
mutate platform-wide state should call it on every successful change so the
``/superadmin/audit`` endpoint and dashboard can show who did what to whom.

Failures inside this helper must never break the caller — auditing is a
secondary concern. We log and swallow errors so a transient DB issue can't
cascade into a 500 on a successful business operation.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.db.models import AuditLog, Client

logger = logging.getLogger(__name__)


def record_audit(
    session: Session,
    *,
    actor: Client | None,
    action: str,
    target_type: str | None = None,
    target_id: str | int | None = None,
    before: Any = None,
    after: Any = None,
    request: Request | None = None,
) -> AuditLog | None:
    """Persist an audit entry. Returns the entry on success, ``None`` on failure."""

    try:
        ip = None
        user_agent = None
        if request is not None:
            ip = request.headers.get("x-forwarded-for", request.client.host if request.client else None)
            if isinstance(ip, str):
                ip = ip.split(",")[0].strip()
            user_agent = request.headers.get("user-agent")

        entry = AuditLog(
            actor_id=actor.id if actor else None,
            actor_name=actor.name if actor else None,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            before=before,
            after=after,
            ip=ip,
            user_agent=user_agent,
        )
        session.add(entry)
        session.flush()
        return entry
    except Exception:  # noqa: BLE001 — audit must never fail caller
        logger.exception("record_audit failed for action=%s", action)
        return None
