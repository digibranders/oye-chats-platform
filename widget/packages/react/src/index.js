import { useEffect, useRef, useState, useCallback } from 'react'

const SCRIPT_ID = 'oyechats-widget-script'
const DEFAULT_CDN = 'https://cdn.oyechats.com/oyechats-widget.js'

// 200 attempts × 50ms = 10s. Beyond that the loader almost certainly
// failed (CDN down, blocked by an ad blocker, CSP rejection) and we
// don't want a runaway interval keeping React work alive forever.
const MAX_POLL_ATTEMPTS = 200
const POLL_INTERVAL_MS = 50

const ensureScript = (src, botKey) => {
  if (typeof window === 'undefined') return
  let el = document.getElementById(SCRIPT_ID)
  if (el) return
  el = document.createElement('script')
  el.id = SCRIPT_ID
  el.src = src
  el.async = true
  el.defer = true
  if (botKey) el.setAttribute('data-bot-key', botKey)
  document.body.appendChild(el)
}

/**
 * <OyeChatsWidget botKey="bot-xxx" />
 *
 * Drop-in component for React apps. Inserts the loader script tag,
 * mounts the widget, and tears it down on unmount.
 *
 * Consent-gated installs: do NOT pass an `asyncInit`-style prop here. Instead
 * render this component only after consent is granted, e.g.
 *   {hasConsent && <OyeChatsWidget botKey="..." />}
 * Or use `useOyeChats()` and call `init()` from your consent callback.
 */
export const OyeChatsWidget = ({ botKey, src = DEFAULT_CDN, onReady }) => {
  useEffect(() => {
    if (!botKey) return undefined
    ensureScript(src, botKey)
    if (!onReady) return undefined

    let attempts = 0
    let timeoutId = null
    let cancelled = false
    const tryRegister = () => {
      if (cancelled) return
      if (window.OyeChats) {
        window.OyeChats.on('ready', onReady)
      } else if (++attempts < MAX_POLL_ATTEMPTS) {
        timeoutId = setTimeout(tryRegister, POLL_INTERVAL_MS)
      } else {
        console.warn('[OyeChats] window.OyeChats never became available — onReady will not fire')
      }
    }
    tryRegister()

    return () => {
      cancelled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
      try { window.OyeChats?.destroy?.() } catch { /* ignore */ }
      const el = document.getElementById(SCRIPT_ID)
      if (el) el.remove()
    }
  }, [botKey, src, onReady])
  return null
}

/**
 * useOyeChats() — React hook exposing the public API as a stable object.
 * Subscribes to ready/open/close events automatically.
 *
 * `init` is exposed so consent-gated apps can render the loader script
 * up-front (with `OYECHATS_ASYNC_INIT=true` set on window) and then call
 * `init()` from a consent callback to mount the widget.
 */
export const useOyeChats = () => {
  const [ready, setReady] = useState(typeof window !== 'undefined' && !!window.OyeChats?.diagnose?.()?.mounted)
  const [open, setOpen] = useState(false)
  const apiRef = useRef(null)

  useEffect(() => {
    let attempts = 0
    let timeoutId = null
    let cancelled = false
    const tryAttach = () => {
      if (cancelled) return
      if (window.OyeChats) {
        apiRef.current = window.OyeChats
        setReady(true)
        window.OyeChats.on('open', () => setOpen(true))
        window.OyeChats.on('close', () => setOpen(false))
      } else if (++attempts < MAX_POLL_ATTEMPTS) {
        timeoutId = setTimeout(tryAttach, POLL_INTERVAL_MS)
      } else {
        console.warn('[OyeChats] window.OyeChats never became available — useOyeChats() will not be ready')
      }
    }
    tryAttach()
    return () => {
      cancelled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
    }
  }, [])

  const init = useCallback((overrides) => apiRef.current?.init?.(overrides), [])
  const destroy = useCallback(() => apiRef.current?.destroy?.(), [])
  const open_ = useCallback(() => apiRef.current?.open(), [])
  const close = useCallback(() => apiRef.current?.close(), [])
  const send = useCallback((t) => apiRef.current?.send(t), [])
  const identify = useCallback((v) => apiRef.current?.identify(v), [])
  const shutdown = useCallback(() => apiRef.current?.shutdown(), [])
  const boot = useCallback((v) => apiRef.current?.boot(v), [])

  return { ready, isOpen: open, init, destroy, open: open_, close, send, identify, shutdown, boot }
}
