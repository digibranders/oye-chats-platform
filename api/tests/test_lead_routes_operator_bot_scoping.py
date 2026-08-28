"""An operator sees the leads of the ONE bot they are bound to, and no other.

``Operator.bot_id`` is a NOT NULL one-to-one binding, and the rest of the
product already treats it as a hard boundary: ``bot_routes.list_bots`` filters
to it because "operators must not see or switch to other bots in the
workspace", and ``offline_message_routes.list_offline_messages`` scopes the
visitor contact details it serves the same way, overriding the ``bot_id`` query
parameter "so a modified request can't peek at a sibling bot's inbox".

Every route in ``lead_routes`` scoped on ``auth["client_id"]`` alone. For an
operator that is the WORKSPACE OWNER's id, so an operator bound to bot A was
served every bot's leads, every bot's suppression list, and could suppress an
address on a bot they have no access to. Leads are visitor PII (name, email,
phone, company, transcript) — the widest of the three surfaces, and the only
one that leaked.

Cross-TENANT scoping was never broken and is pinned here too, so narrowing the
operator case cannot quietly widen the client case.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import contextmanager

import pytest
from fastapi import HTTPException

from app.api import lead_routes
from app.db.models import Bot, ChatSession, Client, EmailSuppression, LeadInfo, Operator

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


@pytest.fixture()
def workspace(db, monkeypatch):
    """One workspace, two bots, an operator bound to the first bot only.

    Plus a second, unrelated tenant, so the cross-tenant assertions have
    something real to fail against.
    """
    monkeypatch.setattr(lead_routes, "get_session", lambda: _ctx(db))
    # Leads dashboard entitlement resolution is a separate concern with its own
    # tests; these routes are called directly, so the router-level gate does not
    # run, but the per-route intelligence flag does.
    monkeypatch.setattr(lead_routes, "is_lead_intelligence_enabled", lambda client_id, session: True)
    monkeypatch.setattr(lead_routes, "is_lead_source_attribution_enabled", lambda client_id, session: True)

    owner = Client(name="Owner", email="owner@ws.test", api_key="key-owner")
    other = Client(name="Other tenant", email="other@else.test", api_key="key-other")
    db.add_all([owner, other])
    db.flush()

    bot_a = Bot(client_id=owner.id, bot_key="bot-a", name="Bot A", is_active=True)
    bot_b = Bot(client_id=owner.id, bot_key="bot-b", name="Bot B", is_active=True)
    foreign_bot = Bot(client_id=other.id, bot_key="bot-x", name="Foreign", is_active=True)
    db.add_all([bot_a, bot_b, foreign_bot])
    db.flush()

    operator = Operator(
        client_id=owner.id,
        bot_id=bot_a.id,
        name="Op A",
        email="op-a@ws.test",
        operator_api_key="op-key-a",
        role="operator",
    )
    db.add(operator)

    for bot, marker in ((bot_a, "a"), (bot_b, "b"), (foreign_bot, "x")):
        db.add(ChatSession(id=f"sess-{marker}", bot_id=bot.id, status="closed"))
        db.flush()
        db.add(LeadInfo(session_id=f"sess-{marker}", bot_id=bot.id, email=f"visitor@{marker}.test", name=f"V{marker}"))
        db.add(EmailSuppression(bot_id=bot.id, email=f"secret@{marker}.test", reason="unsubscribe"))
    db.commit()

    return {
        "owner_auth": {"type": "client", "entity": owner, "client_id": owner.id, "operator_id": None},
        "operator_auth": {
            "type": "operator",
            "entity": operator,
            "client_id": owner.id,
            "operator_id": operator.id,
            "bot_id": bot_a.id,
        },
        "bot_a": bot_a.id,
        "bot_b": bot_b.id,
        "foreign_bot": foreign_bot.id,
    }


# ── The helper every lead route scopes with ─────────────────────────────────


def test_an_operator_resolves_to_their_own_bot_only(db, workspace):
    assert lead_routes._resolve_client_bot_ids(db, workspace["operator_auth"], None) == [workspace["bot_a"]]


def test_the_workspace_owner_still_sees_every_bot(db, workspace):
    assert sorted(lead_routes._resolve_client_bot_ids(db, workspace["owner_auth"], None)) == sorted(
        [workspace["bot_a"], workspace["bot_b"]]
    )


def test_an_operator_naming_a_sibling_bot_is_refused(db, workspace):
    """The URL is not an escape hatch: asking for bot B by id must 403."""
    with pytest.raises(HTTPException) as exc:
        lead_routes._resolve_client_bot_ids(db, workspace["operator_auth"], workspace["bot_b"])
    assert exc.value.status_code == 403


def test_an_operator_naming_their_own_bot_is_allowed(db, workspace):
    assert lead_routes._resolve_client_bot_ids(db, workspace["operator_auth"], workspace["bot_a"]) == [
        workspace["bot_a"]
    ]


@pytest.mark.parametrize("actor", ["owner_auth", "operator_auth"])
def test_another_tenants_bot_is_refused(db, workspace, actor):
    with pytest.raises(HTTPException) as exc:
        lead_routes._resolve_client_bot_ids(db, workspace[actor], workspace["foreign_bot"])
    assert exc.value.status_code == 403


# ── The surfaces that serve visitor PII ─────────────────────────────────────


def test_suppressions_do_not_leak_across_bots(db, workspace):
    """``EmailSuppression`` rows are visitor addresses, one per bot."""
    served = lead_routes.list_suppressions(bot_id=None, page=1, limit=50, search=None, auth=workspace["operator_auth"])
    assert {row["bot_id"] for row in served["suppressions"]} == {workspace["bot_a"]}
    assert served["total"] == 1


def test_an_operator_cannot_suppress_an_address_on_a_sibling_bot(db, workspace):
    """Suppression is a WRITE: it silences a bot's follow-ups permanently."""
    body = lead_routes.CreateSuppressionRequest(bot_id=workspace["bot_b"], email="victim@b.test")
    with pytest.raises(HTTPException) as exc:
        lead_routes.create_suppression(body=body, auth=workspace["operator_auth"])
    assert exc.value.status_code == 403
    assert db.query(EmailSuppression).filter_by(email="victim@b.test").first() is None


def _emails(served: dict) -> set[str]:
    """The lead payload identifies the visitor, not the bot; the email is the tell."""
    return {lead["contact"]["email"] for lead in served["leads"]}


def test_the_lead_list_does_not_leak_across_bots(db, workspace):
    served = lead_routes.list_leads(
        bot_id=None,
        tier=None,
        status=None,
        min_score=None,
        days=None,
        from_date=None,
        to_date=None,
        page=1,
        limit=50,
        auth=workspace["operator_auth"],
    )
    assert _emails(served) == {"visitor@a.test"}


def test_the_csv_export_does_not_leak_across_bots(db, workspace):
    resp = lead_routes.export_leads_csv(bot_id=None, auth=workspace["operator_auth"])

    # A StreamingResponse: the CSV is generated on an async iterator, not buffered.
    async def _drain() -> str:
        chunks = [chunk async for chunk in resp.body_iterator]
        return "".join(c if isinstance(c, str) else c.decode() for c in chunks)

    body = asyncio.run(_drain())
    assert "visitor@a.test" in body
    assert "visitor@b.test" not in body


def test_lead_stats_count_only_the_operators_own_bot(db, workspace):
    stats = lead_routes.lead_stats(
        bot_id=None, days=None, from_date=None, to_date=None, auth=workspace["operator_auth"]
    )
    assert stats["total"] == 1


def test_a_sibling_bots_lead_is_not_readable_by_id(db, workspace):
    with pytest.raises(HTTPException) as exc:
        lead_routes.get_lead_detail(session_id="sess-b", auth=workspace["operator_auth"])
    assert exc.value.status_code == 404


def test_the_owner_still_sees_both_bots_leads(db, workspace):
    """The narrowing is operator-only; the workspace owner loses nothing."""
    served = lead_routes.list_leads(
        bot_id=None,
        tier=None,
        status=None,
        min_score=None,
        days=None,
        from_date=None,
        to_date=None,
        page=1,
        limit=50,
        auth=workspace["owner_auth"],
    )
    assert _emails(served) == {"visitor@a.test", "visitor@b.test"}
    suppressions = lead_routes.list_suppressions(
        bot_id=None, page=1, limit=50, search=None, auth=workspace["owner_auth"]
    )
    assert {row["bot_id"] for row in suppressions["suppressions"]} == {workspace["bot_a"], workspace["bot_b"]}
