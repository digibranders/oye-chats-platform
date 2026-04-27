# OyeChats Public API

Once the loader script (`oyechats-widget.js`) runs, `window.OyeChats` is available — even before the React app finishes loading. Calls made during loading are queued and replayed.

## Methods

| Method | Description |
|---|---|
| `OyeChats.init(config?)` | Mount the widget. Required only if `OYECHATS_ASYNC_INIT === true`. |
| `OyeChats.destroy()` | Unmount and clean up the shadow DOM. Use on SPA logout / route change. |
| `OyeChats.open()` | Open the chat panel. |
| `OyeChats.close()` | Close the chat panel. |
| `OyeChats.toggle()` | Toggle open/closed. |
| `OyeChats.send(text)` | Send a message programmatically — same effect as the visitor typing. |
| `OyeChats.identify({ name, email, phone, attributes })` | Set or merge visitor identity. Persists across sessions until `shutdown()`. |
| `OyeChats.boot(visitor)` | Set fresh visitor identity, start a new session. Use on user login. |
| `OyeChats.shutdown()` | Clear visitor identity and reset session. Use on user logout. |
| `OyeChats.update({ primaryColor, headerColor, position, locale })` | Apply runtime config overrides. |
| `OyeChats.on(event, cb)` | Subscribe to an event. |
| `OyeChats.off(event, cb)` | Unsubscribe. |
| `OyeChats.once(event, cb)` | Subscribe; auto-unregister after first fire. |
| `OyeChats.diagnose()` | Print and return a config sanity report. Paste into a support ticket. |
| `OyeChats.version` | Widget version string. |

## Events

| Event | Payload | Fires when |
|---|---|---|
| `ready` | `{ version }` | The widget has mounted and is ready to receive commands |
| `open` | — | The chat panel opened |
| `close` | — | The chat panel closed |
| `message:user` | `{ text, sessionId }` | Visitor sent a message |
| `message:bot` | `{ text, sessionId }` | Bot replied (final, after streaming completes) |
| `handoff:requested` | `{ sessionId }` | Visitor requested a live operator |
| `handoff:accepted` | `{ sessionId, operator }` | Operator joined the chat |
| `rating:submitted` | `{ sessionId, rating, comment? }` | Visitor submitted a post-chat rating |
| `lead:captured` | `{ name, email, phone? }` | Lead capture form submitted |
| `error` | `{ message, source }` | An error occurred (network, validation, etc.) |

## Examples

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>

<script>
  // Pre-register handlers — the queue absorbs these until the widget loads.
  OyeChats.on('ready', () => console.log('OyeChats ready'));
  OyeChats.on('lead:captured', (lead) => analytics.track('chat_lead', lead));
  OyeChats.on('message:bot', () => analytics.track('chat_engaged'));

  // Sync with logged-in user state (idempotent)
  if (window.currentUser) {
    OyeChats.identify(currentUser);
  }
</script>
```

## TypeScript

Add `@oyechats/types` (or vendor the `types/oyechats.d.ts` file) to get IntelliSense:

```ts
import type {} from '@oyechats/types'  // augments the global Window
window.OyeChats.identify({ name: 'Alex' })  // ✓ typed
```

## Loader globals (set BEFORE the script tag)

| Global | Effect |
|---|---|
| `window.OYECHATS_ASYNC_INIT = true` | Defer mount until `OyeChats.init()` is called (GDPR-friendly) |
| `window.OYECHATS_DEBUG = true` | Verbose logging, lazy-load Sentry on first error |
| `window.OYECHATS_BASE = 'https://...'` | Override CDN base URL for chunks |
