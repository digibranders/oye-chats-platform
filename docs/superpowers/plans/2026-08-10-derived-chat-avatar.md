# Derived Chat Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a website crawl, derive the customer's brand mark from their homepage markup and use it as the AI Agent's chat avatar — but only ever as a default, never overwriting an avatar the customer chose.

**Architecture:** A new `site_icon_extractor` service parses the homepage for icon `<link>` tags, ranks candidates (`apple-touch-icon` → manifest → `rel=icon` → `favicon.ico`), fetches the winner through an SSRF-guarded byte fetcher, validates it with Pillow, normalises it to a 512×512 PNG via the existing logo pipeline, and stores it in R2. The crawl orchestrator runs this as a bounded parallel task and writes the result **only when the bot's avatar slot is empty**, re-checked inside the persist transaction. Provenance lives in a new `Bot.bot_logo_source` column — never in `avatar_type`, which is a style selector the admin UI coerces.

**Tech Stack:** Python 3.11 · FastAPI · SQLAlchemy 2.0 · Alembic · aiohttp · BeautifulSoup4 · Pillow · boto3/R2 · pytest · React 19 + TypeScript (admin app)

**Spec:** `docs/superpowers/specs/2026-08-10-derived-chat-avatar-design.md` (rev 2)

> **Naming note, 2026-08-31 (documentation audit).** This plan shipped, and its task bodies are
> left unedited. One thing to know before grepping: the module landed as
> **`api/app/services/favicon_extractor.py`**, not `site_icon_extractor.py`. Every one of the
> ~50 `site_icon_extractor` references below (including the test paths) means that file. The
> behaviour is the one this plan specifies — rank `apple-touch-icon` above generic icons,
> SSRF-guarded fetch, Pillow validation, normalise through the manual-logo pipeline, and write
> only into an empty avatar slot — and `Bot.bot_logo_source` is real and enforced
> (`crawl_orchestrator.py:355,387,400`).

**Branch:** `development`. Never checkout, commit to, or push from `main`.

---

## Orientation — read before Task 1

You are working in a Python monorepo. All backend commands run from `api/`:

```bash
cd api && uv run pytest tests/test_site_icon_extractor.py -v
```

If a conda env named `oye` exists locally, prefix with `conda run -n oye --no-capture-output`. `uv` works either way.

**Things that will bite you if you skip them:**

1. **`avatar_type` is NOT provenance.** It is a style selector with exactly three legal values (`upload`, `orb`, `mascot`) read by the widget and by a three-tab segmented control in the admin. Never add a fourth value. Provenance goes in the new `bot_logo_source` column.
2. **`bot_logo` stores an R2 *object key*** (e.g. `logos/abc-123.png`), not a URL. Routes absolutise it to `/files/{key}` at read time. Store the key.
3. **`bot_logo` and `launcher_logo` move together** everywhere in this codebase. Always write both.
4. **CI runs `alembic downgrade -1`.** A migration without a working `downgrade()` fails the build.
5. **Do not edit these files** — another session owns them: `api/app/services/company_profile_service.py`, `company_markup.py`, `domain_normalizer.py`, `spider_service.py`, `llm_service.py`. Reading them is fine and `company_markup.py` is a good style reference for defensive markup parsing.

**Before reporting any task done:**

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

---

## File Structure

| File | Responsibility |
|---|---|
| `api/app/core/ssrf.py` *(modify)* | Add `fetch_bytes_safely()` — a byte-preserving sibling of `fetch_text_safely`. Shared per-hop validate/pin/connect logic extracted into one helper so the two functions cannot drift. |
| `api/app/services/site_icon_extractor.py` *(create)* | All icon logic. Three layers: pure candidate selection, network fetch + validation, and the orchestrating entry point. No DB access, no knowledge of Bot. |
| `api/app/services/crawl_orchestrator.py` *(modify)* | Launch the task, await it with a backstop timeout, write the result under the emptiness guard. |
| `api/app/db/models.py` *(modify)* | `Bot.bot_logo_source` column. |
| `api/alembic/versions/<rev>_add_bot_logo_source.py` *(create)* | One nullable `add_column` with a real `downgrade()`. |
| `api/app/api/bot_routes.py` *(modify)* | Shared source-clearing helper; call it in `update_bot`; new `POST /{bot_id}/derive-avatar`; three response payloads. |
| `api/app/api/client_routes.py` *(modify)* | Call the same source-clearing helper in the legacy settings patch. |
| `api/app/config.py` *(modify)* | `SITE_ICON_DERIVATION_ENABLED` kill switch. |
| `app/src/features/launch-studio/customize/AvatarPicker.tsx` *(modify)* | `logoSource` caption + "Use my website's icon" button. |
| `app/src/features/agents/experience/BrandingSection.tsx` *(modify)* | Wire the new props through. |
| `app/src/features/agents/experience/types.ts` *(modify)* | `botLogoSource` on the draft (read-only). |
| `app/src/features/agents/experience/ExperiencePage.tsx` *(modify)* | Refresh handler. |
| `app/src/services/api.js` *(modify)* | `deriveBotAvatar(botId)`. |

**Task order is dependency order.** Tasks 1–3 are pure/isolated and can be done in any order among themselves; 4 onward build on them.

---

## Task 1: SSRF-safe byte fetch

`fetch_text_safely` decodes bodies as UTF-8 with `errors="replace"`, which destroys image data. We need the same guarantees returning raw bytes.

**Files:**
- Modify: `api/app/core/ssrf.py`
- Test: `api/tests/test_ssrf.py`

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_ssrf.py`:

```python
import pytest

from app.core.ssrf import fetch_bytes_safely


class _FakeSession:
    """Stands in for the aiohttp session callers pass for headers/timeout."""

    headers: dict = {}
    timeout = None


@pytest.mark.asyncio
async def test_fetch_bytes_safely_rejects_private_host():
    result = await fetch_bytes_safely(_FakeSession(), "http://169.254.169.254/latest/meta-data/")
    assert result is None


@pytest.mark.asyncio
async def test_fetch_bytes_safely_rejects_non_http_scheme():
    result = await fetch_bytes_safely(_FakeSession(), "data:image/png;base64,iVBORw0KGgo=")
    assert result is None


@pytest.mark.asyncio
async def test_fetch_bytes_safely_preserves_binary_payload(monkeypatch):
    """The regression fetch_text_safely would cause: bytes must survive intact.

    A real PNG header contains 0x89, which is not valid UTF-8. Routed through a
    text decode with errors='replace' it becomes U+FFFD and the image is
    unrecoverable. This asserts the bytes come back byte-identical.
    """
    png_bytes = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 64

    async def _fake_hop(session, url, *, max_bytes):
        return 200, png_bytes

    monkeypatch.setattr("app.core.ssrf._read_body_bytes", _fake_hop)
    monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
    monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda h: "93.184.216.34")

    result = await fetch_bytes_safely(_FakeSession(), "https://example.com/icon.png")
    assert result is not None
    status, body = result
    assert status == 200
    assert body == png_bytes
    assert body[:8] == bytes.fromhex("89504e470d0a1a0a")
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && uv run pytest tests/test_ssrf.py -k fetch_bytes_safely -v
```

Expected: FAIL — `ImportError: cannot import name 'fetch_bytes_safely'`

- [ ] **Step 3: Implement**

In `api/app/core/ssrf.py`, add after `fetch_text_safely`. Note the deliberate structure: `_read_body_bytes` isolates the one hop so tests can stub it, and `_fetch_safely_raw` holds the redirect loop both public functions share.

```python
async def _read_body_bytes(session, url: str, *, max_bytes: int) -> tuple[int, bytes] | None:
    """One pinned, validated hop. Returns (status, body) or None on transport error.

    Split out so the redirect loop in :func:`_fetch_safely_raw` stays readable and
    so tests can stub a single hop without standing up an HTTP server.
    """
    import aiohttp

    hostname = urlparse(url).hostname
    try:
        pinned_ip = str(ipaddress.ip_address(hostname))
    except ValueError:
        pinned_ip = _resolve_pinned_public_ip(hostname)
    if pinned_ip is None:
        return None

    connector = aiohttp.TCPConnector(resolver=_PinnedResolver({hostname: pinned_ip}), ssl=False)
    try:
        async with (
            aiohttp.ClientSession(headers=session.headers, timeout=session.timeout, connector=connector) as pinned,
            pinned.get(url, allow_redirects=False, ssl=False) as resp,
        ):
            if resp.status in _REDIRECT_STATUSES:
                return resp.status, (resp.headers.get("Location") or "").encode()
            chunks: list[bytes] = []
            total = 0
            async for chunk in resp.content.iter_chunked(8192):
                total += len(chunk)
                if total > max_bytes:
                    break
                chunks.append(chunk)
            return resp.status, b"".join(chunks)
    except Exception:
        return None


async def fetch_bytes_safely(
    session,
    url: str,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_redirects: int = 3,
) -> tuple[int, bytes] | None:
    """Byte-preserving sibling of :func:`fetch_text_safely`.

    Same guarantees — scheme allowlist, per-hop :func:`validate_public_url`,
    DNS-pinned connection (AR-42), no auto-follow of redirects, body capped at
    ``max_bytes`` — but returns the raw body instead of a UTF-8 decode.

    Required for binary payloads: ``fetch_text_safely`` decodes with
    ``errors="replace"``, which silently corrupts every non-UTF-8 byte. A PNG
    signature alone (0x89 'PNG') does not survive it.

    Returns ``(status_code, body)`` for a final (non-redirect) response, or
    ``None`` if the URL is unsafe, too many redirects occur, or a transport
    error is raised. Never raises.
    """
    current = url
    for _ in range(max_redirects + 1):
        try:
            validate_public_url(current)
        except SSRFError:
            return None

        hop = await _read_body_bytes(session, current, max_bytes=max_bytes)
        if hop is None:
            return None
        status, body = hop
        if status in _REDIRECT_STATUSES:
            location = body.decode("utf-8", errors="ignore")
            if not location:
                return status, b""
            current = urljoin(current, location)
            continue
        return status, body
    return None  # redirect limit exceeded
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && uv run pytest tests/test_ssrf.py -v
```

Expected: PASS, including every pre-existing test in the file (you have not changed `fetch_text_safely`).

- [ ] **Step 5: Commit**

```bash
git add api/app/core/ssrf.py api/tests/test_ssrf.py
git commit -m "feat(ssrf): add fetch_bytes_safely for binary payloads

fetch_text_safely decodes with errors='replace', which corrupts any
non-UTF-8 byte — a PNG signature does not survive it. Adds a
byte-preserving sibling with identical SSRF guarantees: per-hop
validate_public_url, DNS-pinned connect (AR-42), no auto-follow, size cap."
```

---

## Task 2: Icon candidate selection (pure, no I/O)

**Files:**
- Create: `api/app/services/site_icon_extractor.py`
- Test: `api/tests/test_site_icon_extractor.py`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_site_icon_extractor.py`:

```python
"""Unit tests for deriving a chat avatar from a customer's site markup."""

from __future__ import annotations

from app.services.site_icon_extractor import select_icon_candidates

BASE = "https://example.com/"


def _urls(html: str, base: str = BASE) -> list[str]:
    return [c.url for c in select_icon_candidates(html, base)]


def test_returns_empty_for_empty_html():
    assert select_icon_candidates("", BASE) == []


def test_apple_touch_icon_outranks_rel_icon():
    html = """
    <head>
      <link rel="icon" sizes="512x512" href="/icon-512.png">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    </head>
    """
    assert _urls(html)[0] == "https://example.com/apple-touch-icon.png"


def test_apple_touch_icon_precomposed_is_same_tier():
    html = '<link rel="apple-touch-icon-precomposed" href="/atip.png">'
    assert _urls(html) == ["https://example.com/atip.png"]


def test_largest_declared_size_wins_within_a_tier():
    html = """
    <head>
      <link rel="apple-touch-icon" sizes="120x120" href="/small.png">
      <link rel="apple-touch-icon" sizes="180x180" href="/large.png">
    </head>
    """
    assert _urls(html)[0] == "https://example.com/large.png"


def test_relative_and_protocol_relative_urls_are_absolutised():
    html = """
    <link rel="apple-touch-icon" href="../icons/a.png">
    <link rel="icon" sizes="256x256" href="//cdn.example.net/b.png">
    """
    urls = _urls(html, "https://example.com/blog/index.html")
    assert "https://example.com/icons/a.png" in urls
    assert "https://cdn.example.net/b.png" in urls


def test_svg_is_rejected_by_extension_and_by_type():
    html = """
    <link rel="apple-touch-icon" href="/mark.svg">
    <link rel="icon" type="image/svg+xml" sizes="512x512" href="/mark2">
    """
    assert _urls(html) == []


def test_data_and_javascript_uris_are_rejected():
    html = """
    <link rel="apple-touch-icon" href="data:image/png;base64,iVBORw0KGgo=">
    <link rel="icon" href="javascript:alert(1)">
    <link rel="icon" href="mailto:x@example.com">
    """
    assert _urls(html) == []


def test_og_image_is_never_selected():
    html = '<meta property="og:image" content="https://example.com/banner-1200x630.png">'
    assert select_icon_candidates(html, BASE) == []


def test_absurdly_long_url_is_rejected():
    html = f'<link rel="apple-touch-icon" href="/{"a" * 600}.png">'
    assert _urls(html) == []


def test_favicon_ico_fallback_is_last_and_uses_origin_root():
    html = "<head><title>no icons here</title></head>"
    candidates = select_icon_candidates(html, "https://example.com/deep/page.html")
    assert [c.url for c in candidates] == ["https://example.com/favicon.ico"]


def test_manifest_href_is_exposed_for_the_caller_to_fetch():
    from app.services.site_icon_extractor import find_manifest_url

    html = '<link rel="manifest" href="/site.webmanifest">'
    assert find_manifest_url(html, BASE) == "https://example.com/site.webmanifest"


def test_manifest_icons_are_ranked_between_apple_touch_and_rel_icon():
    from app.services.site_icon_extractor import manifest_icon_candidates

    manifest = {
        "icons": [
            {"src": "/pwa-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/pwa-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/mono.png", "sizes": "512x512", "purpose": "monochrome"},
            {"src": "/tiny.png", "sizes": "48x48"},
        ]
    }
    urls = [c.url for c in manifest_icon_candidates(manifest, BASE)]
    assert urls == ["https://example.com/pwa-512.png", "https://example.com/pwa-192.png"]


def test_malformed_manifest_is_tolerated():
    from app.services.site_icon_extractor import manifest_icon_candidates

    assert manifest_icon_candidates(None, BASE) == []
    assert manifest_icon_candidates({"icons": "not-a-list"}, BASE) == []
    assert manifest_icon_candidates({"icons": [{"no_src": 1}]}, BASE) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && uv run pytest tests/test_site_icon_extractor.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.site_icon_extractor'`

- [ ] **Step 3: Implement**

Create `api/app/services/site_icon_extractor.py`:

```python
"""Derive a chat avatar from a customer's website markup.

The customer pastes their site URL and we crawl it to train the agent; the brand
mark is already sitting in that page's ``<head>``. This module turns it into a
512x512 PNG in our own object storage so the widget can wear the customer's brand
without them uploading anything.

Deliberately NOT favicon-first: a 16-32px favicon upscales blurry against a 40px
CSS / 80px retina avatar. The cascade prefers purpose-built square brand marks:

    A. <link rel="apple-touch-icon">        180x180, square, IS the brand mark
    B. web app manifest icons >= 96px       where modern sites keep the 512 PNG
    C. <link rel="icon"> with sizes >= 96
    D. <link rel="icon">, small/undeclared
    E. /favicon.ico at the origin root      last resort

``og:image`` is excluded on purpose: it is typically a 1200x630 banner, and a
circular avatar crop of that is a fragment of a marketing image. (``company_markup``
does read ``og:image`` — that is a company logo for visitor intelligence, a
different job with no circular-crop constraint.)

Every URL here comes from a third-party page and is therefore attacker-influenced.
See ``_reject_url`` and the SSRF-guarded fetch in :func:`fetch_icon_bytes`.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_MAX_URL_LEN = 500  # mirrors company_markup._MAX_URL_LEN

# Tier constants — lower sorts first.
_TIER_APPLE = 0
_TIER_MANIFEST = 1
_TIER_ICON_LARGE = 2
_TIER_ICON_SMALL = 3
_TIER_FAVICON = 4

# An apple-touch-icon with no declared `sizes` is 180x180 by convention.
_APPLE_ASSUMED_SIZE = 180
# Below this, an icon is not worth rendering at 80px retina — see module docstring.
_MIN_USEFUL_SIZE = 96

_SIZES_RE = re.compile(r"(\d+)\s*[x×]\s*(\d+)", re.IGNORECASE)


@dataclass(frozen=True)
class IconCandidate:
    """One ranked icon URL. Ordering is (tier, -declared_size, order)."""

    url: str
    tier: int
    declared_size: int
    order: int

    @property
    def sort_key(self) -> tuple[int, int, int]:
        return (self.tier, -self.declared_size, self.order)


def _largest_declared_size(sizes_attr: str | None) -> int:
    """Return the largest edge declared in a ``sizes`` attribute, or 0.

    ``sizes="16x16 32x32 180x180"`` -> 180. ``sizes="any"`` (SVG convention) -> 0,
    which is correct: we reject SVG anyway and an unmeasurable raster is untrusted.
    """
    if not sizes_attr:
        return 0
    best = 0
    for match in _SIZES_RE.finditer(sizes_attr):
        best = max(best, int(match.group(1)), int(match.group(2)))
    return best


def _reject_url(raw: str | None, base_url: str, declared_type: str | None = None) -> str | None:
    """Absolutise and screen a candidate URL. Returns None when unusable.

    Rejects, in order: empty, over-long, unresolvable, non-http(s) (which is what
    kills ``data:``, ``javascript:``, ``blob:`` and ``mailto:``), and SVG by either
    file extension or declared MIME type. SVG is script-bearing and is never
    fetched, decoded, or stored.
    """
    if not raw:
        return None
    href = raw.strip()
    if not href or len(href) > _MAX_URL_LEN:
        return None
    if (declared_type or "").strip().lower() == "image/svg+xml":
        return None
    try:
        absolute = urljoin(base_url, href)
    except Exception:
        return None
    if len(absolute) > _MAX_URL_LEN:
        return None
    parsed = urlparse(absolute)
    if parsed.scheme not in {"http", "https"}:
        return None
    if (parsed.path or "").lower().endswith(".svg"):
        return None
    return absolute.split("#", 1)[0]


def _rel_tokens(tag) -> set[str]:
    """``rel`` is a space-separated token list; BeautifulSoup may give str or list."""
    rel = tag.get("rel") or []
    if isinstance(rel, str):
        rel = rel.split()
    return {token.strip().lower() for token in rel}


def find_manifest_url(html: str, base_url: str) -> str | None:
    """Return the absolute ``<link rel="manifest">`` URL, or None."""
    if not html:
        return None
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        logger.debug("manifest discovery failed to parse markup", exc_info=True)
        return None
    for tag in soup.find_all("link"):
        if "manifest" in _rel_tokens(tag):
            return _reject_url(tag.get("href"), base_url)
    return None


def manifest_icon_candidates(manifest: object, base_url: str) -> list[IconCandidate]:
    """Rank the ``icons`` array of a parsed web app manifest.

    Keeps only entries at least ``_MIN_USEFUL_SIZE`` on the long edge and drops
    ``purpose: monochrome`` (a silhouette, not a brand mark). Tolerates any shape
    of malformed input — this is third-party JSON.
    """
    if not isinstance(manifest, dict):
        return []
    icons = manifest.get("icons")
    if not isinstance(icons, list):
        return []
    out: list[IconCandidate] = []
    for order, entry in enumerate(icons):
        if not isinstance(entry, dict):
            continue
        purpose = str(entry.get("purpose") or "").lower()
        if "monochrome" in purpose:
            continue
        url = _reject_url(entry.get("src"), base_url, entry.get("type"))
        if not url:
            continue
        size = _largest_declared_size(entry.get("sizes"))
        if size < _MIN_USEFUL_SIZE:
            continue
        out.append(IconCandidate(url=url, tier=_TIER_MANIFEST, declared_size=size, order=order))
    return sorted(out, key=lambda c: c.sort_key)


def select_icon_candidates(html: str, base_url: str) -> list[IconCandidate]:
    """Rank every icon candidate found in ``html``, best first.

    Does NOT include manifest icons — the caller fetches the manifest separately
    (see :func:`find_manifest_url`) and merges the result, so this function stays
    pure and synchronous.

    Always appends ``/favicon.ico`` at the origin root as the last resort; the
    size floor in :func:`fetch_icon_bytes` is what actually filters out the 32px
    ones, since a bare ``.ico`` declares no size in markup.
    """
    if not html:
        return []
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        logger.debug("icon selection failed to parse markup", exc_info=True)
        return []

    out: list[IconCandidate] = []
    for order, tag in enumerate(soup.find_all("link")):
        rel = _rel_tokens(tag)
        url = _reject_url(tag.get("href"), base_url, tag.get("type"))
        if not url:
            continue
        declared = _largest_declared_size(tag.get("sizes"))

        if {"apple-touch-icon", "apple-touch-icon-precomposed"} & rel:
            out.append(
                IconCandidate(
                    url=url,
                    tier=_TIER_APPLE,
                    declared_size=declared or _APPLE_ASSUMED_SIZE,
                    order=order,
                )
            )
        elif "icon" in rel:
            tier = _TIER_ICON_LARGE if declared >= _MIN_USEFUL_SIZE else _TIER_ICON_SMALL
            out.append(IconCandidate(url=url, tier=tier, declared_size=declared, order=order))

    parsed = urlparse(base_url)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        favicon = f"{parsed.scheme}://{parsed.netloc}/favicon.ico"
        if favicon not in {c.url for c in out}:
            out.append(IconCandidate(url=favicon, tier=_TIER_FAVICON, declared_size=0, order=10_000))

    return sorted(out, key=lambda c: c.sort_key)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && uv run pytest tests/test_site_icon_extractor.py -v
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/site_icon_extractor.py api/tests/test_site_icon_extractor.py
git commit -m "feat(avatar): rank brand-icon candidates from site markup

Pure, no-I/O candidate selection: apple-touch-icon > manifest icons >
rel=icon (>=96px) > rel=icon > /favicon.ico. og:image is excluded (1200x630
banners crop wrong into a circular avatar); SVG is rejected by extension and
by MIME type because it is script-bearing."
```

---

## Task 3: Image validation and normalisation

**Files:**
- Modify: `api/app/services/site_icon_extractor.py`
- Test: `api/tests/test_site_icon_extractor.py`

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_site_icon_extractor.py`:

```python
import io

from PIL import Image

from app.services.site_icon_extractor import validate_and_normalise_icon


def _png_bytes(width: int, height: int, mode: str = "RGB") -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, (width, height), (10, 30, 200)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_accepts_a_square_180px_png():
    result = validate_and_normalise_icon(_png_bytes(180, 180))
    assert result is not None
    normalised = Image.open(io.BytesIO(result))
    assert normalised.size == (512, 512)
    assert normalised.format == "PNG"


def test_rejects_non_image_bytes():
    assert validate_and_normalise_icon(b"<html>not an image</html>") is None


def test_rejects_empty_bytes():
    assert validate_and_normalise_icon(b"") is None


def test_rejects_image_below_the_size_floor():
    """A 32x32 favicon upscales blurry — the whole reason we do not use favicons."""
    assert validate_and_normalise_icon(_png_bytes(32, 32)) is None


def test_rejects_wide_banner_on_aspect_ratio():
    """An og:image-shaped 1200x630 would centre-crop into a fragment."""
    assert validate_and_normalise_icon(_png_bytes(1200, 630)) is None


def test_rejects_tall_image_on_aspect_ratio():
    assert validate_and_normalise_icon(_png_bytes(200, 400)) is None


def test_accepts_slightly_non_square_within_tolerance():
    assert validate_and_normalise_icon(_png_bytes(200, 180)) is not None


def test_rejects_absurd_dimensions():
    buffer = io.BytesIO()
    Image.new("RGB", (5000, 5000)).save(buffer, format="PNG")
    assert validate_and_normalise_icon(buffer.getvalue()) is None


def test_accepts_animated_gif_using_first_frame():
    buffer = io.BytesIO()
    frames = [Image.new("P", (128, 128), i) for i in range(3)]
    frames[0].save(buffer, format="GIF", save_all=True, append_images=frames[1:])
    assert validate_and_normalise_icon(buffer.getvalue()) is not None


def test_rejects_disallowed_format():
    """BMP decodes fine but is not on the allowlist."""
    buffer = io.BytesIO()
    Image.new("RGB", (256, 256)).save(buffer, format="BMP")
    assert validate_and_normalise_icon(buffer.getvalue()) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && uv run pytest tests/test_site_icon_extractor.py -k validate -v
```

Expected: FAIL — `ImportError: cannot import name 'validate_and_normalise_icon'`

- [ ] **Step 3: Implement**

Add to `api/app/services/site_icon_extractor.py`. Put the new imports at the top of the file alongside the existing ones.

```python
# --- add to the imports at the top of the file ---
import io

from PIL import Image, UnidentifiedImageError

from app.services.r2_service import process_image_for_logo
```

```python
# --- append to the module ---

# Formats we are willing to decode. Excludes SVG (never fetched) and anything
# exotic enough that Pillow's decoder is a larger attack surface than the feature
# is worth.
_ALLOWED_FORMATS = frozenset({"PNG", "JPEG", "WEBP", "ICO", "GIF"})

_MIN_EDGE_PX = 64      # below this, worse than the generic mascot at 80px retina
_MAX_EDGE_PX = 4096
_MAX_TOTAL_PX = 4096 * 4096  # decompression-bomb ceiling

# A brand mark is square. This tolerance is what makes excluding og:image a rule
# rather than a preference, and it is why the centre-crop below is safe.
_MIN_ASPECT = 0.8
_MAX_ASPECT = 1.25


def validate_and_normalise_icon(data: bytes) -> bytes | None:
    """Validate ``data`` as a usable brand mark and return a 512x512 PNG, or None.

    The content type on the wire is attacker-controlled, so this is the real gate:
    Pillow must decode it, the format must be on the allowlist, the dimensions must
    be sane, and the aspect ratio must be square-ish. Only then is it handed to the
    existing logo pipeline for the square centre-crop and resize.

    Returns None for every rejection — callers treat that as "try the next
    candidate", never as an error.
    """
    if not data:
        return None
    try:
        # verify() invalidates the object, so open twice: once to check integrity,
        # once to actually read. This is Pillow's documented pattern.
        probe = Image.open(io.BytesIO(data))
        probe.verify()

        img = Image.open(io.BytesIO(data))
        if (img.format or "").upper() not in _ALLOWED_FORMATS:
            return None

        width, height = img.size
        if not (_MIN_EDGE_PX <= width <= _MAX_EDGE_PX and _MIN_EDGE_PX <= height <= _MAX_EDGE_PX):
            return None
        if width * height > _MAX_TOTAL_PX:
            return None

        aspect = width / height
        if not (_MIN_ASPECT <= aspect <= _MAX_ASPECT):
            return None

        # Animated source: frame 0 is the brand mark, later frames are motion.
        if getattr(img, "is_animated", False):
            img.seek(0)
            frame = io.BytesIO()
            img.convert("RGBA").save(frame, format="PNG")
            data = frame.getvalue()

        return process_image_for_logo(data)
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    except Exception:
        logger.debug("icon validation failed unexpectedly", exc_info=True)
        return None
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && uv run pytest tests/test_site_icon_extractor.py -v
```

Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/site_icon_extractor.py api/tests/test_site_icon_extractor.py
git commit -m "feat(avatar): validate and normalise a candidate icon

Pillow verify+reopen, format allowlist, 64-4096px bounds, bomb ceiling, and a
0.8-1.25 aspect gate. The aspect gate is what makes the existing square
centre-crop safe and what principles the og:image exclusion. Reuses
r2_service.process_image_for_logo for the 512x512 PNG."
```

---

## Task 4: The bounded fetch pipeline

**Files:**
- Modify: `api/app/services/site_icon_extractor.py`
- Modify: `api/app/config.py`
- Test: `api/tests/test_site_icon_extractor.py`

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_site_icon_extractor.py`:

```python
import pytest

from app.services import site_icon_extractor


@pytest.mark.asyncio
async def test_derive_returns_none_when_document_fetch_fails(monkeypatch):
    async def _no_document(*args, **kwargs):
        return None

    monkeypatch.setattr(site_icon_extractor, "_fetch_document", _no_document)
    assert await site_icon_extractor.derive_site_icon("https://example.com") is None


@pytest.mark.asyncio
async def test_derive_stops_after_the_candidate_attempt_cap(monkeypatch):
    """Five candidates, all bad, must not produce five fetches."""
    attempts: list[str] = []

    async def _document(url):
        return (
            "https://example.com/",
            """
            <link rel="apple-touch-icon" sizes="180x180" href="/a.png">
            <link rel="apple-touch-icon" sizes="170x170" href="/b.png">
            <link rel="apple-touch-icon" sizes="160x160" href="/c.png">
            <link rel="apple-touch-icon" sizes="150x150" href="/d.png">
            <link rel="icon" sizes="512x512" href="/e.png">
            """,
        )

    async def _icon(url):
        attempts.append(url)
        return None  # every candidate fails validation

    monkeypatch.setattr(site_icon_extractor, "_fetch_document", _document)
    monkeypatch.setattr(site_icon_extractor, "fetch_icon_bytes", _icon)

    assert await site_icon_extractor.derive_site_icon("https://example.com") is None
    assert len(attempts) == site_icon_extractor._MAX_CANDIDATE_ATTEMPTS == 3


@pytest.mark.asyncio
async def test_derive_uploads_the_first_valid_candidate(monkeypatch):
    uploaded: dict = {}

    async def _document(url):
        return "https://example.com/", '<link rel="apple-touch-icon" href="/a.png">'

    async def _icon(url):
        return b"normalised-png-bytes" if url.endswith("/a.png") else None

    def _upload(data, filename, content_type):
        uploaded["data"] = data
        return "logos/derived-abc.png"

    monkeypatch.setattr(site_icon_extractor, "_fetch_document", _document)
    monkeypatch.setattr(site_icon_extractor, "fetch_icon_bytes", _icon)
    monkeypatch.setattr(site_icon_extractor, "upload_to_r2", _upload)

    key = await site_icon_extractor.derive_site_icon("https://example.com")
    assert key == "logos/derived-abc.png"
    assert uploaded["data"] == b"normalised-png-bytes"


@pytest.mark.asyncio
async def test_derive_returns_none_when_storage_fails(monkeypatch):
    async def _document(url):
        return "https://example.com/", '<link rel="apple-touch-icon" href="/a.png">'

    async def _icon(url):
        return b"bytes"

    def _boom(*args, **kwargs):
        raise RuntimeError("R2 is down")

    monkeypatch.setattr(site_icon_extractor, "_fetch_document", _document)
    monkeypatch.setattr(site_icon_extractor, "fetch_icon_bytes", _icon)
    monkeypatch.setattr(site_icon_extractor, "upload_to_r2", _boom)

    assert await site_icon_extractor.derive_site_icon("https://example.com") is None


@pytest.mark.asyncio
async def test_derive_never_raises_on_an_unexpected_error(monkeypatch):
    async def _explode(url):
        raise RuntimeError("something nobody predicted")

    monkeypatch.setattr(site_icon_extractor, "_fetch_document", _explode)
    assert await site_icon_extractor.derive_site_icon("https://example.com") is None


@pytest.mark.asyncio
async def test_derive_returns_none_for_empty_url():
    assert await site_icon_extractor.derive_site_icon("") is None
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && uv run pytest tests/test_site_icon_extractor.py -k derive -v
```

Expected: FAIL — `AttributeError: module has no attribute '_fetch_document'`

- [ ] **Step 3: Implement**

First add the kill switch. In `api/app/config.py`, next to the other crawl flags (near `CRAWL_STREAM_INGEST_ENABLED`, ~line 577):

```python
# SITE_ICON_DERIVATION_ENABLED=false — disable deriving the chat avatar from the
# customer's website during a crawl. Default on; the feature is silent and
# best-effort, so this exists purely as an operational kill switch.
SITE_ICON_DERIVATION_ENABLED = _env("SITE_ICON_DERIVATION_ENABLED", "true").strip().lower() in (
    "1",
    "true",
    "yes",
)
```

Then add the imports at the top of `site_icon_extractor.py`:

```python
import asyncio
import time

import aiohttp

from app.core.ssrf import fetch_bytes_safely
from app.services.r2_service import upload_to_r2
```

And append the pipeline:

```python
# --- Work budget (spec 5.5) -------------------------------------------------
# Aspect ratio and true size are only knowable after decoding, so a rejection
# means "try the next candidate". With five tiers and several <link> tags per
# tier that is an open-ended fetch loop pointed at a third-party origin. These
# are the hard stops. The caller's asyncio.wait_for is only a backstop: it
# measures from the await, not from task creation, so the real bound lives here.
_DOCUMENT_TIMEOUT_S = 10.0
_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024
_MANIFEST_TIMEOUT_S = 5.0
_MANIFEST_MAX_BYTES = 64 * 1024
_ICON_TIMEOUT_S = 5.0
_ICON_MAX_BYTES = 1024 * 1024
_MAX_CANDIDATE_ATTEMPTS = 3
_TOTAL_BUDGET_S = 15.0

# Some CDNs serve an SPA shell to headless UA strings; a plain browser UA gets
# the same first-paint markup a visitor sees, which is where the icon links live.
_USER_AGENT = "Mozilla/5.0 (compatible; OyeChatsBrandBot/1.0; +https://www.oyechats.com)"


def _session(timeout_s: float) -> aiohttp.ClientSession:
    """A session used only to carry headers/timeout into the SSRF helpers.

    ``fetch_bytes_safely`` opens its own pinned session per hop; this one is never
    used to connect, so it costs nothing but must still be closed.
    """
    return aiohttp.ClientSession(
        headers={"User-Agent": _USER_AGENT},
        timeout=aiohttp.ClientTimeout(total=timeout_s),
    )


async def _fetch_document(url: str) -> tuple[str, str] | None:
    """Fetch ``url`` as HTML. Returns ``(final_url, html)`` or None.

    ``final_url`` is what candidate hrefs must resolve against — a site that
    redirects apex to www would otherwise produce icon URLs on the wrong host.
    """
    async with _session(_DOCUMENT_TIMEOUT_S) as session:
        result = await fetch_bytes_safely(session, url, max_bytes=_DOCUMENT_MAX_BYTES)
    if result is None:
        return None
    status, body = result
    if status >= 400:
        return None
    return url, body.decode("utf-8", errors="ignore")


async def _fetch_manifest(url: str) -> object | None:
    """Fetch and parse a web app manifest. Returns the parsed object or None."""
    async with _session(_MANIFEST_TIMEOUT_S) as session:
        result = await fetch_bytes_safely(session, url, max_bytes=_MANIFEST_MAX_BYTES)
    if result is None:
        return None
    status, body = result
    if status >= 400:
        return None
    try:
        return json.loads(body.decode("utf-8", errors="ignore"))
    except (ValueError, UnicodeDecodeError):
        return None


async def fetch_icon_bytes(url: str) -> bytes | None:
    """Fetch one candidate and return normalised 512x512 PNG bytes, or None.

    Pillow's decode and resize are CPU-bound and would otherwise block the event
    loop this coroutine shares with the crawl's ingest consumer and heartbeat, so
    :func:`validate_and_normalise_icon` runs in the default executor.
    """
    async with _session(_ICON_TIMEOUT_S) as session:
        result = await fetch_bytes_safely(session, url, max_bytes=_ICON_MAX_BYTES)
    if result is None:
        return None
    status, body = result
    if status >= 400 or not body:
        return None
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, validate_and_normalise_icon, body)


async def derive_site_icon(page_url: str) -> str | None:
    """Derive a chat avatar from ``page_url`` and store it. Returns the R2 key.

    Returns None for every failure mode — no icon links, all candidates rejected,
    SSRF block, transport error, budget exhausted, storage failure. Callers must
    treat None as "leave the avatar alone", never as an error worth surfacing:
    plenty of sites simply have no usable brand mark, and this runs inside the
    customer's slowest path.

    Never raises.
    """
    if not page_url:
        return None
    started = time.monotonic()

    def _budget_left() -> bool:
        return (time.monotonic() - started) < _TOTAL_BUDGET_S

    try:
        document = await _fetch_document(page_url)
        if document is None:
            return None
        final_url, html = document

        candidates = select_icon_candidates(html, final_url)
        manifest_url = find_manifest_url(html, final_url)
        if manifest_url and _budget_left():
            manifest = await _fetch_manifest(manifest_url)
            candidates = sorted(
                candidates + manifest_icon_candidates(manifest, final_url),
                key=lambda c: c.sort_key,
            )

        attempts = 0
        for candidate in candidates:
            if attempts >= _MAX_CANDIDATE_ATTEMPTS or not _budget_left():
                logger.info(
                    "site icon: budget exhausted for %s after %d attempts",
                    page_url,
                    attempts,
                )
                return None
            attempts += 1
            normalised = await fetch_icon_bytes(candidate.url)
            if normalised is None:
                continue

            # boto3 put_object is blocking; keep it off the crawl's event loop.
            loop = asyncio.get_running_loop()
            key = await loop.run_in_executor(
                None,
                lambda data=normalised: upload_to_r2(data, "site-icon.png", "image/png"),
            )
            logger.info("site icon derived for %s from %s", page_url, candidate.url)
            return key

        logger.info("site icon: no usable candidate for %s (%d tried)", page_url, attempts)
        return None
    except Exception:
        logger.warning("site icon derivation failed for %s (non-fatal)", page_url, exc_info=True)
        return None
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && uv run pytest tests/test_site_icon_extractor.py -v
```

Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/site_icon_extractor.py api/app/config.py api/tests/test_site_icon_extractor.py
git commit -m "feat(avatar): bounded, SSRF-guarded icon derivation pipeline

Hard caps: 1 document fetch, <=1 manifest fetch, <=3 candidate fetches, 15s
total wall clock enforced internally (the caller's wait_for measures from the
await, not from task creation, so it cannot be the real bound). Pillow and
boto3 both run in the executor so nothing blocks the crawl's event loop.
Adds SITE_ICON_DERIVATION_ENABLED as an operational kill switch."
```

---

## Task 5: The `bot_logo_source` column

**Files:**
- Modify: `api/app/db/models.py:339` (after `avatar_type` / `orb_color`)
- Create: `api/alembic/versions/<rev>_add_bot_logo_source.py`

- [ ] **Step 1: Add the column to the model**

In `api/app/db/models.py`, immediately after `orb_color` (line ~339):

```python
    # Provenance for ``bot_logo`` — NOT a style selector. ``avatar_type`` is the
    # style selector ('upload' | 'orb' | 'mascot') and must never carry a fourth
    # value: the widget branches on it and the admin's segmented control coerces
    # anything unknown back to 'upload', which would silently erase provenance on
    # the customer's next save.
    #
    # NULL     -> uploaded by the customer, or legacy/unknown
    # 'derived' -> auto-derived from the customer's website during a crawl
    #
    # Read by the admin only (never shipped to the widget) to caption the avatar
    # as "Taken from your website". The crawl's write guard keys off
    # ``bot_logo IS NULL``, not off this column.
    bot_logo_source = Column(String, nullable=True)
```

- [ ] **Step 2: Generate the migration**

```bash
cd api && uv run alembic revision --autogenerate -m "add bot_logo_source"
```

Open the generated file under `api/alembic/versions/`. It must contain exactly these two bodies — **delete anything else autogenerate picked up** (it can drift on unrelated models):

```python
def upgrade() -> None:
    op.add_column("bots", sa.Column("bot_logo_source", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "bot_logo_source")
```

A `downgrade()` that is empty or `pass` will fail CI — `.github/workflows/ci.yml:74-77` runs `upgrade head` → `check` → `downgrade -1` → `upgrade head`.

- [ ] **Step 3: Run the exact CI migration gate locally**

```bash
cd api && uv run alembic upgrade head && uv run alembic check && uv run alembic downgrade -1 && uv run alembic upgrade head
```

Expected: all four succeed. `alembic check` printing "No new upgrade operations detected" is the signal that the model and the migration agree.

- [ ] **Step 4: Run the test suite**

```bash
cd api && uv run pytest -q
```

Expected: PASS. A new nullable column breaks nothing.

- [ ] **Step 5: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/
git commit -m "feat(db): add bots.bot_logo_source for avatar provenance

Provenance deliberately does NOT go in avatar_type: that is a style selector
('upload' | 'orb' | 'mascot') the widget branches on and the admin's segmented
control coerces, so a fourth value would be erased on the next save."
```

---

## Task 6: Clear provenance on customer upload

Two live write paths reach `bot_logo`. One shared helper, called from both.

**Files:**
- Modify: `api/app/api/bot_routes.py` (near `_reconcile_manual_overrides`, ~1787)
- Modify: `api/app/api/client_routes.py:98`
- Test: `api/tests/test_bot_logo_source.py` *(create)*

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_bot_logo_source.py`:

```python
"""bot_logo_source must never outlive the logo it describes."""

from __future__ import annotations

import pytest

from app.api.bot_routes import reconcile_logo_source


class _Bot:
    def __init__(self, bot_logo=None, bot_logo_source=None):
        self.bot_logo = bot_logo
        self.bot_logo_source = bot_logo_source


def test_upload_over_a_derived_avatar_clears_the_source():
    bot = _Bot(bot_logo="logos/derived.png", bot_logo_source="derived")
    reconcile_logo_source(bot, {"bot_logo": "logos/uploaded.png"})
    assert bot.bot_logo_source is None


def test_removing_the_avatar_clears_the_source():
    bot = _Bot(bot_logo="logos/derived.png", bot_logo_source="derived")
    reconcile_logo_source(bot, {"bot_logo": None})
    assert bot.bot_logo_source is None


def test_resaving_the_same_logo_leaves_the_source_alone():
    """A no-op save of unrelated settings must not strip the caption."""
    bot = _Bot(bot_logo="logos/derived.png", bot_logo_source="derived")
    reconcile_logo_source(bot, {"bot_logo": "logos/derived.png"})
    assert bot.bot_logo_source == "derived"


def test_patch_without_a_logo_field_leaves_the_source_alone():
    bot = _Bot(bot_logo="logos/derived.png", bot_logo_source="derived")
    reconcile_logo_source(bot, {"name": "New agent name"})
    assert bot.bot_logo_source == "derived"


def test_launcher_logo_change_also_clears_the_source():
    """The two fields are mirrored, so either one arriving counts as a change."""
    bot = _Bot(bot_logo="logos/derived.png", bot_logo_source="derived")
    reconcile_logo_source(bot, {"launcher_logo": "logos/uploaded.png"})
    assert bot.bot_logo_source is None


def test_a_client_cannot_set_the_source_directly():
    bot = _Bot(bot_logo="logos/uploaded.png", bot_logo_source=None)
    reconcile_logo_source(bot, {"bot_logo_source": "derived"})
    assert bot.bot_logo_source is None
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && uv run pytest tests/test_bot_logo_source.py -v
```

Expected: FAIL — `ImportError: cannot import name 'reconcile_logo_source'`

- [ ] **Step 3: Implement the helper**

In `api/app/api/bot_routes.py`, immediately after `_reconcile_manual_overrides` (~line 1812):

```python
def reconcile_logo_source(bot: Bot, update_data: dict) -> None:
    """Clear ``bot.bot_logo_source`` when the customer changes the avatar.

    Must run BEFORE the patch is applied — it compares the incoming value against
    the stored one. Any customer-supplied change to ``bot_logo`` (or its mirror
    ``launcher_logo``) means the image is no longer the one we derived, so the
    "Taken from your website" provenance must go with it. Clearing to None is
    also a change, which is what re-arms derivation on the next crawl.

    ``bot_logo_source`` is server-owned: a client that sends it in a patch body
    cannot set it, so it is popped here rather than trusted.

    Exported (no leading underscore) because ``client_routes`` has a second live
    write path for the same fields and must apply the identical rule.
    """
    update_data.pop("bot_logo_source", None)
    if "bot_logo" in update_data:
        incoming = update_data.get("bot_logo")
    elif "launcher_logo" in update_data:
        incoming = update_data.get("launcher_logo")
    else:
        return
    if (incoming or None) != (bot.bot_logo or None):
        bot.bot_logo_source = None
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && uv run pytest tests/test_bot_logo_source.py -v
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into both write paths**

In `api/app/api/bot_routes.py`, in `update_bot` beside the existing reconcile call (~line 1932):

```python
            _reconcile_manual_overrides(bot, update_data)
            reconcile_logo_source(bot, update_data)
```

In `api/app/api/client_routes.py`, inside the settings patch handler — after `update_data = request.dict(exclude_unset=True)` and **before** the logo mirroring at line ~99:

```python
            update_data = request.dict(exclude_unset=True)

            # Same rule as PATCH /bots/{id}: an avatar the customer changed is no
            # longer the one we derived. This route is a legacy fallback (the app
            # only uses it when no bot_id is available) but it is live and
            # API-key reachable, so provenance must not be able to lie here.
            from app.api.bot_routes import reconcile_logo_source

            reconcile_logo_source(bot_db, update_data)

            if "bot_logo" in update_data:
```

- [ ] **Step 6: Run the full suite**

```bash
cd api && uv run pytest -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/app/api/bot_routes.py api/app/api/client_routes.py api/tests/test_bot_logo_source.py
git commit -m "feat(avatar): clear logo provenance when the customer changes it

One shared helper called from both live write paths for bot_logo:
PATCH /bots/{id} and the legacy PATCH /client/settings. Without the second
call site, an avatar uploaded through the fallback route would keep the
'Taken from your website' caption. bot_logo_source is server-owned and is
popped from any incoming patch body."
```

---

## Task 7: Serialise the field to the admin (and only the admin)

**Files:**
- Modify: `api/app/api/bot_routes.py:341`, `:431`, `:621`, `:1298`
- Test: `api/tests/test_bot_logo_source.py`

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_bot_logo_source.py`:

```python
def test_widget_settings_payload_does_not_leak_provenance():
    """The widget renders from bot_logo + avatar_type alone.

    Provenance is an admin-facing fact about where a file came from; shipping it
    to every visitor's browser leaks a detail of the customer's setup for no
    rendering benefit.
    """
    import inspect

    from app.api import auth

    source = inspect.getsource(auth)
    assert '"bot_logo_source"' not in source


def test_bot_settings_response_model_declares_the_field():
    from app.api.bot_routes import BotSettingsResponse

    assert "bot_logo_source" in BotSettingsResponse.model_fields
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && uv run pytest tests/test_bot_logo_source.py -k "widget or response_model" -v
```

Expected: FAIL on `test_bot_settings_response_model_declares_the_field` — the field is not declared. The widget test passes already; it is a regression guard.

- [ ] **Step 3: Add the field to the three admin payloads**

`api/app/api/bot_routes.py:341` — in the `BotSettingsResponse` model, beside `bot_logo`:

```python
    bot_logo: str | None
    bot_logo_source: str | None = None
```

`:431` — in the response construction, beside `bot_logo=bl`:

```python
        bot_logo=bl,
        bot_logo_source=bot.bot_logo_source,
```

`:621` — in the settings dict, beside `"bot_logo": logo_url`:

```python
        "bot_logo": logo_url,
        "bot_logo_source": bot.bot_logo_source,
```

`:1298` — in the list construction, beside `bot_logo=bl`:

```python
                    bot_logo=bl,
                    bot_logo_source=b.bot_logo_source,
```

Do **not** touch `api/app/api/auth.py:886-896`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && uv run pytest tests/test_bot_logo_source.py tests/test_bot_routes.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/bot_routes.py api/tests/test_bot_logo_source.py
git commit -m "feat(api): expose bot_logo_source on the three admin payloads

Deliberately absent from the widget settings payload — the widget renders
from bot_logo + avatar_type alone, and provenance is an admin-facing fact."
```

---

## Task 8: Wire derivation into the crawl

**Files:**
- Modify: `api/app/services/crawl_orchestrator.py:489`, `:780`
- Test: `api/tests/test_crawl_orchestrator_derived_avatar.py` *(create)*

The whole trust requirement lives in the write guard here. Read spec §7.3 before starting.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_crawl_orchestrator_derived_avatar.py`:

```python
"""The crawl may only ever set a DEFAULT avatar, never override a chosen one."""

from __future__ import annotations

from app.services.crawl_orchestrator import apply_derived_avatar


class _Bot:
    def __init__(self, bot_logo=None, launcher_logo=None, bot_logo_source=None):
        self.bot_logo = bot_logo
        self.launcher_logo = launcher_logo
        self.bot_logo_source = bot_logo_source


def test_writes_both_logo_fields_when_the_slot_is_empty():
    bot = _Bot()
    assert apply_derived_avatar(bot, "logos/derived.png") is True
    assert bot.bot_logo == "logos/derived.png"
    assert bot.launcher_logo == "logos/derived.png"
    assert bot.bot_logo_source == "derived"


def test_does_not_overwrite_an_uploaded_avatar():
    """The trust requirement: a customer's choice is frozen forever."""
    bot = _Bot(bot_logo="logos/customer.png", launcher_logo="logos/customer.png")
    assert apply_derived_avatar(bot, "logos/derived.png") is False
    assert bot.bot_logo == "logos/customer.png"
    assert bot.bot_logo_source is None


def test_does_not_overwrite_a_previously_derived_avatar():
    """Derived is frozen too — a recrawl must not silently change the widget."""
    bot = _Bot(bot_logo="logos/old.png", launcher_logo="logos/old.png", bot_logo_source="derived")
    assert apply_derived_avatar(bot, "logos/new.png") is False
    assert bot.bot_logo == "logos/old.png"


def test_does_not_write_when_only_the_launcher_slot_is_occupied():
    """Half-filled state: writing bot_logo alone would desync the two surfaces."""
    bot = _Bot(bot_logo=None, launcher_logo="logos/customer.png")
    assert apply_derived_avatar(bot, "logos/derived.png") is False
    assert bot.bot_logo is None


def test_no_op_when_derivation_produced_nothing():
    bot = _Bot()
    assert apply_derived_avatar(bot, None) is False
    assert bot.bot_logo is None
    assert bot.bot_logo_source is None
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && uv run pytest tests/test_crawl_orchestrator_derived_avatar.py -v
```

Expected: FAIL — `ImportError: cannot import name 'apply_derived_avatar'`

- [ ] **Step 3: Implement the guard**

In `api/app/services/crawl_orchestrator.py`, next to `_apply_crawl_metadata_to_bot` (~line 227):

```python
def apply_derived_avatar(bot_db: Bot, avatar_key: str | None) -> bool:
    """Write a derived avatar onto ``bot_db`` — but only into an empty slot.

    This sets a DEFAULT, never an override. A recrawl that replaced an avatar the
    customer deliberately chose is a support ticket and a trust problem, and the
    chat avatar is the single most visible pixel of the widget — so a slot that is
    already filled, by an upload OR by an earlier derivation, is left alone
    forever. Clearing the avatar in the admin is what re-arms this.

    The caller MUST evaluate this inside the persist transaction, not when the
    derivation task was launched: a crawl runs for minutes and the customer can
    upload an avatar partway through.

    ``bot_logo`` and ``launcher_logo`` are mirrored everywhere in this codebase,
    so both must be empty and both are written — filling one alone would leave the
    chat header branded and the floating launcher generic.

    Mutates ``bot_db`` in place; the caller owns the commit. Returns True when a
    write happened (for logging and assertions).
    """
    if not avatar_key:
        return False
    if bot_db.bot_logo or bot_db.launcher_logo:
        return False
    bot_db.bot_logo = avatar_key
    bot_db.launcher_logo = avatar_key
    bot_db.bot_logo_source = "derived"
    return True
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && uv run pytest tests/test_crawl_orchestrator_derived_avatar.py -v
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Launch the task**

At the top of `crawl_orchestrator.py`, extend the config import (line 35) and add the service import:

```python
from app.config import CRAWL_INGEST_WAVE_PAGES, CRAWL_STREAM_INGEST_ENABLED, SITE_ICON_DERIVATION_ENABLED
```

```python
from app.services.site_icon_extractor import derive_site_icon
```

Then, immediately after the `footer_task` creation (~line 490):

```python
    # Derive a default chat avatar from the customer's site markup, in parallel
    # with the crawl. Same shape as the footer harvest: bounded, silent, and
    # cancelled on teardown. Skipped for an ordered re-scrape (a partial page
    # list is not a "train me from my website" moment) and when no bot is bound.
    icon_task: asyncio.Task | None = None
    if bot_id and not ordered_urls and SITE_ICON_DERIVATION_ENABLED:
        icon_task = asyncio.create_task(derive_site_icon(url))
```

- [ ] **Step 6: Await and apply it**

Immediately **before** the `should_persist` block (~line 777), add:

```python
        # Collect the derived avatar. wait_for here is only a backstop — the real
        # budget is enforced inside derive_site_icon (it measures from task
        # creation; this measures from now). Every failure mode collapses to
        # "no avatar", which the guard below treats as a no-op.
        derived_avatar_key: str | None = None
        if icon_task is not None:
            try:
                derived_avatar_key = await asyncio.wait_for(icon_task, timeout=20.0)
            except Exception:
                # TimeoutError subclasses Exception, so one clause covers both the
                # backstop firing and any escape from derive_site_icon. Listing
                # them separately would trip ruff B014.
                icon_task.cancel()
                with contextlib.suppress(BaseException):
                    await icon_task
                derived_avatar_key = None
            finally:
                icon_task = None
```

Then, inside the existing `if bot_db and bot_db.client_id == client_id:` block, straight after the `_apply_crawl_metadata_to_bot(...)` call and **before** `session.commit()`:

```python
                        # Guarded HERE, not at task-launch time: the customer can
                        # upload an avatar during a ten-minute crawl, and that
                        # upload must win.
                        if apply_derived_avatar(bot_db, derived_avatar_key):
                            written.append("bot_logo(derived)")
```

- [ ] **Step 7: Prevent the task leaking on failure paths**

In the `finally` block, beside the existing `footer_task` cleanup (~line 968):

```python
        if icon_task is not None:
            icon_task.cancel()
            with contextlib.suppress(BaseException):
                await icon_task
```

- [ ] **Step 8: Run the crawl suite**

```bash
cd api && uv run pytest tests/ -k crawl -v
```

Expected: PASS. Every existing crawl test must still pass — derivation is additive and its gate is off for the ordered-URL paths those tests exercise.

- [ ] **Step 9: Commit**

```bash
git add api/app/services/crawl_orchestrator.py api/tests/test_crawl_orchestrator_derived_avatar.py
git commit -m "feat(crawl): derive a default chat avatar during website training

Runs as a bounded parallel task beside the footer harvest. The write guard is
evaluated inside the persist transaction, not at task launch: a crawl runs for
minutes and an avatar the customer uploads partway through must win. A filled
slot — uploaded or previously derived — is never overwritten."
```

---

## Task 9: On-demand refresh endpoint

**Files:**
- Modify: `api/app/api/bot_routes.py`
- Test: `api/tests/test_derive_avatar_route.py` *(create)*

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_derive_avatar_route.py`:

```python
"""POST /bots/{id}/derive-avatar — the one surface where failure is visible."""

from __future__ import annotations

import inspect

from app.api import bot_routes


def test_route_never_reads_a_url_from_the_request_body():
    """The source URL must come from bot.website, never from the caller.

    This is what stops the endpoint becoming an SSRF probe on top of the guard:
    a customer can only ever point it at a domain already stored on their bot.
    """
    source = inspect.getsource(bot_routes.derive_bot_avatar)
    assert "bot.website" in source
    assert "request.url" not in source
    assert "body" not in source


def test_route_is_rate_limited_and_impersonation_writable():
    """Assert on the source, not on __wrapped__ — decorator internals are not a
    stable contract, but the decorators being present on this route is."""
    source = inspect.getsource(bot_routes)
    assert '@limiter.limit("10/minute", key_func=key_from_api_key)' in source
    marker = source.split('@router.post("/{bot_id}/derive-avatar")', 1)[1][:400]
    assert "@impersonation_writable" in marker
```

Then the behavioural tests, appended to the same file:

```python
import pytest
from fastapi import HTTPException


class _Bot:
    id = 7
    client_id = 1
    website = "https://example.com"
    bot_logo = None
    launcher_logo = None
    bot_logo_source = None


@pytest.mark.asyncio
async def test_returns_422_when_nothing_derivable(monkeypatch):
    async def _nothing(url):
        return None

    monkeypatch.setattr(bot_routes, "derive_site_icon", _nothing)
    with pytest.raises(HTTPException) as excinfo:
        await bot_routes._derive_avatar_for_bot(_Bot(), "https://example.com")
    assert excinfo.value.status_code == 422


@pytest.mark.asyncio
async def test_returns_422_when_the_bot_has_no_website():
    with pytest.raises(HTTPException) as excinfo:
        await bot_routes._derive_avatar_for_bot(_Bot(), None)
    assert excinfo.value.status_code == 422


@pytest.mark.asyncio
async def test_overwrites_an_existing_avatar_because_the_customer_asked(monkeypatch):
    async def _key(url):
        return "logos/fresh.png"

    monkeypatch.setattr(bot_routes, "derive_site_icon", _key)
    bot = _Bot()
    bot.bot_logo = "logos/old.png"
    bot.launcher_logo = "logos/old.png"

    key = await bot_routes._derive_avatar_for_bot(bot, "https://example.com")
    assert key == "logos/fresh.png"
    assert bot.bot_logo == "logos/fresh.png"
    assert bot.launcher_logo == "logos/fresh.png"
    assert bot.bot_logo_source == "derived"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd api && uv run pytest tests/test_derive_avatar_route.py -v
```

Expected: FAIL — `AttributeError: module 'app.api.bot_routes' has no attribute 'derive_bot_avatar'`

- [ ] **Step 3: Implement**

Add the imports at the top of `api/app/api/bot_routes.py`:

```python
from app.core.rate_limit import key_from_api_key, limiter
from app.services.site_icon_extractor import derive_site_icon
```

(`limiter` is already imported at line 25 — add only what is missing.)

Then append the route near the other bot mutation endpoints:

```python
async def _derive_avatar_for_bot(bot: Bot, website: str | None) -> str:
    """Derive an avatar from ``website`` and write it onto ``bot``. Returns the key.

    Unlike the crawl path this overwrites unconditionally — the customer pressed
    the button, so replacing their current avatar is the requested outcome, and
    the UI confirms before calling when the current avatar was uploaded rather
    than derived.

    Raises HTTPException(422) when there is nothing to derive. This is the ONLY
    surface where a derivation failure is visible: everywhere else it is silent,
    because everywhere else the customer did not ask.
    """
    if not website:
        raise HTTPException(
            status_code=422,
            detail="Add your website address to this agent before deriving an avatar from it.",
        )
    key = await derive_site_icon(website)
    if not key:
        raise HTTPException(
            status_code=422,
            detail="We couldn't find a usable icon on your website.",
        )
    bot.bot_logo = key
    bot.launcher_logo = key
    bot.bot_logo_source = "derived"
    return key


@router.post("/{bot_id}/derive-avatar")
@limiter.limit("10/minute", key_func=key_from_api_key)
@impersonation_writable
async def derive_bot_avatar(
    bot_id: int,
    request: Request,
    auth=Depends(get_current_client_or_operator),
):
    """Re-derive the agent's avatar from its own website, on demand.

    The source URL is read from ``bot.website`` and is NEVER taken from the
    request — that is what keeps this from becoming an SSRF probe or port scanner
    on top of the guard in ``app.core.ssrf``. A caller can only ever point it at a
    domain already stored on a bot they own.

    Writable under super-admin impersonation: this is a branding edit, the same
    class ``update_bot`` already admits, and it touches nothing in billing,
    credentials, or the widget origin allowlist.
    """
    _require_bot_management_access(auth)
    with get_session() as session:
        bot = _get_workspace_bot(session, bot_id, auth["client_id"])
        key = await _derive_avatar_for_bot(bot, bot.website)
        session.commit()
        base = str(request.base_url).rstrip("/")
        return {"bot_logo": f"{base}/files/{key}", "bot_logo_source": "derived"}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd api && uv run pytest tests/test_derive_avatar_route.py -v
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/bot_routes.py api/tests/test_derive_avatar_route.py
git commit -m "feat(api): POST /bots/{id}/derive-avatar for on-demand refresh

Source URL comes from bot.website, never from the request body — a caller can
only ever point this at a domain stored on a bot they own. The only surface
where a derivation failure is visible, because it is the only one where the
customer asked."
```

---

## Task 10: Backend gates

- [ ] **Step 1: Run every backend check**

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

Expected: all clean. If `ruff format --check` reports files, run `uv run ruff format .` and re-run.

- [ ] **Step 2: Re-run the migration round trip**

```bash
cd api && uv run alembic upgrade head && uv run alembic check && uv run alembic downgrade -1 && uv run alembic upgrade head
```

Expected: all four succeed.

- [ ] **Step 3: Commit any formatting fixes**

```bash
git add -A api/
git commit -m "style: ruff format" || echo "nothing to format"
```

---

## Task 11: Admin UI — provenance caption and refresh button

**Files:**
- Modify: `app/src/features/launch-studio/customize/AvatarPicker.tsx`
- Modify: `app/src/features/agents/experience/BrandingSection.tsx`
- Modify: `app/src/features/agents/experience/types.ts`
- Modify: `app/src/features/agents/experience/ExperiencePage.tsx`
- Modify: `app/src/services/api.js`

- [ ] **Step 1: Add the API client function**

In `app/src/services/api.js`, beside the other bot functions:

```javascript
/**
 * Re-derives the agent's avatar from its own website.
 * The backend reads the source URL from the stored bot.website — no URL is sent.
 *
 * @param {number} botId
 * @returns {Promise<{bot_logo: string, bot_logo_source: string}>}
 */
export const deriveBotAvatar = async (botId) => {
    try {
        const response = await api.post(`/bots/${botId}/derive-avatar`);
        return response.data;
    } catch (error) {
        console.error('API Error deriving avatar:', error);
        throw buildApiError(error, "We couldn't find a usable icon on your website");
    }
};
```

- [ ] **Step 2: Add the field to the draft type**

In `app/src/features/agents/experience/types.ts`, in the `ExperienceDraft` interface beside `botLogo` (~line 18):

```typescript
  botLogo: string | null;
  /**
   * Where botLogo came from. Server-owned and read-only: mapped in fromApi,
   * deliberately absent from toPayload. 'derived' means we took it from the
   * customer's website during a crawl.
   */
  botLogoSource: 'derived' | null;
```

In `fromApi` beside the `botLogo` mapping (~line 155):

```typescript
    botLogo: typeof raw.bot_logo === 'string' && raw.bot_logo.length > 0 ? raw.bot_logo : null,
    botLogoSource: raw.bot_logo_source === 'derived' ? 'derived' : null,
```

Do **not** add anything to `toPayload`.

- [ ] **Step 3: Extend AvatarPicker**

In `app/src/features/launch-studio/customize/AvatarPicker.tsx`, extend the props interface:

```typescript
export interface AvatarPickerProps {
  avatarType: AvatarType;
  orbColor: string;
  botLogo: string | null;
  /** 'derived' when the logo was taken from the customer's website. */
  logoSource?: 'derived' | null;
  primaryColor: string;
  uploading: boolean;
  swatches: string[];
  /** True while an on-demand re-derivation is in flight. */
  deriving?: boolean;
  onChangeType: (type: AvatarType) => void;
  onChangeOrbColor: (hex: string) => void;
  onUpload: (file: File) => void;
  onRemoveLogo: () => void;
  /** Omitted when the agent has no website on file — the control then hides. */
  onDeriveFromWebsite?: () => void;
}
```

Add `Globe` to the lucide import:

```typescript
import { Bot, Check, Globe, ImagePlus, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
```

Destructure the new props alongside the existing ones, then replace the hint paragraph at the end of the `upload` panel (currently `PNG, JPG or SVG up to 2MB`) with:

```tsx
            {logoSource === 'derived' && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--ds-text-subtle)]">
                <Globe size={11} aria-hidden="true" />
                Taken from your website
              </p>
            )}
            <p className="mt-1.5 text-[11px] text-[var(--ds-text-subtle)]">PNG, JPG or SVG up to 2MB</p>
            {onDeriveFromWebsite && (
              <button
                type="button"
                onClick={onDeriveFromWebsite}
                disabled={deriving || uploading}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)] disabled:opacity-50"
              >
                {deriving ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                Use my website&apos;s icon
              </button>
            )}
```

- [ ] **Step 4: Thread the props through BrandingSection**

In `app/src/features/agents/experience/BrandingSection.tsx`, extend the props interface:

```typescript
  /** True while an on-demand avatar derivation is in flight. */
  deriving: boolean;
  /** Omitted when the agent has no website on file. */
  onDeriveFromWebsite?: () => void;
```

Destructure them, then extend the `AvatarPicker` usage:

```tsx
        <AvatarPicker
          avatarType={draft.avatarType}
          orbColor={draft.orbColor}
          botLogo={draft.botLogo}
          logoSource={draft.botLogoSource}
          primaryColor={draft.primaryColor}
          uploading={uploading}
          deriving={deriving}
          swatches={swatches}
          onChangeType={(t) => onChange({ avatarType: t })}
          onChangeOrbColor={(c) => onChange({ orbColor: c })}
          onUpload={onUpload}
          onRemoveLogo={() => onChange({ botLogo: null, botLogoSource: null })}
          onDeriveFromWebsite={onDeriveFromWebsite}
        />
```

- [ ] **Step 5: Add the handler in ExperiencePage**

In `app/src/features/agents/experience/ExperiencePage.tsx`, beside the existing upload handler (~line 134):

```tsx
  const [deriving, setDeriving] = useState(false);

  const handleDeriveFromWebsite = useCallback(async (): Promise<void> => {
    if (!botId) return;
    // Replacing an image the customer uploaded is a visible change they did not
    // make — confirm it. Replacing one we derived needs no ceremony.
    if (draft?.botLogo && draft.botLogoSource !== 'derived') {
      const ok = window.confirm(
        'This will replace the avatar image you uploaded with the icon from your website. Continue?',
      );
      if (!ok) return;
    }
    setDeriving(true);
    try {
      const result = await deriveBotAvatar(botId);
      applyServerValues({ botLogo: result.bot_logo, botLogoSource: 'derived', avatarType: 'upload' });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not derive an avatar');
    } finally {
      setDeriving(false);
    }
  }, [botId, draft?.botLogo, draft?.botLogoSource, applyServerValues, setUploadError]);
```

Import `deriveBotAvatar` from `../../../services/api`, and pass through to `BrandingSection`:

```tsx
          deriving={deriving}
          onDeriveFromWebsite={draft?.website ? handleDeriveFromWebsite : undefined}
```

- [ ] **Step 6: Run the admin gates**

```bash
cd app && npm run lint && npm run build
```

Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add app/src
git commit -m "feat(app): surface derived avatar provenance in Experience

Adds a 'Taken from your website' caption and a 'Use my website's icon'
button to the avatar picker. Replacing a customer-uploaded image confirms
first; replacing a derived one does not. botLogoSource is read-only —
mapped in fromApi, absent from toPayload."
```

---

## Task 12: Final verification

- [ ] **Step 1: Backend**

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

- [ ] **Step 2: Migration round trip**

```bash
cd api && uv run alembic upgrade head && uv run alembic check && uv run alembic downgrade -1 && uv run alembic upgrade head
```

- [ ] **Step 3: Admin app**

```bash
cd app && npm run lint && npm run build
```

- [ ] **Step 4: Confirm the branch**

```bash
git branch --show-current
```

Expected: `development`. If it says `main`, run `git checkout development` before doing anything else.

- [ ] **Step 5: Confirm no collision with the concurrent session**

```bash
git diff --name-only origin/development...HEAD | grep -E "company_profile_service|company_markup|domain_normalizer|spider_service|llm_service"
```

Expected: **no output.** Any match means you edited a file another session owns — revert that file.

- [ ] **Step 6: Manual smoke test**

Start the stack (`cd api && ./scripts/dev.sh`, and `cd app && npm run dev`), then:

1. Create an agent with website `https://github.com` (which serves a large `apple-touch-icon`).
2. Run a crawl from Launch Studio.
3. Open **AI Agents → the agent → Experience → Branding**. Expected: the GitHub mark as the avatar, captioned "Taken from your website".
4. Upload your own image. Expected: caption disappears.
5. Re-run the crawl. Expected: **your uploaded image survives.** This is the requirement the whole feature is built around — if it fails, stop and re-read spec §7.3a.
6. Click **Remove**, then re-run the crawl. Expected: the derived avatar comes back.
7. Point an agent at a site with no icons (e.g. `https://example.com`). Expected: crawl completes normally, no avatar, no error anywhere in the UI.

---

## Deferred — not in this plan

| Item | Why |
|---|---|
| Orphaned R2 objects from a lost write race | ~30 KB per occurrence in a rare race; reordering moves the race rather than removing it (spec §14.1) |
| Reconciling `bot.website` with the crawl URL | The two can diverge; fixing it means a crawl overwriting a customer-entered field, which is the behaviour spec §2 forbids (spec §8.1) |
| Removing the legacy `PATCH /client/settings` write path | Live and API-key reachable; deleting a public route is out of scope. It is patched, not removed (spec §14.5) |
| Per-bot hourly rate limiting | Needs a custom limiter key func written for one route; per-client-per-minute is the house pattern (spec §14.4) |
