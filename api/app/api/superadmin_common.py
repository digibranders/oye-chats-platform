"""Authorisation gates and small shared helpers for the super-admin surface.

The super-admin API is five routers that all mount ``prefix="/superadmin"`` and
all put ``Depends(get_superadmin)`` on every endpoint. They are five files
because they were written at five different times, not because they cover five
different things: clients are split across three of them, invoices across two,
discounts across two.

Consolidating the *routes* is a large shuffle with little to show for it. What
did need fixing is what the split had done to the shared gates:

* ``_require_write`` existed twice, in two files, with two different
  docstrings, and the second copy was added late because the first file was the
  one module that did not enforce the read-only tier at all;
* three of the five routers imported that private name across a module
  boundary from a fourth, so the dependency graph ran through a leading
  underscore;
* the UTC coercer had three implementations under two names.

One definition each, here, imported publicly. ``get_superadmin`` proves the
caller is A super-admin; these decide what that super-admin may do.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException, status

from app.config import DISPLAY_USD_TO_INR
from app.core.pricing import display_price
from app.db.models import Client, Plan


def require_write(actor: Client) -> None:
    """Refuse a mutation from a read-only super-admin.

    ``superadmin_role == "readonly"`` is a real tier, assignable from the
    owner-gated client PATCH. Without this gate a read-only account could mint
    accounts and read back their fresh api_key, or hard-delete a customer and
    CASCADE away their bots, documents, conversations and messages.
    Irreversibly, and from an account granted precisely so it could not.
    """
    if getattr(actor, "superadmin_role", None) == "readonly":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Read-only super-admin: writes are not permitted.",
        )


def require_owner(actor: Client) -> None:
    """Only owner-tier super-admins may grant or change super-admin privileges.

    ``superadmin_role`` is one of ``owner|admin|readonly``. :func:`require_write`
    alone only blocks ``readonly``, which would let an ``admin``-tier actor
    promote themselves or any other account to super-admin. Privilege writes
    (``is_superadmin`` / ``superadmin_role``) must additionally pass this gate.
    """
    if getattr(actor, "superadmin_role", None) != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only an owner-tier super-admin may change super-admin privileges.",
        )


def as_utc(value: datetime | None) -> datetime | None:
    """Treat a naive datetime as UTC.

    Postgres hands back naive datetimes for ``timestamp without time zone``
    columns, and comparing one of those to an aware ``now()`` raises. Three
    copies of this existed under two names.
    """
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def to_usd_cents(amount_minor: int | None, currency: str | None) -> int:
    """Normalise a stored minor-unit amount to USD cents.

    Mirrors the customer-app display rule (``core.pricing.display_price``):
    INR-stored amounts are converted at the fixed ``DISPLAY_USD_TO_INR`` rate,
    USD amounts pass through unchanged. The super-admin dashboard reports a
    single canonical currency (USD), matching what international customers see.
    """
    minor = int(amount_minor or 0)
    if (currency or "usd").lower() == "inr":
        usd_cents, _ = display_price(inr_paise=minor, usd_cents=None, country=None, rate=DISPLAY_USD_TO_INR)
        return usd_cents
    return minor


def plan_monthly_usd_cents(plan: Plan, billing_cycle: str) -> int:
    """Monthly-equivalent USD cents for a plan on a given billing cycle.

    Prefers the plan's stored USD column (the exact gateway price) and falls
    back to converting the INR column only for legacy rows with no USD price.
    Identical precedence to ``PlanModal``'s ``PriceBlock`` on the frontend.
    """
    if billing_cycle == "annual" and (plan.annual_price_cents or plan.annual_price_usd_cents):
        annual_usd, _ = display_price(
            inr_paise=plan.annual_price_cents,
            usd_cents=plan.annual_price_usd_cents,
            country=None,
            rate=DISPLAY_USD_TO_INR,
        )
        return round(annual_usd / 12)  # round, not floor, so MRR isn't understated (M8)
    monthly_usd, _ = display_price(
        inr_paise=plan.monthly_price_cents,
        usd_cents=plan.monthly_price_usd_cents,
        country=None,
        rate=DISPLAY_USD_TO_INR,
    )
    return monthly_usd


# The console reports a single canonical currency so two customers on two price
# lists can be added together. Both helpers lived in the plans router and were
# imported from it by name, underscore and all, which is how a reporting
# convention ends up owned by whichever file happened to need it first.
