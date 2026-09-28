"""Following up an urgent incident alert until the team can reach the visitor.

On 2026-09-28 an urgent alert reached a team with the name "Eva" and no email or
phone, and the owner asked how anyone could reach her. The alert goes out on the
visitor's first urgent message, before any form, and a panicked visitor may never
fill one in. Three pieces close the gap:

1. The urgent reply asks for a phone number or email in the chat. On the next
   turns of that conversation ``rag_service`` reads the visitor's message with
   ``contact_details.find_contact``; this module saves what it finds to the lead
   the way the form does (``save_urgent_contact``) and sends the team each new
   value once (``alert_team_of_contact``).
2. The alert itself says when there is no email or phone yet (``email_service``
   and ``notification_service``).
3. A delayed worker job (``run_no_contact_follow_up``) checks a few minutes
   after the alert. When neither the form nor the chat has given an email or a
   phone by then, the team hears so once, with whether the visitor is still on
   the page.

The worker cannot see the API's in-process record of who is on the page, so the
widget's five-second poll for operator invitations also writes a timestamp to the
shared cache while an urgent session waits for its follow-up (``record_presence``).
Without the cache the job falls back to the visitor's last activity.

Every team message here goes to the bot's ``handoff_request`` list, as the alert
did, and never raises into the caller: an alert failure must not cost the
visitor their reply.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime

from sqlalchemy import func, select

from app.core.cache import cache_get, cache_set
from app.db.models import Bot, ChatMessage, ChatSession, LeadInfo
from app.db.repository import create_or_update_lead_info, get_lead_info_by_session
from app.services.contact_details import FoundContact
from app.services.email_service import (
    get_notification_recipients,
    get_reply_to_address,
    send_urgent_contact_email,
    send_urgent_no_contact_email,
)
from app.services.notification_service import notify_urgent_follow_up

logger = logging.getLogger(__name__)

#: ``ChatSession.inline_cards_shown`` key ``rag_service`` sets once the team was alerted.
URGENT_NOTIFIED_KEY = "urgent_notified"
#: ``inline_cards_shown`` key: the normalised contact values already sent to the team.
CONTACTS_SENT_KEY = "urgent_contacts_sent"
#: ``inline_cards_shown`` key: set once the no-contact follow-up has run for the session.
NO_CONTACT_FOLLOW_UP_KEY = "urgent_no_contact_follow_up"

#: The worker task that sends the no-contact follow-up.
NO_CONTACT_FOLLOW_UP_TASK = "task_urgent_no_contact_follow_up"
#: How long after the alert the follow-up checks for contact details.
NO_CONTACT_FOLLOW_UP_DELAY_SECONDS = 180

#: How long a presence timestamp is kept. Far longer than the follow-up delay, so a
#: late job still finds it.
PRESENCE_TTL_SECONDS = 3600
#: A timestamp younger than this means the page is open. The widget polls every
#: five seconds and the API itself forgets a session after twenty.
PRESENCE_FRESH_SECONDS = 30

_PRESENCE_PREFIX = "urgent_presence:"


# ── The session and the lead ────────────────────────────────────────────────


def _shown(chat_session: ChatSession | None) -> dict:
    shown = getattr(chat_session, "inline_cards_shown", None) if chat_session is not None else None
    return shown if isinstance(shown, dict) else {}


def is_urgent_session(chat_session: ChatSession | None) -> bool:
    """Whether the team was alerted to an urgent incident in this conversation."""
    return bool(_shown(chat_session).get(URGENT_NOTIFIED_KEY))


def awaits_follow_up(chat_session: ChatSession | None) -> bool:
    """Whether this urgent session's no-contact follow-up has yet to run."""
    return is_urgent_session(chat_session) and not _shown(chat_session).get(NO_CONTACT_FOLLOW_UP_KEY)


def lead_has_contact(lead: LeadInfo | None) -> bool:
    """Whether the team can reach the visitor outside the chat."""
    return lead is not None and bool(lead.email or lead.phone)


def _normalised_email(email: str) -> str:
    return f"email:{email.strip().lower()}"


def _normalised_phone(phone: str) -> str:
    digits = "".join(char for char in phone if char.isdigit())
    return f"phone:{'+' if phone.lstrip().startswith('+') else ''}{digits}"


def save_urgent_contact(
    session, chat_session: ChatSession, *, bot_id: int, session_id: str, found: FoundContact
) -> tuple[str | None, FoundContact]:
    """Save ``found`` to the session's lead and pick out what the team has not been sent.

    The lead is written with ``create_or_update_lead_info``, as the chat form's
    ``/chat/lead-capture`` writes it, so the leads view and every later alert
    show the value. Returns the visitor's name and the values not sent to the
    team before, which are recorded as sent here: the caller commits, then
    alerts. Flushes only.
    """
    lead = create_or_update_lead_info(
        session, session_id=session_id, bot_id=bot_id, email=found.email, phone=found.phone
    )
    shown = dict(_shown(chat_session))
    stored = shown.get(CONTACTS_SENT_KEY)
    sent = [value for value in stored if isinstance(value, str)] if isinstance(stored, list) else []
    new_email = found.email if found.email and _normalised_email(found.email) not in sent else None
    new_phone = found.phone if found.phone and _normalised_phone(found.phone) not in sent else None
    if new_email:
        sent.append(_normalised_email(new_email))
    if new_phone:
        sent.append(_normalised_phone(new_phone))
    if new_email or new_phone:
        shown[CONTACTS_SENT_KEY] = sent
        # JSONB is tracked only when the value is reassigned.
        chat_session.inline_cards_shown = shown
    session.flush()
    return (lead.name or None), FoundContact(email=new_email, phone=new_phone)


def contact_acknowledgement(found: FoundContact) -> str:
    """The one-sentence reply to a visitor who typed their contact details."""
    return f"Thanks, the team will reach you on {' or '.join(found.values())}."


# ── Telling the team ─────────────────────────────────────────────────────────


def _email_recipients(bot: Bot | None) -> tuple[list[str], str | None]:
    """The alert's recipients: the ``handoff_request`` list, unless the owner turned handoff email off."""
    if bot is None or not bool(getattr(bot, "email_on_handoff", True)):
        return [], None
    recipients = get_notification_recipients(bot, "handoff_request")
    return recipients, (get_reply_to_address(bot) if recipients else None)


def _notify(session, *, client_id: int, session_id: str, title: str, body: str, kind: str) -> None:
    """The inbox update. ``create_notification`` commits the session, so a failure is rolled back."""
    try:
        notify_urgent_follow_up(session, client_id=client_id, session_id=session_id, title=title, body=body, kind=kind)
    except Exception:  # noqa: BLE001 - the email still goes out
        logger.warning("urgent_follow_up_notification_failed | kind=%s session=%s", kind, session_id, exc_info=True)
        session.rollback()


def alert_team_of_contact(
    session, bot: Bot, *, client_id: int, session_id: str, visitor_name: str | None, contact: FoundContact
) -> None:
    """Send the team contact details a visitor typed after an urgent alert. Never raises."""
    bot_name = getattr(bot, "name", None)
    who = visitor_name or "a visitor"
    title = f"Contact details for {who}: {', '.join(contact.values())}"
    body = f"Shared in the chat after the incident report on {bot_name}." if bot_name else "Shared in the chat."
    _notify(session, client_id=client_id, session_id=session_id, title=title, body=body, kind="contact")
    recipients, reply_to = _email_recipients(bot)
    for recipient in recipients:
        try:
            send_urgent_contact_email(
                recipient,
                bot_name,
                visitor_name,
                email=contact.email,
                phone=contact.phone,
                reply_to=reply_to,
                session_id=session_id,
            )
        except Exception:  # noqa: BLE001 - one bad address must not cost the rest of the team the update
            logger.warning("urgent_contact_email_failed | bot=%s session=%s", getattr(bot, "id", None), session_id)


# ── Presence ─────────────────────────────────────────────────────────────────


def record_presence(session_id: str) -> None:
    """Note that the visitor's widget is open on the page, for the worker to read. Best effort."""
    cache_set(f"{_PRESENCE_PREFIX}{session_id}", {"seen_at": time.time()}, PRESENCE_TTL_SECONDS)


def presence_seen_at(session_id: str) -> float | None:
    """When the visitor's widget last polled from the page, if the shared cache knows."""
    value = cache_get(f"{_PRESENCE_PREFIX}{session_id}")
    seen_at = value.get("seen_at") if isinstance(value, dict) else None
    return float(seen_at) if isinstance(seen_at, int | float) else None


def _ago(seconds: float) -> str:
    minutes = int(max(seconds, 0) // 60)
    if minutes < 1:
        return "less than a minute ago"
    return "1 minute ago" if minutes == 1 else f"{minutes} minutes ago"


def describe_presence(*, status: str | None, seen_at: float | None, last_active_at: float | None, now: float) -> str:
    """One sentence on whether the visitor is still on the page.

    The widget's poll (``seen_at``) is the only live signal the worker has. It
    stops when the tab closes, so a stale one means the visitor has probably
    left. Without it, the last visitor activity (a message, a page view) is all
    there is, and that cannot say whether the page is still open.
    """
    if status == "waiting":
        return "Waiting in the live chat queue now."
    if seen_at is not None:
        if now - seen_at <= PRESENCE_FRESH_SECONDS:
            return "Still on the page: their chat window checked in less than a minute ago."
        return f"Probably left the page: their chat window last checked in {_ago(now - seen_at)}."
    if last_active_at is not None:
        return f"Not known whether they are still on the page. Last active {_ago(now - last_active_at)}."
    return "Not known whether they are still on the page."


def _last_active_at(db, chat_session: ChatSession) -> float | None:
    """The later of the visitor's last message and the session's last recorded activity."""
    last_message = db.execute(
        select(func.max(ChatMessage.created_at)).where(
            ChatMessage.session_id == chat_session.id, ChatMessage.role == "user"
        )
    ).scalar_one_or_none()
    moments = [moment for moment in (last_message, chat_session.last_active_at) if isinstance(moment, datetime)]
    if not moments:
        return None
    return max(moment if moment.tzinfo else moment.replace(tzinfo=UTC) for moment in moments).timestamp()


# ── The delayed follow-up ────────────────────────────────────────────────────


def run_no_contact_follow_up(session_id: str, bot_id: int, alerted_at: float, *, now: float | None = None) -> bool:
    """Tell the team, once, that a visitor who reported an urgent incident left no contact details.

    Runs in the worker a few minutes after the alert. Does nothing when the
    session has an email or a phone by then (the form's email or
    ``alert_team_of_contact`` already carried it), when an operator is already in
    the chat, or when it ran before. The session row is locked and the run
    recorded before anything is sent, so a retry or a second job sends nothing
    twice. Owner previews never get here: their urgent turn alerts no one, so no
    job is scheduled. Returns True when the team was told.
    """
    from app.db.session import SessionLocal

    if SessionLocal is None:
        return False
    with SessionLocal() as db:
        chat_session = db.execute(
            select(ChatSession).where(ChatSession.id == session_id, ChatSession.bot_id == bot_id).with_for_update()
        ).scalar_one_or_none()
        if not awaits_follow_up(chat_session):
            return False
        bot = db.get(Bot, bot_id)
        lead = get_lead_info_by_session(db, session_id, bot_id=bot_id)
        if bot is None or lead_has_contact(lead) or chat_session.status == "live":
            return False
        shown = dict(_shown(chat_session))
        shown[NO_CONTACT_FOLLOW_UP_KEY] = True
        chat_session.inline_cards_shown = shown
        visitor_name = lead.name if lead is not None and lead.name else None
        moment = time.time() if now is None else now
        presence = describe_presence(
            status=chat_session.status,
            seen_at=presence_seen_at(session_id),
            last_active_at=_last_active_at(db, chat_session),
            now=moment,
        )
        client_id = bot.client_id
        bot_name = bot.name
        db.commit()

        _notify(
            db,
            client_id=client_id,
            session_id=session_id,
            title=f"Still no contact details for {visitor_name or 'a visitor'}",
            body=presence,
            kind="no_contact",
        )
        recipients, reply_to = _email_recipients(bot)
        minutes_since_alert = max(1, round((moment - alerted_at) / 60))
        for recipient in recipients:
            try:
                send_urgent_no_contact_email(
                    recipient,
                    bot_name,
                    visitor_name,
                    presence=presence,
                    minutes_since_alert=minutes_since_alert,
                    reply_to=reply_to,
                    session_id=session_id,
                )
            except Exception:  # noqa: BLE001 - one bad address must not cost the rest of the team the reminder
                logger.warning("urgent_no_contact_email_failed | bot=%s session=%s", bot_id, session_id)
    return True
