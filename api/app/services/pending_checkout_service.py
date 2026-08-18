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
Select again, the single most reasonable thing to do. Any fix that only
tightens the button misses it entirely; the retry is legitimate and the server
has to be the one that says "you already bought this".

The idempotency mechanism already existed. ``clients.pending_checkout_*``,
written by ``POST /subscriptions/checkout``, but ``/subscriptions/change-plan``
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
  every worker, an in-memory guard would only cover the one process that
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
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Client, Plan, Subscription

logger = logging.getLogger(__name__)

#: ``pending_checkout_bot_id`` for a mandate that funds a bot which does not
#: exist yet. ``POST /bots/checkout``, where the agent is deliberately not
#: created until the mandate is paid so a dismissed checkout leaves no orphan
#: rows. NULL means account-level and a positive id means an existing bot
#: (revive-in-place), so neither can express "a new bot" and the column would
#: otherwise have to be NULL, which is exactly the wrong-ledger collision
#: migration ``d5b1c8e2f394`` added it to prevent: an account-level in-flight
#: mandate would match a per-agent purchase, and activating it would fund the
#: account instead of creating the agent.
#:
#: Zero is safe as that third value because ``bots.id`` is a serial starting at
#: 1, and the column is a bare Integer with no foreign key, it is a scope tag,
#: not a reference. WHICH new bot is not encoded here at all; that lives in the
#: gateway notes and is compared through ``required_notes`` below.
NEW_BOT_SCOPE = 0


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
    required_notes: Mapping[str, str] | None = None,
    cancel_failure_is_fatal: bool = True,
) -> dict[str, Any] | None:
    """Resolve the in-flight mandate before a caller mints a new one.

    Returns the Checkout payload to hand straight back when the pending mandate
    can serve this request. Returns ``None`` when the caller should mint, by
    which point any superseded mandate has already been cancelled at Razorpay
    and the marker cleared.

    ``required_notes`` narrows reuse for a caller whose purchase is not fully
    described by (plan, cycle, country, bot scope). ``POST /bots/checkout`` is
    the case: it buys an agent that does not exist yet, so WHICH agent lives
    only in the mandate's gateway notes. See
    ``razorpay_service.per_bot_checkout_identity``. Notes that describe a
    different agent make the mandate non-reusable, and it is superseded exactly
    as a different plan would be.

    ``cancel_failure_is_fatal`` decides what a Razorpay failure during the
    supersede-CANCEL means, and the two answers are both correct for their
    caller, the question is only what the path did before it had a marker.
    Default ``True``: the account-level routes refuse (502) rather than mint
    beside a mandate they could not retire. ``False`` for ``POST
    /bots/checkout``, matching ``reuse_pending_upgrade``: that path has never
    cancelled anything, so leaving the handle for Razorpay to expire is
    precisely today's behaviour and a failed cancel is no worse than the
    attempt never having been made. While refusing would newly block agent
    purchases during a gateway wobble that currently succeed. The safety
    property holds either way: ``checkout_already_paid`` read this same mandate
    moments earlier and said unpaid, so nothing is minted beside a mandate
    whose state was never confirmed.

    Raises ``razorpay_service.RazorpayBillingError`` when the gateway could not
    be read, and when the supersede-cancel failed under
    ``cancel_failure_is_fatal``. Callers must surface that (502) and NOT mint: a
    fetch failure is not evidence the pending mandate is dead, and minting a
    sibling against a live authorizable one is the double-charge this module
    exists to prevent.

    Raises ``razorpay_service.SubscriptionActivationConflict`` (→ a 409 that
    tells the customer their payment DID arrive) when the pending mandate turns
    out to be already ACTIVE. Paid, but not yet materialised locally.
    """
    from app.services import razorpay_service

    if client_row is None:
        return None
    pending_id = client_row.pending_checkout_subscription_id
    if not pending_id:
        return None

    matches = _matches(client_row, plan_id=plan.id, billing_cycle=billing_cycle, country=country, bot_id=bot_id)

    # FIRST, before deciding anything else: has the customer already PAID this
    # mandate? This is the reported prod sequence, and it is not a double-click,
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
            "Client %s re-submitted a plan while in-flight checkout %s is already PAID. "
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
        reused = razorpay_service.rebuild_upgrade_checkout(
            pending_id, client, plan, billing_cycle, required_notes=required_notes
        )
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

    # Both roads lead here, the pending mandate cannot serve this request,
    # either because it describes a different purchase or because it is no
    # longer authorizable, so it must be retired before a replacement is minted.
    try:
        status = razorpay_service.cancel_superseded_checkout(pending_id)
    except razorpay_service.RazorpayBillingError:
        if cancel_failure_is_fatal:
            raise
        # ERROR, not WARNING: the caller overwrites the marker with the fresh
        # mandate, so this log line is the only remaining record that the old
        # handle is live. Same artifact ``reuse_pending_upgrade`` leaves when
        # its own supersede-cancel fails; see the parameter's docstring for why
        # this caller proceeds instead of refusing.
        logger.error(
            "Could not cancel superseded checkout %s for client %s before minting its replacement. "
            "the handle is STILL AUTHORIZABLE at Razorpay and can charge if the customer reopens that "
            "checkout. Proceeding with the purchase; needs manual cancellation.",
            pending_id,
            client.id,
            exc_info=True,
        )
    else:
        if status == "active":
            # Defence in depth: the paid check above already refuses this, but it
            # reads ``paid_count`` and this reads ``status``, and the two can move
            # apart for a moment. Whichever notices first, the answer is the same,
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


# ── The Subscription-row twin: upgrade / resume re-auth ──────────────────────
#
# ``clients.pending_checkout_*`` covers the FIRST mandate. An existing paying
# customer's replacement mandate is parked on the Subscription row instead
# (``upgrade_pending_subscription_id`` / ``upgrade_pending_plan_id``), written by
# ``transition_service.execute_paid_upgrade`` and ``/subscriptions/resume``
# Mode 2. Different column, identical hazard, and both sites had the same
# defect this module was created to fix: they re-mint whenever
# ``rebuild_upgrade_checkout`` answers ``None``, which it does just as readily
# for a mandate the customer has already PAID as for one they abandoned.
#
# It missed the reported incident only because both affected clients were first
# purchases. An existing paying customer upgrading is a more valuable account to
# double-charge, not a less likely one.
#
# The supersede half is shared too: a retry the marker cannot serve retires the
# mandate at Razorpay via ``cancel_superseded_checkout``, exactly as
# ``reuse_or_supersede`` does. Leaving it to expire (the behaviour until now)
# leaves the customer holding a live payment handle for a plan they walked away
# from, and Razorpay keeps a ``created`` subscription authorizable indefinitely:
# a stale checkout reopened weeks later from an email or a back button still
# charges. Nothing else retires it, either, no cron sweeps abandoned mandates,
# and the activation handler's sibling sweep only knows the mandate named in the
# new subscription's ``prev_razorpay_subscription_id``, which the superseded one
# never is.
#
# One difference from the twin, and it is deliberate: a gateway failure during
# that cancel is logged, not raised. See :func:`reuse_pending_upgrade`.


def reuse_pending_upgrade(
    session: Session,
    *,
    sub: Subscription,
    client: Client,
    plan: Plan,
    billing_cycle: str,
) -> dict[str, Any] | None:
    """Resolve the in-flight REPLACEMENT mandate before a caller mints another.

    Returns the Checkout payload when the pending mandate can serve this
    request, or ``None`` when the caller should mint, by which point the
    superseded mandate has been cancelled at Razorpay (or the failure to do so
    logged at ERROR) and the marker cleared. Callers package the payload
    themselves. ``/resume`` wraps it in a ``reauthorise_required`` envelope,
    the upgrade path returns it directly.

    Raises ``razorpay_service.SubscriptionActivationConflict`` when the pending
    mandate has ALREADY been paid. That check runs before the plan-id match, not
    after: a customer who paid and then asked for a *different* plan is in the
    same position as one who re-asked for the same plan, and neither may be
    handed a fresh mandate while the paid one is still unmaterialised. It is
    raised again if the mandate turns out to be ``active`` at the moment it
    would be cancelled, the two facts (``paid_count`` and ``status``) can move
    apart for a moment, and whichever notices first, the answer is the same.

    Raises ``razorpay_service.RazorpayBillingError`` if the gateway cannot be
    READ, never guess. A failed CANCEL is different and does not raise; see
    below.
    """
    from app.services import razorpay_service

    pending_id = sub.upgrade_pending_subscription_id
    if not pending_id:
        return None

    if razorpay_service.checkout_already_paid(pending_id):
        logger.info(
            "Client %s re-submitted a plan change while pending mandate %s (sub %s) is already PAID. "
            "refusing to open another payment sheet",
            client.id,
            pending_id,
            sub.id,
        )
        raise razorpay_service.SubscriptionActivationConflict(
            razorpay_subscription_id=pending_id,
            client_id=client.id,
            # Only name the plan when this request IS the one they paid for.
            plan_name=getattr(plan, "name", None) if sub.upgrade_pending_plan_id == plan.id else None,
        )

    if sub.upgrade_pending_plan_id == plan.id:
        reused = razorpay_service.rebuild_upgrade_checkout(pending_id, client, plan, billing_cycle)
        if reused is not None:
            reused.setdefault("provider", "razorpay")
            logger.info(
                "Reusing pending replacement mandate %s for client %s → plan %s",
                pending_id,
                client.id,
                plan.slug,
            )
            return reused
        # Unpaid AND not reusable: abandoned, or minted on the other rail (an
        # annual pending against a monthly request). Either way it cannot serve
        # this request, and the rail-mismatch shape is still authorizable, so
        # it is a live handle exactly like a different-plan pending.
        logger.info("Pending replacement mandate %s for client %s cannot serve this request", pending_id, client.id)
    else:
        logger.info(
            "Superseding pending replacement mandate %s for client %s: requested plan %s differs from the pending %s",
            pending_id,
            client.id,
            plan.id,
            sub.upgrade_pending_plan_id,
        )

    # Both roads lead here, as in ``reuse_or_supersede``: the pending mandate
    # cannot serve this request, so it is retired at the gateway BEFORE its
    # replacement is minted. Left alone it stays authorizable indefinitely, and
    # a customer who reopens that stale checkout weeks later (from the re-auth
    # email, a back button, a tab they never closed) is charged for a plan they
    # never took. A redundant cancel is harmless:
    # ``cancel_superseded_checkout`` re-reads the mandate and only issues the
    # cancel from an authorizable state, so a webhook or a retry that already
    # retired it is a no-op returning the terminal status.
    try:
        status = razorpay_service.cancel_superseded_checkout(pending_id)
    except razorpay_service.RazorpayBillingError:
        # NOT fatal here, unlike the first-mandate twin. The customer is trying
        # to give us money; a Razorpay 5xx while tidying up a handle they have
        # abandoned must not come back as a failed purchase. The safety property
        # the twin protects is intact either way. ``checkout_already_paid``
        # read this same mandate successfully moments ago and said unpaid, so we
        # are not minting beside a mandate whose state was never confirmed, only
        # beside one whose cancel did not land. And the fallback is precisely
        # today's behaviour on this path (leave it for Razorpay to expire), so a
        # failed cancel is no worse than not attempting one. Whereas refusing
        # would newly block upgrades during a gateway wobble that currently
        # succeed.
        #
        # ERROR, not WARNING: the caller overwrites the marker with the fresh
        # mandate, so this log line is the only remaining record that the old
        # handle is live. It is the same artifact the activation handler leaves
        # when its own supersede-cancel fails.
        logger.error(
            "Could not cancel superseded replacement mandate %s for client %s (sub %s) before minting "
            "its replacement, the handle is STILL AUTHORIZABLE at Razorpay and can charge if the "
            "customer reopens that checkout. Proceeding with the purchase; needs manual cancellation.",
            pending_id,
            client.id,
            sub.id,
            exc_info=True,
        )
    else:
        if status == "active":
            # Defence in depth against the paid check above, which asks
            # ``paid_count`` while this asks ``status``; the two can move apart
            # for a moment. Nothing was cancelled (only the activation sweep may
            # retire a live mandate), so minting now would leave two CHARGED
            # subscriptions for one month.
            raise razorpay_service.SubscriptionActivationConflict(
                razorpay_subscription_id=pending_id,
                client_id=client.id,
            )

    sub.upgrade_pending_subscription_id = None
    sub.upgrade_pending_plan_id = None
    session.flush()
    return None
