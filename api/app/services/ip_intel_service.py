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

    # ipapi.is nests ``company`` and ``asn`` as OBJECTS, not strings:
    #   "company": {"name": "Google LLC", "domain": "google.com", "type": "hosting", ...}
    #   "asn":     {"asn": 15169, "org": "Google LLC", "descr": "GOOGLE - ...", ...}
    # Flatten them here, at the boundary, so no consumer has to know the
    # vendor's payload shape. Returning the raw nested dicts previously made
    # the Leads UI render "no company signal" on every lead, because it read
    # these keys as plain strings. Residential IPs omit ``company`` entirely,
    # so both lookups must tolerate a missing/None object.
    company = data.get("company") or {}
    asn = data.get("asn") or {}
    if not isinstance(company, dict):
        company = {}
    if not isinstance(asn, dict):
        asn = {}

    return {
        "company_name": company.get("name"),
        "company_domain": company.get("domain"),
        # "business" | "hosting" | "isp" | "education" | "government" —
        # drives whether the company name means "the visitor's employer"
        # or just "the ISP that routed them".
        "company_type": company.get("type"),
        "asn": asn.get("asn"),
        "asn_org": asn.get("org") or asn.get("descr"),
        "is_vpn": bool(data.get("is_vpn", False)),
        "is_proxy": bool(data.get("is_proxy", False)),
        "is_tor": bool(data.get("is_tor", False)),
        "is_datacenter": bool(data.get("is_datacenter", False)),
        "is_abuser": bool(data.get("is_abuser", False)),
    }
