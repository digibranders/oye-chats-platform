"""Render every transactional email template — both visual previews and Brevo-paste-ready files.

Outputs:
    platform/api/emails/01_password_reset.html             (visual preview, sample data)
    platform/api/emails/02_qualified_lead.html
    platform/api/emails/03_handoff_request.html
    platform/api/emails/04_missed_callback.html
    platform/api/emails/05_offline_message.html
    platform/api/emails/06_chat_transcript.html
    platform/api/emails/07_visitor_confirmation.html

    platform/api/emails/01_password_reset.brevo.html       (Brevo template, paste-ready)
    platform/api/emails/02_qualified_lead.brevo.html
    platform/api/emails/03_handoff_request.brevo.html
    platform/api/emails/04_missed_callback.brevo.html
    platform/api/emails/05_offline_message.brevo.html
    platform/api/emails/07_visitor_confirmation.brevo.html

    platform/api/emails/preview/index.html                 (iframe grid for visual QA)
    platform/api/emails/BREVO_UPLOAD.md                    (paste instructions)

The chat-transcript email (06) sends raw HTML at runtime via _base_template — it has
no Brevo template equivalent, so no .brevo.html flavor is generated.

Usage:
    cd platform/api && uv run python scripts/render_email_previews.py
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from app.config import APP_URL
from app.services.email_service import (
    _alert_box,
    _base_template,
    _body_text,
    _cta_button,
    _info_row,
    _info_table,
    _section_label,
    send_transcript_email,
)

EMAILS_DIR = Path(__file__).resolve().parent.parent / "emails"
PREVIEW_DIR = EMAILS_DIR / "preview"

# All CTA destinations are baked into the rendered HTML, so they need to match
# whatever environment the .brevo.html files will run against. APP_URL comes
# from app.config (env: APP_URL, default: https://app.oyechats.com).
DASHBOARD_URL = APP_URL

Mode = Literal["preview", "brevo"]


def P(field: str, sample: str, mode: Mode) -> str:
    """Pick a value: sample data for `preview`, Brevo `{{ params.field }}` for `brevo`."""
    return sample if mode == "preview" else f"{{{{ params.{field} }}}}"


# ── 01 · Password reset ───────────────────────────────────────────────────────


def render_password_reset(mode: Mode = "preview") -> str:
    otp = P("otp", "428193", mode)
    otp_box = (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        'style="margin:8px 0 18px 0;">'
        '<tr><td align="center" style="background-color:#f5f6ff;border:1px solid #e0e2f5;'
        'border-radius:14px;padding:22px 16px;">'
        "<p style=\"margin:0 0 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
        "Roboto,Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.16em;"
        'text-transform:uppercase;color:#6b7280;">Verification code</p>'
        "<p style=\"margin:0;font-family:'SF Mono','Menlo','Consolas',monospace;"
        f'font-size:34px;font-weight:800;color:#0f0f1a;letter-spacing:0.32em;">{otp}</p>'
        "</td></tr>"
        "</table>"
    )

    content = (
        _body_text(
            "You requested a password reset for your OyeChats account. "
            "Enter the verification code below to choose a new password."
        )
        + otp_box
        + _alert_box(
            "This code expires in <strong>15 minutes</strong>. "
            "If you didn&rsquo;t request this, you can safely ignore this email.",
            bg="#fffbeb",
            border_color="#fcd34d",
            text_color="#854d0e",
        )
        + _body_text(
            "For your security, never share this code with anyone &mdash; OyeChats staff will never ask for it."
        )
    )

    return _base_template(
        "Reset your password",
        content,
        preheader=f"Your OyeChats verification code: {otp}",
        accent_color="#4f46e5",
        accent_bg="#eef2ff",
        accent_border="#a5b4fc",
        accent_icon="\U0001f512",  # 🔒
        category="Security Alert",
        overline="Action Required",
    )


# ── 02 · Qualified lead ───────────────────────────────────────────────────────


def render_qualified_lead(mode: Mode = "preview") -> str:
    bot_name = P("bot_name", "Acme Support Bot", mode)
    tier = P("tier", "SQL", mode)
    tier_label = P("tier_label", "Sales Qualified Lead", mode)
    badge_bg = P("badge_bg", "#dcfce7", mode)
    badge_color = P("badge_color", "#166534", mode)
    accent_color = P("accent_color", "#10b981", mode)
    accent_bg = P("accent_bg", "#ecfdf5", mode)
    accent_border = P("accent_border", "#6ee7b7", mode)

    bant_need = P("bant_need", "Wants bilingual chatbot for Spanish-speaking customers", mode)
    bant_budget = P("bant_budget", "$2,000&ndash;$5,000 / month confirmed", mode)
    bant_authority = P("bant_authority", "Director of Customer Experience", mode)
    bant_timeline = P("bant_timeline", "Wants to launch within 30 days", mode)

    contact_name = P("contact_name", "Carlos Rivera", mode)
    contact_email = P("contact_email", "carlos@rivtech.mx", mode)
    contact_phone = P("contact_phone", "+52 55 1234 5678", mode)
    contact_company = P("contact_company", "Riv Technologies", mode)

    badge_html = (
        f'<span style="display:inline-block;background-color:{badge_bg};color:{badge_color};'
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
        "font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;"
        "padding:4px 10px;border-radius:100px;border:1px solid #86efac;margin-left:8px;"
        f'vertical-align:middle;">{tier}</span>'
    )
    intro = _body_text(
        f'A visitor on <strong style="color:#0f0f1a;">{bot_name}</strong> '
        f"has reached <strong>{tier_label}</strong> status. "
        f"They match your qualification criteria across all four BANT dimensions.{badge_html}"
    )

    bant_table = _section_label("Qualification (BANT)") + _info_table(
        [
            _info_row("Need", bant_need),
            _info_row("Budget", bant_budget),
            _info_row("Authority", bant_authority),
            _info_row("Timeline", bant_timeline),
        ],
        bg="#ecfdf5",
        border_color="#a7f3d0",
    )

    contact_table = _section_label("Contact details") + _info_table(
        [
            _info_row("Name", contact_name),
            _info_row(
                "Email",
                f'<a href="mailto:{contact_email}" style="color:#0f0f1a;text-decoration:underline;">{contact_email}</a>',
            ),
            _info_row("Phone", contact_phone),
            _info_row("Company", contact_company),
        ],
        bg="#f3f4f6",
        border_color="#e5e7eb",
    )

    content = (
        intro
        + bant_table
        + contact_table
        + _cta_button("View lead in dashboard", f"{DASHBOARD_URL}/leads", color=accent_color)
    )

    return _base_template(
        "Hot lead captured",
        content,
        preheader=f"New {tier} lead from {bot_name} — {contact_name} at {contact_company}",
        accent_color=accent_color,
        accent_bg=accent_bg,
        accent_border=accent_border,
        accent_icon="\U0001f3af",  # 🎯
        category="Sales Intelligence",
        overline="New Qualified Lead",
    )


# ── 03 · Handoff request ──────────────────────────────────────────────────────


def render_handoff_request(mode: Mode = "preview") -> str:
    bot_name = P("bot_name", "Acme Support Bot", mode)
    contact_name = P("contact_name", "Priya Mehta", mode)
    contact_email = P("contact_email", "priya.m@brightwave.io", mode)
    reason = P("reason", "Question about enterprise pricing and SSO", mode)
    accent = "#f59e0b"

    intro = _body_text(
        f'A visitor on <strong style="color:#0f0f1a;">{bot_name}</strong> '
        f"is requesting to speak with a live team member. They&rsquo;re waiting "
        f"in the queue right now."
    )

    visitor_table = _section_label("Visitor") + _info_table(
        [
            _info_row("Name", contact_name),
            _info_row(
                "Email",
                f'<a href="mailto:{contact_email}" style="color:#0f0f1a;text-decoration:underline;">{contact_email}</a>',
            ),
            _info_row("Reason", reason),
        ],
        bg="#fffbeb",
        border_color="#fcd34d",
    )

    content = (
        intro
        + visitor_table
        + _alert_box(
            "Visitors typically wait less than 60 seconds before abandoning a "
            "live-chat queue. Please respond promptly.",
            bg="#fff7ed",
            border_color="#fdba74",
            text_color="#9a3412",
        )
        + _cta_button("Accept request", f"{DASHBOARD_URL}/support", color=accent)
    )

    return _base_template(
        "Live chat request",
        content,
        preheader=f"{contact_name} is waiting to chat on {bot_name}",
        accent_color=accent,
        accent_bg="#fffbeb",
        accent_border="#fcd34d",
        accent_icon="\U0001f3a7",  # 🎧
        category="Support Request",
        overline="Live Chat Requested",
    )


# ── 04 · Missed callback ──────────────────────────────────────────────────────


def render_missed_callback(mode: Mode = "preview") -> str:
    bot_name = P("bot_name", "Acme Support Bot", mode)
    contact_name = P("contact_name", "Daniel Okafor", mode)
    contact_email = P("contact_email", "daniel.o@northbeam.co", mode)
    contact_phone = P("contact_phone", "+1 (415) 555&ndash;0142", mode)
    accent = "#ef4444"

    intro = _body_text(
        f"<strong>No agent was available</strong> when a visitor on "
        f'<strong style="color:#0f0f1a;">{bot_name}</strong> requested live '
        f"support. They left their contact details so you can follow up."
    )

    contact_table = _section_label("Visitor") + _info_table(
        [
            _info_row("Name", contact_name),
            _info_row(
                "Email",
                f'<a href="mailto:{contact_email}" style="color:#0f0f1a;text-decoration:underline;">{contact_email}</a>',
            ),
            _info_row("Phone", contact_phone),
        ],
        bg="#fef2f2",
        border_color="#fecaca",
    )

    content = (
        intro
        + _alert_box(
            "Reach out within the next hour for the best chance of converting "
            "this missed connection into a qualified conversation.",
            bg="#fef2f2",
            border_color="#fca5a5",
            text_color="#991b1b",
        )
        + contact_table
        + _cta_button("Follow up now", f"{DASHBOARD_URL}/leads", color=accent)
    )

    return _base_template(
        "Follow up with visitor",
        content,
        preheader=f"Missed live-chat request from {bot_name} — please follow up",
        accent_color=accent,
        accent_bg="#fef2f2",
        accent_border="#fca5a5",
        accent_icon="\U0001f4de",  # 📞
        category="Urgent Follow-Up",
        overline="Missed Chat Alert",
    )


# ── 05 · Offline message ──────────────────────────────────────────────────────


def render_offline_message(mode: Mode = "preview") -> str:
    bot_name = P("bot_name", "Fynix Digital", mode)
    visitor_name = P("visitor_name", "Curl Test", mode)
    visitor_email = P("visitor_email", "admin@digibranders.com", mode)
    message_preview = P(
        "message_preview",
        "Test from curl at 2026-04-29T06:16:16Z &mdash; verifying visitor confirmation email reaches inbox.",
        mode,
    )
    accent = "#0ea5e9"

    intro = _body_text(
        f'A visitor on <strong style="color:#0f0f1a;">{bot_name}</strong> left a message while no agent was available.'
    )

    sender_table = _section_label("From") + _info_table(
        [
            _info_row("Name", visitor_name),
            _info_row(
                "Email",
                f'<a href="mailto:{visitor_email}" style="color:#0f0f1a;text-decoration:underline;">{visitor_email}</a>',
            ),
        ],
        bg="#f0f9ff",
        border_color="#bae6fd",
    )

    message_quote = _section_label("Message") + (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        'style="margin-bottom:18px;">'
        '<tr><td style="background-color:#f0f9ff;border:1px solid #bae6fd;'
        f'border-left:4px solid {accent};border-radius:0 12px 12px 0;padding:18px 20px;">'
        "<p style=\"margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',"
        "Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#075985;line-height:1.7;"
        f'font-style:italic;white-space:pre-wrap;">{message_preview}</p>'
        "</td></tr>"
        "</table>"
    )

    content = (
        intro + sender_table + message_quote + _cta_button("View & reply", f"{DASHBOARD_URL}/support", color=accent)
    )

    return _base_template(
        "New offline message",
        content,
        preheader=f"New message from {visitor_name} on {bot_name} — reply when you're back",
        accent_color=accent,
        accent_bg="#f0f9ff",
        accent_border="#7dd3fc",
        accent_icon="\U0001f4e9",  # 📩
        category="New Message",
        overline="Offline Message",
    )


# ── 06 · Chat transcript ──────────────────────────────────────────────────────


def render_chat_transcript() -> str:
    """Render via the runtime helper by capturing the HTML before dispatch.

    No Brevo flavor — this email sends raw HTML at runtime (template #63 is a
    visual reference only; the bubble layout is too dynamic for Brevo params).
    """
    captured: dict[str, str] = {}

    def _capture(to_email, subject, html_body, **kwargs):  # noqa: ARG001
        captured["html"] = html_body

    from app.services import email_service

    original = email_service.send_email_async
    email_service.send_email_async = _capture
    try:
        send_transcript_email(
            to_email="visitor@example.com",
            bot_name="Acme Support Bot",
            messages=[
                {"role": "system", "content": "Chat started", "created_at": "2026-04-29T11:32:00Z"},
                {
                    "role": "user",
                    "content": "Hi! Do you support Spanish-language chatbots?",
                    "created_at": "2026-04-29T11:32:14Z",
                },
                {
                    "role": "bot",
                    "content": (
                        "Yes — OyeChats supports **multilingual** bots out of the box. "
                        "You can upload knowledge in any language and the bot will reply "
                        "in the visitor's language automatically."
                    ),
                    "created_at": "2026-04-29T11:32:16Z",
                },
                {
                    "role": "user",
                    "content": "Great. Can I see pricing for a team of 5 operators?",
                    "created_at": "2026-04-29T11:33:02Z",
                },
                {
                    "role": "operator",
                    "content": (
                        "Hi Carlos — this is Priya from Acme. Happy to walk you through "
                        "team pricing. Are you free for a 15-minute call this week?"
                    ),
                    "created_at": "2026-04-29T11:33:48Z",
                },
                {"role": "system", "content": "Chat ended", "created_at": "2026-04-29T11:36:12Z"},
            ],
        )
    finally:
        email_service.send_email_async = original

    return captured["html"]


# ── 07 · Visitor confirmation ─────────────────────────────────────────────────


def render_visitor_confirmation(mode: Mode = "preview") -> str:
    bot_name = P("bot_name", "Acme Support Bot", mode)
    visitor_name = P("visitor_name", "Carlos", mode)
    visitor_email = P("visitor_email", "carlos@rivtech.mx", mode)
    accent = "#10b981"

    intro = _body_text(f"Hi <strong>{visitor_name}</strong>,") + _body_text(
        f"Thanks for reaching out to "
        f'<strong style="color:#0f0f1a;">{bot_name}</strong>. '
        f"We&rsquo;ve received your message and our team has been notified. "
        f"Someone will get back to you shortly."
    )

    success_alert = _alert_box(
        "<strong>Message received successfully.</strong> No action needed on "
        "your end &mdash; we&rsquo;ll be in touch by email.",
        bg="#ecfdf5",
        border_color="#6ee7b7",
        text_color="#065f46",
    )

    reply_alert = _alert_box(
        f"We&rsquo;ll reply to <strong>{visitor_email}</strong>. "
        f"You can also reply to this email if you have anything to add.",
        bg="#eef2ff",
        border_color="#a5b4fc",
        text_color="#3730a3",
    )

    content = intro + success_alert + reply_alert

    return _base_template(
        "We got your message",
        content,
        preheader=f"Thanks {visitor_name} — your message to {bot_name} was received",
        accent_color=accent,
        accent_bg="#ecfdf5",
        accent_border="#6ee7b7",
        accent_icon="✅",
        category="Confirmation",
        overline="Message Received",
        visitor=True,
    )


# ── Index ─────────────────────────────────────────────────────────────────────


def render_index(rendered: list[tuple[str, str]]) -> str:
    """Render a preview index page with iframes side by side."""
    cards = []
    for filename, label in rendered:
        cards.append(
            f'<div class="card">'
            f'<div class="card-head">'
            f'<span class="dot"></span>'
            f"<h2>{label}</h2>"
            f'<a href="../{filename}" target="_blank" rel="noopener">Open &rarr;</a>'
            f"</div>"
            f'<iframe src="../{filename}" loading="lazy"></iframe>'
            f"</div>"
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OyeChats Email Previews</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 32px 24px 64px;
    background: #f3f4fb;
    font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    color: #0f0f1a;
  }}
  header {{ max-width: 1400px; margin: 0 auto 28px; }}
  header h1 {{ margin: 0 0 6px; font-size: 26px; letter-spacing: -0.4px; }}
  header p {{ margin: 0; color: #6b7280; font-size: 14px; }}
  .grid {{
    max-width: 1400px; margin: 0 auto;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 24px;
  }}
  .card {{
    background: #fff; border: 1px solid #e8e8f0; border-radius: 16px;
    overflow: hidden; box-shadow: 0 1px 2px rgba(15,15,26,0.04);
  }}
  .card-head {{
    display: flex; align-items: center; gap: 10px;
    padding: 14px 18px; border-bottom: 1px solid #e8e8f0;
  }}
  .card-head h2 {{ flex: 1; margin: 0; font-size: 14px; font-weight: 700; letter-spacing: -0.2px; }}
  .card-head a {{ font-size: 12px; color: #4f46e5; text-decoration: none; font-weight: 600; }}
  .card-head a:hover {{ text-decoration: underline; }}
  .dot {{ width: 8px; height: 8px; border-radius: 50%; background: #4f46e5; }}
  iframe {{
    width: 100%; height: 720px; border: 0; display: block;
    background: #f3f4fb;
  }}
</style>
</head>
<body>
<header>
  <h1>OyeChats &mdash; transactional email previews</h1>
  <p>Rendered from <code>app.services.email_service</code> with sample data. Brevo-paste-ready files are <code>NN_*.brevo.html</code>.</p>
</header>
<main class="grid">
{"".join(cards)}
</main>
</body>
</html>"""


def render_brevo_upload_md() -> str:
    """One-page paste guide — which file goes into which Brevo template ID."""
    return """# Brevo template upload guide

These six `*.brevo.html` files are paste-ready for the Brevo dashboard. Each one
uses `{{ params.x }}` placeholders that the backend (`api/app/services/email_service.py`)
already supplies at send time.

## How to upload

1. Sign in to Brevo &rarr; **Templates** &rarr; **Email Templates**
   (https://app.brevo.com/templates/listing).
2. For each row in the table below, open the existing template by ID, click
   **Edit design** &rarr; **Code** (HTML editor), select all, and paste the
   matching `*.brevo.html` file's contents.
3. **Save**. Use **Send a test** to send to `admin@digibranders.com` and
   spot-check the rendering.

## Template map

| ID | File | Purpose | Params used |
|----|------|---------|-------------|
| 57 | `01_password_reset.brevo.html` | Password reset OTP | `otp` |
| 60 | `02_qualified_lead.brevo.html` | Lead reaches BANT/MEDDIC tier | `bot_name`, `tier`, `tier_label`, `badge_bg`, `badge_color`, `accent_color`, `accent_bg`, `accent_border`, `bant_need`, `bant_budget`, `bant_authority`, `bant_timeline`, `contact_name`, `contact_email`, `contact_phone`, `contact_company` |
| 61 | `03_handoff_request.brevo.html` | Visitor requests live agent | `bot_name`, `contact_name`, `contact_email`, `reason` |
| 62 | `04_missed_callback.brevo.html` | Offline message + no agent | `bot_name`, `contact_name`, `contact_email`, `contact_phone` |
| 58 | `05_offline_message.brevo.html` | Offline message form submit | `bot_name`, `visitor_name`, `visitor_email`, `message_preview` |
| 59 | `07_visitor_confirmation.brevo.html` | Visitor self-confirmation | `bot_name`, `visitor_name`, `visitor_email` |

## Why no Brevo flavor for the chat transcript (06)?

`send_transcript_email` builds raw HTML at runtime via `_base_template` and sends
it through `_send_brevo_email` (not `_send_brevo_template`). Template #63 in
Brevo is a visual reference only and is not used for delivery. The
`06_chat_transcript.html` file in this directory is the visual canon for that
runtime path — re-run `scripts/render_email_previews.py` to refresh it whenever
the helpers change.

## Regenerating these files

```bash
cd platform/api
uv run python scripts/render_email_previews.py
```

Outputs both flavors plus `preview/index.html` for visual QA.
"""


# ── Driver ────────────────────────────────────────────────────────────────────


def main() -> None:
    EMAILS_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

    # (filename, label, html, supports_brevo_flavor)
    targets: list[tuple[str, str, str, bool]] = [
        ("01_password_reset.html", "01 · Password reset", render_password_reset("preview"), True),
        ("02_qualified_lead.html", "02 · Qualified lead (SQL)", render_qualified_lead("preview"), True),
        ("03_handoff_request.html", "03 · Handoff request", render_handoff_request("preview"), True),
        ("04_missed_callback.html", "04 · Missed callback", render_missed_callback("preview"), True),
        ("05_offline_message.html", "05 · Offline message", render_offline_message("preview"), True),
        ("06_chat_transcript.html", "06 · Chat transcript", render_chat_transcript(), False),
        ("07_visitor_confirmation.html", "07 · Visitor confirmation", render_visitor_confirmation("preview"), True),
    ]

    written_for_index: list[tuple[str, str]] = []
    print("Visual previews (sample data):")
    for filename, label, html, _has_brevo in targets:
        path = EMAILS_DIR / filename
        path.write_text(html, encoding="utf-8")
        size_kb = path.stat().st_size / 1024
        print(f"  wrote {filename:36s} ({size_kb:5.1f} KB)")
        written_for_index.append((filename, label))

    print()
    print("Brevo paste-ready (with {{ params.x }} placeholders):")
    brevo_renderers: list[tuple[str, callable]] = [
        ("01_password_reset.brevo.html", render_password_reset),
        ("02_qualified_lead.brevo.html", render_qualified_lead),
        ("03_handoff_request.brevo.html", render_handoff_request),
        ("04_missed_callback.brevo.html", render_missed_callback),
        ("05_offline_message.brevo.html", render_offline_message),
        ("07_visitor_confirmation.brevo.html", render_visitor_confirmation),
    ]
    for filename, renderer in brevo_renderers:
        path = EMAILS_DIR / filename
        path.write_text(renderer("brevo"), encoding="utf-8")
        size_kb = path.stat().st_size / 1024
        print(f"  wrote {filename:36s} ({size_kb:5.1f} KB)")

    index_path = PREVIEW_DIR / "index.html"
    index_path.write_text(render_index(written_for_index), encoding="utf-8")
    print(f"\n  wrote preview/{index_path.name}")

    upload_md_path = EMAILS_DIR / "BREVO_UPLOAD.md"
    upload_md_path.write_text(render_brevo_upload_md(), encoding="utf-8")
    print(f"  wrote {upload_md_path.name}")

    print()
    print(f"Open: file://{index_path}")


if __name__ == "__main__":
    main()
