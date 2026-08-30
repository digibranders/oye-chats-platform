"""Plan entitlements, the single source of truth for "what can this client do?"

This service answers every gate question across the platform:
* Does this client have ``live_chat``? → ``has_feature(client_id, "live_chat")``
* What's their plan slug for the UI? → ``get_entitlements(client_id).plan_slug``
* Can they add another bot? → ``can_client_add_new_bot(client_id)``

Both the backend FastAPI dependencies (``require_feature`` / ``enforce_limit``
in ``app/api/auth.py``) and the frontend ``/me/entitlements`` endpoint read
from this module. Behavior cannot diverge between them.

## Per-bot billing model (migration f8b2c4d6e1a3)

The plan now attaches to the **Bot**, not the Client. A single client can
hold many active subscriptions, one per paid bot, each with its own
credit allowance. Account-level entitlements still resolve via this
module. Features (live_chat, BANT, webhooks) remain per-account because
they describe the **dashboard** the customer logs into, not any single
bot. Limits that *do* vary per bot (credit allowance, future per-bot
flags) should resolve through :func:`get_bot_entitlements` instead.

Two helpers govern bot creation:

* :func:`can_client_add_new_bot`. Gate for ``POST /bots``. A client may
  create their first bot for free; subsequent bots require an active
  paid subscription somewhere in the account so the checkout step has a
  funded counterpart.
* Legacy-pooled bots (``bot.is_legacy_pooled = true``) are
  grandfathered: their credit deductions still drain the client-level
  ledger, so they don't enter the per-bot gating logic at all.

## Resolution order

1. Look up the client's active subscription (``plan_service.get_client_subscription``).
2. If none, fall back to the **Free plan** (slug ``free``). Every client
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
* Plan row missing → fall back to Free limits (most restrictive. Safe default).
* Subscription row missing → fall back to Free.
* DB query fails → return Free with a logged warning (better to lock down
  than to grant unlimited).
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.cache import PREFIX, get_redis
from app.db.models import Bot, Client, Plan
from app.services.plan_service import (
    get_account_subscription,
    get_client_subscription,
    get_subscription_for_bot,
)

logger = logging.getLogger(__name__)


# ── Constants ──────────────────────────────────────────────────────────────

CACHE_TTL_SECONDS = 60

# Sentinel meaning "no limit" / "unlimited". Used as the JSONB value for
# unlimited plan limits and as the return value for "this limit doesn't apply".
UNLIMITED = -1

# Fallback Free-plan limits/features used when no plan row can be resolved
# (e.g. the four canonical plans were deleted by a misconfigured super
# admin). Matches the seeded Free plan exactly.
_FREE_FALLBACK_LIMITS: dict[str, Any] = {
    "credits": 200,
    "bots": 1,
    "operators": 0,
    # Leads dashboard is feature-locked on Free (sidebar gate); the
    # numeric quota is therefore set to UNLIMITED so lead storage from
    # chat conversations + offline messages continues to work for the
    # Insights view the customer DOES have access to.
    "leads": -1,
    "page_scraping": 20,
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
    "auto_recrawl": False,
    "integrations": "reply_to_only",
}


# ── Data types ─────────────────────────────────────────────────────────────


@dataclass
class PlanEntitlements:
    """Resolved entitlements for a single client. Returned by ``get_entitlements``."""

    client_id: int
    plan_slug: str  # "free" | "starter" | "standard" | "professional" | "enterprise" | custom slug
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

    def to_json_dict(self) -> dict[str, Any]:
        """Plain dict for JSON serialization to the frontend."""
        return asdict(self)

    # ── Convenience helpers. Used by FastAPI dependencies + frontend hook ──

    def has_feature(self, feature_name: str) -> bool:
        """True if the named feature is enabled for this client.

        Unknown features default to ``False``, safer to lock down than to
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

        Every limit returns its raw JSONB value. ``bots`` is the plan's
        included quota and is meaningful only for legacy / single-bot
        accounting; new "can I add another bot?" checks live in
        :func:`can_client_add_new_bot`, which understands the per-bot
        billing model.
        """
        raw = self.limits.get(limit_name)
        if raw is None:
            return 0  # Conservative: unknown limit = nothing allowed
        try:
            return int(raw)
        except (TypeError, ValueError):
            return 0

    def within_limit(self, limit_name: str, current_value: int) -> bool:
        """True if ``current_value`` is below the configured limit.

        Returns True for ``UNLIMITED`` regardless of current value. Returns
        False if the limit is unknown, same defensive default as
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


# ── Cache helpers ──────────────────────────────────────────────────────────


def _cache_key(client_id: int, *, with_usage: bool) -> str:
    """Separate cache slots for usage-enriched and bare results.

    Usage numbers change far more often than limit/feature flags, so we
    don't want a usage-poll to invalidate the bare entitlement cache hot
    paths read on every request.
    """
    suffix = "full" if with_usage else "bare"
    return f"{PREFIX}entitlements:{client_id}:{suffix}"


def _bot_cache_key(bot_id: int, *, with_usage: bool) -> str:
    """Per-bot entitlement cache slot, namespaced apart from the account slots."""
    suffix = "full" if with_usage else "bare"
    return f"{PREFIX}entitlements:bot:{bot_id}:{suffix}"


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
    credit ledger sum runs to populate the usage dict. Pass False on
    feature/limit-check hot paths so the gate cost stays minimal.
    """
    if use_cache:
        cached = _read_cache(client_id, with_usage=include_usage)
        if cached is not None:
            return cached

    result = _compute(client_id, db_session, include_usage=include_usage)
    _write_cache(result, with_usage=include_usage)
    return result


def get_bot_entitlements(
    bot_id: int,
    db_session: Session,
    *,
    include_usage: bool = False,
    use_cache: bool = True,
) -> PlanEntitlements:
    """Resolve entitlements for a SINGLE bot from that bot's own subscription.

    Unlike :func:`get_entitlements` (account view, highest-priced sub across all
    bots), this follows the subscription funding ``bot_id``. Falling back to the
    account-level subscription when the bot has none. Use it for gates whose
    behaviour is inherently per-bot (a bot's widget, its RAG qualification, its
    outbound webhooks), so a bot downgraded to Starter loses its features even
    while a sibling bot stays on a higher tier.

    Fails closed: an unknown bot resolves to the Free fallback rather than
    inheriting anything, matching the deny-by-default policy of this module.
    """
    client_id = db_session.execute(select(Bot.client_id).where(Bot.id == bot_id)).scalar_one_or_none()
    if client_id is None:
        # Unknown/deleted bot, never inherit features. Recompute a Free result
        # off a client_id of 0 (no subscription rows → Free fallback in _compute).
        return _compute(0, db_session, include_usage=include_usage, bot_id=None)

    if use_cache:
        redis = get_redis()
        if redis is not None:
            try:
                raw = redis.get(_bot_cache_key(bot_id, with_usage=include_usage))
                if raw is not None:
                    return PlanEntitlements(**json.loads(raw))
            except Exception:
                logger.debug("bot entitlements cache read failed for bot=%s", bot_id, exc_info=True)

    result = _compute(client_id, db_session, include_usage=include_usage, bot_id=bot_id)

    if use_cache:
        redis = get_redis()
        if redis is not None:
            try:
                redis.setex(
                    _bot_cache_key(bot_id, with_usage=include_usage),
                    CACHE_TTL_SECONDS,
                    json.dumps(result.to_json_dict()),
                )
            except Exception:
                logger.debug("bot entitlements cache write failed for bot=%s", bot_id, exc_info=True)
    return result


def invalidate_bot(bot_id: int) -> None:
    """Drop both per-bot cache slots. Call on a bot's plan change / seat change."""
    redis = get_redis()
    if redis is None:
        return
    try:
        redis.delete(_bot_cache_key(bot_id, with_usage=True))
        redis.delete(_bot_cache_key(bot_id, with_usage=False))
    except Exception:
        logger.debug("bot entitlements cache invalidate failed for bot=%s", bot_id, exc_info=True)


# ── Lead source attribution gate ──────────────────────────────────────────
#
# Lead Source Attribution (UTM + visitor journey persisted on LeadInfo,
# surfaced on the Leads page + CSV export) is a paid-tier deliverable.
# The gate lives here so backend routes and the frontend entitlement
# response agree on the rule without duplicating the slug list.
#
# Rule: "Standard", "Professional" and "Enterprise" plans expose full
# attribution. Everyone else (Free / Starter / custom slugs) sees leads
# without the source badge and journey timeline. The Leads UI renders an
# upsell tile in the same slot so the feature is discoverable without
# leaking data.
LEAD_SOURCE_ATTRIBUTION_SLUGS: frozenset[str] = frozenset({"trial", "standard", "professional", "enterprise"})


def is_lead_source_attribution_enabled(client_id: int, db_session: Session) -> bool:
    """True iff this client's active plan includes lead source attribution.

    Uses the same cached ``get_entitlements`` path as every other gate so
    a fresh subscription upgrade takes effect within the 60s TTL. Falls
    back to ``False`` on any resolver error, the defensive default,
    matching the "lock everything down on failure" policy elsewhere in
    this module.
    """
    try:
        entitlements = get_entitlements(client_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "lead_source_attribution: entitlements lookup failed for client=%s. Denying",
            client_id,
            exc_info=True,
        )
        return False
    return entitlements.plan_slug in LEAD_SOURCE_ATTRIBUTION_SLUGS


def is_lead_source_attribution_enabled_for_bot(bot_id: int, db_session: Session) -> bool:
    """True iff the plan funding THIS bot includes lead source attribution.

    Per-bot companion to :func:`is_lead_source_attribution_enabled`. Leads are
    captured per bot, so attribution snapshotting at capture should follow that
    bot's own subscription (account fallback), a bot on Starter shouldn't get
    durable attribution just because a sibling bot is on Standard/Professional.
    Denies on any resolver error.
    """
    try:
        entitlements = get_bot_entitlements(bot_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "lead_source_attribution: entitlements lookup failed for bot=%s. Denying",
            bot_id,
            exc_info=True,
        )
        return False
    return entitlements.plan_slug in LEAD_SOURCE_ATTRIBUTION_SLUGS


# Journey Analytics, the Journeys view under Analytics (top pages, paths
# that convert, post-chat destinations). Widget always collects the raw
# journey data regardless of plan (an upgrade should surface immediate
# history); this gate controls only whether the READ endpoints under
# /analytics/journeys/* return data. Same paid-tier set as lead source
# attribution.
JOURNEY_ANALYTICS_SLUGS: frozenset[str] = frozenset({"trial", "standard", "professional", "enterprise"})


def is_journey_analytics_enabled(client_id: int, db_session: Session) -> bool:
    """True iff this client's active plan includes the Journeys analytics view.

    Read-side gate for /analytics/journeys/*. Widget-side collection is
    unconditional. Denies on any resolver error.
    """
    try:
        entitlements = get_entitlements(client_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "journey_analytics: entitlements lookup failed for client=%s. Denying",
            client_id,
            exc_info=True,
        )
        return False
    return entitlements.plan_slug in JOURNEY_ANALYTICS_SLUGS


def is_journey_analytics_enabled_for_bot(bot_id: int, db_session: Session) -> bool:
    """True iff the plan funding THIS bot includes the Journeys analytics view.

    Per-bot companion to :func:`is_journey_analytics_enabled`. The Journeys
    view is scoped per-bot, so gating follows the bot's own subscription
    (account fallback). Mirrors the lead source attribution model.
    """
    try:
        entitlements = get_bot_entitlements(bot_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "journey_analytics: entitlements lookup failed for bot=%s. Denying",
            bot_id,
            exc_info=True,
        )
        return False
    return entitlements.plan_slug in JOURNEY_ANALYTICS_SLUGS


def is_leads_dashboard_enabled(client_id: int, db_session: Session) -> bool:
    """True iff this client can open the Leads dashboard at all.

    Every plan (Free included) reaches the dashboard: Free gets the
    conversation view (contact + transcript), while the lead-intelligence
    layer (score, tier, BANT breakdown, location/device, CSV export) is a
    paid capability gated separately by ``is_lead_intelligence_enabled``.
    Per-plan lead quotas are enforced via the ``limits.leads`` counter,
    not this gate.

    Deny-by-default on entitlements lookup failure, same policy as every
    other gate in this module.
    """
    try:
        get_entitlements(client_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "leads_dashboard_gate: entitlements lookup failed for client=%s. Denying",
            client_id,
            exc_info=True,
        )
        return False
    return True


def is_lead_intelligence_enabled(client_id: int, db_session: Session) -> bool:
    """True iff this client's active plan includes lead intelligence.

    Lead intelligence is everything beyond the raw conversation: composite
    score, qualification tier, per-dimension BANT/framework breakdown and
    signal evidence, visitor location/device, and the CSV export. Free sees
    the leads list and transcripts only; every paid tier (Starter /
    Standard / Professional, plus any custom slug that isn't ``"free"``)
    gets the full layer. The ``/leads`` routes strip these fields from the
    response for Free, so a curl against the API cannot bypass the
    frontend's locked cells.

    Deny-by-default on entitlements lookup failure, same policy as every
    other gate in this module.
    """
    try:
        entitlements = get_entitlements(client_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "lead_intelligence_gate: entitlements lookup failed for client=%s. Denying",
            client_id,
            exc_info=True,
        )
        return False
    return entitlements.plan_slug != "free"


# ── Visitor intelligence gate ────────────────────────────────────────────────
#
# Visitor Intelligence is the IP-based company/threat signal
# (``ChatSession.visitor_metadata``), the Reoon-validated email display
# (``LeadInfo.is_valid_email`` / ``email_score``), and the manual "Send
# Follow-up" action, the top-tier slice, narrower than the general
# lead-intelligence layer (score/tier/BANT), which is Starter+. Standard
# and below are excluded; Enterprise is listed because it is Professional
# plus unlimited agents/seats, so every Professional feature carries over.
# Kept as its own frozenset (rather than reusing ``plan_slug != "free"``)
# so a future plan tier change to lead intelligence can't silently loosen
# this boundary too.
VISITOR_INTELLIGENCE_SLUGS: frozenset[str] = frozenset({"trial", "professional", "enterprise"})

# The slugs `seed_plans.py` creates. Anything else is a BESPOKE plan a
# super-admin provisioned for an individual deal, the seed script's own
# docstring says unknown slugs are left untouched precisely because they exist.
#
# NOTE: "enterprise" is a SEEDED ladder tier, not a bespoke deal. Bespoke
# slugs for individual contracts are distinct strings (e.g. "enterprise-acme")
# and still take rule 2 in :func:`_paid_tier_includes`.
# Every slug ``seed_plans._PLANS`` writes, the non-public ``trial`` row
# included. Membership is what tells :func:`_paid_tier_includes` a slug is a
# SEEDED tier whose entitlements are decided by the ladders above, rather than
# a bespoke per-contract row that gets every paid feature by default. Leaving
# the trial out would hand it the bespoke rule and grant it capabilities no
# ladder names, silently and without anyone choosing it.
_SEEDED_PLAN_SLUGS: frozenset[str] = frozenset({"free", "trial", "starter", "standard", "professional", "enterprise"})


def _paid_tier_includes(slug: str, ladder_slugs: frozenset[str]) -> bool:
    """Does this plan include a feature granted to ``ladder_slugs``?

    Two rules, and the second exists because narrowing these gates to a bare
    allow-list silently removed a paid feature from enterprise customers.

    1. A slug on the standard ladder gets exactly what the ladder says.
    2. A slug OFF the ladder is bespoke (an enterprise deal at a negotiated
       price) and gets the feature. The comment guarding this was deleted
       when the gate narrowed to ``{"standard", "professional"}``; it said "a
       custom paid slug provisioned for an enterprise deal is a paid plan and
       must not silently lose the feature."

    The failure modes are not symmetric, which is what decides rule 2. Wrongly
    granting costs one vendor call on a tier that should not have had it.
    Wrongly denying leaves a customer on a bespoke contract without a feature
    they pay for AND. Because ``LeadInfo.is_valid_email`` stays NULL. Tripping
    the 409 soft gate on every manual follow-up, with no setting anywhere that
    would re-enable it.

    A newly SEEDED tier is not covered by rule 2: adding it to
    ``_SEEDED_PLAN_SLUGS`` is part of adding the tier, which forces a
    deliberate choice per feature rather than a silent grant. The seeded
    ``enterprise`` tier made that choice explicitly, it is named in every
    ladder above, because it is Professional plus unlimited agents/seats and
    must not lose a feature by moving onto the ladder. Rule 2 still covers
    the per-contract slugs (``enterprise-acme`` and friends).
    """
    if slug in ladder_slugs:
        return True
    return slug not in _SEEDED_PLAN_SLUGS


def is_visitor_intelligence_enabled(client_id: int, db_session: Session) -> bool:
    """True iff ANY of this client's subscriptions includes Visitor Intelligence.

    Account-level view. Resolves to the HIGHEST-priced plan across every bot
    the client owns. Use this ONLY for account-wide questions ("should the
    workspace see this feature exist at all?"). For anything scoped to a
    specific bot's data (which is every ``/leads`` response, since leads
    belong to a bot) use :func:`is_visitor_intelligence_enabled_for_bot`
    instead, or a Free bot's leads inherit a sibling bot's paid plan.

    Denies on any resolver error, same deny-by-default policy as every other
    gate in this module.
    """
    try:
        entitlements = get_entitlements(client_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "visitor_intelligence_gate: entitlements lookup failed for client=%s. Denying",
            client_id,
            exc_info=True,
        )
        return False
    return _paid_tier_includes(entitlements.plan_slug, VISITOR_INTELLIGENCE_SLUGS)


def is_visitor_intelligence_enabled_for_bot(bot_id: int, db_session: Session) -> bool:
    """True iff the plan funding THIS bot includes Visitor Intelligence.

    The correct gate for every lead-scoped surface. Billing attaches to the
    Bot, not the Client, so a workspace can hold one Professional bot and one
    Free bot at the same time. Gating those leads on the account-level
    resolver would surface paid company/email-validity data (and enable the
    manual follow-up send) on the FREE bot's leads too, because that resolver
    deliberately returns the highest-priced subscription in the account.

    Mirrors :func:`is_lead_source_attribution_enabled_for_bot`. Denies on any
    resolver error.
    """
    try:
        entitlements = get_bot_entitlements(bot_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "visitor_intelligence_gate: entitlements lookup failed for bot=%s. Denying",
            bot_id,
            exc_info=True,
        )
        return False
    return _paid_tier_includes(entitlements.plan_slug, VISITOR_INTELLIGENCE_SLUGS)


# ── Email verification gate (Standard + Professional + Enterprise) ──────────
#
# Reoon email verification powers both the widget's real-time blur check
# (``POST /chat/validate-email``) and the background lead-enrichment check that
# persists ``LeadInfo.is_valid_email`` / ``email_score``. It is a metered,
# credit-costing feature (``credit_cost.email_verification``), so it is scoped
# to the Standard, Professional and Enterprise tiers. Free and Starter are
# excluded and skip the Reoon call entirely (rather than paying for a check
# they can't act on). A slug allow-list (not "not free") keeps this boundary
# explicit so a future Starter change can't silently switch the paid feature on.
EMAIL_VERIFICATION_SLUGS: frozenset[str] = frozenset({"trial", "standard", "professional", "enterprise"})


def is_email_validation_enabled_for_bot(bot_id: int, db_session: Session) -> bool:
    """True iff the plan funding THIS bot includes email verification.

    Bot-scoped (mirrors :func:`is_lead_source_attribution_enabled_for_bot`)
    because the gated call sites (``POST /chat/validate-email`` and the
    background lead-enrichment Reoon check) are both authenticated via
    ``X-Bot-Key``, not a client session. Restricted to the Standard,
    Professional and Enterprise tiers (see :data:`EMAIL_VERIFICATION_SLUGS`).
    Denies on any resolver error.
    """
    try:
        entitlements = get_bot_entitlements(bot_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "email_validation_gate: entitlements lookup failed for bot=%s. Denying",
            bot_id,
            exc_info=True,
        )
        return False
    return _paid_tier_includes(entitlements.plan_slug, EMAIL_VERIFICATION_SLUGS)


def get_chat_history_retention_days(client_id: int, db_session: Session) -> int:
    """Days of chat history the client's active plan lets them see.

    Returns the value straight from ``limits.chat_history_days`` on the
    active plan. ``UNLIMITED`` (``-1``) means "no retention cap", the
    admin dashboard shows every conversation ever recorded. Any positive
    integer caps the visible window: a Free customer with a 7-day plan
    limit sees only chats from the last 7 days, regardless of how far
    back their stored history goes.

    Failure policy is deliberately GENEROUS here (unlike other gates):
    a resolver hiccup falls back to ``UNLIMITED`` so the customer's
    dashboard never mysteriously empties itself on a transient cache
    miss. The real deny-by-default gates are the ones that grant paid
    features; showing older-than-cap chat history is a privacy leak we
    can live with for the milliseconds a stale cache might last.
    """
    try:
        entitlements = get_entitlements(client_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "chat_history_retention: entitlements lookup failed for client=%s. Defaulting to unlimited",
            client_id,
            exc_info=True,
        )
        return UNLIMITED
    value = entitlements.limits.get("chat_history_days", UNLIMITED)
    try:
        return int(value)
    except (TypeError, ValueError):
        logger.warning(
            "chat_history_retention: non-integer limit for client=%s: %r. Defaulting to unlimited",
            client_id,
            value,
        )
        return UNLIMITED


def is_bant_enabled_for_plan(client_id: int, db_session: Session) -> bool:
    """True iff this client's active plan exposes BANT qualification.

    Chat hot-path gate: the rag pipeline reads this before running BANT
    extraction, offering team-connect cards, or shipping the qualification
    system prompt. When a customer downgrades from a BANT-enabled tier
    (Standard / Professional) to one without it (Free / Starter), this flips
    to False on the next entitlements cache cycle (≤60s) and every new
    chat runs without qualification. Historical BANT signals stay visible
    in Insights. This gate only stops NEW scoring.

    Falls back to False on any resolver error to match the deny-by-default
    policy used elsewhere in this module: a broken cache read must never
    silently grant a paid feature.
    """
    try:
        entitlements = get_entitlements(client_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "bant_plan_gate: entitlements lookup failed for client=%s. Denying",
            client_id,
            exc_info=True,
        )
        return False
    return bool(entitlements.features.get("bant", False))


def is_bant_enabled_for_bot(bot_id: int, db_session: Session) -> bool:
    """True iff the plan funding THIS bot exposes BANT qualification.

    Per-bot companion to :func:`is_bant_enabled_for_plan`. The rag pipeline runs
    per bot, so it should gate on that bot's own subscription. Otherwise a bot
    downgraded to Starter keeps running BANT extraction whenever a sibling bot is
    still on a BANT tier (the account-level resolver returns the highest tier).
    Falls back to False on any resolver error (deny-by-default).
    """
    try:
        entitlements = get_bot_entitlements(bot_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "bant_bot_gate: entitlements lookup failed for bot=%s. Denying",
            bot_id,
            exc_info=True,
        )
        return False
    return bool(entitlements.features.get("bant", False))


def is_live_chat_enabled_for_bot(bot_id: int, db_session: Session) -> bool:
    """True iff the plan funding THIS bot includes the live-chat feature.

    Per-bot companion mirroring :func:`is_bant_enabled_for_bot`. Returns only the
    PLAN half of the gate. Callers AND it with the bot's own
    ``live_chat_enabled`` toggle to get the effective "is the human-handoff /
    offline-message path available" answer, so the plan check and the operator
    toggle stay independently inspectable.

    The RAG pipeline, the visitor handoff endpoint, and the offline-message
    endpoint all gate on this so a Free-plan bot (whose plan excludes live chat)
    never offers a human escape hatch — matching the widget-config resolution in
    ``bot_routes.get_bot_settings_public``. Falls back to False on any resolver
    error (deny-by-default).
    """
    try:
        entitlements = get_bot_entitlements(bot_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "live_chat_bot_gate: entitlements lookup failed for bot=%s. Denying",
            bot_id,
            exc_info=True,
        )
        return False
    return bool(entitlements.has_feature("live_chat"))


def _compute(
    client_id: int, db_session: Session, *, include_usage: bool, bot_id: int | None = None
) -> PlanEntitlements:
    """Build the entitlements dataclass from primary sources. Internal.

    ``bot_id`` selects the subscription source. When ``None`` (account view),
    entitlements follow ``get_client_subscription``, the HIGHEST-priced active
    subscription across all the client's bots (remediation H2, so a cheap second
    bot never downgrades the account UI). When a ``bot_id`` is given (per-bot
    gate), they follow THAT bot's own subscription, falling back to the
    account-level subscription when the bot has none, so a bot on Starter no
    longer inherits a sibling bot's Professional features.
    """
    # 1. Look up the subscription. ``get_client_subscription`` returns the
    # most-recent non-canceled subscription, which is exactly what
    # entitlements gating cares about.
    subscription = None
    try:
        if bot_id is not None:
            subscription = get_subscription_for_bot(db_session, client_id, bot_id) or get_account_subscription(
                db_session, client_id
            )
        else:
            subscription = get_client_subscription(db_session, client_id)
    except Exception:
        logger.warning(
            "entitlements: failed to load subscription for client=%s bot=%s. Defaulting to Free",
            client_id,
            bot_id,
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

    if plan is None:
        # Catastrophic: even the Free plan row is gone. Use the hardcoded
        # fallback so the application doesn't crash and the client still
        # gets the most-restrictive default.
        logger.error(
            "entitlements: no Free plan row found. Using hardcoded fallback for client=%s",
            client_id,
        )
        result = PlanEntitlements(
            client_id=client_id,
            plan_slug="free",
            plan_name="Free",
            subscription_status="none",
            limits=dict(_FREE_FALLBACK_LIMITS),
            features=dict(_FREE_FALLBACK_FEATURES),
        )
        if include_usage:
            result.usage = _build_usage(client_id, db_session, result.limits)
        return result

    sub_status = subscription.status if subscription is not None else "none"

    limits = dict(plan.limits or {})
    features = dict(plan.features or {})

    # ``limits["operators"]`` is the hard CEILING an account can never
    # exceed even with paid extra seats, it is NOT how many operators the
    # client is currently entitled to create for free. That entitlement is
    # whichever is higher: the plan's included seats (always free) or the
    # seat count they've explicitly paid for via POST /subscription/seats
    # (``subscription.operator_quantity``). Capped at the ceiling. Without
    # this adjustment, `operator_routes.py`'s create-operator gate reads
    # ``limits["operators"]`` directly and would let anyone add operators
    # up to the ceiling for free, since it never looks at what was paid for.
    operator_ceiling = limits.get("operators")
    if isinstance(operator_ceiling, int) and operator_ceiling > 0:
        included_seats = int(plan.included_operator_seats or 0)
        paid_seats = (
            int(subscription.operator_quantity)
            if subscription is not None and subscription.operator_quantity is not None
            else 0
        )
        entitled_seats = max(included_seats, paid_seats)
        limits["operators"] = min(operator_ceiling, entitled_seats)

    # Crawl page/depth caps ride in `plan.limits` already (enforced in
    # `document_routes.py`), but were never exposed here, so the console had
    # no way to tell a customer their cap before a crawl was rejected for
    # hitting it. Read-only pass-through — no adjustment needed, unlike
    # `operators`/`bots`, because there is no purchasable add-on for either.
    limits["max_crawl_pages"] = (plan.limits or {}).get("max_crawl_pages", UNLIMITED)
    limits["max_crawl_depth"] = (plan.limits or {}).get("max_crawl_depth", UNLIMITED)

    # `bots` is the plan's included count; `Client.extra_bot_seats` is what
    # was purchased on top of it (POST /subscription/bot-seats, mirroring how
    # `operators` above adds `subscription.operator_quantity`). Unlimited
    # (`UNLIMITED`) stays unlimited regardless of what was purchased — there
    # is nothing to add extra seats on top of.
    bots_limit = limits.get("bots")
    if isinstance(bots_limit, int) and bots_limit != UNLIMITED:
        client_row = db_session.get(Client, client_id)
        extra_seats = int(getattr(client_row, "extra_bot_seats", 0) or 0) if client_row is not None else 0
        limits["bots"] = bots_limit + extra_seats
    # ``branding_removable`` is an ADD-ON, never a plan inclusion. No tier
    # grants it (every seeded plan carries ``false``, and migration
    # j4e5f6a7b8c9 revoked the historical Standard/Professional/Enterprise
    # grant), so the plan JSONB is overwritten unconditionally here rather
    # than merged. A hand-edited plan row that sets the flag true must not be
    # able to hand out a feature nobody paid the add-on price for.
    #
    # Two conditions, both required:
    #   * an authorized add-on mandate (``branding_addon_active``, set only by
    #     the add-on's ``activated`` webhook), and
    #   * a paid plan. The add-on is sold on top of a paid subscription, so a
    #     lapsed customer who fell back to Free loses it even if a stale
    #     mandate flag survived the downgrade.
    #
    # ``getattr`` rather than attribute access: the flag is absent on the
    # lightweight subscription stand-ins some call sites and tests synthesise,
    # and the missing-attribute default must be the same as the missing-add-on
    # one. Deny.
    features["branding_removable"] = bool(
        subscription is not None and getattr(subscription, "branding_addon_active", False) and plan.slug != "free"
    )

    result = PlanEntitlements(
        client_id=client_id,
        plan_slug=plan.slug,
        plan_name=plan.name,
        subscription_status=sub_status,
        limits=limits,
        features=features,
    )

    if include_usage:
        result.usage = _build_usage(client_id, db_session, limits)

    return result


# ── Per-bot creation gate ──────────────────────────────────────────────────


@dataclass
class AddBotDecision:
    """Outcome of :func:`can_client_add_new_bot`.

    The frontend opens an "Add Bot" paywall modal when ``allowed`` is
    ``False`` and ``must_subscribe`` is ``True``. Other failure reasons
    map to plain error toasts.
    """

    allowed: bool
    reason: str  # machine-readable: "ok" | "upgrade_required"
    must_subscribe: bool  # True iff the user can resolve this by subscribing
    active_bot_count: int

    def to_json(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "reason": self.reason,
            "must_subscribe": self.must_subscribe,
            "active_bot_count": self.active_bot_count,
        }


def can_client_add_new_bot(client_id: int, db_session: Session) -> AddBotDecision:
    """Decide whether ``POST /bots`` should accept another bot for this client.

    Per-bot billing rule: **every bot needs its own subscription** (the
    Free tier funds the first bot for free; every bot beyond that needs
    a fresh paid subscription). So:

    1. 0 active bots → allowed (becomes the Free bot, or the first paid
       bot for an account that's about to subscribe).
    2. ≥1 active bot → blocked with ``must_subscribe=True``. The
       dashboard pops the upgrade modal so the customer can mint another
       subscription. Holding a paid subscription does **not** grant a
       free second bot. Each bot's subscription funds exactly one bot.

    This rule applies uniformly across all plans. Legacy pooled accounts
    that hold unlimited bots under one master subscription are handled
    outside this gate (super-admin sets ``is_legacy_pooled=true`` on each
    such bot at provisioning time so they share the master subscription's
    credits).
    """
    active_bots = int(
        db_session.execute(
            select(func.count(Bot.id)).where(
                Bot.client_id == client_id,
                Bot.is_active.is_(True),
            )
        ).scalar_one()
        or 0
    )
    if active_bots == 0:
        return AddBotDecision(
            allowed=True,
            reason="ok",
            must_subscribe=False,
            active_bot_count=0,
        )

    return AddBotDecision(
        allowed=False,
        reason="upgrade_required",
        must_subscribe=True,
        active_bot_count=active_bots,
    )


def plan_grants_unlimited_bots(plan: Plan) -> bool:
    """Is this plan's included agent quota the :data:`UNLIMITED` (-1) sentinel?

    Such a plan is an ACCOUNT product: its whole promise is one pooled credit
    balance shared across every agent. It must therefore never be attached to a
    **bot-scoped** subscription, which routes the plan's credits into that one
    bot's isolated ledger (``credit_service.resolve_bot_ledger_bot_id``) and
    leaves every further agent it entitles draining the unfunded shared pool.

    Every door onto a bot-scoped subscription gates on this predicate, which is
    why it lives here rather than in any one route module. They split into three
    responses, by whether a subscription already exists to protect:

    * REFUSE, the mutation would land the plan on an EXISTING bot-scoped row:
      ``POST /bots/checkout`` (per-agent by contract),
      ``POST /subscriptions/change-plan`` Branches 1/2a/2b,
      ``POST /subscriptions/resume`` Mode 2,
      ``PUT /superadmin/subscriptions/{id}`` (manual plan override), and
      ``transition_service.promote_scheduled_change`` (the downgrade cutover
      cron, which copies ``sub.bot_id`` onto its grace row).
    * DEMOTE to ``bot_id=None``, no subscription exists yet, so an
      account-scoped mandate is simply what the customer is buying:
      ``POST /subscriptions/change-plan`` Branch 3.
    * SINK. ``razorpay_service._handle_subscription_activated`` refuses the
      INSERT whichever door the mandate came through, including one authorised
      before the route guards shipped.

    Keyed off ``limits.bots`` rather than a slug so every future unlimited-agent
    plan is covered the moment it is seeded.

    Conservative on bad data: a missing, non-numeric, or otherwise unreadable
    quota is NOT unlimited, so a hand-provisioned plan row can still be bought
    per-bot exactly as before. Only the explicit sentinel trips the guard.
    """
    limits = plan.limits if isinstance(plan.limits, dict) else {}
    try:
        return int(limits.get("bots")) == UNLIMITED
    except (TypeError, ValueError):
        return False


# ── Usage population ───────────────────────────────────────────────────────


def _build_usage(client_id: int, db_session: Session, limits: dict[str, Any]) -> dict[str, int]:
    """Populate current-period usage numbers for the limit keys we care about.

    Kept defensive: every counter falls back to 0 on query failure so the
    UI never crashes because of a missing index or a temporary DB hiccup.

    Counters returned:
    * ``bots``           (active bot rows owned by this client
    * ``operators``) active operator rows
    * ``documents``      (distinct document_names ingested
    * ``page_scraping``) pages crawled this billing period
    * ``leads``         . Lead_info rows created this period
    """
    from sqlalchemy import distinct

    from app.db.models import Document, LeadInfo, Operator

    usage: dict[str, int] = {
        "bots": 0,
        "operators": 0,
        "documents": 0,
        "leads": 0,
        # KB char counter is a single-row read off ``clients``. Cheap enough
        # to include on every entitlements lookup so the UI can render a
        # "words used / limit" progress bar without a second round trip.
        "knowledge_characters": 0,
        # ``page_scraping`` and ``credits`` are derived from the credit
        # ledger and require a separate query. Left to callers that need
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
        # ``documents`` is the *uploaded file* count, not the total of every
        # Document row (which also includes one row per crawled web page).
        # Uploads vs crawls are now distinguished by the explicit ``source``
        # column (M7) instead of sniffing ``document_name LIKE 'http%'``, so a
        # file literally named ``https-notes.pdf`` is counted correctly. Crawl
        # volume is governed by its own ``page_scraping`` credit limit.
        usage["documents"] = int(
            db_session.execute(
                select(func.count(distinct(Document.document_name))).where(
                    Document.client_id == client_id,
                    Document.source == "upload",
                )
            ).scalar_one()
            or 0
        )
    except Exception:
        logger.debug("entitlements: document usage query failed", exc_info=True)

    try:
        # ``leads`` is scoped to the CURRENT billing period (M6). Counting all
        # leads ever would permanently over-report on any finite-leads plan.
        from app.db.models import Subscription

        period_start = db_session.execute(
            select(Subscription.current_period_start)
            .where(
                Subscription.client_id == client_id,
                Subscription.status.in_(("active", "trialing", "past_due")),
                Subscription.current_period_start.is_not(None),
            )
            .order_by(Subscription.current_period_start.desc())
            .limit(1)
        ).scalar_one_or_none()
        if period_start is None:
            now = datetime.now(UTC)
            period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

        usage["leads"] = int(
            db_session.execute(
                select(func.count(LeadInfo.id))
                .join(Bot, LeadInfo.bot_id == Bot.id)
                .where(Bot.client_id == client_id, LeadInfo.created_at >= period_start)
            ).scalar_one()
            or 0
        )
    except Exception:
        logger.debug("entitlements: leads usage query failed", exc_info=True)

    try:
        from app.db.models import Client

        usage["knowledge_characters"] = int(
            db_session.execute(select(Client.kb_characters_used).where(Client.id == client_id)).scalar_one() or 0
        )
    except Exception:
        logger.debug("entitlements: kb_characters usage query failed", exc_info=True)

    _ = limits  # Reserved for future per-limit normalization
    return usage
