# Chat Widget — `widget/`

The embeddable chat widget customers script-tag into their own site. The root
[`../CLAUDE.md`](../CLAUDE.md) stays the platform-wide technical reference —
backend, APIs, DB models, auth, dev commands — and all of it still applies here.

## How the embed works

The embed is a **two-stage load**: a tiny loader IIFE that customers script-tag, plus a
code-split ESM app it pulls in at runtime. The customer-facing file
(`oyechats-widget.js`, ~3KB) ships on every page view, so it is kept deliberately small;
the React app only downloads when it is actually needed.

**Stage 1, the loader** (`widget/src/loader.js`, built by `vite.loader.config.js`):

1. Finds its own `<script>` tag and reads `data-bot-key` / `data-api-key` / `data-api-url`
2. Sets `window.OYECHATS_BOT_KEY` (or `OYECHATS_API_KEY`) globally
3. Exposes `window.OyeChats` as a **stub-and-queue** API, so host-page code can call
   `OyeChats.on('ready', cb)`, `.open()`, `.identify()` before the app exists; queued calls
   replay once the app registers
4. Honors `window.OYECHATS_ASYNC_INIT` for consent-gated (GDPR) installs
5. Fetches `<base>/app/manifest.json`, resolves the hashed entry chunk and stylesheet, and
   validates both filenames against a strict pattern, so a tampered manifest cannot point
   the widget at anything outside `cdn.oyechats.com`
6. Dynamic-imports the entry chunk and calls its `init()`

**Stage 2, the app** (`widget/src/app-entry.jsx`, built by `vite.app.config.js`):

1. Creates `<div id="oyechats-widget-root">` and attaches an **open shadow root**, isolating
   widget styles from the host page in both directions
2. Injects the hashed stylesheet the loader resolved
3. Renders React (its own bundled copy) inside the shadow root
4. Communicates with the backend via the `X-Bot-Key` header

Chunks are split so a visitor who never opens the widget pays only for the launcher. Chat,
live chat, markdown rendering, the lead/handoff/quotation forms, Sentry, and each non-English
locale are all lazy. Budgets are enforced by `size-limit` (`npm run size`): the loader is
capped at 8KB gzipped and the eager path (loader + entry + vendor) at roughly 90KB gzipped.

> If the loader's boot fails (CORS, CDN blip, a manifest 404 mid-deploy) it clears its cached
> promise so a later `OyeChats.init()` can retry without a full page reload.

**Works on any platform**: Next.js, React, WordPress, Webflow, Shopify, plain HTML — anything with a `<body>` tag. Same pattern as Intercom, Crisp, Drift.

### Production Embed
```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

> One tag, and nothing else. We do not write markup of our own into a customer's page: OyeChats branding is
> the in-widget badge, governed by the `branding_removable` entitlement. An earlier version of this snippet
> shipped a second line, a crawlable "Powered by OyeChats" anchor, for backlinks. It was withdrawn: it landed
> as a stray line of our text on customer sites we do not control the layout of, which is not a thing to put
> in someone else's page.

### Development Embed (IMPORTANT)
The Vite **dev server** (`localhost:5173/src/main.jsx`) **cannot** be embedded on external sites. Vite's `@vitejs/plugin-react` injects a React Fast Refresh preamble only in its own `index.html`. Loading it cross-origin throws: `"@vitejs/plugin-react can't detect preamble"`.

**To test the widget on another local site:**
```bash
cd platform/widget
npm run build                    # Build the widget
npx vite preview --port 4173     # Serve built files
```
Then embed:
```html
<script src="http://localhost:4173/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

## How the Hosted Demo Page Works

`GET /demo/{bot_key}` is the shareable link on the Deploy page. It shows the
customer's **own website** with the real widget live on top, so a prospect who
opens it sees the thing in context rather than a generic sample page.

Three renderings, in descending order of fidelity (`bot_routes.py`):

1. **Live frame**: only when `?url=` is passed AND the site permits framing.
   Used by the dashboard's preview dialog, where a blank frame is recoverable
   because the customer is watching. `?url=` is restricted to the bot's own
   website and its `allowed_domains`: the route is unauthenticated and its key
   is public, so an open parameter would let anyone serve arbitrary third-party
   HTML from an oyechats.com URL under our branding.
2. **Captured site** (default): a stored full-page screenshot of the customer's
   site as the backdrop, real widget on top. This is what a shared link
   resolves to, because it is the only rendering that works for everyone:
   roughly 40% of sites forbid framing (`X-Frame-Options` / CSP
   `frame-ancestors`), and a headless capture is subject to neither.
3. **Hero page**: last resort, for a bot with no website or no usable capture.

The capture is taken on the worker during training (`task_capture_demo_screenshot`
→ `screenshot_service.refresh_bot_capture`), never on the demo page's request
path, because a full-page render takes tens of seconds. It is stored on R2 under
an unguessable key and recorded on `bots.demo_screenshot_*`. A capture older
than `DEMO_SCREENSHOT_TTL_DAYS`, or one taken of a site the bot no longer points
at, is not served.

> **Known limitation:** sections that reveal on scroll (IntersectionObserver,
> AOS, Framer Motion) capture blank. A full-page screenshot extends the document
> but never scrolls through it, so those observers never fire.
> `DEMO_SCREENSHOT_WAIT_SECONDS` fixes the *other* cause of blank bands (lazily
> loaded media) but cannot fix this one. A proper fix needs a renderer that
> scrolls before capturing, which neither Reader nor Spider exposes.

> **Provider status (2026-08-27):** Jina Reader `X-Respond-With: pageshot` works
> and is the default. Spider's `POST /screenshot` returns HTTP 200 with
> `{"error": "screenshot route produced no image bytes on this backend"}` on our
> account **and bills for the attempt**, so the fallback is currently inert.
> Re-test before relying on it.
