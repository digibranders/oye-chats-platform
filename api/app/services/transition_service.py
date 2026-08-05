"""Plan transition orchestration — upgrades, downgrades, scheduled cutovers.

This module is the single source of truth for everything paid→paid
subscription transitions need:

  * Remaining-credit lookup for upgrade rollover (``remaining_plan_credits``).
  * Razorpay-specific paid→paid upgrade flow (``execute_paid_upgrade``):
    open a new sub and stash the customer's unused plan credits so the
    activation webhook can re-grant them as a top-up once payment clears.
    The OLD mandate is NOT cancelled here — under the UPI re-auth model it
    stays live until the new subscription authorizes and is retired at the
    new sub's activation webhook (so an abandoned checkout can't strand the
    customer).
  * Razorpay-specific paid→paid downgrade flow (``schedule_paid_downgrade``):
    queue the new plan to take effect at the current period's end. The old
    mandate is cancelled at-period-end on the gateway so Razorpay stops
    debiting after the current cycle.
  * Promotion of a queued change (``promote_scheduled_change``): called by
    both the ``subscription.completed`` webhook and the daily ARQ cron
    safety-net so whichever path fires first wins.
  * Seat-overflow guard (``check_seat_overflow``): refuses to schedule a
    downgrade when the customer has more active operators than the target
    plan allows; the route turns this into a 409 with the seat-picker
    payload the frontend renders.

Rollover model: unused **plan_grant** credits from the old subscription
are carried into the new subscription as a ``topup`` grant (12-month
expiry, same as a normal top-up). We snapshot the unused count *before*
cancelling the old mandate, then the activation webhook re-grants that
amount after the new plan's allowance is provisioned. This means the
customer never loses message credits they've already paid for, regardless
of how many days are left in the old billing cycle.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.dates import add_months
from app.db.models import Client, Operator, Plan, Subscription
from app.services import credit_service, email_service

logger = logging.getLogger("oyechats.transitions")


# ``cancel_reason`` stamped on the short-lived GRACE subscription created at a
# paid→paid downgrade cutover (see ``promote_scheduled_change``). The grace row
# holds the customer at the TARGET plan's entitlements — never Free — during the
# window where they still owe the one-time UPI re-authorization of the new
# mandate. The marker distinguishes it from a genuine failed-payment ``past_due``
# so the dunning email / recovery paths skip it, while the existing
# ``task_expire_past_due_subscriptions`` cron still expires it to Free after
# ``PAYMENT_FAILED_GRACE_DAYS`` if the customer never re-authorizes.
DOWNGRADE_REAUTH_GRACE_REASON = "awaiting_downgrade_reauth"


# ── Rollover ──────────────────────────────────────────────────────────────────


def remaining_plan_credits(session: Session, client_id: int) -> int:
    """Unused ``plan_grant`` credits the client still owns on the current cycle.

    Reads the live FIFO breakdown so the number reflects every chat that
    has already burned credits this month. Top-up credits are excluded —
    they're never cleared at renewal and carry over to the new
    subscription on their own.
    """
    breakdown = credit_service.get_balance_breakdown(session, client_id)
    return int(breakdown.get("plan", 0) or 0)


# ── Seat overflow ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SeatOverflow:
    """Returned by ``check_seat_overflow`` when the customer can't downgrade yet."""

    active_seats: int
    allowed_seats: int

    @property
    def excess(self) -> int:
        return max(0, self.active_seats - self.allowed_seats)


def check_seat_overflow(session: Session, client_id: int, target_plan: Plan) -> SeatOverflow | None:
    """Return ``SeatOverflow`` if active operator count exceeds the new plan's seats.

    Returns ``None`` when the customer is already within the new plan's
    seat allowance. The caller decides whether to refuse the transition
    or merely warn — this helper is intentionally pure.
    """
    allowed = int(target_plan.included_operator_seats or 0)
    active = int(
        session.scalar(
            select(func.count(Operator.id)).where(
                Operator.client_id == client_id,
                Operator.is_active.is_(True),
            )
        )
        or 0
    )
    if active <= allowed:
        return None
    return SeatOverflow(active_seats=active, allowed_seats=allowed)


# ── Document overflow ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class DocumentOverflow:
    """Returned by ``check_document_overflow`` when the customer can't downgrade yet."""

    current_documents: int
    allowed_documents: int

    @property
    def excess(self) -> int:
        return max(0, self.current_documents - self.allowed_documents)


def check_document_overflow(session: Session, client_id: int, target_plan: Plan) -> DocumentOverflow | None:
    """Return ``DocumentOverflow`` if uploaded-document count exceeds the target plan.

    Mirrors :func:`check_seat_overflow` for the knowledge base: a paid→paid
    downgrade to a tier with a smaller ``limits.documents`` allowance is refused
    until the customer deletes enough uploaded documents to fit. Unlike operator
    seats (a hard ceiling), documents are otherwise grandfathered at upload time,
    so this guard is what turns "downgrade" into an explicit "get under the limit
    first" decision instead of a silent over-quota state.

    Counting matches ``plan_entitlements_service._build_usage`` exactly — distinct
    ``document_name`` WHERE ``source == 'upload'`` — so the number the block quotes
    is the same one the customer sees in their usage panel. Crawled pages are
    governed by the per-period ``page_scraping`` credit budget, not this stored
    cap, so they are intentionally excluded.

    Returns ``None`` when the plan's ``documents`` limit is ``UNLIMITED`` (``-1``),
    missing, or already satisfied — the helper is pure; the caller decides whether
    to refuse or merely warn.
    """
    from sqlalchemy import distinct

    from app.db.models import Document

    limits = target_plan.limits or {}
    raw_allowed = limits.get("documents")
    # UNLIMITED (-1) or an unset cap → nothing to enforce.
    if raw_allowed is None or int(raw_allowed) < 0:
        return None
    allowed = int(raw_allowed)

    current = int(
        session.scalar(
            select(func.count(distinct(Document.document_name))).where(
                Document.client_id == client_id,
                Document.source == "upload",
            )
        )
        or 0
    )
    if current <= allowed:
        return None
    return DocumentOverflow(current_documents=current, allowed_documents=allowed)


# ── Upgrade (paid → paid, immediate, Razorpay) ────────────────────────────────


def execute_paid_upgrade(
    session: Session,
    client: Client,
    sub: Subscription,
    new_plan: Plan,
    billing_cycle: str,
) -> dict[str, Any]:
    """Open a checkout sheet for the new plan (UPI re-auth model, BL-2).

    Does NOT cancel the current mandate — the old subscription stays live
    until the new one authorizes, then is retired at the new sub's
    activation webhook (see ``_handle_subscription_activated``'s sibling
    sweep). Snapshots the customer's unused plan credits on the OLD sub's
    row so the activation webhook can re-grant them as a top-up after
    payment clears — keeping the route handler free of cross-step state.
    Returns the Razorpay checkout payload the frontend hands to
    ``new Razorpay({...})``.

    NOTE on ``upgrade_credit_pending_cents``: the column name is historical
    (the original implementation stored a currency proration in cents).
    It now stores an integer **credit count**. We kept the column name to
    avoid an Alembic migration just for the rename; semantics are
    documented here and at the call sites.

    Raises:
        RazorpayBillingError: gateway-side creation of the new subscription failed.
    """
    from app.services import razorpay_service

    # Finding D: idempotent upgrade. A sequential double-submit (click → modal →
    # close → click again) must not mint a SECOND Razorpay subscription — both
    # first cycles would charge. lock_client_for_billing only serialises
    # CONCURRENT requests, not a sequential re-submit. If an upgrade to the SAME
    # target plan is already in flight on this sub, return its existing checkout.
    # A different target plan supersedes the stale pending (its unauthorised
    # Razorpay sub never charges and Razorpay expires it).
    if sub.upgrade_pending_subscription_id and sub.upgrade_pending_plan_id == new_plan.id:
        reused = razorpay_service.rebuild_upgrade_checkout(
            sub.upgrade_pending_subscription_id, client, new_plan, billing_cycle
        )
        if reused is not None:
            logger.info(
                "Reusing pending upgrade checkout %s for client %s → plan %s",
                sub.upgrade_pending_subscription_id,
                client.id,
                new_plan.slug,
            )
            return reused
        # The pending checkout was abandoned and is no longer authorizable — clear
        # the stale marker and fall through to mint a fresh one (M3), so the
        # customer isn't stranded with a dead checkout.
        logger.info(
            "Pending upgrade checkout %s for client %s is dead; re-minting",
            sub.upgrade_pending_subscription_id,
            client.id,
        )
        sub.upgrade_pending_subscription_id = None
        sub.upgrade_pending_plan_id = None
        session.flush()

    # Snapshot unused plan credits BEFORE the new plan's allowance is granted —
    # the activation webhook will call ``reset_monthly_plan_credits`` before
    # granting the new allowance, so reading the breakdown later would return 0.
    rollover_credits = remaining_plan_credits(session, client.id)

    # DO NOT cancel the old mandate here (BL-2). Razorpay's UPI mandates can't be
    # swapped in place, so a plan change is cancel+recreate+re-authorize. Under
    # the re-auth model the OLD mandate must stay live until the NEW subscription
    # authorizes; if we hard-cancelled it now and the customer abandoned the
    # Razorpay checkout modal, they'd be stranded — old service gone, new never
    # authorized, and the rollover credits stuck in ``upgrade_credit_pending_cents``.
    # The old sub is retired instead at the NEW sub's activation webhook, where
    # ``_handle_subscription_activated`` gateway-cancels the superseded sibling
    # (identified via ``prev_razorpay_subscription_id`` in the new sub's notes).

    sub.upgrade_credit_pending_cents = rollover_credits
    sub.cancel_reason = sub.cancel_reason or "auto_upgrade"
    session.flush()

    payload = razorpay_service.create_subscription(
        session,
        client,
        new_plan,
        billing_cycle,
        extra_notes={"prev_razorpay_subscription_id": sub.razorpay_subscription_id or ""},
    )
    payload.setdefault("rollover_credits", rollover_credits)
    payload["prev_razorpay_subscription_id"] = sub.razorpay_subscription_id

    # Finding D: record the in-flight checkout so a sequential re-submit for the
    # same target plan reuses it instead of minting another sub. Cleared at
    # activation (apply_pending_proration).
    sub.upgrade_pending_subscription_id = payload.get("subscription_id")
    sub.upgrade_pending_plan_id = new_plan.id
    session.flush()

    logger.info(
        "Upgrade queued: client=%s %s → %s, rollover=%d credits",
        client.id,
        sub.plan.slug if sub.plan else "?",
        new_plan.slug,
        rollover_credits,
    )
    return payload


# ── Downgrade (paid → paid, scheduled at period end, Razorpay) ────────────────


def schedule_paid_downgrade(
    session: Session,
    sub: Subscription,
    new_plan: Plan,
    billing_cycle: str,
) -> datetime:
    """Queue ``new_plan`` to take effect at ``sub.current_period_end``.

    The gateway mandate is cancelled ``at_period_end=True`` so Razorpay
    stops debiting after the current cycle. Local state captures the
    pending change; the webhook (or cron) promotes it at cutover.

    Returns the cutover datetime.

    Raises:
        ValueError: when the subscription has no period anchor to schedule against.
        RazorpayBillingError: gateway-side scheduling failed.
    """
    from app.services import razorpay_service

    if not sub.current_period_end:
        raise ValueError("Subscription has no current_period_end — cannot schedule cutover")

    razorpay_service.cancel_subscription(sub, at_period_end=True)

    sub.cancel_at_period_end = True
    sub.scheduled_plan_id = new_plan.id
    sub.scheduled_billing_cycle = billing_cycle
    sub.scheduled_change_at = sub.current_period_end
    sub.cancel_reason = sub.cancel_reason or "scheduled_downgrade"
    session.flush()

    logger.info(
        "Downgrade scheduled: client=%s %s → %s at %s",
        sub.client_id,
        sub.plan.slug if sub.plan else "?",
        new_plan.slug,
        sub.scheduled_change_at.isoformat(),
    )
    return sub.scheduled_change_at


# ── Reversibility ─────────────────────────────────────────────────────────────


def cancel_scheduled_change(session: Session, sub: Subscription) -> bool:
    """Clear a queued downgrade. Returns True if one was actually queued.

    Idempotent: returns False (no error) when called on a subscription
    that has no scheduled change. The caller decides whether to resurrect
    the gateway mandate (most providers require a new auth) — this helper
    only owns local state because the resurrection path is provider-
    specific.
    """
    if not sub.scheduled_plan_id:
        return False

    sub.scheduled_plan_id = None
    sub.scheduled_billing_cycle = None
    sub.scheduled_change_at = None
    # We intentionally leave ``cancel_at_period_end`` alone — if the
    # caller wants to keep the existing mandate live they must call the
    # gateway resume helper separately; otherwise the row honestly
    # reflects that the customer is still on the cancellation track.
    session.flush()

    logger.info(
        "Scheduled change cancelled for sub=%s (client=%s)",
        sub.id,
        sub.client_id,
    )
    return True


# ── Promotion (called by webhook + cron) ──────────────────────────────────────


def promote_scheduled_change(session: Session, sub: Subscription) -> dict[str, Any] | None:
    """Promote a queued scheduled change into a fresh Razorpay subscription.

    Idempotent: returns ``None`` if there's nothing to promote (already
    promoted or never scheduled). Returns the new Razorpay checkout
    payload otherwise. The customer still needs to authorise the new
    mandate — this function emails them that re-auth link itself (via
    ``short_url``) so the cutover never silently strands them (NB-3).
    """
    from app.services import plan_service, razorpay_service

    # Serialize the promotion decision so a webhook (subscription.cancelled /
    # subscription.completed) and the cron backstop can't both read a non-null
    # ``scheduled_plan_id`` before either clears it and each spin up a duplicate
    # Razorpay subscription + re-auth email for one cutover (Fix A). We take the
    # same per-client advisory lock every customer billing route contends on,
    # then re-read the row under a row lock so we observe any concurrent commit
    # that already promoted it. ``pg_advisory_xact_lock`` is a no-op on
    # non-PostgreSQL binds (mocked unit sessions); the row refresh below is the
    # portable half of the guard.
    plan_service.lock_client_for_billing(session, sub.client_id)

    # Flush before refresh so ``refresh(..., with_for_update=True)`` sees our own
    # pending writes (autoflush is off), then reloads the latest committed row
    # under ``SELECT ... FOR UPDATE`` — the T5 pattern from
    # ``credit_service.grant_subscription_period_once``. A racing caller that
    # already cleared the scheduled trio and committed will now be visible here,
    # so the re-check below no-ops instead of double-provisioning.
    bind = session.get_bind()
    if bind is not None and bind.dialect.name == "postgresql":
        session.flush()
        session.refresh(sub, with_for_update=True)

    if not sub.scheduled_plan_id:
        return None

    new_plan = session.get(Plan, sub.scheduled_plan_id)
    if new_plan is None:
        logger.warning(
            "Scheduled change for sub=%s points at missing plan_id=%s — clearing",
            sub.id,
            sub.scheduled_plan_id,
        )
        sub.scheduled_plan_id = None
        sub.scheduled_billing_cycle = None
        sub.scheduled_change_at = None
        session.flush()
        return None

    billing_cycle = sub.scheduled_billing_cycle or "monthly"
    client = sub.client
    # Snapshot the old plan name before we clear the row — used in the
    # customer notification below.
    old_plan_name = sub.plan.name if sub.plan else "your previous plan"

    # The operator-seat add-on is a SEPARATE Razorpay subscription (P0-3).
    # Nothing else in the scheduled-downgrade path (``schedule_paid_downgrade``,
    # the cancelled-webhook path, or the cron backstop that calls this function)
    # ever cancels it, so left alone it survives the cutover as an orphan —
    # still billing the now-defunct old mandate forever. Cancel it here and
    # carry the seat count forward via the new subscription's Razorpay notes;
    # ``_handle_subscription_activated`` re-creates it on the new subscription
    # once that activation webhook lands, so the customer's paid seats aren't
    # silently dropped by the plan change.
    carried_seats = int(sub.seat_addon_quantity or 0) if sub.seat_addon_subscription_id else 0
    if sub.seat_addon_subscription_id:
        try:
            razorpay_service.cancel_seat_addon(session, sub)
        except Exception:
            logger.error(
                "Seat add-on cancel FAILED for subscription %s (seat add-on %s, client %s) "
                "during scheduled-downgrade promotion — the old seat add-on mandate is "
                "STILL LIVE at Razorpay and will keep debiting the customer on top of the "
                "new subscription. Needs manual reconciliation.",
                sub.id,
                sub.seat_addon_subscription_id,
                client.id if client else None,
                exc_info=True,
            )
            carried_seats = (
                0  # unknown gateway state — don't compound it by re-creating a seat count we can't confirm was cleared
            )

    # Mark the old sub finalized first so the partial-unique index on
    # (client_id, status in active|trialing|past_due) doesn't trip when
    # ``_handle_subscription_activated`` later inserts the new row. This
    # ordering (terminal flip + flush BEFORE create_subscription) is what
    # keeps the index satisfied regardless of whether the row arrived here
    # as ``active`` (completed/cron path) or ``canceled`` (cancelled-webhook
    # path). We do NOT downgrade a row that already went terminal.
    if sub.status not in ("expired", "canceled"):
        sub.status = "expired"
    sub.scheduled_plan_id = None
    sub.scheduled_billing_cycle = None
    sub.scheduled_change_at = None
    session.flush()

    # Hold the customer at the TARGET plan's entitlements — never Free — for the
    # re-authorization window. The old row just went terminal and the freshly
    # created Razorpay mandate below is UNAUTHORIZED, so without a local row
    # ``get_client_subscription`` would find nothing active and entitlements
    # would fall back to Free until the customer re-authorizes (which may be
    # never). This short-lived ``past_due`` grace row on ``new_plan`` keeps the
    # active-set populated so the customer lands on the plan they downgraded TO.
    #
    # It deliberately carries NO gateway mandate (``razorpay_subscription_id``
    # stays NULL): the real ``subscription.activated`` for the new mandate then
    # takes the clean "local is None" branch in ``_handle_subscription_activated``
    # (grants the target allowance), rather than the reactivation branch that
    # would not grant the new period's credits.
    #
    # Cleanup of THIS grace row at that activation depends on ``bot_id``:
    #   * Account-level downgrade (``bot_id IS NULL``, the common path): the
    #     activation sibling-cancel sweep already clears active-set rows WHERE
    #     ``bot_id IS NULL``, so it cancels this grace row for free.
    #   * Per-bot downgrade (``bot_id IS NOT NULL``): that sweep does NOT touch
    #     bot-scoped rows, and ``ix_subscriptions_client_bot_active`` is a UNIQUE
    #     partial index allowing only ONE active-set row per (client, bot).
    #     CONTRACT for the per-bot activation branch: before inserting the new
    #     bot-scoped active row it MUST cancel any ``status='past_due'`` row for
    #     the same (client_id, bot_id) whose ``cancel_reason`` equals
    #     ``DOWNGRADE_REAUTH_GRACE_REASON`` — otherwise the insert collides on
    #     that unique index and activation fails. Until that lands (today's
    #     activation still creates a ``bot_id IS NULL`` row), a bot-scoped grace
    #     row merely self-heals via the expire cron below (≤ 7 days): stale data
    #     at worst, never a lost downgrade or a blocked re-auth.
    #
    # If the customer never re-authorizes, ``task_expire_past_due_subscriptions``
    # flips this row to ``expired`` after ``PAYMENT_FAILED_GRACE_DAYS`` (7 days)
    # via ``past_due_since`` — at which point they correctly drop to Free. No
    # credits are granted here: the balance simply carries until real activation.
    grace_start = datetime.now(UTC)
    grace = Subscription(
        client_id=sub.client_id,
        plan_id=new_plan.id,
        bot_id=sub.bot_id,
        status="past_due",
        billing_cycle=billing_cycle,
        operator_quantity=1,
        current_period_start=grace_start,
        current_period_end=add_months(grace_start, 12 if billing_cycle == "annual" else 1),
        past_due_since=grace_start,
        payment_provider="razorpay",
        razorpay_subscription_id=None,
        prev_razorpay_subscription_id=sub.razorpay_subscription_id or None,
        cancel_reason=DOWNGRADE_REAUTH_GRACE_REASON,
    )
    grace.plan = new_plan
    session.add(grace)
    session.flush()

    # The old (higher-tier) subscription just expired and the grace row now
    # carries the target-tier entitlements, so cached entitlements are stale.
    # Drop them immediately instead of waiting out the 60s TTL, so the downgrade
    # takes effect at cutover.
    if client is not None:
        from app.services import plan_entitlements_service

        plan_entitlements_service.invalidate(client.id)

    payload = razorpay_service.create_subscription(
        session,
        client,
        new_plan,
        billing_cycle,
        extra_notes={
            "prev_razorpay_subscription_id": sub.razorpay_subscription_id or "",
            "carried_seat_count": str(carried_seats),
        },
    )
    payload["prev_razorpay_subscription_id"] = sub.razorpay_subscription_id
    payload["status"] = "scheduled_change_promoted"

    # Notify the customer with the hosted re-auth link so they can authorise
    # the new (lower) plan's UPI mandate. Without this the cutover leaves them
    # with no active subscription and no path back (NB-3). A failed email must
    # NOT roll back the promotion — the checkout already exists and is
    # reconcilable via ``prev_razorpay_subscription_id`` on the new sub — so we
    # swallow send errors here (the send helper also captures them).
    reauth_url = payload.get("short_url")
    if reauth_url and client and client.email:
        try:
            email_service.send_downgrade_reauth_email(
                to_email=client.email,
                name=client.name,
                old_plan_name=old_plan_name,
                new_plan_name=new_plan.name,
                reauth_url=reauth_url,
            )
        except Exception:
            logger.exception(
                "promote_scheduled_change: re-auth email failed for client=%s (promotion stands)",
                client.id,
            )
    else:
        logger.warning(
            "promote_scheduled_change: no re-auth link/email for client=%s (short_url=%r) — "
            "customer must be reconciled manually",
            client.id if client else None,
            reauth_url,
        )

    logger.info(
        "Scheduled change promoted: client=%s old_sub=%s → new plan %s",
        client.id,
        sub.id,
        new_plan.slug,
    )
    return payload


# ── Bot-scoped grace cleanup (called by the per-bot activation branch) ────────


def cancel_bot_scoped_reauth_grace(session: Session, client_id: int, bot_id: int | None) -> int:
    """Cancel the bot-scoped downgrade re-auth grace row for ``(client_id, bot_id)``.

    Companion to the grace row minted in :func:`promote_scheduled_change`. The
    account-level sibling-cancel sweep in ``_handle_subscription_activated`` only
    clears active-set rows WHERE ``bot_id IS NULL``, so a PER-BOT downgrade's
    grace row (``bot_id NOT NULL``) survives it. Because
    ``ix_subscriptions_client_bot_active`` is a UNIQUE partial index over
    ``(client_id, bot_id)`` for the active set, that lingering ``past_due`` grace
    row collides with the new bot-scoped active row the per-bot activation branch
    inserts. Call this FIRST from that branch (before the INSERT) to free the
    index slot.

    Scope is deliberately narrow: it only touches rows in the active set whose
    ``cancel_reason`` is ``DOWNGRADE_REAUTH_GRACE_REASON``, so it can never cancel
    a real paid subscription. Idempotent — returns 0 when there is nothing to
    cancel. ``bot_id IS NULL`` is a no-op: account-level grace is the existing
    sweep's responsibility, and matching NULL here could cancel a legacy
    account-level grace row that the caller did not mean to touch.

    Returns the number of grace rows cancelled (normally 0 or 1).
    """
    if bot_id is None:
        return 0

    rows = (
        session.execute(
            select(Subscription).where(
                Subscription.client_id == client_id,
                Subscription.bot_id == bot_id,
                Subscription.cancel_reason == DOWNGRADE_REAUTH_GRACE_REASON,
                # Only the active-set statuses participate in the unique index, so
                # only those can collide with the incoming INSERT. Rows already
                # swept/expired are left as-is.
                Subscription.status.in_(("active", "trialing", "past_due")),
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return 0

    now = datetime.now(UTC)
    for row in rows:
        # Mirror the account-level sweep's terminal flip. ``cancel_reason`` is
        # left as the grace marker so the audit trail still shows why the row
        # existed (superseded by a successful re-auth, not a dunning lapse).
        row.status = "canceled"
        row.canceled_at = now
    session.flush()

    logger.info(
        "Cancelled %d bot-scoped re-auth grace row(s) for client=%s bot=%s at re-auth activation",
        len(rows),
        client_id,
        bot_id,
    )
    return len(rows)


# ── Pending-proration application (called inside the activation webhook) ──────


def apply_pending_proration(
    session: Session,
    new_sub: Subscription,
    prev_razorpay_subscription_id: str | None,
    live_remaining: int | None = None,
) -> int:
    """Re-grant the old plan's unused credits onto the new sub as a top-up.

    Looks up the old local row by ``prev_razorpay_subscription_id``,
    reads the rollover credit count stashed in
    ``upgrade_credit_pending_cents`` (column name is legacy — it stores a
    credit count, not cents), writes a credit-ledger ``topup`` for that
    amount, then zeros the column so re-runs of the activation webhook
    don't double-credit.

    ``live_remaining`` (finding F): the customer's ACTUAL unused plan credits at
    activation, captured before the new period's reset. The pending figure was
    snapshotted at *click* time; the old plan stays live until the mandate is
    authorized, so the customer keeps burning credits in between. Clamping to the
    live remaining stops us re-granting more than they actually had left (a
    5,000 snapshot spent down to 3,000 must roll over 3,000, not 5,000). When
    omitted (legacy callers) the raw snapshot is used, preserving prior behaviour.

    Returns the credit amount applied (0 when there was nothing pending).
    """
    if not prev_razorpay_subscription_id:
        return 0

    old_sub = session.scalars(
        select(Subscription).where(Subscription.razorpay_subscription_id == prev_razorpay_subscription_id)
    ).first()
    if old_sub is None:
        return 0

    # Finding D: the upgrade has activated, so the in-flight checkout is spent —
    # clear the pending marker unconditionally (even when there were no rollover
    # credits) so it never strands a future upgrade to the same plan.
    old_sub.upgrade_pending_subscription_id = None
    old_sub.upgrade_pending_plan_id = None

    if not old_sub.upgrade_credit_pending_cents:
        session.flush()
        return 0

    credit_amount = int(old_sub.upgrade_credit_pending_cents)
    if live_remaining is not None:
        credit_amount = max(0, min(credit_amount, int(live_remaining)))
    old_sub.upgrade_credit_pending_cents = 0
    session.flush()
    if credit_amount <= 0:
        return 0

    credit_service.grant_topup(
        session,
        new_sub.client_id,
        amount=credit_amount,
        note=f"Upgrade rollover (unused {old_sub.plan.slug if old_sub.plan else 'previous plan'} credits)",
        bot_id=new_sub.bot_id,
    )

    logger.info(
        "Applied upgrade rollover credits: client=%s bot=%s amount=%d",
        new_sub.client_id,
        new_sub.bot_id,
        credit_amount,
    )
    return credit_amount
