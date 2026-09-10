"""Which operator row an account acts as inside its own workspace.

Three doors lead to the same person: the availability toggle
(``POST /operators/status``), the status read the console makes on every window
focus (``GET /operators/me/status``), and the operator websocket authenticated
with the account's API key. They used to answer "which row is this account"
with different rules. The two HTTP endpoints preferred the account's own
self-operator row; the websocket took the first ``role='owner'`` row Postgres
returned, with no ordering.

That held while a workspace had one owner row. On 2026-09-10 an invited member
joined a live workspace with the owner role, and from then on the account's
console connected as that member. "Taking chats" switched the account's own row
on, the stale-flag sweep switched it off again (it had no socket), the console's
next status read said "off duty" and closed the socket, and visitors were told
the team was offline while the owner sat in the inbox.

One resolver, used by all three, is the fix.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Operator


def resolve_account_operator(
    session: Session,
    client_id: int,
    bot_id: int | None = None,
    *,
    active_only: bool = True,
) -> Operator | None:
    """The operator row the account ``client_id`` acts as in its own workspace.

    1. The account's self-operator row (``linked_client_id == client_id``).
    2. Otherwise a legacy owner row that belongs to no account
       (``role == 'owner'`` and ``linked_client_id IS NULL``), the row the
       websocket auto-provisions for an account that never added itself.

    A row linked to ANOTHER account is never returned, whatever its role: that
    row is a different person, and acting as it puts them on duty and takes
    their chats. Both steps order by id, so the answer does not depend on the
    physical order Postgres happens to return rows in.

    ``bot_id`` scopes the lookup the way the console's status read and toggle
    already do. ``active_only=False`` lets the websocket see a deactivated row so
    it can refuse it, instead of silently falling back to some other row.
    """
    conditions = [Operator.client_id == client_id]
    if active_only:
        conditions.append(Operator.is_active.is_(True))
    if bot_id is not None:
        conditions.append(Operator.bot_id == bot_id)

    own = session.execute(
        select(Operator).where(*conditions, Operator.linked_client_id == client_id).order_by(Operator.id).limit(1)
    ).scalar_one_or_none()
    if own is not None:
        return own

    return session.execute(
        select(Operator)
        .where(*conditions, Operator.role == "owner", Operator.linked_client_id.is_(None))
        .order_by(Operator.id)
        .limit(1)
    ).scalar_one_or_none()
