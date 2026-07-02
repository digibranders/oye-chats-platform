"""Seller-of-record profile — the legal identity that will be printed on
every invoice once the invoicing track (Phase 3+) is live.

Stored as one JSONB document in ``pricing_config`` (key
``billing.seller_profile``) so it is super-admin editable at runtime and an
entity change (e.g. OyeChats getting its own GST registration) is a data
edit, never a deploy. It will be snapshotted onto each invoice at finalize
time so that later config edits never mutate already-issued documents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.gstin import VALID_STATE_CODES, is_valid_gstin, normalize_gstin
from app.db.models import PricingConfig

SELLER_PROFILE_KEY = "billing.seller_profile"

# Rule 46(b): serial ≤16 chars. "PPP/YY-YY/NNNNNN" = len(prefix) + 13.
_MAX_PREFIX_LEN = 3
_MAX_RATE_BPS = 4000  # sanity ceiling, not a tax opinion


class SellerProfileError(ValueError):
    """Raised when a seller-profile payload fails validation."""


def _safe_int(value: Any, fallback: int) -> int:
    """Coerce to int, falling back on garbage — a stored bad row (e.g. via the
    generic pricing-config route or a manual psql edit) must never wedge reads.
    Mirrors the defensive-cast convention in ``runtime_config.py``.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


@dataclass(frozen=True)
class SellerProfile:
    configured: bool = False
    legal_name: str = ""
    trade_name: str = "OyeChats"
    gstin: str | None = None
    address_lines: list[str] = field(default_factory=list)
    state_code: str | None = None
    country: str = "IN"
    sac_code: str = "997331"
    tax_rate_bps: int = 1800
    price_inclusive: bool = True
    lut_active: bool = False
    lut_number: str | None = None
    invoice_prefix: str = "DB"
    logo_url: str | None = None

    @property
    def gst_enabled(self) -> bool:
        """GST tax-invoice mode; without a GSTIN we issue plain receipts."""
        return bool(self.gstin)


def get_seller_profile(session: Session) -> SellerProfile:
    row = session.get(PricingConfig, SELLER_PROFILE_KEY)
    if row is None or not isinstance(row.value, dict):
        return SellerProfile()
    defaults = SellerProfile()
    data: dict[str, Any] = row.value
    return SellerProfile(
        configured=True,
        legal_name=str(data.get("legal_name", "")),
        trade_name=str(data.get("trade_name", defaults.trade_name)),
        gstin=data.get("gstin") or None,
        address_lines=[str(x) for x in data.get("address_lines", [])],
        state_code=data.get("state_code") or None,
        country=str(data.get("country", defaults.country)),
        sac_code=str(data.get("sac_code", defaults.sac_code)),
        tax_rate_bps=_safe_int(data.get("tax_rate_bps", defaults.tax_rate_bps), defaults.tax_rate_bps),
        price_inclusive=bool(data.get("price_inclusive", defaults.price_inclusive)),
        lut_active=bool(data.get("lut_active", defaults.lut_active)),
        lut_number=data.get("lut_number") or None,
        invoice_prefix=str(data.get("invoice_prefix", defaults.invoice_prefix)),
        logo_url=data.get("logo_url") or None,
    )


def _validate(payload: dict[str, Any]) -> dict[str, Any]:
    defaults = SellerProfile()
    legal_name = str(payload.get("legal_name", "")).strip()
    if not legal_name:
        raise SellerProfileError("legal_name is required")

    gstin = payload.get("gstin")
    if gstin:
        gstin = normalize_gstin(str(gstin))
        if not is_valid_gstin(gstin):
            raise SellerProfileError("GSTIN failed format/checksum validation")
    else:
        gstin = None

    prefix = str(payload.get("invoice_prefix", defaults.invoice_prefix)).strip().upper()
    if not (1 <= len(prefix) <= _MAX_PREFIX_LEN) or not prefix.isalnum():
        raise SellerProfileError(
            f"invoice_prefix must be 1-{_MAX_PREFIX_LEN} alphanumeric chars (Rule 46 16-char serial limit)"
        )

    raw_rate = payload.get("tax_rate_bps", defaults.tax_rate_bps)
    try:
        tax_rate_bps = int(raw_rate)
    except (TypeError, ValueError) as exc:
        raise SellerProfileError("tax_rate_bps must be an integer") from exc
    if not 0 <= tax_rate_bps <= _MAX_RATE_BPS:
        raise SellerProfileError(f"tax_rate_bps must be between 0 and {_MAX_RATE_BPS}")

    sac_code = str(payload.get("sac_code", defaults.sac_code)).strip()
    if not sac_code:
        raise SellerProfileError("sac_code is required")

    raw_address = payload.get("address_lines", [])
    if not isinstance(raw_address, list):
        raise SellerProfileError("address_lines must be a list of strings")

    # Place of supply comparisons key off the seller state; the GSTIN's first
    # two digits are authoritative when present, else the explicit state code
    # is validated against the GST state-code set (zero-padded).
    if gstin:
        state_code = gstin[:2]
    else:
        raw_state = payload.get("state_code")
        state_code = str(raw_state).strip().zfill(2) if raw_state not in (None, "") else None
        if state_code is not None and state_code not in VALID_STATE_CODES:
            raise SellerProfileError(f"Unknown GST state code: {payload.get('state_code')}")

    lut_active = bool(payload.get("lut_active", defaults.lut_active))
    lut_number = (str(payload.get("lut_number")).strip() or None) if payload.get("lut_number") else None
    if lut_active and not lut_number:
        raise SellerProfileError("lut_number is required when lut_active is true")

    return {
        "legal_name": legal_name,
        "trade_name": str(payload.get("trade_name", defaults.trade_name)).strip() or defaults.trade_name,
        "gstin": gstin,
        "address_lines": [str(x).strip() for x in raw_address if str(x).strip()],
        "state_code": state_code,
        "country": str(payload.get("country", defaults.country)).strip().upper() or defaults.country,
        "sac_code": sac_code,
        "tax_rate_bps": tax_rate_bps,
        "price_inclusive": bool(payload.get("price_inclusive", defaults.price_inclusive)),
        "lut_active": lut_active,
        "lut_number": lut_number,
        "invoice_prefix": prefix,
        "logo_url": (str(payload.get("logo_url")).strip() or None) if payload.get("logo_url") else None,
    }


def save_seller_profile(session: Session, payload: dict[str, Any], *, actor_id: int | None) -> SellerProfile:
    """Merge ``payload`` over the currently stored profile, then validate + upsert.

    PATCH semantics: fields absent from ``payload`` keep their stored values
    (or code defaults on first save) rather than resetting — so a partial edit
    from the admin UI can never silently wipe the GSTIN or tax rate. To clear a
    field, send it explicitly (e.g. ``{"gstin": null}``).
    """
    existing = session.get(PricingConfig, SELLER_PROFILE_KEY)
    base = dict(existing.value) if existing is not None and isinstance(existing.value, dict) else {}
    merged = {**base, **payload}
    value = _validate(merged)
    stmt = (
        insert(PricingConfig)
        .values(key=SELLER_PROFILE_KEY, value=value, updated_by=actor_id, updated_at=func.now())
        .on_conflict_do_update(
            index_elements=["key"],
            set_={"value": value, "updated_by": actor_id, "updated_at": func.now()},
        )
    )
    session.execute(stmt)
    session.flush()
    return get_seller_profile(session)
