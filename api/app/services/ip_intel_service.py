"""IP-based company and threat-signal lookup via ipapi.is.

Always-on, best-effort signal — see
docs/superpowers/plans/2026-08-08-visitor-intelligence.md for why this
can never resolve the real employer behind an ISP-routed IP.
"""

import json
import logging
import os
import re
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

IPAPI_IS_URL = "https://api.ipapi.is/"

# ── Is this "company" actually somebody's employer? ─────────────────────────
#
# Measured on production traffic: 10 IP resolutions produced 0 usable company
# names — 9 consumer ISPs and 1 subnet label. Unfiltered, that is 10 carrier
# names shown to salespeople as leads' employers.
#
# The vendor's own `type` field is checked first but cannot be trusted alone:
# it classified "TSBB pool2" — a BSNL subnet label — as `business`.
#
# Matching is anchored on WORD boundaries, not raw substrings. This module's
# sibling `company_markup` already learned that lesson the expensive way
# (an unanchored blocklist rejected "Sparked" for containing "parked"), and
# the naive version of THIS list was worse: a substring test for "network"
# rejects Juniper Networks, Palo Alto Networks, Arista Networks and F5
# Networks, while "isp" matches inside "DispatchTrack". Those are precisely
# the B2B leads the feature exists to surface.

# Single tokens that only appear in network-infrastructure labels. Kept
# deliberately narrow. Notably NOT here, because they are ordinary company
# vocabulary: network(s), communications, mobile, wireless, cable, fibre,
# fiber, cellular.
_INFRASTRUCTURE_WORDS = frozenset(
    {
        "pool", "subnet", "netblock", "cgnat", "dhcp", "dsl", "pppoe",
        "dialup", "broadband", "isp", "telecom", "telecommunications",
        "concentrator", "allocation", "subscriber",
    }
)  # fmt: skip

# Consumer carrier brands. Their corporate names are perfectly plausible
# company names, so no token rule can catch them — they have to be named.
#
# This knowingly rejects the rare visitor browsing from a carrier's own
# CORPORATE network. That trade is deliberate: a carrier has millions of
# consumer IPs and a handful of office ones, so "Airtel" on an inbound lead is
# overwhelmingly a consumer connection, and asserting otherwise to a
# salesperson is worse than saying nothing.
_CARRIER_BRANDS = (
    "airtel", "jio ", "jio_", "bsnl", "mtnl", "vodafone", "idea cellular",
    "tata teleservices", "tata communications", "act fibernet", "hathway",
    "excitel", "t-mobile", "at&t", "comcast", "verizon", "charter communications",
    "spectrum internet", "orange s.a", "deutsche telekom", "telefonica",
    "china telecom", "china unicom", "china mobile",
)  # fmt: skip

# Multi-word phrases, matched as substrings because each is unambiguous.
_INFRASTRUCTURE_PHRASES = (
    "internet service",
    "address pool",
    "ip pool",
    "customer pool",
    "dynamic ip",
    "static ip",
    "leased line",
    "last mile",
)

_MIN_COMPANY_NAME_LEN = 3


def is_usable_company_name(name: str | None) -> bool:
    """True only if ``name`` could plausibly be a visitor's employer.

    Deliberately conservative, because the two errors do not cost the same. A
    false positive puts a carrier's name in front of a salesperson as though
    it were the lead's company — they act on it, and it is wrong. A false
    negative shows "not identified", which is merely honest.
    """
    if not name:
        return False
    cleaned = name.strip()
    if len(cleaned) < _MIN_COMPANY_NAME_LEN:
        return False
    if not any(char.isalpha() for char in cleaned):
        return False

    lowered = cleaned.lower()
    if any(brand in lowered for brand in _CARRIER_BRANDS):
        return False
    if any(phrase in lowered for phrase in _INFRASTRUCTURE_PHRASES):
        return False
    # Split on non-alphanumerics so "dynamic-pool-42" and "TSBB pool2" both
    # yield a bare "pool" token. Trailing digits are stripped for the same
    # reason: "pool2" is a pool.
    words = {re.sub(r"\d+$", "", w) for w in re.findall(r"[a-z0-9]+", lowered)}
    return not (_INFRASTRUCTURE_WORDS & words)


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

    # "business" | "hosting" | "isp" | "education" | "government" — drives
    # whether the company name means "the visitor's employer" or just "the ISP
    # that routed them".
    company_type = company.get("type")
    company_name = company.get("name")

    # TWO gates, because either alone is insufficient. The type field lets
    # hosting and ISP ranges through as named companies; the name filter alone
    # would accept a plausible-looking carrier name on an `isp` range. A name
    # only survives as "the visitor's company" if the vendor calls the range
    # `business` AND the name could plausibly be an employer.
    if company_type != "business" or not is_usable_company_name(company_name):
        company_name = None

    return {
        "company_name": company_name,
        # The domain must not outlive its name. Returning airtel.in with no
        # company name would let a consumer read it back as the lead's employer
        # domain by another route.
        "company_domain": company.get("domain") if company_name else None,
        "company_type": company_type,
        "asn": asn.get("asn"),
        "asn_org": asn.get("org") or asn.get("descr"),
        "is_vpn": bool(data.get("is_vpn", False)),
        "is_proxy": bool(data.get("is_proxy", False)),
        "is_tor": bool(data.get("is_tor", False)),
        "is_datacenter": bool(data.get("is_datacenter", False)),
        "is_abuser": bool(data.get("is_abuser", False)),
    }
