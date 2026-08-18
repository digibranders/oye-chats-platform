"""Per-bot entitlements resolve from the bot's OWN subscription.

``get_entitlements`` (account view) follows the highest-priced subscription
across all a client's bots, so a bot downgraded to Starter would keep a sibling
bot's Professional features under account-level gating. ``get_bot_entitlements``
fixes that: it resolves from the subscription funding a specific bot (falling
back to the account subscription when the bot has none), so per-bot feature
gates (BANT, webhooks, branding) reflect the plan the customer actually pays for
that bot.

Real Postgres via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os

import pytest

from app.db.models import Bot, Client, Plan, Subscription
from app.services import plan_entitlements_service as ent

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture(autouse=True)
def _no_cache(monkeypatch):
    """Disable the entitlements Redis cache so assertions read live DB state."""
    monkeypatch.setattr(ent, "get_redis", lambda: None)


def _client(db, email):
    row = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(row)
    db.flush()
    return row


def _plan(db, slug, *, price, bant):
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=price,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
        features={"bant": bant, "webhooks": bant},
    )
    db.add(plan)
    db.flush()
    return plan


def _bot(db, client, key):
    bot = Bot(client_id=client.id, bot_key=key, name="Agent")
    db.add(bot)
    db.flush()
    return bot


def _sub(db, client, plan, *, bot_id):
    sub = Subscription(client_id=client.id, plan_id=plan.id, bot_id=bot_id, status="active")
    sub.plan = plan
    db.add(sub)
    db.flush()
    return sub


def test_each_bot_resolves_its_own_plan_not_the_account_highest(db):
    client = _client(db, "twobots@e.com")
    pro = _plan(db, "pro-ent", price=139900, bant=True)
    starter = _plan(db, "starter-ent", price=44900, bant=False)
    bot_pro = _bot(db, client, "bot-pro")
    bot_starter = _bot(db, client, "bot-starter")
    _sub(db, client, pro, bot_id=bot_pro.id)
    _sub(db, client, starter, bot_id=bot_starter.id)
    db.flush()

    # Per-bot: each bot sees exactly its own plan's features.
    assert ent.get_bot_entitlements(bot_pro.id, db).has_feature("bant") is True
    assert ent.get_bot_entitlements(bot_starter.id, db).has_feature("bant") is False
    assert ent.get_bot_entitlements(bot_starter.id, db).plan_slug == "starter-ent"

    # The BANT helper agrees.
    assert ent.is_bant_enabled_for_bot(bot_pro.id, db) is True
    assert ent.is_bant_enabled_for_bot(bot_starter.id, db) is False

    # Account view is unchanged: it still returns the HIGHEST tier (Professional),
    # which is exactly the account-level leak get_bot_entitlements sidesteps.
    assert ent.get_entitlements(client.id, db).has_feature("bant") is True


def test_bot_without_its_own_subscription_falls_back_to_account_plan(db):
    client = _client(db, "fallback@e.com")
    std = _plan(db, "std-ent-fb", price=94900, bant=True)
    _sub(db, client, std, bot_id=None)  # account-level subscription
    bot = _bot(db, client, "bot-fb")  # no per-bot sub of its own
    db.flush()

    ents = ent.get_bot_entitlements(bot.id, db)
    assert ents.plan_slug == "std-ent-fb"
    assert ents.has_feature("bant") is True


def test_unknown_bot_denies_by_default(db):
    ents = ent.get_bot_entitlements(999_999_999, db)
    assert ents.plan_slug == "free"
    assert ents.has_feature("bant") is False


def test_lead_source_attribution_is_per_bot(db):
    """Attribution keys on plan SLUG ({standard, professional}), so a bot on
    Standard gets it and a sibling bot on Starter does not."""
    client = _client(db, "attr-perbot@e.com")
    standard = _plan(db, "standard", price=94900, bant=True)
    starter = _plan(db, "starter", price=44900, bant=False)
    bot_std = _bot(db, client, "bot-attr-std")
    bot_starter = _bot(db, client, "bot-attr-starter")
    _sub(db, client, standard, bot_id=bot_std.id)
    _sub(db, client, starter, bot_id=bot_starter.id)
    db.flush()

    assert ent.is_lead_source_attribution_enabled_for_bot(bot_std.id, db) is True
    assert ent.is_lead_source_attribution_enabled_for_bot(bot_starter.id, db) is False


def test_email_validation_is_enabled_only_on_standard_and_professional(db):
    """Email verification is a metered feature scoped to Standard + Professional
    on the standard ladder, and granted to bespoke enterprise slugs.

    Starter is excluded deliberately: it is a cheaper LADDER tier, and the
    allow-list keeps that boundary explicit so a future Starter change cannot
    switch a paid feature on by accident.

    A custom slug is the opposite case. It is provisioned by a super-admin for
    an individual deal at a negotiated price, and this test used to assert it
    was DENIED, the inverse of what the guarding comment said before the gate
    was narrowed: "a custom paid slug provisioned for an enterprise deal is a
    paid plan and must not silently lose the feature." Denying it leaves that
    customer without a feature they pay for and, because `is_valid_email`
    stays NULL, tripping the 409 soft gate on every manual follow-up, with no
    setting anywhere to re-enable it."""
    client = _client(db, "emailval-perbot@e.com")
    starter = _plan(db, "starter", price=44900, bant=False)
    standard = _plan(db, "standard", price=94900, bant=True)
    professional = _plan(db, "professional", price=199900, bant=True)
    custom = _plan(db, "enterprise-custom", price=500000, bant=True)
    bot_starter = _bot(db, client, "bot-emailval-starter")
    bot_std = _bot(db, client, "bot-emailval-std")
    bot_pro = _bot(db, client, "bot-emailval-pro")
    bot_custom = _bot(db, client, "bot-emailval-custom")
    _sub(db, client, starter, bot_id=bot_starter.id)
    _sub(db, client, standard, bot_id=bot_std.id)
    _sub(db, client, professional, bot_id=bot_pro.id)
    _sub(db, client, custom, bot_id=bot_custom.id)
    db.flush()

    assert ent.is_email_validation_enabled_for_bot(bot_std.id, db) is True
    assert ent.is_email_validation_enabled_for_bot(bot_pro.id, db) is True
    assert ent.is_email_validation_enabled_for_bot(bot_starter.id, db) is False
    assert ent.is_email_validation_enabled_for_bot(bot_custom.id, db) is True, (
        "a bespoke enterprise plan silently lost a feature it pays for"
    )


def test_email_validation_is_denied_on_free(db):
    """A Free bot must skip the paid Reoon call entirely."""
    client = _client(db, "emailval-free@e.com")
    free = _plan(db, "free", price=0, bant=False)
    bot_free = _bot(db, client, "bot-emailval-free")
    _sub(db, client, free, bot_id=bot_free.id)
    db.flush()

    assert ent.is_email_validation_enabled_for_bot(bot_free.id, db) is False


def test_visitor_intelligence_is_per_bot_not_account_highest(db):
    """The entitlement leak this closes: account-level ``get_entitlements``
    deliberately returns the HIGHEST-priced plan across a client's bots, so
    gating lead data on it surfaced Professional-only company/email-validity
    fields (and enabled the manual follow-up send) on a FREE bot's leads
    whenever any sibling bot was on Professional."""
    client = _client(db, "visintel-perbot@e.com")
    professional = _plan(db, "professional", price=139900, bant=True)
    free = _plan(db, "free", price=0, bant=False)
    bot_pro = _bot(db, client, "bot-visintel-pro")
    bot_free = _bot(db, client, "bot-visintel-free")
    _sub(db, client, professional, bot_id=bot_pro.id)
    _sub(db, client, free, bot_id=bot_free.id)
    db.flush()

    assert ent.is_visitor_intelligence_enabled_for_bot(bot_pro.id, db) is True
    assert ent.is_visitor_intelligence_enabled_for_bot(bot_free.id, db) is False

    # The account-level resolver still reports True (highest plan wins),
    # which is exactly why lead-scoped surfaces must not use it.
    assert ent.is_visitor_intelligence_enabled(client.id, db) is True


def test_a_bespoke_slug_also_gets_visitor_intelligence(db):
    """Same rule, applied consistently to the other gate that was narrowed.

    Visitor Intelligence is Professional-only on the ladder; an enterprise
    contract priced above Professional must not resolve to less than it.
    """
    client = _client(db, "vi-custom@e.com")
    professional = _plan(db, "professional", price=199900, bant=True)
    custom = _plan(db, "enterprise-custom", price=500000, bant=True)
    bot_pro = _bot(db, client, "bot-vi-pro")
    bot_custom = _bot(db, client, "bot-vi-custom")
    _sub(db, client, professional, bot_id=bot_pro.id)
    _sub(db, client, custom, bot_id=bot_custom.id)
    db.flush()

    assert ent.is_visitor_intelligence_enabled_for_bot(bot_pro.id, db) is True
    assert ent.is_visitor_intelligence_enabled_for_bot(bot_custom.id, db) is True


def test_a_new_seeded_ladder_tier_is_not_granted_by_accident(db):
    """The guard on rule 2. Bespoke slugs get paid features; a tier added to
    the standard ladder must NOT. Adding it to `_SEEDED_PLAN_SLUGS` is part
    of adding the tier, which forces a deliberate per-feature choice."""
    assert "starter" in ent._SEEDED_PLAN_SLUGS
    assert ent._paid_tier_includes("starter", ent.EMAIL_VERIFICATION_SLUGS) is False
    assert ent._paid_tier_includes("free", ent.EMAIL_VERIFICATION_SLUGS) is False
    assert ent._paid_tier_includes("enterprise-acme", ent.EMAIL_VERIFICATION_SLUGS) is True
