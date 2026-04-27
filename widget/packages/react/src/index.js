import { useEffect, useRef, useState, useCallback } from 'react'

const SCRIPT_ID = 'oyechats-widget-script'
const DEFAULT_CDN = 'https://cdn.oyechats.com/oyechats-widget.js'

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
 */
export const OyeChatsWidget = ({ botKey, src = DEFAULT_CDN, asyncInit = false, onReady }) => {
  useEffect(() => {
    if (!botKey) return
    if (asyncInit) {
      window.OYECHATS_ASYNC_INIT = true
    }
    ensureScript(src, botKey)
    if (onReady) {
      const tryRegister = () => {
        if (window.OyeChats) window.OyeChats.on('ready', onReady)
        else setTimeout(tryRegister, 50)
      }
      tryRegister()
    }
    return () => {
      try { window.OyeChats?.destroy?.() } catch { /* ignore */ }
      const el = document.getElementById(SCRIPT_ID)
      if (el) el.remove()
    }
  }, [botKey, src, asyncInit, onReady])
  return null
}

/**
 * useOyeChats() — React hook exposing the public API as a stable object.
 * Subscribes to ready/open/close events automatically.
 */
export const useOyeChats = () => {
  const [ready, setReady] = useState(typeof window !== 'undefined' && !!window.OyeChats?.diagnose?.()?.mounted)
  const [open, setOpen] = useState(false)
  const apiRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const tryAttach = () => {
      if (cancelled) return
      if (window.OyeChats) {
        apiRef.current = window.OyeChats
        setReady(true)
        window.OyeChats.on('open', () => setOpen(true))
        window.OyeChats.on('close', () => setOpen(false))
      } else {
        setTimeout(tryAttach, 50)
      }
    }
    tryAttach()
    return () => { cancelled = true }
  }, [])

  const open_ = useCallback(() => apiRef.current?.open(), [])
  const close = useCallback(() => apiRef.current?.close(), [])
  const send = useCallback((t) => apiRef.current?.send(t), [])
  const identify = useCallback((v) => apiRef.current?.identify(v), [])
  const shutdown = useCallback(() => apiRef.current?.shutdown(), [])
  const boot = useCallback((v) => apiRef.current?.boot(v), [])

  return { ready, isOpen: open, open: open_, close, send, identify, shutdown, boot }
}
