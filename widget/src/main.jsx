// Dev-server entry. Mirrors what the loader does in production but without
// the manifest fetch / dynamic import dance. `npm run dev` uses this; the
// production build uses src/loader.js + src/app-entry.jsx.

import { init } from './app-entry.jsx'

const PREFIX = '[OyeChats]'

const findScriptTag = () => {
  if (document.currentScript) return document.currentScript
  const scripts = document.getElementsByTagName('script')
  for (let i = scripts.length - 1; i >= 0; i--) {
    const s = scripts[i]
    if (s.getAttribute('data-bot-key') || s.getAttribute('data-api-key')) return s
  }
  return null
}

const scriptTag = findScriptTag()
const botKey = scriptTag?.getAttribute('data-bot-key')
const apiKey = scriptTag?.getAttribute('data-api-key')

if (botKey) {
  window.OYECHATS_BOT_KEY = botKey
  console.log(`${PREFIX} dev: bot key set from script tag`)
} else if (apiKey) {
  window.OYECHATS_API_KEY = apiKey
  console.log(`${PREFIX} dev: legacy api key set from script tag`)
} else if (!window.OYECHATS_BOT_KEY && !window.OYECHATS_API_KEY) {
  console.warn(`${PREFIX} dev: no bot key set. Set window.OYECHATS_BOT_KEY in console or add data-bot-key on <script>.`)
}

// Minimal stub registration — main.jsx in dev IS the app entry,
// so we call init() with a context that registers the public API directly.
const ctx = {
  baseUrl: '',
  cssUrl: null,  // dev injects CSS via Vite HMR, no external link needed
  scriptTag,
  version: typeof __WIDGET_VERSION__ !== 'undefined' ? __WIDGET_VERSION__ : 'dev',
  build: typeof __WIDGET_BUILD__ !== 'undefined' ? __WIDGET_BUILD__ : 'dev',
  register: (impl) => {
    window.OyeChats = impl
  },
}

if (typeof window !== 'undefined' && window.OYECHATS_ASYNC_INIT === true) {
  // Match prod loader behavior — wait for OyeChats.init().
  window.OyeChats = {
    init: () => init(ctx),
  }
  console.log(`${PREFIX} dev: deferred init — call OyeChats.init() to mount`)
} else {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(ctx))
  } else {
    init(ctx)
  }
}
