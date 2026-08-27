"""Probe: does Razorpay ADD tax on top of a subscription plan's amount?

The question this answers, and why it matters
---------------------------------------------
OyeChats publishes BASE prices and adds 18% GST on top. Razorpay Subscriptions
debit ``plan.item.amount``, and there is no per-customer tax layer of the kind
Stripe Tax provides, so today we mint every domestic plan at ``base + GST``.
That works, but it welds the tax rate to an immutable mandate: a GST rate
change means re-minting every plan and re-authorising every customer.

Razorpay's Plan ``item`` object echoes ``tax_inclusive``, ``tax_rate``,
``tax_id``, ``tax_group_id``, ``hsn_code`` and ``sac_code``. Their INVOICES
product documents tax-exclusive line items with a per-line rate. Their
SUBSCRIPTIONS docs never say whether those fields change what is debited. If
they do, plans can stay at the base and tax becomes the gateway's job, which is
the architecture the rest of the industry uses.

That is not a question to answer by reading. This probe answers it empirically.

RESULT (run 2026-08-26, Razorpay test mode)
-------------------------------------------
**The tax fields are metadata only. Razorpay does NOT add tax to a subscription
debit.**

Razorpay accepted ``tax_inclusive: false`` and ``tax_rate: 1800`` on the plan
item and stored both faithfully (they come back on a re-fetch, alongside
``hsn_code``). It left ``item.amount`` and ``item.unit_amount`` at the base, and
exposed no derived total on the subscription entity.

The hosted checkout settled it. Two subscriptions, same ₹1,199 base, one plan
carrying ``tax_rate: 1800`` and one carrying nothing, both quoted the customer
the identical figure:

    TAXPROBE control   ₹ 1,199.00 x 1 unit   ₹ 1,199.00   Billed for this month
    TAXPROBE taxed     ₹ 1,199.00 x 1 unit   ₹ 1,199.00   Billed for this month

So delegating GST to the gateway is not available for Subscriptions, whatever
the Invoices product can do. Minting domestic plans at ``base + GST`` is not a
workaround we chose over a better option; it is the only option Razorpay gives
us, and the coupling of the tax rate to the mandate is an unavoidable
consequence rather than a design mistake.

Re-run this probe before believing any future claim that Razorpay has started
supporting it.

What it does
------------
1. Mints a CONTROL plan at the base amount, no tax fields.
2. Mints a TAXED plan at the same base amount with ``tax_inclusive=false`` and
   a tax rate, then re-fetches it to see what Razorpay stored.
3. Creates a subscription against each plan and dumps every field, looking for
   any amount Razorpay derives, so we can see whether the taxed plan implies a
   larger debit than the control.
4. Cancels both subscriptions. Razorpay plans cannot be deleted; the two test
   plans are left behind and are harmless.

Reading the result
------------------
The probe cannot invent an answer, so it reports evidence, not a verdict, and
says plainly when the evidence is inconclusive. A subscription in ``created``
state has no invoice yet, so if Razorpay exposes no derived amount anywhere the
honest conclusion is "undetermined by API, verify on the hosted checkout page",
and the probe prints the ``short_url`` for exactly that.

Safety
------
REFUSES to run against anything but a ``rzp_test_`` key. This creates real
objects in whatever account the key belongs to, and creating priced plans in a
live account is not something a probe should ever be able to do by accident.

Usage:

    cd platform/api
    uv run python scripts/razorpay_tax_probe.py [--base 119900] [--rate 18]
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

sys.path.insert(0, ".")

from app import config  # noqa: E402


def _require_test_mode() -> None:
    key = config.RAZORPAY_KEY_ID or ""
    if not key.startswith("rzp_test"):
        mode = "live" if key.startswith("rzp_live") else "unrecognised"
        print(
            f"REFUSING TO RUN: RAZORPAY_KEY_ID is a {mode} key.\n"
            "This probe creates plans and subscriptions. Point .env at a test key first.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    if not config.RAZORPAY_KEY_SECRET:
        print("REFUSING TO RUN: RAZORPAY_KEY_SECRET is unset.", file=sys.stderr)
        raise SystemExit(2)


def _client():
    import razorpay

    return razorpay.Client(auth=(config.RAZORPAY_KEY_ID, config.RAZORPAY_KEY_SECRET))


def _dump(label: str, obj: Any) -> None:
    print(f"\n--- {label} ---")
    print(json.dumps(obj, indent=2, sort_keys=True, default=str))


def _item_of(plan: dict[str, Any]) -> dict[str, Any]:
    return plan.get("item") or {}


def _amountish_fields(entity: dict[str, Any]) -> dict[str, Any]:
    """Every field on an entity that looks like it carries money.

    Deliberately broad: the whole point is to notice an amount field we did not
    know Razorpay returned.
    """
    keys = ("amount", "total", "gross_amount", "tax_amount", "net_amount", "unit_amount", "amount_due", "amount_paid")
    return {k: v for k, v in entity.items() if k in keys and v is not None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=int, default=119900, help="Base amount in paise (default ₹1,199).")
    parser.add_argument("--rate", type=float, default=18.0, help="Tax rate in percent (default 18).")
    parser.add_argument(
        "--keep",
        action="store_true",
        help=(
            "Leave the probe subscriptions live so the hosted checkout pages can be opened. "
            "Cancelling them makes the short_urls return "
            "'Customer payment is not allowed for this subscription at this stage', "
            "which is the whole evidence this probe exists to collect. Cancel them yourself afterwards."
        ),
    )
    args = parser.parse_args()

    _require_test_mode()
    rzp = _client()
    base = int(args.base)

    print(f"Razorpay tax probe. key={config.RAZORPAY_KEY_ID[:12]}... base={base} paise rate={args.rate}%")

    created_subs: list[str] = []
    results: dict[str, Any] = {}

    # 1. CONTROL: plain plan, no tax fields.
    control = rzp.plan.create(
        data={
            "period": "monthly",
            "interval": 1,
            "item": {"name": "TAXPROBE control", "amount": base, "currency": "INR"},
            "notes": {"purpose": "tax_probe", "variant": "control"},
        }
    )
    _dump("CONTROL plan", control)
    results["control_amount"] = _item_of(control).get("amount")

    # 2. TAXED: same base, tax declared exclusive. Razorpay's own docs echo
    #    these fields on the item; whether they change the debit is the question.
    #    ``tax_rate`` is sent in basis points (18% -> 1800), the convention their
    #    Items API uses. The re-fetch below shows what was actually stored.
    taxed_payload = {
        "period": "monthly",
        "interval": 1,
        "item": {
            "name": "TAXPROBE taxed",
            "amount": base,
            "currency": "INR",
            "tax_inclusive": False,
            "tax_rate": int(args.rate * 100),
            "hsn_code": "998314",
        },
        "notes": {"purpose": "tax_probe", "variant": "taxed"},
    }
    try:
        taxed = rzp.plan.create(data=taxed_payload)
    except Exception as exc:  # noqa: BLE001 - the rejection IS the finding
        print(f"\nTAXED plan creation REJECTED by Razorpay: {exc}")
        print("\nFINDING: plan items do not accept tax fields on create.")
        print("Conclusion: tax cannot be delegated to Razorpay for subscriptions. Keep gross-in-plan.")
        return 0
    _dump("TAXED plan (create response)", taxed)

    refetched = rzp.plan.fetch(taxed["id"])
    _dump("TAXED plan (re-fetched)", refetched)
    item = _item_of(refetched)
    results["taxed_amount"] = item.get("amount")
    results["taxed_tax_inclusive"] = item.get("tax_inclusive")
    results["taxed_tax_rate"] = item.get("tax_rate")

    # 3. A subscription against each, to see whether Razorpay derives a total.
    for variant, plan_id in (("control", control["id"]), ("taxed", refetched["id"])):
        sub = rzp.subscription.create(
            data={
                "plan_id": plan_id,
                "total_count": 12,
                "customer_notify": 0,
                "notes": {"purpose": "tax_probe", "variant": variant},
            }
        )
        created_subs.append(sub["id"])
        _dump(f"SUBSCRIPTION ({variant})", sub)
        results[f"{variant}_sub_money_fields"] = _amountish_fields(sub)
        results[f"{variant}_short_url"] = sub.get("short_url")

    # 4. Clean up the subscriptions. Plans are immutable and undeletable.
    if args.keep:
        print("\n--keep: leaving these subscriptions live for checkout inspection. Cancel them when done:")
        for sub_id in created_subs:
            print(f"  {sub_id}")
    else:
        for sub_id in created_subs:
            try:
                rzp.subscription.cancel(sub_id, data={"cancel_at_cycle_end": 0})
                print(f"cancelled {sub_id}")
            except Exception as exc:  # noqa: BLE001 - cleanup must not mask the finding
                print(f"WARNING: could not cancel {sub_id}: {exc}", file=sys.stderr)

    # ── Verdict ──
    print("\n================ RESULT ================")
    print(json.dumps(results, indent=2, default=str))

    stored_rate = results.get("taxed_tax_rate")
    taxed_amount = results.get("taxed_amount")

    if stored_rate in (None, 0):
        print(
            "\nFINDING: Razorpay accepted the create call but did NOT store a tax_rate.\n"
            "The tax fields are inert for subscription plans.\n"
            "CONCLUSION: keep minting plans at base + GST. Tax cannot be delegated."
        )
        return 0

    if taxed_amount != base:
        print(
            f"\nFINDING: the stored item.amount ({taxed_amount}) differs from the base sent ({base}).\n"
            "Razorpay rewrote the amount, which means it is doing the tax arithmetic itself.\n"
            "CONCLUSION: plans can stay at base. Delegate tax to the gateway."
        )
        return 0

    print(
        f"\nFINDING: Razorpay stored tax_rate={stored_rate} but left item.amount at the base ({base}).\n"
        "No subscription field exposes a derived total before the first invoice, so the API\n"
        "alone cannot prove what will be debited.\n"
        "NEXT STEP (manual, 30 seconds): open the two short_urls above. The hosted checkout\n"
        "states the amount. If the taxed one shows more than the control, Razorpay is adding\n"
        "the tax and we can stop baking it into the plan. If both show the same, the fields\n"
        "are reporting metadata only and gross-in-plan stays."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
