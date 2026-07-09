"""Shared HTML-email design system — the single source of truth for how every
transactional/lifecycle email looks.

Monochrome + single-indigo-accent (Stripe/Linear inspired), 600px table layout,
system fonts, bulletproof VML buttons, and dark-mode overrides that survive
Outlook's full inversion (``@media (prefers-color-scheme)`` +
``[data-ogsc]``/``[data-ogsb]`` hooks).

``email_service`` composes emails from these components; ``scripts/build_email_gallery``
renders the real senders through this same system, so the gallery and production
can never drift.

Escaping contract: components accept *HTML-ready* fragments. Escape any
user-supplied value with :func:`esc` (or run it through :func:`md_to_html` for
message bodies) BEFORE passing it in. Static/brand strings are trusted.
"""

from __future__ import annotations

import html
import re
from datetime import UTC, datetime

from app.config import APP_URL, BRAND_NAME, MARKETING_URL

# ── Design tokens ────────────────────────────────────────────────────────────
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
MONO = "'SF Mono',ui-monospace,Menlo,Consolas,'Liberation Mono',monospace"

# Light palette — never pure #fff / #000 (both trigger aggressive dark-mode inversion).
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

# Semantic — used ONLY inside small chips / alert boxes, never as full-email theming.
SEMANTIC: dict[str, dict[str, str]] = {
    "success": {"bg": "#ecfdf3", "border": "#a6f4c5", "text": "#067647"},
    "warning": {"bg": "#fffaeb", "border": "#fedf89", "text": "#b54708"},
    "danger": {"bg": "#fef3f2", "border": "#fecdca", "text": "#b42318"},
    "info": {"bg": "#eff8ff", "border": "#b2ddff", "text": "#175cd3"},
}

# Dark overrides (class -> {prop: value}). Applied via @media(prefers-color-scheme)
# AND the Outlook.com [data-ogsc]/[data-ogsb] hooks so inversion looks intentional.
_DARK: dict[str, dict[str, str]] = {
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
    def rules(prefix: str = "") -> str:
        out = []
        for sel, props in _DARK.items():
            decls = "".join(f"{p}:{v} !important;" for p, v in props.items())
            out.append(f"{prefix}{sel}{{{decls}}}")
        return "".join(out)

    # Outlook.com stamps [data-ogsc] (grabbed source color) / [data-ogsb] (background)
    # on the <body>; descendant selectors let us re-pin every surface + ink.
    return f"@media (prefers-color-scheme: dark){{{rules()}}}{rules('[data-ogsc] ')}{rules('[data-ogsb] ')}"


# ── Escaping ─────────────────────────────────────────────────────────────────


def esc(value: object) -> str:
    """HTML-escape a user-supplied value. Empty/None renders as an em-dash."""
    return html.escape(str(value)) if value not in (None, "") else "&#8212;"


def md_to_html(text: str) -> str:
    """Convert a tiny markdown subset to HTML. Call AFTER :func:`esc`.

    Handles **bold**, *italic*/_italic_, and inline `code`. Only processes
    markdown markers, so it is safe on already-escaped strings.
    """
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text, flags=re.DOTALL)
    text = re.sub(r"\*([^*\n]+?)\*", r"<em>\1</em>", text)
    text = re.sub(r"(?<!\w)_([^_\n]+?)_(?!\w)", r"<em>\1</em>", text)
    text = re.sub(
        r"`([^`]+)`",
        r"<span style=\"font-family:'Courier New',Courier,monospace;"
        r'background-color:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:13px;">\1</span>',
        text,
    )
    return text


# ── Shell ────────────────────────────────────────────────────────────────────


def _preheader(text: str) -> str:
    pad = "&#847;&zwnj;&nbsp;&#8199;&shy;" * 12
    return (
        f'<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;'
        f'font-size:1px;line-height:1px;color:{PAGE};opacity:0;">{html.escape(text)}{pad}</div>'
    )


def _brand_split() -> tuple[str, str]:
    """Split BRAND_NAME at a lowercase→uppercase boundary (OyeChats → Oye, Chats)."""
    m = re.search(r"(?<=[a-z])(?=[A-Z])", BRAND_NAME)
    if m:
        return html.escape(BRAND_NAME[: m.start()]), html.escape(BRAND_NAME[m.start() :])
    return "", html.escape(BRAND_NAME)


def _wordmark(*, size: int = 15) -> str:
    tile = size + 6
    first, second = _brand_split()
    initial = html.escape(BRAND_NAME[:1].upper()) if BRAND_NAME else "O"
    first_span = (
        f'<span class="oc-h" style="font-family:{FONT};font-size:{size}px;font-weight:700;'
        f'letter-spacing:-0.2px;color:{INK900};">{first}</span>'
        if first
        else ""
    )
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td width="{tile}" height="{tile}" align="center" valign="middle" '
        f'style="width:{tile}px;height:{tile}px;background-color:{ACCENT};border-radius:6px;'
        f'text-align:center;vertical-align:middle;">'
        f'<span style="font-family:{FONT};font-size:{size - 2}px;font-weight:800;color:#ffffff;'
        f'line-height:{tile}px;">{initial}</span></td>'
        f'<td width="8" style="width:8px;font-size:0;line-height:0;">&nbsp;</td>'
        f'<td valign="middle" style="vertical-align:middle;">{first_span}'
        f'<span style="font-family:{FONT};font-size:{size}px;font-weight:700;'
        f'letter-spacing:-0.2px;color:{ACCENT};">{second}</span></td>'
        f"</tr></table>"
    )


def _header() -> str:
    return (
        f'<tr><td class="oc-pad oc-rule" style="padding:32px 40px 22px 40px;'
        f'border-bottom:1px solid {RULE};">{_wordmark()}</td></tr>'
    )


def _footer(*, visitor: bool) -> str:
    brand = html.escape(BRAND_NAME)
    dot = f'<span class="oc-muted" style="color:{INK300};">&nbsp;&middot;&nbsp;</span>'
    if visitor:
        links = (
            f'<a class="oc-link" href="{MARKETING_URL}" style="color:{INK400};text-decoration:none;'
            f'font-weight:600;">Visit {brand}</a>{dot}'
            f'<a class="oc-link" href="{MARKETING_URL}/privacy" style="color:{INK400};'
            f'text-decoration:none;font-weight:600;">Privacy</a>'
        )
    else:
        links = (
            f'<a class="oc-link" href="{APP_URL}" style="color:{INK400};text-decoration:none;'
            f'font-weight:600;">Dashboard</a>{dot}'
            f'<a class="oc-link" href="{MARKETING_URL}/docs" style="color:{INK400};'
            f'text-decoration:none;font-weight:600;">Help Center</a>{dot}'
            f'<a class="oc-link" href="{MARKETING_URL}/contact" style="color:{INK400};'
            f'text-decoration:none;font-weight:600;">Contact</a>'
        )
    return (
        f'<tr><td class="oc-pad oc-rule" style="padding:24px 40px 30px 40px;'
        f'border-top:1px solid {RULE};">'
        f'<p class="oc-muted" style="margin:0 0 8px 0;font-family:{FONT};font-size:12px;'
        f'color:{INK300};line-height:1.5;">{links}</p>'
        f'<p class="oc-muted" style="margin:0;font-family:{FONT};font-size:12px;'
        f'color:{INK300};line-height:1.5;">&copy; {datetime.now(UTC).year} {brand}. All rights reserved.</p>'
        f"</td></tr>"
    )


def shell(*, subject: str, preheader: str, inner: str, visitor: bool = False) -> str:
    """Wrap composed ``inner`` content in the full email document."""
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
    return (
        f'<a class="oc-link" href="{html.escape(href, quote=True)}" '
        f'style="color:{ACCENT};text-decoration:none;">{text}</a>'
    )


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
        f'letter-spacing:0.14em;text-transform:uppercase;color:{INK400};">{html.escape(label)}</p>'
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
    align = "right" if right else "left"
    body = "".join(
        f"<tr>"
        f'<td class="oc-muted" style="padding:9px 16px 9px 0;font-family:{FONT};font-size:12px;'
        f'font-weight:600;color:{INK400};vertical-align:top;white-space:nowrap;">{lbl}</td>'
        f'<td class="oc-body" style="padding:9px 0;font-family:{FONT};font-size:14px;'
        f'color:{INK700};vertical-align:top;line-height:1.5;text-align:{align};">{val}</td>'
        f"</tr>"
        for lbl, val in rows
    )
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'class="oc-fill oc-rule" style="background-color:{FILL};border:1px solid {RULE};'
        f'border-radius:10px;margin:0 0 18px 0;"><tr><td style="padding:6px 18px;">'
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">'
        f"{body}</table></td></tr></table>"
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
