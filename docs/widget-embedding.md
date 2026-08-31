# Widget Embedding Guide

The OyeChats widget renders an AI chatbot on any website. It works on any platform — Next.js, React, WordPress, Webflow, Shopify, plain HTML — anything with a `<body>` tag.

## How It Works

The embed is a **two-stage load**: a tiny loader IIFE the customer script-tags, plus a code-split ESM app it pulls in at runtime. The customer-facing file ships on every page view, so it is kept deliberately small; the React app only downloads when it is actually needed.

### Stage 1 — the loader (`widget/src/loader.js` → `dist/oyechats-widget.js`)

1. Finds its own `<script>` tag and reads `data-bot-key` / `data-api-key` / `data-api-url`
2. Sets `window.OYECHATS_BOT_KEY` (or `OYECHATS_API_KEY`) globally
3. Exposes `window.OyeChats` as a **stub-and-queue** API, so host-page code can call `OyeChats.on('ready', cb)`, `.open()`, `.identify()` before the app exists; queued calls replay once the app registers
4. Honors `window.OYECHATS_ASYNC_INIT` for consent-gated (GDPR) installs — see [`../widget/docs/integrations/cookiebot.md`](../widget/docs/integrations/cookiebot.md)
5. Fetches `<base>/app/manifest.json`, resolves the hashed entry chunk and stylesheet, and **validates both filenames against a strict pattern**, so a tampered manifest cannot point the widget at anything outside the CDN base
6. Dynamic-imports the entry chunk and calls its `init()`

> If the boot fails (CORS, CDN blip, a manifest 404 mid-deploy) the loader clears its cached promise, so a later `OyeChats.init()` can retry without a full page reload.

### Stage 2 — the app (`widget/src/app-entry.jsx` → `dist/app/oyechats-*.js`)

1. Creates a `<div id="oyechats-widget-root">` and attaches an **open shadow root**, isolating widget styles from the host page in both directions
2. Injects the hashed stylesheet the loader resolved
3. Renders React (its own bundled copy) inside the shadow root
4. Communicates with the backend API via the `X-Bot-Key` header

## Production Embed

Add this before the closing `</body>` tag:

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
<a href="https://www.oyechats.com/?ref=bot-xxx&utm_source=widget&utm_medium=referral"
   rel="nofollow" style="font-size:11px;color:inherit;opacity:0.7;text-decoration:none">Powered by OyeChats</a>
```

Replace `bot-xxx` with the bot key from the admin dashboard. That's it — the widget handles everything else automatically.

> **The `<a>` is not decoration, and it is not optional on branded plans.** The widget mounts into a shadow root from JS *after* the visitor clicks the launcher, so its in-widget "Powered by" badge is invisible to every crawler. This anchor is the only attribution that lands in the customer's served HTML. It is visible (hidden text would penalise the *customer's* domain), `nofollow` (a sitewide self-placed link is a named link scheme), and `color:inherit` so it can never render invisible on a dark host background. Workspaces with the `branding_removable` entitlement get a snippet without it — the dashboard emits both variants from `app/src/data/widgetEmbed.ts`.

## What the Visitor Sees

1. A floating chat button appears in the bottom-right corner of the page
2. Clicking it opens the chat window with the bot's custom branding (colors, logo, name)
3. The visitor types a question and receives a streaming AI response
4. Optionally: a lead capture form appears, or live chat handoff is offered

## Widget Architecture

### Entry points

| File | Role |
|---|---|
| `widget/src/loader.js` | Production customer entry. Built by `vite.loader.config.js` into `dist/oyechats-widget.js` |
| `widget/src/app-entry.jsx` | Production app entry. Built by `vite.app.config.js` into `dist/app/` with hashed names |
| `widget/src/main.jsx` | **Dev server only.** Used by `npm run dev`; not part of the production build |

Sentry is lazy — it is not in the eager payload and loads on first error (or when `window.OYECHATS_DEBUG` is set).

### API Client (`widget/src/services/api.js`)

Communicates with the backend. Key functions:

| Function | Endpoint | Purpose |
|----------|----------|---------|
| `getChatbotSettings()` | `GET /bots/settings/public` | Fetch bot appearance and config |
| `sendMessageStream()` | `POST /chat/stream` | Send message, receive SSE stream |
| `sendMessage()` | `POST /chat` | Send message, receive sync response |
| `getChatHistory()` | `GET /chat/history/{id}` | Load previous messages |
| `submitFeedback()` | `POST /chat/feedback/{id}` | Submit thumbs up/down |
| `submitLeadCapture()` | `POST /chat/lead-capture` | Submit lead form data |
| `requestHandoff()` | `POST /operators/handoff` | Request live operator |
| `getDepartments()` | `GET /operators/departments/public` | List departments for routing |
| `submitOfflineMessage()` | `POST /offline-messages` | Leave message when offline |

### Component Structure

```
widget/src/
├── loader.js             # Production entry: stub-and-queue API + manifest resolution
├── app-entry.jsx         # Production app entry: shadow root + React mount
├── main.jsx              # Dev-server entry only
├── widget-controller.js  # Singleton bridge between window.OyeChats and React
├── services/api.js       # Backend API client (SSE parsing, journey tracking)
├── lib/                  # chatModeMachine, boundedPoll, slashCommands, liveChatTranslation
├── i18n/                 # localeCatalog (eager) + per-locale dictionaries (lazy)
└── components/
    ├── ChatWidget.jsx    # Launcher + panel shell
    ├── ChatWindow.jsx    # Main chat interface (lazy)
    ├── LiveChatMode.jsx  # Operator conversation (lazy)
    ├── LeadCaptureForm.jsx · HandoffForm.jsx · QuotationFlow.jsx · MeetingBooking.jsx  (lazy)
    └── MediaCard.jsx · MessageBubble.jsx · ...
```

## Build Process

`npm run build` runs **two** Vite builds in order — the app first, then the loader — and copies the host fixture:

```bash
cd widget
npm run build     # build:app → build:loader → copy-host-fixture
npm run size      # enforce the per-chunk gzipped budgets
```

**Output files:**
- `dist/oyechats-widget.js` — the loader IIFE, the only file customers reference
- `dist/app/manifest.json` — maps `src/app-entry.jsx` and `style.css` to their hashed filenames
- `dist/app/oyechats-*.[hash].js` — the code-split ESM app chunks
- `dist/app/oyechats-app.[hash].css` — the stylesheet injected into the shadow root

### Vite configuration

| Config | Builds | Format |
|---|---|---|
| `vite.loader.config.js` | `src/loader.js` → `dist/oyechats-widget.js` | IIFE, unhashed (a stable customer-facing URL) |
| `vite.app.config.js` | `src/app-entry.jsx` → `dist/app/*` | ESM, hashed, code-split, `cssCodeSplit=false` |
| `vite.config.js` | dev server only (`npm run dev`) | — |

### Size budgets

Budgets are enforced by `size-limit` and live in `widget/package.json` under the `size-limit` key, which is the authoritative list. Read them there rather than trusting a copy — the headline shapes are:

- **Loader: 8 KB gzipped.** This is what every page view pays.
- **Vendor chunk (React + axios + services): 67 KB gzipped.** Eagerly loaded.
- Chat, markdown, live chat, each form and each non-English locale are separately budgeted and **lazy**.

> The vendor chunk is currently running at roughly **99.9 % of its 67 KB ceiling**. Treat any new import that lands in the eager path as a budget decision, not an implementation detail — `npm run size` is the gate and it will fail before a build does.

## Development vs. Production

### Development Mode

```bash
cd widget
npm run dev    # → http://localhost:5173
```

The dev server is for **widget development only** (editing components, styling, etc.). It cannot be embedded on external sites because Vite's `@vitejs/plugin-react` injects a React Fast Refresh preamble that only works in its own `index.html`.

### Testing Embeds Locally

To test the widget embedded on another local site:

```bash
cd widget
npm run build                    # Build the production bundle
npx vite preview --port 4173     # Serve built files
```

Then embed on your test page:
```html
<script src="http://localhost:4173/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

### Production Deployment

The whole of `dist/` is deployed to `cdn.oyechats.com` (Cloudflare R2) by `deploy-widget.yml`:
- `https://cdn.oyechats.com/oyechats-widget.js` — the loader (stable URL, must not be hashed)
- `https://cdn.oyechats.com/app/manifest.json` — the chunk manifest the loader reads
- `https://cdn.oyechats.com/app/oyechats-*.[hash].js|css` — the app chunks

Because chunk filenames are hashed and the loader resolves them through the manifest, the app directory must be published **before** (or atomically with) the manifest — a manifest pointing at chunks that are not up yet is exactly the mid-deploy 404 the loader's retry path exists to survive.

## Customization

All widget customization is done through the admin dashboard (Bot Settings → Appearance). The widget fetches these settings at load time via `GET /bots/settings/public`:

| Setting | Description |
|---------|-------------|
| `name` | Bot display name in the header |
| `bot_logo` | Custom logo URL |
| `primary_color` | Accent color (hex) |
| `header_color` | Header background (hex) |
| `user_bubble_color` | User message bubble (hex) |
| `avatar_type` | Bot avatar style (e.g., `"orb"`) |
| `lead_form_enabled` | Show lead capture form |
| `lead_form_fields` | Which fields to collect |
| `live_chat_enabled` | Allow operator handoff |

## Isolation & Compatibility

The widget is designed to not interfere with the host page:

- **Own React instance:** The app bundles its own React 19 — it doesn't use or conflict with any React on the host page
- **Shadow DOM:** All widget UI lives inside an **open shadow root** on `<div id="oyechats-widget-root">`. That is what isolates styles in *both* directions — the host page cannot restyle the widget, and the widget cannot leak into the host page. It is stronger than prefixing.
- **Globals:** `window.OYECHATS_BOT_KEY` / `window.OYECHATS_API_KEY`, plus `window.OyeChats` (the public API — see [`../widget/docs/public-api.md`](../widget/docs/public-api.md))
- **Console prefix:** All logs are prefixed with `[OyeChats]`

## Naming Conventions

| Item | Value |
|------|-------|
| Widget loader (customer script tag) | `oyechats-widget.js` |
| Widget app chunks | `app/oyechats-*.[hash].js` · `app/oyechats-app.[hash].css` |
| Chunk manifest | `app/manifest.json` |
| DOM container | `oyechats-widget-root` (open shadow root) |
| Window globals | `window.OYECHATS_BOT_KEY`, `window.OYECHATS_API_KEY` |
| Console prefix | `[OyeChats]` |
| Production CDN | `cdn.oyechats.com/oyechats-widget.js` |
