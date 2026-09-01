"""Create this environment's Razorpay plans and attach them to the plan rows.

``set_razorpay_plan_ids.py`` attaches ids you already have; its docstring says
"after creating plans in the Razorpay dashboard". That is ten plans typed by
hand for the INR rail alone, at ten chances to paste a Starter id onto
Professional, which nothing downstream would catch: the customer is charged the
wrong amount and every invoice reconciles perfectly against it.

This mints them from the ``plans`` table instead, so the amount charged is
derived from the price the product actually publishes.

AMOUNTS ARE GROSS. Razorpay Subscriptions have no tax layer, so a plan is minted
at base + GST and the invoice carves the tax back out of what was captured. That
is the same rule ``razorpay_service.resolve_discounted_plan`` follows for
discounted plans; minting at the base here would under-charge every customer by
the GST and leave the invoicing engine reconciling against money that never
arrived.

Idempotent. Every minted plan carries ``notes.oyechats_plan_slug`` and
``notes.oyechats_cycle``, and an existing plan whose notes and amount both match
is reused rather than duplicated. Re-running after a price change mints a new
plan, because a Razorpay plan's amount is fixed at creation.

Usage, from platform/api:

    .venv/bin/python scripts/mint_razorpay_plans.py            # dry run
    .venv/bin/python scripts/mint_razorpay_plans.py --apply    # mint + write

The environment's ``RAZORPAY_KEY_ID`` decides which account is touched, so the
live plans are minted by running this against a live-keyed deploy.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select  # noqa: E402

from app.core.tax import gross_charge_minor  # noqa: E402
from app.db.models import Plan  # noqa: E402
from app.db.session import get_session  # noqa: E402
from app.services.seller_profile_service import charge_tax_rate_bps  # noqa: E402

CYCLES = (("monthly", "monthly"), ("annual", "yearly"))

#: The two rails, which are separate Razorpay objects because a plan's currency
#: is fixed at creation. An INR plan id can never serve a USD charge.
#:
#: The tax treatment differs and that is the point: a domestic supply is
#: uplifted by GST at charge time, while a sale to an international customer is
#: an export of services and is zero-rated, so the published USD price IS the
#: charge. Passing ``kind="intra"`` for USD would add 18% Indian GST to a
#: foreign customer's card.
RAILS = (
    ("INR", "monthly_price_cents", "annual_price_cents", "intra", ""),
    ("USD", "monthly_price_usd_cents", "annual_price_usd_cents", "export", "_usd"),
)


def _client():
    import razorpay

    key_id = os.environ.get("RAZORPAY_KEY_ID", "")
    secret = os.environ.get("RAZORPAY_KEY_SECRET", "")
    if not key_id or not secret:
        raise SystemExit("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.")
    return razorpay.Client(auth=(key_id, secret)), key_id


def _existing(client) -> list[dict]:
    """Every plan on the account, so a re-run reuses instead of duplicating."""
    items, skip = [], 0
    while True:
        page = client.plan.all({"count": 100, "skip": skip})
        batch = page.get("items", [])
        items.extend(batch)
        if len(batch) < 100:
            break
        skip += 100
    return items


def _find(existing: list[dict], slug: str, cycle: str, amount: int, currency: str) -> str | None:
    for plan in existing:
        notes = plan.get("notes") or {}
        item = plan.get("item") or {}
        if (
            notes.get("oyechats_plan_slug") == slug
            and notes.get("oyechats_cycle") == cycle
            # Amount and currency are part of the match: a price change must
            # mint a new plan, because Razorpay fixes both at creation.
            and int(item.get("amount") or 0) == amount
            and (item.get("currency") or "").upper() == currency
        ):
            return plan["id"]
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Mint and write (default: dry run).")
    parser.add_argument(
        "--currency",
        choices=("INR", "USD", "both"),
        default="both",
        help="Which rail to mint. USD needs international payments enabled on the account.",
    )
    args = parser.parse_args()

    client, key_id = _client()
    mode = "LIVE" if key_id.startswith("rzp_live") else "TEST"
    print(f"Razorpay account: {mode} ({key_id[:12]}…)\n")

    existing = _existing(client)
    print(f"{len(existing)} plans already on the account\n")

    with get_session() as session:
        rate = charge_tax_rate_bps(session)
        print(f"GST added at charge time: {rate} bps\n")
        plans = session.execute(select(Plan).order_by(Plan.id)).scalars().all()

        written: list[tuple[str, str, str]] = []
        for currency, monthly_col, annual_col, tax_kind, suffix in RAILS:
            if args.currency not in (currency, "both"):
                continue
            symbol = "₹" if currency == "INR" else "$"
            print(f"── {currency} rail ({'GST added' if tax_kind == 'intra' else 'zero-rated export'})")
            for plan in plans:
                for cycle, period in CYCLES:
                    base = int(getattr(plan, annual_col if cycle == "annual" else monthly_col) or 0)
                    if base <= 0:
                        continue  # Free and the trial plan are never charged.
                    amount = gross_charge_minor(base, rate_bps=rate, kind=tax_kind)
                    field = f"razorpay_plan_id_{cycle}{suffix}"
                    found = _find(existing, plan.slug, cycle, amount, currency)
                    if found:
                        print(f"  reuse  {plan.slug:<13} {cycle:<8} {symbol}{amount / 100:>10,.2f}  {found}")
                        written.append((plan.slug, field, found))
                        continue
                    if not args.apply:
                        print(f"  MINT   {plan.slug:<13} {cycle:<8} {symbol}{amount / 100:>10,.2f}  (dry run)")
                        continue
                    try:
                        created = client.plan.create(
                            data={
                                "period": period,
                                "interval": 1,
                                "item": {
                                    "name": f"OyeChats {plan.name} {cycle.capitalize()} {currency}",
                                    "amount": amount,
                                    "currency": currency,
                                },
                                "notes": {
                                    "oyechats_plan_slug": plan.slug,
                                    "oyechats_cycle": cycle,
                                    "oyechats_currency": currency,
                                    # The base is recorded so the GST component
                                    # of the charge stays legible on the gateway
                                    # side. Equal to the amount on the USD rail,
                                    # which carries no Indian tax.
                                    "oyechats_base_minor": str(base),
                                },
                            }
                        )
                    except Exception as exc:
                        # A USD plan on an account without international
                        # payments enabled fails here. Report it and keep the
                        # INR rail, rather than losing minted work to a raise.
                        print(f"  FAILED {plan.slug:<13} {cycle:<8} {currency}: {str(exc)[:90]}")
                        continue
                    print(f"  MINTED {plan.slug:<13} {cycle:<8} {symbol}{amount / 100:>10,.2f}  {created['id']}")
                    written.append((plan.slug, field, created["id"]))
            print()

        if not args.apply:
            print("\nDry run. Re-run with --apply to mint and write.")
            return

        by_slug = {p.slug: p for p in plans}
        for slug, field, plan_id in written:
            setattr(by_slug[slug], field, plan_id)
        session.commit()
        print(f"\nWrote {len(written)} plan ids onto the plan rows.")


if __name__ == "__main__":
    main()
