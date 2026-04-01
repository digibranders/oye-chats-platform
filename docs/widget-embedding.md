# Widget Embedding Guide

The OyeChat widget is a self-contained JavaScript bundle that renders an AI chatbot on any website. It works on any platform — Next.js, React, WordPress, Webflow, Shopify, plain HTML — anything with a `<body>` tag.

## How It Works

The widget (`oyechats-widget.js`) is an IIFE (Immediately Invoked Function Expression) bundle (~416KB) that:

1. Finds its own `<script>` tag and reads the `data-bot-key` attribute
2. Sets `window.OYECHAT_BOT_KEY` globally
3. Auto-injects its sibling CSS file (`oyechats-widget.css`) in production
4. Creates a `<div id="oyechats-widget-root">` in the DOM
5. Renders a React app with its own bundled React instance (isolated from the host page)
6. Communicates with the backend API via `X-Bot-Key` header

## Production Embed

Add this single line before the closing `</body>` tag:

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

Replace `bot-xxx` with the bot key from the admin dashboard. That's it — the widget handles everything else automatically.

## What the Visitor Sees

1. A floating chat button appears in the bottom-right corner of the page
2. Clicking it opens the chat window with the bot's custom branding (colors, logo, name)
3. The visitor types a question and receives a streaming AI response
4. Optionally: a lead capture form appears, or live chat handoff is offered

## Widget Architecture

### Entry Point (`widget/src/main.jsx`)

The entry point handles bootstrapping:
- Detects the script tag and extracts `data-bot-key` (or legacy `data-api-key`)
- Initializes Sentry error tracking if configured
- Creates the root DOM container
- Renders the React application

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
├── main.jsx              # Entry point, CSS injection, bot key detection
├── App.jsx               # Root component
├── services/
│   └── api.js            # Backend API client
└── components/           # 14 UI components
    ├── ChatWindow.jsx    # Main chat interface
    ├── Launcher.jsx      # Floating button
    ├── MessageBubble.jsx # Individual messages
    ├── LeadForm.jsx      # Contact capture form
    └── ...               # Input, headers, feedback, etc.
```

## Build Process

The widget is built with Vite into a single-file bundle:

```bash
cd widget
npm run build
```

**Output files:**
- `dist/oyechats-widget.js` — IIFE bundle with React, all components, and Tailwind styles
- `dist/oyechats-widget.css` — Extracted CSS

### Vite Configuration (`widget/vite.config.js`)

Key build settings:
- **Format:** IIFE (no module imports needed by the host page)
- **Entry:** `src/main.jsx`
- **Output names:** `oyechats-widget.js` and `oyechats-widget.css`
- **CSS:** Not code-split; all styles are bundled into the single CSS file
- **Dev CORS:** Enabled for local development

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

The built files are deployed to `cdn.oyechats.com`:
- `https://cdn.oyechats.com/oyechats-widget.js`
- `https://cdn.oyechats.com/oyechats-widget.css`

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

- **Own React instance:** The bundle includes its own React 19 — it doesn't use or conflict with any React on the host page
- **Scoped DOM:** All widget UI lives inside `<div id="oyechats-widget-root">`
- **Scoped styles:** CSS is prefixed/scoped to avoid leaking into the host page
- **No global pollution:** Only `window.OYECHAT_BOT_KEY` and `window.OYECHAT_API_KEY` are set globally
- **Console prefix:** All logs are prefixed with `[OyeChat]`

## Naming Conventions

| Item | Value |
|------|-------|
| Widget bundle | `oyechats-widget.js` / `oyechats-widget.css` |
| DOM container | `oyechats-widget-root` |
| Window globals | `window.OYECHAT_BOT_KEY`, `window.OYECHAT_API_KEY` |
| Console prefix | `[OyeChat]` |
| Production CDN | `cdn.oyechats.com/oyechats-widget.js` |
