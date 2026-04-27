import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { getController } from './widget-controller.js'

// Lazy-loaded only on first error or when OYECHATS_DEBUG=true.
const loadSentry = async () => {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return
  try {
    const Sentry = await import('@sentry/react')
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
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
      <App />
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
