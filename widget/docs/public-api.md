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
| `OyeChats.setLocale(locale)` | Switch the widget's language at runtime (e.g. `'hi-IN'`). Subject to the bot's "allow visitor language switch" setting, which is enforced server-side. |
| `OyeChats.getLocale()` | Current locale. Answers from `localStorage` even before the app has loaded, so it is safe to call immediately after the script tag. |
| `OyeChats.on(event, cb)` | Subscribe to an event. |
| `OyeChats.off(event, cb)` | Unsubscribe. |
| `OyeChats.once(event, cb)` | Subscribe; auto-unregister after first fire. |
| `OyeChats.diagnose()` | Print and return a config sanity report. Paste into a support ticket. |
| `OyeChats.version` | Widget version string. |
| `OyeChats.build` | Build identifier. |

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
| `localeChanged` | `{ locale, language, direction }` | The widget's locale changed (via `setLocale`, `update({locale})`, or the in-widget picker) |

> **Only `ready`, `open`, `close` and `localeChanged` currently fire.** The other events in
> this table are registered as valid and accepted by `on()` / `once()` without warning, but
> no code emits them — subscribing to `message:bot`, `lead:captured`, `handoff:requested`,
> `handoff:accepted`, `rating:submitted`, `message:user` or `error` gives you a handler that
> is never called. They are specified here and in `widget/types/oyechats.d.ts` because they
> are the intended contract; the emit sites have not been written. **Do not build an
> integration on them yet** — verified against `widget/src/widget-controller.js` and every
> `emit(` call site on 2026-08-31.

## Examples

```html
<script src="https://cdn.oyechats.com/oyechats-widget.js" data-bot-key="bot-xxx"></script>

<script>
  // Pre-register handlers — the queue absorbs these until the widget loads.
  // Only the events marked as firing above will call back today.
  OyeChats.on('ready', () => console.log('OyeChats ready'));
  OyeChats.on('open', () => analytics.track('chat_opened'));
  OyeChats.on('localeChanged', ({ locale }) => analytics.track('chat_locale', { locale }));

  // Sync with logged-in user state (idempotent)
  if (window.currentUser) {
    OyeChats.identify(currentUser);
  }
</script>
```

## TypeScript

Vendor `widget/types/oyechats.d.ts` into your project and reference it to get IntelliSense:

```ts
/// <reference path="./oyechats.d.ts" />
window.OyeChats.identify({ name: 'Alex' })  // ✓ typed
```

> A published `@oyechats/types` package is **not confirmed to exist** — the declaration file
> itself calls it "forthcoming". The `@oyechats/next` and `@oyechats/react` wrappers live in
> the repo at `widget/packages/`, both at `0.1.0`; whether either is published to npm is
> likewise unverified. Vendor the file until someone confirms a registry entry.

## Loader globals (set BEFORE the script tag)

| Global | Effect |
|---|---|
| `window.OYECHATS_ASYNC_INIT = true` | Defer mount until `OyeChats.init()` is called (GDPR-friendly) |
| `window.OYECHATS_DEBUG = true` | Verbose logging, lazy-load Sentry on first error |
| `window.OYECHATS_BASE = 'https://...'` | Override CDN base URL for chunks |
