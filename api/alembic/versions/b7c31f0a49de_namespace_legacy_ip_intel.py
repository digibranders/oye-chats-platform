"""Move legacy IP-intel keys under visitor_metadata.ip_intel and flatten them.

Data-only migration. Two shapes exist in ``chat_sessions.visitor_metadata``:

* LEGACY (written before the ip_intel namespacing fix) — ipapi.is's payload
  splatted at the TOP LEVEL of the column, with ``company`` and ``asn`` still
  as nested OBJECTS::

      {"company": {"name": "Bharti Airtel Limited", "domain": "airtel.in",
                   "type": "isp"},
       "asn": {"asn": 24560, "org": "..."},
       "is_vpn": false, "is_datacenter": false, ...}

* CURRENT — namespaced and flattened, so it can coexist with the operator
  console's user-agent keys (browser/os) in the same column::

      {"ip_intel": {"company_name": "...", "company_domain": "...",
                    "company_type": "isp", "asn": 24560, "asn_org": "...",
                    "is_vpn": false, ...}}

The Leads UI reads ONLY the current shape, so legacy rows render as "no
company signal" forever. This rewrites them in place.

Idempotent: rows that already carry ``ip_intel`` are skipped, so a re-run is a
no-op. Downgrade is intentionally not implemented — the legacy shape is a bug,
and unpicking a merged column would risk destroying user-agent keys that were
never part of it.

Revision ID: b7c31f0a49de
Revises: d3a71b6c04e2
"""

from __future__ import annotations

import json
import logging

import sqlalchemy as sa

from alembic import op

revision = "b7c31f0a49de"
down_revision = "d3a71b6c04e2"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")

# Top-level keys that identify a legacy payload. ``company``/``asn`` are the
# giveaway — the current shape never puts them at the top level.
_LEGACY_MARKERS = ("company", "asn", "is_vpn", "is_datacenter", "is_abuser")

_RISK_FLAGS = ("is_vpn", "is_proxy", "is_tor", "is_datacenter", "is_abuser")


def _as_dict(value: object) -> dict:
    """Coerce a possibly-nested JSON value to a dict; {} for anything else."""
    return value if isinstance(value, dict) else {}


def _flatten(legacy: dict) -> dict:
    """Convert a legacy top-level payload into the current ip_intel shape.

    Applies the SAME employer gates as ``ip_intel_service.fetch_ip_intel``.
    This was the second writer of ``visitor_metadata.ip_intel`` and it copied
    the vendor's company name straight through, so a row it wrote could carry
    a carrier or hosting name where the live path would have written null —
    and the Leads panel renders exactly that field as the visitor's company.

    The panel dropped its own defensive disclaimer once the service began
    filtering, on the stated premise that every writer filters. This is what
    makes that premise true. Imported inside the function so the migration
    keeps working if the module is later moved.
    """
    from app.services.ip_intel_service import _EMPLOYER_COMPANY_TYPES, is_usable_company_name

    company = _as_dict(legacy.get("company"))
    asn = _as_dict(legacy.get("asn"))

    company_type = company.get("type")
    company_name = company.get("name")
    if company_type not in _EMPLOYER_COMPANY_TYPES or not is_usable_company_name(company_name):
        company_name = None

    return {
        "company_name": company_name,
        "company_domain": company.get("domain") if company_name else None,
        "company_type": company_type,
        "asn": asn.get("asn"),
        "asn_org": asn.get("org") or asn.get("descr"),
        **{flag: bool(legacy.get(flag, False)) for flag in _RISK_FLAGS},
    }


def upgrade() -> None:
    conn = op.get_bind()

    rows = conn.execute(
        sa.text(
            """
            SELECT id, visitor_metadata
            FROM chat_sessions
            WHERE visitor_metadata IS NOT NULL
              AND NOT (visitor_metadata ? 'ip_intel')
              AND (visitor_metadata ?| :markers)
            """
        ).bindparams(sa.bindparam("markers", value=list(_LEGACY_MARKERS), type_=sa.ARRAY(sa.Text)))
    ).fetchall()

    if not rows:
        logger.info("namespace_legacy_ip_intel: no legacy visitor_metadata rows found")
        return

    migrated = 0
    for session_id, metadata in rows:
        legacy = _as_dict(metadata)
        if not legacy:
            continue

        # Anything that ISN'T a legacy IP-intel key belongs to another feature
        # (the operator console stores parsed user-agent here). Preserve it.
        preserved = {k: v for k, v in legacy.items() if k not in _LEGACY_MARKERS}
        preserved["ip_intel"] = _flatten(legacy)

        conn.execute(
            sa.text("UPDATE chat_sessions SET visitor_metadata = CAST(:m AS jsonb) WHERE id = :id"),
            {"m": json.dumps(preserved), "id": session_id},
        )
        migrated += 1

    logger.info("namespace_legacy_ip_intel: migrated %s row(s)", migrated)


def downgrade() -> None:
    """No-op — see the module docstring."""
