"""GSTIN validation — structure + mod-36 checksum.

Pure functions, no I/O. Validates the seller profile's GSTIN today, and will
validate customer GSTINs captured for B2B tax invoices in later invoicing
phases (see docs/billing/2026-07-02-invoicing-implementation-plan-v2.md).
"""

from __future__ import annotations

import re

_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
# GST state codes 01–38 plus 97 (Other Territory).
VALID_STATE_CODES = frozenset({f"{i:02d}" for i in range(1, 39)} | {"97"})


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
