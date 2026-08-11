"""The per-agent enrichment toggles: default ON, and a real server-side gate.

Two metered enrichments — Reoon email verification and the IP→company lookup —
each sit behind THREE independent gates: the plan, the super-admin kill switch
(`feature.<name>_enabled`), and the customer's own toggle. All three must pass
before a credit is spent.

Both toggles default ON. The customer already pays for a plan that includes
these, so the control worth having is an OFF switch for someone who doesn't
want the credits spent — not an OFF default that leaves a paid feature
invisible until they find the Advanced tab.

`company_lookup_enabled` did not exist at all before this: the company lookup
had no customer control, only a super-admin switch and the plan gate, so a
Professional customer could not turn it off to save credits.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from app.api.chat_routes import _agent_enrichment_opt_in
from app.db.models import Bot, Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _bot(db, bot_id: int, **overrides) -> Bot:
    db.add(Client(id=bot_id, email=f"c{bot_id}@example.com", name="C", api_key=f"k{bot_id}"))
    db.flush()
    bot = Bot(id=bot_id, client_id=bot_id, bot_key=f"bot-tgl{bot_id}", name="B", is_active=True, **overrides)
    db.add(bot)
    db.commit()
    return bot


@pytest.mark.parametrize(
    ("action", "column"),
    [("email_verification", "email_verification_enabled"), ("company_name", "company_lookup_enabled")],
)
def test_both_toggles_default_on(db, action, column):
    """A newly created agent has both enrichments live, with no setup step."""
    bot = _bot(db, 60 if action == "email_verification" else 61)
    assert getattr(bot, column) is True

    with patch("app.api.chat_routes.get_session", return_value=_Ctx(db)):
        assert _agent_enrichment_opt_in(bot.id, action) is True


@pytest.mark.parametrize(
    ("action", "column"),
    [("email_verification", "email_verification_enabled"), ("company_name", "company_lookup_enabled")],
)
def test_turning_a_toggle_off_denies_the_enrichment(db, action, column):
    """The point of the switch: a customer who doesn't want the credits spent."""
    bot = _bot(db, 62 if action == "email_verification" else 63, **{column: False})

    with patch("app.api.chat_routes.get_session", return_value=_Ctx(db)):
        assert _agent_enrichment_opt_in(bot.id, action) is False


def test_the_two_toggles_are_independent(db):
    """Turning off email verification must not disable company lookup."""
    bot = _bot(db, 64, email_verification_enabled=False, company_lookup_enabled=True)

    with patch("app.api.chat_routes.get_session", return_value=_Ctx(db)):
        assert _agent_enrichment_opt_in(bot.id, "email_verification") is False
        assert _agent_enrichment_opt_in(bot.id, "company_name") is True


@pytest.mark.parametrize("action", ["email_verification", "company_name"])
def test_a_missing_bot_denies_rather_than_defaulting_on(db, action):
    """Deny-by-default, matching the plan gates: failing open here spends the
    customer's money."""
    with patch("app.api.chat_routes.get_session", return_value=_Ctx(db)):
        assert _agent_enrichment_opt_in(999_999, action) is False
        assert _agent_enrichment_opt_in(None, action) is False


def test_an_unknown_action_denies(db):
    """A typo'd or future action name must not silently authorise a charge."""
    bot = _bot(db, 65)
    with patch("app.api.chat_routes.get_session", return_value=_Ctx(db)):
        assert _agent_enrichment_opt_in(bot.id, "not_a_real_enrichment") is False


def test_a_database_failure_denies(db):
    """The lookup sits directly in front of a credit deduction."""
    with patch("app.api.chat_routes.get_session", side_effect=RuntimeError("db down")):
        assert _agent_enrichment_opt_in(1, "company_name") is False


class _Ctx:
    """Minimal context-manager stand-in for `get_session()`."""

    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self.db

    def __exit__(self, *args):
        return False
