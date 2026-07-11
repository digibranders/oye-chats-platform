"""Email notification service using Brevo (formerly Sendinblue) transactional API.

Every email is rendered from the shared design system in ``email_design`` (monochrome +
single-indigo-accent, dark-mode hardened for Outlook). All 19 senders build raw HTML in
code and dispatch through ``send_email_async`` — there are no server-side Brevo saved
templates in the send path anymore, so the design lives in one place and the gallery
(``scripts/build_email_gallery``) renders these same functions.
"""

import asyncio
import base64
import contextlib
import json
import logging
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import (
    APP_URL,
    BRAND_NAME,
    BREVO_API_KEY,
    EMAIL_ENABLED,
    EMAIL_FROM_ADDRESS,
    EMAIL_FROM_NAME,
    SUPPORT_EMAIL,
)
from app.services import email_design as ed
from app.services.email_design import button, code_box, esc, h1, info_table, link, p, shell, strong

logger = logging.getLogger(__name__)

BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"
BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account"

_SUPPORT_LINK = link(esc(SUPPORT_EMAIL), f"mailto:{SUPPORT_EMAIL}")


def _capture_email_failure(exc: Exception, **tags) -> None:
    """Capture an email-send failure to Sentry (if configured) with tags.

    Fire-and-forget daemon threads otherwise lose these exceptions entirely
    — logger.error is not enough because no one reads app logs proactively.
    """
    with contextlib.suppress(Exception):
        import sentry_sdk

        with sentry_sdk.push_scope() as scope:
            for key, value in tags.items():
                scope.set_tag(f"email.{key}", str(value))
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
# send path no longer uses saved templates — every email renders in code — but
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
        logger.warning("Email skipped — EMAIL_ENABLED=False (no BREVO_API_KEY) | to=%s subject=%s", to_email, subject)
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

    Legacy transport. The current send path renders HTML in code and does not call this;
    it is kept for the worker's ``task_send_template_email`` and any external callers.
    """
    if not EMAIL_ENABLED:
        logger.warning(
            "Email skipped — EMAIL_ENABLED=False (no BREVO_API_KEY) | to=%s template_id=%s", to_email, template_id
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
            logger.info(f"Template email sent to {to_email} | template_id={template_id} | status={resp.status}")
            return True
    except Exception as e:
        reason = _extract_brevo_error(e)
        logger.warning("Brevo template email failed | to=%s template_id=%s reason=%s", to_email, template_id, reason)
        _capture_email_failure(e, kind="template", to=to_email, template_id=template_id, reason=reason)
        return False


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
        _send_brevo_email(
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
    tier_upper = (tier or "sql").upper()
    tier_label = {"MQL": "Marketing Qualified Lead", "SQL": "Sales Qualified Lead"}.get(
        tier_upper, f"{tier_upper} Lead"
    )
    chip_kind = "success" if tier_upper == "SQL" else "warning"
    safe_bot = esc(bot_name)
    contact = contact or {}

    inner = (
        h1("New qualified lead")
        + p(
            f"A visitor on {strong(safe_bot)} has reached {esc(tier_label)} status. They match your "
            f"qualification criteria. &nbsp;{ed.chip(tier_upper, chip_kind)}"
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
        subject=f"New {tier_upper} lead from {bot_name}",
        preheader=f"New {tier_upper} lead from {bot_name}.",
        inner=inner,
    )
    send_email_async(
        notification_email,
        f"New {tier_upper} lead from {bot_name}",
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
            f"A visitor on {strong(safe_bot)} is requesting to speak with a live team member. "
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
            f"{strong('No agent was available')} when a visitor on {strong(safe_bot)} requested live support. "
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
        preheader=f"A visitor requested support on {bot_name} while no agent was available.",
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
        + p(f"A visitor on {strong(safe_bot)} left a message while no agent was available.")
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
        preheader=f"New message from {visitor_name} on {bot_name} — reply when you're back.",
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
            f"This code expires in {strong('15 minutes')}. Never share it — "
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
            preheader="Your password reset code — expires in 15 minutes.",
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
            preheader="Your verification code — expires in 15 minutes.",
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
            f"email — your account email won&rsquo;t change."
        )
    )
    send_email_async(
        to_email,
        f"Confirm your new {BRAND_NAME} email address",
        shell(
            subject=f"Confirm your new {BRAND_NAME} email address",
            preheader="Confirm your new email address — code expires in 15 minutes.",
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
            "The change only takes effect once that address confirms a verification code — this "
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
    role_labels = {"user": "You", "bot": safe_bot, "operator": "Support Agent", "system": "System"}
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
        f"Chat Transcript — {bot_name}",
        shell(
            subject=f"Chat Transcript — {bot_name}",
            preheader=f"Your conversation with {bot_name} — full transcript.",
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
        + ed.alert("Message received — no action needed on your end. We&rsquo;ll be in touch by email.", "success")
        + p("You can reply directly to this email if you have anything to add.")
    )
    send_email_async(
        to_email,
        f"Thank you for contacting {company_name or BRAND_NAME}",
        shell(
            subject=f"Thank you for contacting {company_name or BRAND_NAME}",
            preheader=f"Thanks {visitor_name or 'there'} — your message was received.",
            inner=inner,
            visitor=True,
        ),
        reply_to=reply_to,
        sender_name=_branded_sender_name(company_name or BRAND_NAME),
    )


# ── Affiliate emails ─────────────────────────────────────────────────────────


def send_affiliate_welcome_email(to_email: str, name: str | None = None) -> None:
    """Email an existing customer that they're now an affiliate."""
    inner = (
        h1(f"You&rsquo;re now an {esc(BRAND_NAME)} affiliate")
        + p(
            f"Hi {_first_name(name)} — you&rsquo;ve just been enrolled in the {esc(BRAND_NAME)} affiliate "
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
            f"customer they bring to the platform. We&rsquo;d like you to join."
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
            "Didn&rsquo;t expect this? You can safely ignore it — the invite will expire and no account will be created."
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


# ── Trial lifecycle emails ───────────────────────────────────────────────────


def send_trial_welcome_email(to_email: str, *, name: str | None, trial_end, credits: int, duration_days: int) -> None:
    """Day-0 welcome email fired the moment a customer lands on the trial."""
    end_human = trial_end.strftime("%B %-d, %Y")
    inner = (
        h1(f"Welcome to {esc(BRAND_NAME)}, {_first_name(name)}")
        + p(
            f"Your {strong(f'{duration_days}-day free trial')} is live. You&rsquo;ve got "
            f"{strong(f'{credits:,} credits')} to spend however you like — chats, URL crawls, document "
            f"uploads. Your trial runs until {strong(esc(end_human))}. No card on file, no auto-charge."
        )
        + button("Open my dashboard", APP_URL)
        + ed.divider()
        + ed.section_label("A 3-step path to your first chat")
        + ed.steps(
            [
                f"{link('Upload your knowledge base', APP_URL + '/knowledge')} — PDFs, docs, or paste your website URL and we crawl it.",
                f"{link('Style the widget', APP_URL + '/chatbot')} — colors, logo, welcome message.",
                f"{link('Drop the script tag', APP_URL + '/chatbot')} on your site — one line of HTML and you&rsquo;re live.",
            ]
        )
        + p(f"Stuck on something? Just reply to this email or write to {_SUPPORT_LINK}.")
    )
    try:
        send_email_async(
            to_email,
            f"Welcome to {BRAND_NAME} — your {duration_days}-day trial is live",
            shell(
                subject=f"Welcome to {BRAND_NAME} — your {duration_days}-day trial is live",
                preheader=f"You've got {credits:,} credits and {duration_days} days to build your bot.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("trial_welcome_email_failed for %s: %s", _redact(to_email), exc)
        _capture_email_failure(exc, event="trial_welcome", email=to_email)


def send_trial_day_7_email(to_email: str, *, name: str | None, days_remaining: int, plan_name: str) -> None:
    """Halfway-through nudge."""
    inner = (
        h1(f"You&rsquo;re halfway through your trial, {_first_name(name)}")
        + p(
            f"Quick check-in — you&rsquo;ve got {strong(f'{days_remaining} days left')}. If your bot is live "
            f"and answering visitors, you&rsquo;re ahead of the curve. If you haven&rsquo;t uploaded knowledge "
            f"or dropped the script tag yet, this is the week to do it."
        )
        + button("Open my dashboard", APP_URL)
        + p(
            f"Already sold? {link('Pick a plan', APP_URL + '/billing')} any time — conversion preserves your "
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
                preheader=f"Halfway through your trial — {days_remaining} days left.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("trial_day_7_email_failed for %s: %s", _redact(to_email), exc)
        _capture_email_failure(exc, event="trial_day_7", email=to_email)


def send_trial_days_left_email(to_email: str, *, name: str | None, days_remaining: int, plan_name: str) -> None:
    """Urgency reminder fired at day-11 (3 left) and day-13 (1 left)."""
    safe_plan = esc(plan_name)
    if days_remaining <= 1:
        headline = f"your {safe_plan} trial ends tomorrow"
        lead = (
            f"Heads up — your trial wraps up in about {strong(f'{days_remaining} day')}. After that your "
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
        h1(f"Hi {_first_name(name)} — {headline}")
        + p(lead)
        + p(
            "Your knowledge base, settings, and chat history are kept safe for 15 days after the trial "
            "ends — nothing is lost if you decide later."
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
        logger.warning("trial_days_left_email_failed for %s (days=%s): %s", _redact(to_email), days_remaining, exc)
        _capture_email_failure(exc, event="trial_days_left", email=to_email, days_remaining=days_remaining)


def send_trial_ended_email(to_email: str, *, name: str | None, plan_name: str, data_retention_until) -> None:
    """Fired the moment the expiry cron flips status to trial_expired."""
    safe_plan = esc(plan_name)
    retention_human = data_retention_until.strftime("%B %-d, %Y")
    inner = (
        h1("Your trial has ended")
        + p(
            f"Hi {_first_name(name)} — your trial of {strong(safe_plan)} wrapped up today. Your bot is now "
            f"showing its offline message to visitors. Pick a plan and it&rsquo;s back online within a minute."
        )
        + ed.alert(
            f"Your knowledge base, settings, and chat history are kept safe until "
            f"{strong(esc(retention_human))}. After that date, the workspace is permanently deleted.",
            "warning",
        )
        + button("Choose a plan to reactivate", f"{APP_URL}/billing")
        + p(f"Trial didn&rsquo;t fit? We&rsquo;d love quick feedback — {_SUPPORT_LINK}.", top=8)
    )
    try:
        send_email_async(
            to_email,
            f"Your {BRAND_NAME} trial has ended — pick a plan to keep your bot live",
            shell(
                subject=f"Your {BRAND_NAME} trial has ended — pick a plan to keep your bot live",
                preheader=f"Reactivate by {retention_human} to keep your bot and data.",
                inner=inner,
            ),
        )
    except Exception as exc:
        logger.warning("trial_ended_email_failed for %s: %s", _redact(to_email), exc)
        _capture_email_failure(exc, event="trial_ended", email=to_email)


def send_trial_data_deleted_email(to_email: str, *, name: str | None) -> None:
    """Sent after the hard-delete cron purges the workspace."""
    inner = (
        h1("Your workspace has been deleted")
        + p(
            f"Hi {_first_name(name)} — as scheduled, we&rsquo;ve permanently deleted the bots, documents, "
            f"and chat history from your trial workspace. Nothing is recoverable from this account."
        )
        + p(
            f"If you ever want to give {esc(BRAND_NAME)} another look, you can start fresh any time — no hard feelings."
        )
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
        logger.warning("trial_data_deleted_email_failed for %s: %s", _redact(to_email), exc)
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
            f"Hi {_first_name(name)} — your billing cycle on {strong(safe_old)} has ended and your scheduled "
            f"move to {strong(safe_new)} is ready. Because your payments run on a UPI mandate, we can&rsquo;t "
            f"change the plan on the existing mandate — you&rsquo;ll need to authorize a new one for the lower plan."
        )
        + ed.alert(
            "It takes under a minute. Until you confirm, your account stays paused on the new plan — "
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
        logger.warning("downgrade_reauth_email_failed for %s: %s", _redact(to_email), exc)
        _capture_email_failure(exc, event="downgrade_reauth", email=to_email)


def send_seat_reauth_email(to_email: str, *, name: str | None, seat_count: int, reauth_url: str) -> None:
    """Tell the customer their operator seats need a fresh mandate after a plan
    change (finding A follow-up).

    A plan cutover cancels the old seat add-on mandate and mints a new one, which
    — like the plan itself — must be re-authorized before it charges (and before
    the seats are re-entitled). This emails the hosted re-auth link so carried
    seats aren't silently suspended with no path back.
    """
    seats = f"{seat_count} extra seat{'s' if seat_count != 1 else ''}"
    inner = (
        h1("Re-authorize your operator seats")
        + p(
            f"Hi {_first_name(name)} — after your recent plan change, your {strong(seats)} moved to a new "
            f"payment mandate. Because seats bill on their own UPI mandate, you&rsquo;ll need to authorize it "
            f"once more so your team keeps its seats."
        )
        + ed.alert(
            "It takes under a minute. Until you confirm, the extra seats stay paused — please complete it soon.",
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
        logger.warning("seat_reauth_email_failed for %s: %s", _redact(to_email), exc)
        _capture_email_failure(exc, event="seat_reauth", email=to_email)


def send_invoice_email(to_email: str, invoice, pdf_url: str, pdf_bytes: bytes | None = None) -> None:
    """Send the customer their finalized invoice/receipt with the PDF attached."""
    from app.services.invoice_pdf import _fmt_inr as _fmt_invoice_inr

    doc_label = {"tax_invoice": "Tax invoice", "credit_note": "Credit note"}.get(invoice.invoice_type, "Receipt")
    is_credit_note = invoice.invoice_type == "credit_note"
    amount = _fmt_invoice_inr(invoice.amount_cents)
    seller_raw = (invoice.seller_snapshot or {}).get("legal_name") or EMAIL_FROM_NAME
    seller_name = esc(seller_raw)  # for HTML body

    rows = [(f"{doc_label} no.", esc(invoice.invoice_number))]
    if invoice.total_tax_minor:
        rows.append(
            (
                "GST reversed" if is_credit_note else "GST included",
                _fmt_invoice_inr(invoice.total_tax_minor),
            )
        )

    lead = (
        f"Your refund has been processed. The credit note from {strong(seller_name)} is ready."
        if is_credit_note
        else f"Thank you for your payment. Your {doc_label.lower()} from {strong(seller_name)} is ready — "
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
        # Invoice numbers contain slashes (e.g. "DB/26-27/000001") — flatten to a safe filename.
        safe_number = str(invoice.invoice_number or invoice.id).replace("/", "-")
        attachments = [{"content": base64.b64encode(pdf_bytes).decode("ascii"), "name": f"{safe_number}.pdf"}]

    send_email_async(
        to_email,
        f"{doc_label} {invoice.invoice_number} from {seller_raw}",
        shell(
            subject=f"{doc_label} {invoice.invoice_number} from {seller_raw}",
            preheader=f"{doc_label} {invoice.invoice_number} — {amount}",
            inner=inner,
        ),
        attachments=attachments,
    )


def _redact(to_email: str) -> str:
    local, _, domain = to_email.partition("@")
    return f"{local[:1]}***@{domain}" if local and domain else "***"
