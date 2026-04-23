"""Email notification service using Brevo (formerly Sendinblue) transactional API."""

import asyncio
import contextlib
import html
import json
import logging
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import BREVO_API_KEY, EMAIL_ENABLED, EMAIL_FROM_ADDRESS, EMAIL_FROM_NAME

logger = logging.getLogger(__name__)

BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"
BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account"


def _capture_email_failure(exc: Exception, **tags) -> None:
    """Capture an email-send failure to Sentry (if configured) with tags.

    Fire-and-forget daemon threads otherwise lose these exceptions entirely
    — logger.error is not enough because no one reads app logs proactively.
    Sentry is where ops actually sees failures.
    """
    with contextlib.suppress(Exception):
        import sentry_sdk

        with sentry_sdk.push_scope() as scope:
            for key, value in tags.items():
                scope.set_tag(f"email.{key}", str(value))
            sentry_sdk.capture_exception(exc)


def _extract_brevo_error(exc: Exception) -> str:
    """Extract the human-readable reason from a Brevo API failure.

    Brevo returns a JSON body like {"code": "invalid_parameter", "message": "..."}
    on errors. The old code caught the exception and logged str(exc) which only
    shows the HTTP status — the actual reason lived unread in the response body.
    """
    if isinstance(exc, HTTPError):
        try:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body)
                code = parsed.get("code", "unknown")
                message = parsed.get("message", body[:200])
                return f"HTTP {exc.code} brevo_code={code} message={message}"
            except json.JSONDecodeError:
                return f"HTTP {exc.code} body={body[:200]}"
        except Exception:
            return f"HTTP {exc.code} (body unreadable)"
    if isinstance(exc, URLError):
        return f"network error: {exc.reason}"
    return f"{type(exc).__name__}: {exc}"


# ── Brevo Template IDs (created 2026-04-09) ──────────────────────────────────
# Manage templates at: https://app.brevo.com/templates/listing
TEMPLATE_PASSWORD_RESET = 57
TEMPLATE_QUALIFIED_LEAD = 60
TEMPLATE_HANDOFF_REQUEST = 61
TEMPLATE_MISSED_CALLBACK = 62
TEMPLATE_OFFLINE_MESSAGE = 58
TEMPLATE_CHAT_TRANSCRIPT = 63
TEMPLATE_VISITOR_CONFIRMATION = 59


def _send_brevo_email(
    to_email: str,
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
) -> bool:
    """Send an email via Brevo transactional API using raw HTML. Returns True on success.

    Args:
        to_email: Recipient email address.
        subject: Email subject line.
        html_body: Full HTML content (used for complex dynamic emails).
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
        reason = _extract_brevo_error(e)
        logger.warning("Brevo email failed | to=%s subject=%s reason=%s", to_email, subject, reason)
        _capture_email_failure(e, kind="raw", to=to_email, subject=subject, reason=reason)
        return False


def _send_brevo_template(
    to_email: str,
    template_id: int,
    params: dict,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
) -> bool:
    """Send an email via a Brevo saved template with dynamic params. Returns True on success.

    Args:
        to_email: Recipient email address.
        template_id: Brevo template ID (see TEMPLATE_* constants above).
        params: Dict of template variable values (mapped to {{params.*}} in the template).
        reply_to: Optional Reply-To address.
        sender_name: Optional override for the sender display name.
    """
    if not EMAIL_ENABLED:
        # Promoted from DEBUG to WARN — silent skips were invisible in prod,
        # making "email never arrived" an unexplained mystery. A single WARN
        # per send is acceptable noise; if it's too much, the fix is to set
        # BREVO_API_KEY, not silence the log.
        logger.warning(
            "Email skipped — EMAIL_ENABLED=False (no BREVO_API_KEY) | to=%s template_id=%s",
            to_email,
            template_id,
        )
        return False

    # When using templateId, Brevo uses the template's own verified sender.
    # We omit the sender override to avoid failures from unverified addresses.
    # reply_to is still forwarded so visitors can reply to the brand email.
    email_payload: dict = {
        "to": [{"email": to_email}],
        "templateId": template_id,
        "params": params,
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
            logger.info(f"Template email sent to {to_email} | template_id={template_id} | status={resp.status}")
            return True
    except Exception as e:
        reason = _extract_brevo_error(e)
        logger.warning(
            "Brevo template email failed | to=%s template_id=%s reason=%s",
            to_email,
            template_id,
            reason,
        )
        _capture_email_failure(e, kind="template", to=to_email, template_id=template_id, reason=reason)
        return False


def send_email_async(
    to_email: str,
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
):
    """Fire-and-forget raw HTML email. Non-blocking.

    When WORKER_ENABLED=true, enqueues to ARQ (durable, retryable).
    Otherwise uses thread pool / threading fallback (fire-and-forget).
    """
    from app.worker.enqueue import WORKER_ENABLED

    if WORKER_ENABLED:
        from app.worker.enqueue import enqueue_sync

        enqueue_sync("task_send_email", to_email, subject, html_body, reply_to, sender_name)
        return

    def _send():
        _send_brevo_email(to_email, subject, html_body, reply_to=reply_to, sender_name=sender_name)

    try:
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _send)
    except RuntimeError:
        import threading

        threading.Thread(target=_send, daemon=True).start()


def send_template_async(
    to_email: str,
    template_id: int,
    params: dict,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
):
    """Fire-and-forget Brevo template email. Non-blocking.

    When WORKER_ENABLED=true, enqueues to ARQ (durable, retryable).
    Otherwise uses thread pool / threading fallback (fire-and-forget).
    """
    from app.worker.enqueue import WORKER_ENABLED

    if WORKER_ENABLED:
        from app.worker.enqueue import enqueue_sync

        enqueue_sync("task_send_template_email", to_email, template_id, params, reply_to, sender_name)
        return

    def _send():
        _send_brevo_template(to_email, template_id, params, reply_to=reply_to, sender_name=sender_name)

    try:
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _send)
    except RuntimeError:
        import threading

        threading.Thread(target=_send, daemon=True).start()


def send_template_to_multiple(
    recipients: list[str],
    template_id: int,
    params: dict,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
):
    """Send a Brevo template email to multiple recipients. Non-blocking."""
    for email_addr in recipients:
        send_template_async(email_addr, template_id, params, reply_to=reply_to, sender_name=sender_name)


def send_email_to_multiple(
    recipients: list[str],
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
):
    """Send the same raw HTML email to multiple recipients (one API call per recipient). Non-blocking."""
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


# ── Template Helpers ──


def _esc(value: str | None) -> str:
    """HTML-escape a user-supplied value for safe inclusion in email templates."""
    return html.escape(str(value)) if value else "&#8212;"


def _md_to_html(text: str) -> str:
    """Convert basic markdown formatting to HTML (applied after HTML-escaping).

    Handles: **bold**, *italic*, _italic_, inline `code`.
    Safe to call on already-escaped strings — only processes markdown markers.
    """
    # Bold: **text** → <strong>text</strong>
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text, flags=re.DOTALL)
    # Italic: *text* (but not ** which was already consumed above)
    text = re.sub(r"\*([^*\n]+?)\*", r"<em>\1</em>", text)
    # Italic: _text_ (word-boundary aware to avoid breaking snake_case)
    text = re.sub(r"(?<!\w)_([^_\n]+?)_(?!\w)", r"<em>\1</em>", text)
    # Inline code: `text` → <code> styled span
    text = re.sub(
        r"`([^`]+)`",
        r'<span style="font-family:\'Courier New\',Courier,monospace;'
        r'background-color:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:13px;">\1</span>',
        text,
    )
    return text


def _html_doc(preheader: str, body_inner: str, *, visitor: bool = False) -> str:
    """Wrap email body in a full HTML document with header, footer, and email meta tags.

    Args:
        preheader: Hidden preview text shown in email client inbox listings.
        body_inner: The main card HTML to render inside the email body.
        visitor: When True, renders a visitor-safe footer (no "View Dashboard" link).
                 Set to True for emails sent to website visitors (transcript, confirmation).
    """
    preheader_html = (
        f'<span style="display:none;font-size:1px;color:#eeeef4;max-height:0;'
        f'overflow:hidden;mso-hide:all;">{html.escape(preheader)}&zwnj;</span>'
        if preheader
        else ""
    )

    if visitor:
        footer_links = (
            "<p style=\"margin:0 0 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
            'Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#9ca3af;">'
            "Powered by OyeChats &middot; AI Customer Support</p>"
        )
    else:
        footer_links = (
            "<p style=\"margin:0 0 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
            'Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#9ca3af;">'
            "Sent by OyeChats &nbsp;&middot;&nbsp; "
            '<a href="https://app.oyechats.com" style="color:#9ca3af;text-decoration:underline;">View Dashboard</a>'
            "</p>"
        )

    return f"""<!DOCTYPE html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="UTF-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<title>OyeChats</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml>
<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#eeeef4;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
{preheader_html}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#eeeef4;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background-color:#ffffff;border-radius:20px 20px 0 0;padding:28px 40px;text-align:center;border-bottom:1px solid #e8e8f0;">
            <a href="https://oyechats.com" style="text-decoration:none;display:inline-block;">
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:26px;font-weight:800;color:#0f0f1a;letter-spacing:-0.5px;">Oye<span style="color:#6366f1;">Chats</span></span>
            </a>
            <p style="margin:6px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#9ca3af;">AI-Powered Customer Conversations</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background-color:#ffffff;padding:0 0 40px 0;">
            {body_inner}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background-color:#f8f8fc;border-radius:0 0 20px 20px;padding:28px 40px;text-align:center;border-top:1px solid #e8e8f0;">
            <a href="https://oyechats.com" style="text-decoration:none;display:inline-block;margin-bottom:10px;">
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;color:#6366f1;letter-spacing:-0.3px;">Oye<span style="color:#4f46e5;">Chats</span></span>
            </a>
            {footer_links}
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9ca3af;">
              &copy; 2026 OyeChats. All rights reserved.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>"""


def _base_template(
    title: str,
    content: str,
    *,
    preheader: str = "",
    accent_color: str = "#6366f1",
    accent_bg: str = "#eef2ff",
    accent_border: str = "#a5b4fc",
    accent_icon: str = "",
    category: str = "",
    overline: str = "",
    visitor: bool = False,
) -> str:
    """Build a premium email card with accent bar, icon badge, title, and content.

    Args:
        title: Card heading text (no emoji — use accent_icon for the badge).
        content: Inner HTML content block.
        preheader: Hidden inbox preview text.
        accent_color: Top accent bar and interactive element color.
        accent_bg: Icon badge background color.
        accent_border: Icon badge border color.
        accent_icon: Emoji for the icon badge (skipped if empty).
        category: Small uppercase label shown below the icon badge.
        overline: Small uppercase label shown above the h1 heading.
        visitor: When True, renders a visitor-safe footer (no "View Dashboard" link).
    """
    # Accent stripe + halo (halo hidden from Outlook via MSO conditional)
    accent_bar_html = (
        f"\n    <!-- Accent stripe -->"
        f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f'\n      <tr><td style="height:6px;background-color:{accent_color};font-size:0;line-height:0;">&nbsp;</td></tr>'
        f"\n    </table>"
        f"\n    <!--[if !mso]><!-->"
        f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f'\n      <tr><td style="height:24px;background-color:#ffffff;'
        f"background-image:linear-gradient(to bottom,rgba({_hex_to_rgba(accent_color)},0.10),"
        f'rgba({_hex_to_rgba(accent_color)},0));font-size:0;line-height:0;">&nbsp;</td></tr>'
        f"\n    </table>"
        f"\n    <!--<![endif]-->"
    )

    # Icon badge (72px table cell — renders as square in Outlook, circle elsewhere)
    icon_html = ""
    if accent_icon:
        category_label = (
            f'\n            <tr><td align="center" style="padding:10px 0 0 0;">'
            f"<span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
            f'font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:{accent_color};">'
            f"{category}</span></td></tr>"
            if category
            else ""
        )
        icon_html = (
            f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
            f'\n      <tr><td align="center" style="padding:4px 40px 0 40px;">'
            f'\n        <table role="presentation" cellpadding="0" cellspacing="0" border="0">'
            f'\n          <tr><td width="72" height="72" align="center" valign="middle"'
            f' style="width:72px;height:72px;border-radius:50%;background-color:{accent_bg};'
            f"border:2px solid {accent_border};font-size:30px;text-align:center;vertical-align:middle;"
            f"font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;\">"
            f"{accent_icon}</td></tr>"
            f"{category_label}"
            f"\n        </table>"
            f"\n      </td></tr>"
            f"\n    </table>"
        )

    # Overline label above h1
    overline_html = (
        f'\n      <tr><td style="padding:20px 40px 0 40px;">'
        f"<p style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
        f'font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:{accent_color};">'
        f"{overline}</p></td></tr>"
        if overline
        else ""
    )

    heading_top = "20px" if (accent_icon or overline) else "32px"
    heading_padding = "8px 40px 0 40px" if overline else f"{heading_top} 40px 0 40px"

    card_html = (
        f"{accent_bar_html}"
        f"\n    <!-- Card content -->"
        f"{icon_html}"
        f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f"{overline_html}"
        f'\n      <tr><td style="padding:{heading_padding};">'
        f"<h1 style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
        f'font-size:26px;font-weight:800;color:#0f0f1a;line-height:1.25;letter-spacing:-0.3px;">{title}</h1>'
        f"</td></tr>"
        f"\n    </table>"
        f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f'\n      <tr><td style="padding:16px 40px 0 40px;">'
        f"\n        {content}"
        f"\n      </td></tr>"
        f"\n    </table>"
    )

    return _html_doc(preheader, card_html, visitor=visitor)


def _hex_to_rgba(hex_color: str) -> str:
    """Convert a 6-digit hex color to an 'R,G,B' string for use in rgba() CSS values."""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"{r},{g},{b}"


def _info_row(label: str, value: str) -> str:
    """Single key-value row for use inside _info_table."""
    return (
        f"<tr>"
        f"<td style=\"padding:9px 16px 9px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
        f"font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;"
        f'white-space:nowrap;vertical-align:top;width:110px;">{label}</td>'
        f"<td style=\"padding:9px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
        f'font-size:14px;font-weight:500;color:#0f0f1a;vertical-align:top;line-height:1.5;">{value}</td>'
        f"</tr>"
    )


def _info_table(rows: list[str], *, bg: str, border_color: str) -> str:
    """Grouped info card with colored background and border.

    Args:
        rows: List of HTML <tr> strings (from _info_row).
        bg: Background color hex.
        border_color: Border color hex.
    """
    rows_html = "".join(rows)
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="background-color:{bg};border:1px solid {border_color};border-radius:16px;'
        f'margin-bottom:20px;">'
        f'<tr><td style="padding:8px 20px 4px 20px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f"{rows_html}"
        f"</table>"
        f"</td></tr>"
        f"</table>"
    )


def _cta_button(text: str, url: str, *, color: str = "#6366f1") -> str:
    """Outlook-compatible full-width pill CTA button.

    Args:
        text: Button label (an arrow suffix → is appended automatically).
        url: Destination URL.
        color: Button background color.
    """
    label = f"{text} &#8594;"
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;">'
        f"<tr>"
        f'<td align="center" style="border-radius:100px;background-color:{color};">'
        f'<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" '
        f'href="{url}" style="height:56px;v-text-anchor:middle;width:460px;" arcsize="50%" '
        f'stroke="f" fillcolor="{color}"><w:anchorlock/><center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:700;">'
        f"{label}</center></v:roundrect><![endif]-->"
        f"<!--[if !mso]><!-->"
        f'<a href="{url}" style="display:block;background-color:{color};color:#ffffff;'
        f"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
        f"font-size:16px;font-weight:800;text-decoration:none;text-align:center;"
        f'padding:17px 32px;border-radius:100px;letter-spacing:0.02em;line-height:1;">{label}</a>'
        f"<!--<![endif]-->"
        f"</td>"
        f"</tr>"
        f"</table>"
    )


def _alert_box(text: str, *, bg: str, border_color: str, text_color: str) -> str:
    """Inline alert/notice box with left accent border."""
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="margin-bottom:20px;">'
        f"<tr>"
        f'<td style="background-color:{bg};border:1px solid {border_color};'
        f'border-left:4px solid {border_color};border-radius:0 12px 12px 0;padding:16px 18px;">'
        f"<p style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
        f'font-size:14px;color:{text_color};line-height:1.6;">{text}</p>'
        f"</td>"
        f"</tr>"
        f"</table>"
    )


def _body_text(text: str, *, color: str = "#4b5563") -> str:
    """Standard body paragraph."""
    return (
        f"<p style=\"margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
        f'Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:{color};line-height:1.7;">{text}</p>'
    )


def _section_label(text: str) -> str:
    """Small uppercase section label above an info block."""
    return (
        f"<p style=\"margin:0 0 8px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
        f"Roboto,Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;"
        f'letter-spacing:0.12em;color:#6b7280;">{text}</p>'
    )


# ── Email Templates ──


def send_qualified_lead_email(
    notification_email: str,
    bot_name: str,
    bant: dict,
    contact: dict | None = None,
    tier: str = "sql",
    *,
    reply_to: str | None = None,
):
    """Send email when a lead reaches a BANT qualification tier (Brevo template #60).

    Args:
        notification_email: Recipient address.
        bot_name: Name of the bot that captured the lead.
        bant: Dict with BANT fields (bant_need, bant_budget, bant_authority, bant_timeline).
        contact: Optional visitor contact info (name, email, phone, company).
        tier: Qualification tier — "mql" or "sql" (default "sql").
        reply_to: Optional Reply-To address for branded emails.
    """
    tier_upper = tier.upper()
    tier_labels: dict[str, str] = {
        "MQL": "Marketing Qualified Lead",
        "SQL": "Sales Qualified Lead",
    }
    tier_label = tier_labels.get(tier_upper, f"{tier_upper} Lead")
    badge_bg = "#dcfce7" if tier_upper == "SQL" else "#fef9c3"
    badge_color = "#166534" if tier_upper == "SQL" else "#854d0e"

    params: dict = {
        "bot_name": _esc(bot_name),
        "tier": tier_upper,
        "tier_label": tier_label,
        "badge_bg": badge_bg,
        "badge_color": badge_color,
        # BANT — use em-dash for missing fields so template rows always render
        "bant_need": _esc(bant.get("bant_need")) if bant.get("bant_need") else "&#8212;",
        "bant_budget": _esc(bant.get("bant_budget")) if bant.get("bant_budget") else "&#8212;",
        "bant_authority": _esc(bant.get("bant_authority")) if bant.get("bant_authority") else "&#8212;",
        "bant_timeline": _esc(bant.get("bant_timeline")) if bant.get("bant_timeline") else "&#8212;",
        # Contact — empty string if not provided
        "contact_name": _esc(contact.get("name")) if contact and contact.get("name") else "&#8212;",
        "contact_email": _esc(contact.get("email")) if contact and contact.get("email") else "&#8212;",
        "contact_phone": _esc(contact.get("phone")) if contact and contact.get("phone") else "&#8212;",
        "contact_company": _esc(contact.get("company")) if contact and contact.get("company") else "&#8212;",
    }

    sender = _branded_sender_name(bot_name)
    send_template_async(
        notification_email,
        TEMPLATE_QUALIFIED_LEAD,
        params,
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
    """Send email when a visitor requests live agent support (Brevo template #61)."""
    params: dict = {
        "bot_name": _esc(bot_name),
        "contact_name": _esc(contact.get("name")) if contact and contact.get("name") else "Unknown",
        "contact_email": _esc(contact.get("email")) if contact and contact.get("email") else "&#8212;",
        "reason": _esc(reason) if reason else "No reason provided",
    }

    sender = _branded_sender_name(bot_name)
    send_template_async(
        notification_email,
        TEMPLATE_HANDOFF_REQUEST,
        params,
        reply_to=reply_to,
        sender_name=sender,
    )


def send_unavailable_callback_email(
    notification_email: str, bot_name: str, contact: dict, *, reply_to: str | None = None
):
    """Send email when no agent was available and visitor left contact details (Brevo template #62)."""
    params: dict = {
        "bot_name": _esc(bot_name),
        "contact_name": _esc(contact.get("name")),
        "contact_email": _esc(contact.get("email")),
        "contact_phone": _esc(contact.get("phone")) if contact.get("phone") else "&#8212;",
    }

    sender = _branded_sender_name(bot_name)
    send_template_async(
        notification_email,
        TEMPLATE_MISSED_CALLBACK,
        params,
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
    """Send email when a visitor leaves an offline message (Brevo template #58)."""
    params: dict = {
        "bot_name": _esc(bot_name),
        "visitor_name": _esc(visitor_name),
        "visitor_email": _esc(visitor_email),
        "message_preview": _esc(message_preview),
    }

    sender = _branded_sender_name(bot_name)
    send_template_async(
        notification_email,
        TEMPLATE_OFFLINE_MESSAGE,
        params,
        reply_to=reply_to,
        sender_name=sender,
    )


def send_password_reset_email(to_email: str, otp: str):
    """Send a password reset OTP email (Brevo template #57)."""
    send_template_async(
        to_email,
        TEMPLATE_PASSWORD_RESET,
        {"otp": _esc(otp)},
    )


# ── Visitor-Facing Email Templates ──


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

    message_rows: list[str] = []
    for msg in messages:
        role = msg.get("role", "bot")
        text = _md_to_html(_esc(msg.get("content") or msg.get("text", "")))
        label = role_labels.get(role, _esc(bot_name))
        timestamp = msg.get("created_at", "")

        # Format timestamp to HH:MM
        time_str = ""
        if timestamp:
            ts = str(timestamp)
            time_str = ts.split("T")[1][:5] if "T" in ts else ts[:5]

        time_html = f'&nbsp;<span style="font-size:11px;color:#9ca3af;">{_esc(time_str)}</span>' if time_str else ""

        # System messages: centered italic with dashed dividers
        if role == "system":
            message_rows.append(
                f'<tr><td style="padding:4px 0 10px 0;">'
                f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
                f'<tr><td style="padding:0 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
                f'<tr><td style="border-top:1px dashed #cbd5e1;font-size:0;line-height:0;">&nbsp;</td></tr>'
                f"</table></td></tr>"
                f'<tr><td style="padding:6px 0;text-align:center;">'
                f"<span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
                f'font-size:12px;color:#94a3b8;font-style:italic;">{text}</span>'
                f"</td></tr>"
                f'<tr><td style="padding:0 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
                f'<tr><td style="border-top:1px dashed #cbd5e1;font-size:0;line-height:0;">&nbsp;</td></tr>'
                f"</table></td></tr>"
                f"</table></td></tr>"
            )
            continue

        is_user = role == "user"
        # Distinct tints per role
        bubble_bg = "#dbeafe" if is_user else ("#d1fae5" if role == "operator" else "#ede9fe")
        bubble_color = "#1e40af" if is_user else ("#065f46" if role == "operator" else "#4c1d95")
        label_color = "#1d4ed8" if is_user else ("#059669" if role == "operator" else "#6d28d9")
        # Table-based bubble (email-safe, no flexbox)
        if is_user:
            bubble_row = (
                f'<tr><td style="padding:0 0 12px 0;">'
                f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
                f"<tr>"
                f'<td style="text-align:right;">'
                f"<span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
                f'font-size:11px;font-weight:700;color:{label_color};">{label}</span>'
                f"&nbsp;<span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
                f'font-size:10px;color:#94a3b8;">{time_html}</span><br>'
                f'<span style="display:inline-block;background-color:{bubble_bg};border-radius:16px 16px 4px 16px;'
                f"padding:10px 14px;margin-top:4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
                f"Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:{bubble_color};line-height:1.6;"
                f'white-space:pre-wrap;word-break:break-word;max-width:80%;text-align:left;">{text}</span>'
                f"</td>"
                f"</tr>"
                f"</table>"
                f"</td></tr>"
            )
        else:
            bubble_row = (
                f'<tr><td style="padding:0 0 12px 0;">'
                f"<span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
                f'font-size:11px;font-weight:700;color:{label_color};">{label}</span>'
                f"&nbsp;<span style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
                f'font-size:10px;color:#94a3b8;">{time_html}</span><br>'
                f'<span style="display:inline-block;background-color:{bubble_bg};border-radius:16px 16px 16px 4px;'
                f"padding:10px 14px;margin-top:4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
                f"Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:{bubble_color};line-height:1.6;"
                f'white-space:pre-wrap;word-break:break-word;max-width:80%;">{text}</span>'
                f"</td></tr>"
            )

        message_rows.append(bubble_row)

    messages_html = "".join(message_rows)

    transcript_box = (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="background-color:#f8f9fc;border:1px solid #e8eaf0;border-radius:16px;margin-bottom:20px;">'
        f'<tr><td style="padding:24px 20px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f"{messages_html}"
        f"</table>"
        f"</td></tr></table>"
    )

    footer_note = (
        f"<p style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
        f'Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#94a3b8;text-align:center;">'
        f'This transcript was sent from <strong style="color:#6b7280;">{_esc(bot_name)}</strong> via OyeChats</p>'
    )

    content = (
        _body_text(
            f"Here is a full transcript of your conversation with "
            f'<strong style="color:#0f0f1a;">{_esc(bot_name)}</strong>.'
        )
        + transcript_box
        + footer_note
    )

    sender = _branded_sender_name(bot_name)
    # Transcript uses raw HTML (Brevo template #63 is visual reference only —
    # message bubbles are too dynamic for simple text params).
    send_email_async(
        to_email,
        f"Chat Transcript — {bot_name}",
        _base_template(
            "Your Chat Transcript",
            content,
            preheader=f"Your conversation with {bot_name} — full transcript",
            accent_color="#8b5cf6",
            accent_bg="#f5f3ff",
            accent_border="#c4b5fd",
            accent_icon="\U0001f4ac",
            category="Conversation Summary",
            overline="Full Transcript",
            visitor=True,
        ),
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
    """Send a confirmation email to the visitor after they submit an offline message (Brevo template #59).

    Args:
        to_email: Visitor's email address.
        bot_name: Display name of the bot / brand.
        visitor_name: Visitor's name for personalization.
        reply_to: Optional Reply-To address (brand email) so visitor can reply directly.
    """
    params: dict = {
        "bot_name": _esc(bot_name),
        "visitor_name": _esc(visitor_name),
        "visitor_email": _esc(to_email),
    }

    sender = _branded_sender_name(bot_name)
    send_template_async(
        to_email,
        TEMPLATE_VISITOR_CONFIRMATION,
        params,
        reply_to=reply_to,
        sender_name=sender,
    )
