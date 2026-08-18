"""GSTIN validation. Structure + mod-36 checksum.

Pure functions, no I/O. Validates the seller profile's GSTIN today, and will
validate customer GSTINs captured for B2B tax invoices in later invoicing
phases (see docs/billing/2026-07-02-invoicing-implementation-plan-v2.md).
"""

from __future__ import annotations

import re

_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
# GST state codes 01 to 38 plus 97 (Other Territory).
VALID_STATE_CODES = frozenset({f"{i:02d}" for i in range(1, 39)} | {"97"})

# GST state code → State name (Rule 46 requires the State NAME for the place of
# supply on an inter-state tax invoice, not the bare numeric code).
GST_STATE_NAMES: dict[str, str] = {
    "01": "Jammu & Kashmir",
    "02": "Himachal Pradesh",
    "03": "Punjab",
    "04": "Chandigarh",
    "05": "Uttarakhand",
    "06": "Haryana",
    "07": "Delhi",
    "08": "Rajasthan",
    "09": "Uttar Pradesh",
    "10": "Bihar",
    "11": "Sikkim",
    "12": "Arunachal Pradesh",
    "13": "Nagaland",
    "14": "Manipur",
    "15": "Mizoram",
    "16": "Tripura",
    "17": "Meghalaya",
    "18": "Assam",
    "19": "West Bengal",
    "20": "Jharkhand",
    "21": "Odisha",
    "22": "Chhattisgarh",
    "23": "Madhya Pradesh",
    "24": "Gujarat",
    "25": "Daman & Diu",
    "26": "Dadra & Nagar Haveli and Daman & Diu",
    "27": "Maharashtra",
    "28": "Andhra Pradesh (Old)",
    "29": "Karnataka",
    "30": "Goa",
    "31": "Lakshadweep",
    "32": "Kerala",
    "33": "Tamil Nadu",
    "34": "Puducherry",
    "35": "Andaman & Nicobar Islands",
    "36": "Telangana",
    "37": "Andhra Pradesh",
    "38": "Ladakh",
    "97": "Other Territory",
}


def state_name(code: str | None) -> str | None:
    """Return the GST State name for a 2-digit code (``"27" → "Maharashtra"``)."""
    return GST_STATE_NAMES.get((code or "").strip()) if code else None


def compute_check_char(body14: str) -> str:
    """Mod-36 check character over the first 14 GSTIN characters."""
    total = 0
    for i, ch in enumerate(body14):
        value = _CHARS.index(ch)
        product = value * (2 if i % 2 else 1)
        total += product // 36 + product % 36
    return _CHARS[(36 - total % 36) % 36]


def normalize_gstin(raw: str) -> str:
    return raw.strip().upper()


def is_valid_gstin(raw: str) -> bool:
    gstin = normalize_gstin(raw or "")
    if not _GSTIN_RE.match(gstin):
        return False
    if gstin[:2] not in VALID_STATE_CODES:
        return False
    return gstin[-1] == compute_check_char(gstin[:-1])


# ISO 3166-1 alpha-2 → country name, for the export-invoice "country of
# destination" that Rule 46 requires. Deliberately a curated list rather than a
# dependency: the invoice only ever needs the markets the product actually
# sells into, and an unknown code falls back to the code itself so the field is
# never silently blank on a statutory document.
COUNTRY_NAMES: dict[str, str] = {
    "AE": "United Arab Emirates",
    "AU": "Australia",
    "BD": "Bangladesh",
    "BR": "Brazil",
    "CA": "Canada",
    "CH": "Switzerland",
    "DE": "Germany",
    "DK": "Denmark",
    "ES": "Spain",
    "FR": "France",
    "GB": "United Kingdom",
    "HK": "Hong Kong",
    "ID": "Indonesia",
    "IE": "Ireland",
    "IL": "Israel",
    "IN": "India",
    "IT": "Italy",
    "JP": "Japan",
    "KE": "Kenya",
    "LK": "Sri Lanka",
    "MY": "Malaysia",
    "NG": "Nigeria",
    "NL": "Netherlands",
    "NP": "Nepal",
    "NZ": "New Zealand",
    "PH": "Philippines",
    "PK": "Pakistan",
    "PL": "Poland",
    "QA": "Qatar",
    "SA": "Saudi Arabia",
    "SE": "Sweden",
    "SG": "Singapore",
    "TH": "Thailand",
    "TR": "Türkiye",
    "US": "United States",
    "VN": "Vietnam",
    "ZA": "South Africa",
}


def country_name(code: str | None) -> str | None:
    """ISO alpha-2 → country name, falling back to the code itself.

    Returns ``None`` only for a genuinely empty code, so a caller can omit the
    line rather than print "Country of destination: ".
    """
    normalized = (code or "").strip().upper()
    if not normalized:
        return None
    return COUNTRY_NAMES.get(normalized, normalized)
