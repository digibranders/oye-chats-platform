"""Email notification service. Transport is Brevo (HTTP API) or AWS SES (HTTP
API via boto3), selected per-environment by ``EMAIL_PROVIDER`` — see
``_send_raw_email``.

Every email is rendered from the shared design system in ``email_design`` (monochrome +
single-indigo-accent, dark-mode hardened for Outlook). All 19 senders build raw HTML in
code and dispatch through ``send_email_async``. There are no server-side Brevo saved
templates in the send path anymore, so the design lives in one place and the gallery
(``scripts/build_email_gallery``) renders these same functions.
"""

import asyncio
import base64
import contextlib
import json
import logging
import re
from email import encoders
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.config import (
    APP_URL,
    BRAND_NAME,
    BREVO_API_KEY,
    EMAIL_ENABLED,
    EMAIL_FROM_ADDRESS,
    EMAIL_FROM_NAME,
    EMAIL_PROVIDER,
    SES_AWS_ACCESS_KEY_ID,
    SES_AWS_REGION,
    SES_AWS_SECRET_ACCESS_KEY,
    SUPPORT_EMAIL,
)
from app.services import email_design as ed
from app.services.email_design import button, code_box, esc, h1, info_table, link, p, shell, strong

logger = logging.getLogger(__name__)

BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"
BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account"

_SUPPORT_LINK = link(esc(SUPPORT_EMAIL), f"mailto:{SUPPORT_EMAIL}")


def redact_email(to_email: str) -> str:
    """``gaurav@example.com`` → ``g***@example.com``.

    The one address redactor for everything that emits a recipient: this module,
    ``worker.tasks``' two send tasks, and ``offline_message_routes``. Local part
    cut to its first character, domain kept. The domain is the diagnostic.
    "every @outlook.com send is bouncing" is a real finding and a fully masked
    address cannot express it, and it is not personal data on its own. Anything
    without an ``@`` collapses to ``***``, because a value that is not an address
    is a value we cannot vouch for.

    Public because a recipient here is often a *visitor's* address (the chat
    follow-up in ``lead_routes``, the offline-message reply), which is personal
    data under GDPR and under India's DPDP Act, where this product's basis is
    consent-only, and because Sentry's LoggingIntegration turns every log
    record that carries one into a breadcrumb or an event. There should be no
    second copy of this rule.
    """
    local, _, domain = to_email.partition("@")
    return f"{local[:1]}***@{domain}" if local and domain else "***"


# Same shape as ``core.langfuse_client._EMAIL_RE``, deliberately duplicated
# rather than imported: that module is the Langfuse client and pulling it in
# here would make every email send depend on the tracing stack for a regex.
_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")


def _email_failure_tags(tags: dict) -> dict[str, str]:
    """Build the ``email.*`` Sentry tags for :func:`_capture_email_failure`.

    PRIVACY. Every address in a tag value goes through :func:`redact_email`
    before it leaves the process. Callers pass the recipient verbatim (as
    ``to=`` or ``email=``), and for the visitor-facing senders (the chat
    follow-up in ``lead_routes``, the offline-message notification) that
    recipient is a *visitor's* address, personal data under GDPR and under
    India's DPDP Act, where this product's basis is consent-only. Most of these
    call sites already redacted the same value for their local log; the Sentry
    path was simply missed.

    Redaction rather than dropping (the usual call, see ``core.visitor_privacy``
    and d041a7a) because ``g***@example.com`` is not a constant: the domain
    survives, which is the whole reason to tag a send failure with a recipient
    at all. Applied as a substitution over the value rather than per key, so it
    also catches the ``reason`` tag (Brevo's error bodies quote the offending
    address back at us) and so a caller inventing a new key cannot reopen this.
    """
    return {
        f"email.{key}": _EMAIL_RE.sub(lambda m: redact_email(m.group(0)), str(value)) for key, value in tags.items()
    }


def _capture_email_failure(exc: Exception, **tags) -> None:
    """Capture an email-send failure to Sentry (if configured) with tags.

     Fire-and-forget daemon threads otherwise lose these exceptions entirely
    . Logger.error is not enough because no one reads app logs proactively.
    """
    with contextlib.suppress(Exception):
        import sentry_sdk

        with sentry_sdk.push_scope() as scope:
            for key, value in _email_failure_tags(tags).items():
                scope.set_tag(key, value)
            sentry_sdk.capture_exception(exc)


def _extract_brevo_error(exc: Exception) -> str:
    """Extract the human-readable reason from a Brevo API failure."""
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


# ── Brevo Template IDs (legacy) ──────────────────────────────────────────────
# Retained for the super-admin template catalogue + backward compatibility. The
# send path no longer uses saved templates (every email renders in code) but
# the IDs still exist in the Brevo account.
TEMPLATE_PASSWORD_RESET = 57
TEMPLATE_QUALIFIED_LEAD = 60
TEMPLATE_HANDOFF_REQUEST = 61
TEMPLATE_MISSED_CALLBACK = 62
TEMPLATE_OFFLINE_MESSAGE = 58
TEMPLATE_CHAT_TRANSCRIPT = 63
TEMPLATE_VISITOR_CONFIRMATION = 59


# ── Brevo transport ──────────────────────────────────────────────────────────


def _send_brevo_email(
    to_email: str,
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
    attachments: list[dict] | None = None,
) -> bool:
    """Send an email via Brevo transactional API using raw HTML. Returns True on success."""
    if not EMAIL_ENABLED:
        logger.warning(
            "Email skipped. EMAIL_ENABLED=False (no BREVO_API_KEY) | to=%s subject=%s",
            redact_email(to_email),
            subject,
        )
        return False

    email_payload: dict = {
        "sender": {"name": sender_name or EMAIL_FROM_NAME, "email": EMAIL_FROM_ADDRESS},
        "to": [{"email": to_email}],
        "subject": subject,
        "htmlContent": html_body,
    }
    if reply_to:
        email_payload["replyTo"] = {"email": reply_to}
    if attachments:
        # Brevo transactional attachment format: [{"content": <base64>, "name": <filename>}].
        email_payload["attachment"] = attachments

    payload = json.dumps(email_payload).encode("utf-8")
    req = Request(
        BREVO_API_URL,
        data=payload,
        headers={"accept": "application/json", "content-type": "application/json", "api-key": BREVO_API_KEY},
        method="POST",
    )
    try:
        with urlopen(req, timeout=10) as resp:
            logger.info(f"Email sent to {redact_email(to_email)} | subject={subject} | status={resp.status}")
            return True
    except Exception as e:
        reason = _extract_brevo_error(e)
        logger.warning("Brevo email failed | to=%s subject=%s reason=%s", redact_email(to_email), subject, reason)
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

    Legacy transport. The current send path renders HTML in code and does not call this;
    it is kept for the worker's ``task_send_template_email`` and any external callers.
    """
    if not EMAIL_ENABLED:
        logger.warning(
            "Email skipped. EMAIL_ENABLED=False (no BREVO_API_KEY) | to=%s template_id=%s",
            redact_email(to_email),
            template_id,
        )
        return False

    email_payload: dict = {"to": [{"email": to_email}], "templateId": template_id, "params": params}
    if reply_to:
        email_payload["replyTo"] = {"email": reply_to}

    payload = json.dumps(email_payload).encode("utf-8")
    req = Request(
        BREVO_API_URL,
        data=payload,
        headers={"accept": "application/json", "content-type": "application/json", "api-key": BREVO_API_KEY},
        method="POST",
    )
    try:
        with urlopen(req, timeout=10) as resp:
            logger.info(
                f"Template email sent to {redact_email(to_email)} | template_id={template_id} | status={resp.status}"
            )
            return True
    except Exception as e:
        reason = _extract_brevo_error(e)
        logger.warning(
            "Brevo template email failed | to=%s template_id=%s reason=%s", redact_email(to_email), template_id, reason
        )
        _capture_email_failure(e, kind="template", to=to_email, template_id=template_id, reason=reason)
        return False


# ── AWS SES transport (HTTPS API via boto3) ──────────────────────────────────
# Not SMTP: DigitalOcean (and most hosts) block outbound ports 25/465/587 by
# default, which broke a working SES-over-SMTP integration the moment it hit
# production (2026-08-22). The API rides port 443, same as Brevo — see the
# EMAIL_PROVIDER comment in config.py.


def _extract_ses_error(exc: Exception) -> str:
    """Extract a human-readable reason from an SES API failure."""
    if isinstance(exc, ClientError):
        error = exc.response.get("Error", {})
        return f"SES {error.get('Code', 'Unknown')}: {error.get('Message', str(exc))}"
    if isinstance(exc, BotoCoreError):
        return f"{type(exc).__name__}: {exc}"
    return f"{type(exc).__name__}: {exc}"


def _send_ses_email(
    to_email: str,
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
    attachments: list[dict] | None = None,
) -> bool:
    """Send an email via the AWS SES HTTPS API (``send_raw_email``). Returns True on success.

    Same signature and return contract as ``_send_brevo_email`` so callers (and
    ``_send_raw_email`` below) don't need to know which transport is active.
    ``attachments`` stays in the Brevo shape (``{"content": <base64>, "name": <filename>}``)
    since that's what every existing sender already builds; only this function
    knows it needs to become a MIME part instead of a JSON field. The message is
    built as a standard MIME document and handed to SES as raw bytes — SES parses
    it itself, so this is the same message shape a raw SMTP send would have used,
    just delivered over HTTPS instead of an SMTP socket.
    """
    if not EMAIL_ENABLED:
        logger.warning(
            "Email skipped. EMAIL_ENABLED=False (no SES API credentials) | to=%s subject=%s",
            redact_email(to_email),
            subject,
        )
        return False

    msg = MIMEMultipart("mixed")
    msg["Subject"] = subject
    msg["From"] = formataddr((sender_name or EMAIL_FROM_NAME, EMAIL_FROM_ADDRESS))
    msg["To"] = to_email
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    for attachment in attachments or []:
        part = MIMEBase("application", "octet-stream")
        part.set_payload(base64.b64decode(attachment["content"]))
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{attachment["name"]}"')
        msg.attach(part)

    try:
        client = boto3.client(
            "ses",
            region_name=SES_AWS_REGION,
            aws_access_key_id=SES_AWS_ACCESS_KEY_ID,
            aws_secret_access_key=SES_AWS_SECRET_ACCESS_KEY,
        )
        client.send_raw_email(Source=EMAIL_FROM_ADDRESS, Destinations=[to_email], RawMessage={"Data": msg.as_bytes()})
        logger.info(f"Email sent to {redact_email(to_email)} | subject={subject} | provider=ses")
        return True
    except Exception as e:
        reason = _extract_ses_error(e)
        logger.warning("SES email failed | to=%s subject=%s reason=%s", redact_email(to_email), subject, reason)
        _capture_email_failure(e, kind="raw", to=to_email, subject=subject, reason=reason)
        return False


def _send_raw_email(
    to_email: str,
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
    attachments: list[dict] | None = None,
) -> bool:
    """Route a raw HTML send to the transport selected by ``EMAIL_PROVIDER``.

    The single call site every sender should go through indirectly (via
    ``send_email_async``) or directly (the worker task). Keeping the branch here,
    not duplicated at each call site, means adding a third provider later is a
    one-function change.
    """
    if EMAIL_PROVIDER == "ses":
        return _send_ses_email(
            to_email, subject, html_body, reply_to=reply_to, sender_name=sender_name, attachments=attachments
        )
    return _send_brevo_email(
        to_email, subject, html_body, reply_to=reply_to, sender_name=sender_name, attachments=attachments
    )


def send_email_async(
    to_email: str,
    subject: str,
    html_body: str,
    *,
    reply_to: str | None = None,
    sender_name: str | None = None,
    attachments: list[dict] | None = None,
):
    """Fire-and-forget raw HTML email. Non-blocking.

    When WORKER_ENABLED=true, enqueues to ARQ (durable, retryable). Otherwise uses a
    thread-pool / threading fallback. ``attachments`` uses the Brevo format and is
    JSON-serializable so it rides through the ARQ job args unchanged.
    """
    from app.worker.enqueue import WORKER_ENABLED

    if WORKER_ENABLED:
        from app.worker.enqueue import enqueue_sync

        enqueue_sync("task_send_email", to_email, subject, html_body, reply_to, sender_name, attachments)
        return

    def _send():
        _send_raw_email(
            to_email, subject, html_body, reply_to=reply_to, sender_name=sender_name, attachments=attachments
        )

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
    """Fire-and-forget Brevo template email (legacy transport). Non-blocking."""
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
    """Send a Brevo template email to multiple recipients (legacy). Non-blocking."""
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
    """Send the same raw HTML email to multiple recipients (one API call per recipient)."""
    for email_addr in recipients:
        send_email_async(email_addr, subject, html_body, reply_to=reply_to, sender_name=sender_name)


def get_notification_recipients(bot, event_type: str) -> list[str]:
    """Resolve notification email recipients for a given event type.

    Resolution chain (first non-empty wins): per-event override → default list →
    legacy comma-separated single field → empty list.
    """
    ne = bot.notification_emails
    if isinstance(ne, dict):
        event_list = ne.get(event_type)
        if isinstance(event_list, list) and event_list:
            return [e.strip() for e in event_list if e and e.strip()]
        default_list = ne.get("default")
        if isinstance(default_list, list) and default_list:
            return [e.strip() for e in default_list if e and e.strip()]
    if bot.notification_email:
        return [e.strip() for e in bot.notification_email.split(",") if e.strip()]
    return []


def _branded_sender_name(bot_name: str) -> str:
    """Build the '<BotName> via <Brand>' sender display name."""
    return f"{bot_name} via {BRAND_NAME}"


def _first_name(name: str | None) -> str:
    return esc(name.split()[0]) if name and name.split() else "there"


def _mailto(addr: str) -> str:
    """A mailto link whose visible text is the (escaped) address."""
    safe = esc(addr)
    return link(safe, f"mailto:{addr}") if addr else "&#8212;"


# ── Lead / live-chat emails (customer & operator facing) ─────────────────────


def send_qualified_lead_email(
    notification_email: str,
    bot_name: str,
    bant: dict,
    contact: dict | None = None,
    tier: str = "sql",
    *,
    reply_to: str | None = None,
):
    """Send email when a lead reaches a BANT qualification tier."""
    tier_key = (tier or "sql").lower()
    tier_label = {
        "mql": "Marketing Qualified Lead",
        "sal": "Sales Accepted Lead",
        "sql": "Sales Qualified Lead",
        "unqualified": "New Lead",
    }.get(tier_key, "New Lead")
    chip_kind = "success" if tier_key == "sql" else "warning"
    safe_bot = esc(bot_name)
    contact = contact or {}

    inner = (
        h1("New qualified lead")
        + p(
            f"A visitor on {strong(safe_bot)} has reached {esc(tier_label)} status. They match your "
            f"qualification criteria. &nbsp;{ed.chip(tier_label, chip_kind)}"
        )
        + ed.section_label("Qualification (BANT)")
        + info_table(
            [
                ("Need", esc(bant.get("bant_need"))),
                ("Budget", esc(bant.get("bant_budget"))),
                ("Authority", esc(bant.get("bant_authority"))),
                ("Timeline", esc(bant.get("bant_timeline"))),
            ]
        )
        + ed.section_label("Contact")
        + info_table(
            [
                ("Name", esc(contact.get("name"))),
                ("Email", _mailto(contact.get("email"))),
                ("Phone", esc(contact.get("phone"))),
                ("Company", esc(contact.get("company"))),
            ]
        )
        + button("View lead in dashboard", f"{APP_URL}/leads")
    )
    html_body = shell(
        subject=f"New {tier_label} from {bot_name}",
        preheader=f"New {tier_label} from {bot_name}.",
        inner=inner,
    )
    send_email_async(
        notification_email,
        f"New {tier_label} from {bot_name}",
        html_body,
        reply_to=reply_to,
        sender_name=_branded_sender_name(bot_name),
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
    safe_bot = esc(bot_name)
    contact = contact or {}
    inner = (
        h1("A visitor wants to chat")
        + p(
            f"A visitor on {strong(safe_bot)} is requesting to speak with an operator. "
            f"They&rsquo;re waiting in the queue right now."
        )
        + ed.section_label("Visitor")
        + info_table(
            [
                ("Name", esc(contact.get("name")) if contact.get("name") else "Unknown"),
                ("Email", _mailto(contact.get("email"))),
                ("Reason", esc(reason) if reason else "No reason provided"),
            ]
        )
        + ed.alert(
            "Visitors typically wait less than 60 seconds before abandoning a live-chat queue. "
            "Please respond promptly.",
            "warning",
        )
        + button("Accept request", f"{APP_URL}/support")
    )
    html_body = shell(
        subject=f"{contact.get('name') or 'A visitor'} is waiting to chat on {bot_name}",
        preheader=f"A visitor is waiting in your live-chat queue on {bot_name}.",
        inner=inner,
    )
    send_email_async(
        notification_email,
        f"{contact.get('name') or 'A visitor'} is waiting to chat on {bot_name}",
        html_body,
        reply_to=reply_to,
        sender_name=_branded_sender_name(bot_name),
    )


def send_unavailable_callback_email(
    notification_email: str, bot_name: str, contact: dict, *, reply_to: str | None = None
):
    """Send email when no agent was available and visitor left contact details."""
    safe_bot = esc(bot_name)
    inner = (
        h1("Follow up with a visitor")
        + p(
            f"{strong('No operator was available')} when a visitor on {strong(safe_bot)} requested live support. "
            f"They left their contact details so you can follow up."
        )
        + ed.alert(
            "Reach out within the next hour for the best chance of converting this missed "
            "connection into a qualified conversation.",
            "danger",
        )
        + ed.section_label("Visitor")
        + info_table(
            [
                ("Name", esc(contact.get("name"))),
                ("Email", _mailto(contact.get("email"))),
                ("Phone", esc(contact.get("phone"))),
            ]
        )
        + button("Follow up now", f"{APP_URL}/leads")
    )
    html_body = shell(
        subject=f"Missed live-chat request from {bot_name}",
        preheader=f"A visitor requested support on {bot_name} while no operator was available.",
        inner=inner,
    )
    send_email_async(
        notification_email,
        f"Missed live-chat request from {bot_name}",
        html_body,
        reply_to=reply_to,
        sender_name=_branded_sender_name(bot_name),
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
    safe_bot = esc(bot_name)
    inner = (
        h1("New offline message")
        + p(f"A visitor on {strong(safe_bot)} left a message while no operator was available.")
        + ed.section_label("From")
        + info_table(
            [
                ("Name", esc(visitor_name)),
                ("Email", _mailto(visitor_email)),
            ]
        )
        + ed.section_label("Message")
        + ed.quote(esc(message_preview))
        + button("View &amp; reply", f"{APP_URL}/support")
    )
    html_body = shell(
        subject=f"New offline message from {bot_name}",
        preheader=f"New message from {visitor_name} on {bot_name}. Reply when you're back.",
        inner=inner,
    )
    send_email_async(
        notification_email,
        f"New offline message from {bot_name}",
        html_body,
        reply_to=reply_to,
        sender_name=_branded_sender_name(bot_name),
    )


# ── Authentication & account emails ──────────────────────────────────────────


def send_password_reset_email(to_email: str, otp: str):
    """Send a password reset OTP email."""
    inner = (
        h1("Reset your password")
        + p("We received a request to reset the password on your account. Enter the code below to choose a new one.")
        + code_box(otp)
        + ed.alert(
            f"This code expires in {strong('15 minutes')}. Never share it. "
            f"{esc(BRAND_NAME)} staff will never ask for it.",
            "warning",
        )
        + p("Didn&rsquo;t request this? You can safely ignore this email; your password stays the same.")
    )
    send_email_async(
        to_email,
        f"Your {BRAND_NAME} password reset code",
        shell(
            subject=f"Your {BRAND_NAME} password reset code",
            preheader="Your password reset code. Expires in 15 minutes.",
            inner=inner,
        ),
    )


def send_verification_otp_email(to_email: str, name: str, otp: str) -> None:
    """Send a 6-digit email verification code."""
    inner = (
        h1("Verify your email")
        + p(
            f"Hi {_first_name(name)}, thanks for signing up. Enter the code below to verify your "
            f"email address and finish setting up your account."
        )
        + code_box(otp)
        + p(
            f"This code expires in {strong('15 minutes')}. If you didn&rsquo;t create an "
            f"{esc(BRAND_NAME)} account, you can safely ignore this email."
        )
    )
    send_email_async(
        to_email,
        f"Your {BRAND_NAME} verification code",
        shell(
            subject=f"Your {BRAND_NAME} verification code",
            preheader="Your verification code. Expires in 15 minutes.",
            inner=inner,
        ),
    )


def send_email_change_otp(to_email: str, name: str, otp: str) -> None:
    """Send a 6-digit code to a client's *new* email to confirm an email-change request."""
    inner = (
        h1("Confirm your new email")
        + p(
            f"Hi {_first_name(name)}, you asked to change the email on your {esc(BRAND_NAME)} account to "
            f"this address. Enter the code below to confirm the change."
        )
        + code_box(otp)
        + p(
            f"This code expires in {strong('15 minutes')}. If this wasn&rsquo;t you, you can ignore this "
            f"email. Your account email won&rsquo;t change."
        )
    )
    send_email_async(
        to_email,
        f"Confirm your new {BRAND_NAME} email address",
        shell(
            subject=f"Confirm your new {BRAND_NAME} email address",
            preheader="Confirm your new email address. Code expires in 15 minutes.",
            inner=inner,
        ),
    )


def send_email_change_requested_notice(to_email: str, name: str, new_email: str) -> None:
    """Notify a client's *current* (old) email that an email change was requested."""
    inner = (
        h1("Email change requested")
        + p(
            f"Hi {_first_name(name)}, someone requested to change the login email on your "
            f"{esc(BRAND_NAME)} account to {strong(esc(new_email))}."
        )
        + p(
            "The change only takes effect once that address confirms a verification code. This "
            "inbox stays your login email until then."
        )
        + ed.alert(
            f"If this wasn&rsquo;t you, {link('reset your password', APP_URL + '/reset')} immediately "
            f"and contact {_SUPPORT_LINK}.",
            "danger",
        )
    )
    send_email_async(
        to_email,
        f"Email change requested on your {BRAND_NAME} account",
        shell(
            subject=f"Email change requested on your {BRAND_NAME} account",
            preheader="A change to your login email was requested.",
            inner=inner,
        ),
    )


# ── Visitor-facing emails ────────────────────────────────────────────────────


def send_transcript_email(to_email: str, bot_name: str, messages: list[dict], *, reply_to: str | None = None):
    """Send a formatted chat transcript to the visitor's email."""
    safe_bot = esc(bot_name)
    role_labels = {"user": "You", "bot": safe_bot, "operator": "Operator", "system": "System"}
    # Distinct light tints per role (flatten to neutral in dark via oc-fill).
    tints = {
        "user": (ed.FILL, ed.INK700),
        "bot": (ed.ACCENT_TINT, "#3730a3"),
        "operator": ("#ecfdf3", "#065f46"),
    }

    rows: list[str] = []
    for msg in messages:
        role = msg.get("role", "bot")
        text = ed.md_to_html(esc(msg.get("content") or msg.get("text", "")))
        label = role_labels.get(role, safe_bot)
        ts = str(msg.get("created_at", ""))
        time_str = ts.split("T")[1][:5] if "T" in ts else ts[:5]
        time_html = (
            f'<span style="font-weight:400;color:{ed.INK300};">&nbsp;&middot;&nbsp;{esc(time_str)}</span>'
            if time_str
            else ""
        )

        if role == "system":
            rows.append(
                f'<tr><td style="padding:4px 0 12px 0;text-align:center;">'
                f'<span class="oc-muted" style="font-family:{ed.FONT};font-size:12px;color:{ed.INK300};'
                f'font-style:italic;">{text}</span></td></tr>'
            )
            continue

        bg, tc = tints.get(role, (ed.FILL, ed.INK700))
        rows.append(
            f'<tr><td style="padding:0 0 14px 0;">'
            f'<p class="oc-muted" style="margin:0 0 4px 0;font-family:{ed.FONT};font-size:11px;'
            f'font-weight:700;color:{ed.INK400};">{label}{time_html}</p>'
            f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td class="oc-fill oc-fill-text" style="background-color:{bg};border-radius:10px;'
            f"padding:11px 15px;font-family:{ed.FONT};font-size:14px;color:{tc};line-height:1.6;"
            f'white-space:pre-wrap;">{text}</td></tr></table></td></tr>'
        )

    transcript = (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'class="oc-fill oc-rule" style="background-color:{ed.FILL};border:1px solid {ed.RULE};'
        f'border-radius:10px;margin:0 0 18px 0;"><tr><td style="padding:18px 20px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f"{''.join(rows)}</table></td></tr></table>"
    )
    inner = (
        h1("Your chat transcript")
        + p(f"Here&rsquo;s a full transcript of your conversation with {strong(safe_bot)}.")
        + transcript
        + p(f"Sent from {safe_bot} via {esc(BRAND_NAME)}.")
    )
    send_email_async(
        to_email,
        f"Chat Transcript ({bot_name}",
        shell(
            subject=f"Chat Transcript) {bot_name}",
            preheader=f"Your conversation with {bot_name}. Full transcript.",
            inner=inner,
            visitor=True,
        ),
        reply_to=reply_to,
        sender_name=_branded_sender_name(bot_name),
    )


def send_visitor_confirmation_email(
    to_email: str, company_name: str, visitor_name: str, *, reply_to: str | None = None
):
    """Send a confirmation email to the visitor after they submit an offline message."""
    safe_company = esc(company_name) if company_name else esc(BRAND_NAME)
    inner = (
        h1("We got your message")
        + p(f"Hi {esc(visitor_name) if visitor_name else 'there'},")
        + p(
            f"Thanks for reaching out to {strong(safe_company)}. We&rsquo;ve received your message and "
            f"our team has been notified. Someone will get back to you shortly."
        )
        + ed.alert("Message received, no action needed on your end. We&rsquo;ll be in touch by email.", "success")
        + p("You can reply directly to this email if you have anything to add.")
    )
    send_email_async(
        to_email,
        f"Thank you for contacting {company_name or BRAND_NAME}",
        shell(
            subject=f"Thank you for contacting {company_name or BRAND_NAME}",
            preheader=f"Thanks {visitor_name or 'there'}. Your message was received.",
            inner=inner,
            visitor=True,
        ),
        reply_to=reply_to,
        sender_name=_branded_sender_name(company_name or BRAND_NAME),
    )


# ── Quotation emails ─────────────────────────────────────────────────────────

_CURRENCY_SYMBOLS = {
    "INR": "₹",
    "USD": "$",
    "EUR": "€",
    "GBP": "£",
    "AUD": "A$",
    "CAD": "C$",
    "SGD": "S$",
    "AED": "د.إ",
}


def _format_money(currency: str, value: object) -> str:
    """Render a money amount with its currency symbol. Whole numbers drop the
    decimals (₹200, not ₹200.00); fractional amounts keep two places."""
    symbol = _CURRENCY_SYMBOLS.get((currency or "").upper(), f"{(currency or '').upper()} ")
    try:
        rounded = round(float(value), 2)
    except (TypeError, ValueError):
        rounded = 0.0
    if rounded == int(rounded):
        return f"{symbol}{int(rounded):,}"
    return f"{symbol}{rounded:,.2f}"


def send_quotation_visitor_email(
    to_email: str,
    company_name: str,
    visitor_name: str | None,
    service_names: list[str],
    *,
    reply_to: str | None = None,
) -> None:
    """Confirm to the visitor that their quote request was received.

    Deliberately carries NO pricing: the widget never shows visitors prices, so
    neither does this email. It just acknowledges the request and sets the
    expectation that the team will follow up with the actual quote.
    """
    safe_company = esc(company_name) if company_name else esc(BRAND_NAME)
    names = [esc(s) for s in (service_names or []) if s]
    services_line = ", ".join(names) if names else "the services you selected"
    inner = (
        h1("Your quote request is in")
        + p(f"Hi {esc(visitor_name) if visitor_name else 'there'},")
        + p(
            f"Thanks for your interest in {strong(safe_company)}. We&rsquo;ve received your "
            f"request for a quote on {strong(services_line)}."
        )
        + ed.alert("Our team is preparing your quotation and will be in touch by email shortly.", "success")
        + p("You can reply directly to this email if you&rsquo;d like to add any details.")
    )
    send_email_async(
        to_email,
        f"Your quote request with {company_name or BRAND_NAME}",
        shell(
            subject=f"Your quote request with {company_name or BRAND_NAME}",
            preheader=f"Thanks {visitor_name or 'there'}. We&rsquo;re preparing your quote.",
            inner=inner,
            visitor=True,
        ),
        reply_to=reply_to,
        sender_name=_branded_sender_name(company_name or BRAND_NAME),
    )


def send_quotation_client_email(
    notification_email: str,
    bot_name: str,
    contact: dict | None,
    currency: str,
    line_items: list[dict],
    total: object,
    *,
    reply_to: str | None = None,
) -> None:
    """Notify the client that a visitor completed a quote request.

    Unlike the visitor email, this one carries the full itemised quote (line
    items + quantities + subtotals + total), the per-service question answers
    the visitor gave, and the visitor's contact info so the client can follow
    up. ``reply_to`` should be the visitor's email so a reply lands straight in
    their inbox.
    """
    safe_bot = esc(bot_name)
    contact = contact or {}

    # Money table: one row per service (name × qty → subtotal) + a bold total.
    quote_rows: list[tuple[str, str]] = []
    for item in line_items or []:
        qty = item.get("quantity")
        label = esc(item.get("name") or "Service")
        if qty:
            label = f"{label} &times; {esc(qty)}"
        quote_rows.append((label, _format_money(currency, item.get("subtotal", 0))))
    quote_rows.append(("Total", strong(_format_money(currency, total))))

    # Per-service Q&A: only for services that actually collected answers, so a
    # simple pick-and-quantity service adds no empty section.
    answer_sections = ""
    for item in line_items or []:
        answer_rows = [
            (esc(ans.get("question_text") or ans.get("question_id") or "Question"), esc(ans.get("answer")))
            for ans in item.get("answers") or []
            if (ans.get("answer") or "").strip()
        ]
        if answer_rows:
            answer_sections += ed.section_label(esc(item.get("name") or "Service")) + info_table(answer_rows)

    inner = (
        h1("New quote request")
        + p(f"A visitor on {strong(safe_bot)} just completed a quote request. Here&rsquo;s what they asked for.")
        + ed.section_label("Quote")
        + info_table(quote_rows, right=True)
        + (ed.section_label("Their answers") + answer_sections if answer_sections else "")
        + ed.section_label("Contact")
        + info_table(
            [
                ("Name", esc(contact.get("name")) if contact.get("name") else "Unknown"),
                ("Email", _mailto(contact.get("email"))),
                ("Phone", esc(contact.get("phone"))),
                ("Company", esc(contact.get("company"))),
            ]
        )
        + button("View lead in dashboard", f"{APP_URL}/leads")
    )
    send_email_async(
        notification_email,
        f"New quote request from {bot_name}",
        shell(
            subject=f"New quote request from {bot_name}",
            preheader=f"A visitor completed a quote request on {bot_name}.",
            inner=inner,
        ),
        reply_to=reply_to,
        sender_name=_branded_sender_name(bot_name),
    )


# ── Affiliate emails ─────────────────────────────────────────────────────────


def send_affiliate_welcome_email(to_email: str, name: str | None = None) -> None:
    """Email an existing customer that they're now an affiliate."""
    inner = (
        h1(f"You&rsquo;re now an {esc(BRAND_NAME)} affiliate")
        + p(
            f"Hi {_first_name(name)}. You&rsquo;ve just been enrolled in the {esc(BRAND_NAME)} affiliate "
            f"program. You can now create referral codes, share them anywhere, and track how each one "
            f"performs from your dashboard."
        )
        + button("Open my affiliate dashboard", f"{APP_URL}/affiliate")
        + p(f"Need help? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    send_email_async(
        to_email,
        f"You’re now an {BRAND_NAME} affiliate",
        shell(
            subject=f"You’re now an {BRAND_NAME} affiliate",
            preheader="Create referral codes and earn from every signup.",
            inner=inner,
        ),
    )


def send_affiliate_invite_email(to_email: str, accept_url: str, *, expires_in_days: int = 14) -> None:
    """Email a magic link to a non-customer invited as an affiliate."""
    expiry = f"{expires_in_days} day" if expires_in_days == 1 else f"{expires_in_days} days"
    inner = (
        h1(f"You&rsquo;ve been invited to {esc(BRAND_NAME)} Partners")
        + p(
            f"{esc(BRAND_NAME)} Partners is a hand-picked group earning recurring commission on every "
            f"account they bring to the platform. We&rsquo;d like you to join."
        )
        + p(
            f"Click below to accept. If you already have an account you&rsquo;ll sign in and the Affiliate "
            f"menu appears in your sidebar. New here? You can create an account in the same flow. This link "
            f"expires in {strong(esc(expiry))}."
        )
        + button("Accept your Partners invite", accept_url)
        + p("If the button doesn&rsquo;t work, paste this link into your browser:", top=8)
        + f'<p class="oc-link" style="margin:0 0 16px 0;font-family:{ed.FONT};font-size:13px;'
        f'color:{ed.ACCENT};word-break:break-all;line-height:1.5;">{link(esc(accept_url), accept_url)}</p>'
        + p(
            "Didn&rsquo;t expect this? You can safely ignore it, the invite will expire and no account will be created."
        )
    )
    send_email_async(
        to_email,
        f"You’re invited to {BRAND_NAME} Partners",
        shell(
            subject=f"You’re invited to {BRAND_NAME} Partners",
            preheader=f"Accept your Partners invite. Link expires in {expiry}.",
            inner=inner,
        ),
    )


def send_operator_invite_email(
    to_email: str,
    accept_url: str,
    *,
    workspace_name: str,
    inviter_name: str | None,
    expires_in_days: int = 7,
) -> None:
    """Magic-link invite for a new operator to join ``workspace_name``.

    ``accept_url`` carries the plaintext invite token (path or query).
    ``invite_service.accept_invite`` matches it back against the pending
    row. Single-use in effect: once accepted, the token no longer
    resolves to a pending invite, so a resend goes through a new URL.

    Templating matches ``send_affiliate_invite_email`` so both invites
    read the same to the recipient (heading + explainer + button +
    fallback link + safe-to-ignore note).
    """
    expiry = f"{expires_in_days} day" if expires_in_days == 1 else f"{expires_in_days} days"
    safe_workspace = esc(workspace_name)
    inviter_snippet = f"{esc(inviter_name)} has invited you" if inviter_name else "You&rsquo;ve been invited"
    inner = (
        h1(f"You&rsquo;ve been invited to {safe_workspace}")
        + p(
            f"{inviter_snippet} to join {strong(safe_workspace)} on {esc(BRAND_NAME)} as an operator. "
            f"Once you accept you&rsquo;ll be able to take live chats and support their visitors from your dashboard."
        )
        + p(f"Click below to accept. This link expires in {strong(esc(expiry))}.")
        + button("Accept invitation", accept_url)
        + p("If the button doesn&rsquo;t work, paste this link into your browser:", top=8)
        + f'<p class="oc-link" style="margin:0 0 16px 0;font-family:{ed.FONT};font-size:13px;'
        f'color:{ed.ACCENT};word-break:break-all;line-height:1.5;">{link(esc(accept_url), accept_url)}</p>'
        + p(
            "Didn&rsquo;t expect this? You can safely ignore it, the invite will expire and no account will be created."
        )
    )
    send_email_async(
        to_email,
        f"You’ve been invited to join {workspace_name} on {BRAND_NAME}",
        shell(
            subject=f"You’ve been invited to join {workspace_name} on {BRAND_NAME}",
            preheader=f"Accept your invite to join {workspace_name}. Link expires in {expiry}.",
            inner=inner,
        ),
    )


# ── Trial lifecycle emails ───────────────────────────────────────────────────


def send_trial_welcome_email(to_email: str, *, name: str | None, trial_end, credits: int, duration_days: int) -> None:
    """Day-0 welcome email fired the moment a customer lands on the trial."""
    end_human = trial_end.strftime("%B %-d, %Y")
    inner = (
        h1(f"Welcome to {esc(BRAND_NAME)}, {_first_name(name)}")
        + p(
            f"Your {strong(f'{duration_days}-day free trial')} is live. You&rsquo;ve got "
            f"{strong(f'{credits:,} credits')} to spend however you like. Chats, website training, document "
            f"uploads. Your trial runs until {strong(esc(end_human))}. No card on file, no auto-charge."
        )
        + button("Open my dashboard", APP_URL)
        + ed.divider()
        + ed.section_label("A 3-step path to your first chat")
        + ed.steps(
            [
                f"{link('Upload your knowledge base', APP_URL + '/knowledge')}. PDFs, docs, or paste your website URL and we train on it.",
                f"{link('Style the widget', APP_URL + '/chatbot')}. Colors, logo, welcome message.",
                f"{link('Drop the script tag', APP_URL + '/chatbot')} on your site, one line of HTML and you&rsquo;re live.",
            ]
        )
        + p(f"Stuck on something? Just reply to this email or write to {_SUPPORT_LINK}.")
    )
    try:
        send_email_async(
            to_email,
            f"Welcome to {BRAND_NAME} (your {duration_days}-day trial is live",
            shell(
                subject=f"Welcome to {BRAND_NAME}) your {duration_days}-day trial is live",
                preheader=f"You've got {credits:,} credits and {duration_days} days to build your bot.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("trial_welcome_email_failed for %s: %s", redact_email(to_email), exc)
        _capture_email_failure(exc, event="trial_welcome", email=to_email)


def send_trial_halfway_email(to_email: str, *, name: str | None, days_remaining: int, plan_name: str) -> None:
    """Halfway-through nudge. Fires at T-4 on the 7-day trial cadence."""
    inner = (
        h1(f"You&rsquo;re halfway through your trial, {_first_name(name)}")
        + p(
            f"Quick check-in. You&rsquo;ve got {strong(f'{days_remaining} days left')}. If your bot is live "
            f"and answering visitors, you&rsquo;re ahead of the curve. If you haven&rsquo;t uploaded knowledge "
            f"or dropped the script tag yet, this is the week to do it."
        )
        + button("Open my dashboard", APP_URL)
        + p(
            f"Already sold? {link('Pick a plan', APP_URL + '/billing')} any time. Conversion preserves your "
            f"bot, documents, and chat history.",
            top=8,
        )
    )
    try:
        send_email_async(
            to_email,
            f"You’re halfway through your {BRAND_NAME} trial",
            shell(
                subject=f"You’re halfway through your {BRAND_NAME} trial",
                preheader=f"Halfway through your trial - {days_remaining} days left.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("trial_halfway_email_failed for %s: %s", redact_email(to_email), exc)
        _capture_email_failure(exc, event="trial_halfway", email=to_email)


def send_trial_days_left_email(to_email: str, *, name: str | None, days_remaining: int, plan_name: str) -> None:
    """Urgency reminder fired at T-2 and T-1 on the 7-day trial cadence."""
    safe_plan = esc(plan_name)
    if days_remaining <= 1:
        headline = f"your {safe_plan} trial ends tomorrow"
        lead = (
            f"Heads up. Your trial wraps up in about {strong(f'{days_remaining} day')}. After that your "
            f"widget will switch to its offline message until you pick a plan."
        )
        subject = f"Your {BRAND_NAME} trial ends tomorrow"
    else:
        headline = f"{days_remaining} days left in your {safe_plan} trial"
        lead = (
            f"You&rsquo;ve got {strong(f'{days_remaining} days')} to keep evaluating. If you&rsquo;d like your "
            f"bot to stay live without a gap, pick a plan before the trial ends."
        )
        subject = f"{days_remaining} days left in your {BRAND_NAME} trial"

    inner = (
        h1(f"Hi {_first_name(name)} - {headline}")
        + p(lead)
        + p(
            "Your knowledge base, settings, and chat history are kept safe for 15 days after the trial "
            "ends, nothing is lost if you decide later."
        )
        + button("Pick a plan", f"{APP_URL}/billing")
        + p(f"Questions about pricing? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    try:
        send_email_async(
            to_email,
            subject,
            shell(
                subject=subject,
                preheader=f"{days_remaining} day{'s' if days_remaining != 1 else ''} left in your trial.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("trial_days_left_email_failed for %s (days=%s): %s", redact_email(to_email), days_remaining, exc)
        _capture_email_failure(exc, event="trial_days_left", email=to_email, days_remaining=days_remaining)


def send_promo_precharge_reminder_email(
    to_email: str,
    *,
    name: str | None,
    plan_name: str,
    charge_date: str,
    amount_display: str,
) -> None:
    """Fired ~10 days before a launch-promo free period ends, so the customer's
    first real charge is never a surprise (chargeback prevention)."""
    safe_plan = esc(plan_name)
    subject = f"Your free months on {BRAND_NAME} end soon"
    inner = (
        h1(f"Hi {_first_name(name)}. Your free {safe_plan} period ends on {esc(charge_date)}")
        + p(
            f"You&rsquo;ve been on {strong(safe_plan)} free of charge. On {strong(esc(charge_date))} your "
            f"first payment of {strong(esc(amount_display))} will be collected from the card or UPI on file, "
            f"and your plan continues without a gap."
        )
        + p("Nothing to do to keep going. If you&rsquo;d like to change or cancel, you can do it anytime before then.")
        + button("Manage your plan", f"{APP_URL}/billing")
        + p(f"Questions? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    try:
        send_email_async(
            to_email,
            subject,
            shell(subject=subject, preheader=f"Your first charge is on {charge_date}.", inner=inner),
        )
    except Exception as exc:
        logger.warning("promo_precharge_email_failed for %s: %s", redact_email(to_email), exc)
        _capture_email_failure(exc, event="promo_precharge", email=to_email)


def send_trial_ended_email(to_email: str, *, name: str | None, plan_name: str, data_retention_until) -> None:
    """Fired the moment the expiry cron flips status to trial_expired."""
    safe_plan = esc(plan_name)
    retention_human = data_retention_until.strftime("%B %-d, %Y")
    inner = (
        h1("Your trial has ended")
        + p(
            f"Hi {_first_name(name)}. Your trial of {strong(safe_plan)} wrapped up today. Your bot is now "
            f"showing its offline message to visitors. Pick a plan and it&rsquo;s back online within a minute."
        )
        + ed.alert(
            f"Your knowledge base, settings, and chat history are kept safe until "
            f"{strong(esc(retention_human))}. After that date, the workspace is permanently deleted.",
            "warning",
        )
        + button("Choose a plan to reactivate", f"{APP_URL}/billing")
        + p(f"Trial didn&rsquo;t fit? We&rsquo;d love quick feedback - {_SUPPORT_LINK}.", top=8)
    )
    try:
        send_email_async(
            to_email,
            f"Your {BRAND_NAME} trial has ended. Pick a plan to keep your bot live",
            shell(
                subject=f"Your {BRAND_NAME} trial has ended. Pick a plan to keep your bot live",
                preheader=f"Reactivate by {retention_human} to keep your bot and data.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("trial_ended_email_failed for %s: %s", redact_email(to_email), exc)
        _capture_email_failure(exc, event="trial_ended", email=to_email)


def send_trial_data_deleted_email(to_email: str, *, name: str | None) -> None:
    """Sent after the hard-delete cron purges the workspace."""
    inner = (
        h1("Your workspace has been deleted")
        + p(
            f"Hi {_first_name(name)}, as scheduled, we&rsquo;ve permanently deleted the bots, documents, "
            f"and chat history from your trial workspace. Nothing is recoverable from this account."
        )
        + p(f"If you ever want to give {esc(BRAND_NAME)} another look, you can start fresh any time, no hard feelings.")
        + p(f"Questions? Reply to this email or write to {_SUPPORT_LINK}.")
    )
    try:
        send_email_async(
            to_email,
            f"Your {BRAND_NAME} workspace has been deleted",
            shell(
                subject=f"Your {BRAND_NAME} workspace has been deleted",
                preheader="Your trial workspace has been permanently deleted.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("trial_data_deleted_email_failed for %s: %s", redact_email(to_email), exc)
        _capture_email_failure(exc, event="trial_data_deleted", email=to_email)


# ── Billing emails ───────────────────────────────────────────────────────────


def send_downgrade_reauth_email(
    to_email: str, *, name: str | None, old_plan_name: str, new_plan_name: str, reauth_url: str
) -> None:
    """Tell the customer their scheduled downgrade cutover needs a new mandate."""
    safe_old, safe_new = esc(old_plan_name), esc(new_plan_name)
    inner = (
        h1(f"One step to finish your switch to {safe_new}")
        + p(
            f"Hi {_first_name(name)}. Your billing cycle on {strong(safe_old)} has ended and your scheduled "
            f"move to {strong(safe_new)} is ready. Because your payments run on a UPI mandate, we can&rsquo;t "
            f"change the plan on the existing mandate. You&rsquo;ll need to authorize a new one for the lower plan."
        )
        + ed.alert(
            "It takes under a minute. Until you confirm, your account stays paused on the new plan. "
            "please complete it soon to keep your bot live.",
            "warning",
        )
        + button(f"Authorize {safe_new}", reauth_url)
        + p(f"Changed your mind, or need a hand? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    try:
        send_email_async(
            to_email,
            f"Action needed: confirm your switch to {new_plan_name}",
            shell(
                subject=f"Action needed: confirm your switch to {new_plan_name}",
                preheader=f"Authorize your new {new_plan_name} mandate to keep your bot live.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("downgrade_reauth_email_failed for %s: %s", redact_email(to_email), exc)
        _capture_email_failure(exc, event="downgrade_reauth", email=to_email)


def send_seat_reauth_email(to_email: str, *, name: str | None, seat_count: int, reauth_url: str) -> None:
    """Tell the customer their operator seats need a fresh mandate after a plan
    change (finding A follow-up).

    A plan cutover cancels the old seat add-on mandate and mints a new one, which
    (like the plan itself) must be re-authorized before it charges (and before
    the seats are re-entitled). This emails the hosted re-auth link so carried
    seats aren't silently suspended with no path back.
    """
    seats = f"{seat_count} extra seat{'s' if seat_count != 1 else ''}"
    inner = (
        h1("Re-authorize your operator seats")
        + p(
            f"Hi {_first_name(name)}. After your recent plan change, your {strong(seats)} moved to a new "
            f"payment mandate. Because seats bill on their own UPI mandate, you&rsquo;ll need to authorize it "
            f"once more so your team keeps its seats."
        )
        + ed.alert(
            "It takes under a minute. Until you confirm, the extra seats stay paused. Please complete it soon.",
            "warning",
        )
        + button("Authorize my seats", reauth_url)
        + p(f"Questions? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    try:
        send_email_async(
            to_email,
            "Action needed: re-authorize your operator seats",
            shell(
                subject="Action needed: re-authorize your operator seats",
                preheader="Authorize your seat mandate to keep your team's seats active.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("seat_reauth_email_failed for %s: %s", redact_email(to_email), exc)
        _capture_email_failure(exc, event="seat_reauth", email=to_email)


def send_invoice_email(to_email: str, invoice, pdf_url: str, pdf_bytes: bytes | None = None) -> None:
    """Send the customer their finalized invoice/receipt with the PDF attached."""
    from app.services.invoice_pdf import _fmt_money as _fmt_invoice_money

    doc_label = {"tax_invoice": "Tax invoice", "credit_note": "Credit note"}.get(invoice.invoice_type, "Receipt")
    is_credit_note = invoice.invoice_type == "credit_note"

    # Format in the document's OWN currency. This used to hardcode rupees, so a
    # $9 export was announced to the customer as "₹9.00", a figure that matches
    # neither the attached PDF nor their card statement.
    def money(minor: int | None) -> str:
        return _fmt_invoice_money(minor, invoice.currency)

    amount = money(invoice.amount_cents)
    seller_raw = (invoice.seller_snapshot or {}).get("legal_name") or EMAIL_FROM_NAME
    seller_name = esc(seller_raw)  # for HTML body

    rows = [(f"{doc_label} no.", esc(invoice.invoice_number))]
    if invoice.total_tax_minor:
        rows.append(
            (
                "GST reversed" if is_credit_note else "GST included",
                money(invoice.total_tax_minor),
            )
        )

    lead = (
        f"Your refund has been processed. The credit note from {strong(seller_name)} is ready."
        if is_credit_note
        else f"Thank you for your payment. Your {doc_label.lower()} from {strong(seller_name)} is ready. "
        f"the PDF is attached to this email."
    )
    hero = (
        f'<p class="oc-muted" style="margin:0 0 4px 0;font-family:{ed.FONT};font-size:12px;font-weight:600;'
        f'letter-spacing:0.06em;text-transform:uppercase;color:{ed.INK400};">'
        f"{'Refund amount' if is_credit_note else 'Amount paid'}</p>"
        f'<p class="oc-h" style="margin:0 0 20px 0;font-family:{ed.FONT};font-size:34px;font-weight:700;'
        f'color:{ed.INK900};letter-spacing:-0.6px;">{amount}</p>'
    )
    inner = (
        h1(f"Your {doc_label.lower()} is ready")
        + p(lead)
        + hero
        + info_table(rows, right=True)
        + button(f"Download {doc_label}", pdf_url)
        + p("A copy is attached as a PDF. The download link stays valid for 30 days.", top=8)
    )

    attachments: list[dict] | None = None
    if pdf_bytes:
        # Invoice numbers contain slashes (e.g. "DB/26-27/000001"). Flatten to a safe filename.
        safe_number = str(invoice.invoice_number or invoice.id).replace("/", "-")
        attachments = [{"content": base64.b64encode(pdf_bytes).decode("ascii"), "name": f"{safe_number}.pdf"}]

    send_email_async(
        to_email,
        f"{doc_label} {invoice.invoice_number} from {seller_raw}",
        shell(
            subject=f"{doc_label} {invoice.invoice_number} from {seller_raw}",
            preheader=f"{doc_label} {invoice.invoice_number} - {amount}",
            inner=inner,
        ),
        attachments=attachments,
    )


# ── Dunning (failed recurring payment) ───────────────────────────────────────
#
# Razorpay sends its own subscription notifications and hosts the card-update
# page. These emails deliberately do NOT duplicate the payment mechanics.
# They add what Razorpay structurally cannot know: that the customer's AI
# agents stop responding when OyeChats' grace window elapses.


def _stop_phrase(days: int) -> str:
    """Human deadline: ``today`` / ``in 1 day`` / ``in N days``.

    Floors at zero on purpose. ``days_left`` is computed as
    ``max(0, GRACE_DAYS - elapsed)`` (subscription_routes) and ``elapsed`` is
    ``.days``-truncated, so a late cron tick reaches 0 easily. "Your AI agents
    stop in 0 days" reads as a rendering bug in the one email that most needs
    to look credible.
    """
    if days <= 0:
        return "today"
    return "in 1 day" if days == 1 else f"in {days} days"


def _keep_working_phrase(days: int) -> str:
    """Reassurance side of the same deadline, with the same zero floor."""
    if days <= 0:
        return "Your AI agents stop responding to visitors today"
    unit = "day" if days == 1 else "days"
    return f"Your AI agents keep working for another {days} {unit}"


def _send_dunning(to_email: str, subject: str, preheader: str, inner: str, *, event: str, **tags) -> bool:
    """Shared send + failure handling for the dunning family.

    Returns ``True`` when the send was handed off (ARQ enqueue, or thread
    dispatch when ``WORKER_ENABLED=false``), ``False`` when the hand-off itself
    failed. Never raises: a Brevo outage must not break the cron loop and
    starve every other customer's email.

    The CALLER must write the cadence marker only on ``True``. ``due_email``
    fires on the exact day bucket only, so a marker written after a failed
    hand-off drops that email permanently, and day 3 is the one that carries
    the recovery link.

    "Handed off" is the honest boundary: past the enqueue, delivery failures
    are retried by ``task_send_email`` (3 tries with backoff) and are not
    observable from here.
    """
    try:
        send_email_async(
            to_email,
            subject,
            shell(subject=subject, preheader=preheader, inner=inner),
        )
    except Exception as exc:
        logger.warning("%s_email_failed for %s: %s", event, redact_email(to_email), exc)
        _capture_email_failure(exc, event=event, email=to_email, **tags)
        return False
    return True


def send_payment_failed_email(to_email: str, *, name: str | None, plan_name: str, amount: str) -> bool:
    """Day 0: the charge failed and Razorpay will retry automatically.

    Deliberately calm and asks for NOTHING. At this point the subscription is
    ``pending`` and Razorpay retries roughly daily for ~3 days; most of these
    succeed on their own. An alarming email here creates support load for a
    problem that usually self-resolves, and needs no recovery link, which also
    spares a gateway call per past-due customer per cron pass.
    """
    safe_plan = esc(plan_name)
    safe_amount = esc(amount)
    inner = (
        h1("We couldn&rsquo;t process your payment")
        + p(
            f"Hi {_first_name(name)} &mdash; the {strong(safe_amount)} charge for your "
            f"{strong(safe_plan)} plan didn&rsquo;t go through. This is usually a temporary "
            f"bank decline."
        )
        + ed.alert(
            "We&rsquo;ll retry automatically over the next few days. You don&rsquo;t need to do anything yet.",
            "info",
        )
        + p("If it keeps failing we&rsquo;ll email you a secure link to update your payment method.", top=8)
        + p(f"Questions? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    return _send_dunning(
        to_email,
        "We couldn't process your payment (we'll retry",
        "No action needed yet) we'll retry the charge automatically.",
        inner,
        event="payment_failed",
    )


def send_payment_action_required_email(
    to_email: str, *, name: str | None, plan_name: str, amount: str, recovery_url: str, days_left: int
) -> bool:
    """Day 3: retries are exhausted. Nothing happens without the customer."""
    safe_plan = esc(plan_name)
    safe_amount = esc(amount)
    inner = (
        h1("Action needed: update your payment method")
        + p(
            f"Hi {_first_name(name)} &mdash; we&rsquo;ve tried the {strong(safe_amount)} charge for your "
            f"{strong(safe_plan)} plan several times and it hasn&rsquo;t gone through."
        )
        + ed.alert(
            f"{_keep_working_phrase(days_left)}. After that they&rsquo;ll stop responding to visitors "
            f"until payment is restored.",
            "warning",
        )
        + p("Use the secure link below to retry your card, use a different one, or switch to UPI.")
        + button("Update payment method", recovery_url)
        + p(f"Questions? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    return _send_dunning(
        to_email,
        "Action needed: update your payment method",
        f"Your agents stop {_stop_phrase(days_left)} unless payment is restored.",
        inner,
        event="payment_action_required",
        days_left=days_left,
    )


def send_payment_final_warning_email(
    to_email: str, *, name: str | None, plan_name: str, recovery_url: str, days_left: int
) -> bool:
    """Day 5: the deadline is the message."""
    safe_plan = esc(plan_name)
    phrase = _stop_phrase(days_left)
    subject = f"Your AI agents stop {phrase}"
    inner = (
        h1(f"Your AI agents stop {phrase}")
        + p(
            f"Hi {_first_name(name)} &mdash; your {strong(safe_plan)} payment is still outstanding. "
            f"{strong(phrase.capitalize())} your agents will stop responding to visitors "
            f"and your chat widget will go into offline mode."
        )
        + ed.alert("This takes under a minute to fix and everything resumes immediately.", "warning")
        + button("Restore my subscription", recovery_url)
        + p(f"Need help? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    return _send_dunning(
        to_email,
        subject,
        "One click restores your subscription and brings your agents back.",
        inner,
        event="payment_final_warning",
        days_left=days_left,
    )


def send_subscription_suspended_email(
    to_email: str, *, name: str | None, plan_name: str, recovery_url: str | None
) -> bool:
    """Grace elapsed. Still recoverable. Say so, and keep the door open.

    ``recovery_url`` is optional: the gateway may be unreachable, or the
    mandate may have reached a terminal state. Falling back to prose beats
    rendering a button that goes nowhere.
    """
    safe_plan = esc(plan_name)
    action = (
        button("Restore my subscription", recovery_url)
        if recovery_url
        else p("Visit Billing in your workspace to restart your plan.", top=8)
    )
    inner = (
        h1("Your subscription has been suspended")
        + p(
            f"Hi {_first_name(name)} &mdash; we weren&rsquo;t able to collect payment for your "
            f"{strong(safe_plan)} plan, so your agents have stopped responding to visitors."
        )
        + ed.alert("Your data, knowledge base and conversation history are all safe and untouched.", "info")
        + p("Restore payment and everything comes straight back.")
        + action
        + p(f"Need help? Reply to this email or write to {_SUPPORT_LINK}.", top=8)
    )
    return _send_dunning(
        to_email,
        "Your OyeChats subscription has been suspended",
        "Your data is safe. Restore payment to bring your agents back.",
        inner,
        event="subscription_suspended",
    )
