"""One in-flight FIRST mandate per client, across every route that mints one.

Razorpay cannot swap a UPI mandate's plan in place, so every "buy a plan" path
mints a fresh authorizable subscription. If the customer retries and the retry
mints ANOTHER one, both can be authorised and both charge a full cycle. Prod
client 18 authorised ``sub_TPaGNnEfFML4Lr`` and ``sub_TPaHBPNyYV3tfe`` for the
same month and paid ₹11,998 for one ₹5,999 subscription; client 8 did the same
with two Professional mandates 44 seconds apart.

Note the 44 seconds. This is not a double-click, and a frontend submit latch
does not reach it. The customer paid on the Launch Studio welcome screen, the
plan card did not change, they waited for feedback that never came, and clicked
Select again — the single most reasonable thing to do. Any fix that only
tightens the button misses it entirely; the retry is legitimate and the server
has to be the one that says "you already bought this".

The idempotency mechanism already existed — ``clients.pending_checkout_*``,
written by ``POST /subscriptions/checkout`` — but ``/subscriptions/change-plan``
Branch 3 mints exactly the same kind of first mandate (trial→paid, Free→paid,
revive-in-place) and never consulted it. This module is that one mechanism,
extracted so both routes share it rather than growing a second, competing one.

Three rules, and the differences between them are the whole point:

* **Already paid → refuse.** Checked first, on ``paid_count``, because Razorpay's
  status lags its own money: the mandate both prod customers had already paid
  still read ``created``, which is indistinguishable from an abandoned checkout
  by state alone. Re-opening a payment sheet here is the defect. The refusal is
  a ``SubscriptionActivationConflict`` whose customer-facing sentence leads with
  the payment having worked and says not to pay again.
* **Same key, unpaid → reuse.** The key is (plan, cycle, confirmed country, bot
  scope): everything that changes WHICH mandate a customer would end up
  authorising. A retry under the same key gets the SAME gateway subscription id
  back, so the frontend re-opens the same Razorpay handle.
* **Different key, unpaid → supersede.** A genuinely different purchase needs a
  new mandate, but the old one is still authorizable at Razorpay, indefinitely.
  It is cancelled at the gateway in the same operation, before the replacement
  is minted, so it can never charge.

Durability and concurrency are deliberately not this module's invention:

* The marker is a DB column, so it survives a process restart and is visible to
  every worker — an in-memory guard would only cover the one process that
  happened to serve the first click.
* Both callers hold ``plan_service.lock_client_for_billing`` (a transaction-
  scoped Postgres advisory lock) for the whole read-decide-mint-write sequence,
  so two concurrent requests serialise: the loser reads the winner's COMMITTED
  marker and reuses it. A bare read-then-write would let both pass the read.

Staleness is decided by the gateway, never by a TTL:
``razorpay_service.rebuild_upgrade_checkout`` returns ``None`` once the pending
subscription is no longer authorizable, and only then is the marker cleared.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Client, Plan

logger = logging.getLogger(__name__)


def _matches(
    client_row: Client,
    *,
    plan_id: int,
    billing_cycle: str,
    country: str,
    bot_id: int | None,
) -> bool:
    """Does the stored marker describe the purchase being requested now?

    Defaults mirror the columns' meaning for rows written before a field
    existed: no cycle means monthly, no country means the domestic (INR) rail,
    no bot means account-level.
    """
    return (
        client_row.pending_checkout_plan_id == plan_id
        and (client_row.pending_checkout_cycle or "monthly") == billing_cycle
        and (client_row.pending_checkout_country or "IN") == country
        and client_row.pending_checkout_bot_id == bot_id
    )


def clear(client_row: Client) -> None:
    """Forget the in-flight checkout. Callers flush/commit."""
    client_row.pending_checkout_subscription_id = None
    client_row.pending_checkout_plan_id = None
    client_row.pending_checkout_cycle = None
    client_row.pending_checkout_country = None
    client_row.pending_checkout_bot_id = None
    client_row.pending_checkout_at = None


def record(
    client_row: Client,
    *,
    subscription_id: str | None,
    plan_id: int,
    billing_cycle: str,
    country: str,
    bot_id: int | None = None,
) -> None:
    """Remember the mandate just minted, so the next retry can reuse it.

    Cleared by ``_handle_subscription_activated`` once the customer authorises,
    and by :func:`reuse_or_supersede` when the gateway says it is dead.
    """
    client_row.pending_checkout_subscription_id = subscription_id
    client_row.pending_checkout_plan_id = plan_id
    client_row.pending_checkout_cycle = billing_cycle
    client_row.pending_checkout_country = country
    client_row.pending_checkout_bot_id = bot_id
    client_row.pending_checkout_at = datetime.now(UTC)


def reuse_or_supersede(
    session: Session,
    *,
    client_row: Client | None,
    client: Client,
    plan: Plan,
    billing_cycle: str,
    country: str,
    bot_id: int | None = None,
) -> dict[str, Any] | None:
    """Resolve the in-flight mandate before a caller mints a new one.

    Returns the Checkout payload to hand straight back when the pending mandate
    can serve this request. Returns ``None`` when the caller should mint — by
    which point any superseded mandate has already been cancelled at Razorpay
    and the marker cleared.

    Raises ``razorpay_service.RazorpayBillingError`` when the gateway could not
    be read or the supersede-cancel failed. Callers must surface that (502) and
    NOT mint: a fetch failure is not evidence the pending mandate is dead, and
    minting a sibling against a live authorizable one is the double-charge this
    module exists to prevent.

    Raises ``razorpay_service.SubscriptionActivationConflict`` (→ a 409 that
    tells the customer their payment DID arrive) when the pending mandate turns
    out to be already ACTIVE — paid, but not yet materialised locally.
    """
    from app.services import razorpay_service

    if client_row is None:
        return None
    pending_id = client_row.pending_checkout_subscription_id
    if not pending_id:
        return None

    matches = _matches(client_row, plan_id=plan.id, billing_cycle=billing_cycle, country=country, bot_id=bot_id)

    # FIRST, before deciding anything else: has the customer already PAID this
    # mandate? This is the reported prod sequence, and it is not a double-click —
    # the plan card never updated after payment, so the customer waited (44
    # seconds, for client 8) and clicked Select again.
    #
    # Every branch below would get that case wrong, because Razorpay's status
    # lags its own money: the mandate still reads ``created``, so
    # ``rebuild_upgrade_checkout`` calls it authorizable and hands back a payment
    # sheet for a plan that is already bought. ``paid_count`` is the only
    # question whose answer separates "abandoned checkout, re-open it" from
    # "paid checkout, stop", and it costs one gateway read on a retry. Worth it:
    # the alternative is charging the month twice.
    if razorpay_service.checkout_already_paid(pending_id):
        logger.info(
            "Client %s re-submitted a plan while in-flight checkout %s is already PAID — "
            "refusing to open another payment sheet",
            client.id,
            pending_id,
        )
        raise razorpay_service.SubscriptionActivationConflict(
            razorpay_subscription_id=pending_id,
            client_id=client.id,
            # Name the plan only when this request IS the one they paid for.
            # On a different-plan retry the pending mandate bought something
            # else, and "Your Professional payment went through" would be false.
            plan_name=getattr(plan, "name", None) if matches else None,
        )

    if matches:
        reused = razorpay_service.rebuild_upgrade_checkout(pending_id, client, plan, billing_cycle)
        if reused is not None:
            reused.setdefault("provider", "razorpay")
            logger.info(
                "Reusing in-flight checkout %s for client %s (plan %s, %s, bot %s)",
                pending_id,
                client.id,
                plan.id,
                billing_cycle,
                bot_id,
            )
            return reused
        logger.info("In-flight checkout %s for client %s is no longer reusable for this request", pending_id, client.id)
    else:
        logger.info(
            "Superseding in-flight checkout %s for client %s: requested plan %s (%s, %s, bot %s) "
            "differs from the pending plan %s (%s, %s, bot %s)",
            pending_id,
            client.id,
            plan.id,
            billing_cycle,
            country,
            bot_id,
            client_row.pending_checkout_plan_id,
            client_row.pending_checkout_cycle,
            client_row.pending_checkout_country,
            client_row.pending_checkout_bot_id,
        )

    # Both roads lead here — the pending mandate cannot serve this request,
    # either because it describes a different purchase or because it is no
    # longer authorizable — so it must be retired before a replacement is minted.
    status = razorpay_service.cancel_superseded_checkout(pending_id)
    if status == "active":
        # Defence in depth: the paid check above already refuses this, but it
        # reads ``paid_count`` and this reads ``status``, and the two can move
        # apart for a moment. Whichever notices first, the answer is the same —
        # nothing was cancelled (only the activation sweep may retire a live
        # mandate), so minting now would leave two CHARGED subscriptions for one
        # month.
        raise razorpay_service.SubscriptionActivationConflict(
            razorpay_subscription_id=pending_id,
            client_id=client.id,
        )
    clear(client_row)
    session.flush()
    return None
