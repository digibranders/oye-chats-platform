"""Plan entitlements — the single source of truth for "what can this client do?"

This service answers every gate question across the platform:
* Does this client have ``live_chat``? → ``has_feature(client_id, "live_chat")``
* Has this client hit their bot limit? → ``within_limit(client_id, "bots", current_count)``
* What's their plan slug for the UI? → ``get_entitlements(client_id).plan_slug``

Both the backend FastAPI dependencies (``require_feature`` / ``enforce_limit``
in ``app/api/auth.py``) and the frontend ``/me/entitlements`` endpoint read
from this module. Behavior cannot diverge between them.

## Resolution order

1. Look up the client's active subscription (``plan_service.get_client_subscription``).
2. If none, fall back to the **Free plan** (slug ``free``) — every client
   gets Free's limits by default; this also covers the auth path during
   trial transitions when the subscription row may briefly be absent.
3. Merge the plan's ``limits`` and ``features`` JSONB into a typed dataclass.
4. Layer current-period usage from the credit ledger so callers can render
   "X / Y" UI without a second query.

## Caching

Result is cached in Redis 60s per ``client_id``. The TTL is short because:
* Plan / subscription transitions are infrequent (users don't upgrade per
  request) but real-time enforcement matters when they happen.
* Usage numbers shift continuously; 60s is the lag a customer will tolerate
  in their "credits used" widget.

Cache is invalidated explicitly on:
* Subscription create/upgrade/downgrade (``invalidate(client_id)``)
* Credit grant/deduction (called from ``credit_service`` writers)
* Manual super-admin override

## Failure modes

Every method degrades gracefully:
* Redis down → cache miss → DB query → no harm (just slower).
* Plan row missing → fall back to Free limits (most restrictive — safe default).
* Subscription row missing → fall back to Free.
* DB query fails → return Free with a logged warning (better to lock down
  than to grant unlimited).
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.cache import PREFIX, get_redis
from app.db.models import Client, Plan
from app.services.plan_service import get_client_subscription

logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────────

CACHE_TTL_SECONDS = 60

# Sentinel meaning "no limit" / "unlimited" — used as the JSONB value for
# Enterprise tier and as the return value for "this limit doesn't apply".
UNLIMITED = -1

# Fallback Free-plan limits/features used when no plan row can be resolved
# (e.g. the four canonical plans were deleted by a misconfigured super
# admin). Matches the seeded Free plan exactly.
_FREE_FALLBACK_LIMITS: dict[str, Any] = {
    "credits": 250,
    "bots": 1,
    # ``max_bots_cap`` mirrors the canonical free-plan ceiling: Free users
    # can never exceed the included quota — there are no purchasable bot
    # add-ons on this tier. Paid plans set this higher in their JSONB.
    "max_bots_cap": 1,
    "operators": 0,
    # Leads dashboard is feature-locked on Free (sidebar gate); the
    # numeric quota is therefore set to UNLIMITED so lead storage from
    # chat conversations + offline messages continues to work for the
    # Insights view the customer DOES have access to.
    "leads": -1,
    "page_scraping": 30,
    "documents": 5,
    "chat_history_days": 7,
}

_FREE_FALLBACK_FEATURES: dict[str, Any] = {
    "live_chat": False,
    "bant": False,
    "branding_removable": False,
    "webhooks": False,
    "api_access": False,
    "online_support": False,
    "topup_allowed": False,
    "integrations": "reply_to_only",
}


# ── Data types ─────────────────────────────────────────────────────────────


@dataclass
class PlanEntitlements:
    """Resolved entitlements for a single client. Returned by ``get_entitlements``."""

    client_id: int
    plan_slug: str  # "free" | "starter" | "standard" | "enterprise" | custom slug
    plan_name: str
    # Subscription status: "active" | "trialing" | "past_due" | "canceled" |
    # "expired" | "none" (no subscription row). Drives the dashboard banner.
    subscription_status: str
    limits: dict[str, Any] = field(default_factory=dict)
    features: dict[str, Any] = field(default_factory=dict)
    # Current-period usage. Populated when ``include_usage=True`` is passed to
    # ``get_entitlements``. Empty otherwise to avoid the extra query on hot
    # paths that only need limit/feature checks.
    usage: dict[str, int] = field(default_factory=dict)
    # Paid bot-seat add-ons the client has purchased on top of their plan's
    # included quota. Always populated (defaults to 0) so callers don't have
    # to special-case absent data.
    extra_bot_seats: int = 0
    # Region-aware bot-seat pricing surfaced from PricingConfig. Empty dict
    # when add-ons aren't purchasable (Free / Enterprise) — the UI hides
    # the "buy a seat" CTA in that case.
    bot_seat_pricing: dict[str, Any] = field(default_factory=dict)

    def to_json_dict(self) -> dict[str, Any]:
        """Plain dict for JSON serialization to the frontend."""
        return asdict(self)

    # ── Convenience helpers — used by FastAPI dependencies + frontend hook ──

    def has_feature(self, feature_name: str) -> bool:
        """True if the named feature is enabled for this client.

        Unknown features default to ``False`` — safer to lock down than to
        accidentally expose a paid feature because of a typo. Pair with the
        ``require_feature`` dependency for canonical enforcement.
        """
        value = self.features.get(feature_name)
        if isinstance(value, bool):
            return value
        # String features like ``integrations`` ("all" / "reply_to_only")
        # have their own gating logic; the generic ``has_feature`` returns
        # True when ANY value is present so callers handle the value
        # themselves. This keeps the dependency API simple.
        return value is not None and value != "" and value is not False

    def limit_for(self, limit_name: str) -> int:
        """Return the configured limit. ``UNLIMITED`` (-1) means no cap.

        For ``bots`` this returns the **effective** limit, which is the
        plan's included quota plus any paid add-on seats, capped at the
        plan's hard ceiling. Every other limit returns its raw JSONB
        value. This keeps callers ``within_limit("bots", n)`` agnostic to
        the existence of add-ons.
        """
        if limit_name == "bots":
            return self._effective_bot_limit()
        raw = self.limits.get(limit_name)
        if raw is None:
            return 0  # Conservative: unknown limit = nothing allowed
        try:
            return int(raw)
        except (TypeError, ValueError):
            return 0

    def _effective_bot_limit(self) -> int:
        """Effective bot limit = included + paid add-ons, capped at hard ceiling.

        Special cases:
        * If either the included quota or the hard cap is ``UNLIMITED``,
          the effective limit is ``UNLIMITED`` — Enterprise stays
          unbounded regardless of seat purchases.
        * If ``max_bots_cap`` is missing from the plan JSONB (a plan row
          older than the bot-seat-addon migration), we fall back to the
          included quota — adding add-ons on a plan with no declared
          ceiling is a no-op rather than an unbounded grant.
        """
        included = self.limits.get("bots")
        cap = self.limits.get("max_bots_cap")
        try:
            included_int = int(included) if included is not None else 0
        except (TypeError, ValueError):
            included_int = 0
        if included_int == UNLIMITED:
            return UNLIMITED
        if cap is None:
            return included_int  # Plan predates the cap concept.
        try:
            cap_int = int(cap)
        except (TypeError, ValueError):
            return included_int
        if cap_int == UNLIMITED:
            return UNLIMITED
        return min(included_int + max(0, self.extra_bot_seats), cap_int)

    def within_limit(self, limit_name: str, current_value: int) -> bool:
        """True if ``current_value`` is below the configured limit.

        Returns True for ``UNLIMITED`` regardless of current value. Returns
        False if the limit is unknown — same defensive default as
        ``has_feature``.
        """
        limit = self.limit_for(limit_name)
        if limit == UNLIMITED:
            return True
        return current_value < limit

    def remaining(self, limit_name: str, current_value: int) -> int:
        """How many of this resource the client can still create/use.

        Returns a very large number for ``UNLIMITED`` so callers can use
        ``min(remaining(...), batch_size)`` without special-casing.
        """
        limit = self.limit_for(limit_name)
        if limit == UNLIMITED:
            return 10**9
        return max(0, limit - current_value)

    def can_purchase_bot_seat(self) -> bool:
        """True if the client may buy another bot seat.

        Three independent guards: there must be a price configured, the
        plan must have a hard cap that isn't already exhausted by
        ``bots + extra_bot_seats``, and the included quota must not be
        already unlimited (Enterprise needs no add-ons).
        """
        if not self.bot_seat_pricing:
            return False
        included = self.limits.get("bots")
        cap = self.limits.get("max_bots_cap")
        if included == UNLIMITED or cap == UNLIMITED:
            return False
        try:
            included_int = int(included) if included is not None else 0
            cap_int = int(cap) if cap is not None else 0
        except (TypeError, ValueError):
            return False
        return (included_int + max(0, self.extra_bot_seats)) < cap_int


# ── Cache helpers ──────────────────────────────────────────────────────────


def _cache_key(client_id: int, *, with_usage: bool) -> str:
    """Separate cache slots for usage-enriched and bare results.

    Usage numbers change far more often than limit/feature flags, so we
    don't want a usage-poll to invalidate the bare entitlement cache hot
    paths read on every request.
    """
    suffix = "full" if with_usage else "bare"
    return f"{PREFIX}entitlements:{client_id}:{suffix}"


def invalidate(client_id: int) -> None:
    """Drop both cache slots for this client.

    Call this on any input change: subscription create/upgrade/downgrade,
    plan row edit, manual super-admin override, or credit ledger writes
    when the usage panel needs to reflect them immediately.
    """
    client = get_redis()
    if client is None:
        return
    try:
        client.delete(_cache_key(client_id, with_usage=True))
        client.delete(_cache_key(client_id, with_usage=False))
    except Exception:
        logger.debug("entitlements cache invalidate failed", exc_info=True)


def _read_cache(client_id: int, *, with_usage: bool) -> PlanEntitlements | None:
    client = get_redis()
    if client is None:
        return None
    try:
        raw = client.get(_cache_key(client_id, with_usage=with_usage))
        if raw is None:
            return None
        data = json.loads(raw)
        return PlanEntitlements(**data)
    except Exception:
        logger.debug("entitlements cache read failed for client=%s", client_id, exc_info=True)
        return None


def _write_cache(entitlements: PlanEntitlements, *, with_usage: bool) -> None:
    client = get_redis()
    if client is None:
        return
    try:
        client.setex(
            _cache_key(entitlements.client_id, with_usage=with_usage),
            CACHE_TTL_SECONDS,
            json.dumps(entitlements.to_json_dict()),
        )
    except Exception:
        logger.debug("entitlements cache write failed for client=%s", entitlements.client_id, exc_info=True)


# ── Main resolver ──────────────────────────────────────────────────────────


def get_entitlements(
    client_id: int,
    db_session: Session,
    *,
    include_usage: bool = False,
    use_cache: bool = True,
) -> PlanEntitlements:
    """Resolve the active entitlements for a client.

    Hot path: 1 Redis call on cache hit (~1 ms). On miss, 2 DB queries
    (subscription join + plan row). With ``include_usage=True`` an extra
    credit ledger sum runs to populate the usage dict — pass False on
    feature/limit-check hot paths so the gate cost stays minimal.
    """
    if use_cache:
        cached = _read_cache(client_id, with_usage=include_usage)
        if cached is not None:
            return cached

    result = _compute(client_id, db_session, include_usage=include_usage)
    _write_cache(result, with_usage=include_usage)
    return result


def _compute(client_id: int, db_session: Session, *, include_usage: bool) -> PlanEntitlements:
    """Build the entitlements dataclass from primary sources. Internal."""
    # 1. Look up the subscription. ``get_client_subscription`` returns the
    # most-recent non-canceled subscription, which is exactly what
    # entitlements gating cares about.
    subscription = None
    try:
        subscription = get_client_subscription(db_session, client_id)
    except Exception:
        logger.warning(
            "entitlements: failed to load subscription for client=%s — defaulting to Free",
            client_id,
            exc_info=True,
        )

    # 2. Identify the plan. Subscription is the primary source; falls back
    # to the seeded Free plan row, and finally to the hardcoded constants
    # at module scope if even that row is missing.
    plan: Plan | None = None
    if subscription is not None:
        plan = db_session.get(Plan, subscription.plan_id)

    if plan is None:
        plan = db_session.execute(select(Plan).where(Plan.slug == "free")).scalar_one_or_none()

    # Bot-seat add-on inputs — always loaded, even on the catastrophic
    # fallback path. We read from Client lazily; a missing column or a
    # client row that vanished mid-request both degrade to 0 add-ons,
    # which is the safe default (no extra capacity granted).
    extra_seats = _load_extra_bot_seats(client_id, db_session)
    bot_pricing = _load_bot_seat_pricing(db_session)

    if plan is None:
        # Catastrophic: even the Free plan row is gone. Use the hardcoded
        # fallback so the application doesn't crash and the client still
        # gets the most-restrictive default.
        logger.error(
            "entitlements: no Free plan row found — using hardcoded fallback for client=%s",
            client_id,
        )
        result = PlanEntitlements(
            client_id=client_id,
            plan_slug="free",
            plan_name="Free",
            subscription_status="none",
            limits=dict(_FREE_FALLBACK_LIMITS),
            features=dict(_FREE_FALLBACK_FEATURES),
            extra_bot_seats=extra_seats,
            bot_seat_pricing=bot_pricing,
        )
        if include_usage:
            result.usage = _build_usage(client_id, db_session, result.limits)
        return result

    sub_status = subscription.status if subscription is not None else "none"

    limits = dict(plan.limits or {})
    features = dict(plan.features or {})

    result = PlanEntitlements(
        client_id=client_id,
        plan_slug=plan.slug,
        plan_name=plan.name,
        subscription_status=sub_status,
        limits=limits,
        features=features,
        extra_bot_seats=extra_seats,
        bot_seat_pricing=bot_pricing,
    )

    if include_usage:
        result.usage = _build_usage(client_id, db_session, limits)

    return result


# ── Bot-seat add-on helpers ────────────────────────────────────────────────


def _load_extra_bot_seats(client_id: int, db_session: Session) -> int:
    """Read ``clients.extra_bot_seats`` defensively. Missing row → 0."""
    try:
        client = db_session.get(Client, client_id)
        if client is None:
            return 0
        return int(getattr(client, "extra_bot_seats", 0) or 0)
    except Exception:
        logger.debug(
            "entitlements: extra_bot_seats load failed for client=%s",
            client_id,
            exc_info=True,
        )
        return 0


def _load_bot_seat_pricing(db_session: Session) -> dict[str, Any]:
    """Surface the bot-seat price knobs from PricingConfig.

    Returns ``{"usd_cents": int, "inr_paise": int}`` when both are set.
    Returns an empty dict if either is missing — the entitlements helper
    ``can_purchase_bot_seat`` treats that as "add-ons disabled" so the
    upgrade modal won't show the purchase CTA in a misconfigured env.
    """
    try:
        from app.services.credit_service import get_pricing

        pricing = get_pricing(db_session)
        usd = pricing.get("bot_seat_price_usd_cents")
        inr = pricing.get("bot_seat_price_inr_paise")
        if usd is None or inr is None:
            return {}
        return {
            "usd_cents": int(usd),
            "inr_paise": int(inr),
        }
    except Exception:
        logger.debug("entitlements: bot seat pricing load failed", exc_info=True)
        return {}


# ── Usage population ───────────────────────────────────────────────────────


def _build_usage(client_id: int, db_session: Session, limits: dict[str, Any]) -> dict[str, int]:
    """Populate current-period usage numbers for the limit keys we care about.

    Kept defensive: every counter falls back to 0 on query failure so the
    UI never crashes because of a missing index or a temporary DB hiccup.

    Counters returned:
    * ``bots``           — active bot rows owned by this client
    * ``operators``      — active operator rows
    * ``documents``      — distinct document_names ingested
    * ``page_scraping``  — pages crawled this billing period
    * ``leads``          — lead_info rows created this period
    """
    from sqlalchemy import distinct, func

    from app.db.models import Bot, Document, LeadInfo, Operator

    usage: dict[str, int] = {
        "bots": 0,
        "operators": 0,
        "documents": 0,
        "leads": 0,
        # ``page_scraping`` and ``credits`` are derived from the credit
        # ledger and require a separate query — left to callers that need
        # them so we don't slow every entitlements lookup.
    }

    try:
        usage["bots"] = int(
            db_session.execute(
                select(func.count(Bot.id)).where(
                    Bot.client_id == client_id,
                    Bot.is_active.is_(True),
                )
            ).scalar_one()
            or 0
        )
    except Exception:
        logger.debug("entitlements: bot usage query failed", exc_info=True)

    try:
        usage["operators"] = int(
            db_session.execute(
                select(func.count(Operator.id)).where(
                    Operator.client_id == client_id,
                    Operator.is_active.is_(True),
                )
            ).scalar_one()
            or 0
        )
    except Exception:
        logger.debug("entitlements: operator usage query failed", exc_info=True)

    try:
        # ``documents`` is the *uploaded file* count — not the total of
        # every Document row, which would also include crawled web pages
        # (one row per page). Crawled pages live in the same table with
        # ``document_name`` set to the URL by ``pipeline._ingest_url`` at
        # line 374; uploaded files set it to the filename at line 154.
        # Filtering by ``NOT LIKE 'http%'`` separates the two without a
        # schema change. Crawl volume is governed by its own
        # ``page_scraping`` limit (tracked via the credit ledger), so the
        # split here is purely about what the customer sees in the
        # Sources → Documents counter.
        usage["documents"] = int(
            db_session.execute(
                select(func.count(distinct(Document.document_name))).where(
                    Document.client_id == client_id,
                    ~Document.document_name.like("http%"),
                )
            ).scalar_one()
            or 0
        )
    except Exception:
        logger.debug("entitlements: document usage query failed", exc_info=True)

    try:
        usage["leads"] = int(
            db_session.execute(
                select(func.count(LeadInfo.id)).join(Bot, LeadInfo.bot_id == Bot.id).where(Bot.client_id == client_id)
            ).scalar_one()
            or 0
        )
    except Exception:
        logger.debug("entitlements: leads usage query failed", exc_info=True)

    _ = limits  # Reserved for future per-limit normalization
    return usage
