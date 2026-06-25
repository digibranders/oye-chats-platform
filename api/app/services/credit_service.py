"""Credit-based billing service.

Single source of truth for credit balances. Replaces ``usage_service`` once all
hot paths have migrated. Uses an event-sourced ledger (``CreditLedger``) where
every grant, deduction, refund, and expiry is an immutable signed-delta row.

Key invariants:

* Balance for a client = ``SUM(delta) WHERE client_id = ?``.
* Plan grants reset on subscription renewal (use-it-or-lose-it). They never
  expire on their own.
* Top-up grants carry forward and expire 12 months from purchase. Whatever is
  unredeemed at expiry is written off as a negative ``expiry`` row keyed back
  to the original grant via ``grant_id``.
* Deductions consume grants in FIFO priority: ``plan_grant`` first (so plan
  credits don't waste at month-end), then top-ups by ``expires_at ASC``, then
  ``manual_adjust``. Each deduction row stores the ``grant_id`` it was
  allocated against so per-grant remaining balance is computable in one query.
* All deduct/refund/grant operations take a per-client PostgreSQL advisory
  lock so concurrent chat requests cannot oversell.

Pricing (credit costs, top-up packs, kill switch) is read from the
``pricing_config`` key/value table and cached for ~60s.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.core.dates import add_months
from app.db.models import Bot, CreditLedger, PricingConfig, Subscription

# ── Per-bot ledger scoping ────────────────────────────────────────────────────
#
# Every public read/write below takes an optional ``bot_id`` argument:
#
#   * ``bot_id=None`` (default)  → operates on the **client pool** —
#     ledger rows whose ``bot_id IS NULL``. This is the legacy /
#     account-level shape used by grandfathered (``is_legacy_pooled=True``)
#     bots and the Free single bot.
#   * ``bot_id=<int>``           → operates on an **isolated per-bot ledger**.
#     Used by every bot that has its own paid subscription
#     (``bot.is_legacy_pooled=False`` AND ``bot.subscription_id IS NOT NULL``).
#
# ``resolve_bot_ledger_bot_id`` is the single helper that maps a Bot row to
# the right scope. Call it at the boundary (chat / ingestion / email
# routes) and thread the result through the credit_service calls.


def resolve_bot_ledger_bot_id(bot: Bot | None) -> int | None:
    """Decide which ledger bucket a bot's usage should drain.

    Returns the bot's id (per-bot ledger) when the bot has its own paid
    subscription and isn't grandfathered into the pool. Returns ``None``
    (client pool) for legacy-pooled bots and the single Free bot — both
    keep the pre-per-bot-billing behaviour.
    """
    if bot is None:
        return None
    if getattr(bot, "is_legacy_pooled", False):
        return None
    if getattr(bot, "subscription_id", None) is None:
        return None
    return getattr(bot, "id", None)


logger = logging.getLogger(__name__)


# ── Exceptions ────────────────────────────────────────────────────────────────


class CreditError(Exception):
    """Base class for credit-service exceptions."""


class InsufficientCredits(CreditError):
    """Raised when a deduction would drive balance below zero."""

    def __init__(self, *, required: int, available: int) -> None:
        self.required = required
        self.available = available
        super().__init__(f"Insufficient credits: need {required}, have {available}")


class KillSwitchActive(CreditError):
    """Raised when the global ``kill_switch`` pricing flag is on."""


# ── Pricing config (cached) ───────────────────────────────────────────────────


_PRICING_CACHE_TTL_SECONDS = 60.0
_pricing_cache: dict[str, Any] = {}
_pricing_cache_loaded_at: float = 0.0
_pricing_cache_lock = threading.Lock()

# Defaults used when a key is missing from the database (defensive fallback;
# the migration seeds these so they should always be present).
_DEFAULT_PRICING: dict[str, Any] = {
    "credit_cost.ai_chat": 1,
    # URL crawl per page — bumped from 3 to 5. Each page goes through the
    # crawler, cleaner, chunker, embedder, and pgvector write; 5 credits
    # reflects the real cost more honestly and aligns with the tightened
    # plan limits (Free 30 pages = 150 credits worst case).
    "credit_cost.url_scan": 5,
    "credit_cost.email_send": 1,
    # Per-file knowledge base upload — bumped from 2 to 3. Documents go
    # through OpenAI embedding + chunking + pgvector storage, so 3 credits
    # better reflects ingestion cost (Free 5 docs = 15 credits worst case;
    # Standard 35 docs = 105 credits — still negligible against the plan).
    "credit_cost.document_upload": 3,
    "seat_price_cents": 1500,
    "topup_expiry_months": 12,
    "low_balance_warn_pct": 20,
    "kill_switch": False,
    # Top-up packs charge in INR via Razorpay but advertise USD prices in
    # the modal — see the ``a2c3e4f5b6d7_topup_packs_usd_reprice`` migration
    # for the contract.
    "topup_packs": [
        {
            "amount": 1599,
            "currency": "INR",
            "display_amount": 19,
            "display_currency": "USD",
            "credits": 2000,
            "bonus_pct": 0,
        },
        {
            "amount": 3999,
            "currency": "INR",
            "display_amount": 49,
            "display_currency": "USD",
            "credits": 5500,
            "bonus_pct": 10,
        },
        {
            "amount": 7999,
            "currency": "INR",
            "display_amount": 99,
            "display_currency": "USD",
            "credits": 12000,
            "bonus_pct": 20,
            "badge": "Best value",
        },
        {
            "amount": 19999,
            "currency": "INR",
            "display_amount": 249,
            "display_currency": "USD",
            "credits": 32500,
            "bonus_pct": 30,
        },
    ],
}


def get_pricing(session: Session, *, refresh: bool = False) -> dict[str, Any]:
    """Return all pricing_config rows merged with defaults. Cached for 60s.

    Pass ``refresh=True`` after a super-admin write to force the next caller to
    reload from the database.
    """
    global _pricing_cache_loaded_at

    now = time.monotonic()
    with _pricing_cache_lock:
        cache_fresh = (now - _pricing_cache_loaded_at) < _PRICING_CACHE_TTL_SECONDS
        if not refresh and _pricing_cache and cache_fresh:
            return dict(_pricing_cache)

        rows = session.execute(select(PricingConfig)).scalars().all()
        merged: dict[str, Any] = dict(_DEFAULT_PRICING)
        for row in rows:
            merged[row.key] = row.value
        _pricing_cache.clear()
        _pricing_cache.update(merged)
        _pricing_cache_loaded_at = now
        return dict(_pricing_cache)


def invalidate_pricing_cache() -> None:
    """Force the next ``get_pricing`` call to reload from the database."""
    global _pricing_cache_loaded_at
    with _pricing_cache_lock:
        _pricing_cache_loaded_at = 0.0


def get_credit_cost(session: Session, action: str) -> int:
    """Return the credit cost for an action (e.g. ``'ai_chat'``, ``'url_scan'``)."""
    pricing = get_pricing(session)
    return int(pricing.get(f"credit_cost.{action}", 0))


def is_kill_switch_active(session: Session) -> bool:
    """Return True when global credit deductions are halted by super admin."""
    return bool(get_pricing(session).get("kill_switch", False))


# ── Balance queries ───────────────────────────────────────────────────────────


def _scope_clause(client_id: int, bot_id: int | None):
    """Build the WHERE filter that selects a single (client, bot) ledger.

    ``bot_id=None`` selects the client pool (rows where ``bot_id IS NULL``),
    preserving the pre-per-bot-billing behaviour. ``bot_id=<int>`` selects
    a single bot's isolated ledger.
    """
    if bot_id is None:
        return (CreditLedger.client_id == client_id, CreditLedger.bot_id.is_(None))
    return (CreditLedger.client_id == client_id, CreditLedger.bot_id == int(bot_id))


def get_balance(session: Session, client_id: int, bot_id: int | None = None) -> int:
    """Return the current balance for the given ledger scope."""
    return int(
        session.scalar(select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(*_scope_clause(client_id, bot_id)))
        or 0
    )


def _consumed_against(session: Session, grant_id: int) -> int:
    """How many credits have been consumed against a given grant.

    Sums the absolute value of negative deltas whose ``grant_id`` matches.
    Scoped purely by ``grant_id`` (grants and their deductions always share
    the same client/bot scope by construction).
    """
    consumed = session.scalar(
        select(func.coalesce(func.sum(-CreditLedger.delta), 0)).where(
            CreditLedger.grant_id == grant_id,
            CreditLedger.delta < 0,
        )
    )
    return int(consumed or 0)


def _grants_for(
    session: Session,
    client_id: int,
    *,
    bot_id: int | None = None,
    only_unexpired: bool = True,
) -> list[CreditLedger]:
    """Return positive grant rows for a (client, bot) scope in FIFO order.

    Order:
      1. ``plan_grant`` first (use-it-or-lose-it; consume before top-ups).
      2. ``topup`` next, oldest ``expires_at`` first.
      3. ``manual_adjust`` last (treated as topup-like but with no expiry).
    """
    stmt = select(CreditLedger).where(
        *_scope_clause(client_id, bot_id),
        CreditLedger.delta > 0,
        CreditLedger.reason.in_(("plan_grant", "topup", "manual_adjust")),
    )
    if only_unexpired:
        now = datetime.now(UTC)
        stmt = stmt.where((CreditLedger.expires_at.is_(None)) | (CreditLedger.expires_at > now))
    stmt = stmt.order_by(
        text("CASE reason WHEN 'plan_grant' THEN 0 WHEN 'topup' THEN 1 ELSE 2 END"),
        CreditLedger.expires_at.asc().nulls_last(),
        CreditLedger.created_at.asc(),
    )
    return list(session.execute(stmt).scalars().all())


def get_balance_breakdown(session: Session, client_id: int, bot_id: int | None = None) -> dict[str, Any]:
    """Return ``{plan, topup, total, soonest_expiry}`` for one ledger scope."""
    plan_remaining = 0
    topup_remaining = 0
    soonest: datetime | None = None

    for grant in _grants_for(session, client_id, bot_id=bot_id):
        consumed = _consumed_against(session, grant.id)
        remaining = grant.delta - consumed
        if remaining <= 0:
            continue
        if grant.reason == "plan_grant":
            plan_remaining += remaining
        else:
            topup_remaining += remaining
            if grant.expires_at and (soonest is None or grant.expires_at < soonest):
                soonest = grant.expires_at

    return {
        "plan": plan_remaining,
        "topup": topup_remaining,
        "total": plan_remaining + topup_remaining,
        "soonest_expiry": soonest,
    }


# ── Atomicity helper ──────────────────────────────────────────────────────────


def _acquire_client_lock(session: Session, client_id: int, bot_id: int | None = None) -> None:
    """Take a transaction-scoped PG advisory lock keyed on (client_id, bot_id).

    Released automatically at COMMIT/ROLLBACK. Prevents concurrent
    requests from racing the balance check. Per-bot ledgers get their
    own lock so two bots under the same client don't serialise against
    each other. Uses the two-arg ``pg_advisory_xact_lock(int, int)``
    form for that; legacy / client-pool callers pass ``bot_id=0`` so
    every client-pool operation still serialises on the same lock.
    """
    session.execute(
        text("SELECT pg_advisory_xact_lock(:cid, :bid)"),
        {"cid": int(client_id), "bid": int(bot_id or 0)},
    )


# ── Mutations ─────────────────────────────────────────────────────────────────


def check_and_deduct(
    session: Session,
    client_id: int,
    amount: int,
    reason: str,
    reference_id: int | None = None,
    bot_id: int | None = None,
) -> int:
    """Atomically deduct ``amount`` credits, allocating FIFO within one scope.

    Writes one ledger row per grant chunk consumed (almost always exactly one).
    Returns the new balance. Raises :class:`InsufficientCredits` if the scope
    does not have enough credits, or :class:`KillSwitchActive` if global
    deductions are paused.
    """
    if amount <= 0:
        return get_balance(session, client_id, bot_id)

    if is_kill_switch_active(session):
        raise KillSwitchActive("Credit deductions are temporarily halted")

    _acquire_client_lock(session, client_id, bot_id)

    available = get_balance(session, client_id, bot_id)
    if available < amount:
        raise InsufficientCredits(required=amount, available=available)

    remaining = amount
    for grant in _grants_for(session, client_id, bot_id=bot_id):
        if remaining == 0:
            break
        avail = grant.delta - _consumed_against(session, grant.id)
        if avail <= 0:
            continue
        take = min(avail, remaining)
        session.add(
            CreditLedger(
                client_id=client_id,
                bot_id=bot_id,
                delta=-take,
                reason=reason,
                reference_id=reference_id,
                grant_id=grant.id,
            )
        )
        remaining -= take

    if remaining > 0:
        # Should never happen — balance check would have failed first.
        logger.error(
            "credit_service: short allocation for client %s bot %s (need %d, short %d)",
            client_id,
            bot_id,
            amount,
            remaining,
        )
        raise InsufficientCredits(required=amount, available=amount - remaining)

    session.flush()
    return available - amount


def refund(
    session: Session,
    client_id: int,
    amount: int,
    reference_id: int,
    note: str | None = None,
    bot_id: int | None = None,
) -> int:
    """Reverse a previous deduction (e.g., per-page crawl failure).

    Writes a positive ``refund`` delta. Does not re-attribute to a grant —
    refunded credits behave like a fresh manual adjustment for FIFO purposes.
    """
    if amount <= 0:
        return get_balance(session, client_id, bot_id)
    _acquire_client_lock(session, client_id, bot_id)
    session.add(
        CreditLedger(
            client_id=client_id,
            bot_id=bot_id,
            delta=int(amount),
            reason="refund",
            reference_id=reference_id,
            note=note or "Refund",
        )
    )
    session.flush()
    return get_balance(session, client_id, bot_id)


def grant_plan_credits(
    session: Session,
    client_id: int,
    amount: int,
    note: str | None = None,
    bot_id: int | None = None,
) -> CreditLedger:
    """Grant plan credits (subscription renewal). Never expire individually."""
    if amount <= 0:
        raise ValueError("grant_plan_credits requires positive amount")
    _acquire_client_lock(session, client_id, bot_id)
    entry = CreditLedger(
        client_id=client_id,
        bot_id=bot_id,
        delta=int(amount),
        reason="plan_grant",
        expires_at=None,
        note=note,
    )
    session.add(entry)
    session.flush()
    return entry


def grant_topup(
    session: Session,
    client_id: int,
    amount: int,
    note: str | None = None,
    bot_id: int | None = None,
) -> CreditLedger:
    """Grant top-up credits with an N-calendar-month expiry from now.

    Uses calendar-month arithmetic (``add_months``) not 30-day approximations,
    so a top-up bought on Jun 10 expires on Jun 10 the next year — not Jun 5
    (which the old ``months * 30`` day count would produce, losing 5 days).

    Per-bot top-ups land in that bot's isolated ledger when ``bot_id`` is
    set; account-level top-ups (``bot_id=None``) land in the client pool.
    """
    if amount <= 0:
        raise ValueError("grant_topup requires positive amount")
    pricing = get_pricing(session)
    months = int(pricing.get("topup_expiry_months", 12))
    expires_at = add_months(datetime.now(UTC), months)
    _acquire_client_lock(session, client_id, bot_id)
    entry = CreditLedger(
        client_id=client_id,
        bot_id=bot_id,
        delta=int(amount),
        reason="topup",
        expires_at=expires_at,
        note=note,
    )
    session.add(entry)
    session.flush()
    return entry


def grant_manual(
    session: Session,
    client_id: int,
    amount: int,
    note: str,
    by_user_id: int | None = None,
) -> CreditLedger:
    """Super admin manual grant. ``note`` is required; audit-logged via ``created_by``."""
    if amount == 0:
        raise ValueError("grant_manual requires non-zero amount")
    if not note:
        raise ValueError("grant_manual requires a note for audit trail")
    _acquire_client_lock(session, client_id)
    entry = CreditLedger(
        client_id=client_id,
        delta=int(amount),
        reason="manual_adjust",
        expires_at=None,
        note=note,
        created_by=by_user_id,
    )
    session.add(entry)
    session.flush()
    return entry


def reset_monthly_plan_credits(session: Session, client_id: int, bot_id: int | None = None) -> int:
    """Zero out unused plan credits at subscription renewal (within one scope).

    Returns the number of credits expired (informational; >= 0).

    Implementation: writes one negative ledger entry per *still-positive*
    plan_grant row, each tied to that grant's ``grant_id``. This is the same
    pattern ``check_and_deduct`` uses for normal consumption, and is the
    ONLY shape that ``get_balance_breakdown`` correctly attributes — an
    orphan negative entry (no ``grant_id``) would float in the raw sum but
    never reduce the breakdown's per-grant remaining, causing last month's
    unused credits to be silently rolled into the new month's bucket. That
    bug was the source of the "614 / 500" overflow we saw.
    """
    _acquire_client_lock(session, client_id, bot_id)
    leftover_total = 0
    for grant in _grants_for(session, client_id, bot_id=bot_id):
        if grant.reason != "plan_grant":
            continue  # don't expire top-ups or manual adjusts here
        consumed = _consumed_against(session, grant.id)
        remaining = int(grant.delta) - consumed
        if remaining <= 0:
            continue
        session.add(
            CreditLedger(
                client_id=client_id,
                bot_id=bot_id,
                delta=-remaining,
                reason="plan_grant",
                grant_id=grant.id,
                note="Monthly reset (use-it-or-lose-it)",
            )
        )
        # Flush per row — SQLAlchemy's batched insertmany path doesn't cast
        # the ``reason`` enum column correctly on PostgreSQL, and that path
        # only triggers when 2+ rows are queued at once. Flushing each row
        # individually forces the single-row INSERT that does cast properly.
        session.flush()
        leftover_total += remaining
    return leftover_total


def expire_old_topups(session: Session) -> int:
    """Daily cron: write off the unredeemed remainder of past-expiry top-up grants.

    Returns the total number of credits expired across all clients.
    """
    now = datetime.now(UTC)
    expired_grants = (
        session.execute(
            select(CreditLedger).where(
                CreditLedger.reason == "topup",
                CreditLedger.expires_at.is_not(None),
                CreditLedger.expires_at < now,
                CreditLedger.delta > 0,
            )
        )
        .scalars()
        .all()
    )

    total_expired = 0
    for grant in expired_grants:
        consumed = _consumed_against(session, grant.id)
        already_expired = int(
            session.scalar(
                select(func.coalesce(func.sum(-CreditLedger.delta), 0)).where(
                    CreditLedger.grant_id == grant.id,
                    CreditLedger.reason == "expiry",
                )
            )
            or 0
        )
        unused = grant.delta - consumed - already_expired
        if unused <= 0:
            continue
        _acquire_client_lock(session, grant.client_id)
        session.add(
            CreditLedger(
                client_id=grant.client_id,
                delta=-unused,
                reason="expiry",
                grant_id=grant.id,
                note=f"Top-up credits expired ({grant.expires_at:%Y-%m-%d})",
            )
        )
        total_expired += unused

    if total_expired:
        session.flush()
    return total_expired


# ── High-level helpers used by webhook handlers ───────────────────────────────


def grant_for_subscription(session: Session, subscription: Subscription) -> CreditLedger | None:
    """Grant the subscription's plan credits for the current period.

    Used on initial signup and by the cron-fallback monthly grant. Idempotency
    at the call site (webhook handler / cron) is responsible for not granting
    twice in the same period.

    Per-bot subscriptions (``subscription.bot_id IS NOT NULL``) land in the
    bot's isolated ledger; legacy / account-level subscriptions land in the
    client pool exactly as before.
    """
    plan = subscription.plan
    if plan is None or int(plan.credits_per_month or 0) <= 0:
        return None
    return grant_plan_credits(
        session,
        subscription.client_id,
        int(plan.credits_per_month),
        note=f"{plan.name} monthly grant",
        bot_id=subscription.bot_id,
    )


def clawback_refund(
    session: Session,
    *,
    client_id: int,
    charge_minor: int,
    refund_minor: int,
    note: str,
) -> tuple[int, int | None]:
    """Reverse credits on a refunded subscription / top-up invoice.

    Accounting rule, intentionally lenient: claw back only the UNCONSUMED
    portion of the most recent grant for this client, scaled by the
    fraction of the original charge that was refunded. Credits already
    spent on chats are gone — we can't unscramble the LLM tokens that
    bought them, so the customer keeps whatever they used before the
    refund. The clawback caps at the grant's remaining balance so this
    can never drive the customer's overall credit balance negative.

    Returns ``(amount_clawed_back, ledger_entry_id)``. The entry id is
    ``None`` when nothing was clawed back — either because there is no
    matching grant, the grant was already fully consumed, or the refund
    fraction came out to zero. Callers use the tuple for the webhook
    log line; nothing depends on the entry id.
    """
    if charge_minor <= 0 or refund_minor <= 0:
        return (0, None)

    _acquire_client_lock(session, client_id)

    # Cap the fraction at 1.0 — a partial refund larger than the original
    # charge shouldn't happen, but if a webhook glitch ever sends one we
    # clamp instead of multiplying past the original grant.
    refund_fraction = min(1.0, float(refund_minor) / float(charge_minor))

    # Pick the most recent positive plan / top-up grant for this client.
    # We don't have a hard FK from invoice → ledger today, and a renewal
    # cron runs at most once per period, so the latest grant is in
    # practice the one this invoice paid for. Edge case (renewed twice
    # in the same hour) is so unlikely it isn't worth a schema change.
    grant = (
        session.execute(
            select(CreditLedger)
            .where(
                CreditLedger.client_id == client_id,
                CreditLedger.reason.in_(("plan_grant", "topup")),
                CreditLedger.delta > 0,
            )
            .order_by(CreditLedger.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if grant is None:
        return (0, None)

    consumed = _consumed_against(session, grant.id)
    remaining = int(grant.delta) - consumed
    if remaining <= 0:
        return (0, None)

    intended = int(round(float(grant.delta) * refund_fraction))
    clawback = min(intended, remaining)
    if clawback <= 0:
        return (0, None)

    entry = CreditLedger(
        client_id=client_id,
        delta=-clawback,
        reason="refund",
        grant_id=grant.id,
        note=note,
    )
    session.add(entry)
    session.flush()
    return (clawback, entry.id)
