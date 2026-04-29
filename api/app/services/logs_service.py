"""Server log reader for the super-admin Logs page.

Wraps ``journalctl`` so super-admins can inspect the API and worker journals
from the dashboard instead of SSH-ing into the droplet.

Design notes
------------
* **Service allowlist** — the only accepted service names are
  ``oyechats-api`` and ``oyechats-worker``. Any other value is rejected
  with ``ValueError`` before we hand a string to ``journalctl``. This is
  the only user-controlled input that flows into a subprocess argument
  list, but allowlisting keeps shell-injection unreachable regardless.
* **Hard timeout** — ``journalctl`` is invoked with a 10-second cap so a
  missing binary or stuck I/O can't hang the API worker.
* **Local fallback** — when journalctl isn't available (laptop dev),
  returns a small synthetic snippet so the UI still renders.
* **Pure function output** — returns a list of dicts with parsed
  timestamp / level / message; the UI does the colouring.

The endpoint that calls into here is gated by ``get_superadmin``, so the
journal access is implicitly tied to the operator's audited identity.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

ALLOWED_SERVICES = {"oyechats-api", "oyechats-worker"}

_LEVEL_PATTERNS = [
    (re.compile(r"\b(CRITICAL|FATAL)\b"), "critical"),
    (re.compile(r"\bERROR\b|\bException\b|\bTraceback\b"), "error"),
    (re.compile(r"\bWARN(ING)?\b"), "warning"),
    (re.compile(r"\bINFO\b"), "info"),
    (re.compile(r"\bDEBUG\b"), "debug"),
]


def _classify(message: str) -> str:
    for pattern, level in _LEVEL_PATTERNS:
        if pattern.search(message):
            return level
    return "info"


def _parse_journalctl_json(line: str) -> dict[str, Any] | None:
    """Convert one ``journalctl --output=json`` line into our row shape."""
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        return None

    # journald gives microseconds since epoch as a string in __REALTIME_TIMESTAMP.
    ts_us = rec.get("__REALTIME_TIMESTAMP")
    when: str | None = None
    if ts_us:
        try:
            seconds = int(ts_us) / 1_000_000
            when = datetime.fromtimestamp(seconds, tz=UTC).isoformat()
        except (TypeError, ValueError):
            when = None

    message = rec.get("MESSAGE")
    if isinstance(message, list):
        # Binary log lines come back as a list of byte values; ignore those.
        return None
    if not isinstance(message, str):
        return None

    return {
        "timestamp": when,
        "level": _classify(message),
        "message": message,
        "unit": rec.get("_SYSTEMD_UNIT") or rec.get("UNIT") or rec.get("SYSLOG_IDENTIFIER"),
        "pid": rec.get("_PID"),
    }


def _local_dev_fallback(service: str) -> list[dict[str, Any]]:
    """Synthetic snippet when journalctl isn't installed (typical dev laptop)."""
    now = datetime.now(UTC).isoformat()
    return [
        {
            "timestamp": now,
            "level": "info",
            "message": (
                f"journalctl unavailable on this host — showing a placeholder. "
                f"On the droplet this would tail `journalctl -u {service}.service`."
            ),
            "unit": f"{service}.service",
            "pid": None,
        }
    ]


def fetch_logs(
    service: str,
    *,
    lines: int = 500,
    level: str | None = None,
    grep: str | None = None,
) -> dict[str, Any]:
    """Return a dict ``{available, service, entries}`` for the UI.

    ``available`` is False on dev hosts that lack journalctl; the UI shows the
    synthetic fallback in that case.
    """
    if service not in ALLOWED_SERVICES:
        raise ValueError(f"unknown service '{service}'. Allowed: {sorted(ALLOWED_SERVICES)}")

    lines = max(10, min(lines, 5_000))
    journalctl = shutil.which("journalctl")
    if not journalctl:
        return {
            "available": False,
            "service": service,
            "entries": _local_dev_fallback(service),
        }

    cmd = [
        journalctl,
        "-u",
        f"{service}.service",
        "-n",
        str(lines),
        "--no-pager",
        "--output=json",
    ]
    try:
        proc = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        logger.warning("journalctl timed out for service=%s", service)
        return {
            "available": True,
            "service": service,
            "entries": [],
            "error": "journalctl timed out",
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("journalctl failed for service=%s", service)
        return {
            "available": True,
            "service": service,
            "entries": [],
            "error": f"{type(exc).__name__}: {exc}",
        }

    if proc.returncode != 0:
        # Most common cause on dev: user lacks read permission. We still
        # surface stderr to the UI so the operator can act on it.
        return {
            "available": True,
            "service": service,
            "entries": [],
            "error": (proc.stderr or "").strip()[:500] or f"journalctl exited {proc.returncode}",
        }

    rows: list[dict[str, Any]] = []
    for raw in proc.stdout.splitlines():
        parsed = _parse_journalctl_json(raw)
        if parsed is None:
            continue
        if level and parsed["level"] != level:
            continue
        if grep and grep.lower() not in parsed["message"].lower():
            continue
        rows.append(parsed)

    return {"available": True, "service": service, "entries": rows}
