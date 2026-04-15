import html
import logging
import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.auth import get_current_bot, get_current_client_or_operator
from app.core.cache import bot_config_key, cache_delete
from app.db.models import Bot, BotGrowthEvent
from app.db.session import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bots", tags=["bots"])
public_router = APIRouter(tags=["bots"])
DEMO_EVENT_TYPES = {"demo_share_clicked", "demo_link_opened"}


def _get_workspace_bot(session, bot_id: int, client_id: int) -> Bot:
    bot = session.execute(select(Bot).where(Bot.id == bot_id, Bot.client_id == client_id)).scalars().first()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot not found.")
    return bot


def _require_bot_management_access(auth: dict) -> None:
    """Allow workspace owners/admins to manage bots while keeping regular agents read-only."""
    if auth["type"] == "client":
        return

    if getattr(auth["entity"], "role", "operator") not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="You do not have permission to manage bots.")


def _record_growth_event(session, bot_id: int, event_type: str) -> None:
    if event_type not in DEMO_EVENT_TYPES:
        raise ValueError(f"Unsupported growth event type: {event_type}")
    session.add(BotGrowthEvent(bot_id=bot_id, event_type=event_type))


# ── Request / Response Models ──


class CreateBotRequest(BaseModel):
    name: str = "AI Assistant"
    website: str | None = None
    system_prompt: str | None = None
    bant_enabled: bool = True


class UpdateBotRequest(BaseModel):
    name: str | None = None
    # max_length matches _MAX_CUSTOM_PROMPT_CHARS in rag_service — enforced at API boundary
    system_prompt: str | None = Field(None, max_length=2000)
    brand_tone: str | None = Field(None, max_length=500)
    company_name: str | None = Field(None, max_length=100)
    company_description: str | None = Field(None, max_length=1000)
    website: str | None = None
    bot_logo: str | None = None
    launcher_name: str | None = None
    launcher_logo: str | None = None
    primary_color: str | None = None
    background_color: str | None = None
    header_color: str | None = None
    user_bubble_color: str | None = None
    bant_enabled: bool | None = None
    bant_config: dict | None = None
    qualification_framework: str | None = None
    avatar_type: str | None = None
    orb_color: str | None = None
    # Lead form settings
    lead_form_enabled: bool | None = None
    lead_form_fields: list[dict] | None = None
    # Email notification settings
    notification_email: str | None = None
    notification_emails: dict | None = None
    reply_to_email: str | None = None
    email_on_qualified: bool | None = None
    email_on_handoff: bool | None = None
    email_on_offline: bool | None = None
    email_visitor_confirmation: bool | None = None
    # Live chat settings
    live_chat_enabled: bool | None = None
    operator_timeout_seconds: int | None = None
    # Business hours
    business_hours: dict | None = None
    # Feature flags — partial merge applied on PATCH (existing flags are preserved)
    feature_flags: dict | None = None
    # Widget messages — all customizable user-facing strings
    widget_messages: dict | None = None
    # Widget configuration — timing, thresholds, advanced settings
    widget_config: dict | None = None
    # Branding customization
    branding_text: str | None = None
    branding_url: str | None = None
    # Configurable visitor-facing messages
    welcome_title: str | None = None
    welcome_subtitle: str | None = None
    waiting_message: str | None = None
    offline_message: str | None = None
    handoff_delay_seconds: int | None = None
    calendly_url: str | None = None
    meeting_booking_enabled: bool | None = None


class BotResponse(BaseModel):
    id: int
    bot_key: str
    name: str
    website: str | None
    system_prompt: str | None
    brand_tone: str | None = None
    bot_logo: str | None
    launcher_name: str
    launcher_logo: str | None
    primary_color: str
    background_color: str
    header_color: str
    recommended_colors: list | None
    user_bubble_color: str = "#DBE9FF"
    bant_enabled: bool
    bant_config: dict | None = None
    avatar_type: str
    orb_color: str | None
    lead_form_enabled: bool = False
    lead_form_fields: list[dict] | None = None
    notification_email: str | None = None
    notification_emails: dict | None = None
    reply_to_email: str | None = None
    email_on_qualified: bool = True
    email_on_handoff: bool = True
    email_on_offline: bool = True
    email_visitor_confirmation: bool = True
    live_chat_enabled: bool = True
    operator_timeout_seconds: int = 120
    business_hours: dict | None = None
    feature_flags: dict = {}
    widget_messages: dict = {}
    widget_config: dict = {}
    branding_text: str = "Powered by OyeChats"
    branding_url: str = "https://oyechats.com"
    # Configurable visitor-facing messages
    welcome_title: str = "Hi there 👋"
    welcome_subtitle: str = "How can we help you today?"
    waiting_message: str = "Connecting you to support..."
    offline_message: str = "Our team is currently unavailable."
    handoff_delay_seconds: int = 0
    calendly_url: str | None = None
    meeting_booking_enabled: bool = False
    is_active: bool
    created_at: str

    class Config:
        from_attributes = True


# ── Endpoints ──

# IMPORTANT: Static sub-paths MUST be defined before /{bot_id} dynamic routes
# to prevent FastAPI from trying to parse "settings" as an integer bot_id.


@router.get("/settings/public")
def get_bot_settings_public(request: Request, bot: Bot = Depends(get_current_bot)):
    """
    Public endpoint for the widget to fetch bot settings.
    Authenticated via X-Bot-Key or X-API-Key (backward compat).
    """
    # Construct backend file URL for relative logos
    logo_url = bot.bot_logo
    if logo_url and not logo_url.startswith("http"):
        logo_url = f"{str(request.base_url).rstrip('/')}/files/{logo_url}"

    launcher_logo_url = bot.launcher_logo
    if launcher_logo_url and not launcher_logo_url.startswith("http"):
        launcher_logo_url = f"{str(request.base_url).rstrip('/')}/files/{launcher_logo_url}"

    return {
        "bot_name": bot.name,
        "bot_logo": logo_url,
        "launcher_name": bot.launcher_name or "Have Questions?",
        "launcher_logo": launcher_logo_url,
        "primary_color": bot.primary_color or "#ba68c8",
        "background_color": bot.background_color or "#ffffff",
        "header_color": bot.header_color or "#3A0CA3",
        "recommended_colors": bot.recommended_colors or [],
        "user_bubble_color": bot.user_bubble_color or "#DBE9FF",
        "bant_enabled": bot.bant_enabled,
        "avatar_type": bot.avatar_type or "upload",
        "orb_color": bot.orb_color,
        "lead_form_enabled": bot.lead_form_enabled,
        "lead_form_fields": bot.lead_form_fields,
        "live_chat_enabled": bot.live_chat_enabled,
        "business_hours": bot.business_hours,
        "feature_flags": bot.feature_flags or {},
        "widget_messages": bot.widget_messages or {},
        "widget_config": bot.widget_config or {},
        "branding_text": bot.branding_text or "Powered by OyeChats",
        "branding_url": bot.branding_url or "https://oyechats.com",
        "welcome_title": bot.welcome_title or "Hi there 👋",
        "welcome_subtitle": bot.welcome_subtitle or "How can we help you today?",
        "waiting_message": bot.waiting_message or "Connecting you to support...",
        "offline_message": bot.offline_message or "Our team is currently unavailable.",
        "handoff_delay_seconds": bot.handoff_delay_seconds or 0,
        "bant_cta_options": _build_public_cta_options(bot),
    }


def _build_public_cta_options(bot) -> dict:
    """Build sanitized CTA options for the widget (no scoring rubric exposed)."""
    from app.services.lead_service import get_bant_config

    config = get_bant_config(bot)
    cta_options = {}
    for dim in ["need", "timeline", "authority", "budget"]:
        dim_config = config.get(dim, {})
        if dim_config.get("cta_enabled", False):
            cta_options[dim] = {
                "prompt": dim_config.get("cta_prompt", ""),
                "options": [o["label"] for o in dim_config.get("options", [])],
            }
    return cta_options


def _build_demo_page_html(bot: Bot) -> str:
    bot_name = html.escape(bot.name or "OyeChats")
    website = (bot.website or "").strip()
    website_link = ""
    if website.startswith(("http://", "https://")):
        safe_website = html.escape(website)
        website_link = (
            f'<a class="demo-link" href="{safe_website}" target="_blank" rel="noopener noreferrer">'
            f"Visit {safe_website}</a>"
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{bot_name} Demo | OyeChats</title>
  <meta name="description" content="Try the {bot_name} assistant powered by OyeChats." />
  <style>
    :root {{
      color-scheme: light;
      --ink: #102033;
      --muted: #5a6b7f;
      --panel: rgba(255, 255, 255, 0.9);
      --line: rgba(16, 32, 51, 0.08);
      --accent: #0f6dff;
      --accent-strong: #0a56ca;
      --bg-a: #eff6ff;
      --bg-b: #f8fafc;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 109, 255, 0.18), transparent 36%),
        radial-gradient(circle at bottom right, rgba(56, 189, 248, 0.16), transparent 34%),
        linear-gradient(135deg, var(--bg-a), var(--bg-b));
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }}
    .shell {{
      width: min(960px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.14);
      overflow: hidden;
      backdrop-filter: blur(20px);
    }}
    .hero {{
      padding: 40px 40px 24px;
      display: grid;
      gap: 16px;
    }}
    .eyebrow {{
      width: fit-content;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(15, 109, 255, 0.1);
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }}
    h1 {{
      margin: 0;
      font-size: clamp(2rem, 5vw, 4rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }}
    p {{
      margin: 0;
      max-width: 680px;
      color: var(--muted);
      font-size: 1rem;
      line-height: 1.65;
    }}
    .actions {{
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 8px;
    }}
    .demo-link {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 44px;
      padding: 0 18px;
      border-radius: 999px;
      background: var(--accent);
      color: white;
      font-weight: 600;
      text-decoration: none;
      transition: background 0.18s ease;
    }}
    .demo-link:hover {{ background: var(--accent-strong); }}
    .hint {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      padding: 0 40px 40px;
    }}
    .hint-card {{
      padding: 18px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid rgba(16, 32, 51, 0.06);
    }}
    .hint-card strong {{
      display: block;
      margin-bottom: 6px;
      font-size: 0.95rem;
    }}
    .hint-card span {{
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.5;
    }}
    @media (max-width: 640px) {{
      .hero, .hint {{
        padding-left: 22px;
        padding-right: 22px;
      }}
      .hero {{ padding-top: 24px; }}
      .hint {{ padding-bottom: 22px; }}
    }}
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="eyebrow">Interactive Demo</div>
      <h1>Try {bot_name} on a live page.</h1>
      <p>This preview mirrors the production OyeChats widget for this bot. Open the chat launcher in the bottom-right corner and run a few realistic questions before you embed it on your site.</p>
      <div class="actions">
        {website_link}
      </div>
    </section>
    <section class="hint">
      <div class="hint-card">
        <strong>Ask a real question</strong>
        <span>Use the launcher to test product FAQs, support scenarios, or qualification prompts.</span>
      </div>
      <div class="hint-card">
        <strong>Share this page</strong>
        <span>Send the demo URL to teammates or prospects so they can try the bot without touching your website code.</span>
      </div>
      <div class="hint-card">
        <strong>Deploy when ready</strong>
        <span>Once the responses feel right, use the existing embed guide in the dashboard to put the same bot on your site.</span>
      </div>
    </section>
  </main>
  <script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="{html.escape(bot.bot_key)}"></script>
</body>
</html>
"""


def _validate_preview_url(raw_url: str) -> str:
    """Validate that a preview URL uses http/https and has a valid host."""
    parsed = urlparse(raw_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must use http or https scheme.")
    if not parsed.netloc:
        raise HTTPException(status_code=400, detail="Invalid URL.")
    return raw_url


def _check_iframe_allowed(target_url: str) -> bool:
    """HEAD-check whether *target_url* allows being loaded in an iframe.

    Returns ``True`` when the site does **not** block framing (or we
    cannot determine), ``False`` when ``X-Frame-Options: DENY`` or a
    ``frame-ancestors 'none'`` CSP directive is detected.  Network
    errors are treated as "allow" so the iframe gets a chance to load.
    """
    import httpx  # local import — only used in this preview path

    try:
        with httpx.Client(timeout=5, follow_redirects=True, max_redirects=5) as client:
            resp = client.head(target_url, headers={"User-Agent": "OyeChats-Preview/1.0"})
            xfo = (resp.headers.get("x-frame-options") or "").strip().upper()
            if xfo in ("DENY", "SAMEORIGIN"):
                return False
            csp = resp.headers.get("content-security-policy") or ""
            for directive in csp.split(";"):
                d = directive.strip().lower()
                if d.startswith("frame-ancestors"):
                    # "frame-ancestors 'none'" or "frame-ancestors 'self'" block us
                    parts = d.split()
                    if len(parts) >= 2 and parts[1] in ("'none'", "'self'"):
                        return False
            return True
    except Exception:
        # Network error, timeout, DNS failure — let the iframe try
        return True


def _mask_bot_key(bot_key: str) -> str:
    """Show first 6 and last 4 characters of a bot key."""
    if len(bot_key) <= 12:
        return bot_key
    return f"{bot_key[:6]}{'•' * (len(bot_key) - 10)}{bot_key[-4:]}"


def _build_preview_page_html(bot: Bot, target_url: str) -> str:
    """Build an iframe-based preview page that overlays the widget on a real website."""
    bot_name = html.escape(bot.name or "OyeChats")
    bot_key = html.escape(bot.bot_key)
    masked_key = html.escape(_mask_bot_key(bot.bot_key))
    safe_url = html.escape(target_url)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{bot_name} Preview | OyeChats</title>
  <style>
    /*
     * Scope resets to preview-shell only — never touch #oyechats-widget-root
     * or its children, as the widget ships its own self-contained styles.
     */
    .preview-shell,
    .preview-shell *,
    .preview-shell *::before,
    .preview-shell *::after {{
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }}
    html, body {{
      height: 100%;
      overflow: hidden;
      margin: 0;
      padding: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }}
    .preview-shell {{
      display: flex;
      flex-direction: column;
      height: 100vh;
    }}
    .toolbar {{
      height: 52px;
      flex-shrink: 0;
      background: #0f172a;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      padding: 0 20px;
      gap: 16px;
      font-size: 14px;
      z-index: 10;
    }}
    .toolbar-bot {{
      display: flex;
      align-items: center;
      gap: 10px;
    }}
    .toolbar-bot-icon {{
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      color: white;
    }}
    .toolbar-name {{
      font-weight: 600;
      color: #f8fafc;
    }}
    .toolbar-key {{
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 12px;
      color: #64748b;
      background: rgba(255,255,255,0.06);
      padding: 3px 8px;
      border-radius: 6px;
    }}
    .toolbar-spacer {{ flex: 1; }}
    .toolbar-brand {{
      font-size: 12px;
      color: #64748b;
      text-decoration: none;
      transition: color 0.15s;
    }}
    .toolbar-brand:hover {{ color: #94a3b8; }}
    .toolbar-badge {{
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(34,197,94,0.12);
      color: #4ade80;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }}
    .toolbar-badge::before {{
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #4ade80;
    }}
    .preview-frame {{
      width: 100%;
      flex: 1;
      border: none;
      display: block;
    }}
    .fallback {{
      display: none;
      width: 100%;
      flex: 1;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      background: #f8fafc;
      color: #334155;
      text-align: center;
      padding: 40px;
    }}
    .fallback.visible {{
      display: flex;
    }}
    .fallback h2 {{
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
    }}
    .fallback p {{
      max-width: 480px;
      font-size: 15px;
      line-height: 1.6;
      color: #64748b;
    }}
    .fallback-icon {{
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: #eff6ff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }}
  </style>
</head>
<body>
  <div class="preview-shell">
    <div class="toolbar">
      <div class="toolbar-bot">
        <div class="toolbar-bot-icon">{bot_name[0].upper()}</div>
        <span class="toolbar-name">{bot_name}</span>
      </div>
      <span class="toolbar-key">{masked_key}</span>
      <span class="toolbar-badge">Preview</span>
      <div class="toolbar-spacer"></div>
      <a class="toolbar-brand" href="https://oyechats.com" target="_blank" rel="noopener">Powered by OyeChats</a>
    </div>
    <iframe
      id="preview-frame"
      class="preview-frame"
      src="{safe_url}"
      referrerpolicy="no-referrer"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
      loading="eager"
    ></iframe>
    <div id="fallback" class="fallback">
      <div class="fallback-icon">&#x1f6e1;</div>
      <h2>Website blocked embedding</h2>
      <p>This website doesn&rsquo;t allow being loaded inside a preview frame. The chat widget is still active &mdash; try it using the launcher in the bottom-right corner.</p>
    </div>
  </div>
  <script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="{bot_key}"></script>
  <script>
    (function() {{
      var frame = document.getElementById('preview-frame');
      var fallback = document.getElementById('fallback');
      var shown = false;

      function showFallback() {{
        if (shown) return;
        shown = true;
        frame.style.display = 'none';
        fallback.classList.add('visible');
      }}

      /*
       * Detection strategy:
       * 1. Pre-flight: fetch the URL in no-cors mode.  If the server
       *    responds with an opaque response we cannot inspect headers,
       *    but a network error (DNS, TLS, etc.) rejects the promise.
       * 2. On iframe load: try to read contentWindow.length — an error
       *    page served by the browser after X-Frame-Options block
       *    typically has 0 sub-frames AND we can still read `length`
       *    (it's cross-origin accessible).  We combine this with a
       *    same-origin document check for blank/empty pages.
       * 3. Hard timeout as last-resort.
       */

      frame.addEventListener('load', function() {{
        try {{
          // Same-origin check — works when our server serves the error
          var doc = frame.contentDocument;
          if (doc) {{
            var url = doc.URL || '';
            var body = (doc.body && doc.body.innerHTML) || '';
            if (url === 'about:blank' || body.trim() === '') {{
              showFallback();
            }}
            return;
          }}
        }} catch(e) {{
          // Cross-origin: expected for external sites that DID load.
        }}
      }});

      frame.addEventListener('error', function() {{
        showFallback();
      }});

      // Hard timeout: if the iframe area is still blank after 8s,
      // show fallback.
      setTimeout(function() {{
        if (shown) return;
        try {{
          // Last-chance same-origin check
          var doc = frame.contentDocument;
          if (doc && (!doc.body || doc.body.innerHTML.trim() === '')) {{
            showFallback();
          }}
        }} catch(e) {{
          // Cross-origin: site is loaded, all good.
        }}
      }}, 8000);
    }})();
  </script>
</body>
</html>
"""


@public_router.get("/demo/{bot_key}", response_class=HTMLResponse)
def get_bot_demo_page(bot_key: str, url: str | None = Query(default=None)):
    """Render a shareable demo page, or an iframe-based preview when *url* is supplied."""
    with get_session() as session:
        bot = session.execute(select(Bot).where(Bot.bot_key == bot_key, Bot.is_active.is_(True))).scalars().first()
        if not bot:
            raise HTTPException(status_code=404, detail="Bot demo not found.")

        _record_growth_event(session, bot.id, "demo_link_opened")
        session.commit()

        if url:
            _validate_preview_url(url)
            if _check_iframe_allowed(url):
                return HTMLResponse(content=_build_preview_page_html(bot, url))
            # Site blocks framing — fall through to the hero demo page
            # so the user still sees a working widget.
        return HTMLResponse(content=_build_demo_page_html(bot))


@router.get("", response_model=list[BotResponse])
def list_bots(request: Request, auth=Depends(get_current_client_or_operator)):
    """List all bots for the authenticated client or agent's client."""
    client_id = auth["client_id"]
    with get_session() as session:
        stmt = select(Bot).where(Bot.client_id == client_id).order_by(Bot.id)
        bots = session.execute(stmt).scalars().all()
        bots_response = []
        for b in bots:
            bl = b.bot_logo
            if bl and not bl.startswith("http"):
                bl = f"{str(request.base_url).rstrip('/')}/files/{bl}"
            ll = b.launcher_logo
            if ll and not ll.startswith("http"):
                ll = f"{str(request.base_url).rstrip('/')}/files/{ll}"

            bots_response.append(
                BotResponse(
                    id=b.id,
                    bot_key=b.bot_key,
                    name=b.name,
                    website=b.website,
                    system_prompt=b.system_prompt,
                    bot_logo=bl,
                    launcher_name=b.launcher_name or "Have Questions?",
                    launcher_logo=ll,
                    primary_color=b.primary_color or "#ba68c8",
                    background_color=b.background_color or "#ffffff",
                    header_color=b.header_color or "#3A0CA3",
                    recommended_colors=b.recommended_colors or [],
                    user_bubble_color=b.user_bubble_color or "#DBE9FF",
                    bant_enabled=b.bant_enabled,
                    bant_config=b.bant_config,
                    avatar_type=b.avatar_type or "upload",
                    orb_color=b.orb_color,
                    lead_form_enabled=b.lead_form_enabled,
                    lead_form_fields=b.lead_form_fields,
                    notification_email=b.notification_email,
                    notification_emails=b.notification_emails,
                    reply_to_email=b.reply_to_email,
                    email_on_qualified=b.email_on_qualified,
                    email_on_handoff=b.email_on_handoff,
                    email_on_offline=b.email_on_offline,
                    email_visitor_confirmation=b.email_visitor_confirmation,
                    live_chat_enabled=b.live_chat_enabled,
                    operator_timeout_seconds=b.operator_timeout_seconds,
                    business_hours=b.business_hours,
                    feature_flags=b.feature_flags or {},
                    widget_messages=b.widget_messages or {},
                    widget_config=b.widget_config or {},
                    branding_text=b.branding_text or "Powered by OyeChats",
                    branding_url=b.branding_url or "https://oyechats.com",
                    welcome_title=b.welcome_title or "Hi there 👋",
                    welcome_subtitle=b.welcome_subtitle or "How can we help you today?",
                    waiting_message=b.waiting_message or "Connecting you to support...",
                    offline_message=b.offline_message or "Our team is currently unavailable.",
                    handoff_delay_seconds=b.handoff_delay_seconds or 0,
                    calendly_url=b.calendly_url,
                    meeting_booking_enabled=b.meeting_booking_enabled,
                    is_active=b.is_active,
                    created_at=b.created_at.isoformat() if b.created_at else "",
                )
            )
        return bots_response


@router.post("", status_code=201)
def create_bot(request: CreateBotRequest, auth=Depends(get_current_client_or_operator)):
    """Create a new bot for the authenticated workspace."""
    _require_bot_management_access(auth)
    with get_session() as session:
        # ── Plan enforcement: check bot count limit ──
        from app.services.plan_service import UNLIMITED, get_client_plan, get_plan_limit

        plan = get_client_plan(session, auth["client_id"])
        bot_limit = get_plan_limit(plan, "bots")
        if bot_limit != UNLIMITED:
            current_bots = (
                session.execute(select(Bot).where(Bot.client_id == auth["client_id"], Bot.is_active.is_(True)))
                .scalars()
                .all()
            )
            if len(current_bots) >= bot_limit:
                raise HTTPException(
                    status_code=429,
                    detail={
                        "error": "plan_limit_exceeded",
                        "metric": "bots",
                        "used": len(current_bots),
                        "limit": bot_limit,
                        "message": f"You have reached your plan's bot limit ({bot_limit}). "
                        "Please upgrade your plan to create more bots.",
                    },
                )

        new_bot = Bot(
            client_id=auth["client_id"],
            bot_key=f"bot-{uuid.uuid4().hex[:12]}",
            name=request.name.strip() if request.name else "AI Assistant",
            website=request.website,
            system_prompt=request.system_prompt,
            bant_enabled=request.bant_enabled,
        )
        session.add(new_bot)
        session.commit()
        session.refresh(new_bot)

        logger.info(f"Workspace {auth['client_id']} created bot {new_bot.id} ({new_bot.name})")

        return {
            "message": "Bot created successfully",
            "bot_id": new_bot.id,
            "bot_key": new_bot.bot_key,
            "name": new_bot.name,
        }


@router.post("/{bot_id}/demo-share-click")
def track_demo_share_click(bot_id: int, auth=Depends(get_current_client_or_operator)):
    """Record that an authenticated workspace user copied a bot demo link."""
    _require_bot_management_access(auth)
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        _record_growth_event(session, bot.id, "demo_share_clicked")
        session.commit()
        return {"success": True, "event_type": "demo_share_clicked"}


@router.get("/{bot_id}/framework-presets")
def get_framework_presets(bot_id: int, auth=Depends(get_current_client_or_operator)):
    with get_session() as session:
        _get_workspace_bot(session, bot_id, auth["client_id"])
        from app.services.qualification_service import get_preset_frameworks

        return get_preset_frameworks()


@router.get("/{bot_id}")
def get_bot(bot_id: int, request: Request, auth=Depends(get_current_client_or_operator)):
    """Get details of a specific bot owned by the authenticated workspace."""
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        bl = bot.bot_logo
        if bl and not bl.startswith("http"):
            bl = f"{str(request.base_url).rstrip('/')}/files/{bl}"
        ll = bot.launcher_logo
        if ll and not ll.startswith("http"):
            ll = f"{str(request.base_url).rstrip('/')}/files/{ll}"

        return BotResponse(
            id=bot.id,
            bot_key=bot.bot_key,
            name=bot.name,
            website=bot.website,
            system_prompt=bot.system_prompt,
            bot_logo=bl,
            launcher_name=bot.launcher_name or "Have Questions?",
            launcher_logo=ll,
            primary_color=bot.primary_color or "#ba68c8",
            background_color=bot.background_color or "#ffffff",
            header_color=bot.header_color or "#3A0CA3",
            recommended_colors=bot.recommended_colors or [],
            user_bubble_color=bot.user_bubble_color or "#DBE9FF",
            bant_enabled=bot.bant_enabled,
            bant_config=bot.bant_config,
            avatar_type=bot.avatar_type or "upload",
            orb_color=bot.orb_color,
            lead_form_enabled=bot.lead_form_enabled,
            lead_form_fields=bot.lead_form_fields,
            notification_email=bot.notification_email,
            notification_emails=bot.notification_emails,
            reply_to_email=bot.reply_to_email,
            email_on_qualified=bot.email_on_qualified,
            email_on_handoff=bot.email_on_handoff,
            email_on_offline=bot.email_on_offline,
            email_visitor_confirmation=bot.email_visitor_confirmation,
            live_chat_enabled=bot.live_chat_enabled,
            operator_timeout_seconds=bot.operator_timeout_seconds,
            business_hours=bot.business_hours,
            feature_flags=bot.feature_flags or {},
            widget_messages=bot.widget_messages or {},
            widget_config=bot.widget_config or {},
            branding_text=bot.branding_text or "Powered by OyeChats",
            branding_url=bot.branding_url or "https://oyechats.com",
            welcome_title=bot.welcome_title or "Hi there 👋",
            welcome_subtitle=bot.welcome_subtitle or "How can we help you today?",
            waiting_message=bot.waiting_message or "Connecting you to support...",
            offline_message=bot.offline_message or "Our team is currently unavailable.",
            handoff_delay_seconds=bot.handoff_delay_seconds or 0,
            calendly_url=bot.calendly_url,
            meeting_booking_enabled=bot.meeting_booking_enabled,
            is_active=bot.is_active,
            created_at=bot.created_at.isoformat() if bot.created_at else "",
        )


@router.patch("/{bot_id}")
def update_bot(bot_id: int, request: UpdateBotRequest, auth=Depends(get_current_client_or_operator)):
    """Update settings for a specific bot."""
    try:
        _require_bot_management_access(auth)
        with get_session() as session:
            bot = _get_workspace_bot(session, bot_id, auth["client_id"])

            update_data = request.dict(exclude_unset=True)
            logger.info(f"Updating bot {bot_id} | fields: {list(update_data.keys())}")

            # Sync logos
            if "bot_logo" in update_data:
                update_data["launcher_logo"] = update_data["bot_logo"]
            elif "launcher_logo" in update_data:
                update_data["bot_logo"] = update_data["launcher_logo"]

            # Merge feature_flags — partial updates must not wipe existing flags
            if "feature_flags" in update_data and update_data["feature_flags"] is not None:
                current_flags = dict(bot.feature_flags or {})
                current_flags.update(update_data.pop("feature_flags"))
                bot.feature_flags = current_flags

            # Merge widget_messages — partial updates must not wipe existing messages
            if "widget_messages" in update_data and update_data["widget_messages"] is not None:
                current_messages = dict(bot.widget_messages or {})
                current_messages.update(update_data.pop("widget_messages"))
                bot.widget_messages = current_messages

            # Merge widget_config — partial updates must not wipe existing config
            if "widget_config" in update_data and update_data["widget_config"] is not None:
                current_config = dict(bot.widget_config or {})
                current_config.update(update_data.pop("widget_config"))
                bot.widget_config = current_config

            # Framework selection is stored under bant_config.framework for backward compatibility
            selected_framework = update_data.pop("qualification_framework", None)
            if selected_framework is not None:
                merged_bant_config = dict(bot.bant_config or {})
                merged_bant_config["framework"] = selected_framework
                bot.bant_config = merged_bant_config

            if "bant_config" in update_data and update_data["bant_config"] is not None:
                incoming_bant = dict(update_data["bant_config"])
                merged_bant = dict(bot.bant_config or {})
                merged_bant.update(incoming_bant)
                bot.bant_config = merged_bant
                update_data.pop("bant_config")

            for key, value in update_data.items():
                setattr(bot, key, value)

            session.commit()
            # Invalidate cached bot config so widget picks up changes immediately
            cache_delete(bot_config_key(bot.bot_key))
            logger.info(f"Bot {bot_id} settings saved successfully by workspace {auth['client_id']}")
            return {"message": "Bot settings updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update bot {bot_id}: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to save bot settings.") from e


@router.delete("/{bot_id}")
def delete_bot(bot_id: int, auth=Depends(get_current_client_or_operator)):
    """Delete a bot and all its data (documents, sessions, messages)."""
    _require_bot_management_access(auth)
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])

        bot_key_val = bot.bot_key
        session.delete(bot)
        session.commit()
        cache_delete(bot_config_key(bot_key_val))
        logger.info(f"Bot {bot_id} deleted by workspace {auth['client_id']}")
        return {"message": "Bot deleted successfully"}
