"""IP-based company and threat-signal lookup via ipapi.is.

Always-on, best-effort signal — see
docs/superpowers/plans/2026-08-08-visitor-intelligence.md for why this
can never resolve the real employer behind an ISP-routed IP.
"""

import json
import logging
import os
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

IPAPI_IS_URL = "https://api.ipapi.is/"


def fetch_ip_intel(ip_address: str) -> dict | None:
    """Fetch company/ASN/threat data for an IP. Returns None on any failure."""
    api_key = os.getenv("IPAPI_IS_KEY", "")
    if not api_key:
        return None

    query = urllib.parse.urlencode({"q": ip_address, "key": api_key})
    url = f"{IPAPI_IS_URL}?{query}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "OyeChats/1.0"})
        with urllib.request.urlopen(req, timeout=3.0) as response:
            data = json.loads(response.read().decode())
    except Exception as exc:
        logger.warning(f"ipapi.is lookup failed for {ip_address}: {exc}")
        return None

    if "error" in data:
        logger.warning(f"ipapi.is returned error for {ip_address}: {data.get('error')}")
        return None

    return {
        "company": data.get("company"),
        "asn": data.get("asn"),
        "is_vpn": data.get("is_vpn", False),
        "is_proxy": data.get("is_proxy", False),
        "is_tor": data.get("is_tor", False),
        "is_datacenter": data.get("is_datacenter", False),
        "is_abuser": data.get("is_abuser", False),
    }
