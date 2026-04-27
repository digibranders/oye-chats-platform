// WidgetController — singleton state bridge between the public API
// (window.OyeChats) and the React component tree. React components
// subscribe via useWidgetController(); the public API mutates state
// or fires actions through it.
//
// Kept deliberately framework-free so the loader can call into it
// before React mounts.

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

const createController = () => {
  const listeners = new Map()  // eventName -> Set<callback>
  const onceListeners = new Map()
  const stateListeners = new Set()  // (state) -> void
  const actionListeners = new Set()  // (action) -> void

  let visitor = null  // identity from identify() / boot()
  let runtimeConfig = {}  // overrides from update()

  const emit = (event, payload) => {
    if (!VALID_EVENTS.has(event)) {
      // Allow internal events (e.g. 'state:changed') without warning,
      // but warn on typos in the public surface.
      if (!event.includes(':') || event.startsWith('state:')) {
        // skip — internal channel
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
    for (const cb of actionListeners) {
      try { cb(action) } catch (e) { console.error('[OyeChats] action handler error:', e) }
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
      dispatch({ type: 'send', text: text.trim() })
    },
    identify(v) { setVisitor(v) },
    shutdown() {
      setVisitor(null)
      try { localStorage.removeItem('chat_session_id') } catch { /* ignore */ }
      dispatch({ type: 'shutdown' })
    },
    boot(v) {
      setVisitor(v)
      try { localStorage.removeItem('chat_session_id') } catch { /* ignore */ }
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
      return () => actionListeners.delete(cb)
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
