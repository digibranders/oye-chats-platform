"""Following up an urgent incident alert until the team can reach the visitor.

On 2026-09-28 an urgent alert reached a team with the name "Eva" and no email or
phone, and the owner asked how anyone could reach her. The alert goes out on the
visitor's first urgent message, before any form, and a panicked visitor may never
fill one in. Three pieces close the gap:

1. The urgent reply asks for a phone number or email in the chat and records
   which message asked (``mark_contact_asked``). On the next
   ``CONTACT_WINDOW_TURNS`` visitor turns, and only while the lead has neither
   an email nor a phone, ``rag_service`` reads the visitor's message with
   ``contact_details.find_contact``; this module saves what it finds to the lead
   the way the form does, never over a value already there
   (``save_urgent_contact``), and sends it to the team (``alert_team_of_contact``).
2. The alert itself says when there is no email or phone yet (``email_service``
   and ``notification_service``).
3. A delayed worker job (``run_no_contact_follow_up``) checks a few minutes
   after the alert. When neither the form nor the chat has given an email or a
   phone by then, the team hears so once, with whether the visitor is still on
   the page.

The worker cannot see the API's in-process record of who is on the page, so the
widget's five-second poll for operator invitations also writes a timestamp to the
shared cache while an urgent session waits for its follow-up (``record_presence``).
It writes only while a job is scheduled and unsettled, and for at most
``PRESENCE_GRACE_SECONDS`` past the job's due time: the alert records the due
time only when it enqueued a job, and the job settles the session on every
outcome. Without the cache the job falls back to the visitor's last activity.

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
#: ``inline_cards_shown`` key: set once the no-contact follow-up is settled for the
#: session, because it ran, or because it found nothing left to do.
NO_CONTACT_FOLLOW_UP_KEY = "urgent_no_contact_follow_up"
#: ``inline_cards_shown`` key: when the scheduled follow-up is due, as a unix time.
#: Set only when the alert enqueued the job, so no job means no heartbeat.
FOLLOW_UP_DUE_KEY = "urgent_no_contact_follow_up_due_at"
#: ``inline_cards_shown`` key: the id of the bot message that last asked the
#: visitor for a phone number or email.
CONTACT_ASKED_KEY = "urgent_contact_asked_after"
#: How many visitor turns after the ask are read for contact details.
CONTACT_WINDOW_TURNS = 2

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
#: How long past the follow-up's due time the heartbeat is still written, for a
#: worker that runs the job late. After it the poll writes nothing.
PRESENCE_GRACE_SECONDS = 600

_PRESENCE_PREFIX = "urgent_presence:"


# ── The session and the lead ────────────────────────────────────────────────


def _shown(chat_session: ChatSession | None) -> dict:
    shown = getattr(chat_session, "inline_cards_shown", None) if chat_session is not None else None
    return shown if isinstance(shown, dict) else {}


def is_urgent_session(chat_session: ChatSession | None) -> bool:
    """Whether the team was alerted to an urgent incident in this conversation."""
    return bool(_shown(chat_session).get(URGENT_NOTIFIED_KEY))


def _due_at(chat_session: ChatSession | None) -> float | None:
    due = _shown(chat_session).get(FOLLOW_UP_DUE_KEY)
    return float(due) if isinstance(due, int | float) and not isinstance(due, bool) else None


def follow_up_pending(chat_session: ChatSession | None) -> bool:
    """Whether a no-contact follow-up job was scheduled for this session and is not settled."""
    return (
        is_urgent_session(chat_session)
        and _due_at(chat_session) is not None
        and not _shown(chat_session).get(NO_CONTACT_FOLLOW_UP_KEY)
    )


def awaits_follow_up(chat_session: ChatSession | None, *, now: float | None = None) -> bool:
    """Whether the widget's poll should write the presence heartbeat for this session.

    Only while a scheduled follow-up is pending, and no later than
    ``PRESENCE_GRACE_SECONDS`` past its due time.
    """
    if not follow_up_pending(chat_session):
        return False
    due_at = _due_at(chat_session)
    moment = time.time() if now is None else now
    return due_at is not None and moment <= due_at + PRESENCE_GRACE_SECONDS


def _set_flag(chat_session: ChatSession, key: str, value: object) -> None:
    shown = dict(_shown(chat_session))
    shown[key] = value
    # JSONB is tracked only when the value is reassigned.
    chat_session.inline_cards_shown = shown


def mark_follow_up_due(chat_session: ChatSession | None, due_at: float) -> None:
    """Record that a follow-up job was enqueued and when it is due. The caller commits."""
    if chat_session is not None:
        _set_flag(chat_session, FOLLOW_UP_DUE_KEY, due_at)


def settle_follow_up(chat_session: ChatSession | None) -> None:
    """Record that the follow-up has nothing (more) to do, which stops the heartbeat. The caller commits."""
    if chat_session is not None and not _shown(chat_session).get(NO_CONTACT_FOLLOW_UP_KEY):
        _set_flag(chat_session, NO_CONTACT_FOLLOW_UP_KEY, True)


def mark_contact_asked(chat_session: ChatSession | None, message_id: int) -> None:
    """Record the bot message that asked for a phone number or email. The caller commits."""
    if chat_session is not None:
        _set_flag(chat_session, CONTACT_ASKED_KEY, message_id)


def in_contact_window(db, chat_session: ChatSession | None) -> bool:
    """Whether this visitor turn is one of the first ``CONTACT_WINDOW_TURNS`` after the ask.

    The visitor's message is saved before the pipeline runs, so the count
    includes it.
    """
    asked_after = _shown(chat_session).get(CONTACT_ASKED_KEY)
    if chat_session is None or not isinstance(asked_after, int) or isinstance(asked_after, bool):
        return False
    turns = db.execute(
        select(func.count(ChatMessage.id)).where(
            ChatMessage.session_id == chat_session.id,
            ChatMessage.role == "user",
            ChatMessage.id > asked_after,
        )
    ).scalar_one()
    return 1 <= turns <= CONTACT_WINDOW_TURNS


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
    show the value. An email or a phone already on the lead is never replaced.
    Returns the visitor's name and the values saved and not sent to the team
    before, which are recorded as sent here, and settles the no-contact
    follow-up: the caller commits, then alerts. Flushes only.
    """
    existing = get_lead_info_by_session(session, session_id, bot_id=bot_id)
    email = found.email if not (existing is not None and existing.email) else None
    phone = found.phone if not (existing is not None and existing.phone) else None
    lead = create_or_update_lead_info(session, session_id=session_id, bot_id=bot_id, email=email, phone=phone)
    shown = dict(_shown(chat_session))
    stored = shown.get(CONTACTS_SENT_KEY)
    sent = [value for value in stored if isinstance(value, str)] if isinstance(stored, list) else []
    new_email = email if email and _normalised_email(email) not in sent else None
    new_phone = phone if phone and _normalised_phone(phone) not in sent else None
    if new_email:
        sent.append(_normalised_email(new_email))
    if new_phone:
        sent.append(_normalised_phone(new_phone))
    if new_email or new_phone:
        shown[CONTACTS_SENT_KEY] = sent
        # JSONB is tracked only when the value is reassigned.
        chat_session.inline_cards_shown = shown
    if lead_has_contact(lead):
        # The team can reach the visitor now: no reminder, no heartbeat.
        settle_follow_up(chat_session)
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
    """Note that the visitor's chat window is open, for the worker to read. Never raises.

    ``cache_set`` swallows a failed write, but ``get_redis`` raises in production
    when it cannot connect, and this runs inside the widget's poll, which must
    not turn into a 500 over a heartbeat.
    """
    try:
        cache_set(f"{_PRESENCE_PREFIX}{session_id}", {"seen_at": time.time()}, PRESENCE_TTL_SECONDS)
    except Exception:  # noqa: BLE001 - presence is best effort; the poll must answer
        logger.warning("urgent_presence_write_failed | session=%s", session_id, exc_info=True)


def presence_seen_at(session_id: str) -> float | None:
    """When the visitor's chat window last polled, if the shared cache knows. Never raises."""
    try:
        value = cache_get(f"{_PRESENCE_PREFIX}{session_id}")
    except Exception:  # noqa: BLE001 - the follow-up falls back to the last activity
        logger.warning("urgent_presence_read_failed | session=%s", session_id, exc_info=True)
        return None
    seen_at = value.get("seen_at") if isinstance(value, dict) else None
    return float(seen_at) if isinstance(seen_at, int | float) and not isinstance(seen_at, bool) else None


def _ago(seconds: float) -> str:
    minutes = int(max(seconds, 0) // 60)
    if minutes < 1:
        return "less than a minute ago"
    return "1 minute ago" if minutes == 1 else f"{minutes} minutes ago"


def _about_ago(seconds: float) -> str:
    minutes = int(max(seconds, 0) // 60)
    return "less than a minute ago" if minutes < 1 else f"about {_ago(seconds)}"


def describe_presence(
    *,
    status: str | None,
    seen_at: float | None,
    last_active_at: float | None,
    now: float,
    heartbeat_until: float | None = None,
) -> str:
    """One sentence on whether the visitor is still on the page.

    The widget's poll (``seen_at``) is the only live signal the worker has. The
    widget polls only while the chat panel is open, so a stale one says the chat
    window closed, not that the visitor left the page. The poll stops writing at
    ``heartbeat_until`` on purpose, so a record from that moment says nothing.
    Without it, the last visitor activity (a message, a page view) is all there
    is, and that cannot say whether the page is still open.
    """
    if status == "waiting":
        return "Waiting in the live chat queue now."
    if seen_at is not None:
        if now - seen_at <= PRESENCE_FRESH_SECONDS:
            return "Still on the page: their chat window checked in less than a minute ago."
        if heartbeat_until is not None and seen_at >= heartbeat_until - PRESENCE_FRESH_SECONDS:
            return (
                "Not known whether they are still on the page. "
                f"Their chat window last checked in {_ago(now - seen_at)}."
            )
        return f"Their chat window closed {_about_ago(now - seen_at)}."
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
    ``alert_team_of_contact`` already carried it), when an operator is assigned
    or in the chat, when the conversation is closed, or when it ran before. Each
    of those outcomes settles the session, so the widget's poll stops writing the
    presence heartbeat. The session row is locked and the run recorded before
    anything is sent, so a retry or a second job sends nothing twice. Owner
    previews never get here: their urgent turn alerts no one, so no job is
    scheduled. Returns True when the team was told.
    """
    from app.db.session import SessionLocal

    if SessionLocal is None:
        return False
    with SessionLocal() as db:
        chat_session = db.execute(
            select(ChatSession).where(ChatSession.id == session_id, ChatSession.bot_id == bot_id).with_for_update()
        ).scalar_one_or_none()
        if not follow_up_pending(chat_session):
            return False
        bot = db.get(Bot, bot_id)
        lead = get_lead_info_by_session(db, session_id, bot_id=bot_id)
        settle_follow_up(chat_session)
        if (
            bot is None
            or lead_has_contact(lead)
            or chat_session.status in ("live", "closed")
            or chat_session.assigned_operator_id is not None
        ):
            db.commit()
            return False
        visitor_name = lead.name if lead is not None and lead.name else None
        moment = time.time() if now is None else now
        due_at = _due_at(chat_session)
        presence = describe_presence(
            status=chat_session.status,
            seen_at=presence_seen_at(session_id),
            last_active_at=_last_active_at(db, chat_session),
            now=moment,
            heartbeat_until=(due_at + PRESENCE_GRACE_SECONDS) if due_at is not None else None,
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
