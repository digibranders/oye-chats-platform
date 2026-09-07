"""End-to-end edge cases for THE PRICING QUERY.

"The pricing query" is the runtime resolution of *which plan governs a client
right now* and the gates that read it — the chain behind every plan-gated
action:

    get_client_subscription  → highest-tier ACTIVE subscription (or None)
    get_client_plan          → that plan, else the DEFAULT plan, else free-by-slug
    get_plan_limit           → a numeric cap off the plan's JSONB (deny-by-default)
    is_feature_enabled       → a boolean off the plan's JSONB
    enforce_feature          → HTTP 403 when the feature is off
    can_client_add_new_bot   → the per-bot-billing bot cap
    plan_grants_unlimited_bots

These run against a real throwaway Postgres (the ``db`` fixture) because the
resolver is a JOIN + ORDER BY whose exact tie-breaks and status filter are the
whole point; SQLite would not exercise them faithfully.

Companion to ``test_account_plan_resolution.py`` (the remediation-H2
highest-tier case). This file covers the branches that file does not: the
no-subscription fallbacks, the status filter (canceled / expired / past_due /
trialing), the created_at tie-break, and the limit/feature/bot-cap gates.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.api.subscription_routes import resolve_bot_plan
from app.db.models import Bot, Client, Plan, Subscription
from app.services import plan_service
from app.services.plan_entitlements_service import (
    UNLIMITED,
    can_client_add_new_bot,
    get_bot_entitlements,
    plan_grants_unlimited_bots,
)

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="pricing-query edge-case tests need a reachable Postgres at DB_URL",
)


# ── helpers ──────────────────────────────────────────────────────────────────


def _client(db, email: str) -> Client:
    c = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _plan(db, slug: str, *, price: int, limits: dict | None = None, features: dict | None = None, **kw) -> Plan:
    p = Plan(name=slug.title(), slug=slug, monthly_price_cents=price, credits_per_month=0)
    if limits is not None:
        p.limits = limits
    if features is not None:
        p.features = features
    for k, v in kw.items():
        setattr(p, k, v)
    db.add(p)
    db.flush()
    return p


def _sub(
    db, client, plan, *, status: str, bot_id: int | None = None, created_at: datetime | None = None
) -> Subscription:
    s = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot_id,
        status=status,
        payment_provider="razorpay",
    )
    if created_at is not None:
        s.created_at = created_at
    db.add(s)
    return s


# ── Resolution: fallbacks when there is no live subscription ──────────────────


def test_no_subscription_resolves_to_default_plan(db):
    """A client with zero subscriptions rides the DEFAULT plan — NOT free by
    name, whatever the seeded default happens to be. This is the case every
    existing pre-pricing client lands in the moment gating goes live."""
    client = _client(db, "nosub@e.com")
    _plan(db, "free", price=0, is_default=False, is_active=True)
    default = _plan(db, "trial", price=0, is_default=True, is_active=True)
    db.commit()

    assert plan_service.get_client_plan(db, client.id).id == default.id


def test_no_subscription_no_default_falls_back_to_free_slug(db):
    """Absolute fallback: no live subscription AND no active default plan — the
    resolver returns the plan whose slug is literally ``free`` rather than
    raising, so the request path never dies on a mis-seeded plan table."""
    client = _client(db, "nodefault@e.com")
    free = _plan(db, "free", price=0, is_default=False, is_active=True)
    db.commit()

    assert plan_service.get_client_plan(db, client.id).id == free.id


# ── Resolution: the status filter ─────────────────────────────────────────────


def test_canceled_subscription_is_ignored(db):
    """A canceled subscription must never keep governing the client. With only a
    canceled row the client falls back to the default plan, not the plan it was
    canceled from."""
    client = _client(db, "canceled@e.com")
    default = _plan(db, "free", price=0, is_default=True, is_active=True)
    paid = _plan(db, "professional", price=299900)
    _sub(db, client, paid, status="canceled")
    db.commit()

    assert plan_service.get_client_subscription(db, client.id) is None
    assert plan_service.get_client_plan(db, client.id).id == default.id


def test_expired_and_paused_subscriptions_are_ignored(db):
    """Neither ``expired`` nor ``paused`` counts as live; both fall back."""
    client = _client(db, "expired@e.com")
    default = _plan(db, "free", price=0, is_default=True, is_active=True)
    paid = _plan(db, "standard", price=119900)
    _sub(db, client, paid, status="expired")
    _sub(db, client, paid, status="paused")
    db.commit()

    assert plan_service.get_client_subscription(db, client.id) is None
    assert plan_service.get_client_plan(db, client.id).id == default.id


def test_past_due_subscription_still_governs(db):
    """``past_due`` is a live status (the mandate has not been canceled, only a
    charge is late) — the client keeps their paid plan through the dunning
    window rather than being silently downgraded mid-cycle."""
    client = _client(db, "pastdue@e.com")
    _plan(db, "free", price=0, is_default=True, is_active=True)
    paid = _plan(db, "professional", price=299900)
    _sub(db, client, paid, status="past_due")
    db.commit()

    assert plan_service.get_client_plan(db, client.id).id == paid.id


def test_trialing_subscription_governs(db):
    """A trialing subscription resolves to its plan (the trial IS the entitlement
    during the window)."""
    client = _client(db, "trialing@e.com")
    _plan(db, "free", price=0, is_default=True, is_active=True)
    paid = _plan(db, "standard", price=119900)
    _sub(db, client, paid, status="trialing")
    db.commit()

    assert plan_service.get_client_plan(db, client.id).id == paid.id


def test_canceled_higher_tier_never_beats_active_lower_tier(db):
    """The highest-tier rule is scoped to LIVE rows only. A canceled Professional
    plus an active Starter resolves to Starter — the dead higher tier does not
    resurrect just because it out-prices the live one."""
    client = _client(db, "mixed@e.com")
    _plan(db, "free", price=0, is_default=True, is_active=True)
    starter = _plan(db, "starter", price=59900)
    professional = _plan(db, "professional", price=299900)
    _sub(db, client, professional, status="canceled")
    _sub(db, client, starter, status="active")
    db.commit()

    assert plan_service.get_client_plan(db, client.id).id == starter.id


def test_equal_price_tiebreak_prefers_most_recent(db):
    """When two live subscriptions share the top price, the tie breaks on the
    most recently created row (the deterministic NV6 pick).

    The two live rows must sit on DIFFERENT bots: a partial unique index
    (``ix_subscriptions_client_legacy_active``) allows at most one live
    account-level (``bot_id IS NULL``) subscription per client, so a
    same-price tie can only arise across per-bot subscriptions. This is the
    per-bot-billing shape the tie-break was written for."""
    client = _client(db, "tie@e.com")
    _plan(db, "free", price=0, is_default=True, is_active=True)
    plan_a = _plan(db, "standard-a", price=119900)
    plan_b = _plan(db, "standard-b", price=119900)
    bot_a = Bot(client_id=client.id, bot_key="bot-tie-a", name="A", is_active=True)
    bot_b = Bot(client_id=client.id, bot_key="bot-tie-b", name="B", is_active=True)
    db.add_all([bot_a, bot_b])
    db.flush()
    now = datetime.now(UTC)
    _sub(db, client, plan_a, status="active", bot_id=bot_a.id, created_at=now - timedelta(days=3))
    _sub(db, client, plan_b, status="active", bot_id=bot_b.id, created_at=now)
    db.commit()

    # Same price → newest wins.
    assert plan_service.get_client_subscription(db, client.id).plan_id == plan_b.id


# ── The denormalized Bot.plan_id must never drive a customer-facing plan ──────


def test_stale_bot_plan_id_does_not_drive_the_per_agent_plan(db):
    """The per-agent plan and its ceilings follow the bot's SUBSCRIPTION, never
    the denormalized ``Bot.plan_id``.

    ``Bot.plan_id`` is stamped once when the bot is provisioned and no code ever
    reassigns it, so it goes stale on the first plan change. While
    ``get_credit_balance`` read it, an upgraded customer was shown the ceilings
    of the tier they had LEFT on the Usage page, while enforcement (which
    resolves through ``subscriptions``) applied the real ones — the display
    contradicted both the invoice and the gate.

    This pins the invariant that closes that gap: the plan shown and the plan
    enforced resolve from the same source, even when the stale column disagrees.
    """
    client = _client(db, "stale-planid@e.com")
    starter = _plan(db, "starter", price=59900, limits={"ai_messages": 2000})
    professional = _plan(db, "professional", price=299900, limits={"ai_messages": 50000})
    bot = Bot(client_id=client.id, bot_key="bot-stale", name="Upgraded", is_active=True)
    db.add(bot)
    db.flush()
    sub = _sub(db, client, professional, status="active", bot_id=bot.id)
    db.flush()
    # The drift: the bot still carries the tier it was provisioned on, while its
    # subscription has moved to Professional.
    bot.plan_id = starter.id
    bot.subscription_id = sub.id
    db.commit()

    # The exact helper the credit-balance endpoint resolves through.
    resolved = resolve_bot_plan(bot)
    assert resolved is not None
    assert resolved.id == professional.id
    assert resolved.limits["ai_messages"] == 50000

    # ...and it agrees with the gate that actually enforces.
    entitlements = get_bot_entitlements(bot.id, db, use_cache=False)
    assert entitlements.plan_slug == "professional"
    assert entitlements.limits["ai_messages"] == 50000

    # The stale column is still wrong; it simply no longer reaches a customer.
    assert bot.plan_id == starter.id


# ── Limit extraction: deny-by-default + the UNLIMITED sentinel ────────────────


def test_get_plan_limit_reads_known_metric(db):
    plan = _plan(db, "standard", price=119900, limits={"ai_messages": 10000})
    assert plan_service.get_plan_limit(plan, "ai_messages") == 10000


def test_get_plan_limit_unknown_metric_denies_by_default(db):
    """An unknown / typo'd / renamed metric returns 0, never UNLIMITED — a
    misspelled key must fail closed, not silently grant infinite quota."""
    plan = _plan(db, "standard", price=119900, limits={"ai_messages": 10000})
    assert plan_service.get_plan_limit(plan, "ai_messagez") == 0
    assert plan_service.get_plan_limit(plan, "does_not_exist") == 0


def test_get_plan_limit_unlimited_sentinel_is_preserved(db):
    """A plan that genuinely wants a metric unbounded stores -1 (UNLIMITED)
    explicitly, and the resolver returns it verbatim for callers to interpret."""
    plan = _plan(db, "enterprise", price=599900, limits={"ai_messages": UNLIMITED})
    assert plan_service.get_plan_limit(plan, "ai_messages") == UNLIMITED == -1


# ── Feature gate ──────────────────────────────────────────────────────────────


def test_feature_gate_allows_when_enabled(db):
    client = _client(db, "feat-on@e.com")
    plan = _plan(db, "professional", price=299900, features={"live_chat": True})
    _sub(db, client, plan, status="active")
    db.commit()

    assert plan_service.is_feature_enabled(plan, "live_chat") is True
    # Must not raise.
    plan_service.enforce_feature(db, client.id, "live_chat")


def test_feature_gate_403s_when_disabled_or_missing(db):
    from fastapi import HTTPException

    client = _client(db, "feat-off@e.com")
    plan = _plan(db, "starter", price=59900, features={"live_chat": False})
    _sub(db, client, plan, status="active")
    db.commit()

    assert plan_service.is_feature_enabled(plan, "live_chat") is False
    with pytest.raises(HTTPException) as exc:
        plan_service.enforce_feature(db, client.id, "live_chat")
    assert exc.value.status_code == 403
    # A feature the plan never declares also denies (deny-by-default).
    assert plan_service.is_feature_enabled(plan, "never_declared_feature") is False


# ── Bot cap (per-bot billing) ─────────────────────────────────────────────────


def test_can_add_first_bot_but_not_second(db):
    """Per-bot billing: the first active bot is allowed (it is the funded one);
    any bot beyond it is blocked with must_subscribe, regardless of plan tier."""
    client = _client(db, "botcap@e.com")
    _plan(db, "professional", price=299900, is_default=True, is_active=True)
    db.commit()

    first = can_client_add_new_bot(client.id, db)
    assert first.allowed is True and first.active_bot_count == 0

    db.add(Bot(client_id=client.id, bot_key="bot-cap-1", name="B1", is_active=True))
    db.commit()

    second = can_client_add_new_bot(client.id, db)
    assert second.allowed is False
    assert second.must_subscribe is True
    assert second.active_bot_count == 1


def test_inactive_bot_does_not_count_against_cap(db):
    """A deactivated bot frees its billing slot — it must not count toward the
    active-bot gate."""
    client = _client(db, "inactivebot@e.com")
    _plan(db, "free", price=0, is_default=True, is_active=True)
    db.add(Bot(client_id=client.id, bot_key="bot-inact", name="Old", is_active=False))
    db.commit()

    assert can_client_add_new_bot(client.id, db).allowed is True


# ── Unlimited-bots predicate (account-product guard) ──────────────────────────


def test_unlimited_bots_predicate(db):
    unlimited = _plan(db, "agency", price=999900, limits={"bots": UNLIMITED})
    finite = _plan(db, "standard", price=119900, limits={"bots": 1})
    missing = _plan(db, "legacy", price=0, limits={"ai_messages": 250})  # no "bots" key
    bad = _plan(db, "corrupt", price=0, limits={"bots": "lots"})  # non-numeric

    assert plan_grants_unlimited_bots(unlimited) is True
    assert plan_grants_unlimited_bots(finite) is False
    assert plan_grants_unlimited_bots(missing) is False  # conservative on missing
    assert plan_grants_unlimited_bots(bad) is False  # conservative on bad data
