"""Read-only Langfuse client for the super-admin observability dashboard.

Uses Langfuse's public REST API (basic auth = public_key:secret_key) rather
than the SDK so we never load tracing/observability code in this path. The
endpoints we hit are read-only and inexpensive.

The full SDK is intentionally avoided because Langfuse's OpenTelemetry
callback caused APIConnectionError under memory pressure on the prod droplet
(see CLAUDE.md). Calling the REST API directly sidesteps that entirely.

Returns plain dicts. All errors are caught and surfaced as ``{"error": "..."}``
so the UI can render a friendly fallback rather than blowing up.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from app.config import LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _is_configured() -> bool:
    return bool(LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY and LANGFUSE_HOST)


def _client() -> httpx.Client | None:
    if not _is_configured():
        return None
    return httpx.Client(
        base_url=LANGFUSE_HOST,
        auth=(LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY),
        timeout=_TIMEOUT,
        headers={"User-Agent": "oyechats-superadmin/1.0"},
    )


def fetch_summary(days: int = 7, trace_limit: int = 25) -> dict[str, Any]:
    """Aggregated observability snapshot used by the /observability page.

    Returns a dict with: ``configured``, ``host``, ``daily_metrics``,
    ``recent_traces``, ``scores``, optionally ``error``.
    """
    if not _is_configured():
        return {
            "configured": False,
            "host": LANGFUSE_HOST,
            "daily_metrics": [],
            "recent_traces": [],
            "scores": [],
            "error": "Langfuse credentials not configured.",
        }

    from_dt = (datetime.now(UTC) - timedelta(days=days)).isoformat()
    out: dict[str, Any] = {
        "configured": True,
        "host": LANGFUSE_HOST,
        "daily_metrics": [],
        "recent_traces": [],
        "scores": [],
    }

    client = _client()
    if client is None:
        out["error"] = "Failed to initialise Langfuse client."
        return out

    try:
        with client:
            # Daily aggregated cost / count metrics. The endpoint shape is
            # documented at https://api.reference.langfuse.com.
            try:
                r = client.get(
                    "/api/public/metrics/daily",
                    params={"fromTimestamp": from_dt, "limit": days},
                )
                if r.status_code == 200:
                    data = r.json()
                    out["daily_metrics"] = data.get("data") if isinstance(data, dict) else data
            except Exception as exc:  # noqa: BLE001
                logger.warning("Langfuse daily metrics failed: %s", exc)

            # Recent traces — most useful for "what just ran" debugging.
            try:
                r = client.get(
                    "/api/public/traces",
                    params={"limit": trace_limit, "fromTimestamp": from_dt},
                )
                if r.status_code == 200:
                    data = r.json()
                    out["recent_traces"] = data.get("data") if isinstance(data, dict) else data
            except Exception as exc:  # noqa: BLE001
                logger.warning("Langfuse traces failed: %s", exc)

            # Scores: relevance gate, evals, user feedback.
            try:
                r = client.get(
                    "/api/public/scores",
                    params={"limit": 50, "fromTimestamp": from_dt},
                )
                if r.status_code == 200:
                    data = r.json()
                    out["scores"] = data.get("data") if isinstance(data, dict) else data
            except Exception as exc:  # noqa: BLE001
                logger.warning("Langfuse scores failed: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Langfuse summary fetch failed")
        out["error"] = str(exc)

    return out
