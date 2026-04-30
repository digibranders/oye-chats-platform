"""Upload regenerated `.brevo.html` files to Brevo's saved templates.

Workflow per template:
1. GET the current template HTML and stash it in ``emails/.backup/<timestamp>/<id>.html``
   so we can roll back if anything regresses.
2. PUT the new HTML.
3. GET again and assert the update took.

Reads ``BREVO_API_KEY`` from ``app.config`` (which loads ``.env``). The script
exits non-zero on any failure — successful uploads are NOT rolled back, but
the unchanged remaining templates simply aren't touched.

Usage:
    cd platform/api
    uv run python scripts/upload_brevo_templates.py            # upload all
    uv run python scripts/upload_brevo_templates.py 57 60      # upload subset
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import BREVO_API_KEY

EMAILS_DIR = Path(__file__).resolve().parent.parent / "emails"
BACKUP_ROOT = EMAILS_DIR / ".backup"
BREVO_TEMPLATES_URL = "https://api.brevo.com/v3/smtp/templates/{id}"

# Mapping: Brevo template ID → local file
TEMPLATES: list[tuple[int, str, str]] = [
    (57, "01_password_reset.brevo.html", "Password reset"),
    (58, "05_offline_message.brevo.html", "Offline message"),
    (59, "07_visitor_confirmation.brevo.html", "Visitor confirmation"),
    (60, "02_qualified_lead.brevo.html", "Qualified lead"),
    (61, "03_handoff_request.brevo.html", "Handoff request"),
    (62, "04_missed_callback.brevo.html", "Missed callback"),
]


class BrevoError(RuntimeError):
    pass


def _request(method: str, url: str, *, body: dict | None = None) -> dict:
    """Make an authenticated Brevo API call. Returns parsed JSON or empty dict."""
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    req = Request(
        url,
        data=payload,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "api-key": BREVO_API_KEY or "",
        },
        method=method,
    )
    try:
        with urlopen(req, timeout=20) as resp:
            raw = resp.read()
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))
    except HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        raise BrevoError(f"HTTP {exc.code} on {method} {url}: {body_text[:300]}") from exc
    except URLError as exc:
        raise BrevoError(f"network error on {method} {url}: {exc.reason}") from exc


def get_template(template_id: int) -> dict:
    return _request("GET", BREVO_TEMPLATES_URL.format(id=template_id))


def update_template(template_id: int, *, html_content: str) -> None:
    """PUT new htmlContent. We keep the existing subject, sender, name, etc."""
    _request(
        "PUT",
        BREVO_TEMPLATES_URL.format(id=template_id),
        body={"htmlContent": html_content},
    )


def main() -> int:
    if not BREVO_API_KEY:
        print("ERROR: BREVO_API_KEY is not set. Add it to .env and retry.", file=sys.stderr)
        return 2

    # Optional CLI filter: pass template IDs to upload a subset.
    requested_ids = {int(arg) for arg in sys.argv[1:]} if len(sys.argv) > 1 else None
    targets = [t for t in TEMPLATES if t[0] in requested_ids] if requested_ids is not None else TEMPLATES
    if not targets:
        print(f"ERROR: no templates matched IDs {requested_ids}", file=sys.stderr)
        return 2

    timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    backup_dir = BACKUP_ROOT / timestamp
    backup_dir.mkdir(parents=True, exist_ok=True)

    print(f"Uploading {len(targets)} template(s) to Brevo. Backup → {backup_dir}\n")

    failures: list[str] = []
    for template_id, filename, label in targets:
        path = EMAILS_DIR / filename
        if not path.is_file():
            failures.append(f"#{template_id} {label}: missing file {filename}")
            print(f"  ✗ #{template_id} {label}: {filename} not found")
            continue

        new_html = path.read_text(encoding="utf-8")

        # 1) Back up existing template
        try:
            current = get_template(template_id)
        except BrevoError as exc:
            failures.append(f"#{template_id} {label}: GET failed — {exc}")
            print(f"  ✗ #{template_id} {label}: GET failed — {exc}")
            continue

        existing_html = current.get("htmlContent", "")
        backup_path = backup_dir / f"{template_id}.html"
        backup_path.write_text(existing_html or "", encoding="utf-8")

        # 2) Upload new HTML
        try:
            update_template(template_id, html_content=new_html)
        except BrevoError as exc:
            failures.append(f"#{template_id} {label}: PUT failed — {exc}")
            print(f"  ✗ #{template_id} {label}: PUT failed — {exc}")
            continue

        # 3) Verify via re-fetch (Brevo persists the htmlContent verbatim)
        try:
            verify = get_template(template_id)
        except BrevoError as exc:
            failures.append(f"#{template_id} {label}: verify-GET failed — {exc}")
            print(f"  ✗ #{template_id} {label}: verify-GET failed — {exc}")
            continue

        verified_html = verify.get("htmlContent", "")
        if verified_html.strip() != new_html.strip():
            failures.append(f"#{template_id} {label}: verification mismatch (server HTML differs)")
            print(f"  ⚠ #{template_id} {label}: verification mismatch — review on Brevo dashboard")
            continue

        size_kb = len(new_html) / 1024
        print(f"  ✓ #{template_id} {label:24s} ({size_kb:5.1f} KB)  backup={backup_path.name}")

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for line in failures:
            print(f"  {line}")
        print(f"\nRoll back any successful uploads via the backups in {backup_dir}.")
        return 1

    print(f"All {len(targets)} template(s) uploaded and verified.")
    print(f"Rollback (if ever needed): re-PUT files from {backup_dir}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
