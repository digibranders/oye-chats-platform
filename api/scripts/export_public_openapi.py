"""Export a CUSTOMER-FACING OpenAPI document for the public docs site.

``app.openapi()`` describes every route the process mounts, including the
whole ``/superadmin`` surface, impersonation minting, the inbound Razorpay
webhook and the internal health/ops probes. That document must never be
published: it is a map of the platform's privileged control plane, and the
generated title ("RAG Backend API") is an internal name.

This script produces the filtered document that IS safe to publish:

* every path matching :data:`_DENY_PATTERNS` is dropped;
* ``components.schemas`` is pruned to what the surviving paths still
  reference (transitively), so no superadmin request/response model names
  leak through the components map;
* ``info`` is rewritten to the public product name and the public base URL
  is declared, so the file is directly usable in Postman/Insomnia.

The output is what the marketing site serves at ``/openapi.json``.

Usage (from ``platform/api``):

    uv run python scripts/export_public_openapi.py \
        --out ../../oyechats-website/public/openapi.json

Re-run it whenever customer-facing routes change; the file is a build
artefact of the API, not hand-maintained website content.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

# Paths that must never appear in the published document. Matched with
# ``re.search`` against the raw path template, so a pattern anchored with ``^``
# means "path prefix" and a bare word means "appears anywhere".
_DENY_PATTERNS: tuple[str, ...] = (
    # Privileged control plane.
    r"^/superadmin",
    r"impersonat",
    # Product-internal activation funnel (super-admin gated) and the
    # super-admin price-drift diagnostic that lives under /subscriptions.
    r"^/activation",
    r"^/subscriptions/admin/",
    # Inbound gateway webhook. Razorpay posts here, customers never do.
    r"^/webhooks/razorpay$",
    # Ops probes and internal object proxy.
    r"^/health/full$",
    r"^/files/",
    # Debug-only helpers.
    r"/debug",
)

_DENY = re.compile("|".join(_DENY_PATTERNS))

_PUBLIC_INFO: dict[str, Any] = {
    "title": "OyeChats API",
    "version": "1.0.0",
    "description": (
        "REST API for the OyeChats AI chatbot platform.\n\n"
        "Authenticate workspace-scoped requests with `X-API-Key` (Settings → "
        "API Keys in the dashboard). Widget endpoints authenticate with the "
        "public `X-Bot-Key` embed key; live-chat operator endpoints "
        "authenticate with `X-Operator-Key`.\n\n"
        "This document describes the customer-facing surface only. See "
        "https://www.oyechats.com/docs for guides."
    ),
    "contact": {"name": "OyeChats Support", "email": "support@oyechats.com"},
    "termsOfService": "https://www.oyechats.com/legal/terms",
}

_PUBLIC_SERVERS = [{"url": "https://api.oyechats.com", "description": "Production"}]

_REF_RE = re.compile(r'"\$ref"\s*:\s*"#/components/schemas/([^"]+)"')


def filter_paths(paths: dict[str, Any]) -> dict[str, Any]:
    """Drop every path matching the deny list, preserving insertion order."""
    return {path: item for path, item in paths.items() if not _DENY.search(path)}


def reachable_schemas(document: dict[str, Any]) -> set[str]:
    """Schema names reachable from ``paths``, followed transitively.

    Serialising to JSON and scanning for ``$ref`` is deliberate: the refs can
    sit at any depth (arrays, ``anyOf``, nested objects, parameter schemas),
    and a structural walk has to re-implement all of those shapes to stay
    correct. The text scan cannot miss one.
    """
    all_schemas: dict[str, Any] = document.get("components", {}).get("schemas", {})
    frontier = set(_REF_RE.findall(json.dumps(document.get("paths", {}))))
    seen: set[str] = set()

    while frontier:
        name = frontier.pop()
        if name in seen:
            continue
        seen.add(name)
        schema = all_schemas.get(name)
        if schema is None:
            continue
        for nested in _REF_RE.findall(json.dumps(schema)):
            if nested not in seen:
                frontier.add(nested)

    return seen


def build_public_document(raw: dict[str, Any]) -> dict[str, Any]:
    """Return the publishable document derived from a full OpenAPI document."""
    document = dict(raw)
    document["info"] = dict(_PUBLIC_INFO)
    document["servers"] = [dict(server) for server in _PUBLIC_SERVERS]
    document["paths"] = filter_paths(raw.get("paths", {}))

    keep = reachable_schemas(document)
    components = dict(raw.get("components", {}))
    schemas = components.get("schemas")
    if isinstance(schemas, dict):
        components["schemas"] = {name: body for name, body in schemas.items() if name in keep}
    if components:
        document["components"] = components

    # Tag list, when present, is generated from the routers. Prune the tags no
    # surviving operation uses so the document has no dangling superadmin tags.
    used_tags = {
        tag
        for path_item in document["paths"].values()
        if isinstance(path_item, dict)
        for operation in path_item.values()
        if isinstance(operation, dict)
        for tag in operation.get("tags", [])
    }
    if isinstance(raw.get("tags"), list):
        document["tags"] = [t for t in raw["tags"] if t.get("name") in used_tags]

    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        required=True,
        help="Destination JSON file (e.g. ../../oyechats-website/public/openapi.json).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the destination differs from freshly generated output.",
    )
    args = parser.parse_args()

    # Imported here so ``--help`` does not pay for app construction.
    from app.main import app

    document = build_public_document(app.openapi())
    rendered = json.dumps(document, indent=2, sort_keys=False) + "\n"

    destination = Path(args.out).resolve()

    if args.check:
        current = destination.read_text() if destination.exists() else ""
        if current != rendered:
            print(f"{destination} is stale. Re-run without --check.", file=sys.stderr)
            return 1
        print(f"{destination} is up to date.")
        return 0

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(rendered)

    dropped = len(app.openapi().get("paths", {})) - len(document["paths"])
    print(
        f"Wrote {destination}\n"
        f"  paths kept    : {len(document['paths'])}\n"
        f"  paths dropped : {dropped}\n"
        f"  schemas kept  : {len(document.get('components', {}).get('schemas', {}))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
