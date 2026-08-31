"""The per-agent enrichment toggles: default OFF, and a real server-side gate.

Two metered enrichments (Reoon email verification and the IP→company lookup)
each sit behind THREE independent gates: the plan, the super-admin kill switch
(`feature.<name>_enabled`), and the customer's own toggle. All three must pass
before a credit is spent.

Both toggles default OFF (migration `b3d9f1a7c2e5`, which reversed the earlier
`c3f7a91b2d84`). Enrichment spends credits, so it is an explicit opt-in the
customer switches on rather than a metered feature left running until they
find the Advanced tab. The trade-off accepted here is discoverability: a
Standard or Professional customer sees nothing happen until they opt in, which
is what the Usage page's credit-cost rows and their deep link exist to solve.

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
def test_both_toggles_default_off(db, action, column):
    """A newly created agent has both enrichments OFF; enrichment is opt-in."""
    bot = _bot(db, 60 if action == "email_verification" else 61)
    assert getattr(bot, column) is False

    with patch("app.api.chat_routes.get_session", return_value=_Ctx(db)):
        assert _agent_enrichment_opt_in(bot.id, action) is False


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


class TestTheCallSitesPassTheRightAction:
    """The `action` argument is the only thing steering which column is read,
    and the email paths' tests monkeypatch the helper with
    `lambda *_a, **_k: ...`, which swallows the argument entirely.

    A review proved the gap: swapping "email_verification" for "company_name"
    at the lead-capture call site left the whole suite green. The deny-on-
    unknown-action guard is no help, both strings are valid keys, so a typo
    lands on the WRONG LIVE GATE instead of failing closed. A customer who
    turns Company lookup off to save credits would silently stop getting email
    verification, which they are paying for and did not disable.
    """

    @staticmethod
    def _actions_passed_in(func) -> set[str]:
        import inspect
        import re

        return set(re.findall(r'_agent_enrichment_opt_in\([^,]+,\s*"([a-z_]+)"', inspect.getsource(func)))

    def test_lead_capture_enrichment_gates_on_email_verification(self):
        from app.api import chat_routes

        assert self._actions_passed_in(chat_routes._enrich_lead_in_background) == {"email_verification"}

    def test_the_visitor_facing_verdict_gates_on_email_verification(self):
        """RETARGETED, not relaxed. The widget's blur check and the
        meeting-booking attendee check now ask one helper (``_email_verdict``)
        for a verdict instead of each restating the gate, so the gate is one
        function deeper than it was. The property under test is unchanged: the
        visitor-facing verification path reads the ``email_verification``
        toggle and nothing else, and both call sites really do go through it.
        """
        import inspect

        from app.api import chat_routes

        assert self._actions_passed_in(chat_routes._email_verdict) == {"email_verification"}
        for func in (chat_routes.validate_email_endpoint, chat_routes.meeting_booked_endpoint):
            assert "_email_verdict(" in inspect.getsource(func), f"{func.__name__} skips the shared verdict"

    def test_the_ip_resolver_gates_on_company_name(self):
        from app.api import chat_routes

        assert self._actions_passed_in(chat_routes._resolve_and_update_location) == {"company_name"}

    def test_every_action_used_at_a_call_site_is_a_known_column(self):
        """Catches the other direction, a call site inventing an action name
        that silently denies forever, since unknown actions deny."""
        import inspect
        import re

        from app.api import chat_routes

        used = set(
            re.findall(
                r'_agent_enrichment_opt_in\([^,]+,\s*"([a-z_]+)"',
                inspect.getsource(chat_routes),
            )
        )
        assert used, "no call sites found. Did the helper get renamed again?"
        assert used <= set(chat_routes._AGENT_TOGGLE_COLUMN), (
            f"call sites use unknown actions {sorted(used - set(chat_routes._AGENT_TOGGLE_COLUMN))}, "
            "which deny silently and forever"
        )
