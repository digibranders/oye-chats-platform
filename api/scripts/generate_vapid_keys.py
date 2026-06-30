"""Generate a VAPID keypair for Web Push notifications.

Run once per environment (dev / staging / prod). Prints the public key (URL-safe
base64, suitable for the frontend's ``applicationServerKey``) and the private
key (PEM, suitable for ``pywebpush``). Paste them into the corresponding
environment's ``.env``:

    VAPID_PUBLIC_KEY=<public key from this script>
    VAPID_PRIVATE_KEY="<private PEM, single line, escape newlines as \\n>"

Or write the PEM to a file and point ``VAPID_PRIVATE_KEY_FILE`` at it.

Usage:
    cd platform/api
    uv run python scripts/generate_vapid_keys.py
"""

from __future__ import annotations

import base64

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid01


def main() -> None:
    vapid = Vapid01()
    vapid.generate_keys()

    private_pem = vapid.private_pem().decode()
    public_raw = vapid.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    public_b64 = base64.urlsafe_b64encode(public_raw).rstrip(b"=").decode()

    print("# Add the following to your .env file:\n")
    print(f"VAPID_PUBLIC_KEY={public_b64}")
    # Single-line PEM with literal "\n" escapes — safe for .env files that
    # do not support multi-line values. python-dotenv un-escapes on load.
    escaped_pem = private_pem.replace("\n", "\\n")
    print(f'VAPID_PRIVATE_KEY="{escaped_pem}"')
    print("\n# Optional override (defaults to mailto:SUPPORT_EMAIL):")
    print("# VAPID_SUBJECT=mailto:you@example.com")


if __name__ == "__main__":
    main()
