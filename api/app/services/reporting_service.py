"""Per-bot reporting rollups.

Answers "what did each of my bots do in this window?" (credits spent,
conversations held, leads captured) for one account, one row per bot that
showed any activity.

The agency tier is the reason this exists: one account runs many client
sites off a **shared** credit pool, and the owner has to hand each of their
own clients a number. A pooled deduction lands in the client-level ledger
(``credit_ledger.bot_id IS NULL``), so grouping on the ledger *scope* would
collapse every agency client's spend into one anonymous bucket. Spend is
therefore grouped on ``attributed_bot_id``, the reporting-only column that
records which bot actually spent the credits regardless of which ledger paid.
See the column docstring in ``app.db.models.CreditLedger``: balance maths
must keep keying off ``bot_id``, and reporting must keep keying off
``attributed_bot_id``. Never swap them.

Strictly read-only, nothing here writes to the ledger.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Bot, ChatSession, CreditLedger, LeadInfo

# Ledger reasons that represent real metered consumption. Mirrors
# ``_CONSUMPTION_REASONS`` in ``app.api.subscription_routes`` (the Usage page's
# trend + breakdown) so the two surfaces never quote different numbers for the
# same window. Deliberately excludes plan_grant (grants + monthly resets),
# topup, refund, expiry, and manual_adjust. None of which are consumption.
#
# Copied rather than imported: this is the service layer and that is the API
# layer, so importing upward would invert the dependency. ``test_reporting_rollup``
# asserts the two tuples stay equal, which fails the build on drift.
CONSUMPTION_REASONS: tuple[str, ...] = (
    "ai_chat",
    "url_scan",
    "email_send",
    "document_upload",
    "email_verification",
    "company_name",
)


def _credits_by_bot(session: Session, *, client_id: int, since: datetime, until: datetime) -> dict[int, int]:
    """Consumption credits spent per attributed bot, as positive magnitudes.

    Joins ``Bot`` so a bot that was deleted (the FK nulls ``attributed_bot_id``)
    or that belongs to another account contributes nothing. ``delta < 0`` is
    belt-and-braces: consumption rows are always debits, and a stray credit
    row must never silently reduce a client's reported spend.
    """
    rows = session.execute(
        select(CreditLedger.attributed_bot_id, func.sum(-CreditLedger.delta))
        .join(Bot, Bot.id == CreditLedger.attributed_bot_id)
        .where(
            Bot.client_id == client_id,
            # Both sides of the tenant check. ``Bot.client_id`` is the
            # authoritative owner, and pinning the ledger row to the same
            # account means a mis-attributed row (one account's spend pointing
            # at another account's bot) is dropped rather than reported to the
            # wrong customer.
            CreditLedger.client_id == client_id,
            CreditLedger.reason.in_(CONSUMPTION_REASONS),
            CreditLedger.delta < 0,
            CreditLedger.created_at >= since,
            CreditLedger.created_at <= until,
        )
        .group_by(CreditLedger.attributed_bot_id)
    ).all()
    return {int(bot_id): int(total or 0) for bot_id, total in rows}


def _conversations_by_bot(session: Session, *, client_id: int, since: datetime, until: datetime) -> dict[int, int]:
    """Chat sessions started per bot in the window."""
    rows = session.execute(
        select(ChatSession.bot_id, func.count(ChatSession.id))
        .join(Bot, Bot.id == ChatSession.bot_id)
        .where(
            Bot.client_id == client_id,
            ChatSession.created_at >= since,
            ChatSession.created_at <= until,
        )
        .group_by(ChatSession.bot_id)
    ).all()
    return {int(bot_id): int(total or 0) for bot_id, total in rows}


def _leads_by_bot(session: Session, *, client_id: int, since: datetime, until: datetime) -> dict[int, int]:
    """Leads captured per bot in the window.

    ``LeadInfo`` carries its own ``created_at``, so the lead is dated by when
    contact details were captured rather than by when the conversation opened,
    a session that starts on the 31st and converts on the 1st belongs to the
    month it converted in.
    """
    rows = session.execute(
        select(LeadInfo.bot_id, func.count(LeadInfo.id))
        .join(Bot, Bot.id == LeadInfo.bot_id)
        .where(
            Bot.client_id == client_id,
            LeadInfo.created_at >= since,
            LeadInfo.created_at <= until,
        )
        .group_by(LeadInfo.bot_id)
    ).all()
    return {int(bot_id): int(total or 0) for bot_id, total in rows}


def get_per_bot_rollup(
    session: Session,
    *,
    client_id: int,
    since: datetime,
    until: datetime,
) -> list[dict]:
    """One row per bot of ``client_id`` that showed activity in the window.

    Each row is ``{"bot_id", "bot_name", "credits_spent", "conversations",
    "leads"}``. Bots with no credits, no conversations and no leads in the
    window are omitted entirely, an agency report should list the clients
    that did something, not every bot ever created. Sorted by credits spent,
    descending, with ``bot_id`` as a stable tie-breaker.

    ``since``/``until`` are both inclusive.
    """
    window = {"client_id": client_id, "since": since, "until": until}
    credits = _credits_by_bot(session, **window)
    conversations = _conversations_by_bot(session, **window)
    leads = _leads_by_bot(session, **window)

    active_bot_ids = set(credits) | set(conversations) | set(leads)
    if not active_bot_ids:
        return []

    # Names come from a client-scoped query rather than from the aggregates, so
    # a bot id that somehow survived the joins above still cannot surface a
    # foreign bot's name.
    names = dict(
        session.execute(select(Bot.id, Bot.name).where(Bot.id.in_(active_bot_ids), Bot.client_id == client_id)).all()
    )

    rows = [
        {
            "bot_id": bot_id,
            "bot_name": names[bot_id],
            "credits_spent": credits.get(bot_id, 0),
            "conversations": conversations.get(bot_id, 0),
            "leads": leads.get(bot_id, 0),
        }
        for bot_id in active_bot_ids
        if bot_id in names
    ]
    rows.sort(key=lambda row: (-row["credits_spent"], row["bot_id"]))
    return rows
