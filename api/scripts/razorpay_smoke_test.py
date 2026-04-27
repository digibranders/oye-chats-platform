"""Razorpay live smoke test.

Run this once you've pasted real test keys into ``platform/api/.env`` to
confirm the integration talks to Razorpay's test API end-to-end. It does
NOT hit the database — it only exercises the Razorpay SDK calls in
isolation.

Usage:

    cd platform/api
    uv run python scripts/razorpay_smoke_test.py [--amount 1599]

Output:
* Creates a test Order for ``--amount`` rupees (default ₹1,599 = 2,000 credit
  pack) and prints the ``order_id``.
* Prints a Razorpay-hosted Checkout URL you can open in a browser to test
  the actual payment flow with UPI VPA ``success@razorpay``.
* Verifies the order can be re-fetched (proves auth + key correctness).
* Optionally fakes a signature with the SDK utility to confirm
  ``verify_payment_signature`` works locally.

This script is dev-only — never run against production keys.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Make ``app`` importable when run from platform/api
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")


def _bail(msg: str) -> None:
    print(f"\033[31m✗ {msg}\033[0m", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Razorpay live smoke test")
    parser.add_argument("--amount", type=int, default=1599, help="Rupees (default: 1599)")
    parser.add_argument("--credits", type=int, default=2000, help="Credits this represents")
    parser.add_argument("--client-id", type=int, default=1, help="OyeChats client id for notes")
    args = parser.parse_args()

    key_id = os.getenv("RAZORPAY_KEY_ID")
    key_secret = os.getenv("RAZORPAY_KEY_SECRET")
    if not key_id or not key_secret:
        _bail("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env")
    if not key_id.startswith("rzp_test_"):
        _bail(f"Refusing to run: {key_id!r} does not look like a TEST key (must start with 'rzp_test_')")

    import razorpay

    client = razorpay.Client(auth=(key_id, key_secret))

    print("\033[36m[1/4] Creating test order…\033[0m")
    receipt = f"smoke_{int(time.time())}"
    order = client.order.create(
        data={
            "amount": args.amount * 100,  # paise
            "currency": "INR",
            "receipt": receipt,
            "notes": {
                "purpose": "topup",
                "client_id": str(args.client_id),
                "credits": str(args.credits),
                "amount_inr": str(args.amount),
                "smoke_test": "true",
            },
            "payment_capture": 1,
        }
    )
    order_id = order["id"]
    print(json.dumps(order, indent=2))
    print(f"\033[32m✓ Order created: {order_id}\033[0m\n")

    print("\033[36m[2/4] Re-fetching the order to confirm auth…\033[0m")
    refetched = client.order.fetch(order_id)
    assert refetched["id"] == order_id, "fetched id mismatch"
    print(f"\033[32m✓ Re-fetch OK (status={refetched['status']})\033[0m\n")

    print("\033[36m[3/4] Hosted Checkout URL (open in a browser to test pay-flow):\033[0m")
    print(f"  https://api.razorpay.com/v1/checkout/embedded?key_id={key_id}&order_id={order_id}")
    print("  Test UPI VPA:  success@razorpay  (auto-captures)")
    print("  Test card:     4111 1111 1111 1111   any future expiry, any CVV, OTP=123456\n")

    print("\033[36m[4/4] Local signature roundtrip (no network)…\033[0m")
    # Pretend we got a payment_id back from Checkout. Real Razorpay computes
    # HMAC-SHA256(order_id|payment_id, key_secret); we emulate it locally so
    # the SDK's verifier can confirm the math.
    import hashlib
    import hmac as _hmac

    fake_payment_id = "pay_smoke_TestPayment01"
    msg = f"{order_id}|{fake_payment_id}".encode()
    sig = _hmac.new(key_secret.encode(), msg, hashlib.sha256).hexdigest()
    try:
        client.utility.verify_payment_signature(
            {
                "razorpay_order_id": order_id,
                "razorpay_payment_id": fake_payment_id,
                "razorpay_signature": sig,
            }
        )
        print("\033[32m✓ Local signature roundtrip OK — verify_payment_signature accepts our HMAC.\033[0m")
    except Exception as exc:
        _bail(f"Signature roundtrip failed: {exc}")

    print("\n\033[32m── Razorpay test integration is live. ──\033[0m")
    print("Next: complete a payment in the browser via the Checkout URL above.")
    print("Then check your Razorpay dashboard → Test Mode → Orders to see this entry.")


if __name__ == "__main__":
    main()
