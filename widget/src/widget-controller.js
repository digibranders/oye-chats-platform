// WidgetController — singleton state bridge between the public API
// (window.OyeChats) and the React component tree. React components
// subscribe via useWidgetController(); the public API mutates state
// or fires actions through it.
//
// Kept deliberately framework-free so the loader can call into it
// before React mounts.

import { getSessionKey } from './services/storage-keys.js'

const VALID_EVENTS = new Set([
  'ready',
  'open',
  'close',
  'message:user',
  'message:bot',
  'handoff:requested',
  'handoff:accepted',
  'rating:submitted',
  'lead:captured',
  'error',
])

// How long a queued action / send waits for a subscriber before being
// dropped. Bounds memory growth if the customer calls open()/send()
// after destroy() and never re-init()s.
const QUEUE_TTL_MS = 30_000

const createController = () => {
  const listeners = new Map()  // eventName -> Set<callback>
  const onceListeners = new Map()
  const stateListeners = new Set()  // ({visitor?, runtimeConfig?}) -> void
  const actionListeners = new Set()  // (action) -> void
  const sendListeners = new Set()    // (text) -> void  (chat panel takes deliveries here)

  // Pending action / send queues — drained when the first listener subscribes.
  // Without this, OyeChats.open() called before ChatWidget's useEffect runs is
  // silently dropped (race between loader register() and React effect commit).
  const actionQueue = []  // [{action, expiresAt}]
  const sendQueue = []    // [{text, expiresAt}]

  let visitor = null
  let runtimeConfig = {}

  const now = () => Date.now()
  const pruneExpired = (queue) => {
    const t = now()
    while (queue.length && queue[0].expiresAt <= t) queue.shift()
  }

  const emit = (event, payload) => {
    if (!VALID_EVENTS.has(event)) {
      if (!event.includes(':') || event.startsWith('state:')) {
        // internal channel — skip
      } else {
        console.warn(`[OyeChats] Unknown event "${event}"`)
      }
    }
    const subs = listeners.get(event)
    if (subs) {
      for (const cb of subs) {
        try { cb(payload) } catch (e) { console.error('[OyeChats] event handler error:', e) }
      }
    }
    const onceSubs = onceListeners.get(event)
    if (onceSubs) {
      for (const cb of onceSubs) {
        try { cb(payload) } catch (e) { console.error('[OyeChats] once handler error:', e) }
      }
      onceListeners.delete(event)
    }
  }

  const dispatch = (action) => {
    if (actionListeners.size === 0) {
      actionQueue.push({ action, expiresAt: now() + QUEUE_TTL_MS })
      return
    }
    for (const cb of actionListeners) {
      try { cb(action) } catch (e) { console.error('[OyeChats] action handler error:', e) }
    }
  }

  const flushActionQueue = () => {
    pruneExpired(actionQueue)
    if (actionListeners.size === 0) return
    while (actionQueue.length) {
      const { action } = actionQueue.shift()
      for (const cb of actionListeners) {
        try { cb(action) } catch (e) { console.error('[OyeChats] action handler error:', e) }
      }
    }
  }

  const queueSend = (text) => {
    if (sendListeners.size === 0) {
      sendQueue.push({ text, expiresAt: now() + QUEUE_TTL_MS })
      return
    }
    for (const cb of sendListeners) {
      try { cb(text) } catch (e) { console.error('[OyeChats] send handler error:', e) }
    }
  }

  const flushSendQueue = () => {
    pruneExpired(sendQueue)
    if (sendListeners.size === 0) return
    while (sendQueue.length) {
      const { text } = sendQueue.shift()
      for (const cb of sendListeners) {
        try { cb(text) } catch (e) { console.error('[OyeChats] send handler error:', e) }
      }
    }
  }

  const setVisitor = (v) => {
    visitor = v ? { ...visitor, ...v } : null
    for (const cb of stateListeners) {
      try { cb({ visitor }) } catch (e) { console.error('[OyeChats] state handler error:', e) }
    }
  }

  return {
    on(event, cb) {
      if (typeof cb !== 'function') return
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(cb)
    },
    off(event, cb) {
      const subs = listeners.get(event)
      if (subs) subs.delete(cb)
      const onceSubs = onceListeners.get(event)
      if (onceSubs) onceSubs.delete(cb)
    },
    once(event, cb) {
      if (typeof cb !== 'function') return
      if (!onceListeners.has(event)) onceListeners.set(event, new Set())
      onceListeners.get(event).add(cb)
    },
    emit,
    dispatch,
    open()    { dispatch({ type: 'open' }) },
    close()   { dispatch({ type: 'close' }) },
    toggle()  { dispatch({ type: 'toggle' }) },
    send(text) {
      if (typeof text !== 'string' || !text.trim()) return
      const trimmed = text.trim()
      // Open the chat (if closed) AND queue the text for delivery to ChatWindow.
      // Two channels because ChatWidget and ChatWindow have different concerns:
      // ChatWidget owns visibility, ChatWindow owns the message stream.
      dispatch({ type: 'send', text: trimmed })
      queueSend(trimmed)
    },
    identify(v) { setVisitor(v) },
    shutdown() {
      setVisitor(null)
      try { localStorage.removeItem(getSessionKey()) } catch { /* ignore */ }
      dispatch({ type: 'shutdown' })
    },
    boot(v) {
      setVisitor(v)
      try { localStorage.removeItem(getSessionKey()) } catch { /* ignore */ }
      dispatch({ type: 'boot' })
    },
    update(config) {
      runtimeConfig = { ...runtimeConfig, ...(config || {}) }
      for (const cb of stateListeners) {
        try { cb({ runtimeConfig }) } catch (e) { console.error('[OyeChats] state handler error:', e) }
      }
    },
    getVisitor()       { return visitor },
    getRuntimeConfig() { return runtimeConfig },
    onState(cb) {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    onAction(cb) {
      actionListeners.add(cb)
      flushActionQueue()
      return () => actionListeners.delete(cb)
    },
    onSend(cb) {
      sendListeners.add(cb)
      flushSendQueue()
      return () => sendListeners.delete(cb)
    },
  }
}

// Singleton — there's only ever one widget instance per page.
let _instance = null
export const getController = () => {
  if (!_instance) _instance = createController()
  return _instance
}

export const __resetForTests = () => { _instance = null }
