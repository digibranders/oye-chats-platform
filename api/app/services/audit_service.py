"""Super-admin audit trail helper.

``record_audit`` writes a single immutable row to ``audit_logs``. Routes that
mutate platform-wide state should call it on every successful change so the
``/superadmin/audit`` endpoint and dashboard can show who did what to whom.

Failures inside this helper must never break the caller. Auditing is a
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


def _impersonation_context(session: Session, actor: Client | None) -> dict[str, Any] | None:
    """Describe the real human behind an impersonated Client, or ``None``.

    ``auth._resolve_impersonated_client`` tags the detached Client it returns
    with ``_impersonator_id`` / ``_impersonation_token_id``. An ordinary caller
    carries neither, so the common path costs one ``getattr`` and no query.
    The ``isinstance`` check keeps mock/stub actors (whose attribute access
    auto-creates truthy objects) on the ordinary path.
    """
    impersonator_id = getattr(actor, "_impersonator_id", None)
    if not isinstance(impersonator_id, int):
        return None

    impersonator = session.get(Client, impersonator_id)
    return {
        "impersonator_id": impersonator_id,
        "impersonator_name": impersonator.name if impersonator is not None else None,
        "impersonator_email": impersonator.email if impersonator is not None else None,
        "impersonated_client_id": getattr(actor, "id", None),
        "impersonation_token_id": getattr(actor, "_impersonation_token_id", None),
    }


def _impersonated_actor_name(impersonation: dict[str, Any], actor: Client | None) -> str | None:
    """Render "<super-admin> (as <account>)" for the audit list."""
    impersonator_name = impersonation.get("impersonator_name")
    account_name = getattr(actor, "name", None)
    if impersonator_name and account_name:
        return f"{impersonator_name} (as {account_name})"
    return impersonator_name or account_name


def _with_impersonation(after: Any, impersonation: dict[str, Any]) -> dict[str, Any]:
    """Attach the impersonation context to the row's ``after`` snapshot.

    ``after`` is almost always a dict, so the context lands beside the existing
    keys under ``"impersonation"``. Any other payload is nested under
    ``"value"`` so the shape stays a dict and nothing is dropped.
    """
    if after is None:
        return {"impersonation": impersonation}
    if isinstance(after, dict):
        return {**after, "impersonation": impersonation}
    return {"value": after, "impersonation": impersonation}


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
    """Persist an audit entry. Returns the entry on success, ``None`` on failure.

    When ``actor`` is an impersonated Client (an ``X-Impersonation-Token``
    session), the row is attributed to the **super-admin who actually acted**,
    not to the customer whose Account they were driving, and the ``after``
    snapshot gains an ``"impersonation"`` block naming the Account and token.
    Callers need no change: passing the client from the auth dependency is
    enough for the trail to answer "who really did this".
    """

    try:
        ip = None
        user_agent = None
        if request is not None:
            ip = request.headers.get("x-forwarded-for", request.client.host if request.client else None)
            if isinstance(ip, str):
                ip = ip.split(",")[0].strip()
            user_agent = request.headers.get("user-agent")

        actor_id = actor.id if actor else None
        actor_name = actor.name if actor else None
        impersonation = _impersonation_context(session, actor)
        if impersonation is not None:
            actor_id = impersonation["impersonator_id"]
            actor_name = _impersonated_actor_name(impersonation, actor)
            after = _with_impersonation(after, impersonation)

        entry = AuditLog(
            actor_id=actor_id,
            actor_name=actor_name,
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
    except Exception:  # noqa: BLE001  Audit must never fail caller
        logger.exception("record_audit failed for action=%s", action)
        return None
