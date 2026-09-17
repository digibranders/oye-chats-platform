"""Starting values a new bot copies from the account that owns it.

Every bot-creation path (``POST /bots`` and the paid per-bot checkout) builds
its ``Bot`` with these so the console shows where alerts go from the first
screen, instead of an empty recipient field.

Deliberately not copied:

* ``reply_to_email``: resolved at send time by
  ``email_service.get_reply_to_address``, so it follows the owner's current
  address rather than a snapshot.
* ``business_hours``: NULL means always available, which is the right default.
* ``company_name`` is copied but not locked in ``manual_field_overrides``, so
  the first crawl can still replace it with what the site says.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.cache import bot_config_key, cache_delete
from app.db.models import Bot, Client

# ``UpdateBotRequest.company_name`` accepts at most this many characters. A
# longer copy would leave the bot unsaveable from the console.
MAX_BOT_COMPANY_NAME = 100


def owner_contact_defaults(session: Session, client_id: int) -> dict[str, Any]:
    """``Bot`` constructor kwargs taken from account ``client_id``.

    Returns an empty dict when the account row is missing, so a caller never
    fails to create a bot over a default.
    """
    row = session.execute(select(Client.email, Client.company_name).where(Client.id == client_id)).one_or_none()
    if row is None:
        return {}
    defaults: dict[str, Any] = {}
    email = _text(row.email)
    if email:
        defaults["notification_emails"] = {"default": [email]}
    company_name = _text(row.company_name)[:MAX_BOT_COMPANY_NAME].strip()
    if company_name:
        defaults["company_name"] = company_name
    return defaults


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def follow_owner_email_change(session: Session, client_id: int, old_email: str, new_email: str) -> None:
    """Move default recipient lists that are exactly the old owner address.

    A bot created or backfilled with the owner's address saved a copy of it.
    Before that copy existed, the send-time fallback followed the account's
    current email, so a list that is still only the old address follows the
    change too. A list the customer extended or replaced is left alone. The
    caller owns the commit.
    """
    old = old_email.strip().casefold()
    new = new_email.strip()
    if not old or not new or old == new.casefold():
        return
    bots = session.execute(select(Bot).where(Bot.client_id == client_id)).scalars().all()
    for bot in bots:
        routing = bot.notification_emails
        if not isinstance(routing, dict):
            continue
        listed = routing.get("default")
        if not (isinstance(listed, list) and len(listed) == 1 and isinstance(listed[0], str)):
            continue
        if listed[0].strip().casefold() != old:
            continue
        bot.notification_emails = {**routing, "default": [new]}
        cache_delete(bot_config_key(bot.bot_key))
