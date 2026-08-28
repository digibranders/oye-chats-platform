"""Activate / deactivate a bot's knowledge on plan transitions.

When a paid subscription lapses to Free (dunning expiry or cancellation) the
bot keeps all its data but should stop answering from a knowledge base it built
on a paid tier, the customer is prompted to re-add knowledge within Free's
caps, and re-upgrading restores everything. This module owns that reversible
"deactivate the whole bot's knowledge" flip; retrieval scoping lives in
``repository.py`` (every search/list query filters ``Document.is_active``).

Scope is per **bot**, not per client: the platform bills one subscription per
bot, so a lapse on one bot must not blank a sibling bot the customer still pays
for. Callers pass the lapsed/reactivated subscription's ``bot_id``.

Neither function commits, the caller owns the transaction so the flag flip
lands atomically with the subscription status change that triggered it.
"""

from __future__ import annotations

import logging

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.models import Document, Subscription

logger = logging.getLogger(__name__)

# Statuses that mean the bot is still funded and MUST keep its knowledge live.
# ``past_due`` is included because the dunning grace window keeps full access.
_FUNDED_STATUSES = ("active", "trialing", "past_due")


def _bot_still_funded(session: Session, bot_id: int) -> bool:
    """True when ``bot_id`` still has a funded subscription.

    Guards against a plan-upgrade cutover: the old subscription is canceled
    (which fires ``subscription.cancelled``) while a new one activates for the
    SAME bot. Without this check the old sub's cancellation would blank a bot
    that is still paid. ``flush`` first so the caller's just-set terminal status
    on the lapsing row is visible to this read (it must NOT count as funded).
    """
    session.flush()
    return (
        session.execute(
            select(Subscription.id)
            .where(Subscription.bot_id == bot_id, Subscription.status.in_(_FUNDED_STATUSES))
            .limit(1)
        ).first()
        is not None
    )


def deactivate_bot_knowledge(session: Session, bot_id: int | None) -> int:
    """Deactivate every currently-active chunk for ``bot_id``. Returns the count.

    Called when the bot's subscription lapses to Free. No-ops when the bot still
    has a funded subscription (an upgrade cutover, not a real lapse). Idempotent:
    chunks already inactive are skipped by the ``is_active = true`` guard, so a
    repeated call (redelivered webhook, overlapping crons) is a no-op too.
    """
    if not bot_id:
        return 0
    if _bot_still_funded(session, bot_id):
        return 0
    result = session.execute(
        update(Document).where(Document.bot_id == bot_id, Document.is_active.is_(True)).values(is_active=False)
    )
    count = result.rowcount or 0
    if count:
        logger.info("Deactivated %d knowledge chunk(s) for bot %s (plan lapsed to Free)", count, bot_id)
    return count


def reactivate_client_knowledge(session: Session, client_id: int) -> int:
    """Reactivate every deactivated chunk across ALL of a client's bots.

    Account-level subscriptions (``bot_id IS NULL``) are the trial and the Free
    row it converts into, and :func:`reactivate_bot_knowledge` is a hard no-op
    for a NULL bot id. So every account-level upgrade silently restored nothing,
    while the trial-ended email promised "one upgrade switches it back on".
    This is the client-level path that promise needs.

    Returns the number of chunks reactivated, summed across the client's bots.
    """
    from app.db.models import Bot

    total = 0
    bot_ids = session.execute(select(Bot.id).where(Bot.client_id == client_id)).scalars().all()
    for bot_id in bot_ids:
        total += reactivate_bot_knowledge(session, bot_id)
    result = session.execute(
        update(Document)
        .where(Document.client_id == client_id, Document.bot_id.is_(None), Document.is_active.is_(False))
        .values(is_active=True)
    )
    total += result.rowcount or 0
    return total


def deactivate_client_knowledge(session: Session, client_id: int) -> int:
    """Pause every active chunk across ALL of a client's bots. Returns the count.

    The account-level counterpart to :func:`deactivate_bot_knowledge`, used when
    a trial converts to Free: the subscription that lapsed is account-scoped, so
    there is no single ``bot_id`` to pass.

    The pause is ALL of a bot's knowledge, not the part above the Free plan's
    ceiling. ``deactivate_bot_knowledge`` is all-or-nothing by design and no
    partial mechanism exists, so every piece of copy about this must say exactly
    that: the knowledge is paused, and one upgrade restores all of it. Claiming
    a partial pause would publish something the code cannot honour.
    """
    from app.db.models import Bot

    total = 0
    bot_ids = session.execute(select(Bot.id).where(Bot.client_id == client_id)).scalars().all()
    for bot_id in bot_ids:
        total += deactivate_bot_knowledge(session, bot_id)
    # Chunks with a NULL ``bot_id``, which the crawl routes create whenever the
    # optional ``bot_id`` parameter is omitted. No per-bot call can reach them,
    # and "your knowledge base is paused" has to be true of the whole base.
    result = session.execute(
        update(Document)
        .where(Document.client_id == client_id, Document.bot_id.is_(None), Document.is_active.is_(True))
        .values(is_active=False)
    )
    total += result.rowcount or 0
    return total


def reactivate_bot_knowledge(session: Session, bot_id: int | None) -> int:
    """Reactivate every deactivated chunk for ``bot_id``. Returns the count.

    Called when a bot returns to a paid plan. Because customer-initiated
    deletion is a hard delete, an inactive chunk can only have been deactivated
    by :func:`deactivate_bot_knowledge`, so reactivating every inactive chunk
    restores exactly the pre-downgrade knowledge (plus anything re-added on Free,
    which was already active). Idempotent for the same reason as above.
    """
    if not bot_id:
        return 0
    result = session.execute(
        update(Document).where(Document.bot_id == bot_id, Document.is_active.is_(False)).values(is_active=True)
    )
    count = result.rowcount or 0
    if count:
        logger.info("Reactivated %d knowledge chunk(s) for bot %s (returned to a paid plan)", count, bot_id)
    return count
