"""Behavioral scoring — scores visitor engagement signals from the widget."""

from __future__ import annotations

import logging

from app.db.models import Bot
from app.services.lead_service import get_bant_config

logger = logging.getLogger(__name__)

# Default behavioral scoring weights (overridable via bant_config.behavioral_config)
_DEFAULT_BEHAVIORAL_CONFIG = {
    "enabled": True,
    "max_score": 20,
    "return_visit_score": 5,
    "utm_present_score": 3,
    "time_on_site_threshold": 60,
    "time_on_site_score": 3,
    "pages_viewed_threshold": 3,
    "pages_viewed_score": 4,
    "known_referrer_score": 5,
    "known_referrers": [
        "google.com",
        "linkedin.com",
        "facebook.com",
        "twitter.com",
        "x.com",
        "bing.com",
        "youtube.com",
        "github.com",
        "producthunt.com",
        "g2.com",
        "capterra.com",
    ],
}


def get_behavioral_config(bot: Bot | None) -> dict:
    """Return the effective behavioral scoring config for a bot."""
    config = get_bant_config(bot)
    bot_behavioral = config.get("behavioral_config") or {}
    merged = {**_DEFAULT_BEHAVIORAL_CONFIG, **bot_behavioral}
    return merged


def _normalize_referrer(referrer: str | None) -> str:
    """Extract domain from a referrer URL for matching."""
    if not referrer:
        return ""
    referrer = referrer.lower().strip()
    # Strip protocol
    for prefix in ("https://", "http://", "//"):
        if referrer.startswith(prefix):
            referrer = referrer[len(prefix) :]
            break
    # Strip www.
    if referrer.startswith("www."):
        referrer = referrer[4:]
    # Extract domain (before first /)
    return referrer.split("/")[0]


def score_behavioral_signals(
    signals: dict,
    bot: Bot | None = None,
) -> int:
    """Score behavioral signals from the widget.

    Args:
        signals: Dict with keys: is_return_visit, utm_params, time_on_page,
                 pages_viewed, referrer
        bot: Optional bot for per-bot config overrides

    Returns:
        Behavioral score (0 to max_score, default 20)
    """
    config = get_behavioral_config(bot)
    if not config.get("enabled", True):
        return 0

    score = 0
    max_score = config.get("max_score", 20)

    # Return visit signal
    if signals.get("is_return_visit"):
        score += config.get("return_visit_score", 5)

    # UTM parameters present (indicates paid/tracked traffic)
    utm = signals.get("utm_params")
    if utm and isinstance(utm, dict) and any(utm.values()):
        score += config.get("utm_present_score", 3)

    # Time on site (seconds)
    time_on_page = signals.get("time_on_page", 0)
    threshold = config.get("time_on_site_threshold", config.get("time_on_site_threshold_seconds", 60))
    if isinstance(time_on_page, (int, float)) and time_on_page >= threshold:
        score += config.get("time_on_site_score", 3)

    # Pages viewed
    pages_viewed = signals.get("pages_viewed", 0)
    pages_threshold = config.get("pages_viewed_threshold", 3)
    if isinstance(pages_viewed, int) and pages_viewed >= pages_threshold:
        score += config.get("pages_viewed_score", 4)

    # Known referrer
    referrer = signals.get("referrer", "")
    if referrer:
        domain = _normalize_referrer(referrer)
        known_referrers = config.get("known_referrers", [])
        if any(known in domain for known in known_referrers):
            score += config.get("known_referrer_score", 5)

    return min(score, max_score)
