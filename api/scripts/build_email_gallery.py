"""Build the transactional-email gallery. Rendered from the REAL senders.

Renders every email the platform actually sends into ``api/emails/gallery/`` (plus a
browsable ``index.html``) by calling the production ``send_*`` functions in
``app.services.email_service`` with sample data and capturing the HTML they hand to
Brevo. Because it exercises the real code path, the gallery cannot drift from what
customers receive. Regenerate it whenever an email changes.

Usage:
    cd platform/api && uv run python scripts/build_email_gallery.py
"""

from __future__ import annotations

import html
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

# Allow running as a plain script (`python scripts/build_email_gallery.py`): put the
# api/ project root on the path so `app.*` imports resolve.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import email_design as ed  # noqa: E402
from app.services import email_service as es  # noqa: E402

GALLERY_DIR = Path(__file__).resolve().parent.parent / "emails" / "gallery"
TO = "preview@example.com"

# ── Capture harness ──────────────────────────────────────────────────────────
# Replace the real dispatcher so senders render + hand us HTML instead of calling Brevo
# (and never touch the ARQ worker path).
_captured: dict[str, str] = {}


def _capture(to_email, subject, html_body, **kwargs):  # noqa: ARG001
    _captured["html"] = html_body


es.send_email_async = _capture


def _render(thunk) -> str:
    _captured.clear()
    thunk()
    if "html" not in _captured:
        raise RuntimeError("sender did not dispatch an email (nothing captured)")
    return _captured["html"]


# ── Sample data ──────────────────────────────────────────────────────────────
_BANT = {
    "bant_need": "Bilingual chatbot for Spanish-speaking customers",
    "bant_budget": "$2,000-$5,000 / month confirmed",
    "bant_authority": "Director of Customer Experience",
    "bant_timeline": "Wants to launch within 30 days",
}
_CONTACT = {
    "name": "Carlos Rivera",
    "email": "carlos@rivtech.mx",
    "phone": "+52 55 1234 5678",
    "company": "Riv Technologies",
}
_MESSAGES = [
    {"role": "system", "content": "Chat started", "created_at": "2026-07-09T11:32:00Z"},
    {"role": "user", "content": "Hi! Do you support Spanish-language chatbots?", "created_at": "2026-07-09T11:32:14Z"},
    {
        "role": "bot",
        "content": "Yes. Our bots are **multilingual** out of the box. Upload knowledge in any language and "
        "the bot replies in the visitor's language automatically.",
        "created_at": "2026-07-09T11:32:16Z",
    },
    {
        "role": "user",
        "content": "Great. Can I see pricing for a team of 5 operators?",
        "created_at": "2026-07-09T11:33:02Z",
    },
    {
        "role": "operator",
        "content": "Hi Carlos. Happy to walk you through team pricing. Are you free for a 15-minute call this week?",
        "created_at": "2026-07-09T11:33:48Z",
    },
    {"role": "system", "content": "Chat ended", "created_at": "2026-07-09T11:36:12Z"},
]
_INVOICE = SimpleNamespace(
    invoice_type="tax_invoice",
    invoice_number="DB/26-27/000042",
    amount_cents=118000,
    total_tax_minor=18000,
    seller_snapshot={"legal_name": "Digibranders"},
    id=42,
)

# (slug, category, thunk that invokes the real sender with sample data)
TEMPLATES = [
    (
        "verification-otp",
        "Authentication & account",
        lambda: es.send_verification_otp_email(TO, "Carlos Rivera", "428193"),
    ),
    ("password-reset", "Authentication & account", lambda: es.send_password_reset_email(TO, "428193")),
    ("email-change-otp", "Authentication & account", lambda: es.send_email_change_otp(TO, "Carlos", "739024")),
    (
        "email-change-notice",
        "Authentication & account",
        lambda: es.send_email_change_requested_notice(TO, "Carlos", "carlos.new@rivtech.mx"),
    ),
    (
        "trial-welcome",
        "Trial lifecycle",
        lambda: es.send_trial_welcome_email(
            TO, name="Carlos", trial_end=datetime(2026, 7, 23), credits=5000, duration_days=14
        ),
    ),
    (
        "trial-day7",
        "Trial lifecycle",
        lambda: es.send_trial_day_7_email(TO, name="Carlos", days_remaining=7, plan_name="Standard"),
    ),
    (
        "trial-days-left",
        "Trial lifecycle",
        lambda: es.send_trial_days_left_email(TO, name="Carlos", days_remaining=3, plan_name="Standard"),
    ),
    (
        "trial-ended",
        "Trial lifecycle",
        lambda: es.send_trial_ended_email(
            TO, name="Carlos", plan_name="Standard", data_retention_until=datetime(2026, 8, 7)
        ),
    ),
    ("trial-data-deleted", "Trial lifecycle", lambda: es.send_trial_data_deleted_email(TO, name="Carlos")),
    ("invoice", "Billing", lambda: es.send_invoice_email(TO, _INVOICE, "https://app.oyechats.com/billing/invoices/42")),
    (
        "downgrade-reauth",
        "Billing",
        lambda: es.send_downgrade_reauth_email(
            TO,
            name="Carlos",
            old_plan_name="Standard",
            new_plan_name="Starter",
            reauth_url="https://razorpay.com/checkout/example",
        ),
    ),
    (
        "qualified-lead",
        "Lead & live chat",
        lambda: es.send_qualified_lead_email(TO, "Acme Support Bot", _BANT, _CONTACT, tier="sql"),
    ),
    (
        "handoff-request",
        "Lead & live chat",
        lambda: es.send_handoff_request_email(
            TO,
            "Acme Support Bot",
            "Question about enterprise pricing and SSO",
            {"name": "Priya Mehta", "email": "priya.m@brightwave.io"},
        ),
    ),
    (
        "missed-callback",
        "Lead & live chat",
        lambda: es.send_unavailable_callback_email(
            TO,
            "Acme Support Bot",
            {"name": "Daniel Okafor", "email": "daniel.o@northbeam.co", "phone": "+1 (415) 555-0142"},
        ),
    ),
    (
        "offline-message",
        "Lead & live chat",
        lambda: es.send_offline_message_email(
            TO,
            "Fynix Digital",
            "Anika Sharma",
            "anika@fynix.digital",
            "Hi. I'm evaluating chat widgets for our support site and wanted to know if you support handoff to a human agent during business hours. Also, do you have a WordPress plugin?",
        ),
    ),
    (
        "visitor-confirmation",
        "Lead & live chat",
        lambda: es.send_visitor_confirmation_email(TO, "Fynix Digital", "Anika"),
    ),
    ("chat-transcript", "Lead & live chat", lambda: es.send_transcript_email(TO, "Acme Support Bot", _MESSAGES)),
    ("affiliate-welcome", "Affiliate", lambda: es.send_affiliate_welcome_email(TO, "Carlos Rivera")),
    (
        "affiliate-invite",
        "Affiliate",
        lambda: es.send_affiliate_invite_email(
            TO, "https://app.oyechats.com/affiliate-invite?token=example", expires_in_days=14
        ),
    ),
]


def render_index(entries: list[tuple[str, str]]) -> str:
    by_cat: dict[str, list[str]] = {}
    order: list[str] = []
    for slug, cat in entries:
        if cat not in by_cat:
            by_cat[cat] = []
            order.append(cat)
        by_cat[cat].append(slug)
    sections = []
    for cat in order:
        cards = "".join(
            f'<div class="card"><div class="head"><h3>{html.escape(slug)}</h3>'
            f'<a href="{slug}.html" target="_blank" rel="noopener">Open &rarr;</a></div>'
            f'<iframe src="{slug}.html" loading="lazy"></iframe></div>'
            for slug in by_cat[cat]
        )
        sections.append(f'<h2>{html.escape(cat)}</h2><div class="grid">{cards}</div>')
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(ed.BRAND_NAME)} email gallery</title>
<style>
  *{{box-sizing:border-box;}} body{{margin:0;padding:32px 24px 64px;background:{ed.PAGE};
    font-family:{ed.FONT};color:{ed.INK900};}}
  header{{max-width:1400px;margin:0 auto 20px;}} header h1{{margin:0 0 4px;font-size:24px;letter-spacing:-0.4px;}}
  header p{{margin:0;color:{ed.INK400};font-size:14px;}}
  h2{{max-width:1400px;margin:34px auto 14px;font-size:15px;text-transform:uppercase;letter-spacing:0.08em;color:{ed.INK400};}}
  .grid{{max-width:1400px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:20px;}}
  .card{{background:{ed.CARD};border:1px solid {ed.RULE};border-radius:12px;overflow:hidden;}}
  .head{{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid {ed.RULE};}}
  .head h3{{flex:1;margin:0;font-size:13px;font-weight:600;}}
  .head a{{font-size:12px;color:{ed.ACCENT};text-decoration:none;font-weight:600;}}
  iframe{{width:100%;height:680px;border:0;display:block;background:{ed.PAGE};}}
</style></head><body>
<header><h1>{html.escape(ed.BRAND_NAME)}. Transactional email gallery</h1>
<p>{len(entries)} templates, rendered from the real senders in app.services.email_service.
Toggle your OS to dark mode to preview inversion behavior.</p></header>
{"".join(sections)}
</body></html>"""


def main() -> None:
    GALLERY_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Writing gallery to {GALLERY_DIR}\n")
    entries: list[tuple[str, str]] = []
    for i, (slug, cat, thunk) in enumerate(TEMPLATES, 1):
        htmlc = _render(thunk)
        (GALLERY_DIR / f"{slug}.html").write_text(htmlc, encoding="utf-8")
        print(f"  {i:2d}. {slug + '.html':32s} ({len(htmlc.encode()) / 1024:4.1f} KB)  [{cat}]")
        entries.append((slug, cat))
    (GALLERY_DIR / "index.html").write_text(render_index(entries), encoding="utf-8")
    print(f"\n  index.html ({len(entries)} templates)")
    print(f"\nOpen: file://{GALLERY_DIR / 'index.html'}")


if __name__ == "__main__":
    main()
