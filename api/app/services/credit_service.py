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
import math
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.core.dates import add_months
from app.db.models import Bot, CreditLedger, PricingConfig, Subscription

# ── Per-bot ledger scoping ────────────────────────────────────────────────────
#
# Every public read/write below takes an optional ``bot_id`` argument:
#
#   * ``bot_id=None`` (default)  → operates on the **client pool**.
#     Ledger rows whose ``bot_id IS NULL``. This is the legacy /
#     account-level shape used by grandfathered (``is_legacy_pooled=True``)
#     bots and the Free single bot.
#   * ``bot_id=<int>``           → operates on an **isolated per-bot ledger**.
#     Used by every bot that has its own paid subscription
#     (``bot.is_legacy_pooled=False`` AND ``bot.subscription_id IS NOT NULL``).
#
# ``resolve_bot_ledger_bot_id`` is the single helper that maps a Bot row to
# the right scope. Call it at the boundary (chat / ingestion / email
# routes) and thread the result through the credit_service calls.


_UNSET: object = object()


# The statuses under which a subscription still FUNDS anything. Mirrors
# ``auth._ACTIVE_SUBSCRIPTION_STATUSES`` / ``bot_routes._bot_has_live_subscription``:
# ``past_due`` counts because dunning is a grace window, not a shut-off.
_LIVE_SUBSCRIPTION_STATUSES: frozenset[str] = frozenset({"trialing", "active", "past_due"})


def resolve_bot_ledger_bot_id(bot: Bot | None) -> int | None:
    """Decide which ledger bucket a bot's usage should drain.

    Returns ``bot.id`` (per-bot ledger) only when the subscription linked to
    this bot is itself scoped to the bot (``subscription.bot_id == bot.id``)
    AND still live. Returns ``None`` (client pool) for:
    - legacy-pooled / Free bots
    - bots whose ``subscription_id`` is a convenience pointer set by the
      per-bot-billing migration but whose subscription still has
      ``bot_id = NULL``. Credits live in the client pool for those bots.
    - bots whose own subscription is DEAD (canceled/expired/paused). Nothing
      clears ``Bot.subscription_id`` on cancellation, so without the status
      check a bot whose per-bot subscription was cancelled - the advertised
      support flow for moving an account onto a pooled tier - kept draining a
      dead, never-again-granted isolated ledger forever and hit
      InsufficientCredits while the account pool sat full (seam-audit P1).

    Credit routing path:
    - ``get_current_bot()`` pre-resolves ``subscription.bot_id`` into
      ``bot._subscription_bot_id`` before expunging the ORM object from
      the session, so detached bots can be routed without a lazy-load.
    - ``subscription_routes`` and tests pass fresh ORM objects with an
      active session; those fall through to the ``bot.subscription``
      relationship (lazy-loaded while the session is alive).
    """
    if bot is None:
        return None
    if getattr(bot, "is_legacy_pooled", False):
        return None
    if getattr(bot, "subscription_id", None) is None:
        return None
    bot_pk = getattr(bot, "id", None)
    # Fast path: _subscription_bot_id is pre-resolved by get_current_bot()
    # for detached bots (avoids DetachedInstanceError on lazy relationship).
    sub_bot_id = getattr(bot, "_subscription_bot_id", _UNSET)
    if sub_bot_id is _UNSET:
        # Slow path: bot was loaded with an active session (subscription_routes,
        # billing endpoints). Lazy-load the relationship normally. The liveness
        # judgement happens here; the fast path already had it applied by
        # ``live_subscription_bot_id`` at pre-resolution time.
        sub = getattr(bot, "subscription", None)
        if sub is None or sub.status not in _LIVE_SUBSCRIPTION_STATUSES:
            return None
        sub_bot_id = sub.bot_id
    if sub_bot_id != bot_pk:
        return None
    return bot_pk


def live_subscription_bot_id(session: Session, subscription_id: int | None) -> int | None:
    """``subscription.bot_id`` for ledger routing - ``None`` unless it is LIVE.

    The auth layer (``get_current_bot`` and friends) stashes this on the bot as
    ``_subscription_bot_id`` before expunging it, so the hot chat path routes
    credits without a lazy-load. It must carry the same liveness judgement as
    :func:`resolve_bot_ledger_bot_id`'s slow path: pre-resolving the scope of a
    DEAD subscription would re-create the orphaned-ledger P1 on exactly the
    path that spends the most credits.
    """
    if subscription_id is None:
        return None
    return session.scalar(
        select(Subscription.bot_id).where(
            Subscription.id == subscription_id,
            Subscription.status.in_(_LIVE_SUBSCRIPTION_STATUSES),
        )
    )


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
    # URL crawl per page. Bumped from 3 to 5. Each page goes through the
    # crawler, cleaner, chunker, embedder, and pgvector write; 5 credits
    # reflects the real cost more honestly and aligns with the tightened
    # plan limits (Free 30 pages = 150 credits worst case).
    "credit_cost.url_scan": 5,
    "credit_cost.email_send": 1,
    # Reoon power-mode email verification, charged once per background lead
    # enrichment (never on the real-time widget blur check). Gated to
    # Standard + Professional plans and to the ``feature.email_verification_enabled``
    # kill switch below; skipped silently when the ledger can't cover it.
    "credit_cost.email_verification": 10,
    # IP → company-name / firmographic lookup (Visitor Intelligence), charged
    # once per resolved visitor. Professional-only and gated to the
    # ``feature.company_name_enabled`` kill switch; skipped silently on an
    # empty balance.
    "credit_cost.company_name": 5,
    # Per-file knowledge base upload, the MINIMUM charge for one file. The
    # cost scales with document size (below); a file short enough to price
    # under this floor still costs this much.
    "credit_cost.document_upload": 1,
    # Operator live-chat translation (Phase 4), charged once per translated
    # message per target language. Live chat itself remains free; this is the
    # only metered thing on that path. Gated to the per-bot
    # ``language_config.operator_translation_enabled`` flag AND to the
    # ``feature.translation_enabled`` switch below. A workspace that runs out
    # of credits loses translation, never message delivery.
    "credit_cost.translation": 1,
    # Size-based upload pricing: one flat rate, no buckets. A document costs
    # ``ceil(words / 250)`` credits (1 credit per 250 words) floored at the
    # minimum above. Both halves are super-admin tunable from the pricing
    # panel; this replaced a five-bucket word-tier table whose EXCLUSIVE
    # ``max_words`` edges had to be restated identically in the customer-facing
    # table, and drifted from it (see ``get_document_upload_cost_for_size``).
    "credit_cost.document_upload_words_per_credit": 250,
    "seat_price_cents": 1500,
    # Lifetime top-ups: 0 (or any non-positive value) means top-up grants never
    # expire. ``grant_topup`` writes ``expires_at=None`` and the daily
    # ``expire_old_topups`` sweep skips them entirely. One-time purchase, credits
    # carry forward forever.
    "topup_expiry_months": 0,
    "low_balance_warn_pct": 20,
    "kill_switch": False,
    # Master on/off switches for the two metered enrichment features, editable
    # from the super-admin pricing panel (pricing_config KV). When False the
    # feature is skipped for everyone regardless of plan, no lookup, no charge.
    "feature.email_verification_enabled": True,
    # Company lookup. LAUNCHED. Off = no lookup and no charge, anywhere.
    # Note this feature charges only when a company is actually IDENTIFIED
    # (see chat_routes._resolve_and_update_location): most visitors arrive on
    # consumer ISP ranges that name no employer, and the customer must not pay
    # 10 credits for "not identified".
    "feature.company_name_enabled": True,
    # Operator live-chat translation (Phase 4). Off = no translation call and
    # no charge, for every workspace, with no deploy. The per-bot
    # ``operator_translation_enabled`` flag is the customer-facing control;
    # this is the platform-wide one. Turning it off degrades live chat to
    # original-language-only, it never interrupts a conversation.
    "feature.translation_enabled": True,
    # Visitor language resolution and the AI's answer language (Phases 2/3).
    # The platform-wide counterpart to each bot's ``language_config.enabled``.
    #
    # Separate from ``feature.translation_enabled`` on purpose: that one governs
    # operator live-chat translation, which is metered and can be withdrawn on
    # its own. This one governs whether a conversation has a language at all.
    # Turning it off makes every bot behave exactly as a bot with multilingual
    # disabled: no directive in the prompt, the legacy QA cache key, English
    # canned paths. It charges nothing, so it is not a credit switch; it lives
    # here because this is where the platform's DB-backed, no-deploy feature
    # flags already are.
    #
    # It does NOT govern the admin dashboard's own UI language (Phase 7). Those
    # are different slices and coupling them would let a conversation-side
    # incident silently change what language the dashboard renders in.
    "feature.multilingual_chat_enabled": True,
    # One-time top-up packs (lifetime credits). Charged in INR via Razorpay;
    # ``usd`` is a display-only headline for non-INR buyers (never charged).
    # ``bonus_pct`` / ``badge`` are marketing metadata, fully super-admin
    # editable. Priced per the 2026-08 credit reprice.
    "topup_packs": [
        {
            "inr": 1000,
            "usd": 13,
            "credits": 2000,
            "bonus_pct": 0,
            "stripe_price_id": None,
            "razorpay_plan_id": None,
        },
        {
            "inr": 4000,
            "usd": 50,
            "credits": 8000,
            "bonus_pct": 0,
            "stripe_price_id": None,
            "razorpay_plan_id": None,
        },
        {
            "inr": 10000,
            "usd": 125,
            "credits": 30000,
            "bonus_pct": 50,
            "stripe_price_id": None,
            "razorpay_plan_id": None,
        },
        {
            "inr": 20000,
            "usd": 250,
            "credits": 70000,
            "bonus_pct": 75,
            "badge": "Best value",
            "stripe_price_id": None,
            "razorpay_plan_id": None,
        },
        {
            "inr": 30000,
            "usd": 375,
            "credits": 100000,
            "bonus_pct": 67,
            "stripe_price_id": None,
            "razorpay_plan_id": None,
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


# Fail-closed default when an action's credit cost is missing or malformed:
# charge (at least) 1 rather than defaulting to 0 (free), which would silently
# leak revenue on a typo'd/unpriced action or a non-numeric config value (§5).
_DEFAULT_CREDIT_COST = 1

# Document-upload rate, used when pricing_config carries no usable override.
# Mirrors ``_DEFAULT_PRICING`` above; kept as named constants because
# ``get_document_upload_cost_for_size`` needs them as a fail-closed fallback
# for a config value it cannot parse.
_DEFAULT_WORDS_PER_CREDIT = 250
_MIN_DOCUMENT_UPLOAD_COST = 1


def _coerce_credit_cost(raw: Any) -> int | None:
    """Turn one raw ``pricing_config`` value into a chargeable credit count.

    Returns ``None`` when the value cannot be read as a price, so the caller can
    fail closed. ``pricing_config.value`` is untyped JSONB written by
    ``PUT /superadmin/pricing-config/{key}``, so every one of these is reachable
    from the pricing panel:

    * ``None`` — a cleared field. NOT "free": a price nobody set is unknown.
    * a negative — a typo'd sign. The previous ``max(int(raw), 0)`` turned this
      into a FREE action, which is a revenue leak on the exact input this
      helper exists to survive.
    * a string or a list — ``int()`` RAISES on these, and this value is read by
      ``GET /credits/balance`` as well as by the charge path, so the raise took
      the Usage and Billing pages down for every customer in the platform.
    * ``NaN`` / ``inf`` — ``float()`` accepts both and neither is a price.

    A numeric string (``"3"``) is accepted: a JSON text field invites one, and
    it states a price unambiguously. A fraction is rounded UP to a whole credit
    — credits are whole units and a partial one is charged as one, matching
    ``get_document_upload_cost_for_size``. Truncating 1.5 to 1 would have
    undercharged silently.
    """
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return math.ceil(value)


def get_credit_cost(session: Session, action: str) -> int:
    """Return the credit cost for an action (e.g. ``'ai_chat'``, ``'url_scan'``).

    Fails CLOSED: an unknown action, or a config value that is not a usable
    price, yields ``_DEFAULT_CREDIT_COST`` (not 0/free) and is logged, so
    pricing gaps surface as a charge rather than a silent free ride. An
    explicit ``0`` is honoured — that is a super admin deliberately making an
    action free, not a malformed value. See :func:`_coerce_credit_cost`.

    Every consumer of a per-action price goes through here, the charge path and
    the read path that shows a customer what an action costs
    (``subscription_routes._credit_costs_payload``) alike. That is what makes
    the price shown and the price charged one value rather than two readings of
    the same raw config with different clamping.
    """
    pricing = get_pricing(session)
    raw = pricing.get(f"credit_cost.{action}", _DEFAULT_CREDIT_COST)
    cost = _coerce_credit_cost(raw)
    if cost is None:
        logger.warning(
            "credit_cost.%s is not a usable price (%r). Failing closed to %d",
            action,
            raw,
            _DEFAULT_CREDIT_COST,
        )
        return _DEFAULT_CREDIT_COST
    return cost


def count_words(text: str) -> int:
    """Rough word count for size-based upload pricing.

    Uses whitespace-split. Matches how a user would eyeball the doc's
    length. Punctuation attached to words counts as one word; hyphenated
    compounds count as one. Good enough for a 250-words-per-credit rate, where
    a 10-word imprecision moves the charge only on an exact multiple of 250.
    Empty / whitespace-only input returns 0, which prices at 0 credits via
    ``get_document_upload_cost_for_size``: nothing was extracted, so nothing
    reaches the knowledge base and nothing is charged.
    """
    if not text:
        return 0
    return len(text.split())


def get_document_upload_floor(session: Session) -> int:
    """The per-file MINIMUM an upload is charged, clamped to at least 1 credit.

    ``credit_cost.document_upload`` is an untyped JSONB value a super admin can
    save as ``0``; a zeroed floor must not make uploads free, so the clamp is
    part of the value rather than something each caller remembers to apply.

    Public because two consumers need the same number: the deduction path
    (:func:`get_document_upload_cost_for_size`) and the read path that shows a
    customer what an upload costs (``subscription_routes._credit_costs_payload``).
    Serving the raw config value there while charging the clamped one is the
    exact price/charge divergence this pair of helpers exists to prevent.
    """
    return max(get_credit_cost(session, "document_upload"), _MIN_DOCUMENT_UPLOAD_COST)


def get_document_upload_words_per_credit(session: Session, *, warn: bool = True) -> int:
    """The upload rate in words per credit, clamped to a positive integer.

    Fails CLOSED: a missing, non-numeric or non-positive
    ``credit_cost.document_upload_words_per_credit`` falls back to the shipped
    ``_DEFAULT_WORDS_PER_CREDIT`` rather than to a divisor that would make an
    upload free (or raise ``ZeroDivisionError`` mid-ingest).

    ``warn=False`` suppresses the log line for read-only callers. The deduction
    path logs a bad value on every upload, which is where an operator should
    see it; the balance endpoint polls, and repeating the same warning on every
    poll would bury it.
    """
    raw_rate = get_pricing(session).get(
        "credit_cost.document_upload_words_per_credit",
        _DEFAULT_WORDS_PER_CREDIT,
    )
    try:
        words_per_credit = int(raw_rate)
    except (TypeError, ValueError):
        words_per_credit = 0
    if words_per_credit <= 0:
        if warn:
            logger.warning(
                "credit_cost.document_upload_words_per_credit is missing or not a positive "
                "integer (%r). Falling back to %d words per credit",
                raw_rate,
                _DEFAULT_WORDS_PER_CREDIT,
            )
        words_per_credit = _DEFAULT_WORDS_PER_CREDIT
    return words_per_credit


def get_document_upload_cost_for_size(session: Session, word_count: int) -> int:
    """Return the credit cost for uploading a document of ``word_count`` words.

    One flat rate: ``ceil(words / rate)`` credits, where ``rate`` is
    ``credit_cost.document_upload_words_per_credit`` (250. I.e. 1 credit per
    250 words), never below the ``credit_cost.document_upload`` minimum. Both
    keys are super-admin tunable from the pricing panel, and both are read here
    through the clamping accessors above, which is the same pair the balance
    endpoint serves to the console: one source, both consumers.

    This replaced a five-bucket word-tier table. The buckets priced the same
    idea in a shape that had to be restated (with EXCLUSIVE edges) in the
    customer-facing table in ``UsagePage.tsx``, and the two drifted: every
    bounded boundary advertised one price and charged the next bucket up, 3x
    at 100 words. A single rate has no edges to restate.

    A file with NO extractable words costs 0, not the floor. The floor is the
    minimum for storing content; a file that yielded none (an empty .txt, a
    scanned PDF with no text layer, an extraction that failed) puts nothing in
    the knowledge base and is not billed. The ingest route has always skipped
    billing those, so the floor was quoted by ``POST /ingest/preview-cost``
    for a file the very next request charged 0 for — a shown price and a
    charged price disagreeing inside one money surface. The rule lives here, in
    the one function both the quote and the charge call, rather than in an
    ``if words > 0`` at each of them.

    Fails CLOSED: a missing or non-numeric rate falls back to the shipped 250
    rather than to a divisor that would make an upload free.
    """
    word_count = max(int(word_count or 0), 0)
    if word_count == 0:
        return 0
    minimum = get_document_upload_floor(session)
    words_per_credit = get_document_upload_words_per_credit(session)

    # Integer ceiling division, a partial block of words is a whole credit.
    charged = (word_count + words_per_credit - 1) // words_per_credit
    return max(charged, minimum)


def is_kill_switch_active(session: Session) -> bool:
    """Return True when global credit deductions are halted by super admin."""
    return bool(get_pricing(session).get("kill_switch", False))


# Values a super-admin might plausibly type into the pricing panel's untyped
# `value: Any` editor meaning "off". `bool("false")` is True in Python, so a
# bare bool() here turns every one of these into ON, the opposite of intent,
# on a switch whose entire job is to stop a metered feature from charging.
_FEATURE_FALSY = frozenset({"0", "false", "no", "off", "disabled", ""})


def is_feature_enabled(session: Session, feature: str) -> bool:
    """Return the super-admin on/off state for a metered feature.

    Reads ``feature.<name>_enabled`` from pricing config. E.g.
    ``feature.email_verification_enabled``, ``feature.company_name_enabled``.

    **The ``_enabled`` suffix is load-bearing and was missing.** This function
    read ``feature.<name>``, which is defined nowhere: not in
    ``_DEFAULT_PRICING``, not in ``seed_pricing_config.py``. Combined with the
    fail-open default below, that made every switch permanently ON. Verified
    against a real database: with ``feature.company_name_enabled = False``
    physically present, this returned ``True``. So the Visitor-Intelligence
    company lookup (the one the admin UI badges "Coming soon" and whose own
    comment promises it "never charges") deducted 10 credits per visitor
    session, and a super-admin turning it off in the panel changed nothing.
    On Professional that is the full 10,000-credit monthly allowance in 1,000
    sessions, for an unlaunched feature.

    Fails OPEN (defaults to True) only for a genuinely ABSENT key, so a feature
    shipped without a config row behaves like its default rather than silently
    dying. A key that is present and falsy is honoured. That is the whole
    point of the switch.
    """
    value = get_pricing(session).get(f"feature.{feature}_enabled", True)
    if isinstance(value, str):
        return value.strip().lower() not in _FEATURE_FALSY
    return bool(value)


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
    """Return the current SPENDABLE balance for the given ledger scope.

    Equals the raw delta sum MINUS the still-unconsumed remainder of top-up grants
    that have passed their expiry but which the daily sweep hasn't zeroed yet
    (finding O3). Without this subtraction the balance would overstate what the
    FIFO allocator (which skips expired grants) can actually spend, causing the
    same "short allocation" / stuck-balance divergence finding E fixed for refunds
    (up to one sweep interval). The overhang is 0 in the common case (nothing
    expired-and-unswept), so this stays cheap.
    """
    total = int(
        session.scalar(select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(*_scope_clause(client_id, bot_id)))
        or 0
    )
    now = datetime.now(UTC)
    expired = (
        session.execute(
            select(CreditLedger).where(
                *_scope_clause(client_id, bot_id),
                CreditLedger.delta > 0,
                CreditLedger.reason == "topup",
                CreditLedger.expires_at.is_not(None),
                CreditLedger.expires_at <= now,
            )
        )
        .scalars()
        .all()
    )
    overhang = sum(max(int(g.delta) - _consumed_against(session, g.id), 0) for g in expired)
    return total - overhang


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
      3. ``refund`` alongside topups (no expiry; sorts after dated topups).
      4. ``manual_adjust`` last (treated as topup-like but with no expiry).

    ``refund`` MUST be included (finding E): ``get_balance`` sums every positive
    delta, so an allocatable set that excluded refunds left the customer with a
    positive-but-unspendable balance. Invariant: ``get_balance`` equals what this
    allocator can consume.
    """
    stmt = select(CreditLedger).where(
        *_scope_clause(client_id, bot_id),
        CreditLedger.delta > 0,
        CreditLedger.reason.in_(("plan_grant", "topup", "manual_adjust", "refund")),
    )
    if only_unexpired:
        now = datetime.now(UTC)
        stmt = stmt.where((CreditLedger.expires_at.is_(None)) | (CreditLedger.expires_at > now))
    stmt = stmt.order_by(
        text("CASE reason WHEN 'plan_grant' THEN 0 WHEN 'topup' THEN 1 WHEN 'refund' THEN 1 ELSE 2 END"),
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
    idempotency_key: str | None = None,
    *,
    attributed_bot_id: int | None = None,
) -> int:
    """Atomically deduct ``amount`` credits, allocating FIFO within one scope.

    Writes one ledger row per grant chunk consumed (almost always exactly one).
    Returns the new balance. Raises :class:`InsufficientCredits` if the scope
    does not have enough credits, or :class:`KillSwitchActive` if global
    deductions are paused.

    ``idempotency_key`` (finding H): an OPT-IN, globally-unique token identifying
    one billable unit of work. Only the crawl ingestion path passes one today.
    ``ingest:{client_id}:{bot_id}:{crawl_job_id}:{url_sha}`` (see
    ``pipeline.batch_web_ingestion``); the visitor ``/chat`` path deliberately
    does NOT (a client-held key there is a free-chat vector). When supplied, a
    retry / re-queued ARQ job carrying the same key is a no-op, the existing
    deduction stands and the current balance is returned. ``reference_id`` remains
    a coarse AUDIT label (bot/doc id) and does NOT drive idempotency; callers that
    pass no key keep the exact prior behaviour (charge per call). A partial unique
    index on ``idempotency_key`` backs the app-level check against a lost race.

    This is intended for TRUSTED server-side callers (background jobs), NOT for
    untrusted/visitor-facing endpoints: a caller that can freely hold the key
    constant across distinct billable events would get them for free. Callers
    MUST namespace the key to include the ledger scope (client/bot) so two
    different scopes can never mint the same key. That makes the cross-scope
    unique-index race unreachable; same-scope retries are serialised by the
    advisory lock and caught by the check below.

    ``attributed_bot_id`` answers "which bot SPENT this?" and is REPORTING-ONLY.
    It is deliberately independent of ``bot_id``, which is the ledger SCOPE key
    (``None`` = shared client pool) that every balance query keys off. A pooled
    deduction therefore carries ``bot_id=None`` (so the pool balance stays
    correct) alongside a concrete ``attributed_bot_id`` (so per-bot reporting
    still works). It defaults to ``bot_id`` so every bot-scoped deduction stays
    attributed without the caller doing anything; only pooled callers need to
    pass it explicitly. Balance maths MUST NEVER read this column. See
    ``_scope_clause``.
    """
    if amount <= 0:
        return get_balance(session, client_id, bot_id)

    if is_kill_switch_active(session):
        raise KillSwitchActive("Credit deductions are temporarily halted")

    _acquire_client_lock(session, client_id, bot_id)

    # Idempotency (finding H): short-circuit if a deduction with this key already
    # exists. Runs under the advisory lock so two concurrent retries can't both
    # pass. Keys are globally unique (namespaced by caller), so the lookup is not
    # scope-restricted, a stray cross-scope collision should surface, not silently
    # double-charge.
    if idempotency_key is not None:
        prior = session.execute(
            select(CreditLedger.reason, func.coalesce(func.sum(-CreditLedger.delta), 0))
            .where(CreditLedger.idempotency_key == idempotency_key, CreditLedger.delta < 0)
            .group_by(CreditLedger.reason)
        ).all()
        if prior:
            # Defense-in-depth: a key is meant to be 1:1 with a fixed billable
            # unit. If it's ever reused for a DIFFERENT amount/reason, skipping
            # silently could leak value, so fail loud in the log rather than
            # quietly no-op a larger charge. (Not currently reachable: every key
            # is server-derived and 1:1 with its work unit.)
            prior_reason, prior_amount = prior[0]
            if len(prior) > 1 or int(prior_amount) != amount or prior_reason != reason:
                logger.warning(
                    "credit_service: idempotency_key=%s reused with a different unit "
                    "(prior reason=%s amount=%s; now reason=%s amount=%s). Skipping anyway",
                    idempotency_key,
                    prior_reason,
                    prior_amount,
                    reason,
                    amount,
                )
            else:
                logger.info(
                    "credit_service: idempotent skip. Deduction for key=%s already recorded",
                    idempotency_key,
                )
            return get_balance(session, client_id, bot_id)

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
                # Reporting-only; never part of the scope/balance maths. Falls
                # back to the scope so bot-scoped deductions self-attribute.
                attributed_bot_id=attributed_bot_id if attributed_bot_id is not None else bot_id,
                delta=-take,
                reason=reason,
                reference_id=reference_id,
                grant_id=grant.id,
                # Stamp the key only on the FIRST chunk so the partial unique
                # index (one row per key) isn't violated by a multi-grant split.
                idempotency_key=idempotency_key if remaining == amount else None,
            )
        )
        remaining -= take

    if remaining > 0:
        # Should never happen. Balance check would have failed first.
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
    *,
    attributed_bot_id: int | None = None,
) -> int:
    """Reverse a previous deduction (e.g., per-page crawl failure).

    Writes a positive ``refund`` delta. Does not re-attribute to a grant.
    Refunded credits behave like a fresh manual adjustment for FIFO purposes.

    ``attributed_bot_id`` mirrors :func:`check_and_deduct`: this row reverses a
    specific bot's spend, so it carries the same reporting attribution (and the
    same ``bot_id`` fallback). Without it a pooled refund would be unattributed
    while the pooled deduction it reverses is attributed, so any net-spend
    report would over-count that bot.
    """
    if amount <= 0:
        return get_balance(session, client_id, bot_id)
    _acquire_client_lock(session, client_id, bot_id)
    session.add(
        CreditLedger(
            client_id=client_id,
            bot_id=bot_id,
            attributed_bot_id=attributed_bot_id if attributed_bot_id is not None else bot_id,
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
    reference_id: int | None = None,
) -> CreditLedger:
    """Grant plan credits (subscription renewal). Never expire individually.

    ``reference_id`` links the grant to the originating ``Invoice.id`` so a
    later refund can claw back *this* grant precisely instead of the most-recent
    plan_grant in scope (remediation C2 / NV5).
    """
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
        reference_id=reference_id,
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
    reference_id: int | None = None,
) -> CreditLedger:
    """Grant top-up credits, expiring N calendar months from now (0 = lifetime).

    When ``topup_expiry_months`` is positive, uses calendar-month arithmetic
    (``add_months``) not 30-day approximations, so a top-up bought on Jun 10
    expires on Jun 10 the next year, not Jun 5 (which the old ``months * 30``
    day count would produce, losing 5 days). When it is 0 (or negative) the
    grant is written with ``expires_at=None``, a lifetime, one-time top-up
    that never expires.

    Per-bot top-ups land in that bot's isolated ledger when ``bot_id`` is
    set; account-level top-ups (``bot_id=None``) land in the client pool.

    ``reference_id`` links the grant to the originating ``Invoice.id`` so a
    refund claws back *this* top-up rather than the most-recent one in scope
    (remediation C2. Fixes refunding the older of two same-bot top-ups).
    """
    if amount <= 0:
        raise ValueError("grant_topup requires positive amount")
    pricing = get_pricing(session)
    months = int(pricing.get("topup_expiry_months", 0) or 0)
    # months <= 0 → lifetime top-up: no expiry row is ever written, so
    # ``expire_old_topups`` (which filters ``expires_at IS NOT NULL``) never
    # sweeps it and the credits carry forward forever.
    expires_at = add_months(datetime.now(UTC), months) if months > 0 else None
    _acquire_client_lock(session, client_id, bot_id)
    entry = CreditLedger(
        client_id=client_id,
        bot_id=bot_id,
        delta=int(amount),
        reason="topup",
        expires_at=expires_at,
        note=note,
        reference_id=reference_id,
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
    ONLY shape that ``get_balance_breakdown`` correctly attributes, an
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
        # Flush per row. SQLAlchemy's batched insertmany path doesn't cast
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
        # Finding O1: take the per-scope advisory lock BEFORE reading consumption.
        # Reading `consumed` first and locking afterwards is a TOCTOU, a
        # concurrent deduction landing between the read and the lock would leave
        # `unused` stale and over-sweep the grant (expiring credits the customer
        # just spent). Locking first serialises against check_and_deduct so the
        # consumption read below is stable.
        _acquire_client_lock(session, grant.client_id, grant.bot_id)
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
        session.add(
            CreditLedger(
                client_id=grant.client_id,
                bot_id=grant.bot_id,
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


def cycle_months(billing_cycle: str | None) -> int:
    """Number of months of credits a subscription grants per billing period."""
    return 12 if (billing_cycle or "").strip().lower() == "annual" else 1


def grant_for_subscription(
    session: Session, subscription: Subscription, reference_id: int | None = None
) -> CreditLedger | None:
    """Grant the subscription's plan credits for the current period.

    Used on initial signup and by the cron-fallback monthly grant. Idempotency
    at the call site (webhook handler / cron) is responsible for not granting
    twice in the same period.

    Per-bot subscriptions (``subscription.bot_id IS NOT NULL``) land in the
    bot's isolated ledger; legacy / account-level subscriptions land in the
    client pool exactly as before.

    Annual subscriptions advance their billing period by 12 months and are
    only granted once per period (see ``grant_subscription_period_once`` /
    the renewal cron), so the grant itself must scale by ``billing_cycle``.
    Otherwise an annual subscriber receives only 1/12th of the credits they
    paid for.
    """
    plan = subscription.plan
    if plan is None or int(plan.credits_per_month or 0) <= 0:
        return None
    months = cycle_months(getattr(subscription, "billing_cycle", None))
    return grant_plan_credits(
        session,
        subscription.client_id,
        int(plan.credits_per_month) * months,
        note=f"{plan.name} {'annual' if months == 12 else 'monthly'} grant",
        bot_id=subscription.bot_id,
        reference_id=reference_id,
    )


def _backfill_plan_grant_reference(session: Session, subscription: Subscription, invoice_id: int) -> None:
    """Link the most recent un-referenced plan_grant in scope to ``invoice_id``.

    Only ever touches a row whose ``reference_id`` is still NULL, so it can
    never clobber a real, already-correct link, at most it fills in the one
    gap left by an activation-time grant that predates its invoice (see the
    caller). Scoped by client + bot exactly like every other grant/clawback
    lookup so a per-bot subscription's backfill can't reach the account pool
    (or vice versa).
    """
    grant = (
        session.execute(
            select(CreditLedger)
            .where(
                *_scope_clause(subscription.client_id, subscription.bot_id),
                CreditLedger.reason == "plan_grant",
                # Positive rows only: reset debits share reason="plan_grant"
                # and a NULL reference_id, and rows written in one transaction
                # share the same server-side created_at, without these two
                # guards the invoice link could land on a NEGATIVE reset row,
                # silently disabling precise refund clawback (P0-1 aggravator).
                CreditLedger.delta > 0,
                CreditLedger.reference_id.is_(None),
            )
            .order_by(CreditLedger.created_at.desc(), CreditLedger.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if grant is not None:
        grant.reference_id = invoice_id
        session.flush()


# Two period-end values can describe the SAME paid cycle and still differ by a
# few days: the renewal cron keys on ``add_months(old_end)``, which day-clamps
# month-end anchors (Jan 31 → Feb 28 → Mar 28), while Razorpay's ``current_end``
# re-expands to the anchor day (Mar 31). A strictly monotonic marker would treat
# the webhook's larger value as a fresh period and re-run reset+grant. Any real
# billing cycle is ≥ 28 days, so a ≤ 4-day advance can never be a legitimate new
# period. Treat it as already granted.
_PERIOD_KEY_TOLERANCE = timedelta(days=4)


def grant_subscription_period_once(
    session: Session,
    subscription: Subscription,
    period_end: datetime | None,
    *,
    invoice_id: int | None = None,
) -> bool:
    """Reset + grant a subscription's plan credits for ``period_end``, at most once.

    Idempotent per billing period (remediation H4): if the subscription's
    ``last_granted_period_end`` already equals ``period_end``, this is a no-op
    and returns ``False``. Otherwise it resets the prior period's unused plan
    grant, grants the new allowance, advances the marker, and returns ``True``.

    Both the reset and the grant are scoped to ``subscription.bot_id`` so an
    account-level subscription (``bot_id IS NULL``) touches only the client
    pool and a per-bot subscription touches only that bot's ledger, the two
    never cross-contaminate. This is the single source of truth for per-period
    granting shared by the Razorpay webhook path and the renewal cron (BL-5 /
    NB-8); keep the two callers behaviourally identical by routing both here.

    A ``None`` ``period_end`` (event missing ``current_end``) still grants but
    cannot advance the marker; that is logged so a missing period is visible
    rather than silently double-granting on a later event.

    Concurrency (T5 review): the ``last_granted_period_end`` marker check below
    is the idempotency decision, and it is shared by two independent callers,
    the renewal cron and the ``subscription.charged`` webhook. That can run in
    overlapping transactions for the *same* period. The advisory lock inside
    ``reset_monthly_plan_credits`` / ``grant_plan_credits`` only serializes the
    ledger writes, not this read, so without a lock here both callers could read
    the same stale marker, both decide to grant, and each write a ``plan_grant``
    (an extra month of credits). ``ProcessedWebhook`` does not cover this because
    the cron shares no event id with the webhook. We take a ``SELECT ... FOR
    UPDATE`` row lock on the subscription and re-read it *before* the marker
    check so the decision runs against committed, locked data: if a concurrent
    transaction grants and commits for this period first, the loser blocks on the
    row lock, then observes the advanced marker and no-ops. Every caller passes a
    persistent, flushed subscription whose own columns are not dirty at this
    point (the ``current_period_*`` writes happen after this helper returns), so
    refreshing does not discard pending changes. The lock is re-entrant with the
    later advisory lock (a different lock space) and cannot deadlock on a row the
    session already owns.

    We ``flush`` before the refresh because the session is configured with
    ``autoflush=False``: without it, ``refresh`` would issue its ``SELECT ... FOR
    UPDATE`` *before* pushing a marker set earlier in the same transaction (e.g.
    ``subscription.activated`` then ``subscription.charged`` handled in one
    transaction), reload the pre-set committed value, and clobber our own marker
    back. Reintroducing the double-grant it is meant to prevent. Flushing makes
    the re-read observe read-your-own-writes; the FOR UPDATE still returns the
    latest committed row, so a concurrent committed grant is still seen.

    Precondition: because that ``flush`` flushes the *whole* session, callers must
    not leave other unflushed ``Subscription`` (or any other) column writes pending
    that are not yet meant to hit the DB when invoking this helper. The intended
    dirty state is at most the ``last_granted_period_end`` marker set by an earlier
    same-transaction handler; ``current_period_*`` and similar writes are performed
    by callers *after* this helper returns (see ``razorpay_service``).
    """
    session.flush()
    session.refresh(subscription, with_for_update=True)

    if (
        period_end is not None
        and subscription.last_granted_period_end is not None
        and period_end <= subscription.last_granted_period_end + _PERIOD_KEY_TOLERANCE
    ):
        # Monotonic, not exact-equality: any period at or before the marker is
        # already granted. A strict ``==`` check is exploitable, the
        # superadmin dead-letter "replay failed webhook" tool re-dispatches an
        # event by its original (never-committed) id, so an OLDER period's
        # charged event that failed and got dead-lettered can be replayed
        # AFTER a newer period's grant already advanced the marker past it.
        # ``==`` would treat that stale replay as a fresh, ungranted period.
        # Granting a second time for a period the customer already burned
        # credits against, and regressing the marker backward so the very
        # next legitimate replay (or the real event, if it also redelivers)
        # can trigger yet another grant. ``<=`` makes the marker monotonic:
        # the old event now correctly no-ops instead of regressing anything.
        #
        # The grant for this period already happened. Almost always at
        # ``subscription.activated``, which runs before any Invoice exists and
        # so calls ``grant_for_subscription`` with no ``reference_id`` (see
        # ``_handle_subscription_activated``). The invoice for that same charge
        # only shows up later via ``subscription.charged``, by which point this
        # no-op branch is all that runs, the reference never gets attached.
        # Without it, ``clawback_refund`` on that invoice can't find its exact
        # grant and falls back to "most recent grant in scope", which on a
        # multi-period-old chargeback claws back a LATER period's still-in-use
        # credits instead of the (already fully consumed / long expired) grant
        # the refund actually paid for. Backfill it here, the first time an
        # invoice_id becomes available for an already-granted period.
        #
        # Only backfill on an EXACT period match. ``_backfill_plan_grant_reference``
        # links whatever the most recent un-referenced plan_grant is. Correct when
        # this event's period is the same one that grant belongs to, but a stale
        # replay of an OLDER period (period_end < marker, the new ``<=`` case above)
        # could otherwise misattribute ITS invoice onto a newer, unrelated grant.
        if invoice_id is not None and period_end == subscription.last_granted_period_end:
            _backfill_plan_grant_reference(session, subscription, invoice_id)
        return False

    reset_monthly_plan_credits(session, subscription.client_id, bot_id=subscription.bot_id)
    grant_for_subscription(session, subscription, reference_id=invoice_id)
    if period_end is not None:
        subscription.last_granted_period_end = period_end
    else:
        logger.warning(
            "Granted subscription %s credits without a period end. Marker not advanced",
            subscription.razorpay_subscription_id,
        )
    return True


def clawback_refund(
    session: Session,
    *,
    client_id: int,
    charge_minor: int,
    refund_minor: int,
    note: str,
    bot_id: int | None = None,
    reasons: tuple[str, ...] = ("plan_grant", "topup"),
    invoice_id: int | None = None,
    allow_unlinked_fallback: bool = False,
) -> tuple[int, int | None]:
    """Reverse credits on a refunded subscription / top-up invoice.

    Accounting rule, intentionally lenient: claw back only the UNCONSUMED
    portion of the most recent matching grant **within the same ledger
    scope** the payment credited, scaled by the fraction of the original
    charge that was refunded. Credits already spent on chats are gone. We
    can't unscramble the LLM tokens that bought them, so the customer keeps
    whatever they used before the refund. The clawback caps at the grant's
    remaining balance so this can never drive the balance negative.

    Scoping (remediation C2):

    * ``bot_id`` selects the ledger scope, the bot's isolated ledger when set,
      else the client pool. The reversal lands in, and the advisory lock is
      taken on, that same scope, so a per-bot refund no longer writes to the
      client pool (which left bot credits un-reversed and could drive the pool
      negative).
    * ``reasons`` narrows which grant type to claw back: a subscription refund
      passes ``("plan_grant",)`` and a top-up refund ``("topup",)`` so that,
      when a client holds both, the refund reverses the grant the invoice
      actually paid for rather than whichever was created most recently.

    Returns ``(amount_clawed_back, ledger_entry_id)``; the entry id is ``None``
    when nothing was clawed back (no matching grant, already consumed, or the
    refund fraction rounded to zero).
    """
    if charge_minor <= 0 or refund_minor <= 0:
        return (0, None)

    _acquire_client_lock(session, client_id, bot_id)

    # Cap the fraction at 1.0, a partial refund larger than the original
    # charge shouldn't happen, but if a webhook glitch ever sends one we
    # clamp instead of multiplying past the original grant.
    refund_fraction = min(1.0, float(refund_minor) / float(charge_minor))

    # Prefer the grant(s) LINKED to this invoice (remediation C2 / NV5): grants
    # stamp ``reference_id = Invoice.id`` at grant time, so we can claw back the
    # exact grant(s) the refunded invoice paid for, not the most-recent grant of
    # the same type, which mis-attributes when a client holds two same-scope
    # top-ups or refunds an old subscription invoice after a renewal.
    #
    # Finding #3: a single invoice's entitlement can span MORE THAN ONE grant row
    # (e.g. an activation partial + a proration top-up, or an annual grant the
    # credits backfill split into two rows). Clawing back only ONE row
    # under-reverses a full refund. Collect ALL grants linked to this invoice and
    # spread the clawback across them. This is safe from over-claw precisely
    # because every row is scoped to THIS invoice, it can never reach a later
    # period's still-in-use grant.
    linked_grants: list[CreditLedger] = []
    if invoice_id is not None:
        linked_grants = list(
            session.execute(
                select(CreditLedger)
                .where(
                    *_scope_clause(client_id, bot_id),
                    CreditLedger.reason.in_(reasons),
                    CreditLedger.delta > 0,
                    CreditLedger.reference_id == invoice_id,
                )
                .order_by(CreditLedger.created_at.desc())
            )
            .scalars()
            .all()
        )

    if linked_grants:
        grants = linked_grants
    elif not allow_unlinked_fallback:
        # No grant is linked to this invoice and the caller did not authorise
        # the legacy guess. Claw NOTHING: seat add-on and withheld-credit
        # invoices legitimately fund no grant, and guessing "most recent grant
        # in scope" wiped whole plan allowances for a ₹449 seat refund (P0-1).
        # A missed clawback is recoverable by ops; a wrong one is not.
        logger.error(
            "clawback_refund: no grant linked to invoice %s (client=%s bot=%s reasons=%s) "
            "and unlinked fallback not allowed, nothing clawed; review manually",
            invoice_id,
            client_id,
            bot_id,
            reasons,
        )
        return (0, None)
    else:
        # Fallback for legacy / unlinked grants (rows created before C2 linking
        # and before ``Invoice.kind``): the most-recent matching grant in scope
        # is in practice the one this invoice paid for. Kept to a SINGLE row
        # here. Summing every unlinked grant in scope could reverse a later
        # period's still-in-use credits, which the invoice linkage above exists
        # to prevent. Callers may only set ``allow_unlinked_fallback`` for
        # invoices whose ``kind`` is NULL (pre-migration rows).
        one = (
            session.execute(
                select(CreditLedger)
                .where(
                    *_scope_clause(client_id, bot_id),
                    CreditLedger.reason.in_(reasons),
                    CreditLedger.delta > 0,
                )
                .order_by(CreditLedger.created_at.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        grants = [one] if one is not None else []

    if not grants:
        return (0, None)

    # Intended clawback = the refunded fraction of the TOTAL credits these grants
    # represent (matches the fraction of money refunded).
    total_granted = sum(int(g.delta) for g in grants)
    intended = int(round(float(total_granted) * refund_fraction))
    if intended <= 0:
        return (0, None)

    # Spread the clawback across the grants (newest first), each capped at its own
    # unconsumed remaining, until the intended amount is satisfied.
    total_clawed = 0
    last_entry_id: int | None = None
    for grant in grants:
        if total_clawed >= intended:
            break
        consumed = _consumed_against(session, grant.id)
        remaining = int(grant.delta) - consumed
        if remaining <= 0:
            continue
        take = min(intended - total_clawed, remaining)
        if take <= 0:
            continue
        entry = CreditLedger(
            client_id=client_id,
            bot_id=bot_id,
            delta=-take,
            reason="refund",
            grant_id=grant.id,
            note=note,
        )
        session.add(entry)
        session.flush()
        total_clawed += take
        last_entry_id = entry.id

    if total_clawed <= 0:
        return (0, None)
    return (total_clawed, last_entry_id)


def reverse_refund_clawback(
    session: Session,
    *,
    client_id: int,
    bot_id: int | None,
    clawback_note: str,
) -> int:
    """Restore credits previously clawed for a refund that later FAILED (N1).

    ``refund.created`` claws credits on initiation so the customer can't spend
    during settlement; if the gateway then *rejects* the refund, those credits
    must come back. This finds the negative ``reason='refund'`` ledger rows this
    refund wrote (matched by their exact ``clawback_note``) and writes a
    mirroring positive row against the SAME ``grant_id``. Restoring the grant's
    remaining balance and keeping :func:`get_balance_breakdown` accurate.

    NOT self-idempotent (finding O4): re-running finds the same original clawback
    rows and writes ANOTHER mirroring positive, double-restoring the credits.
    Idempotency is therefore the CALLER's responsibility, a ``refund_failed:<id>``
    marker in ``processed_webhooks`` must gate this so it runs at most once per
    failed refund. Returns total credits restored.
    """
    _acquire_client_lock(session, client_id, bot_id)
    clawback_rows = (
        session.execute(
            select(CreditLedger).where(
                *_scope_clause(client_id, bot_id),
                CreditLedger.reason == "refund",
                CreditLedger.delta < 0,
                CreditLedger.note == clawback_note,
            )
        )
        .scalars()
        .all()
    )
    restored = 0
    for row in clawback_rows:
        amount = -int(row.delta)
        if amount <= 0:
            continue
        session.add(
            CreditLedger(
                client_id=client_id,
                bot_id=bot_id,
                delta=amount,
                reason="refund",
                grant_id=row.grant_id,
                note=f"Re-grant after failed refund (reverses ledger {row.id})",
            )
        )
        session.flush()
        restored += amount
    return restored
