import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { getController } from './widget-controller.js'

// True when the page embedding the widget is a developer machine rather than a
// deployed site — including a production widget bundle (`vite preview`) dropped
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
      integrations: [
        // Replay records the DOM of the CUSTOMER's page, not just our widget.
        // Hence: everything masked, media blocked, and error-only capture — we
        // never record a visitor session that completed without a crash.
        Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
        // Only activates when the host page serves `Document-Policy:
        // js-profiling`; on every other site the browser withholds the JS
        // profiler and the integration is inert. We cannot set that header on
        // a customer's domain, so treat profiles here as best-effort.
        Sentry.browserProfilingIntegration(),
        Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
      ],
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1.0,
      profileSessionSampleRate: 0.1,
      profileLifecycle: 'trace',
      enableLogs: true,
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

const CONTAINER_ID = 'oyechats-widget-root'
const RENDER_TARGET_ID = 'oyechats-shadow-inner'
const STYLE_LINK_ATTR = 'data-oyechats-style'

let _root = null
let _container = null

const ensureContainer = () => {
  let container = document.getElementById(CONTAINER_ID)
  if (!container) {
    container = document.createElement('div')
    container.id = CONTAINER_ID
    document.body.appendChild(container)
  }
  // Opt this subtree out of Lenis smooth-scroll hijacking. When a wheel event
  // crosses the Shadow DOM boundary it is retargeted to this host element, so
  // Lenis's ancestor check sees the attribute here and lets native scrolling
  // through — covering the case (capture-phase listeners) that plain
  // stopPropagation inside the widget can't. Complements the wheel-propagation
  // guard in ChatWindow, which defeats bubble-phase hijackers generically.
  container.setAttribute('data-lenis-prevent', '')
  return container
}

const ensureShadowAndStyles = (container, cssUrl) => {
  const shadow = container.shadowRoot || container.attachShadow({ mode: 'open' })
  if (cssUrl && !shadow.querySelector(`link[${STYLE_LINK_ATTR}="1"]`)) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = cssUrl
    link.setAttribute(STYLE_LINK_ATTR, '1')
    shadow.appendChild(link)
  }
  let target = shadow.querySelector(`#${RENDER_TARGET_ID}`)
  if (!target) {
    target = document.createElement('div')
    target.id = RENDER_TARGET_ID
    shadow.appendChild(target)
  }
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

const mount = () => {
  if (_root) return
  if (!_bootContext) {
    console.error('[OyeChats] init() called before loader bootstrap — no boot context.')
    return
  }
  const container = ensureContainer()
  _container = container
  const target = ensureShadowAndStyles(container, _bootContext.cssUrl)
  if (target.dataset.oyechatsMounted === 'true') return
  target.dataset.oyechatsMounted = 'true'
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
  // Fire ready on next tick so any synchronous handlers attached during init
  // can register before they're called.
  setTimeout(() => getController().emit('ready', { version: VERSION }), 0)
}

const unmount = () => {
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
}

// Entry exported to the loader. Called once after dynamic import resolves.
export const init = (ctx) => {
  _bootContext = ctx
  if (!_registered && ctx?.register) {
    ctx.register(buildPublicApi())
    _registered = true
  }
  // If async-init is on, the loader called init() because the customer ran
  // OyeChats.init() — mount immediately. Otherwise also mount (auto path).
  mount()
}

// Allow direct usage from main.jsx in dev (no loader present).
export default init
