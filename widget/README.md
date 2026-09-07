# OyeChats Widget

The embeddable chat widget. Customers paste one `<script>` tag into their site and a chatbot appears.

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>
```

## Architecture (post-bundle-split)

The build emits two layers:

- **`oyechats-widget.js`** (~1.3 KB gzipped) — the loader IIFE customers embed. Bootstraps the shadow DOM, exposes `window.OyeChats`, fetches the manifest, dynamically imports the app entry chunk.
- **`app/`** — the React app, ESM-only with code-splitting. The browser only downloads chunks as features are used.

Initial payload on a host page:

| Chunk | Gzipped | When |
|---|---|---|
| `oyechats-widget.js` (loader) | 1.3 KB | Script tag executes |
| `oyechats-app.[hash].js` (entry stub + entry code) | ~6 KB | Right after loader |
| `oyechats-vendor.[hash].js` (React + axios + services) | ~64 KB | Right after loader |
| `oyechats-app.[hash].css` | ~8 KB | Right after loader |
| **Subtotal: ~80 KB gzipped** | | |
| `oyechats-ChatWindow.[hash].js` | ~16 KB | First widget open |
| `oyechats-markdown.[hash].js` | ~36 KB | First widget open |
| `oyechats-LiveChatMode.[hash].js` | ~4 KB | Handoff requested |
| `oyechats-{HandoffForm,LeadCaptureForm,MeetingBooking}.[hash].js` | ~5 KB | Form shown |
| `oyechats-sentry.[hash].js` | ~149 KB | `OYECHATS_DEBUG=true` only |

For a visitor who never opens the widget, the cost is ~80 KB gzipped (down from 152 KB before the split).

## Development

```bash
npm install
npm run dev          # dev server on http://localhost:5173
npm run build        # builds loader + app into dist/
npm run preview      # serves dist/ on http://localhost:4173 (use this for cross-origin embed tests)
npm run lint
npm run size         # bundle-size budget check
npm run e2e          # Playwright tests (run e2e:install first)
```

The dev server is **not embeddable cross-origin** (Vite's React Fast Refresh preamble blocks it). Use `npm run preview` to test embedding on another site.

## Public API

See `docs/public-api.md` for the full surface.

```js
OyeChats.open()
OyeChats.close()
OyeChats.send('Hello')
OyeChats.identify({ name, email })
OyeChats.on('message:bot', (msg) => analytics.track('chat', msg))
OyeChats.diagnose()  // prints config sanity report
```

## Integration recipes

`docs/integrations/`
- [Next.js](docs/integrations/nextjs.md)
- [WordPress](docs/integrations/wordpress.md)
- [Webflow](docs/integrations/webflow.md)
- [Cookiebot / OneTrust (GDPR)](docs/integrations/cookiebot.md)

## npm packages (skeletons — not yet published)

- `packages/react/` → `@oyechats/react` — `<OyeChatsWidget />` + `useOyeChats()` hook
- `packages/next/` → `@oyechats/next` — Next.js `<Script>` wrapper

## File map

| Path | Purpose |
|---|---|
| `src/loader.js` | IIFE loader — script-tag detect, public API stub, manifest fetch, dynamic import |
| `src/app-entry.jsx` | App bootstrap — registers real public API, mounts React |
| `src/main.jsx` | Dev-server entry (mirrors loader logic, no manifest fetch) |
| `src/widget-controller.js` | Singleton state bridge between the public API and React |
| `src/components/ChatWidget.jsx` | FAB + open/close state machine |
| `src/components/ChatWindow.jsx` | Chat conversation UI (lazy chunk) |
| `src/services/api.js` | REST client |
| `vite.loader.config.js` | Loader build (IIFE) |
| `vite.app.config.js` | App build (ESM + code-split) |
| `vite.config.js` | Dev-server config |
| `dev/host.html` | Local fixture host page (embedded into `dist/index.html` by build) |
| `types/oyechats.d.ts` | Public API TypeScript declarations |
