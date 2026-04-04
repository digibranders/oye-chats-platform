"""Email notification service using Brevo (formerly Sendinblue) transactional API."""

import asyncio
import html
import json
import logging
from urllib.request import Request, urlopen

from app.config import BREVO_API_KEY, EMAIL_ENABLED, EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME

logger = logging.getLogger(__name__)

BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"


def _send_brevo_email(to_email: str, subject: str, html_body: str) -> bool:
    """Send an email via Brevo transactional API. Returns True on success."""
    if not EMAIL_ENABLED:
        logger.debug("Email not sent (Brevo not configured)")
        return False

    payload = json.dumps(
        {
            "sender": {"name": EMAIL_FROM_NAME, "email": EMAIL_FROM_ADDRESS},
            "to": [{"email": to_email}],
            "subject": subject,
            "htmlContent": html_body,
        }
    ).encode("utf-8")

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


def send_email_async(to_email: str, subject: str, html_body: str):
    """Fire-and-forget email sending. Non-blocking."""
    try:
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _send_brevo_email, to_email, subject, html_body)
    except RuntimeError:
        # No event loop — use thread
        import threading

        threading.Thread(
            target=_send_brevo_email,
            args=(to_email, subject, html_body),
            daemon=True,
        ).start()


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


def send_qualified_lead_email(notification_email: str, bot_name: str, bant: dict, contact: dict | None = None):
    """Send email when a lead is fully BANT qualified."""
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

    content = f"""
    <p style="color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;">
        A visitor on <strong>{bot_name}</strong> has been fully qualified with all BANT fields captured.
    </p>
    <div style="background: #f0fdf4; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
        <h3 style="font-size: 14px; font-weight: 600; color: #166534; margin: 0 0 12px 0;">BANT Summary</h3>
        <ul style="margin: 0; padding-left: 20px; color: #15803d; line-height: 1.8;">
            <li><strong>Need:</strong> {_esc(bant.get("bant_need"))}</li>
            <li><strong>Budget:</strong> {_esc(bant.get("bant_budget"))}</li>
            <li><strong>Authority:</strong> {_esc(bant.get("bant_authority"))}</li>
            <li><strong>Timeline:</strong> {_esc(bant.get("bant_timeline"))}</li>
        </ul>
    </div>
    {contact_section}
    <a href="https://admin.oyechats.com/leads"
        style="display: inline-block; background: #6366f1; color: #ffffff;
               padding: 10px 24px; border-radius: 8px; text-decoration: none;
               font-weight: 600; font-size: 14px; margin-top: 8px;">
        View in Dashboard
    </a>
    """
    send_email_async(
        notification_email,
        f"[OyeChats] New Qualified Lead — {bot_name}",
        _base_template("New Qualified Lead 🎯", content),
    )


def send_handoff_request_email(notification_email: str, bot_name: str, reason: str | None, contact: dict | None = None):
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
    send_email_async(
        notification_email,
        f"[OyeChats] Live Chat Request — {bot_name}",
        _base_template("Live Chat Request 💬", content),
    )


def send_unavailable_callback_email(notification_email: str, bot_name: str, contact: dict):
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
    send_email_async(
        notification_email,
        f"[OyeChats] Missed Chat — Callback Requested — {bot_name}",
        _base_template("Missed Chat — Callback Requested 📞", content),
    )


def send_offline_message_email(
    notification_email: str,
    bot_name: str,
    visitor_name: str,
    visitor_email: str,
    message_preview: str,
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
    send_email_async(
        notification_email,
        f"[OyeChats] New Offline Message — {bot_name}",
        _base_template("New Offline Message 📩", content),
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
