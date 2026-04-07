"""Email notification service using Brevo (formerly Sendinblue) transactional API."""

import asyncio
import html
import json
import logging
from urllib.request import Request, urlopen

from app.config import BREVO_API_KEY, EMAIL_ENABLED, EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME

logger = logging.getLogger(__name__)

BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"


def _send_brevo_email(
    to_email: str,
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
) -> bool:
    """Send an email via Brevo transactional API. Returns True on success.

    Args:
        to_email: Recipient email address.
        subject: Email subject line.
        html_body: Full HTML content.
        reply_to: Optional Reply-To address (for branded "via OyeChats" emails).
        sender_name: Optional override for the sender display name.
    """
    if not EMAIL_ENABLED:
        logger.debug("Email not sent (Brevo not configured)")
        return False

    email_payload: dict = {
        "sender": {
            "name": sender_name or EMAIL_FROM_NAME,
            "email": EMAIL_FROM_ADDRESS,
        },
        "to": [{"email": to_email}],
        "subject": subject,
        "htmlContent": html_body,
    }
    if reply_to:
        email_payload["replyTo"] = {"email": reply_to}

    payload = json.dumps(email_payload).encode("utf-8")

    req = Request(
        BREVO_API_URL,
        data=payload,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "api-key": BREVO_API_KEY,
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=10) as resp:
            logger.info(f"Email sent to {to_email} | subject={subject} | status={resp.status}")
            return True
    except Exception as e:
        logger.error(f"Brevo email failed to {to_email}: {e}")
        return False


def send_email_async(
    to_email: str,
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
):
    """Fire-and-forget email sending. Non-blocking."""

    def _send():
        _send_brevo_email(to_email, subject, html_body, reply_to=reply_to, sender_name=sender_name)

    try:
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _send)
    except RuntimeError:
        import threading

        threading.Thread(target=_send, daemon=True).start()


def send_email_to_multiple(
    recipients: list[str],
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
):
    """Send the same email to multiple recipients (one API call per recipient). Non-blocking."""
    for email_addr in recipients:
        send_email_async(email_addr, subject, html_body, reply_to=reply_to, sender_name=sender_name)


def get_notification_recipients(bot, event_type: str) -> list[str]:
    """Resolve notification email recipients for a given event type.

    Resolution chain (first non-empty wins):
    1. bot.notification_emails[event_type] (per-event override)
    2. bot.notification_emails["default"]  (default list)
    3. bot.notification_email              (legacy single/comma-separated)
    4. Empty list
    """
    ne = bot.notification_emails
    if isinstance(ne, dict):
        # Per-event override
        event_list = ne.get(event_type)
        if isinstance(event_list, list) and event_list:
            return [e.strip() for e in event_list if e and e.strip()]

        # Default list
        default_list = ne.get("default")
        if isinstance(default_list, list) and default_list:
            return [e.strip() for e in default_list if e and e.strip()]

    # Legacy fallback — comma-separated single field
    if bot.notification_email:
        return [e.strip() for e in bot.notification_email.split(",") if e.strip()]

    return []


def _branded_sender_name(bot_name: str) -> str:
    """Build the 'BrandName via OyeChats' sender display name."""
    return f"{bot_name} via OyeChats"


# ── Email Templates ──


def _base_template(title: str, content: str) -> str:
    return f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
                sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px;">
        <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="font-size: 20px; font-weight: 700; color: #1a1a2e;
                       margin: 0;">OyeChats</h1>
        </div>
        <div style="background: #ffffff; border: 1px solid #e5e7eb;
                    border-radius: 12px; padding: 24px;">
            <h2 style="font-size: 18px; font-weight: 600; color: #1a1a2e;
                       margin: 0 0 16px 0;">{title}</h2>
            {content}
        </div>
        <p style="text-align: center; font-size: 12px; color: #9ca3af; margin-top: 24px;">
            Sent by OyeChats &middot; <a href="https://admin.oyechats.com" style="color: #6366f1;">View Dashboard</a>
        </p>
    </div>
    """


def _esc(value: str | None) -> str:
    """HTML-escape a user-supplied value for safe inclusion in email templates."""
    return html.escape(str(value)) if value else "—"


def send_qualified_lead_email(
    notification_email: str,
    bot_name: str,
    bant: dict,
    contact: dict | None = None,
    tier: str = "sql",
    *,
    reply_to: str | None = None,
):
    """Send email when a lead reaches a BANT qualification tier.

    Args:
        notification_email: Recipient address (or comma-separated list).
        bot_name: Name of the bot that captured the lead.
        bant: Dict with BANT fields (bant_need, bant_budget, bant_authority, bant_timeline).
        contact: Optional visitor contact info (name, email, phone, company).
        tier: Qualification tier — "mql" or "sql" (default "sql").
        reply_to: Optional Reply-To address for branded emails.
    """
    tier_upper = tier.upper()
    tier_labels: dict[str, str] = {
        "MQL": "Lead reached MQL",
        "SQL": "New SQL Lead",
    }
    tier_label = tier_labels.get(tier_upper, f"New {tier_upper} Lead")

    contact_section = ""
    if contact:
        parts = []
        if contact.get("name"):
            parts.append(f"<li><strong>Name:</strong> {_esc(contact['name'])}</li>")
        if contact.get("email"):
            parts.append(f"<li><strong>Email:</strong> {_esc(contact['email'])}</li>")
        if contact.get("phone"):
            parts.append(f"<li><strong>Phone:</strong> {_esc(contact['phone'])}</li>")
        if contact.get("company"):
            parts.append(f"<li><strong>Company:</strong> {_esc(contact['company'])}</li>")
        if parts:
            parts_html = "".join(parts)
            contact_section = (
                '<h3 style="font-size: 14px; font-weight: 600; color: #374151; '
                'margin: 16px 0 8px 0;">Contact Info</h3>'
                '<ul style="margin: 0; padding-left: 20px; color: #4b5563;">'
                f"{parts_html}</ul>"
            )

    # Build BANT summary rows, only including fields that have a value.
    bant_rows: list[str] = []
    for key, label in [
        ("bant_need", "Need"),
        ("bant_budget", "Budget"),
        ("bant_authority", "Authority"),
        ("bant_timeline", "Timeline"),
    ]:
        value = bant.get(key)
        if value:
            bant_rows.append(f"<li><strong>{label}:</strong> {_esc(value)}</li>")

    bant_section = ""
    if bant_rows:
        rows_html = "".join(bant_rows)
        bant_section = (
            '<div style="background: #f0fdf4; border-radius: 8px; padding: 16px; margin-bottom: 16px;">'
            '<h3 style="font-size: 14px; font-weight: 600; color: #166534; margin: 0 0 12px 0;">BANT Summary</h3>'
            f'<ul style="margin: 0; padding-left: 20px; color: #15803d; line-height: 1.8;">{rows_html}</ul>'
            "</div>"
        )

    content = f"""
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        A visitor on <strong>{bot_name}</strong> has reached <strong>{tier_upper}</strong> qualification.
    </p>
    {bant_section}
    {contact_section}
    <a href="https://admin.oyechats.com/leads"
        style="display: inline-block; background: #6366f1; color: #ffffff;
               padding: 10px 24px; border-radius: 8px; text-decoration: none;
               font-weight: 600; font-size: 14px; margin-top: 8px;">
        View in Dashboard
    </a>
    """
    sender = _branded_sender_name(bot_name)
    send_email_async(
        notification_email,
        f"[OyeChats] {tier_label} — {bot_name}",
        _base_template(f"{tier_label} \U0001f3af", content),
        reply_to=reply_to,
        sender_name=sender,
    )


def send_handoff_request_email(
    notification_email: str,
    bot_name: str,
    reason: str | None,
    contact: dict | None = None,
    *,
    reply_to: str | None = None,
):
    """Send email when a visitor requests live agent support."""
    contact_info = ""
    if contact:
        parts = []
        if contact.get("name"):
            parts.append(f"<strong>{_esc(contact['name'])}</strong>")
        if contact.get("email"):
            parts.append(_esc(contact["email"]))
        if parts:
            contact_info = f'<p style="color: #4b5563;">From: {" — ".join(parts)}</p>'

    content = f"""
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        A visitor on <strong>{bot_name}</strong> has requested to speak with a team member.
    </p>
    {contact_info}
    {
        (
            f'<div style="background: #fef3c7; border-radius: 8px; padding: 16px; '
            f'margin: 16px 0;"><p style="margin: 0; color: #92400e;"><strong>Reason:'
            f"</strong> {_esc(reason)}</p></div>"
        )
        if reason
        else ""
    }
    <a href="https://admin.oyechats.com/live-chat"
        style="display: inline-block; background: #6366f1; color: #ffffff;
               padding: 10px 24px; border-radius: 8px; text-decoration: none;
               font-weight: 600; font-size: 14px;">
        Open Live Chat
    </a>
    """
    sender = _branded_sender_name(bot_name)
    send_email_async(
        notification_email,
        f"[OyeChats] Live Chat Request — {bot_name}",
        _base_template("Live Chat Request 💬", content),
        reply_to=reply_to,
        sender_name=sender,
    )


def send_unavailable_callback_email(
    notification_email: str, bot_name: str, contact: dict, *, reply_to: str | None = None
):
    """Send email when no agent was available and visitor left contact details."""
    content = f"""
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        A visitor on <strong>{bot_name}</strong> requested live support but no
        agent was available. They left their contact details for a callback.
    </p>
    <div style="background: #fef2f2; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
        <ul style="margin: 0; padding-left: 20px; color: #991b1b; line-height: 1.8;">
            <li><strong>Name:</strong> {_esc(contact.get("name"))}</li>
            <li><strong>Email:</strong> {_esc(contact.get("email"))}</li>
            {(f"<li><strong>Phone:</strong> {_esc(contact.get('phone'))}</li>") if contact.get("phone") else ""}
        </ul>
    </div>
    <a href="https://admin.oyechats.com/leads"
        style="display: inline-block; background: #6366f1; color: #ffffff;
               padding: 10px 24px; border-radius: 8px; text-decoration: none;
               font-weight: 600; font-size: 14px;">
        Follow Up
    </a>
    """
    sender = _branded_sender_name(bot_name)
    send_email_async(
        notification_email,
        f"[OyeChats] Missed Chat — Callback Requested — {bot_name}",
        _base_template("Missed Chat — Callback Requested 📞", content),
        reply_to=reply_to,
        sender_name=sender,
    )


def send_offline_message_email(
    notification_email: str,
    bot_name: str,
    visitor_name: str,
    visitor_email: str,
    message_preview: str,
    *,
    reply_to: str | None = None,
):
    """Send email when a visitor leaves an offline message."""
    content = f"""
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        A visitor on <strong>{bot_name}</strong> left a message while no agent was available.
    </p>
    <div style="background: #f0f9ff; border-radius: 8px; padding: 16px;
               margin-bottom: 16px;">
        <p style="color: #4b5563; margin: 0 0 8px 0;"><strong>From:</strong>
           {_esc(visitor_name)} ({_esc(visitor_email)})</p>
        <p style="color: #1e3a5f; margin: 0; line-height: 1.6;
           white-space: pre-wrap;">{_esc(message_preview)}</p>
    </div>
    <a href="https://admin.oyechats.com/messages"
        style="display: inline-block; background: #6366f1; color: #ffffff;
               padding: 10px 24px; border-radius: 8px; text-decoration: none;
               font-weight: 600; font-size: 14px;">
        View Messages
    </a>
    """
    sender = _branded_sender_name(bot_name)
    send_email_async(
        notification_email,
        f"[OyeChats] New Offline Message — {bot_name}",
        _base_template("New Offline Message 📩", content),
        reply_to=reply_to,
        sender_name=sender,
    )


def send_password_reset_email(to_email: str, otp: str):
    """Send a password reset OTP email."""
    content = f"""
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        You recently requested to reset your password for your OyeChats account.
    </p>
    <div style="background: #f3f4f6; border: 1px dashed #d1d5db;
               border-radius: 8px; padding: 20px; text-align: center;
               margin-bottom: 24px; margin-top: 16px;">
        <p style="color: #6b7280; font-size: 13px; text-transform: uppercase;
           letter-spacing: 0.05em; margin: 0 0 8px 0;">Your Reset Code</p>
        <div style="font-family: monospace; font-size: 32px; font-weight: 700;
                    color: #111827; letter-spacing: 4px;">
            {otp}
        </div>
    </div>
    <p style="color: #4b5563; font-size: 14px; margin: 0;">
        This code is valid for <strong>15 minutes</strong>. If you did not
        request a password reset, please ignore this email or contact support
        if you have concerns.
    </p>
    """
    send_email_async(
        to_email,
        "Reset Your Password — OyeChats",
        _base_template("Password Reset Request 🔐", content),
    )


# ── New Email Templates (Email Integration) ──


def send_transcript_email(
    to_email: str,
    bot_name: str,
    messages: list[dict],
    *,
    reply_to: str | None = None,
):
    """Send a formatted chat transcript to the visitor's email.

    Args:
        to_email: Recipient (visitor) email address.
        bot_name: Display name of the bot.
        messages: List of dicts with keys: role ("user"|"bot"|"operator"|"system"), content, created_at (optional ISO str).
        reply_to: Optional Reply-To address for branded emails.
    """
    role_labels = {
        "user": "You",
        "bot": _esc(bot_name),
        "operator": "Support Agent",
        "system": "System",
    }

    message_blocks: list[str] = []
    for msg in messages:
        role = msg.get("role", "bot")
        text = _esc(msg.get("content") or msg.get("text", ""))
        label = role_labels.get(role, _esc(bot_name))
        timestamp = msg.get("created_at", "")

        is_user = role == "user"
        bg_color = "#dbeafe" if is_user else "#f3f4f6"
        align = "right" if is_user else "left"
        label_color = "#1d4ed8" if is_user else "#4b5563"

        time_html = ""
        if timestamp:
            # Show just the time portion if it's a full ISO timestamp
            display_time = timestamp
            if "T" in str(timestamp):
                display_time = str(timestamp).split("T")[1][:5]
            time_html = f'<span style="font-size: 11px; color: #9ca3af; margin-left: 8px;">{_esc(display_time)}</span>'

        block = f"""
        <div style="text-align: {align}; margin-bottom: 12px;">
            <span style="font-size: 12px; font-weight: 600; color: {label_color};">{label}</span>
            {time_html}
            <div style="display: inline-block; max-width: 85%; background: {bg_color};
                        border-radius: 12px; padding: 10px 14px; margin-top: 4px;
                        text-align: left; line-height: 1.5; color: #1f2937;
                        white-space: pre-wrap; word-break: break-word;">
                {text}
            </div>
        </div>
        """
        message_blocks.append(block)

    messages_html = "".join(message_blocks)

    content = f"""
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        Here is a transcript of your conversation with <strong>{_esc(bot_name)}</strong>.
    </p>
    <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px;
                padding: 16px; margin-bottom: 16px; max-height: 600px; overflow-y: auto;">
        {messages_html}
    </div>
    <p style="text-align: center; font-size: 12px; color: #9ca3af; margin: 0;">
        This transcript was sent from {_esc(bot_name)} via OyeChats
    </p>
    """
    sender = _branded_sender_name(bot_name)
    send_email_async(
        to_email,
        f"Chat Transcript — {bot_name}",
        _base_template("Chat Transcript 💬", content),
        reply_to=reply_to,
        sender_name=sender,
    )


def send_visitor_confirmation_email(
    to_email: str,
    bot_name: str,
    visitor_name: str,
    *,
    reply_to: str | None = None,
):
    """Send a confirmation email to the visitor after they submit an offline message.

    Args:
        to_email: Visitor's email address.
        bot_name: Display name of the bot / brand.
        visitor_name: Visitor's name for personalization.
        reply_to: Optional Reply-To address (brand email) so visitor can reply directly.
    """
    content = f"""
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        Hi <strong>{_esc(visitor_name)}</strong>,
    </p>
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        Thank you for reaching out to <strong>{_esc(bot_name)}</strong>. We've received
        your message and our team will get back to you as soon as possible.
    </p>
    <div style="background: #f0fdf4; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
        <p style="color: #166534; margin: 0; font-size: 14px;">
            You don't need to do anything else — we'll reply to this email address
            (<strong>{_esc(to_email)}</strong>) when we have an update for you.
        </p>
    </div>
    <p style="color: #9ca3af; font-size: 13px; margin: 0;">
        If you have additional questions in the meantime, feel free to reply to this email.
    </p>
    """
    sender = _branded_sender_name(bot_name)
    send_email_async(
        to_email,
        f"We received your message — {bot_name}",
        _base_template("Message Received ✓", content),
        reply_to=reply_to,
        sender_name=sender,
    )
