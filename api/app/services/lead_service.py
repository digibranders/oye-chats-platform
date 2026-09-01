"""Lead scoring and qualification helpers for rubric-based BANT v2."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime

from app.core.visitor_privacy import format_visitor_location, redact_visitor_metadata
from app.db.models import Bot, ChatSession, LeadInfo
from app.services.qualification_service import calculate_composite_score, framework_dimension_keys
from app.services.qualification_service import get_framework_config as _get_framework_config

DEFAULT_BANT_CONFIG = {
    "need": {
        "enabled": True,
        "weight": 25,
        "options": [
            {"label": "Just browsing", "score": 5},
            {"label": "Exploring solutions", "score": 10},
            {"label": "Active pain point", "score": 15},
            {"label": "Urgent need", "score": 20},
            {"label": "Critical / blocking", "score": 25},
        ],
        "cta_enabled": True,
        "cta_prompt": "What best describes your situation?",
    },
    "timeline": {
        "enabled": True,
        "weight": 25,
        "options": [
            {"label": "No timeline", "score": 5},
            {"label": "6-12 months", "score": 10},
            {"label": "3-6 months", "score": 15},
            {"label": "1-3 months", "score": 20},
            {"label": "This month", "score": 25},
        ],
        "cta_enabled": True,
        "cta_prompt": "When are you looking to get started?",
    },
    "authority": {
        "enabled": True,
        "weight": 25,
        "options": [
            {"label": "Researching for someone", "score": 5},
            {"label": "Team member / influencer", "score": 10},
            {"label": "Manager / champion", "score": 15},
            {"label": "Decision maker", "score": 20},
            {"label": "Budget owner", "score": 25},
        ],
        "cta_enabled": False,
        "cta_prompt": "What's your role in this decision?",
    },
    "budget": {
        "enabled": True,
        "weight": 25,
        "options": [
            {"label": "No budget yet", "score": 5},
            {"label": "Under $1K/mo", "score": 10},
            {"label": "$1K-5K/mo", "score": 15},
            {"label": "$5K-20K/mo", "score": 20},
            {"label": "$20K+/mo", "score": 25},
        ],
        "cta_enabled": False,
        "cta_prompt": "Do you have a budget range in mind?",
    },
    "thresholds": {"mql": 30, "sal": 55, "sql": 75},
    "conversation_order": ["need", "timeline", "authority", "budget"],
    "decay": {"enabled": True, "timeline_decay_per_30d": 5, "need_decay_per_30d": 3},
}

_DEFAULT_THRESHOLDS = DEFAULT_BANT_CONFIG["thresholds"]
_SECONDS_PER_30_DAYS = 30 * 24 * 60 * 60


def _deep_merge(base: dict, overrides: dict) -> dict:
    """Recursively merge nested dictionaries without mutating inputs."""
    merged = deepcopy(base)
    for key, value in overrides.items():
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            merged[key] = _deep_merge(existing, value)
        else:
            merged[key] = deepcopy(value)
    return merged


def _score_value(value: int | None) -> int:
    """Normalize nullable score fields to non-negative integers."""
    return max(int(value or 0), 0)


def _isoformat_or_none(value: datetime | None) -> str | None:
    """Return an ISO8601 string for datetimes, preserving nulls."""
    return value.isoformat() if value else None


def get_bant_config(bot: Bot | None) -> dict:
    """Return the effective qualification configuration for a bot's ACTIVE framework.

    BR-01: this previously always deep-merged the bot's ``bant_config``
    overrides onto ``DEFAULT_BANT_CONFIG`` (the BANT preset) regardless of
    which framework the bot actually had selected. For a MEDDIC/CHAMP/
    GPCTBA+C&I bot, that silently produced a hybrid config containing both
    the bot's real dimensions AND the four unused, still-"enabled" BANT
    dimensions (need/budget/authority/timeline). Corrupting any weighted
    composite computed from it and, in ``bot_routes._build_public_cta_options``,
    hiding every non-BANT dimension's CTA pill entirely. Delegates to
    ``qualification_service.get_framework_config``, which selects the correct
    preset for the bot's ``framework`` first, then merges overrides onto it.
    """
    return _get_framework_config(bot)


def calculate_lead_score(session: ChatSession) -> int:
    """Return the composite score: BANT + behavioral (capped at 100)."""
    bant = _score_value(session.bant_score)
    behavioral = _score_value(getattr(session, "behavioral_score", 0))
    return min(bant + behavioral, 100)


def get_lead_tier(score: int, thresholds: dict | None = None) -> str:
    """Classify a composite score into unqualified, MQL, SAL, or SQL."""
    effective_thresholds = _deep_merge(_DEFAULT_THRESHOLDS, thresholds or {})
    if score >= int(effective_thresholds["sql"]):
        return "sql"
    if score >= int(effective_thresholds["sal"]):
        return "sal"
    if score >= int(effective_thresholds["mql"]):
        return "mql"
    return "unqualified"


def get_lead_status(score: int, thresholds: dict | None = None) -> str:
    """Backward-compatible alias for tier-based lead classification."""
    return get_lead_tier(score, thresholds=thresholds)


def count_dimensions_assessed(session: ChatSession) -> int:
    """Count how many of the active framework's dimensions have a non-zero score.

    BR-01/BR-05: previously hardcoded to the four legacy BANT columns, which
    are only ever populated when the bot's framework is literally "bant",
    for MEDDIC/CHAMP/GPCTBA+C&I bots this always read 0 regardless of how
    many dimensions were actually assessed. ``dimensions_assessed`` is a
    persisted column already computed framework-agnostically (from
    ``dimension_scores``) at extraction time in
    ``rag_service._background_bant_extraction``. Read it directly instead
    of recomputing from BANT-only columns.
    """
    return _score_value(getattr(session, "dimensions_assessed", 0))


def apply_display_decay(session: ChatSession, framework_config: dict | None = None) -> dict:
    """
    Apply display-only decay to the active framework's dimension scores.

    Decay is applied in full 30-day periods after `bant_last_updated`. The session
    itself is never mutated; callers receive adjusted values for presentation only.

    Returns ``{"dimensions": {dim: decayed_score, ...}, "total": composite,
    "decayed": bool}``. ``total`` is the framework-weighted composite
    (via ``calculate_composite_score``) computed from the *decayed* per-dimension
    scores, not a raw point sum, so it stays consistent with the persisted
    ``ChatSession.bant_score`` for every framework (equal-weight BANT is the
    special case where a raw sum and the weighted composite coincide).

    BR-05: previously hardcoded to decay only the literal ``need_score``/
    ``timeline_score`` columns. Meaningless for any framework whose
    dimensions aren't named "need"/"timeline" (MEDDIC/CHAMP/GPCTBA+C&I all
    share the same two decay-rate keys as BANT despite not having those
    dimensions). Generalized to read ``dimension_scores`` and apply a
    per-dimension decay rate keyed as ``f"{dimension}_decay_per_30d"``,
    a no-op for frameworks/dimensions that don't define one, which matches
    prior (accidental) behavior for those cases while fixing it for BANT.
    """
    config = framework_config or DEFAULT_BANT_CONFIG
    decay_config = config.get("decay") or {}
    effective_decay = _deep_merge(DEFAULT_BANT_CONFIG["decay"], decay_config)
    dimensions = framework_dimension_keys(config) or ["need", "budget", "authority", "timeline"]

    dimension_scores = session.dimension_scores if isinstance(session.dimension_scores, dict) else {}
    raw_scores: dict[str, int] = {}
    for dim in dimensions:
        entry = dimension_scores.get(dim) if isinstance(dimension_scores.get(dim), dict) else {}
        raw_score = entry.get("score")
        if raw_score is None:
            # Back-compat: sessions scored before ``dimension_scores`` existed
            # (or plain BANT sessions where the legacy columns are the source
            # of truth) fall back to the matching legacy column.
            raw_score = getattr(session, f"bant_{dim}_score", 0)
        raw_scores[dim] = _score_value(raw_score)

    decayed_scores = dict(raw_scores)
    decay_active = effective_decay.get("enabled", True) and session.bant_last_updated is not None
    if decay_active:
        last_updated = session.bant_last_updated
        if last_updated.tzinfo is None:
            last_updated = last_updated.replace(tzinfo=UTC)
        elapsed_seconds = (datetime.now(UTC) - last_updated).total_seconds()
        if elapsed_seconds > _SECONDS_PER_30_DAYS:
            periods = max(int(elapsed_seconds // _SECONDS_PER_30_DAYS), 0)
            for dim in dimensions:
                rate = int(effective_decay.get(f"{dim}_decay_per_30d", 0) or 0)
                if rate <= 0:
                    continue
                decayed_scores[dim] = max(raw_scores[dim] - periods * rate, 0)

    composite = calculate_composite_score({dim: {"score": score} for dim, score in decayed_scores.items()}, config)

    return {
        "dimensions": decayed_scores,
        "total": composite,
        "decayed": decayed_scores != raw_scores,
    }


_LEGACY_DIMENSION_TEXT_ATTR = {
    "need": "bant_need",
    "budget": "bant_budget",
    "authority": "bant_authority",
    "timeline": "bant_timeline",
}


def build_lead_response(
    session: ChatSession,
    lead_info: LeadInfo | None,
    message_count: int = 0,
    bot: Bot | None = None,
    *,
    include_attribution: bool = False,
    include_intelligence: bool = True,
    include_visitor_intelligence: bool = False,
) -> dict:
    """Build a standardized lead payload using decayed display scores.

    ``include_attribution`` gates the Lead Source Attribution fields
    (``page_url``, ``referrer``, ``utm_params`` on ``behavioral``, and the
    top-level ``source`` block that pins the lead's UTM + journey snapshot
    from ``lead_info``). Callers pass ``True`` only when the caller's client
    is on a plan that includes the feature, the gate is enforced at the
    route boundary via ``is_lead_source_attribution_enabled``. On lower
    tiers the fields are stripped from the response entirely so a curl
    against the API cannot bypass the frontend paywall.

    ``include_intelligence`` gates the lead-intelligence layer the same
    way (route boundary: ``is_lead_intelligence_enabled``). When False
    (the Free plan) the composite score, tier, per-dimension breakdown,
    and location/device are stripped entirely, leaving the conversation
    surface: identity, contact, chat count, and timestamps.

    ``include_visitor_intelligence`` gates the Professional-only Visitor
    Intelligence layer: the Reoon-validated ``is_valid_email`` / `email_score`
    on ``contact``, and the top-level ``visitor_metadata`` IP-intelligence
    block (company/ASN/VPN-threat signal captured in the background for
    every visitor, regardless of plan. This flag only controls whether it's
    ever returned in the API response). Route boundary:
    ``is_visitor_intelligence_enabled``. Unlike ``include_intelligence``,
    these keys are never present in the base payload and are only added
    when this flag is True. There's nothing to strip on lower tiers
    because the fields don't exist in the payload at all otherwise.

    BR-01: ``config`` reflects the bot's ACTUAL selected framework (via
    the fixed ``get_bant_config``), and the ``bant`` breakdown below
    emits that framework's real dimensions, for a BANT bot this is
    unchanged (need/budget/authority/timeline); for MEDDIC/CHAMP/
    GPCTBA+C&I it surfaces their real dimensions instead of four
    permanently-empty ones.
    """
    config = get_bant_config(bot)
    dimensions = framework_dimension_keys(config) or list(_LEGACY_DIMENSION_TEXT_ATTR)
    adjusted_scores = apply_display_decay(session, framework_config=config)
    bant_score = adjusted_scores["total"]
    behavioral = _score_value(getattr(session, "behavioral_score", 0))
    score = min(bant_score + behavioral, 100)

    contact = None
    if lead_info is not None:
        contact = {
            "name": lead_info.name,
            "email": lead_info.email,
            "phone": lead_info.phone,
            "company": lead_info.company,
        }
        if include_visitor_intelligence:
            contact["is_valid_email"] = lead_info.is_valid_email
            contact["email_score"] = lead_info.email_score
            # The resolved company identity, behind the same plan gate as the
            # rest of visitor intelligence, it is produced by the same paid
            # enrichment. `company` above stays the raw domain on every plan,
            # because it is free and pre-dates this feature.
            contact["company_name"] = lead_info.company_name
            contact["company_description"] = lead_info.company_description
            contact["company_logo_url"] = lead_info.company_logo_url

    tier = get_lead_tier(score, thresholds=config.get("thresholds"))
    lead_viewed_at = getattr(session, "lead_viewed_at", None)

    dimension_scores = session.dimension_scores if isinstance(session.dimension_scores, dict) else {}
    bant_breakdown = {}
    for dim in dimensions:
        entry = dimension_scores.get(dim) if isinstance(dimension_scores.get(dim), dict) else {}
        value = entry.get("value")
        if value is None and dim in _LEGACY_DIMENSION_TEXT_ATTR:
            value = getattr(session, _LEGACY_DIMENSION_TEXT_ATTR[dim], None)
        bant_breakdown[dim] = {"value": value, "score": adjusted_scores["dimensions"].get(dim, 0)}

    # Behavioral block. Engagement score is always exposed; page_url /
    # referrer / utm_params live behind ``include_attribution`` so lower
    # tiers can still see the engagement bar without leaking source data.
    behavioral_block: dict = {
        "visit_count": getattr(session, "visit_count", 1),
    }
    if include_attribution:
        behavioral_block["page_url"] = getattr(session, "page_url", None)
        behavioral_block["referrer"] = getattr(session, "referrer", None)
        behavioral_block["utm_params"] = getattr(session, "utm_params", None)

    payload: dict = {
        "session_id": session.id,
        # Which chatbot produced this lead. Leads, Inbox and Journey show every
        # chatbot's data together, so without this a row is unattributable in
        # any account that has more than one -- you can neither filter to a
        # chatbot nor tell, looking at the row, where it came from.
        #
        # The id comes off the SESSION, which is the record of what actually
        # happened; a mismatched `bot` argument is a caller bug and must not
        # silently relabel a lead. The name is denormalised alongside it rather
        # than left for the dashboard to join, because a lead whose chatbot has
        # since been deleted would otherwise render blank for a conversation
        # that really did occur.
        "bot_id": getattr(session, "bot_id", None),
        "bot_name": (getattr(bot, "name", None) or None) if bot is not None else None,
        "score": score,
        "bant_score": bant_score,
        "behavioral_score": behavioral,
        "tier": tier,
        "status": tier,  # backward-compat alias for frontend
        "dimensions_assessed": count_dimensions_assessed(session),
        "bant": bant_breakdown,
        "behavioral": behavioral_block,
        "contact": contact,
        # Redacted here, at the serialisation boundary, rather than left to the
        # dashboard: this payload is the leads list AND the lead drawer, so the
        # unredacted form would otherwise reach every browser devtools network
        # tab and every curl against the API. The frontend's ``formatLocation``
        # is idempotent, so its own pass over this value is a no-op.
        "location": format_visitor_location(session.location),
        "device": session.device or "Unknown",
        "chats": message_count,
        "created_at": _isoformat_or_none(session.created_at),
        "last_active_at": _isoformat_or_none(session.last_active_at),
        "unread": lead_viewed_at is None,
        "lead_viewed_at": _isoformat_or_none(lead_viewed_at),
    }

    if include_visitor_intelligence:
        # The plan gate decides whether the customer sees the enrichment at all;
        # it does not entitle them to the visitor's raw IP, which rides along
        # inside the blob as ``ip_intel.resolved_for_ip``. Our own dedup marker.
        payload["visitor_metadata"] = redact_visitor_metadata(getattr(session, "visitor_metadata", None))

    if not include_intelligence:
        # Free plan: the conversation surface only. Deleting (not nulling)
        # keeps the wire contract honest. Absent means "not on your plan",
        # and a curl can't recover what was never serialized.
        for key in (
            "score",
            "bant_score",
            "behavioral_score",
            "tier",
            "status",
            "dimensions_assessed",
            "bant",
            "location",
            "device",
        ):
            payload.pop(key, None)

    if include_attribution:
        # Prefer the durable snapshot on lead_info (survives session pruning);
        # fall back to the live session copy so leads captured before the
        # feature shipped still light up on the Leads page.
        source_utm = None
        source_journey = None
        if lead_info is not None:
            source_utm = getattr(lead_info, "utm_params", None)
            source_journey = getattr(lead_info, "visitor_journey", None)
        if source_utm is None:
            source_utm = getattr(session, "utm_params", None)
        if source_journey is None:
            source_journey = getattr(session, "visitor_journey", None)
        payload["source"] = {
            "utm_params": source_utm,
            "referrer": getattr(session, "referrer", None),
            "landing_page": getattr(session, "page_url", None),
            "journey": source_journey,
        }

    return payload
