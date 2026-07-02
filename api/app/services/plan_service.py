"""Plan management service — resolves client plans, enforces limits, and manages plan CRUD."""

import logging
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import Bot, Operator, Plan, PricingConfig, Subscription, UsageRecord

logger = logging.getLogger(__name__)

# Sentinel value: -1 in a limit field means "unlimited"
UNLIMITED = -1


def lock_client_for_billing(session: Session, client_id: int) -> None:
    """Serialize a client's subscription / credit mutations (remediation H1).

    Takes a transaction-scoped PostgreSQL advisory lock keyed on the client, so
    concurrent billing mutations — a double-clicked "start trial", racing
    change-plan / seats / cancel — run one at a time. Without it, two requests
    can both pass the read-side checks (TOCTOU) and double-grant credits or
    clobber each other's writes. Released automatically at COMMIT / ROLLBACK.

    The 64-bit key is hashed from a namespaced string so it cannot collide with
    the per-(client, bot) advisory locks ``credit_service`` takes inside the
    grant/deduct path. No-op on non-PostgreSQL binds (e.g. mocked unit-test
    sessions); the lock is a concurrency guard, not a single-thread invariant.
    """
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
        {"k": f"oyechats:billing:{int(client_id)}"},
    )


def get_active_plans(session: Session) -> list[Plan]:
    """Return all active plans ordered by sort_order (for pricing page display)."""
    stmt = select(Plan).where(Plan.is_active.is_(True)).order_by(Plan.sort_order)
    return list(session.execute(stmt).scalars().all())


_PRICING_CONTENT_KEYS: dict[str, str] = {
    "faq": "pricing_faq",
    "feature_matrix": "pricing_feature_matrix",
    "topup_packs": "pricing_topup_packs",
    "credit_costs": "pricing_credit_costs",
}


def get_pricing_content(session: Session) -> dict:
    """Return the editable site pricing-content blobs keyed by short name.

    Missing keys default to an empty list so callers never KeyError on a
    fresh database.
    """
    rows: dict[str, object] = {
        row.key: row.value
        for row in session.execute(select(PricingConfig).where(PricingConfig.key.in_(_PRICING_CONTENT_KEYS.values())))
        .scalars()
        .all()
    }
    return {short: rows.get(full, []) for short, full in _PRICING_CONTENT_KEYS.items()}


def set_pricing_content(session: Session, content: dict) -> None:
    """Upsert provided pricing-content blobs. Only known keys are written."""
    for short, full in _PRICING_CONTENT_KEYS.items():
        if short not in content:
            continue
        row: PricingConfig | None = (
            session.execute(select(PricingConfig).where(PricingConfig.key == full)).scalars().first()
        )
        if row is None:
            session.add(PricingConfig(key=full, value=content[short]))
        else:
            row.value = content[short]
    session.commit()


def get_plan_by_slug(session: Session, slug: str) -> Plan | None:
    """Look up a plan by its URL-safe slug."""
    return session.execute(select(Plan).where(Plan.slug == slug)).scalars().first()


def get_plan_by_id(session: Session, plan_id: int) -> Plan | None:
    """Look up a plan by its database ID."""
    return session.execute(select(Plan).where(Plan.id == plan_id)).scalars().first()


def get_default_plan(session: Session) -> Plan | None:
    """Return the plan marked as default (auto-assigned to new signups)."""
    return session.execute(select(Plan).where(Plan.is_default.is_(True))).scalars().first()


def get_client_subscription(session: Session, client_id: int) -> Subscription | None:
    """Return the client's account subscription, preferring the HIGHEST tier.

    Under per-bot billing a client may hold several active subscriptions at once
    (one account-level + one per paid bot). Account-level entitlements must
    follow the highest-tier active subscription (by plan price), NOT whichever
    row was created most recently — otherwise adding a Free second bot would
    silently downgrade the account's features to Free (remediation H2). Ties
    break on most-recent. ``plan_id`` is non-null (FK RESTRICT), so the inner
    join never drops a valid subscription.
    """
    stmt = (
        select(Subscription)
        .join(Plan, Plan.id == Subscription.plan_id)
        .where(
            Subscription.client_id == client_id,
            Subscription.status.in_(("active", "trialing", "past_due")),
        )
        .order_by(Plan.monthly_price_cents.desc(), Subscription.created_at.desc())
        .limit(1)
    )
    return session.execute(stmt).scalars().first()


def get_subscription_for_bot(session: Session, client_id: int, bot_id: int) -> Subscription | None:
    """Return the active subscription funding a specific bot (remediation N3).

    Under per-bot billing, mutation endpoints (cancel/resume/seats) must be able
    to target a chosen bot's subscription rather than always acting on the
    account's highest-tier one. Scoped by ``client_id`` so a bot owned by another
    client never resolves. Ties break on most-recent.
    """
    stmt = (
        select(Subscription)
        .where(
            Subscription.client_id == client_id,
            Subscription.bot_id == bot_id,
            Subscription.status.in_(("active", "trialing", "past_due")),
        )
        .order_by(Subscription.created_at.desc())
        .limit(1)
    )
    return session.execute(stmt).scalars().first()


def get_client_plan(session: Session, client_id: int) -> Plan:
    """Resolve the client's current plan. Falls back to the default (free) plan."""
    sub = get_client_subscription(session, client_id)
    if sub:
        plan = get_plan_by_id(session, sub.plan_id)
        if plan:
            return plan

    # No active subscription — fall back to the default plan
    default = get_default_plan(session)
    if default:
        return default

    # Absolute fallback: return the free plan by slug
    free_plan = get_plan_by_slug(session, "free")
    if free_plan:
        return free_plan

    # Should never happen — seed data ensures at least one plan exists
    raise RuntimeError("No plans found in the database. Run the seed migration.")


def get_plan_limit(plan: Plan, metric: str) -> int:
    """Extract a specific limit value from the plan's JSONB limits field.

    Deny-by-default (NV3): an unknown metric returns 0, not UNLIMITED. A typo'd
    or renamed metric name must never silently grant unlimited quota — this now
    matches ``PlanEntitlements.limit_for``, which also fails closed. A plan that
    genuinely wants a metric unlimited stores ``-1`` (UNLIMITED) explicitly.
    """
    limits: dict = plan.limits or {}
    return limits.get(metric, 0)


# Free-tier crawl floor — used when a plan row is missing the crawl-limit
# keys entirely (e.g. seed data older than the a7c1e9f3b210 migration, or a
# test fixture). Lets the rest of the stack treat ``get_crawl_limits`` as
# total without leaking ``None`` into the crawler subprocess env.
#
# ``max_crawl_pages`` set to 20 to match the Free tier's page_scraping limit
# (200 credits / month, 20 pages per crawl ceiling).
_DEFAULT_CRAWL_LIMITS = {
    "max_crawl_pages": 20,
    "max_crawl_depth": 3,
    "max_crawl_js_pages": 10,
    "max_crawl_concurrency": 2,
}


def get_crawl_limits(plan: Plan) -> dict[str, int]:
    """Return the crawl-limit dict for ``plan`` with safe fallbacks.

    Keys: ``max_crawl_pages``, ``max_crawl_depth``, ``max_crawl_js_pages``,
    ``max_crawl_concurrency``. Missing keys fall back to the free-tier
    floor — never to UNLIMITED — because the crawler subprocess always
    needs a concrete integer ceiling.

    ``max_crawl_pages`` may legitimately be ``UNLIMITED`` (``-1``) for paid
    tiers: the per-crawl page cap was lifted on Starter/Standard so that
    spend is governed purely by the credit pre-flight + per-page atomic
    deduction. Callers MUST resolve ``-1`` to a concrete int (typically
    via the available credit balance) before forwarding to the crawler
    subprocess.
    """
    limits: dict = plan.limits or {}
    return {key: int(limits.get(key, default)) for key, default in _DEFAULT_CRAWL_LIMITS.items()}


def get_client_crawl_limits(session: Session, client_id: int) -> dict[str, int]:
    """Convenience: resolve the client's plan and return its crawl limits."""
    return get_crawl_limits(get_client_plan(session, client_id))


def is_feature_enabled(plan: Plan, feature: str) -> bool:
    """Check whether a specific feature is enabled on this plan."""
    features: dict = plan.features or {}
    return features.get(feature, False)


def enforce_feature(session: Session, client_id: int, feature: str) -> None:
    """Raise HTTP 403 if a feature is not enabled on the client's current plan.

    Feature gating is independent of credits — it controls which capabilities
    a tier exposes (e.g. ``live_chat``, ``bant``, ``sso``). The ``features``
    JSONB column on ``Plan`` is the source of truth.
    """
    from fastapi import HTTPException, status

    plan = get_client_plan(session, client_id)
    if not is_feature_enabled(plan, feature):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "feature_not_available",
                "feature": feature,
                "message": (
                    f"The '{feature.replace('_', ' ')}' feature is not included in your "
                    f"current plan. Please upgrade to access this feature."
                ),
            },
        )


def get_current_usage_record(session: Session, client_id: int) -> UsageRecord | None:
    """Get the usage record for the current billing period."""
    now = datetime.now(UTC)
    stmt = (
        select(UsageRecord)
        .where(
            UsageRecord.client_id == client_id,
            UsageRecord.period_start <= now,
            UsageRecord.period_end > now,
        )
        # Deterministic pick (NV6): under the per-bot model two active
        # subscriptions can both straddle ``now``; without an explicit order the
        # "current period" was arbitrary. Prefer the most recently started one.
        .order_by(UsageRecord.period_start.desc())
        .limit(1)
    )
    return session.execute(stmt).scalars().first()


def get_or_create_usage_record(session: Session, client_id: int) -> UsageRecord:
    """Get or create the usage record for the current billing period.

    If no record exists (new signup, period rollover), creates one based on
    the client's current plan limits.
    """
    record = get_current_usage_record(session, client_id)
    if record:
        # Keep the current-period record's plan + limits in sync with the
        # client's CURRENT plan. The record snapshots plan_id/limits at creation
        # and would otherwise go stale after a mid-period upgrade/downgrade,
        # showing the old plan/limits until the next period. We only write when
        # the plan actually changed; used counters are preserved.
        current = get_client_plan(session, client_id)
        if current and record.plan_id != current.id:
            cur_limits = current.limits or {}
            record.plan_id = current.id
            record.ai_messages_limit = cur_limits.get("ai_messages", 0)
            record.live_chat_messages_limit = cur_limits.get("live_chat_messages", 0)
            record.url_scans_limit = cur_limits.get("url_scans", 0)
            record.email_summaries_limit = cur_limits.get("email_summaries", 0)
            record.email_notifications_limit = cur_limits.get("email_notifications", 0)
            record.storage_limit_mb = cur_limits.get("storage_mb", 0)
            session.flush()
        return record

    # Determine period boundaries from subscription or default to calendar month
    plan = get_client_plan(session, client_id)
    sub = get_client_subscription(session, client_id)

    if sub and sub.current_period_start and sub.current_period_end:
        period_start = sub.current_period_start
        period_end = sub.current_period_end
    else:
        # Default to calendar month for free-tier / no subscription
        now = datetime.now(UTC)
        period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # Next month first day
        if now.month == 12:
            period_end = period_start.replace(year=now.year + 1, month=1)
        else:
            period_end = period_start.replace(month=now.month + 1)

    limits = plan.limits or {}

    # Count current bots and operators for snapshot fields. Both filter on
    # ``is_active`` so the snapshot matches the live entitlements view (which
    # also counts only active operators) rather than over-counting deactivated.
    bots_count = session.execute(select(Bot.id).where(Bot.client_id == client_id, Bot.is_active.is_(True))).all()
    operators_count = session.execute(
        select(Operator.id).where(Operator.client_id == client_id, Operator.is_active.is_(True))
    ).all()

    record = UsageRecord(
        client_id=client_id,
        plan_id=plan.id,
        period_start=period_start,
        period_end=period_end,
        ai_messages_limit=limits.get("ai_messages", 0),
        live_chat_messages_limit=limits.get("live_chat_messages", 0),
        url_scans_limit=limits.get("url_scans", 0),
        email_summaries_limit=limits.get("email_summaries", 0),
        email_notifications_limit=limits.get("email_notifications", 0),
        storage_limit_mb=limits.get("storage_mb", 0),
        bots_count=len(bots_count),
        operators_count=len(operators_count),
    )
    # M4 — the (client_id, period_start) unique index blocks a concurrent
    # double-create at the DB layer; catch the loser's IntegrityError in a
    # savepoint and return the winner's row instead of bubbling a 500.
    sp = session.begin_nested()
    try:
        session.add(record)
        session.flush()
        sp.commit()
    except IntegrityError:
        sp.rollback()
        existing = get_current_usage_record(session, client_id)
        if existing is None:
            raise
        return existing
    return record


def assign_default_plan_to_client(session: Session, client_id: int) -> Subscription:
    """Create the initial subscription for a new client signup AND grant the
    first period's credits.

    Two flavours of "default" coexist:

    * **Trial plan** (``trial_days > 0``) — the modern default. The
      subscription starts in ``trialing``; ``trial_start`` / ``trial_end``
      are populated and ``current_period_end`` is pinned to ``trial_end``
      so the billing UI's "renews on" label matches the trial deadline.
      The expiry cron (PR4) flips status to ``trial_expired`` when
      ``trial_end < now()``.
    * **Free plan** (``trial_days == 0``) — historical fallback for any
      install whose default is still pointed at a zero-trial plan. Starts
      in ``active`` with an anniversary-monthly billing cycle.

    The credit grant is part of the contract here — without it, a brand-new
    signup has a valid subscription but a zero balance, which blocks every
    credit-gated action (crawl, chat, document upload) until the next
    monthly cron tick. Paid plans get their grant from the payment webhook;
    trial / free plans need it inline because no payment ever arrives.
    """
    # Serialize concurrent signup retries so a client can't get two default
    # subscriptions (and two credit grants) from a double-fired request.
    lock_client_for_billing(session, client_id)

    default_plan = get_default_plan(session) or get_plan_by_slug(session, "free")
    if not default_plan:
        raise RuntimeError("No default plan found. Run the seed migration.")

    from datetime import timedelta

    from app.core.dates import add_months

    now = datetime.now(UTC)
    trial_days = int(default_plan.trial_days or 0)

    if trial_days > 0:
        # Trial-plan path — period and trial dates intentionally coincide so
        # the dashboard's "renews on" badge points at the trial deadline.
        trial_start = now
        trial_end = now + timedelta(days=trial_days)
        sub_status = "trialing"
        period_start = trial_start
        period_end = trial_end
    else:
        # Zero-trial fallback (legacy free plan).
        trial_start = None
        trial_end = None
        sub_status = "active"
        # Anniversary billing: a customer signing up on May 30 17:18 IST
        # gets their period_end on June 30 17:18 IST — exactly one month
        # from signup. Matches Stripe/Razorpay defaults.
        period_start = now
        period_end = add_months(now, 1)

    sub = Subscription(
        client_id=client_id,
        plan_id=default_plan.id,
        status=sub_status,
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=period_start,
        current_period_end=period_end,
        trial_start=trial_start,
        trial_end=trial_end,
        payment_provider="manual",
    )
    # Bind the relationship so grant_for_subscription can read `sub.plan`
    # without re-querying after flush.
    sub.plan = default_plan
    session.add(sub)
    session.flush()

    # Grant the initial period's credits. ``grant_for_subscription`` is a
    # no-op for plans with zero credits_per_month, so this is safe even if
    # someone later creates a plan with no allowance.
    from app.services import credit_service

    credit_service.grant_for_subscription(session, sub)

    logger.info(
        "Assigned default plan '%s' (status=%s) to client %s and granted %d credits",
        default_plan.slug,
        sub_status,
        client_id,
        int(default_plan.credits_per_month or 0),
    )
    return sub


class TrialUnavailable(Exception):
    """Raised when a client cannot start a trial on the requested plan.

    Carries the reason code so the API layer can map it to a stable HTTP
    response without parsing English. Reasons:

    * ``plan_not_found``        — slug doesn't match an active plan.
    * ``plan_not_trialable``    — ``trial_days <= 0`` (e.g. free or enterprise).
    * ``already_trialed``       — client previously held a sub (active or
      expired) on this exact plan. One trial per plan, lifetime.
    * ``active_paid_subscription`` — client is on a paid plan already
      (or trialing a different paid plan) — they should change plans
      through the normal upgrade flow, not start a fresh trial.
    """

    def __init__(self, reason: str, *, message: str | None = None) -> None:
        super().__init__(message or reason)
        self.reason = reason
        self.message = message or reason


def start_trial(session: Session, client_id: int, plan_slug: str) -> Subscription:
    """Move a client onto a 14-day trial of the named paid plan.

    Trial credits = the plan's own ``credits_per_month``. The customer
    experiences the full paid tier; converting on day 14 (or any day
    before) doesn't change the credit shape, just the billing flow.

    Idempotency / safety:

    * The free-tier subscription a client may already hold (status =
      ``active`` on the ``free`` plan) is gracefully canceled so the new
      trialing row can satisfy the ``status IN (active, trialing,
      past_due)`` partial-unique index on ``subscriptions.client_id``.
    * Pre-existing rows on the *same* plan (any historical status) raise
      :class:`TrialUnavailable` with reason ``already_trialed`` — one
      trial per plan, lifetime.
    * Pre-existing rows on a different *paid* plan raise
      ``active_paid_subscription`` — the upgrade/downgrade UI handles
      that case, not the start-trial path.
    """
    from datetime import timedelta

    from app.db.models import Plan

    # Serialize concurrent start-trial requests for this client BEFORE the
    # read-side eligibility checks, so a double-click can't pass the
    # already-trialed / current-subscription guards twice and double-grant.
    lock_client_for_billing(session, client_id)

    plan = get_plan_by_slug(session, plan_slug)
    if plan is None or not plan.is_active:
        raise TrialUnavailable("plan_not_found", message=f"No active plan with slug '{plan_slug}'.")

    trial_days = int(plan.trial_days or 0)
    if trial_days <= 0:
        raise TrialUnavailable(
            "plan_not_trialable",
            message=f"The '{plan.name}' plan does not offer a free trial.",
        )

    # Lifetime ban on re-trialing the same plan. We check the historical
    # set, not just the current row, so a customer who already used their
    # Starter trial can't reset by canceling and re-clicking.
    prior_on_same_plan = (
        session.execute(
            select(Subscription)
            .where(
                Subscription.client_id == client_id,
                Subscription.plan_id == plan.id,
            )
            .limit(1)
        )
        .scalars()
        .first()
    )
    if prior_on_same_plan is not None:
        raise TrialUnavailable(
            "already_trialed",
            message=(
                f"You have already used your free trial for the '{plan.name}' plan. "
                "Choose this plan from the billing page to subscribe directly."
            ),
        )

    # Current subscription — anything in the active-set is the row that
    # gates the unique index. We allow upgrading from a free-tier
    # subscription (paid==0) but refuse to trample anything else.
    current = (
        session.execute(
            select(Subscription)
            .where(
                Subscription.client_id == client_id,
                Subscription.status.in_(("active", "trialing", "past_due")),
            )
            .order_by(Subscription.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )

    now = datetime.now(UTC)
    if current is not None:
        current_plan = session.execute(select(Plan).where(Plan.id == current.plan_id)).scalars().first()
        is_paid_plan = current_plan is not None and int(current_plan.monthly_price_cents or 0) > 0
        # Active paid subscriptions go through the change-plan flow — we
        # don't silently kill a paying customer's sub to drop them onto a
        # different trial. Trialing customers, on the other hand, may want
        # to evaluate a second tier; we let them swap (the lifetime
        # one-trial-per-plan rule above keeps the swap from being abused
        # as an unlimited credit faucet).
        if is_paid_plan and current.status != "trialing":
            raise TrialUnavailable(
                "active_paid_subscription",
                message=(
                    "You're already on a paid subscription. Use the change-plan "
                    "flow on the billing page to switch tiers."
                ),
            )
        # Free-tier upgrade OR trialing→trialing swap. Either way, vacate
        # the partial-unique index by canceling the existing row before we
        # insert the new trialing one. Capture the cancel reason BEFORE
        # we overwrite ``status`` — it's how the audit trail distinguishes
        # the two flows.
        cancel_reason = "auto_swap_trial" if current.status == "trialing" else "auto_upgrade_to_trial"
        current.status = "canceled"
        current.canceled_at = now
        current.cancel_reason = cancel_reason
        session.flush()

    # Expire any unused monthly grant from the prior subscription BEFORE
    # we hand out the new plan's credits. Otherwise the new balance ends
    # up as ``old_remaining + new_grant`` — e.g. a free-tier user with 500
    # untouched credits who starts a Standard trial would see 10,500 / 10,000.
    # ``reset_monthly_plan_credits`` only zeroes ``plan_grant`` rows; paid
    # top-up credits (``topup_grant``) survive because the customer
    # bought those outright and they ride the standard 12-month expiry.
    from app.services import credit_service

    credit_service.reset_monthly_plan_credits(session, client_id)

    trial_end = now + timedelta(days=trial_days)
    sub = Subscription(
        client_id=client_id,
        plan_id=plan.id,
        status="trialing",
        billing_cycle="monthly",
        operator_quantity=1,
        current_period_start=now,
        current_period_end=trial_end,
        trial_start=now,
        trial_end=trial_end,
        payment_provider="manual",
    )
    sub.plan = plan
    session.add(sub)
    session.flush()

    credit_service.grant_for_subscription(session, sub)

    logger.info(
        "Started trial for client %s on plan '%s' (credits=%d, ends=%s)",
        client_id,
        plan.slug,
        int(plan.credits_per_month or 0),
        trial_end.isoformat(),
    )
    return sub
