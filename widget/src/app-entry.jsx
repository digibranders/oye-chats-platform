import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { getController } from './widget-controller.js'
import { getDirection, onLocaleChange, setLocale } from './i18n/i18n.js'
import { readLocalePreference } from './services/storage-keys.js'
import { CONTAINER_ID, ensureHost, ensureStylesheet, whenStylesheetReady } from './lib/widgetHost.js'

// True when the page embedding the widget is a developer machine rather than a
// deployed site, including a production widget bundle (`vite preview`) dropped
// onto a localhost test page.
const isLocalHostname = (hostname) => {
  const host = String(hostname || '').toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  )
}

// Lazy-loaded only on first error or when OYECHATS_DEBUG=true.
// Production only: dev builds and localhost-embedded widgets are skipped so
// developer noise never reaches the Sentry project that pages on real incidents.
const loadSentry = async () => {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn || !import.meta.env.PROD) return
  if (isLocalHostname(window.location.hostname)) return
  try {
    const Sentry = await import('@sentry/react')
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      // Errors + light tracing only, no Replay, Profiling or Logs. We are on
      // the Sentry free plan, where blowing any one of those quotas pauses
      // ingestion project-wide and we lose error reporting too. Replay is
      // doubly unwanted here: this bundle runs on the CUSTOMER's page, so a
      // replay would record their visitors, not just our widget.
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
    })
  } catch (e) {
    console.warn('[OyeChats] Sentry load failed:', e)
  }
}

if (typeof window !== 'undefined' && window.OYECHATS_DEBUG === true) {
  void loadSentry()
}

const VERSION = typeof __WIDGET_VERSION__ !== 'undefined' ? __WIDGET_VERSION__ : '0.0.0'
const BUILD = typeof __WIDGET_BUILD__ !== 'undefined' ? __WIDGET_BUILD__ : 'dev'

const RENDER_TARGET_ID = 'oyechats-shadow-inner'

let _root = null
let _container = null
// Set while mount() waits for the stylesheet, so a second init() in that
// window does not start a second wait.
let _pendingMount = null

const ensureRenderTarget = (container, shadow) => {
  let target = shadow.querySelector(`#${RENDER_TARGET_ID}`)
  if (!target) {
    target = document.createElement('div')
    target.id = RENDER_TARGET_ID
    shadow.appendChild(target)
  }
  const dir = getDirection()
  container.setAttribute('dir', dir)
  target.setAttribute('dir', dir)
  return target
}

// Real public-API implementation. Registered with the loader stub so queued
// calls replay against this object instead of the queue.
const buildPublicApi = () => {
  const ctrl = getController()
  return {
    version: VERSION,
    build: BUILD,
    init: () => mount(),
    destroy: () => unmount(),
    open: () => ctrl.open(),
    close: () => ctrl.close(),
    toggle: () => ctrl.toggle(),
    send: (text) => ctrl.send(text),
    identify: (v) => ctrl.identify(v),
    shutdown: () => ctrl.shutdown(),
    boot: (v) => ctrl.boot(v),
    update: (cfg) => ctrl.update(cfg),
    setLocale: (loc) => ctrl.setLocale(loc),
    getLocale: () => ctrl.getLocale(),
    on: (e, cb) => ctrl.on(e, cb),
    off: (e, cb) => ctrl.off(e, cb),
    once: (e, cb) => ctrl.once(e, cb),
    diagnose: () => diagnose(),
  }
}

const diagnose = () => {
  const report = {
    version: VERSION,
    build: BUILD,
    botKey: window.OYECHATS_BOT_KEY ? `${String(window.OYECHATS_BOT_KEY).slice(0, 8)}…` : null,
    apiKey: window.OYECHATS_API_KEY ? '(legacy api-key set)' : null,
    asyncInit: window.OYECHATS_ASYNC_INIT === true,
    debug: window.OYECHATS_DEBUG === true,
    container: !!document.getElementById(CONTAINER_ID),
    mounted: !!_root,
    visitor: getController().getVisitor(),
    runtimeConfig: getController().getRuntimeConfig(),
    apiUrl: import.meta.env.VITE_API_URL || 'https://api.oyechats.com',
    userAgent: navigator.userAgent,
  }
  console.log('[OyeChats] diagnose():', report)
  return report
}

let _bootContext = null
let _registered = false
let _localeUnsubscribe = null

const render = (target) => {
  _root = createRoot(target)
  _root.render(
    <StrictMode>
      {/* Last-resort catch-all: the per-Suspense boundaries inside ChatWindow
          handle lazy-chunk failures locally, but this guarantees no render
          throw anywhere in the tree can ever unmount the whole widget and
          leave the visitor staring at nothing. */}
      <ErrorBoundary label="root" fallback={null}>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )

  // Keep the Shadow DOM host `dir` synced with the active locale. The
  // unsubscribe function must be retained and called from unmount(): an
  // init/destroy/init cycle otherwise leaves every previous listener alive,
  // each holding a closure over a `_container` that is no longer in the
  // document.
  _localeUnsubscribe = onLocaleChange(({ direction }) => {
    if (_container) _container.setAttribute('dir', direction)
    const shadow = _container?.shadowRoot
    const shadowTarget = shadow?.querySelector(`#${RENDER_TARGET_ID}`)
    if (shadowTarget) shadowTarget.setAttribute('dir', direction)
  })

  // Fire ready on next tick so any synchronous handlers attached during init
  // can register before they're called.
  setTimeout(() => getController().emit('ready', { version: VERSION }), 0)
}

const mount = () => {
  if (_root || _pendingMount) return
  if (!_bootContext) {
    console.error('[OyeChats] init() called before loader bootstrap, no boot context.')
    return
  }
  // Apply a previously stored locale before the shadow host is created, so a
  // returning RTL visitor does not get a frame of left-to-right layout while
  // the bot settings request is still in flight. ChatWidget re-resolves against
  // the bot's supported locales once settings arrive and corrects this if the
  // stored value is no longer offered.
  const storedPreference = readLocalePreference()
  if (storedPreference?.locale) setLocale(storedPreference.locale)

  const { host, shadow } = ensureHost()
  _container = host
  const link = _bootContext.cssUrl ? ensureStylesheet(shadow, _bootContext.cssUrl) : null
  const target = ensureRenderTarget(host, shadow)
  if (target.dataset.oyechatsMounted === 'true') return
  target.dataset.oyechatsMounted = 'true'
  if (!link) {
    render(target)
    return
  }

  // Render only once the stylesheet applies. Before that the launcher draws as
  // an unstyled button inside the customer's page, then jumps into its corner.
  const pending = {}
  _pendingMount = pending
  whenStylesheetReady(link).then(
    () => {
      if (_pendingMount !== pending) return
      _pendingMount = null
      render(target)
    },
    (error) => {
      if (_pendingMount !== pending) return
      _pendingMount = null
      target.dataset.oyechatsMounted = ''
      // Dropped so a later OyeChats.init() requests the stylesheet afresh
      // instead of reusing the failed element.
      link.remove()
      console.error('[OyeChats]', error)
      getController().emit('error', { message: error.message, source: 'stylesheet' })
    },
  )
}

const unmount = () => {
  _pendingMount = null
  if (_localeUnsubscribe) {
    try { _localeUnsubscribe() } catch { /* listener already gone */ }
    _localeUnsubscribe = null
  }
  if (_root) {
    try { _root.unmount() } catch (e) { console.warn('[OyeChats] unmount error:', e) }
    _root = null
  }
  if (_container) {
    try {
      const shadow = _container.shadowRoot
      if (shadow) {
        const target = shadow.querySelector(`#${RENDER_TARGET_ID}`)
        if (target) target.dataset.oyechatsMounted = ''
      }
      _container.remove()
    } catch { /* ignore */ }
    _container = null
  }
  getController().shutdown()
  getController().resetReady()
}

// Entry exported to the loader. Called once after dynamic import resolves.
export const init = (ctx) => {
  _bootContext = ctx
  if (!_registered && ctx?.register) {
    ctx.register(buildPublicApi())
    _registered = true
  }
  // If async-init is on, the loader called init() because the customer ran
  // OyeChats.init(). Mount immediately. Otherwise also mount (auto path).
  mount()
}

// Allow direct usage from main.jsx in dev (no loader present).
export default init
