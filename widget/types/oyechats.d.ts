// Public TypeScript declarations for the OyeChats widget global.
// Customers consuming the script-tag install get IntelliSense by
// adding this file as a triple-slash reference, OR by installing
// the (forthcoming) `@oyechats/types` package.

export interface OyeChatsVisitor {
  id?: string
  name?: string
  email?: string
  phone?: string
  attributes?: Record<string, string | number | boolean | null>
}

export interface OyeChatsRuntimeConfig {
  primaryColor?: string
  headerColor?: string
  position?: 'bottom-right' | 'bottom-left'
  locale?: string
  hideLauncher?: boolean
}

export interface OyeChatsInitConfig {
  botKey?: string
  apiKey?: string
}

export type OyeChatsEvent =
  | 'ready'
  | 'open'
  | 'close'
  | 'message:user'
  | 'message:bot'
  | 'handoff:requested'
  | 'handoff:accepted'
  | 'rating:submitted'
  | 'lead:captured'
  | 'error'

export interface OyeChatsDiagnoseReport {
  version: string
  build: string
  botKey: string | null
  apiKey: string | null
  asyncInit: boolean
  debug: boolean
  container: boolean
  mounted: boolean
  visitor: OyeChatsVisitor | null
  runtimeConfig: OyeChatsRuntimeConfig
  apiUrl: string
  userAgent: string
}

export interface OyeChatsApi {
  /** Widget version, e.g. "2.2.0". */
  readonly version: string
  /** Build timestamp from CI. */
  readonly build: string
  /** Mount the widget. Required only when `window.OYECHATS_ASYNC_INIT === true`. */
  init(config?: OyeChatsInitConfig): void | Promise<void>
  /** Unmount the widget completely. Use on SPA logout / route changes. */
  destroy(): void
  /** Open the chat panel. */
  open(): void
  /** Close the chat panel. */
  close(): void
  /** Toggle the chat panel. */
  toggle(): void
  /** Send a message programmatically. Triggers the same flow as the user typing. */
  send(text: string): void
  /** Set or merge visitor identity. Persisted across sessions until shutdown(). */
  identify(visitor: OyeChatsVisitor): void
  /** Clear visitor identity and reset the session. Use on user logout. */
  shutdown(): void
  /** Set a fresh visitor identity and start a new session. Use on user login. */
  boot(visitor: OyeChatsVisitor): void
  /** Update runtime config (theme, position, locale). */
  update(config: OyeChatsRuntimeConfig): void
  /** Subscribe to a widget event. */
  on(event: OyeChatsEvent, callback: (payload?: unknown) => void): void
  /** Unsubscribe a previously-registered handler. */
  off(event: OyeChatsEvent, callback: (payload?: unknown) => void): void
  /** Subscribe and auto-unregister after the first fire. */
  once(event: OyeChatsEvent, callback: (payload?: unknown) => void): void
  /** Print and return a config-sanity report. Paste into a support ticket. */
  diagnose(): OyeChatsDiagnoseReport
}

declare global {
  interface Window {
    /** Defer widget mount until OyeChats.init() is called. Set BEFORE the script tag. */
    OYECHATS_ASYNC_INIT?: boolean
    /** Enable verbose console logging + Sentry. Set BEFORE the script tag. */
    OYECHATS_DEBUG?: boolean
    /** Optional base URL override for chunk loading (defaults to script src directory). */
    OYECHATS_BASE?: string
    /** Bot key (set by the loader from data-bot-key, but writable for advanced use). */
    OYECHATS_BOT_KEY?: string
    /** Legacy API key (back-compat with single-bot installs). */
    OYECHATS_API_KEY?: string
    /** The public OyeChats API. */
    OyeChats: OyeChatsApi
  }
}
