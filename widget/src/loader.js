// OyeChats widget loader (IIFE).
// Responsibilities:
//   1. Detect the embedding <script> tag and read `data-bot-key` / `data-api-key`.
//   2. Expose `window.OyeChats` as a stub-and-queue API so customer code can call
//      `OyeChats.on('ready', cb)` etc. before the React app has loaded.
//   3. Honor `window.OYECHATS_ASYNC_INIT` for consent-gated installs (GDPR).
//   4. Mount the shadow DOM container, fetch the app manifest from CDN,
//      and dynamic-import the ESM app entry chunk.
//
// Kept tiny on purpose — every byte here ships on every customer page load.

const VERSION = typeof __WIDGET_VERSION__ !== 'undefined' ? __WIDGET_VERSION__ : '0.0.0'
const BUILD = typeof __WIDGET_BUILD__ !== 'undefined' ? __WIDGET_BUILD__ : 'dev'
const PREFIX = '[OyeChats]'

// ── Public API stub: queues calls until the real implementation registers. ──
const _queue = []
let _impl = null

const stubMethod = (name) => (...args) => {
  if (_impl && typeof _impl[name] === 'function') {
    return _impl[name](...args)
  }
  if (name === 'get') {
    throw new Error(`${PREFIX} OyeChats.get() called before widget loaded`)
  }
  _queue.push([name, args])
  return undefined
}

const stub = {
  version: VERSION,
  build: BUILD,
  init: stubMethod('init'),
  destroy: stubMethod('destroy'),
  open: stubMethod('open'),
  close: stubMethod('close'),
  toggle: stubMethod('toggle'),
  send: stubMethod('send'),
  identify: stubMethod('identify'),
  shutdown: stubMethod('shutdown'),
  boot: stubMethod('boot'),
  update: stubMethod('update'),
  on: stubMethod('on'),
  off: stubMethod('off'),
  once: stubMethod('once'),
  diagnose: stubMethod('diagnose'),
  __register(impl) {
    _impl = impl
    while (_queue.length) {
      const [name, args] = _queue.shift()
      if (typeof impl[name] === 'function') {
        try {
          impl[name](...args)
        } catch (err) {
          console.error(`${PREFIX} replay of ${name}() failed:`, err)
        }
      }
    }
  },
}

// Expose immediately so customer scripts after this one can register handlers.
if (typeof window !== 'undefined') {
  window.OyeChats = window.OyeChats || stub
}

// ── Script tag detection (preserves legacy behavior). ──────────────────────
const findScriptTag = () => {
  if (document.currentScript) return document.currentScript
  const scripts = document.getElementsByTagName('script')
  for (let i = scripts.length - 1; i >= 0; i--) {
    const s = scripts[i]
    if (s.getAttribute('data-bot-key') || s.getAttribute('data-api-key')) {
      return s
    }
    if (s.src && s.src.includes('oyechats-widget')) {
      return s
    }
  }
  return null
}

const scriptTag = findScriptTag()
const botKey = scriptTag?.getAttribute('data-bot-key') || null
const apiKey = scriptTag?.getAttribute('data-api-key') || null

if (botKey) {
  window.OYECHATS_BOT_KEY = botKey
} else if (apiKey) {
  window.OYECHATS_API_KEY = apiKey
}

// ── Resolve the base URL for app chunks. ───────────────────────────────────
// Priority: explicit window override → script src directory → empty (dev).
const resolveBaseUrl = () => {
  if (typeof window.OYECHATS_BASE === 'string' && window.OYECHATS_BASE) {
    return window.OYECHATS_BASE.replace(/\/$/, '')
  }
  if (scriptTag?.src) {
    try {
      const url = new URL(scriptTag.src)
      // strip filename → directory; loader sits next to /app/manifest.json
      const dir = url.href.substring(0, url.href.lastIndexOf('/'))
      return dir
    } catch {
      // ignore
    }
  }
  return ''
}

const BASE_URL = resolveBaseUrl()

// ── Boot the React app via dynamic import. ─────────────────────────────────
let _bootPromise = null

const boot = async (overrides = {}) => {
  if (_bootPromise) return _bootPromise

  // Apply runtime overrides before the app loads.
  if (overrides.botKey) window.OYECHATS_BOT_KEY = overrides.botKey
  if (overrides.apiKey) window.OYECHATS_API_KEY = overrides.apiKey

  _bootPromise = (async () => {
    try {
      const manifestUrl = `${BASE_URL}/app/manifest.json`
      const res = await fetch(manifestUrl, { credentials: 'omit', mode: 'cors' })
      if (!res.ok) {
        throw new Error(`manifest fetch failed: ${res.status}`)
      }
      const manifest = await res.json()
      const entry = manifest['src/app-entry.jsx']
      if (!entry || !entry.file) {
        throw new Error('manifest missing entry chunk')
      }
      const entryUrl = `${BASE_URL}/app/${entry.file}`
      // CSS lookup: prefer entry.css[] (set when cssCodeSplit=true), else
      // fall back to the top-level style.css manifest entry (cssCodeSplit=false).
      let cssFile = entry.css?.[0]
      if (!cssFile) {
        const styleEntry = manifest['style.css']
        if (styleEntry?.file) cssFile = styleEntry.file
      }
      const cssUrl = cssFile ? `${BASE_URL}/app/${cssFile}` : null

      const mod = await import(/* @vite-ignore */ entryUrl)
      if (typeof mod.init !== 'function') {
        throw new Error('app entry missing init() export')
      }
      mod.init({
        baseUrl: BASE_URL,
        cssUrl,
        scriptTag,
        version: VERSION,
        build: BUILD,
        register: (impl) => stub.__register(impl),
      })
    } catch (err) {
      console.error(`${PREFIX} failed to boot widget:`, err, '\n→ Action: confirm CORS on the chunk URLs and that the bot-key is valid.')
    }
  })()

  return _bootPromise
}

// Bind the stub's init to the boot logic so OyeChats.init() works post-load too.
const _stubInit = stub.init
stub.init = (overrides) => {
  if (_impl && typeof _impl.init === 'function') return _impl.init(overrides)
  return boot(overrides)
}
// Reassign for safety in case the customer cached the original reference.
if (typeof window !== 'undefined') {
  window.OyeChats = stub
}
void _stubInit  // satisfy lint about unused variable

// ── Auto-init unless deferred. ─────────────────────────────────────────────
if (typeof window !== 'undefined' && window.OYECHATS_ASYNC_INIT === true) {
  console.log(`${PREFIX} v${VERSION} loader ready (deferred — call OyeChats.init() to mount)`)
} else {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot())
  } else {
    boot()
  }
}
