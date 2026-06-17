"""Email notification service using Brevo (formerly Sendinblue) transactional API."""

import asyncio
import contextlib
import html
import json
import logging
import re
from datetime import UTC, datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import (
    APP_URL,
    BRAND_NAME,
    BRAND_TAGLINE_FOOTER,
    BREVO_API_KEY,
    EMAIL_ENABLED,
    EMAIL_FROM_ADDRESS,
    EMAIL_FROM_NAME,
    MARKETING_URL,
    SUPPORT_EMAIL,
)

logger = logging.getLogger(__name__)

BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"
BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account"


# ── Credit metering ──
#
# Customer-facing emails (lead alerts, BANT notifications, offline-message
# digests) deduct 1 credit per send. System emails (auth OTPs, operator pings,
# password resets, visitor confirmations) are always free. Call-sites that
# trigger customer-facing emails should call ``meter_customer_email`` BEFORE
# invoking the relevant ``send_*_email`` function and bail out if it returns
# ``False`` — the customer is out of credits.
#
# We deliberately keep the metering at call-sites (not inside the send_*
# functions) because (a) those functions are fire-and-forget and don't have a
# DB session in scope, and (b) the call-site has the ``client_id`` already.


def meter_customer_email(session, client_id: int, *, reference_id: int | None = None) -> bool:
    """Charge 1 credit for a customer-facing email send.

    Returns ``True`` if the credit was deducted (caller may proceed to send),
    or ``False`` if the client is out of credits or the kill switch is on
    (caller should skip the send and log).
    """
    from app.services import credit_service

    cost = credit_service.get_credit_cost(session, "email_send")
    if cost <= 0:
        return True
    try:
        credit_service.check_and_deduct(
            session,
            client_id,
            cost,
            reason="email_send",
            reference_id=reference_id,
        )
        return True
    except credit_service.InsufficientCredits:
        logger.warning("Customer email skipped for client %s: out of credits", client_id)
        return False
    except credit_service.KillSwitchActive:
        logger.warning("Customer email skipped for client %s: kill switch active", client_id)
        return False


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
    """Build the '<BotName> via <Brand>' sender display name."""
    return f"{bot_name} via {BRAND_NAME}"


def _brand_wordmark(*, color: str = "#0f0f1a") -> str:
    """Render the configured brand name with a CamelCase color split.

    For 'OyeChats': renders 'Oye' in `color` and 'Chats' in brand primary.
    For brands without a CamelCase split (e.g. 'Acme'), the whole name
    renders in brand primary for consistent emphasis. Brand name is HTML-
    escaped so custom values can't break the markup.
    """
    name = BRAND_NAME
    match = re.search(r"(?<=[a-z])(?=[A-Z])", name)
    if match:
        first = html.escape(name[: match.start()])
        second = html.escape(name[match.start() :])
        return f'<span style="color:{color};">{first}<span style="color:{_BRAND_PRIMARY};">{second}</span></span>'
    return f'<span style="color:{_BRAND_PRIMARY};">{html.escape(name)}</span>'


def _copyright_year() -> int:
    """Current year in UTC. Computed per-render so long-running processes don't go stale."""
    return datetime.now(UTC).year


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


# ── Brand & Design Tokens ──
#
# Single source of truth for email styling. Update here once and every email
# helper picks up the new value on next send. Light-mode locked: dark-mode
# clients are explicitly opted out via color-scheme metadata + [data-ogsc]/
# [data-ogsb] overrides set in _html_doc().

_FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
_EMOJI_FONT_STACK = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif"

# Brand
_BRAND_PRIMARY = "#4f46e5"  # Indigo — logo accent, default CTA
_BRAND_PRIMARY_DARK = "#3730a3"  # Hover/contrast

# Ink (text) palette
_INK_900 = "#0f0f1a"  # Headings
_INK_700 = "#1f2937"  # Strong body
_INK_500 = "#4b5563"  # Body text
_INK_400 = "#6b7280"  # Labels
_INK_300 = "#9ca3af"  # Muted / footer

# Surfaces
_SURFACE_PAGE = "#f3f4fb"
_SURFACE_CARD = "#ffffff"
_SURFACE_FOOTER = "#f8f8fc"
_RULE = "#e8e8f0"


def _email_header() -> str:
    """Branded header row — centered wordmark only.

    Renders the top of every email as a single centered wordmark, no
    brand-mark tile and no tagline. Pure HTML/CSS so it works in
    image-blocked inboxes and offline. The marketing URL wraps the
    wordmark so the brand is still clickable.
    """
    return (
        f"<tr>"
        f'<td style="background-color:{_SURFACE_CARD};border-radius:20px 20px 0 0;'
        f'padding:30px 40px 26px 40px;text-align:center;">'
        f'<a href="{MARKETING_URL}" style="text-decoration:none;display:inline-block;line-height:1;">'
        f'<span style="font-family:{_FONT_STACK};font-size:24px;font-weight:800;'
        f'letter-spacing:-0.5px;line-height:1;">'
        f"{_brand_wordmark(color=_INK_900)}"
        f"</span>"
        f"</a>"
        f"</td>"
        f"</tr>"
    )


def _email_footer(*, visitor: bool) -> str:
    """Footer row inside the body card — brand row, link row, legal row.

    Two variants, selected by the ``visitor`` flag:

    - Operator footer (visitor=False): View Dashboard · Help Center · Contact
    - Visitor footer (visitor=True):   Visit <Brand> · Privacy

    All URLs and labels resolve from ``app.config`` (``MARKETING_URL``,
    ``APP_URL``, ``SUPPORT_EMAIL``, ``BRAND_NAME``). Copyright year is
    computed at render time so long-running processes never go stale.
    """
    brand_initial = html.escape(BRAND_NAME[:1].upper()) if BRAND_NAME else "O"
    safe_brand = html.escape(BRAND_NAME)

    if visitor:
        link_row = (
            f'<a href="{MARKETING_URL}"'
            f' style="color:{_INK_400};text-decoration:none;font-weight:600;">Visit {safe_brand}</a>'
            f'<span style="color:{_INK_300};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>'
            f'<a href="{MARKETING_URL}/privacy"'
            f' style="color:{_INK_400};text-decoration:none;font-weight:600;">Privacy</a>'
        )
    else:
        link_row = (
            f'<a href="{APP_URL}"'
            f' style="color:{_INK_400};text-decoration:none;font-weight:600;">View Dashboard</a>'
            f'<span style="color:{_INK_300};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>'
            f'<a href="{MARKETING_URL}/help"'
            f' style="color:{_INK_400};text-decoration:none;font-weight:600;">Help Center</a>'
            f'<span style="color:{_INK_300};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>'
            f'<a href="mailto:{SUPPORT_EMAIL}"'
            f' style="color:{_INK_400};text-decoration:none;font-weight:600;">Contact Support</a>'
        )

    return (
        # Footer row — sits inside the same card as the body, separated only by
        # a 1px hairline rule. Bottom corners pick up the card's border-radius.
        f"<tr>"
        f'<td class="oc-footer oc-pad-x" style="background-color:{_SURFACE_FOOTER};'
        f"border-top:1px solid {_RULE};border-radius:0 0 20px 20px;"
        f'padding:26px 40px;text-align:center;">'
        # Brand row — small logo lockup
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"'
        f' style="margin:0 auto 6px auto;">'
        f"<tr>"
        f'<td width="22" height="22" align="center" valign="middle"'
        f' style="width:22px;height:22px;background-color:{_BRAND_PRIMARY};'
        f'border-radius:6px;text-align:center;vertical-align:middle;">'
        f'<span style="font-family:{_FONT_STACK};font-size:11px;font-weight:800;'
        f'color:#ffffff;letter-spacing:-0.3px;line-height:22px;">{brand_initial}</span>'
        f"</td>"
        f'<td width="8" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>'
        f'<td valign="middle" style="vertical-align:middle;">'
        f'<a href="{MARKETING_URL}" style="text-decoration:none;display:block;line-height:1;">'
        f'<span style="font-family:{_FONT_STACK};font-size:14px;font-weight:800;'
        f'letter-spacing:-0.3px;line-height:1;">'
        f"{_brand_wordmark(color=_INK_900)}"
        f"</span>"
        f"</a>"
        f"</td>"
        f"</tr>"
        f"</table>"
        # Tagline
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:10px;'
        f"font-weight:700;letter-spacing:0.14em;text-transform:uppercase;"
        f'color:{_INK_300};">{html.escape(BRAND_TAGLINE_FOOTER)}</p>'
        # Hairline divider
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="60"'
        f' align="center" style="margin:0 auto 14px auto;">'
        f'<tr><td style="border-top:1px solid {_RULE};font-size:0;line-height:0;">&nbsp;</td></tr>'
        f"</table>"
        # Link row
        f'<p style="margin:0 0 10px 0;font-family:{_FONT_STACK};font-size:12px;'
        f'color:{_INK_400};line-height:1.5;">{link_row}</p>'
        # Legal row — year computed per render
        f'<p style="margin:0;font-family:{_FONT_STACK};font-size:11px;'
        f'color:{_INK_300};line-height:1.5;">'
        f"&copy; {_copyright_year()} {safe_brand}. All rights reserved."
        f"</p>"
        f"</td>"
        f"</tr>"
    )


def _html_doc(preheader: str, body_inner: str, *, visitor: bool = False) -> str:
    """Wrap email body in a full HTML document with header, footer, and email meta tags.

    Light-mode locked: every email opts out of dark-mode rendering via
    color-scheme metadata, [data-ogsc]/[data-ogsb] selectors (Outlook.com),
    and explicit background-color on every surface.

    Args:
        preheader: Hidden preview text shown in email client inbox listings.
        body_inner: The main card HTML to render inside the email body.
        visitor: When True, renders a visitor-safe footer (no "View Dashboard" link).
                 Set to True for emails sent to website visitors (transcript, confirmation).
    """
    preheader_html = (
        f'<span style="display:none;font-size:1px;color:{_SURFACE_PAGE};max-height:0;'
        f'overflow:hidden;mso-hide:all;">{html.escape(preheader)}&zwnj;</span>'
        if preheader
        else ""
    )

    return f"""<!DOCTYPE html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="UTF-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>{html.escape(BRAND_NAME)}</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml>
<![endif]-->
<style>
  :root {{ color-scheme: light only; supported-color-schemes: light; }}
  html, body {{ color-scheme: light only; }}
  /* Outlook.com / Office 365 dark-mode override — keep light surfaces light */
  [data-ogsc] body, [data-ogsb] body {{ background-color: {_SURFACE_PAGE} !important; }}
  [data-ogsc] .oc-card, [data-ogsb] .oc-card {{ background-color: {_SURFACE_CARD} !important; }}
  [data-ogsc] .oc-footer, [data-ogsb] .oc-footer {{ background-color: {_SURFACE_FOOTER} !important; }}
  [data-ogsc] .oc-ink-900 {{ color: {_INK_900} !important; }}
  [data-ogsc] .oc-ink-500 {{ color: {_INK_500} !important; }}
  [data-ogsc] .oc-ink-300 {{ color: {_INK_300} !important; }}
  /* Mobile tightening */
  @media only screen and (max-width: 600px) {{
    .oc-pad-x {{ padding-left: 24px !important; padding-right: 24px !important; }}
    .oc-h1 {{ font-size: 22px !important; }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background-color:{_SURFACE_PAGE};color-scheme:light only;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
{preheader_html}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:{_SURFACE_PAGE};">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">

        <!-- Unified card: header + content + footer in a single rounded card -->
        <tr>
          <td class="oc-card" style="background-color:{_SURFACE_CARD};border-radius:20px;border:1px solid {_RULE};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              {_email_header()}
              <tr>
                <td style="background-color:{_SURFACE_CARD};padding:0 0 36px 0;">
                  {body_inner}
                </td>
              </tr>
              {_email_footer(visitor=visitor)}
            </table>
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
    accent_color: str = _BRAND_PRIMARY,
    accent_bg: str = "#eef2ff",
    accent_border: str = "#a5b4fc",
    accent_icon: str = "",
    category: str = "",
    overline: str = "",
    visitor: bool = False,
) -> str:
    """Build a premium email card with accent bar, icon tile, title, and content.

    Args:
        title: Card heading text (no emoji — use accent_icon for the tile).
        content: Inner HTML content block.
        preheader: Hidden inbox preview text.
        accent_color: Top accent bar, overline label, and CTA color.
        accent_bg: Icon tile background color.
        accent_border: Icon tile inner-ring color.
        accent_icon: Emoji for the icon tile (skipped if empty).
        category: Small uppercase label shown below the icon tile.
        overline: Small uppercase label shown above the h1 heading.
        visitor: When True, renders a visitor-safe footer (no "View Dashboard" link).
    """
    # Accent stripe + soft halo (halo hidden from Outlook via MSO conditional)
    accent_bar_html = (
        f"\n    <!-- Accent stripe -->"
        f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f'\n      <tr><td style="height:5px;background-color:{accent_color};font-size:0;line-height:0;">&nbsp;</td></tr>'
        f"\n    </table>"
        f"\n    <!--[if !mso]><!-->"
        f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f'\n      <tr><td style="height:28px;background-color:{_SURFACE_CARD};'
        f"background-image:linear-gradient(to bottom,rgba({_hex_to_rgba(accent_color)},0.12),"
        f'rgba({_hex_to_rgba(accent_color)},0));font-size:0;line-height:0;">&nbsp;</td></tr>'
        f"\n    </table>"
        f"\n    <!--<![endif]-->"
    )

    # Icon tile (64×64 rounded-square — feels like an app icon).
    # Category label sits in its own full-width row so it never wraps.
    icon_html = ""
    if accent_icon:
        category_row = (
            f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
            f'\n      <tr><td align="center" style="padding:14px 40px 0 40px;text-align:center;">'
            f'<span style="font-family:{_FONT_STACK};font-size:10px;font-weight:700;'
            f"letter-spacing:0.16em;text-transform:uppercase;color:{accent_color};"
            f'white-space:nowrap;">{category}</span>'
            f"</td></tr>"
            f"\n    </table>"
            if category
            else ""
        )
        icon_html = (
            f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
            f'\n      <tr><td align="center" style="padding:0 40px;">'
            f'\n        <table role="presentation" cellpadding="0" cellspacing="0" border="0">'
            f'\n          <tr><td width="64" height="64" align="center" valign="middle"'
            f' style="width:64px;height:64px;border-radius:18px;background-color:{accent_bg};'
            f"border:1px solid {accent_border};font-size:30px;text-align:center;vertical-align:middle;"
            f'font-family:{_EMOJI_FONT_STACK};line-height:64px;">'
            f"{accent_icon}</td></tr>"
            f"\n        </table>"
            f"\n      </td></tr>"
            f"\n    </table>"
            f"{category_row}"
        )

    # Overline label above h1
    overline_html = (
        f'\n      <tr><td class="oc-pad-x" style="padding:22px 40px 0 40px;text-align:center;">'
        f'<p style="margin:0;font-family:{_FONT_STACK};font-size:11px;font-weight:700;'
        f'letter-spacing:0.16em;text-transform:uppercase;color:{accent_color};">'
        f"{overline}</p></td></tr>"
        if overline
        else ""
    )

    heading_top_pad = "8px" if overline else ("20px" if accent_icon else "36px")

    card_html = (
        f"{accent_bar_html}"
        f"\n    <!-- Card content -->"
        f"{icon_html}"
        f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f"{overline_html}"
        f'\n      <tr><td class="oc-pad-x" style="padding:{heading_top_pad} 40px 0 40px;text-align:center;">'
        f'<h1 class="oc-h1 oc-ink-900" style="margin:0;font-family:{_FONT_STACK};'
        f'font-size:26px;font-weight:800;color:{_INK_900};line-height:1.25;letter-spacing:-0.4px;">'
        f"{title}</h1>"
        f"</td></tr>"
        f"\n    </table>"
        f'\n    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f'\n      <tr><td class="oc-pad-x" style="padding:18px 40px 0 40px;">'
        f"\n        {content}"
        f"\n      </td></tr>"
        f"\n    </table>"
    )

    return _html_doc(preheader, card_html, visitor=visitor)


def _hex_to_rgba(hex_color: str) -> str:
    """Convert a 6-digit hex color to an 'R,G,B' string for use in rgba() CSS values.

    Returns "0,0,0" for any non-hex input (e.g. a Brevo `{{ params.accent_color }}`
    placeholder when this helper is called during static-template generation) so
    the halo gradient gracefully degrades to invisible without raising.
    """
    if not hex_color or not hex_color.startswith("#") or len(hex_color) != 7:
        return "0,0,0"
    h = hex_color.lstrip("#")
    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return "0,0,0"
    return f"{r},{g},{b}"


def _info_row(label: str, value: str) -> str:
    """Single key-value row for use inside _info_table."""
    return (
        f"<tr>"
        f'<td style="padding:10px 16px 10px 0;font-family:{_FONT_STACK};'
        f"font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:{_INK_400};"
        f'white-space:nowrap;vertical-align:top;width:110px;">{label}</td>'
        f'<td class="oc-ink-900" style="padding:10px 0;font-family:{_FONT_STACK};'
        f'font-size:14px;font-weight:500;color:{_INK_900};vertical-align:top;line-height:1.5;">{value}</td>'
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
        f'style="background-color:{bg};border:1px solid {border_color};border-radius:14px;'
        f'margin-bottom:18px;">'
        f'<tr><td style="padding:10px 20px 6px 20px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f"{rows_html}"
        f"</table>"
        f"</td></tr>"
        f"</table>"
    )


def _cta_button(text: str, url: str, *, color: str = _BRAND_PRIMARY) -> str:
    """Outlook-compatible full-width pill CTA button.

    Args:
        text: Button label (an arrow suffix → is appended automatically).
        url: Destination URL.
        color: Button background color.
    """
    label = f"{text} &#8594;"
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;">'
        f"<tr>"
        f'<td align="center" style="border-radius:100px;background-color:{color};">'
        f'<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" '
        f'href="{url}" style="height:54px;v-text-anchor:middle;width:460px;" arcsize="50%" '
        f'stroke="f" fillcolor="{color}"><w:anchorlock/><center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:700;">'
        f"{label}</center></v:roundrect><![endif]-->"
        f"<!--[if !mso]><!-->"
        f'<a href="{url}" style="display:block;background-color:{color};color:#ffffff;'
        f"font-family:{_FONT_STACK};"
        f"font-size:15px;font-weight:700;text-decoration:none;text-align:center;"
        f'padding:16px 32px;border-radius:100px;letter-spacing:0.02em;line-height:1;">{label}</a>'
        f"<!--<![endif]-->"
        f"</td>"
        f"</tr>"
        f"</table>"
    )


def _alert_box(text: str, *, bg: str, border_color: str, text_color: str) -> str:
    """Inline alert/notice box with left accent border."""
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="margin-bottom:18px;">'
        f"<tr>"
        f'<td style="background-color:{bg};border:1px solid {border_color};'
        f'border-left:4px solid {border_color};border-radius:0 12px 12px 0;padding:14px 18px;">'
        f'<p style="margin:0;font-family:{_FONT_STACK};'
        f'font-size:14px;color:{text_color};line-height:1.6;">{text}</p>'
        f"</td>"
        f"</tr>"
        f"</table>"
    )


def _body_text(text: str, *, color: str = _INK_500) -> str:
    """Standard body paragraph."""
    return (
        f'<p class="oc-ink-500" style="margin:0 0 16px 0;font-family:{_FONT_STACK};'
        f'font-size:15px;color:{color};line-height:1.7;">{text}</p>'
    )


def _section_label(text: str) -> str:
    """Small uppercase section label above an info block."""
    return (
        f'<p style="margin:0 0 8px 0;font-family:{_FONT_STACK};'
        f"font-size:10px;font-weight:700;text-transform:uppercase;"
        f'letter-spacing:0.14em;color:{_INK_400};">{text}</p>'
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
    # Per-tier accent so the Brevo template can stay tier-aware:
    # SQL — green (celebration), MQL — amber (early signal).
    if tier_upper == "SQL":
        badge_bg, badge_color = "#dcfce7", "#166534"
        accent_color, accent_bg, accent_border = "#10b981", "#ecfdf5", "#6ee7b7"
    else:
        badge_bg, badge_color = "#fef9c3", "#854d0e"
        accent_color, accent_bg, accent_border = "#f59e0b", "#fffbeb", "#fcd34d"

    params: dict = {
        "bot_name": _esc(bot_name),
        "tier": tier_upper,
        "tier_label": tier_label,
        "badge_bg": badge_bg,
        "badge_color": badge_color,
        # Tier-driven accent palette (referenced by the Brevo template)
        "accent_color": accent_color,
        "accent_bg": accent_bg,
        "accent_border": accent_border,
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


def send_verification_otp_email(to_email: str, name: str, otp: str) -> None:
    """Send a 6-digit email verification code via Brevo (raw HTML — no dedicated template yet)."""
    safe_name = _esc(name or "there")
    safe_otp = _esc(otp)

    html = f"""
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
  <div style="background:#2563eb;padding:28px 32px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:22px">Verify your email</h1>
  </div>
  <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <p style="margin:0 0 16px">Hi {safe_name},</p>
    <p style="margin:0 0 24px;color:#6b7280">
      Thanks for signing up for OyeChats. Use the code below to verify your email address.
      The code expires in <strong>15 minutes</strong>.
    </p>
    <div style="background:#f3f4f6;border-radius:8px;padding:20px 32px;text-align:center;margin-bottom:24px">
      <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#111827;font-family:monospace">{safe_otp}</span>
    </div>
    <p style="margin:0;font-size:13px;color:#9ca3af">
      If you didn&apos;t create an OyeChats account, you can safely ignore this email.
    </p>
  </div>
</div>
"""

    send_email_async(
        to_email=to_email,
        subject="Your OyeChats verification code",
        html_body=html,
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
        f'<p style="margin:0;font-family:{_FONT_STACK};'
        f'font-size:12px;color:#94a3b8;text-align:center;">'
        f'This transcript was sent from <strong style="color:#6b7280;">{_esc(bot_name)}</strong>'
        f" via {html.escape(BRAND_NAME)}</p>"
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


# ── Affiliate program emails ─────────────────────────────────────────────
# Two transactional templates, composed as raw HTML through the shared
# ``_html_doc`` wrapper rather than via Brevo template IDs. Reason: the
# affiliate program is internal, low-volume, and self-contained — going
# through Brevo's template editor adds friction without buying anything.
#
# Both emails follow the same skeleton: short headline, two short
# paragraphs, single primary CTA button. No metering — these are
# operational emails, not customer-billed sends.


def _affiliate_cta_button(href: str, label: str) -> str:
    """Pill-shaped CTA button matching the brand palette."""
    safe_href = html.escape(href, quote=True)
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="left">'
        f"<tr>"
        f'<td align="center" style="border-radius:10px;background-color:{_BRAND_PRIMARY};">'
        f'<a href="{safe_href}"'
        f' style="display:inline-block;padding:12px 22px;font-family:{_FONT_STACK};'
        f"font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;"
        f'border-radius:10px;letter-spacing:0.01em;">'
        f"{html.escape(label)}"
        f"</a>"
        f"</td>"
        f"</tr>"
        f"</table>"
    )


def send_affiliate_welcome_email(to_email: str, name: str | None = None) -> None:
    """Email an existing OyeChats customer that they're now an affiliate.

    Triggered from the super-admin invite endpoint when the target email
    already has a ``clients`` row — they don't need a magic link, they just
    need to know to log in and check ``/affiliate``. Fire-and-forget.
    """
    safe_name = _esc((name or "").split()[0]) if name else "there"
    dashboard_url = f"{APP_URL.rstrip('/')}/affiliate"

    body_inner = (
        f'<tr><td class="oc-pad-x" style="padding:32px 40px 0 40px;">'
        f'<h1 class="oc-h1" style="margin:0 0 18px 0;font-family:{_FONT_STACK};'
        f'font-size:24px;font-weight:700;color:{_INK_900};line-height:1.25;">'
        f"You&rsquo;re now an OyeChats affiliate"
        f"</h1>"
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Hi {safe_name} — you&rsquo;ve just been enrolled in the OyeChats "
        f"affiliate program. You can now create referral codes, share them "
        f"anywhere, and track how each one performs from your dashboard."
        f"</p>"
        f'<p style="margin:0 0 22px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Open the affiliate dashboard to create your first code:"
        f"</p>"
        f"{_affiliate_cta_button(dashboard_url, 'Open my affiliate dashboard')}"
        f'<p style="margin:24px 0 0 0;font-family:{_FONT_STACK};font-size:13px;'
        f'color:{_INK_300};line-height:1.55;">'
        f"Need help? Reply to this email or write to "
        f'<a href="mailto:{html.escape(SUPPORT_EMAIL)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;">{html.escape(SUPPORT_EMAIL)}</a>.'
        f"</p>"
        f"</td></tr>"
    )

    html_body = _html_doc(
        preheader="You can now create referral codes and earn from every signup.",
        body_inner=body_inner,
        visitor=False,
    )
    send_email_async(
        to_email,
        f"You’re now an {BRAND_NAME} affiliate",
        html_body,
    )


def send_affiliate_invite_email(
    to_email: str,
    accept_url: str,
    *,
    expires_in_days: int = 14,
) -> None:
    """Email a magic link to a non-customer who's been invited as an affiliate.

    ``accept_url`` already carries the raw token (e.g.
    ``https://app.oyechats.com/affiliate-invite?token=...``). We do not
    persist the raw token here; it's emailed once and lives only in this
    email body. If the recipient loses the email, super admin revokes the
    invite and sends a new one.
    """
    safe_url = html.escape(accept_url, quote=True)
    expiry_phrase = f"{expires_in_days} day" if expires_in_days == 1 else f"{expires_in_days} days"

    body_inner = (
        f'<tr><td class="oc-pad-x" style="padding:32px 40px 0 40px;">'
        f'<h1 class="oc-h1" style="margin:0 0 18px 0;font-family:{_FONT_STACK};'
        f'font-size:24px;font-weight:700;color:{_INK_900};line-height:1.25;">'
        f"You&rsquo;ve been invited to {html.escape(BRAND_NAME)} Partners"
        f"</h1>"
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"OyeChats Partners is a hand-picked group earning recurring commission "
        f"on every customer they bring to the platform. We&rsquo;d like you to "
        f"join."
        f"</p>"
        f'<p style="margin:0 0 22px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Click below to accept. If you already have an OyeChats account, "
        f"you&rsquo;ll sign in and the Affiliate menu will appear in your "
        f"sidebar. New here? You can create an account in the same flow. "
        f"This link expires in "
        f'<strong style="color:{_INK_900};">{html.escape(expiry_phrase)}</strong>.'
        f"</p>"
        f"{_affiliate_cta_button(accept_url, 'Accept your Partners invite')}"
        f'<p style="margin:24px 0 8px 0;font-family:{_FONT_STACK};font-size:12px;'
        f'color:{_INK_300};line-height:1.55;word-break:break-all;">'
        f"If the button doesn&rsquo;t work, paste this link into your browser:"
        f"</p>"
        f'<p style="margin:0 0 16px 0;font-family:{_FONT_STACK};font-size:12px;'
        f'color:{_INK_500};line-height:1.5;word-break:break-all;">'
        f'<a href="{safe_url}" style="color:{_BRAND_PRIMARY};text-decoration:none;">{safe_url}</a>'
        f"</p>"
        f'<p style="margin:16px 0 0 0;font-family:{_FONT_STACK};font-size:12px;'
        f'color:{_INK_300};line-height:1.55;">'
        f"Didn&rsquo;t expect this email? You can safely ignore it — the invite "
        f"will expire and no account will be created."
        f"</p>"
        f"</td></tr>"
    )

    html_body = _html_doc(
        preheader=f"Accept your Partners invite. Link expires in {expiry_phrase}.",
        body_inner=body_inner,
        visitor=False,
    )
    send_email_async(
        to_email,
        f"You’re invited to {BRAND_NAME} Partners",
        html_body,
    )


def send_trial_welcome_email(
    to_email: str,
    *,
    name: str | None,
    trial_end: datetime,
    credits: int,
    duration_days: int,
) -> None:
    """Welcome email fired the moment a customer registers and lands on the
    14-day trial.

    Day-0 in the email cadence (see PR4 for the day-7 / day-11 / day-13 /
    day-14 follow-ups). Best-effort send — the registration endpoint never
    blocks on this and swallows transport failures so a Brevo outage can't
    take signup down with it.

    Content priorities, in order:

    1. Confirm the trial is active and state the exact end date (no
       ambiguous "in 14 days" phrasing — the timestamp is authoritative).
    2. Quote the credit allowance so the prospect knows the cap.
    3. One primary CTA to the dashboard. Quick-start tips inline rather
       than a separate "what now?" email so day-0 carries its weight.
    """
    safe_name = _esc((name or "").split()[0]) if name else "there"
    dashboard_url = APP_URL.rstrip("/")
    knowledge_url = f"{dashboard_url}/knowledge"
    chatbot_url = f"{dashboard_url}/chatbot"
    billing_url = f"{dashboard_url}/billing"

    # Render the deadline in a forgiving, date-only format so timezone
    # drift between sender and recipient doesn't make the email lie.
    end_human = trial_end.strftime("%B %-d, %Y")

    body_inner = (
        f'<tr><td class="oc-pad-x" style="padding:32px 40px 0 40px;">'
        f'<h1 class="oc-h1" style="margin:0 0 18px 0;font-family:{_FONT_STACK};'
        f'font-size:24px;font-weight:700;color:{_INK_900};line-height:1.25;">'
        f"Welcome to {html.escape(BRAND_NAME)}, {safe_name} &mdash; your "
        f"{duration_days}-day free trial is live"
        f"</h1>"
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"You&rsquo;ve got <strong>{credits:,} credits</strong> to spend "
        f"however you like &mdash; chats, URL crawls, document uploads. "
        f"Your trial runs until "
        f'<strong style="color:{_INK_900};">{html.escape(end_human)}</strong>. '
        f"No card on file, no auto-charge."
        f"</p>"
        f'<p style="margin:0 0 22px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Pop the dashboard open and let&rsquo;s get your first bot answering "
        f"customer questions:"
        f"</p>"
        f"{_affiliate_cta_button(dashboard_url, 'Open my dashboard')}"
        f'<p style="margin:28px 0 12px 0;font-family:{_FONT_STACK};font-size:13px;'
        f"font-weight:600;color:{_INK_900};letter-spacing:0.02em;"
        f'text-transform:uppercase;">'
        f"A 3-step path to your first chat"
        f"</p>"
        f'<ol style="margin:0 0 8px 0;padding-left:20px;font-family:{_FONT_STACK};'
        f'font-size:14px;color:{_INK_500};line-height:1.65;">'
        f"<li>"
        f'<a href="{html.escape(knowledge_url, quote=True)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;font-weight:600;">'
        f"Upload your knowledge base"
        f"</a> &mdash; PDFs, docs, or just paste your website URL and we crawl it."
        f"</li>"
        f"<li>"
        f'<a href="{html.escape(chatbot_url, quote=True)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;font-weight:600;">'
        f"Style the widget"
        f"</a> &mdash; colors, logo, welcome message, all of it."
        f"</li>"
        f"<li>"
        f'<a href="{html.escape(chatbot_url, quote=True)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;font-weight:600;">'
        f"Drop the script tag"
        f"</a> on your site &mdash; one line of HTML and you&rsquo;re live."
        f"</li>"
        f"</ol>"
        f'<p style="margin:28px 0 0 0;font-family:{_FONT_STACK};font-size:13px;'
        f'color:{_INK_300};line-height:1.55;">'
        f"Love what you see before day {duration_days}? "
        f'<a href="{html.escape(billing_url, quote=True)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;">Pick a plan any time</a> '
        f"to keep your bot live past the trial. Stuck on something? Just "
        f"reply to this email or write to "
        f'<a href="mailto:{html.escape(SUPPORT_EMAIL)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;">{html.escape(SUPPORT_EMAIL)}</a>.'
        f"</p>"
        f"</td></tr>"
    )

    html_body = _html_doc(
        preheader=(
            f"You’ve got {credits:,} credits and {duration_days} days to "
            f"build the bot that answers your customers’ questions."
        ),
        body_inner=body_inner,
        visitor=False,
    )
    try:
        send_email_async(
            to_email,
            f"Welcome to {BRAND_NAME} — your {duration_days}-day trial is live",
            html_body,
        )
    except Exception as exc:
        # Registration must not fail because of a transport glitch. The
        # day-1 nudge cron (PR4) acts as a soft retry — if the customer
        # never gets day-0 they still get day-1.
        local, _, domain = to_email.partition("@")
        redacted = f"{local[:1]}***@{domain}" if local and domain else "***"
        logger.warning("trial_welcome_email_failed for %s: %s", redacted, exc)
        _capture_email_failure(exc, event="trial_welcome", email=to_email)


# ── Trial lifecycle cadence (PR4) ─────────────────────────────────────────
#
# Four touchpoints fired by the worker crons in ``app.worker.tasks``:
#
# * ``trial_day_7``   — midpoint check-in, celebrates activation
# * ``trial_days_left`` — parameterised "X days remaining" warning
#                        (used for day-11 and day-13 fires)
# * ``trial_ended``   — day-14, asks for plan + card; quotes the
#                        15-day data-retention window
# * ``trial_data_deleted`` — final notification after the retention
#                        window lapses and the worker has purged
#                        bots / documents / sessions
#
# Each helper swallows transport failures the same way ``send_trial_welcome_email``
# does. The cron records its own ``trial_emails_sent`` marker only after
# the helper returns; a Brevo blip therefore lets the next cron tick
# retry instead of pretending the email landed.


def _trial_redact(to_email: str) -> str:
    local, _, domain = to_email.partition("@")
    return f"{local[:1]}***@{domain}" if local and domain else "***"


def _trial_cta_button(href: str, label: str) -> str:
    """Trial-cadence emails share the affiliate pill — the design system has
    one primary CTA shape and this is it."""
    return _affiliate_cta_button(href, label)


def send_trial_day_7_email(
    to_email: str,
    *,
    name: str | None,
    days_remaining: int,
    plan_name: str,
) -> None:
    """Halfway-through nudge. Tone: encouraging, not salesy."""
    safe_name = _esc((name or "").split()[0]) if name else "there"
    dashboard_url = APP_URL.rstrip("/")
    billing_url = f"{dashboard_url}/billing"

    body_inner = (
        f'<tr><td class="oc-pad-x" style="padding:32px 40px 0 40px;">'
        f'<h1 class="oc-h1" style="margin:0 0 18px 0;font-family:{_FONT_STACK};'
        f'font-size:24px;font-weight:700;color:{_INK_900};line-height:1.25;">'
        f"You&rsquo;re halfway through your {html.escape(plan_name)} trial, {safe_name}"
        f"</h1>"
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Quick check-in &mdash; you&rsquo;ve got "
        f'<strong style="color:{_INK_900};">{days_remaining} days left</strong>. '
        f"If your bot is live and answering visitors, you&rsquo;re ahead of the curve. "
        f"If you haven&rsquo;t uploaded knowledge or dropped the script tag yet, "
        f"this is the week to do it."
        f"</p>"
        f'<p style="margin:0 0 22px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Open the dashboard to see your stats or finish the setup:"
        f"</p>"
        f"{_trial_cta_button(dashboard_url, 'Open my dashboard')}"
        f'<p style="margin:28px 0 0 0;font-family:{_FONT_STACK};font-size:13px;'
        f'color:{_INK_300};line-height:1.55;">'
        f"Already sold? "
        f'<a href="{html.escape(billing_url, quote=True)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;">Pick a plan</a> '
        f"any time &mdash; conversion preserves your bot, documents, and chat history."
        f"</p>"
        f"</td></tr>"
    )

    html_body = _html_doc(
        preheader=f"Halfway through your trial — {days_remaining} days left.",
        body_inner=body_inner,
        visitor=False,
    )
    try:
        send_email_async(
            to_email,
            f"You’re halfway through your {BRAND_NAME} trial",
            html_body,
        )
    except Exception as exc:
        logger.warning("trial_day_7_email_failed for %s: %s", _trial_redact(to_email), exc)
        _capture_email_failure(exc, event="trial_day_7", email=to_email)


def send_trial_days_left_email(
    to_email: str,
    *,
    name: str | None,
    days_remaining: int,
    plan_name: str,
) -> None:
    """Urgency reminder fired at day-11 (3 left) and day-13 (1 left)."""
    safe_name = _esc((name or "").split()[0]) if name else "there"
    dashboard_url = APP_URL.rstrip("/")
    billing_url = f"{dashboard_url}/billing"

    # Tone scales with urgency — 1 day left is the "tomorrow" frame.
    if days_remaining <= 1:
        headline = f"Your {html.escape(plan_name)} trial ends tomorrow"
        body_lead = (
            f"Heads up &mdash; your trial wraps up in about "
            f'<strong style="color:{_INK_900};">{days_remaining} day</strong>. '
            f"After that your widget will switch to its offline message until you pick a plan."
        )
        subject = f"Your {BRAND_NAME} trial ends tomorrow"
    else:
        headline = f"{days_remaining} days left in your {html.escape(plan_name)} trial"
        body_lead = (
            f"You&rsquo;ve got "
            f'<strong style="color:{_INK_900};">{days_remaining} days</strong> '
            f"to keep evaluating. If you&rsquo;d like your bot to stay live without a gap, "
            f"pick a plan before the trial ends."
        )
        subject = f"{days_remaining} days left in your {BRAND_NAME} trial"

    body_inner = (
        f'<tr><td class="oc-pad-x" style="padding:32px 40px 0 40px;">'
        f'<h1 class="oc-h1" style="margin:0 0 18px 0;font-family:{_FONT_STACK};'
        f'font-size:24px;font-weight:700;color:{_INK_900};line-height:1.25;">'
        f"Hi {safe_name} &mdash; {headline.lower()}"
        f"</h1>"
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"{body_lead}"
        f"</p>"
        f'<p style="margin:0 0 22px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Your knowledge base, settings, and chat history are kept safe for "
        f"15 days after the trial ends &mdash; nothing is lost if you decide later."
        f"</p>"
        f"{_trial_cta_button(billing_url, 'Pick a plan')}"
        f'<p style="margin:24px 0 0 0;font-family:{_FONT_STACK};font-size:13px;'
        f'color:{_INK_300};line-height:1.55;">'
        f"Questions about pricing? Reply to this email or write to "
        f'<a href="mailto:{html.escape(SUPPORT_EMAIL)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;">{html.escape(SUPPORT_EMAIL)}</a>.'
        f"</p>"
        f"</td></tr>"
    )

    html_body = _html_doc(
        preheader=f"{days_remaining} day{'s' if days_remaining != 1 else ''} left in your trial.",
        body_inner=body_inner,
        visitor=False,
    )
    try:
        send_email_async(to_email, subject, html_body)
    except Exception as exc:
        logger.warning(
            "trial_days_left_email_failed for %s (days=%s): %s",
            _trial_redact(to_email),
            days_remaining,
            exc,
        )
        _capture_email_failure(exc, event="trial_days_left", email=to_email, days_remaining=days_remaining)


def send_trial_ended_email(
    to_email: str,
    *,
    name: str | None,
    plan_name: str,
    data_retention_until: datetime,
) -> None:
    """Fired the moment the expiry cron flips status to ``trial_expired``."""
    safe_name = _esc((name or "").split()[0]) if name else "there"
    billing_url = f"{APP_URL.rstrip('/')}/billing"
    retention_human = data_retention_until.strftime("%B %-d, %Y")

    body_inner = (
        f'<tr><td class="oc-pad-x" style="padding:32px 40px 0 40px;">'
        f'<h1 class="oc-h1" style="margin:0 0 18px 0;font-family:{_FONT_STACK};'
        f'font-size:24px;font-weight:700;color:{_INK_900};line-height:1.25;">'
        f"Your {html.escape(plan_name)} trial has ended"
        f"</h1>"
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Hi {safe_name} &mdash; your trial of "
        f'<strong style="color:{_INK_900};">{html.escape(plan_name)}</strong> '
        f"wrapped up today. Your bot is now showing its offline message to visitors. "
        f"Pick a plan and your bot is back online within a minute."
        f"</p>"
        f'<p style="margin:0 0 22px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Your knowledge base, settings, and chat history are kept safe until "
        f'<strong style="color:{_INK_900};">{html.escape(retention_human)}</strong>. '
        f"After that date, the workspace is permanently deleted."
        f"</p>"
        f"{_trial_cta_button(billing_url, 'Choose a plan to reactivate')}"
        f'<p style="margin:24px 0 0 0;font-family:{_FONT_STACK};font-size:13px;'
        f'color:{_INK_300};line-height:1.55;">'
        f"Trial didn&rsquo;t fit? We&rsquo;d love quick feedback &mdash; "
        f'<a href="mailto:{html.escape(SUPPORT_EMAIL)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;">{html.escape(SUPPORT_EMAIL)}</a>.'
        f"</p>"
        f"</td></tr>"
    )

    html_body = _html_doc(
        preheader=(f"Your trial has ended. Reactivate by {retention_human} to keep your bot and data."),
        body_inner=body_inner,
        visitor=False,
    )
    try:
        send_email_async(
            to_email,
            f"Your {BRAND_NAME} trial has ended — pick a plan to keep your bot live",
            html_body,
        )
    except Exception as exc:
        logger.warning("trial_ended_email_failed for %s: %s", _trial_redact(to_email), exc)
        _capture_email_failure(exc, event="trial_ended", email=to_email)


def send_trial_data_deleted_email(
    to_email: str,
    *,
    name: str | None,
) -> None:
    """Sent after the hard-delete cron purges the workspace.

    No CTA — at this point the customer's account is deactivated. Brief,
    factual, leaves the door open for sign-up later.
    """
    safe_name = _esc((name or "").split()[0]) if name else "there"

    body_inner = (
        f'<tr><td class="oc-pad-x" style="padding:32px 40px 0 40px;">'
        f'<h1 class="oc-h1" style="margin:0 0 18px 0;font-family:{_FONT_STACK};'
        f'font-size:24px;font-weight:700;color:{_INK_900};line-height:1.25;">'
        f"Your {html.escape(BRAND_NAME)} workspace has been deleted"
        f"</h1>"
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"Hi {safe_name} &mdash; as scheduled, we&rsquo;ve permanently deleted the "
        f"bots, documents, and chat history from your trial workspace. Nothing is "
        f"recoverable from this account."
        f"</p>"
        f'<p style="margin:0 0 14px 0;font-family:{_FONT_STACK};font-size:15px;'
        f'color:{_INK_500};line-height:1.55;">'
        f"If you ever want to give {html.escape(BRAND_NAME)} another look, you can "
        f"start fresh any time &mdash; no hard feelings."
        f"</p>"
        f'<p style="margin:24px 0 0 0;font-family:{_FONT_STACK};font-size:13px;'
        f'color:{_INK_300};line-height:1.55;">'
        f"Questions? Reply to this email or write to "
        f'<a href="mailto:{html.escape(SUPPORT_EMAIL)}" '
        f'style="color:{_BRAND_PRIMARY};text-decoration:none;">{html.escape(SUPPORT_EMAIL)}</a>.'
        f"</p>"
        f"</td></tr>"
    )

    html_body = _html_doc(
        preheader="Your trial workspace has been permanently deleted.",
        body_inner=body_inner,
        visitor=False,
    )
    try:
        send_email_async(
            to_email,
            f"Your {BRAND_NAME} workspace has been deleted",
            html_body,
        )
    except Exception as exc:
        logger.warning("trial_data_deleted_email_failed for %s: %s", _trial_redact(to_email), exc)
        _capture_email_failure(exc, event="trial_data_deleted", email=to_email)
