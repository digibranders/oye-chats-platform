"""Lead scoring and qualification helpers for rubric-based BANT v2."""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime

from app.db.models import Bot, ChatSession, LeadInfo

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
    """Return the effective BANT configuration for a bot."""
    if bot is None or not bot.bant_config:
        return deepcopy(DEFAULT_BANT_CONFIG)
    return _deep_merge(DEFAULT_BANT_CONFIG, bot.bant_config)


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
    """Count how many BANT dimensions have a non-zero rubric score."""
    scores = (
        session.bant_need_score,
        session.bant_budget_score,
        session.bant_authority_score,
        session.bant_timeline_score,
    )
    return sum(1 for score in scores if _score_value(score) > 0)


def apply_display_decay(session: ChatSession, decay_config: dict | None = None) -> dict:
    """
    Apply display-only decay to need and timeline scores.

    Decay is applied in full 30-day periods after `bant_last_updated`. The session
    itself is never mutated; callers receive adjusted values for presentation only.
    """

    effective_decay = _deep_merge(DEFAULT_BANT_CONFIG["decay"], decay_config or {})
    scores = {
        "need_score": _score_value(session.bant_need_score),
        "budget_score": _score_value(session.bant_budget_score),
        "authority_score": _score_value(session.bant_authority_score),
        "timeline_score": _score_value(session.bant_timeline_score),
    }

    if not effective_decay.get("enabled", True) or session.bant_last_updated is None:
        return {**scores, "total": sum(scores.values()), "decayed": False}

    last_updated = session.bant_last_updated
    if last_updated.tzinfo is None:
        last_updated = last_updated.replace(tzinfo=UTC)

    elapsed_seconds = (datetime.now(UTC) - last_updated).total_seconds()
    if elapsed_seconds <= _SECONDS_PER_30_DAYS:
        return {**scores, "total": sum(scores.values()), "decayed": False}

    periods = max(int(elapsed_seconds // _SECONDS_PER_30_DAYS), 0)
    need_decay = periods * int(effective_decay.get("need_decay_per_30d", 0))
    timeline_decay = periods * int(effective_decay.get("timeline_decay_per_30d", 0))

    adjusted_scores = {
        **scores,
        "need_score": max(scores["need_score"] - need_decay, 0),
        "timeline_score": max(scores["timeline_score"] - timeline_decay, 0),
    }

    return {
        **adjusted_scores,
        "total": sum(adjusted_scores.values()),
        "decayed": adjusted_scores != scores,
    }


def build_lead_response(
    session: ChatSession,
    lead_info: LeadInfo | None,
    message_count: int = 0,
    bot: Bot | None = None,
) -> dict:
    """Build a standardized lead payload using decayed display scores."""
    config = get_bant_config(bot)
    adjusted_scores = apply_display_decay(session, decay_config=config.get("decay"))
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

    tier = get_lead_tier(score, thresholds=config.get("thresholds"))
    return {
        "session_id": session.id,
        "score": score,
        "bant_score": bant_score,
        "behavioral_score": behavioral,
        "tier": tier,
        "status": tier,  # backward-compat alias for frontend
        "dimensions_assessed": count_dimensions_assessed(session),
        "bant": {
            "need": {"value": session.bant_need, "score": adjusted_scores["need_score"]},
            "budget": {"value": session.bant_budget, "score": adjusted_scores["budget_score"]},
            "authority": {"value": session.bant_authority, "score": adjusted_scores["authority_score"]},
            "timeline": {"value": session.bant_timeline, "score": adjusted_scores["timeline_score"]},
        },
        "behavioral": {
            "page_url": getattr(session, "page_url", None),
            "referrer": getattr(session, "referrer", None),
            "utm_params": getattr(session, "utm_params", None),
            "visit_count": getattr(session, "visit_count", 1),
        },
        "contact": contact,
        "location": session.location or "Unknown",
        "device": session.device or "Unknown",
        "chats": message_count,
        "created_at": _isoformat_or_none(session.created_at),
        "last_active_at": _isoformat_or_none(session.last_active_at),
    }
