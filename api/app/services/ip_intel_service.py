"""IP-based company and threat-signal lookup via ipapi.is.

Always-on, best-effort signal. See
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
# names. 9 consumer ISPs and 1 subnet label. Unfiltered, that is 10 carrier
# names shown to salespeople as leads' employers.
#
# The vendor's own `type` field is checked first but cannot be trusted alone:
# it classified "TSBB pool2" (a BSNL subnet label) as `business`.
#
# Matching is anchored on WORD boundaries, not raw substrings. This module's
# sibling `company_markup` already learned that lesson the expensive way
# (an unanchored blocklist rejected "Sparked" for containing "parked"), and
# the naive version of THIS list was worse: a substring test for "network"
# rejects Juniper Networks, Palo Alto Networks, Arista Networks and F5
# Networks, while "isp" matches inside "DispatchTrack". Those are precisely
# the B2B leads the feature exists to surface.

# Tokens that only appear in network-infrastructure labels. Deliberately
# narrow. Notably NOT here, because they are ordinary company vocabulary:
# network(s), communications, mobile, wireless, cable, fibre, fiber, cellular.
_INFRASTRUCTURE_WORDS = frozenset(
    {
        "subnet", "netblock", "cgnat", "dhcp", "dsl", "pppoe", "ftth",
        "dialup", "isp", "telecom", "telecommunication", "telecommunications",
        "telekom", "telco", "telecomunicaciones", "concentrator",
    }
)  # fmt: skip

# Infrastructure vocabulary that is ALSO ordinary business vocabulary. These
# only condemn a name when it carries no corporate suffix, because a real
# company says so in its name and a subnet label never does:
#
#   "TSBB pool2"            -> rejected   (a label)
#   "Pool Corporation"      -> accepted   (NASDAQ: POOL, ~$5B revenue)
#   "BSNL Broadband"        -> rejected
#   "Broadband Search Ltd"  -> accepted
_AMBIGUOUS_INFRASTRUCTURE_WORDS = frozenset({"pool", "broadband", "allocation", "subscriber"})

# A corporate suffix is the cheapest available evidence that a string is a
# registered company rather than a network label.
_CORPORATE_SUFFIXES = frozenset(
    {
        "ltd", "limited", "inc", "incorporated", "corp", "corporation", "llc",
        "llp", "plc", "gmbh", "ag", "sa", "sas", "bv", "nv", "oy", "oyj", "ab",
        "as", "aps", "spa", "srl", "pty", "pvt", "co", "company", "holdings",
        "partners", "ventures", "technologies", "solutions", "advisors",
        "associates", "consultants", "systems", "labs", "industries",
        "enterprises", "international", "capital", "financial",
    }
)  # fmt: skip

# Consumer carrier brands. Their corporate names are perfectly plausible
# company names, so no token rule can catch them. They have to be named.
#
# This knowingly rejects the rare visitor browsing from a carrier's own
# CORPORATE network. That trade is deliberate: a carrier has millions of
# consumer IPs and a handful of office ones, so "Airtel" on an inbound lead is
# overwhelmingly a consumer connection, and asserting otherwise to a
# salesperson is worse than saying nothing.
#
# A hand-curated list CANNOT generalise, and this one does not pretend to: a
# review tested 197 realistic carrier names worldwide against an earlier
# 24-entry version and 126 passed. It is a best-effort backstop for when the
# vendor's `type` field is wrong, not a guarantee. Matched on word boundaries
# for the same reason everything else here is. "jio" as a bare substring
# would hit nothing useful, and as a trailing-space hack ("jio ") it missed
# "JioFiber", "Reliance Jio" and the ASN-style "RELIANCEJIO-IN".
_CARRIER_BRAND_WORDS = frozenset(
    {
        # India
        "airtel", "jio", "jiofiber", "reliancejio", "bsnl", "mtnl",
        "hathway", "excitel", "fibernet", "railwire", "gtpl", "den",
        # Global majors and incumbents
        "vodafone", "verizon", "comcast", "xfinity", "centurylink", "lumen",
        "frontier", "windstream", "altice", "optimum", "mediacom", "cox",
        "spectrum", "rogers", "telus", "videotron", "shaw", "bell",
        "singtel", "starhub", "myrepublic", "telkomsel", "viettel", "vnpt",
        "pldt", "celcom", "axiata", "maxis", "globe", "smart",
        "swisscom", "kpn", "ziggo", "telenet", "proximus", "sfr", "bouygues",
        "telia", "telenor", "elisa", "fastweb", "wind", "tim", "vivo",
        "rostelecom", "mts", "megafon", "beeline", "turkcell", "turktelekom",
        "plusnet", "talktalk", "virginmedia", "btgroup", "openreach", "bt",
        "telefonica", "movistar", "claro", "telmex", "oi", "entel", "tigo",
        "cablevision", "izzi", "totalplay", "megacable",
        "mtn", "safaricom", "vodacom", "glo", "ooredoo", "zamtel", "econet",
        "telkom", "orange", "unicom", "chinanet", "chinamobile", "chinatelecom",
    }
)  # fmt: skip

# Multi-word phrases, matched as substrings because each is unambiguous.
# "last mile" was here and is gone: it condemned Delhivery, Shadowfax,
# Loadshare and Porter (one of India's largest B2B verticals) while
# matching no realistic ipapi.is label.
_INFRASTRUCTURE_PHRASES = (
    "internet service",
    "address pool",
    "ip pool",
    "customer pool",
    "dynamic ip",
    "static ip",
    "leased line",
    "virgin media",
)

# Two, not three: 3M, GE, BP, HP and LG are real employers. (BT is not, it is
# British Telecom, and it sits in the carrier list above.) Empty and
# whitespace-only names are already caught by the strip and isalpha guards.
_MIN_COMPANY_NAME_LEN = 2

# ipapi.is classifies a range as business | hosting | isp | education |
# government. Three of those are places people work.
#
# `education` and `government` were originally excluded along with hosting and
# isp, which was an oversight rather than a decision: a procurement officer at
# IIT Bombay or a state department is a legitimate (often the most valuable)
# B2B lead, and their range is exactly as employer-owned as a company's. An
# unrecognised value fails CLOSED, matching the rest of this module: showing
# nothing costs less than showing a salesperson something false.
_EMPLOYER_COMPANY_TYPES = frozenset({"business", "education", "government"})


def _tokens(lowered: str) -> set[str]:
    """Word tokens, with trailing digits and a trailing plural ``s`` removed.

    Both strips exist to defeat trivial evasion of the sets above:
    ``pool2`` is a pool, and ``Customer Subnets`` is a subnet.
    """
    raw = re.findall(r"[a-z0-9]+", lowered)
    out = set()
    for word in raw:
        word = re.sub(r"\d+$", "", word)
        out.add(word)
        if len(word) > 3 and word.endswith("s"):
            out.add(word[:-1])
    return out


def is_usable_company_name(name: str | None) -> bool:
    """True only if ``name`` could plausibly be a visitor's employer.

    Deliberately conservative, because the two errors do not cost the same. A
    false positive puts a carrier's name in front of a salesperson as though
    it were the lead's company. They act on it, and it is wrong. A false
    negative shows "not identified", which is merely honest.
    """
    # The vendor's payload is untrusted, and `company`/`asn` are already
    # guarded one level up. A non-string name reaching `.strip()` raised
    # AttributeError out of fetch_ip_intel, which sits BEFORE the geolocation
    # lookup in its caller's try block, so one malformed field cost the
    # session its city and country too. Same guard, same reason, as
    # company_markup._plausible_name.
    if not isinstance(name, str):
        return False
    cleaned = name.strip()
    if len(cleaned) < _MIN_COMPANY_NAME_LEN:
        return False
    if not any(char.isalpha() for char in cleaned):
        return False

    lowered = cleaned.lower()
    if any(phrase in lowered for phrase in _INFRASTRUCTURE_PHRASES):
        return False

    words = _tokens(lowered)
    if words & _CARRIER_BRAND_WORDS:
        return False
    if words & _INFRASTRUCTURE_WORDS:
        return False
    if words & _AMBIGUOUS_INFRASTRUCTURE_WORDS:
        return bool(words & _CORPORATE_SUFFIXES)
    return True


def fetch_ip_intel(ip_address: str) -> dict | None:
    """Fetch company/ASN/threat data for an IP. Returns None on any failure.

    PRIVACY, the only caller is ``chat_routes._resolve_and_update_location``,
    which runs on the background pool; read the note on that function before
    calling this from anywhere else. ``url`` below carries both the visitor's
    address and the vendor API key, and Sentry's StdlibIntegration records
    outbound URLs unsanitised into whatever transaction is live.
    """
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
        # PRIVACY, no ``ip_address`` and no ``url`` in either line. Sentry's
        # LoggingIntegration promotes every WARNING to a breadcrumb, so an
        # address interpolated here rode out on the next error the process
        # reported, and the URL would have taken the vendor key with it.
        # urllib's exceptions do not repeat the request URL in ``str()``.
        logger.warning(f"ipapi.is lookup failed: {exc}")
        return None

    if "error" in data:
        logger.warning(f"ipapi.is returned error: {data.get('error')}")
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

    # "business" | "hosting" | "isp" | "education" | "government". Drives
    # whether the company name means "the visitor's employer" or just "the ISP
    # that routed them".
    company_type = company.get("type")
    company_name = company.get("name")

    # TWO gates, because either alone is insufficient. The type field lets
    # hosting and ISP ranges through as named companies; the name filter alone
    # would accept a plausible-looking carrier name on an `isp` range. A name
    # only survives as "the visitor's company" if the range is a type someone
    # can be employed by AND the name could plausibly be an employer.
    if company_type not in _EMPLOYER_COMPANY_TYPES or not is_usable_company_name(company_name):
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
