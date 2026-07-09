"""Build the full OyeChats transactional-email gallery — all 19 templates.

Renders every email the platform sends as a standalone, self-contained HTML file
into ``api/emails/gallery/`` plus a browsable ``index.html``. This is a DESIGN
deliverable (monochrome + single-indigo-accent system, Stripe/Linear inspired,
dark-mode hardened for Outlook inversion). It is intentionally decoupled from
``app.services.email_service`` — once the design is approved, the tokens and
components here get ported back into the runtime helpers.

Usage:
    cd platform/api && uv run python scripts/build_email_gallery.py
"""

from __future__ import annotations

import html
from pathlib import Path

GALLERY_DIR = Path(__file__).resolve().parent.parent / "emails" / "gallery"

APP_URL = "https://app.oyechats.com"
MARKETING_URL = "https://oyechats.com"
SUPPORT_EMAIL = "developer@oyechats.com"
BRAND = "OyeChats"

# ── Design tokens ────────────────────────────────────────────────────────────
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
MONO = "'SF Mono',ui-monospace,Menlo,Consolas,'Liberation Mono',monospace"

# Light palette — never pure #fff / #000 (both trigger aggressive dark-mode inversion)
PAGE = "#f4f5f7"
CARD = "#ffffff"
FILL = "#f3f4f6"  # neutral fill: code box, info tables, quotes
RULE = "#e6e8eb"  # hairlines
INK900 = "#1a1a1d"  # headings
INK700 = "#33363d"  # strong body
INK500 = "#5b616e"  # body
INK400 = "#6b7280"  # labels
INK300 = "#9ca3af"  # footer / faint
ACCENT = "#4f46e5"  # indigo — the ONE accent
ACCENT_TINT = "#eef2ff"
ACCENT_BORDER = "#c7d2fe"

# Semantic — used ONLY inside small chips / alert boxes, never as full-email theming
SEMANTIC = {
    "success": {"bg": "#ecfdf3", "border": "#a6f4c5", "text": "#067647"},
    "warning": {"bg": "#fffaeb", "border": "#fedf89", "text": "#b54708"},
    "danger": {"bg": "#fef3f2", "border": "#fecdca", "text": "#b42318"},
    "info": {"bg": "#eff8ff", "border": "#b2ddff", "text": "#175cd3"},
}

# Dark overrides (class -> {prop: value}). Applied via @media(prefers-color-scheme)
# AND the Outlook.com [data-ogsc]/[data-ogsb] hooks so inversion looks intentional.
DARK = {
    ".oc-page": {"background-color": "#0f1011"},
    ".oc-card": {"background-color": "#17181b", "border-color": "#2b2d33"},
    ".oc-h": {"color": "#f3f4f6"},
    ".oc-body": {"color": "#c2c7cf"},
    ".oc-strong": {"color": "#f3f4f6"},
    ".oc-muted": {"color": "#8b909a"},
    ".oc-rule": {"border-color": "#2b2d33"},
    ".oc-fill": {"background-color": "#232428", "border-color": "#31333a"},
    ".oc-fill-text": {"color": "#e4e6ea"},
    ".oc-link": {"color": "#a5b0ff"},
    ".oc-code": {"color": "#f3f4f6"},
    ".oc-box-success": {"background-color": "#0f2a1d", "border-color": "#1c5237", "color": "#6ee7b7"},
    ".oc-box-warning": {"background-color": "#2b2109", "border-color": "#5a4413", "color": "#fcd34d"},
    ".oc-box-danger": {"background-color": "#2b1514", "border-color": "#5c2422", "color": "#fca5a5"},
    ".oc-box-info": {"background-color": "#10233d", "border-color": "#1e4272", "color": "#93c5fd"},
    ".oc-chip-success": {"background-color": "#0f2a1d", "border-color": "#1c5237", "color": "#6ee7b7"},
    ".oc-chip-warning": {"background-color": "#2b2109", "border-color": "#5a4413", "color": "#fcd34d"},
    ".oc-chip-danger": {"background-color": "#2b1514", "border-color": "#5c2422", "color": "#fca5a5"},
    ".oc-chip-info": {"background-color": "#10233d", "border-color": "#1e4272", "color": "#93c5fd"},
}


def _dark_css() -> str:
    """Expand DARK into a @media block + [data-ogsc]/[data-ogsb] blocks."""

    def rules(prefix: str = "") -> str:
        out = []
        for sel, props in DARK.items():
            decls = "".join(f"{p}:{v} !important;" for p, v in props.items())
            out.append(f"{prefix}{sel}{{{decls}}}")
        return "".join(out)

    media = f"@media (prefers-color-scheme: dark){{{rules()}}}"
    # Outlook.com stamps [data-ogsc] (grabbed source color) / [data-ogsb] (background)
    # on the <body>; descendant selectors let us re-pin every surface + ink.
    ogsc = rules("[data-ogsc] ")
    ogsb = rules("[data-ogsb] ")
    return media + ogsc + ogsb


def esc(v) -> str:
    return html.escape(str(v)) if v not in (None, "") else "&#8212;"


# ── Shell ────────────────────────────────────────────────────────────────────


def _preheader(text: str) -> str:
    pad = "&#847;&zwnj;&nbsp;&#8199;&shy;" * 12
    return (
        f'<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;'
        f'font-size:1px;line-height:1px;color:{PAGE};opacity:0;">{html.escape(text)}{pad}</div>'
    )


def _wordmark(*, size: int = 15) -> str:
    tile = size + 6
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0">'
        f"<tr>"
        f'<td width="{tile}" height="{tile}" align="center" valign="middle" '
        f'style="width:{tile}px;height:{tile}px;background-color:{ACCENT};border-radius:6px;'
        f'text-align:center;vertical-align:middle;">'
        f'<span style="font-family:{FONT};font-size:{size - 2}px;font-weight:800;color:#ffffff;'
        f'line-height:{tile}px;">O</span></td>'
        f'<td width="8" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>'
        f'<td valign="middle" style="vertical-align:middle;">'
        f'<span class="oc-h" style="font-family:{FONT};font-size:{size}px;font-weight:700;'
        f'letter-spacing:-0.2px;color:{INK900};">Oye</span>'
        f'<span style="font-family:{FONT};font-size:{size}px;font-weight:700;'
        f'letter-spacing:-0.2px;color:{ACCENT};">Chats</span>'
        f"</td>"
        f"</tr></table>"
    )


def _header() -> str:
    return (
        f'<tr><td class="oc-pad oc-rule" style="padding:32px 40px 22px 40px;'
        f'border-bottom:1px solid {RULE};">{_wordmark()}</td></tr>'
    )


def _footer(*, visitor: bool) -> str:
    if visitor:
        links = (
            f'<a class="oc-link" href="{MARKETING_URL}" style="color:{INK400};text-decoration:none;'
            f'font-weight:600;">Visit {BRAND}</a>'
            f'<span class="oc-muted" style="color:{INK300};">&nbsp;&middot;&nbsp;</span>'
            f'<a class="oc-link" href="{MARKETING_URL}/privacy" style="color:{INK400};'
            f'text-decoration:none;font-weight:600;">Privacy</a>'
        )
    else:
        links = (
            f'<a class="oc-link" href="{APP_URL}" style="color:{INK400};text-decoration:none;'
            f'font-weight:600;">Dashboard</a>'
            f'<span class="oc-muted" style="color:{INK300};">&nbsp;&middot;&nbsp;</span>'
            f'<a class="oc-link" href="{MARKETING_URL}/help" style="color:{INK400};'
            f'text-decoration:none;font-weight:600;">Help Center</a>'
            f'<span class="oc-muted" style="color:{INK300};">&nbsp;&middot;&nbsp;</span>'
            f'<a class="oc-link" href="mailto:{SUPPORT_EMAIL}" style="color:{INK400};'
            f'text-decoration:none;font-weight:600;">Contact</a>'
        )
    return (
        f'<tr><td class="oc-pad oc-rule" style="padding:24px 40px 30px 40px;'
        f'border-top:1px solid {RULE};">'
        f'<p class="oc-muted" style="margin:0 0 8px 0;font-family:{FONT};font-size:12px;'
        f'color:{INK300};line-height:1.5;">{links}</p>'
        f'<p class="oc-muted" style="margin:0;font-family:{FONT};font-size:12px;'
        f'color:{INK300};line-height:1.5;">&copy; 2026 {BRAND}. All rights reserved.</p>'
        f"</td></tr>"
    )


def shell(*, subject: str, preheader: str, inner: str, visitor: bool = False) -> str:
    return f"""<!DOCTYPE html>
<html lang="en" dir="ltr" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{html.escape(subject)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
<style>
  :root {{ color-scheme: light dark; supported-color-schemes: light dark; }}
  body {{ margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }}
  table {{ border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }}
  td {{ mso-line-height-rule:exactly; }}
  img {{ border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }}
  a[x-apple-data-detectors] {{ color:inherit !important; text-decoration:none !important; font-size:inherit !important;
    font-family:inherit !important; font-weight:inherit !important; line-height:inherit !important; }}
  @media only screen and (max-width:600px) {{
    .oc-container {{ width:100% !important; }}
    .oc-pad {{ padding-left:24px !important; padding-right:24px !important; }}
    .oc-btn-a {{ display:block !important; width:100% !important; box-sizing:border-box !important; }}
  }}
  {_dark_css()}
</style>
</head>
<body class="oc-page" style="margin:0;padding:0;background-color:{PAGE};">
{_preheader(preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="oc-page" style="background-color:{PAGE};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="oc-container" style="width:600px;max-width:600px;">
      <tr><td class="oc-card oc-rule" style="background-color:{CARD};border:1px solid {RULE};border-radius:14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          {_header()}
          <tr><td class="oc-pad" style="padding:32px 40px 36px 40px;">
            {inner}
          </td></tr>
          {_footer(visitor=visitor)}
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""


# ── Components ───────────────────────────────────────────────────────────────


def h1(text: str) -> str:
    return (
        f'<h1 class="oc-h" style="margin:0 0 18px 0;font-family:{FONT};font-size:24px;'
        f'font-weight:600;color:{INK900};line-height:1.3;letter-spacing:-0.4px;">{text}</h1>'
    )


def p(text: str, *, top: int = 0) -> str:
    return (
        f'<p class="oc-body" style="margin:{top}px 0 16px 0;font-family:{FONT};font-size:16px;'
        f'color:{INK500};line-height:1.6;">{text}</p>'
    )


def strong(text: str) -> str:
    return f'<strong class="oc-strong" style="color:{INK900};font-weight:600;">{text}</strong>'


def link(text: str, href: str) -> str:
    return f'<a class="oc-link" href="{html.escape(href, quote=True)}" style="color:{ACCENT};text-decoration:none;">{text}</a>'


def button(label: str, href: str) -> str:
    href_e = html.escape(href, quote=True)
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px 0;">'
        f'<tr><td class="oc-btn-td" align="center" bgcolor="{ACCENT}" style="border-radius:6px;background-color:{ACCENT};">'
        f'<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" '
        f'href="{href_e}" style="height:46px;v-text-anchor:middle;width:230px;" arcsize="13%" '
        f'stroke="f" fillcolor="{ACCENT}"><w:anchorlock/><center style="color:#ffffff;font-family:{FONT};'
        f'font-size:15px;font-weight:600;">{label}</center></v:roundrect><![endif]-->'
        f"<!--[if !mso]><!-->"
        f'<a class="oc-btn-a" href="{href_e}" style="display:inline-block;padding:14px 30px;font-family:{FONT};'
        f"font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;"
        f'line-height:18px;text-align:center;">{label}</a>'
        f"<!--<![endif]-->"
        f"</td></tr></table>"
    )


def code_box(code: str, *, label: str = "Verification code") -> str:
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'class="oc-fill oc-rule" style="background-color:{FILL};border:1px solid {RULE};'
        f'border-radius:10px;margin:6px 0 18px 0;">'
        f'<tr><td align="center" style="padding:22px 16px;">'
        f'<p class="oc-muted" style="margin:0 0 8px 0;font-family:{FONT};font-size:11px;font-weight:700;'
        f'letter-spacing:0.14em;text-transform:uppercase;color:{INK400};">{label}</p>'
        f'<p class="oc-code" style="margin:0;font-family:{MONO};font-size:32px;font-weight:700;'
        f'color:{INK900};letter-spacing:0.30em;">{esc(code)}</p>'
        f"</td></tr></table>"
    )


def section_label(text: str) -> str:
    return (
        f'<p class="oc-muted" style="margin:0 0 8px 0;font-family:{FONT};font-size:11px;font-weight:700;'
        f'letter-spacing:0.12em;text-transform:uppercase;color:{INK400};">{text}</p>'
    )


def divider() -> str:
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="margin:22px 0;"><tr><td class="oc-rule" style="border-top:1px solid {RULE};'
        f'font-size:0;line-height:0;">&nbsp;</td></tr></table>'
    )


def info_table(rows: list[tuple[str, str]], *, right: bool = False) -> str:
    body = []
    align = "right" if right else "left"
    for lbl, val in rows:
        body.append(
            f"<tr>"
            f'<td class="oc-muted" style="padding:9px 16px 9px 0;font-family:{FONT};font-size:12px;'
            f'font-weight:600;color:{INK400};vertical-align:top;white-space:nowrap;">{lbl}</td>'
            f'<td class="oc-body" style="padding:9px 0;font-family:{FONT};font-size:14px;'
            f'color:{INK700};vertical-align:top;line-height:1.5;text-align:{align};">{val}</td>'
            f"</tr>"
        )
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'class="oc-fill oc-rule" style="background-color:{FILL};border:1px solid {RULE};'
        f'border-radius:10px;margin:0 0 18px 0;"><tr><td style="padding:6px 18px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f"{''.join(body)}</table></td></tr></table>"
    )


def alert(text: str, kind: str = "info") -> str:
    c = SEMANTIC[kind]
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="margin:0 0 18px 0;"><tr>'
        f'<td class="oc-box-{kind}" style="background-color:{c["bg"]};border:1px solid {c["border"]};'
        f'border-left:3px solid {c["text"]};border-radius:0 8px 8px 0;padding:13px 16px;">'
        f'<p style="margin:0;font-family:{FONT};font-size:14px;color:{c["text"]};line-height:1.6;">{text}</p>'
        f"</td></tr></table>"
    )


def chip(text: str, kind: str = "success") -> str:
    c = SEMANTIC[kind]
    return (
        f'<span class="oc-chip-{kind}" style="display:inline-block;background-color:{c["bg"]};'
        f"color:{c['text']};border:1px solid {c['border']};font-family:{FONT};font-size:11px;"
        f"font-weight:700;letter-spacing:0.06em;text-transform:uppercase;padding:3px 9px;"
        f'border-radius:100px;vertical-align:middle;">{text}</span>'
    )


def quote(text: str) -> str:
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="margin:0 0 18px 0;"><tr>'
        f'<td class="oc-fill oc-rule" style="background-color:{FILL};border:1px solid {RULE};'
        f'border-left:3px solid {ACCENT};border-radius:0 8px 8px 0;padding:16px 18px;">'
        f'<p class="oc-fill-text" style="margin:0;font-family:{FONT};font-size:15px;color:{INK700};'
        f'line-height:1.65;font-style:italic;white-space:pre-wrap;">{text}</p>'
        f"</td></tr></table>"
    )


def steps(items: list[str]) -> str:
    lis = "".join(f'<li style="margin:0 0 8px 0;">{it}</li>' for it in items)
    return (
        f'<ol class="oc-body" style="margin:0 0 18px 0;padding-left:20px;font-family:{FONT};'
        f'font-size:15px;color:{INK500};line-height:1.6;">{lis}</ol>'
    )


# ── Templates (19) ───────────────────────────────────────────────────────────


def t_verification_otp():
    inner = (
        h1("Verify your email")
        + p(
            "Hi Carlos, thanks for signing up. Enter the code below to verify your email address and finish setting up your account."
        )
        + code_box("428193")
        + p(
            f"This code expires in {strong('15 minutes')}. If you didn&rsquo;t create an {BRAND} account, you can safely ignore this email."
        )
    )
    return (
        "verification-otp",
        "Verify your email",
        shell(
            subject=f"Your {BRAND} verification code",
            preheader="Your verification code — expires in 15 minutes.",
            inner=inner,
        ),
    )


def t_password_reset():
    inner = (
        h1("Reset your password")
        + p("We received a request to reset the password on your account. Enter the code below to choose a new one.")
        + code_box("428193")
        + alert(
            f"This code expires in {strong('15 minutes')}. Never share it — {BRAND} staff will never ask for it.",
            "warning",
        )
        + p("Didn&rsquo;t request this? You can safely ignore this email; your password stays the same.")
    )
    return (
        "password-reset",
        "Reset your password",
        shell(
            subject=f"Your {BRAND} password reset code",
            preheader="Your password reset code — expires in 15 minutes.",
            inner=inner,
        ),
    )


def t_email_change_otp():
    inner = (
        h1("Confirm your new email")
        + p(
            f"You asked to change the email on your {BRAND} account to this address. Enter the code below to confirm the change."
        )
        + code_box("739024")
        + p(
            f"This code expires in {strong('15 minutes')}. If this wasn&rsquo;t you, you can ignore this email — your account email won&rsquo;t change."
        )
    )
    return (
        "email-change-otp",
        "Confirm your new email",
        shell(
            subject=f"Confirm your new {BRAND} email address",
            preheader="Confirm your new email address — code expires in 15 minutes.",
            inner=inner,
        ),
    )


def t_email_change_notice():
    inner = (
        h1("Email change requested")
        + p(
            f"Someone requested to change the login email on your {BRAND} account to {strong('carlos.new@rivtech.mx')}."
        )
        + p(
            "The change only takes effect once that address confirms a verification code — this inbox stays your login email until then."
        )
        + alert(
            f"If this wasn&rsquo;t you, {link('reset your password', APP_URL + '/reset')} immediately and contact {link(SUPPORT_EMAIL, 'mailto:' + SUPPORT_EMAIL)}.",
            "danger",
        )
    )
    return (
        "email-change-notice",
        "Email change requested",
        shell(
            subject=f"Email change requested on your {BRAND} account",
            preheader="A change to your login email was requested.",
            inner=inner,
        ),
    )


def t_trial_welcome():
    inner = (
        h1(f"Welcome to {BRAND}, Carlos")
        + p(
            f"Your {strong('14-day free trial')} is live. You&rsquo;ve got {strong('5,000 credits')} to spend however you like — chats, URL crawls, document uploads. Your trial runs until {strong('July 23, 2026')}. No card on file, no auto-charge."
        )
        + button("Open my dashboard", APP_URL)
        + divider()
        + section_label("A 3-step path to your first chat")
        + steps(
            [
                f"{link('Upload your knowledge base', APP_URL + '/knowledge')} — PDFs, docs, or paste your website URL and we crawl it.",
                f"{link('Style the widget', APP_URL + '/chatbot')} — colors, logo, welcome message.",
                f"{link('Drop the script tag', APP_URL + '/chatbot')} on your site — one line of HTML and you&rsquo;re live.",
            ]
        )
        + p(
            f"Stuck on something? Just reply to this email or write to {link(SUPPORT_EMAIL, 'mailto:' + SUPPORT_EMAIL)}."
        )
    )
    return (
        "trial-welcome",
        "Welcome — your trial is live",
        shell(
            subject=f"Welcome to {BRAND} — your 14-day trial is live",
            preheader="You've got 5,000 credits and 14 days to build your bot.",
            inner=inner,
        ),
    )


def t_trial_day7():
    inner = (
        h1("You&rsquo;re halfway through your trial, Carlos")
        + p(
            f"Quick check-in — you&rsquo;ve got {strong('7 days left')}. If your bot is live and answering visitors, you&rsquo;re ahead of the curve. If you haven&rsquo;t uploaded knowledge or dropped the script tag yet, this is the week to do it."
        )
        + button("Open my dashboard", APP_URL)
        + p(
            f"Already sold? {link('Pick a plan', APP_URL + '/billing')} any time — conversion preserves your bot, documents, and chat history.",
            top=8,
        )
    )
    return (
        "trial-day7",
        "Halfway through your trial",
        shell(
            subject=f"You're halfway through your {BRAND} trial",
            preheader="Halfway through your trial — 7 days left.",
            inner=inner,
        ),
    )


def t_trial_days_left():
    inner = (
        h1("3 days left in your trial")
        + p(
            f"You&rsquo;ve got {strong('3 days')} to keep evaluating. If you&rsquo;d like your bot to stay live without a gap, pick a plan before the trial ends."
        )
        + p(
            "Your knowledge base, settings, and chat history are kept safe for 15 days after the trial ends — nothing is lost if you decide later."
        )
        + button("Pick a plan", APP_URL + "/billing")
        + p(
            f"Questions about pricing? Reply to this email or write to {link(SUPPORT_EMAIL, 'mailto:' + SUPPORT_EMAIL)}.",
            top=8,
        )
    )
    return (
        "trial-days-left",
        "3 days left in your trial",
        shell(
            subject=f"3 days left in your {BRAND} trial",
            preheader="3 days left in your trial.",
            inner=inner,
        ),
    )


def t_trial_ended():
    inner = (
        h1("Your trial has ended")
        + p(
            f"Hi Carlos — your trial of {strong('Standard')} wrapped up today. Your bot is now showing its offline message to visitors. Pick a plan and it&rsquo;s back online within a minute."
        )
        + alert(
            f"Your knowledge base, settings, and chat history are kept safe until {strong('August 7, 2026')}. After that date, the workspace is permanently deleted.",
            "warning",
        )
        + button("Choose a plan to reactivate", APP_URL + "/billing")
        + p(
            f"Trial didn&rsquo;t fit? We&rsquo;d love quick feedback — {link(SUPPORT_EMAIL, 'mailto:' + SUPPORT_EMAIL)}.",
            top=8,
        )
    )
    return (
        "trial-ended",
        "Your trial has ended",
        shell(
            subject=f"Your {BRAND} trial has ended — pick a plan to keep your bot live",
            preheader="Reactivate by August 7 to keep your bot and data.",
            inner=inner,
        ),
    )


def t_trial_data_deleted():
    inner = (
        h1("Your workspace has been deleted")
        + p(
            "Hi Carlos — as scheduled, we&rsquo;ve permanently deleted the bots, documents, and chat history from your trial workspace. Nothing is recoverable from this account."
        )
        + p(f"If you ever want to give {BRAND} another look, you can start fresh any time — no hard feelings.")
        + p(f"Questions? Reply to this email or write to {link(SUPPORT_EMAIL, 'mailto:' + SUPPORT_EMAIL)}.")
    )
    return (
        "trial-data-deleted",
        "Your workspace has been deleted",
        shell(
            subject=f"Your {BRAND} workspace has been deleted",
            preheader="Your trial workspace has been permanently deleted.",
            inner=inner,
        ),
    )


def t_invoice():
    # Stripe-style receipt: hero amount → summary → line items → total.
    hero = (
        f'<p class="oc-muted" style="margin:0 0 4px 0;font-family:{FONT};font-size:12px;font-weight:600;'
        f'letter-spacing:0.06em;text-transform:uppercase;color:{INK400};">Amount paid</p>'
        f'<p class="oc-h" style="margin:0 0 20px 0;font-family:{FONT};font-size:34px;font-weight:700;'
        f'color:{INK900};letter-spacing:-0.6px;">&#8377;1,180.00</p>'
    )
    line_items = (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 6px 0;">'
        f'<tr><td class="oc-body" style="padding:10px 0;font-family:{FONT};font-size:14px;color:{INK700};'
        f'border-bottom:1px solid {RULE};" class="oc-rule">Standard plan — monthly</td>'
        f'<td class="oc-body oc-rule" align="right" style="padding:10px 0;font-family:{FONT};font-size:14px;'
        f'color:{INK700};border-bottom:1px solid {RULE};">&#8377;1,000.00</td></tr>'
        f'<tr><td class="oc-body oc-rule" style="padding:10px 0;font-family:{FONT};font-size:14px;color:{INK700};'
        f'border-bottom:1px solid {RULE};">GST (18%)</td>'
        f'<td class="oc-body oc-rule" align="right" style="padding:10px 0;font-family:{FONT};font-size:14px;'
        f'color:{INK700};border-bottom:1px solid {RULE};">&#8377;180.00</td></tr>'
        f'<tr><td class="oc-h" style="padding:12px 0 0 0;font-family:{FONT};font-size:15px;font-weight:700;'
        f'color:{INK900};">Total</td>'
        f'<td class="oc-h" align="right" style="padding:12px 0 0 0;font-family:{FONT};font-size:15px;'
        f'font-weight:700;color:{INK900};">&#8377;1,180.00</td></tr>'
        f"</table>"
    )
    inner = (
        h1("Your tax invoice is ready")
        + p(
            f"Thank you for your payment. Your tax invoice from {strong('Digibranders')} is ready — the PDF is attached to this email."
        )
        + hero
        + info_table(
            [
                ("Invoice no.", "DB/26-27/000042"),
                ("Date paid", "July 9, 2026"),
                ("Payment method", "UPI &middot; okhdfcbank"),
            ],
            right=True,
        )
        + section_label("Summary")
        + line_items
        + divider()
        + button("Download invoice", APP_URL + "/billing/invoices/42")
        + p("A copy is attached as a PDF. The download link stays valid for 30 days.", top=8)
    )
    return (
        "invoice",
        "Your tax invoice is ready",
        shell(
            subject="Tax invoice DB/26-27/000042 from Digibranders",
            preheader="Tax invoice DB/26-27/000042 — ₹1,180.00",
            inner=inner,
        ),
    )


def t_downgrade_reauth():
    inner = (
        h1("One step to finish your switch to Starter")
        + p(
            f"Hi Carlos — your billing cycle on {strong('Standard')} has ended and your scheduled move to {strong('Starter')} is ready. Because your payments run on a UPI mandate, we can&rsquo;t change the plan on the existing mandate — you&rsquo;ll need to authorize a new one for the lower plan."
        )
        + alert(
            "It takes under a minute. Until you confirm, your account stays paused on the new plan — please complete it soon to keep your bot live.",
            "warning",
        )
        + button("Authorize Starter", "https://razorpay.com/checkout/example")
        + p(
            f"Changed your mind, or need a hand? Reply to this email or write to {link(SUPPORT_EMAIL, 'mailto:' + SUPPORT_EMAIL)}.",
            top=8,
        )
    )
    return (
        "downgrade-reauth",
        "Confirm your plan switch",
        shell(
            subject="Action needed: confirm your switch to Starter",
            preheader="Authorize your new Starter mandate to keep your bot live.",
            inner=inner,
        ),
    )


def t_qualified_lead():
    intro = p(
        f"A visitor on {strong('Acme Support Bot')} has reached Sales Qualified Lead status. "
        f"They match your qualification criteria across all four BANT dimensions. &nbsp;{chip('SQL', 'success')}"
    )
    inner = (
        h1("New qualified lead")
        + intro
        + section_label("Qualification (BANT)")
        + info_table(
            [
                ("Need", "Bilingual chatbot for Spanish-speaking customers"),
                ("Budget", "&#36;2,000&ndash;&#36;5,000 / month confirmed"),
                ("Authority", "Director of Customer Experience"),
                ("Timeline", "Wants to launch within 30 days"),
            ]
        )
        + section_label("Contact")
        + info_table(
            [
                ("Name", "Carlos Rivera"),
                ("Email", link("carlos@rivtech.mx", "mailto:carlos@rivtech.mx")),
                ("Phone", "+52 55 1234 5678"),
                ("Company", "Riv Technologies"),
            ]
        )
        + button("View lead in dashboard", APP_URL + "/leads")
    )
    return (
        "qualified-lead",
        "New qualified lead",
        shell(
            subject="New SQL lead from Acme Support Bot — Carlos Rivera",
            preheader="New SQL lead — Carlos Rivera at Riv Technologies.",
            inner=inner,
        ),
    )


def t_handoff_request():
    inner = (
        h1("A visitor wants to chat")
        + p(
            f"A visitor on {strong('Acme Support Bot')} is requesting to speak with a live team member. They&rsquo;re waiting in the queue right now."
        )
        + section_label("Visitor")
        + info_table(
            [
                ("Name", "Priya Mehta"),
                ("Email", link("priya.m@brightwave.io", "mailto:priya.m@brightwave.io")),
                ("Reason", "Question about enterprise pricing and SSO"),
            ]
        )
        + alert(
            "Visitors typically wait less than 60 seconds before abandoning a live-chat queue. Please respond promptly.",
            "warning",
        )
        + button("Accept request", APP_URL + "/support")
    )
    return (
        "handoff-request",
        "A visitor wants to chat",
        shell(
            subject="Priya Mehta is waiting to chat on Acme Support Bot",
            preheader="A visitor is waiting in your live-chat queue.",
            inner=inner,
        ),
    )


def t_missed_callback():
    inner = (
        h1("Follow up with a visitor")
        + p(
            f"{strong('No agent was available')} when a visitor on {strong('Acme Support Bot')} requested live support. They left their contact details so you can follow up."
        )
        + alert(
            "Reach out within the next hour for the best chance of converting this missed connection into a qualified conversation.",
            "danger",
        )
        + section_label("Visitor")
        + info_table(
            [
                ("Name", "Daniel Okafor"),
                ("Email", link("daniel.o@northbeam.co", "mailto:daniel.o@northbeam.co")),
                ("Phone", "+1 (415) 555-0142"),
            ]
        )
        + button("Follow up now", APP_URL + "/leads")
    )
    return (
        "missed-callback",
        "Follow up with a visitor",
        shell(
            subject="Missed live-chat request from Acme Support Bot",
            preheader="A visitor requested support while you were away.",
            inner=inner,
        ),
    )


def t_offline_message():
    inner = (
        h1("New offline message")
        + p(f"A visitor on {strong('Fynix Digital')} left a message while no agent was available.")
        + section_label("From")
        + info_table(
            [
                ("Name", "Anika Sharma"),
                ("Email", link("anika@fynix.digital", "mailto:anika@fynix.digital")),
            ]
        )
        + section_label("Message")
        + quote(
            "Hi — I&rsquo;m evaluating chat widgets for our support site and wanted to know if you support handoff to a human agent during business hours. Also, do you have a WordPress plugin?"
        )
        + button("View &amp; reply", APP_URL + "/support")
    )
    return (
        "offline-message",
        "New offline message",
        shell(
            subject="New offline message from Fynix Digital",
            preheader="New message from Anika Sharma — reply when you're back.",
            inner=inner,
        ),
    )


def t_visitor_confirmation():
    inner = (
        h1("We got your message")
        + p("Hi Anika,")
        + p(
            f"Thanks for reaching out to {strong('Fynix Digital')}. We&rsquo;ve received your message and our team has been notified. Someone will get back to you shortly."
        )
        + alert("Message received — no action needed on your end. We&rsquo;ll be in touch by email.", "success")
        + p("You can reply directly to this email if you have anything to add.")
    )
    return (
        "visitor-confirmation",
        "We got your message",
        shell(
            subject="Thank you for contacting Fynix Digital",
            preheader="Thanks Anika — your message was received.",
            inner=inner,
            visitor=True,
        ),
    )


def t_chat_transcript():
    def bubble(role, name, time, text, tint, tc):
        return (
            f'<tr><td style="padding:0 0 14px 0;">'
            f'<p class="oc-muted" style="margin:0 0 4px 0;font-family:{FONT};font-size:11px;font-weight:700;'
            f'color:{INK400};">{name}<span style="font-weight:400;color:{INK300};">&nbsp;&middot;&nbsp;{time}</span></p>'
            f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td class="oc-fill oc-fill-text" style="background-color:{tint};border-radius:10px;padding:11px 15px;'
            f'font-family:{FONT};font-size:14px;color:{tc};line-height:1.6;">{text}</td>'
            f"</tr></table></td></tr>"
        )

    rows = (
        bubble("user", "You", "11:32", "Hi! Do you support Spanish-language chatbots?", FILL, INK700)
        + bubble(
            "bot",
            "Acme Support Bot",
            "11:32",
            "Yes — our bots are multilingual out of the box. Upload knowledge in any language and the bot replies in the visitor&rsquo;s language automatically.",
            ACCENT_TINT,
            "#3730a3",
        )
        + bubble("user", "You", "11:33", "Great. Can I see pricing for a team of 5 operators?", FILL, INK700)
        + bubble(
            "operator",
            "Priya (Acme)",
            "11:33",
            "Hi Carlos — happy to walk you through team pricing. Are you free for a 15-minute call this week?",
            "#ecfdf3",
            "#065f46",
        )
    )
    transcript = (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'class="oc-fill oc-rule" style="background-color:{FILL};border:1px solid {RULE};border-radius:10px;'
        f'margin:0 0 18px 0;"><tr><td style="padding:18px 20px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">{rows}</table>'
        f"</td></tr></table>"
    )
    inner = (
        h1("Your chat transcript")
        + p(f"Here&rsquo;s a full transcript of your conversation with {strong('Acme Support Bot')}.")
        + transcript
        + p(f"Sent from Acme Support Bot via {BRAND}.")
    )
    return (
        "chat-transcript",
        "Your chat transcript",
        shell(
            subject="Chat Transcript — Acme Support Bot",
            preheader="Your conversation with Acme Support Bot — full transcript.",
            inner=inner,
            visitor=True,
        ),
    )


def t_affiliate_welcome():
    inner = (
        h1(f"You&rsquo;re now an {BRAND} affiliate")
        + p(
            f"Hi Carlos — you&rsquo;ve just been enrolled in the {BRAND} affiliate program. You can now create referral codes, share them anywhere, and track how each one performs from your dashboard."
        )
        + button("Open my affiliate dashboard", APP_URL + "/affiliate")
        + p(f"Need help? Reply to this email or write to {link(SUPPORT_EMAIL, 'mailto:' + SUPPORT_EMAIL)}.", top=8)
    )
    return (
        "affiliate-welcome",
        "You're now an affiliate",
        shell(
            subject=f"You're now an {BRAND} affiliate",
            preheader="Create referral codes and earn from every signup.",
            inner=inner,
        ),
    )


def t_affiliate_invite():
    invite_url = APP_URL + "/affiliate-invite?token=example"
    inner = (
        h1(f"You&rsquo;ve been invited to {BRAND} Partners")
        + p(
            f"{BRAND} Partners is a hand-picked group earning recurring commission on every customer they bring to the platform. We&rsquo;d like you to join."
        )
        + p(
            f"Click below to accept. If you already have an account you&rsquo;ll sign in and the Affiliate menu appears in your sidebar. New here? You can create an account in the same flow. This link expires in {strong('14 days')}."
        )
        + button("Accept your Partners invite", invite_url)
        + p("If the button doesn&rsquo;t work, paste this link into your browser:", top=8)
        + f'<p class="oc-link" style="margin:0 0 16px 0;font-family:{FONT};font-size:13px;color:{ACCENT};word-break:break-all;line-height:1.5;">{link(invite_url, invite_url)}</p>'
        + p(
            "Didn&rsquo;t expect this? You can safely ignore it — the invite will expire and no account will be created."
        )
    )
    return (
        "affiliate-invite",
        "You're invited to Partners",
        shell(
            subject=f"You're invited to {BRAND} Partners",
            preheader="Accept your Partners invite. Link expires in 14 days.",
            inner=inner,
        ),
    )


# ── Driver ───────────────────────────────────────────────────────────────────

CATEGORIES = [
    ("Authentication & account", [t_verification_otp, t_password_reset, t_email_change_otp, t_email_change_notice]),
    ("Trial lifecycle", [t_trial_welcome, t_trial_day7, t_trial_days_left, t_trial_ended, t_trial_data_deleted]),
    ("Billing", [t_invoice, t_downgrade_reauth]),
    (
        "Lead & live chat",
        [
            t_qualified_lead,
            t_handoff_request,
            t_missed_callback,
            t_offline_message,
            t_visitor_confirmation,
            t_chat_transcript,
        ],
    ),
    ("Affiliate", [t_affiliate_welcome, t_affiliate_invite]),
]


def render_index(entries: list[tuple[str, str, str]]) -> str:
    by_cat: dict[str, list[tuple[str, str]]] = {}
    for cat, slug, label in entries:
        by_cat.setdefault(cat, []).append((slug, label))
    sections = []
    for cat, items in by_cat.items():
        cards = "".join(
            f'<div class="card"><div class="head"><h3>{html.escape(lbl)}</h3>'
            f'<a href="{slug}.html" target="_blank" rel="noopener">Open &rarr;</a></div>'
            f'<iframe src="{slug}.html" loading="lazy"></iframe></div>'
            for slug, lbl in items
        )
        sections.append(f'<h2>{html.escape(cat)}</h2><div class="grid">{cards}</div>')
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{BRAND} email gallery</title>
<style>
  *{{box-sizing:border-box;}} body{{margin:0;padding:32px 24px 64px;background:#f4f5f7;
    font-family:{FONT};color:{INK900};}}
  header{{max-width:1400px;margin:0 auto 20px;}} header h1{{margin:0 0 4px;font-size:24px;letter-spacing:-0.4px;}}
  header p{{margin:0;color:{INK400};font-size:14px;}}
  h2{{max-width:1400px;margin:34px auto 14px;font-size:15px;text-transform:uppercase;letter-spacing:0.08em;color:{INK400};}}
  .grid{{max-width:1400px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:20px;}}
  .card{{background:{CARD};border:1px solid {RULE};border-radius:12px;overflow:hidden;}}
  .head{{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid {RULE};}}
  .head h3{{flex:1;margin:0;font-size:13px;font-weight:600;}}
  .head a{{font-size:12px;color:{ACCENT};text-decoration:none;font-weight:600;}}
  iframe{{width:100%;height:680px;border:0;display:block;background:{PAGE};}}
</style></head><body>
<header><h1>{BRAND} — transactional email gallery</h1>
<p>{len(entries)} templates · monochrome + single-accent system · dark-mode hardened. Toggle your OS to dark mode to preview inversion behavior.</p></header>
{"".join(sections)}
</body></html>"""


def main() -> None:
    GALLERY_DIR.mkdir(parents=True, exist_ok=True)
    entries: list[tuple[str, str, str]] = []
    print(f"Writing gallery to {GALLERY_DIR}\n")
    n = 0
    for cat, fns in CATEGORIES:
        for fn in fns:
            slug, label, htmlc = fn()
            (GALLERY_DIR / f"{slug}.html").write_text(htmlc, encoding="utf-8")
            kb = len(htmlc.encode()) / 1024
            n += 1
            print(f"  {n:2d}. {slug + '.html':32s} ({kb:4.1f} KB)  [{cat}]")
            entries.append((cat, slug, label))
    (GALLERY_DIR / "index.html").write_text(render_index(entries), encoding="utf-8")
    print(f"\n  index.html ({len(entries)} templates)")
    print(f"\nOpen: file://{GALLERY_DIR / 'index.html'}")


if __name__ == "__main__":
    main()
