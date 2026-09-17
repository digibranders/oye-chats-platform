"""A new bot starts with somewhere to send mail, and replies reach a person.

Production audit, 2026-09-17: all eight bots had ``notification_emails``,
``notification_email`` and ``reply_to_email`` NULL. Alerts still reached the
owner through the send-time fallback in ``get_notification_recipients``, but
the console showed an empty recipient field, and with no Reply-To header a
reply to a team alert or a visitor's quote email went to
notifications@oyechats.com and was lost.

Now:

* both creation paths (``POST /bots`` and the paid per-bot checkout) save the
  owner's account email as the default recipient and copy the account's
  company name when it has one;
* ``get_reply_to_address`` resolves a saved Reply-To, then the owner's
  account email, and every sender reads it through that one function;
* ``BotResponse.owner_email`` tells the console which address the fallbacks
  use, since the viewer may be an invited member rather than the owner.
"""

from __future__ import annotations

import ast
import os
from itertools import count
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.db.models import Bot, Client
from app.services.email_service import get_reply_to_address
from tests.test_bot_pause_and_widget_heartbeat import _db_app, _mk_bot, _mk_client

pg = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

OWNER = "owner@acme.test"
_seq = count(1)


@pytest.fixture()
def _no_entitlements_cache(monkeypatch):
    from app.services import plan_entitlements_service

    monkeypatch.setattr(plan_entitlements_service, "get_redis", lambda: None)


def _client(db, *, email: str = OWNER, company_name: str | None = None) -> Client:
    n = next(_seq)
    client = Client(
        name=f"Owner {n}",
        email=email,
        api_key=f"contact-defaults-{n}",
        hashed_password="h",
        company_name=company_name,
    )
    db.add(client)
    db.commit()
    return client


# ── Reply-To resolution ──────────────────────────────────────────────────────


@pg
def test_a_saved_reply_to_wins(db):
    client = _client(db)
    bot = _mk_bot(db, client, f"bot-reply-saved-{next(_seq)}", reply_to_email=" support@acme.test ")

    assert get_reply_to_address(bot) == "support@acme.test"


@pg
@pytest.mark.parametrize("saved", [None, "", "   "], ids=["null", "empty", "blank"])
def test_an_unset_reply_to_falls_back_to_the_owner(db, saved):
    client = _client(db)
    bot = _mk_bot(db, client, f"bot-reply-unset-{next(_seq)}", reply_to_email=saved)

    assert get_reply_to_address(bot) == OWNER


@pg
def test_a_cache_stand_in_resolves_by_its_account_id(db):
    client = _client(db)
    stand_in = SimpleNamespace(id=1, client_id=client.id, reply_to_email=None)

    assert get_reply_to_address(stand_in) == OWNER


def test_no_saved_address_and_no_account_gives_no_reply_to():
    assert get_reply_to_address(SimpleNamespace(id=1, client_id=None, reply_to_email=None)) is None
    assert get_reply_to_address(None) is None


_REPLY_TO_READERS_ALLOWED = {
    # The resolver itself.
    "app/services/email_service.py",
    # Serializers and the settings patch: they publish or store the saved value.
    "app/api/bot_routes.py",
    "app/api/auth.py",
}


def test_every_sender_reads_reply_to_through_the_resolver():
    """A direct ``bot.reply_to_email`` read skips the owner fallback.

    Reading the attribute (``bot.reply_to_email`` or
    ``getattr(bot, "reply_to_email", ...)``) outside the files that store or
    publish it means a sender built its own Reply-To and lost the fallback.
    """
    root = Path(__file__).resolve().parents[1]
    offenders: list[str] = []
    for path in sorted((root / "app").rglob("*.py")):
        rel = path.relative_to(root).as_posix()
        if rel in _REPLY_TO_READERS_ALLOWED or rel.startswith("app/db/"):
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            direct = isinstance(node, ast.Attribute) and node.attr == "reply_to_email"
            via_getattr = (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "getattr"
                and len(node.args) >= 2
                and isinstance(node.args[1], ast.Constant)
                and node.args[1].value == "reply_to_email"
            )
            if direct or via_getattr:
                offenders.append(f"{rel}:{node.lineno}")
    assert offenders == [], f"use email_service.get_reply_to_address instead: {offenders}"


@pg
def test_an_offline_message_alert_carries_the_owner_as_reply_to(db, monkeypatch):
    from app.api import offline_message_routes
    from tests.test_notification_owner_fallback import _offline_client

    client = _client(db)
    bot = _mk_bot(db, client, f"bot-reply-offline-{next(_seq)}")
    db.commit()
    tc, _team = _offline_client(db, monkeypatch)
    reply_tos: list[str | None] = []
    monkeypatch.setattr(
        offline_message_routes, "send_offline_message_email", lambda **kw: reply_tos.append(kw.get("reply_to"))
    )

    response = tc.post(
        "/offline-messages",
        json={"bot_key": bot.bot_key, "name": "Asha", "email": "asha@visitor.test", "message": "Call me back."},
    )

    assert response.status_code == 200, response.text
    assert reply_tos == [OWNER]


# ── Creation defaults ────────────────────────────────────────────────────────


@pg
def test_a_bot_created_in_the_console_starts_with_the_owner_as_recipient(db, monkeypatch, _no_entitlements_cache):
    client = _mk_client(db, "create-owner@acme.test")
    client.company_name = "Acme Analytics"
    db.flush()
    tc = _db_app(db, monkeypatch, client.id)

    response = tc.post("/bots", json={"name": "Helper", "website": "https://acme.test"})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["notification_emails"] == {"default": ["create-owner@acme.test"]}
    assert body["company_name"] == "Acme Analytics"
    assert body["notifications_use_owner_fallback"] is False
    assert body["owner_email"] == "create-owner@acme.test"
    # Deliberately left unset: NULL hours mean always available, and an unset
    # Reply-To follows the owner's current address at send time.
    assert body["business_hours"] is None
    assert body["reply_to_email"] is None
    row = db.get(Bot, body["id"])
    assert row.manual_field_overrides == [], "a copied company name must stay refreshable by the crawl"


@pg
@pytest.mark.parametrize("company_name", [None, "", "   "], ids=["null", "empty", "blank"])
def test_an_account_without_a_company_name_leaves_it_for_the_crawl(
    db, monkeypatch, _no_entitlements_cache, company_name
):
    client = _mk_client(db, f"create-nocompany-{next(_seq)}@acme.test")
    client.company_name = company_name
    db.flush()
    tc = _db_app(db, monkeypatch, client.id)

    response = tc.post("/bots", json={"name": "Helper", "website": "https://acme.test"})

    assert response.status_code == 201, response.text
    assert response.json()["company_name"] is None


@pg
def test_a_bot_created_by_a_paid_checkout_starts_with_the_same_defaults(db):
    from app.services.razorpay_service import _create_bot_from_subscription_notes

    client = _client(db, email="paid-owner@acme.test", company_name="Paid Co")
    plan_id = _plan_id(db)

    bot = _create_bot_from_subscription_notes(db, client.id, None, plan_id, {"bot_name": "Paid bot"})

    assert bot.notification_emails == {"default": ["paid-owner@acme.test"]}
    assert bot.company_name == "Paid Co"
    assert bot.business_hours is None
    assert bot.reply_to_email is None


def _plan_id(db) -> int:
    from app.db.models import Plan

    plan = Plan(
        name="Contact Defaults",
        slug=f"contact-defaults-{next(_seq)}",
        monthly_price_cents=44900,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
        features={},
        limits={"bots": 1},
    )
    db.add(plan)
    db.flush()
    return plan.id


# ── Serializers publish the owner address ────────────────────────────────────


@pg
def test_both_serializers_publish_the_owner_email(db, monkeypatch, _no_entitlements_cache):
    client = _mk_client(db, "serializer-owner@acme.test")
    bot = _mk_bot(db, client, f"bot-owner-email-{next(_seq)}")
    db.flush()
    tc = _db_app(db, monkeypatch, client.id)

    one = tc.get(f"/bots/{bot.id}")
    listed = tc.get("/bots")

    assert one.status_code == 200 and listed.status_code == 200
    assert one.json()["owner_email"] == "serializer-owner@acme.test"
    assert [row["owner_email"] for row in listed.json()] == ["serializer-owner@acme.test"]


# ── Effective contact page ───────────────────────────────────────────────────


def _crawled_page(db, bot: Bot, url: str) -> None:
    from app.db.models import Document

    db.add(
        Document(
            bot_id=bot.id,
            client_id=bot.client_id,
            document_name=url,
            source="crawl",
            content="page",
            file_hash=url,
            embedding=[0.0] * 768,
        )
    )
    db.flush()


@pg
def test_the_contact_link_reports_a_crawled_contact_page(db, monkeypatch, _no_entitlements_cache):
    client = _mk_client(db, f"contact-crawl-{next(_seq)}@acme.test")
    bot = _mk_bot(db, client, f"bot-contact-crawl-{next(_seq)}")
    _crawled_page(db, bot, "https://acme.test/pricing")
    _crawled_page(db, bot, "https://acme.test/contact-us")
    tc = _db_app(db, monkeypatch, client.id)

    response = tc.get(f"/bots/{bot.id}/contact-link")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "effective_url": "https://acme.test/contact-us",
        "source": "crawl",
        "detected_url": "https://acme.test/contact-us",
    }


@pg
def test_a_contact_smart_link_outranks_the_crawl(db, monkeypatch, _no_entitlements_cache):
    client = _mk_client(db, f"contact-smart-{next(_seq)}@acme.test")
    bot = _mk_bot(
        db,
        client,
        f"bot-contact-smart-{next(_seq)}",
        answer_links=[{"keyword": "Contact", "url": " https://acme.test/talk "}],
    )
    _crawled_page(db, bot, "https://acme.test/contact")
    tc = _db_app(db, monkeypatch, client.id)

    response = tc.get(f"/bots/{bot.id}/contact-link")

    assert response.json() == {
        "effective_url": "https://acme.test/talk",
        "source": "smart_link",
        "detected_url": "https://acme.test/contact",
    }


@pg
def test_no_contact_page_anywhere_reads_as_none(db, monkeypatch, _no_entitlements_cache):
    client = _mk_client(db, f"contact-none-{next(_seq)}@acme.test")
    bot = _mk_bot(db, client, f"bot-contact-none-{next(_seq)}")
    other_client = _mk_client(db, f"contact-other-{next(_seq)}@acme.test")
    tc = _db_app(db, monkeypatch, other_client.id)

    assert tc.get(f"/bots/{bot.id}/contact-link").status_code == 404

    tc = _db_app(db, monkeypatch, client.id)
    response = tc.get(f"/bots/{bot.id}/contact-link")
    assert response.json() == {"effective_url": None, "source": None, "detected_url": None}


# ── An owner email change carries the saved default along ────────────────────


@pg
def test_a_default_list_that_is_the_old_owner_address_follows_the_change(db):
    from app.services.bot_defaults import follow_owner_email_change

    client = _client(db, email="old-owner@acme.test")
    followed = _mk_bot(
        db,
        client,
        f"bot-follow-{next(_seq)}",
        notification_emails={"default": ["Old-Owner@acme.test"], "qualified_lead": ["sales@acme.test"]},
    )
    chosen = _mk_bot(
        db, client, f"bot-chosen-{next(_seq)}", notification_emails={"default": ["old-owner@acme.test", "b@acme.test"]}
    )
    other_account = _client(db, email="someone@acme.test")
    foreign = _mk_bot(
        db, other_account, f"bot-foreign-{next(_seq)}", notification_emails={"default": ["old-owner@acme.test"]}
    )

    follow_owner_email_change(db, client.id, "old-owner@acme.test", "new-owner@acme.test")
    db.flush()

    assert followed.notification_emails == {"default": ["new-owner@acme.test"], "qualified_lead": ["sales@acme.test"]}
    assert chosen.notification_emails["default"] == ["old-owner@acme.test", "b@acme.test"]
    assert foreign.notification_emails == {"default": ["old-owner@acme.test"]}


def test_confirming_an_email_change_moves_the_saved_defaults():
    source = (Path(__file__).resolve().parents[1] / "app/api/client_routes.py").read_text(encoding="utf-8")
    body = source[source.index("def confirm_client_email_change") :]
    body = body[: body.index("\n@router")]
    assert "follow_owner_email_change(" in body
