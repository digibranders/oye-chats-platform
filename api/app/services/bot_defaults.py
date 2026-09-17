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

from app.db.models import Client

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
