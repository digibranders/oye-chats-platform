"""The three HTML pages a bot can be shown on, and the guards around them.

``GET /demo/{bot_key}`` renders one of three things: the customer's own site in
an iframe with the widget over it, a stored full-page screenshot with the
widget over it, or a generic hero page. Which one is decided by the route in
``bot_routes``; how each is built lives here.

This is 770 lines of f-string HTML plus the URL guards that decide whether a
site may be framed at all. It sat in ``bot_routes.py`` and was 19% of that
file, sharing nothing with bot CRUD, checkout, install or recrawl beyond the
``Bot`` model. It is the only consumer of ``html``, ``socket``, ``ipaddress``,
``HTMLResponse``, ``SSRFError`` and the screenshot config in the whole module.

The route stays where it is on purpose. Tests monkeypatch
``bot_routes._check_iframe_allowed`` and ``bot_routes._validate_preview_url``
19 times between them; the route resolves those names from ``bot_routes``'s own
globals, so importing them there keeps every one of those patches working. A
split that quietly turned 19 regression guards into no-ops would be a worse
file layout, not a better one.
"""

from __future__ import annotations

import html
import ipaddress
import logging
import socket
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

from fastapi import HTTPException

from app.config import DEMO_SCREENSHOT_ENABLED, DEMO_SCREENSHOT_TTL_DAYS
from app.config import WIDGET_SCRIPT_URL as CONFIGURED_WIDGET_SCRIPT_URL
from app.core.origin_check import extract_hostname, is_origin_allowed
from app.core.ssrf import SSRFError, validate_public_url
from app.db.models import Bot

logger = logging.getLogger(__name__)


def _demo_url_belongs_to_bot(bot: Bot, raw_url: str) -> bool:
    """Is ``raw_url`` a site this bot is entitled to have previewed?

    Accepts the bot's own ``website`` (with the usual apex/``www.``
    equivalence) and anything on its configured ``allowed_domains``. Everything
    else is refused.

    The guard exists because ``/demo/{bot_key}`` is unauthenticated and its key
    is public by design: it ships in every embed snippet and is printed on the
    Deploy page. Without this, that key is all anyone needs to serve arbitrary
    third-party content from an oyechats.com URL under a "Powered by OyeChats"
    toolbar.

    Note this is deliberately independent of ``domain_check_enabled``. That
    flag governs whether the WIDGET refuses to boot on a foreign origin, and it
    fails open on an empty allow-list so a new bot still works. Failing open
    here would reinstate exactly the abuse this prevents, so an empty
    allow-list simply means the bot's own website is the only previewable site.
    """
    host = extract_hostname(raw_url)
    if not host:
        return False
    host = host.lower()

    own_host = extract_hostname(bot.website) if bot.website else None
    if not own_host and bot.website:
        # ``website`` is very often stored as a bare hostname, which
        # ``extract_hostname`` cannot read without a scheme.
        own_host = extract_hostname(f"https://{bot.website.strip()}")
    if own_host:
        own_host = own_host.lower()
        if host == own_host:
            return True
        # Apex and ``www.`` are the same site to everyone except a string
        # comparison, and customers store whichever one they typed.
        if host.removeprefix("www.") == own_host.removeprefix("www."):
            return True

    allowed = bot.allowed_domains or []
    return is_origin_allowed(host, allowed)


def _demo_capture_is_usable(bot: Bot) -> bool:
    """Should the demo page render this bot's stored capture?

    Staleness is checked here rather than only at capture time because the
    capture is refreshed by training, and a bot that stopped being retrained
    would otherwise show a screenshot of a site design its owner replaced
    long ago. Past the TTL the hero page is the more honest answer, and the
    next training run (or an explicit recapture) restores the real one.

    A capture of a DIFFERENT site than the bot currently points at is never
    usable, no matter how recent: that is the case where showing it would be
    actively misleading rather than merely dated.
    """
    if not DEMO_SCREENSHOT_ENABLED or not bot.demo_screenshot_url:
        return False
    if bot.demo_screenshot_status != "ready":
        return False

    current = (bot.website or "").strip().lower().removeprefix("https://").removeprefix("http://").rstrip("/")
    captured = (
        (bot.demo_screenshot_source_url or "").strip().lower().removeprefix("https://").removeprefix("http://")
    ).rstrip("/")
    if current and captured and current.removeprefix("www.") != captured.removeprefix("www."):
        return False

    captured_at = bot.demo_screenshot_captured_at
    if captured_at is None:
        return False
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=UTC)
    return captured_at > datetime.now(UTC) - timedelta(days=DEMO_SCREENSHOT_TTL_DAYS)


def _widget_script_tag(bot_key: str) -> str:
    """The demo page's own copy of the embed snippet.

    Sourced from config rather than hardcoded to the production CDN: a local or
    staging demo page used to load the LIVE widget build, so the one surface
    whose whole job is showing what the customer will get was the one surface
    that could not show a change before it shipped.
    """
    return f'<script src="{html.escape(CONFIGURED_WIDGET_SCRIPT_URL)}" data-bot-key="{html.escape(bot_key)}"></script>'


def _build_screenshot_demo_page_html(bot: Bot, edit: bool = False) -> str:
    """The customer's own website, captured, with the real widget live on top.

    This is the demo page proper. The backdrop is a full-page capture of their
    site stored on our CDN (see ``screenshot_service``), drawn inside light
    browser chrome so nobody mistakes it for the live site, and the widget on
    top is the real one loaded by bot key. Everything the visitor clicks in the
    widget is real; the page behind it is a picture.

    A capture rather than an iframe because roughly 40% of sites forbid framing
    outright, and a demo that fails in front of a prospect is worse than no
    demo. This is also what LiveChat does.
    """
    bot_name = html.escape(bot.name or "OyeChats")
    shot_url = html.escape(bot.demo_screenshot_url or "")
    source_url = bot.demo_screenshot_source_url or bot.website or ""
    display_host = html.escape(urlparse(source_url).hostname or source_url or "your website")
    safe_source = html.escape(source_url) if source_url.startswith(("http://", "https://")) else ""
    visit_link = (
        f'<a class="chrome-visit" href="{safe_source}" target="_blank" rel="noopener noreferrer">Open the real site</a>'
        if safe_source
        else ""
    )
    editor_bootstrap = _PREVIEW_EDITOR_BOOTSTRAP if edit else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{bot_name} Demo | OyeChats</title>
  <meta name="description" content="Try the {bot_name} assistant on {display_host}, powered by OyeChats." />
  <meta name="robots" content="noindex" />
  <style>
    /*
     * Scope every reset to the demo shell. Never touch #oyechats-widget-root
     * or its children: the widget ships its own self-contained styles and
     * renders into a shadow root.
     */
    .demo-shell, .demo-shell *, .demo-shell *::before, .demo-shell *::after {{
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }}
    html, body {{
      margin: 0;
      padding: 0;
      background: #eef2f7;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    .demo-shell {{ min-height: 100vh; }}
    .chrome {{
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 12px;
      height: 44px;
      padding: 0 16px;
      background: #f8fafc;
      border-bottom: 1px solid rgba(15, 23, 42, 0.1);
    }}
    .chrome-dots {{ display: flex; gap: 6px; flex-shrink: 0; }}
    .chrome-dots i {{
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #d7dee8;
      display: block;
    }}
    .chrome-address {{
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
      height: 28px;
      padding: 0 12px;
      border-radius: 999px;
      background: #ffffff;
      border: 1px solid rgba(15, 23, 42, 0.08);
      color: #475569;
      font-size: 12.5px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }}
    .chrome-lock {{ flex-shrink: 0; color: #64748b; font-size: 11px; }}
    .chrome-tag {{
      flex-shrink: 0;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(15, 109, 255, 0.1);
      color: #0a56ca;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }}
    .chrome-visit {{
      flex-shrink: 0;
      color: #475569;
      font-size: 12px;
      text-decoration: none;
      white-space: nowrap;
    }}
    .chrome-visit:hover {{ color: #0f172a; text-decoration: underline; }}
    .shot {{
      display: block;
      width: 100%;
      height: auto;
      /* The capture is a picture of a page, not an interactive one. Saying so
         with the cursor is cheaper than a visitor discovering it by clicking. */
      cursor: default;
      user-select: none;
    }}
    .note {{
      padding: 14px 16px 96px;
      text-align: center;
      color: #64748b;
      font-size: 12.5px;
      line-height: 1.6;
    }}
    @media (max-width: 640px) {{
      .chrome-tag, .chrome-visit {{ display: none; }}
    }}
  </style>
</head>
<body>
  <div class="demo-shell">
    <div class="chrome">
      <div class="chrome-dots"><i></i><i></i><i></i></div>
      <div class="chrome-address"><span class="chrome-lock">&#x1f512;</span>{display_host}</div>
      <span class="chrome-tag">Demo</span>
      {visit_link}
    </div>
    <img class="shot" src="{shot_url}" alt="A preview image of {display_host}" draggable="false" />
    <p class="note">
      This is a picture of {display_host}. The chat in the corner is live &mdash; open it and ask a question.
    </p>
  </div>
  {editor_bootstrap}{_widget_script_tag(bot.bot_key)}
</body>
</html>
"""


def _build_demo_page_html(bot: Bot, edit: bool = False) -> str:
    bot_name = html.escape(bot.name or "OyeChats")
    website = (bot.website or "").strip()
    website_link = ""
    if website.startswith(("http://", "https://")):
        safe_website = html.escape(website)
        website_link = (
            f'<a class="demo-link" href="{safe_website}" target="_blank" rel="noopener noreferrer">'
            f"Visit {safe_website}</a>"
        )
    editor_bootstrap = _PREVIEW_EDITOR_BOOTSTRAP if edit else ""

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
  {editor_bootstrap}{_widget_script_tag(bot.bot_key)}
</body>
</html>
"""


def _validate_preview_url(raw_url: str) -> str:
    """Validate that a preview URL uses http/https, has a valid host, and does not resolve to a private IP.

    Blocks SSRF by resolving the hostname and rejecting private, loopback,
    link-local, and other reserved IP ranges before allowing server-side requests.
    """
    parsed = urlparse(raw_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="URL must use http or https scheme.")
    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=400, detail="Invalid URL.")

    try:
        addr_info = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="Could not resolve hostname.") from exc

    for _family, _type, _proto, _canonname, sockaddr in addr_info:
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(status_code=400, detail="URLs pointing to internal addresses are not allowed.")

    return raw_url


def _check_iframe_allowed(target_url: str) -> bool:
    """HEAD-check whether *target_url* allows being loaded in an iframe.

    Returns ``True`` when the site does **not** block framing (or we
    cannot determine), ``False`` when ``X-Frame-Options: DENY`` or a
    ``frame-ancestors 'none'`` CSP directive is detected.  Network
    errors are treated as "allow" so the iframe gets a chance to load.
    """
    import httpx  # local import. Only used in this preview path

    # Re-validate here (defence in depth) and. Crucially. Do NOT follow
    # redirects: the initial URL passed _validate_preview_url, but a 3xx could
    # bounce the server-side request to an internal address. A redirect is
    # surfaced as-is (its 3xx response carries no framing headers → "allow").
    # (audit F11)
    try:
        validate_public_url(target_url)
    except SSRFError:
        return False

    try:
        with httpx.Client(timeout=5, follow_redirects=False) as client:
            resp = client.head(target_url, headers={"User-Agent": "OyeChats-Preview/1.0"})
            # A redirect (http→https, apex→www. Near-universal): we intentionally
            # don't follow it (SSRF), so we can't read the final page's framing
            # headers. Report not-embeddable so the demo serves the working hero
            # fallback instead of embedding a page that likely blocks framing
            # (code-review RV6).
            if 300 <= resp.status_code < 400:
                return False
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
        # Network error, timeout, DNS failure. Let the iframe try
        return True


def _mask_bot_key(bot_key: str) -> str:
    """Show first 6 and last 4 characters of a bot key."""
    if len(bot_key) <= 12:
        return bot_key
    return f"{bot_key[:6]}{'•' * (len(bot_key) - 10)}{bot_key[-4:]}"


_PREVIEW_EDITOR_BOOTSTRAP = "<script>window.__OYECHATS_PREVIEW_MODE__=true;</script>\n"


def _build_preview_page_html(bot: Bot, target_url: str, edit: bool = False) -> str:
    """Build an iframe-based preview page that overlays the widget on a real website.

    When *edit* is True, a bootstrap flag is injected so the widget enables its
    live-preview bridge (accepts `oyechats:preview-config` postMessage events
    from the parent frame. Typically the admin dashboard editor).
    """
    bot_name = html.escape(bot.name or "OyeChats")
    masked_key = html.escape(_mask_bot_key(bot.bot_key))
    safe_url = html.escape(target_url)
    editor_bootstrap = _PREVIEW_EDITOR_BOOTSTRAP if edit else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{bot_name} Preview | OyeChats</title>
  <style>
    /*
     * Scope resets to preview-shell only, never touch #oyechats-widget-root
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
      <a class="toolbar-brand" href="https://www.oyechats.com" target="_blank" rel="noopener">Powered by OyeChats</a>
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
  {editor_bootstrap}{_widget_script_tag(bot.bot_key)}
  <script>
    (function() {{
      var frame = document.getElementById('preview-frame');
      var fallback = document.getElementById('fallback');
      var shown = false;
      var reported = false;

      /*
       * Report the INNER frame's fate to whoever embedded this page (the
       * dashboard's preview dialog).
       *
       * This exists because the dialog used to infer "your site blocked
       * embedding" from the widget's own `oyechats:preview-ready` message.
       * The widget lives on THIS page, not on the customer's site, so it
       * reports ready whether or not the site below it rendered, and the
       * warning it was supposed to drive was effectively unreachable in
       * exactly the case it was written for.
       *
       * Targeted at the referrer's origin rather than '*' so the state of a
       * customer's site is not broadcast to any arbitrary embedder.
       */
      function report(ok) {{
        if (reported) return;
        reported = true;
        try {{
          if (window.parent === window) return;
          var target = '*';
          if (document.referrer) {{
            try {{ target = new URL(document.referrer).origin; }} catch (e) {{ /* keep '*' */ }}
          }}
          window.parent.postMessage({{ type: 'oyechats:preview-site', ok: !!ok }}, target);
        }} catch (e) {{ /* never let reporting break the preview */ }}
      }}

      function showFallback() {{
        if (shown) return;
        shown = true;
        frame.style.display = 'none';
        fallback.classList.add('visible');
        report(false);
      }}

      /*
       * Detection strategy:
       * 1. Pre-flight: fetch the URL in no-cors mode.  If the server
       *    responds with an opaque response we cannot inspect headers,
       *    but a network error (DNS, TLS, etc.) rejects the promise.
       * 2. On iframe load: try to read contentWindow.length, an error
       *    page served by the browser after X-Frame-Options block
       *    typically has 0 sub-frames AND we can still read `length`
       *    (it's cross-origin accessible).  We combine this with a
       *    same-origin document check for blank/empty pages.
       * 3. Hard timeout as last-resort.
       */

      frame.addEventListener('load', function() {{
        try {{
          // Same-origin check. Works when our server serves the error
          var doc = frame.contentDocument;
          if (doc) {{
            var url = doc.URL || '';
            var body = (doc.body && doc.body.innerHTML) || '';
            if (url === 'about:blank' || body.trim() === '') {{
              showFallback();
            }} else {{
              report(true);
            }}
            return;
          }}
        }} catch(e) {{
          // Cross-origin: expected for external sites that DID load.
          report(true);
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
          report(true);
        }}
      }}, 8000);
    }})();
  </script>
</body>
</html>
"""
