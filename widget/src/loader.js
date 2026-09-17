// OyeChats widget loader (IIFE).
// Responsibilities:
//   1. Detect the embedding <script> tag and read `data-bot-key` / `data-api-key`.
//   2. Expose `window.OyeChats` as a stub-and-queue API so customer code can call
//      `OyeChats.on('ready', cb)` etc. before the React app has loaded.
//   3. Honor `window.OYECHATS_ASYNC_INIT` for consent-gated installs (GDPR).
//   4. Create the shadow host, start the stylesheet, and dynamic-import the
//      ESM app entry chunk together with the chunks it depends on.
//
// Kept tiny on purpose. Every byte here ships on every customer page load.

import { chunksFromManifest } from './lib/manifestChunks.js'
import { ensureHost, ensureStylesheet } from './lib/widgetHost.js'

const VERSION = typeof __WIDGET_VERSION__ !== 'undefined' ? __WIDGET_VERSION__ : '0.0.0'
const BUILD = typeof __WIDGET_BUILD__ !== 'undefined' ? __WIDGET_BUILD__ : 'dev'
// The app build's chunk names, baked in by vite.loader.config.js. Saves the
// manifest round trip on every page view. Null when the loader was built
// without the app, in which case boot() reads the manifest instead.
const BUILT_CHUNKS = typeof __OYECHATS_CHUNKS__ !== 'undefined' ? __OYECHATS_CHUNKS__ : null
const PREFIX = '[OyeChats]'

// A second execution of this loader (SPA re-mount, GTM firing on two triggers,
// two copies of the snippet) must not replace an API object that is already
// installed: the cached app-entry module registers its implementation exactly
// once, into the FIRST stub, so a fresh stub's queue would never drain and
// open() / send() / on('ready') would go silent forever. When one is already
// there, this execution installs nothing and boots nothing.
const _alreadyInstalled =
  typeof window !== 'undefined' && typeof window.OyeChats?.__register === 'function'

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
  setLocale: stubMethod('setLocale'),
  getLocale: () => {
    if (_impl && typeof _impl.getLocale === 'function') {
      return _impl.getLocale()
    }
    try {
      const key = (typeof window !== 'undefined' && (window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY)) || 'default'
      const raw = typeof localStorage !== 'undefined' && localStorage.getItem(`oyechats_locale_${key}`)
      if (!raw) return 'en-IN'
      // The app persists `{ locale, source }` (storage-keys.writeLocale); older
      // builds wrote the bare locale string. Handle both, never return the blob.
      if (raw[0] === '{') {
        const parsed = JSON.parse(raw)
        return (parsed && typeof parsed.locale === 'string' && parsed.locale) || 'en-IN'
      }
      return raw
    } catch {
      return 'en-IN'
    }
  },
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
const apiUrl = scriptTag?.getAttribute('data-api-url') || null

if (_alreadyInstalled) {
  // Keep the first install's credentials and API object intact.
} else if (botKey) {
  window.OYECHATS_BOT_KEY = botKey
} else if (apiKey) {
  window.OYECHATS_API_KEY = apiKey
}
if (_alreadyInstalled) {
  // Same reason: the running widget already resolved its API URL.
} else if (apiUrl) {
  window.OYECHATS_API_URL = apiUrl
} else if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
  if (!window.OYECHATS_API_URL && scriptTag?.src?.includes('localhost')) {
    window.OYECHATS_API_URL = 'http://localhost:8000'
  }
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

const fetchManifestChunks = async () => {
  const res = await fetch(`${BASE_URL}/app/manifest.json`, { credentials: 'omit', mode: 'cors' })
  if (!res.ok) {
    throw new Error(`manifest fetch failed: ${res.status}`)
  }
  return chunksFromManifest(await res.json())
}

const boot = async (overrides = {}) => {
  if (_bootPromise) return _bootPromise

  // Apply runtime overrides before the app loads.
  if (overrides.botKey) window.OYECHATS_BOT_KEY = overrides.botKey
  if (overrides.apiKey) window.OYECHATS_API_KEY = overrides.apiKey

  _bootPromise = (async () => {
    try {
      const chunks = BUILT_CHUNKS || await fetchManifestChunks()
      const chunkUrl = (file) => `${BASE_URL}/app/${file}`
      const cssUrl = chunks.css ? chunkUrl(chunks.css) : null

      // Start the stylesheet now, in parallel with the scripts. The app waits
      // for it before rendering, so starting it here is what keeps it from
      // adding its own round trip after the JS.
      if (cssUrl && document.body) {
        ensureStylesheet(ensureHost().shadow, cssUrl)
      }
      // The entry is a two-line module that re-exports the app from these
      // chunks. Requesting them now fetches them alongside the entry instead
      // of after it has been parsed. A failure here resurfaces, and is
      // reported, through the entry import below.
      for (const file of chunks.imports) {
        import(/* @vite-ignore */ chunkUrl(file)).catch(() => undefined)
      }

      const mod = await import(/* @vite-ignore */ chunkUrl(chunks.entry))
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
      // Reset so a later OyeChats.init() can retry on the same page after
      // a transient failure (CORS hiccup, CDN blip, manifest 404 mid-deploy).
      // Without this, the rejected promise is cached forever and the widget
      // can never recover without a full page reload.
      _bootPromise = null
      throw err
    }
  })()

  // Swallow the rejection at the top level so the unhandledrejection handler
  // doesn't fire. We already logged it inside the IIFE. Callers who want
  // explicit error handling should chain `.catch()` themselves.
  return _bootPromise.catch(() => undefined)
}

// Bind the stub's init to the boot logic so OyeChats.init() works post-load too.
const _stubInit = stub.init
stub.init = (overrides) => {
  if (_impl && typeof _impl.init === 'function') return _impl.init(overrides)
  return boot(overrides)
}
// Reassign for safety in case the customer cached the original reference.
if (typeof window !== 'undefined' && !_alreadyInstalled) {
  window.OyeChats = stub
}
void _stubInit  // satisfy lint about unused variable

// ── Auto-init unless deferred. ─────────────────────────────────────────────
if (_alreadyInstalled) {
  console.log(`${PREFIX} v${VERSION} loader already installed on this page. Ignoring duplicate load`)
} else if (typeof window !== 'undefined' && window.OYECHATS_ASYNC_INIT === true) {
  console.log(`${PREFIX} v${VERSION} loader ready (deferred. Call OyeChats.init() to mount)`)
} else {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot())
  } else {
    boot()
  }
}
