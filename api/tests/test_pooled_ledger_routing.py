"""``resolve_bot_ledger_bot_id`` — which ledger bucket a bot's usage drains.

The credit ledger has exactly two scopes (``credit_service`` module docstring):
``bot_id IS NULL`` is the SHARED CLIENT POOL, ``bot_id = <int>`` is an ISOLATED
per-bot ledger. ``resolve_bot_ledger_bot_id`` is the single helper that maps a
``Bot`` row to one of them, and every credit call site threads its result
through — chat, ingestion, crawl, document upload, billing.

What these tests defend: an ACCOUNT-LEVEL subscription (``subscription.bot_id IS
NULL``) must pool EVERY bot under it. That is the whole mechanism behind a tier
that sells one credit balance across unlimited agents — the purchase funds the
client pool, and each agent has to be routed back to that same pool. A refactor
that made the helper return ``bot.id`` for those bots would silently split the
pool: the first agent would spend from an isolated ledger nobody funded, the
rest would drain a pool the reporting no longer matches. Nothing would raise.

Both dispatch paths inside the helper are pinned separately, because the two
are reached by different callers and only one of them is on the hot chat route:

* **Fast path** — ``get_current_bot()`` pre-resolves ``subscription.bot_id``
  into ``bot._subscription_bot_id`` and then expunges the ORM object, so the
  widget/chat request routes a DETACHED bot without a lazy-load. Modelled by
  ``_DetachedBot``, whose ``subscription`` property raises: reaching for the
  relationship there is a ``DetachedInstanceError`` in production, so a test
  that quietly fell through to the slow path must fail loudly instead.
* **Slow path** — ``subscription_routes`` / billing endpoints hand over a live
  ORM object and the helper lazy-loads ``bot.subscription``. Modelled by real
  transient ``Bot`` / ``Subscription`` instances, which carry no
  ``_subscription_bot_id`` at all (asserted in the factory) so the sentinel
  branch is genuinely taken.

No database is required: the helper is pure attribute reads.
"""

from __future__ import annotations

import pytest

from app.db.models import Bot, Subscription
from app.services.credit_service import resolve_bot_ledger_bot_id

# ── Test doubles ─────────────────────────────────────────────────────────────


class _DetachedBot:
    """The expunged bot ``get_current_bot()`` hands the chat route.

    ``subscription`` raises rather than returning a value: on the real detached
    instance it raises ``DetachedInstanceError``, and the pre-resolved
    ``_subscription_bot_id`` exists precisely so the helper never touches it.
    Any test using this double therefore proves the FAST path was taken.
    """

    def __init__(
        self,
        *,
        bot_id: int | None,
        subscription_id: int | None,
        subscription_bot_id: int | None,
        is_legacy_pooled: bool = False,
    ) -> None:
        self.id = bot_id
        self.subscription_id = subscription_id
        self.is_legacy_pooled = is_legacy_pooled
        self._subscription_bot_id = subscription_bot_id

    @property
    def subscription(self) -> Subscription:
        raise AssertionError(
            "fast path must not touch the lazy `subscription` relationship — "
            "that is a DetachedInstanceError on the real expunged bot"
        )


def _session_bot(
    *,
    bot_id: int,
    subscription: Subscription | None,
    is_legacy_pooled: bool = False,
) -> Bot:
    """A live ORM bot as ``subscription_routes`` / billing endpoints see it.

    Transient (never added to a session), so ``bot.subscription`` resolves to
    whatever is assigned without touching a database.
    """
    bot = Bot(
        id=bot_id,
        client_id=1,
        name=f"Agent {bot_id}",
        bot_key=f"bot-{bot_id}",
        is_legacy_pooled=is_legacy_pooled,
        subscription_id=subscription.id if subscription is not None else None,
    )
    bot.subscription = subscription
    # The slow path is selected by the ABSENCE of the pre-resolved attribute.
    # If a future change starts stamping it in the constructor, these tests
    # would silently become fast-path duplicates.
    assert not hasattr(bot, "_subscription_bot_id")
    return bot


def _account_subscription(sub_id: int = 900) -> Subscription:
    """Account-level (pooled) subscription: ``bot_id`` is NULL."""
    return Subscription(id=sub_id, client_id=1, plan_id=1, bot_id=None)


def _bot_scoped_subscription(*, sub_id: int, bot_id: int) -> Subscription:
    """Per-bot subscription: ``bot_id`` names the bot it funds."""
    return Subscription(id=sub_id, client_id=1, plan_id=1, bot_id=bot_id)


# ── 1. An account-level subscription pools EVERY bot under it ────────────────
#
# The agency-tier invariant. Both agents point at the same account-scoped
# subscription; both must resolve to the client pool.


def test_account_level_subscription_pools_every_bot_slow_path():
    sub = _account_subscription()
    first = _session_bot(bot_id=11, subscription=sub)
    second = _session_bot(bot_id=12, subscription=sub)

    assert resolve_bot_ledger_bot_id(first) is None
    assert resolve_bot_ledger_bot_id(second) is None


def test_account_level_subscription_pools_every_bot_fast_path():
    first = _DetachedBot(bot_id=11, subscription_id=900, subscription_bot_id=None)
    second = _DetachedBot(bot_id=12, subscription_id=900, subscription_bot_id=None)

    assert resolve_bot_ledger_bot_id(first) is None
    assert resolve_bot_ledger_bot_id(second) is None


@pytest.mark.parametrize("bot_id", [1, 2, 3, 4, 5])
def test_account_level_subscription_pools_an_unlimited_roster(bot_id: int):
    """Scale is the point: no agent index resolves to its own ledger."""
    sub = _account_subscription()

    assert resolve_bot_ledger_bot_id(_session_bot(bot_id=bot_id, subscription=sub)) is None
    assert (
        resolve_bot_ledger_bot_id(_DetachedBot(bot_id=bot_id, subscription_id=sub.id, subscription_bot_id=None)) is None
    )


# ── 2. A bot-scoped subscription isolates that bot ───────────────────────────


def test_bot_scoped_subscription_isolates_that_bot_slow_path():
    sub = _bot_scoped_subscription(sub_id=901, bot_id=21)
    bot = _session_bot(bot_id=21, subscription=sub)

    assert resolve_bot_ledger_bot_id(bot) == 21


def test_bot_scoped_subscription_isolates_that_bot_fast_path():
    bot = _DetachedBot(bot_id=21, subscription_id=901, subscription_bot_id=21)

    assert resolve_bot_ledger_bot_id(bot) == 21


def test_subscription_scoped_to_a_different_bot_falls_back_to_the_pool():
    """``subscription.bot_id`` must MATCH — a foreign scope is not this bot's.

    Reading the subscription as "bot-scoped, therefore isolate" without
    comparing ids would drain agent 22's usage out of agent 21's funded ledger.
    """
    sub = _bot_scoped_subscription(sub_id=901, bot_id=21)
    other = _session_bot(bot_id=22, subscription=sub)

    assert resolve_bot_ledger_bot_id(other) is None
    assert resolve_bot_ledger_bot_id(_DetachedBot(bot_id=22, subscription_id=901, subscription_bot_id=21)) is None


# ── 3. Legacy-pooled bots stay pooled regardless of subscription ─────────────


@pytest.mark.parametrize(
    "subscription_factory",
    [
        pytest.param(lambda: None, id="no-subscription"),
        pytest.param(_account_subscription, id="account-level-subscription"),
        pytest.param(lambda: _bot_scoped_subscription(sub_id=902, bot_id=31), id="bot-scoped-subscription"),
    ],
)
def test_legacy_pooled_bot_resolves_to_the_pool_slow_path(subscription_factory):
    """``is_legacy_pooled`` short-circuits ahead of every other signal.

    Grandfathered bots keep spending from the client pool even when a bot-scoped
    subscription row exists that would otherwise isolate them.
    """
    bot = _session_bot(bot_id=31, subscription=subscription_factory(), is_legacy_pooled=True)

    assert resolve_bot_ledger_bot_id(bot) is None


@pytest.mark.parametrize(
    ("subscription_id", "subscription_bot_id"),
    [
        pytest.param(None, None, id="no-subscription"),
        pytest.param(900, None, id="account-level-subscription"),
        pytest.param(902, 31, id="bot-scoped-subscription"),
    ],
)
def test_legacy_pooled_bot_resolves_to_the_pool_fast_path(subscription_id, subscription_bot_id):
    bot = _DetachedBot(
        bot_id=31,
        subscription_id=subscription_id,
        subscription_bot_id=subscription_bot_id,
        is_legacy_pooled=True,
    )

    assert resolve_bot_ledger_bot_id(bot) is None


# ── 4. No subscription at all ────────────────────────────────────────────────


def test_bot_without_a_subscription_resolves_to_the_pool_slow_path():
    """The Free bot: no ``subscription_id``, so nothing to isolate against."""
    bot = _session_bot(bot_id=41, subscription=None)

    assert bot.subscription_id is None
    assert resolve_bot_ledger_bot_id(bot) is None


def test_bot_without_a_subscription_resolves_to_the_pool_fast_path():
    bot = _DetachedBot(bot_id=41, subscription_id=None, subscription_bot_id=None)

    assert resolve_bot_ledger_bot_id(bot) is None


def test_no_bot_at_all_resolves_to_the_pool():
    """``bot=None`` is a real call shape — e.g. ``db.get(Bot, bot_id)`` misses."""
    assert resolve_bot_ledger_bot_id(None) is None


# ── 5. The convenience pointer set by the per-bot-billing migration ──────────
#
# Straight off the helper's docstring: bots whose ``subscription_id`` is a
# convenience pointer set by the per-bot-billing migration, but whose
# subscription still has ``bot_id = NULL``. A non-NULL ``subscription_id`` is
# therefore NOT on its own evidence of an isolated ledger — only
# ``subscription.bot_id == bot.id`` is. Their credits live in the client pool.


def test_convenience_pointer_subscription_id_still_routes_to_the_pool_slow_path():
    sub = _account_subscription(sub_id=903)
    bot = _session_bot(bot_id=51, subscription=sub)

    # The pointer is set — the tempting-but-wrong signal to isolate on.
    assert bot.subscription_id == 903
    # The subscription it points at is still account-scoped.
    assert bot.subscription.bot_id is None
    assert resolve_bot_ledger_bot_id(bot) is None


def test_convenience_pointer_subscription_id_still_routes_to_the_pool_fast_path():
    bot = _DetachedBot(bot_id=51, subscription_id=903, subscription_bot_id=None)

    assert bot.subscription_id == 903
    assert resolve_bot_ledger_bot_id(bot) is None


# ── Path dispatch itself ─────────────────────────────────────────────────────


def test_pre_resolved_attribute_wins_over_the_relationship():
    """``_subscription_bot_id`` is the authority once ``get_current_bot`` sets it.

    Pinned with the two signals DISAGREEING, which is the only arrangement that
    can tell the paths apart. ``None`` is a legitimate pre-resolved value (the
    auth layer stamps exactly that for an account-level subscription), so it
    must not be mistaken for "not resolved yet" and fall through to a lazy-load.
    """
    bot = Bot(id=61, client_id=1, name="Agent 61", bot_key="bot-61", subscription_id=904)
    bot.subscription = _bot_scoped_subscription(sub_id=904, bot_id=61)
    # Relationship alone would isolate this bot...
    assert resolve_bot_ledger_bot_id(bot) == 61

    # ...but the pre-resolved account-level value overrides it.
    bot._subscription_bot_id = None
    assert resolve_bot_ledger_bot_id(bot) is None
