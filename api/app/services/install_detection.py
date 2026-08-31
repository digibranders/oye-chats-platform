"""Active install detection: fetch a customer domain and look for the snippet.

The install card used to answer one bit — "has any page anywhere ever loaded
this chatbot?" — from a single stamp written when the widget first called home.
That is a fine answer to "did my first paste work" and a useless one to every
question after it: which of my domains is it on, is it still on the one I put it
on last month, and is that page running somebody else's chatbot.

Passive data cannot be made to answer those. A bootstrap only arrives when a
real visitor loads a page, so silence from a domain is equally consistent with
"not installed" and "installed, quiet Tuesday" — and a widget carrying a
different ``data-bot-key`` is attributed to THAT bot and never mentions this one.
The only way to distinguish them is to go and look, which is what this module
does.

Two halves, deliberately split:

* :func:`scan_html` is pure. Given markup it reports what OyeChats snippets are
  in it. No network, no database, so the parsing rules that decide whether a
  customer is told their site is broken are testable directly.
* :func:`probe_domain` does the fetching, through
  :func:`app.core.ssrf.fetch_text_safely`.

That second point is not incidental. This feature makes the server fetch
hostnames a customer typed into a text box, which is textbook SSRF: without
guards, ``allowed_domains = ["169.254.169.254"]`` turns the "check my install"
button into a cloud-metadata reader. ``fetch_text_safely`` already carries the
defences that were built for the crawler's liveness probe — public-IP
validation, a pinned resolver so the address validated is the address connected
to (DNS rebinding), re-validation on every redirect hop, and a body cap — so
this reuses it rather than writing a second, less careful fetch.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass

from app.core.ssrf import fetch_text_safely

logger = logging.getLogger(__name__)

# The customer-facing loader filename. Fixed by the embed contract in
# CLAUDE.md ("Key Naming Conventions") and identical across the production CDN,
# a self-hosted copy and a local `vite preview`, so matching on the filename
# rather than on `cdn.oyechats.com` keeps the check working for all three.
_LOADER_FILENAME = "oyechats-widget.js"

# One <script ...> opening tag. Non-greedy to the first `>`, which is safe here
# because attribute values in real markup do not contain a bare `>` — and a
# handcrafted one that did would cost us a missed detection, never a false
# "installed".
_SCRIPT_TAG_RE = re.compile(r"<script\b[^>]*>", re.IGNORECASE)
_SRC_RE = re.compile(r"""\bsrc\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_BOT_KEY_RE = re.compile(r"""\bdata-bot-key\s*=\s*["']([^"']+)["']""", re.IGNORECASE)

# The consent-gated install: no `data-bot-key` on the tag, the key assigned to a
# global instead (widget/src/loader.js reads `window.OYECHATS_BOT_KEY`). Rarer
# than the standard snippet but entirely legitimate, and a checker that called
# it "not installed" would send a working customer to debug a working site.
_GLOBAL_KEY_RE = re.compile(
    r"""OYECHATS_BOT_KEY\s*=\s*["']([^"']+)["']""",
    re.IGNORECASE,
)

# How much of a page to read. The snippet is conventionally in <body>, and on a
# content-heavy page the tag can sit a long way down, but a whole marketing site
# with inlined images is not worth pulling to find one script tag.
MAX_HTML_BYTES = 1_500_000

# Per-domain ceiling. A probe of ten domains must not hold a worker for minutes.
PROBE_TIMEOUT_SECONDS = 15

# How many domains one probe run will visit. Bounds both the wall time of a
# check and the egress a single button press can buy.
MAX_DOMAINS_PER_RUN = 25


@dataclass(frozen=True)
class WidgetScan:
    """What OyeChats markup a page contains."""

    #: An OyeChats loader <script> was present at all.
    has_loader: bool
    #: Every `data-bot-key` found, in document order, deduplicated.
    bot_keys: tuple[str, ...]

    def verdict_for(self, bot_key: str) -> str:
        """Classify this page from one chatbot's point of view.

        A page carrying several snippets counts as installed for THIS bot if its
        key is among them. Multiple chatbots on one page is unusual but valid
        (a marketing site with different bots per section), and reporting the
        customer's own working install as 'foreign' because a second one is
        also there would be a false alarm on a correct setup.
        """
        if bot_key and bot_key in self.bot_keys:
            return "installed"
        if self.bot_keys or self.has_loader:
            # An OyeChats widget is here, but not this one. `has_loader` with no
            # key at all lands here too: the loader is present and we cannot
            # prove it is ours, and claiming 'installed' on that would tick the
            # customer's setup step for somebody else's chatbot.
            return "foreign"
        return "missing"


def scan_html(html: str) -> WidgetScan:
    """Find OyeChats widget snippets in served markup.

    Reads the HTML as delivered, which is the honest limit of this check and
    worth being explicit about: a site that injects its snippet from JavaScript
    after load (a tag manager, a consent tool, a client-rendered app) serves
    markup with no script tag in it, and is correctly reported as 'missing' here
    while being perfectly installed for a real visitor. The dashboard has to
    present a probe result as what it is — one fetch, one moment, no JavaScript
    — rather than as a verdict on the customer's website.
    """
    if not html:
        return WidgetScan(has_loader=False, bot_keys=())

    has_loader = False
    keys: list[str] = []

    for tag in _SCRIPT_TAG_RE.finditer(html):
        raw = tag.group(0)
        src_match = _SRC_RE.search(raw)
        if not src_match or _LOADER_FILENAME not in src_match.group(1).lower():
            continue
        has_loader = True
        key_match = _BOT_KEY_RE.search(raw)
        if key_match:
            key = key_match.group(1).strip()
            if key and key not in keys:
                keys.append(key)

    if has_loader and not keys:
        # Only worth scanning for once the loader is confirmed present: the
        # global on its own is just a string on the page, and matching it
        # without a loader would let any page that mentions the variable name
        # read as an install.
        for match in _GLOBAL_KEY_RE.finditer(html):
            key = match.group(1).strip()
            if key and key not in keys:
                keys.append(key)

    return WidgetScan(has_loader=has_loader, bot_keys=tuple(keys))


@dataclass(frozen=True)
class ProbeResult:
    """One domain, checked once."""

    hostname: str
    status: str  # installed | foreign | missing | unreachable
    bot_key: str | None = None
    detail: str | None = None


async def _fetch_page(session, hostname: str) -> tuple[int, str] | None:
    """Fetch a customer domain, HTTPS first and HTTP only as a fallback.

    Order matters. Trying HTTP first would downgrade every check of a site that
    redirects to HTTPS anyway, and a redirect chain costs a hop from the budget
    ``fetch_text_safely`` enforces. Plain HTTP stays as a fallback rather than
    being dropped, because a customer whose staging site has no certificate has
    a real install we would otherwise report as unreachable.
    """
    for scheme in ("https", "http"):
        result = await fetch_text_safely(
            session,
            f"{scheme}://{hostname}/",
            max_bytes=MAX_HTML_BYTES,
        )
        if result is not None and result[0] < 400:
            return result
    return None


async def probe_domain(session, hostname: str, bot_key: str) -> ProbeResult:
    """Fetch one domain and report what this chatbot's install looks like there.

    Never raises. A probe is diagnostic, so every failure mode — unroutable
    host, TLS error, timeout, 404, an SSRF rejection — collapses to
    ``unreachable`` with a note. The alternative, letting one bad domain abort
    the run, would mean a customer with one dead staging entry learns nothing
    about the nine live domains beside it.
    """
    try:
        fetched = await asyncio.wait_for(_fetch_page(session, hostname), timeout=PROBE_TIMEOUT_SECONDS)
    except TimeoutError:
        return ProbeResult(hostname, "unreachable", detail="The site did not respond in time.")
    except Exception:
        logger.debug("probe failed for %s", hostname, exc_info=True)
        return ProbeResult(hostname, "unreachable", detail="We could not reach this domain.")

    if fetched is None:
        return ProbeResult(
            hostname,
            "unreachable",
            detail="We could not reach this domain, or it is not a public address.",
        )

    status_code, html = fetched
    scan = scan_html(html)
    verdict = scan.verdict_for(bot_key)

    if verdict == "installed":
        return ProbeResult(hostname, "installed", bot_key=bot_key)
    if verdict == "foreign":
        found = scan.bot_keys[0] if scan.bot_keys else None
        return ProbeResult(
            hostname,
            "foreign",
            bot_key=found,
            detail="An OyeChats widget is on this page, but it belongs to a different chatbot.",
        )
    return ProbeResult(
        hostname,
        "missing",
        detail=(
            f"The page loaded (HTTP {status_code}) but no OyeChats snippet was in it. "
            "If you add the widget with a tag manager, we cannot see it from here."
        ),
    )
