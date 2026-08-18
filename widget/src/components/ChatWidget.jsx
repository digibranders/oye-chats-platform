import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import Launcher from './Launcher';
import { getChatbotSettings, recordPageVisit, markChatEvent } from '../services/api';
import { readSessionId, writeSessionId, resolveShareDomain } from '../services/storage-keys';
import { getController } from '../widget-controller.js';

// Lazy-loaded. Chat window ships in its own chunk, only fetched on first widget open.
// This is the largest component (~1900 LOC plus react-markdown), so deferring it
// keeps the initial FAB chunk small (Core Web Vitals win for the host site).
const ChatWindow = lazy(() => import('./ChatWindow'));

/** Ref used to pass a pre-typed message from the greeting bubble into the chat window. */
const usePendingMessage = () => {
    const ref = useRef(null);
    return ref;
};

const OPEN_DURATION = 300;  // ms. Matches widgetOpen animation (280ms + buffer)
const CLOSE_DURATION = 220; // ms. Matches widgetClose animation (200ms + buffer)

const ChatWidget = () => {
  // The panel always starts closed on every page load, it opens only when the
  // visitor taps the launcher. The open/closed state is deliberately not
  // persisted (the conversation itself still is, via the session id), so a
  // returning visitor never has the chat pop open on its own.
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(null);
  const closeTimer = useRef(null);
  const [settings, setSettings] = useState({
    bot_name: 'OyeChats AI',
    bot_logo: null,
    launcher_name: 'Have Questions?',
    launcher_logo: null,
    primary_color: '#2B66BC',
    header_color: '#2B66BC',
    background_color: '#ffffff',
    business_hours: null,
    feature_flags: {},
  });

  // Pending message from greeting bubble → auto-sent on chat open
  const pendingMessageRef = usePendingMessage();

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const fetchedSettings = await getChatbotSettings();
        if (fetchedSettings) {
          setSettings(fetchedSettings);
        }
      } catch (error) {
        console.error("Failed to load settings in widget:", error);
      }
    };
    fetchSettings();
  }, []);

  // ── Journey capture (runs on every page load, independent of the panel) ────
  // The launcher renders on every host page whether or not the chat is open, so
  // recording the visit here (not inside the (open-only) ChatWindow) is what
  // makes "journey before chat" capture pages browsed BEFORE the chat opens.
  // On MPA sites each page load remounts this; on SPA sites the installed
  // history hooks capture subsequent route changes.
  useEffect(() => {
    recordPageVisit();
  }, []);

  // ── Live preview bridge ──────────────────────────────────────────────────
  // When the widget is embedded in the admin "Preview on my website" panel,
  // the demo page sets `window.__OYECHATS_PREVIEW_MODE__ = true`. In that
  // mode we accept `oyechats:preview-config` messages from the parent frame
  // and merge them into local settings, no network round-trip, no save.
  // Only the immediate parent window is trusted (dashboard → iframe),
  // which prevents third-party sites from driving the widget via postMessage.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!window.__OYECHATS_PREVIEW_MODE__) return undefined;
    if (window.parent === window) return undefined;

    const allowedOrigin = (() => {
      if (document.referrer) {
        try { return new URL(document.referrer).origin; } catch { /* fall through */ }
      }
      return null;
    })();

    const handleMessage = (event) => {
      if (event.source !== window.parent) return;
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'oyechats:preview-config') return;
      const payload = data.payload;
      if (!payload || typeof payload !== 'object') return;
      setSettings((prev) => ({ ...prev, ...payload }));
    };

    window.addEventListener('message', handleMessage);
    // Signal readiness so the parent flushes the initial draft settings.
    // Use document.referrer origin instead of '*' to avoid leaking messages
    // to arbitrary parent frames.
    try {
      let targetOrigin = '*';
      if (document.referrer) {
        try { targetOrigin = new URL(document.referrer).origin; } catch { /* keep '*' */ }
      }
      window.parent.postMessage({ type: 'oyechats:preview-ready' }, targetOrigin);
    } catch (error) {
      console.warn('[OyeChats] Preview ready signal failed:', error);
    }
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // ── Mobile body scroll lock ──────────────────────────────────────────────────
  // When the widget opens full-screen on mobile, freeze the host page body
  // to prevent it from scrolling underneath (causes shake/jitter).
  const savedBodyStyles = useRef(null);

  const lockBodyScroll = useCallback(() => {
    if (window.innerWidth >= 768) return;
    const { body } = document;
    const { documentElement } = document;
    savedBodyStyles.current = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      height: body.style.height,
      htmlOverflow: documentElement.style.overflow,
      scrollY: window.scrollY,
    };
    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${savedBodyStyles.current.scrollY}px`;
    body.style.width = '100%';
    documentElement.style.overflow = 'hidden';
  }, []);

  const unlockBodyScroll = useCallback(() => {
    if (!savedBodyStyles.current) return;
    const { body } = document;
    const { documentElement } = document;
    const scrollY = savedBodyStyles.current.scrollY;
    body.style.overflow = savedBodyStyles.current.overflow;
    body.style.position = savedBodyStyles.current.position;
    body.style.top = savedBodyStyles.current.top;
    body.style.width = savedBodyStyles.current.width;
    documentElement.style.overflow = savedBodyStyles.current.htmlOverflow;
    savedBodyStyles.current = null;
    window.scrollTo(0, scrollY);
  }, []);

  // Cleanup timer + body scroll lock on unmount
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      unlockBodyScroll();
    };
  }, [unlockBodyScroll]);

  // Cross-subdomain continuity for the CONVERSATION (session id), so a visitor
  // who hops from the main domain to a subdomain keeps the same chat history.
  // `shareDomain` comes from bot settings, so callbacks re-bind once settings
  // resolve. An explicit `session_share_domain` (Admin → Channels) always wins;
  // when it's blank we auto-detect the apex so continuity works with zero
  // config. Resolves to null only when neither is available (cookies disabled),
  // keeping the widget localStorage-only in that case. The open/closed PANEL
  // state is deliberately not persisted, the widget always starts closed.
  const shareDomain = resolveShareDomain(settings?.session_share_domain);

  const openChat = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setIsVisible(true);
    lockBodyScroll();
    // Journey marker. Chat_opened. If no session id has been minted
    // yet (visitor is opening the panel for the first time and hasn't
    // typed a message), MINT ONE HERE so the pre-chat journey we've
    // already captured in sessionStorage gets flushed to the backend
    // right now instead of sitting local until the first message. The
    // backend's ensure_chat_session creates the chat_sessions row
    // lazily from any well-formed uuid, so this is safe.
    try {
      const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY;
      let sessionId = readSessionId(botKey);
      if (!sessionId) {
        sessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        writeSessionId(sessionId, { botKey, shareDomain });
      }
      markChatEvent(sessionId, 'chat_opened');
    } catch { /* non-critical */ }
    // Allow React to paint widget-hidden state, then trigger open animation
    setTimeout(() => {
      setIsAnimating(true);
      // After open animation completes, use static class so component switches don't re-trigger animation
      setTimeout(() => setIsAnimating('done'), OPEN_DURATION);
    }, 20);
  }, [lockBodyScroll, shareDomain]);

  const closeChat = useCallback(() => {
    setIsAnimating(false); // triggers close animation
    // Journey marker. Chat_closed. Anchored to the current page so
    // "after-chat destinations" analytics know where the visitor was
    // when they dismissed the panel.
    try {
      const persistedSessionId = readSessionId(window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY);
      markChatEvent(persistedSessionId, 'chat_closed');
    } catch { /* non-critical */ }
    closeTimer.current = setTimeout(() => {
      setIsVisible(false); // unmount after animation
      closeTimer.current = null;
      unlockBodyScroll();
    }, CLOSE_DURATION);
  }, [unlockBodyScroll]);

  // Same race for the session id. `openChat` mints and persists the session id
  // the instant the visitor opens the panel, which can happen before bot
  // settings (and thus `shareDomain`) resolve. In that window `writeSessionId`
  // ran with `shareDomain` undefined, so it wrote localStorage ONLY and never
  // set the parent-domain cookie that bridges subdomains. localStorage is
  // origin-partitioned, so a hop to a subdomain before the first message would
  // then start a fresh session. Once sharing resolves, re-mirror the persisted
  // id into the shared cookie so an already-minted session carries across the
  // domain family. No-op when sharing is off or no session exists yet.
  useEffect(() => {
    if (!shareDomain) return;
    const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY;
    const sessionId = readSessionId(botKey);
    if (sessionId) writeSessionId(sessionId, { botKey, shareDomain });
  }, [shareDomain]);

  const toggleChat = useCallback(() => {
    if (isVisible && (isAnimating === true || isAnimating === 'done')) {
      closeChat();
    } else if (!isVisible) {
      openChat();
    }
  }, [isVisible, isAnimating, openChat, closeChat]);

  const handleBubbleSend = useCallback((text) => {
      pendingMessageRef.current = text;
      openChat();
  }, [pendingMessageRef, openChat]);

  // ── Public API bridge ──────────────────────────────────────────────────────
  // Subscribe to controller actions dispatched by window.OyeChats.{open,close,toggle,send,...}
  // and emit lifecycle events back out to customer-registered handlers.
  useEffect(() => {
    const ctrl = getController();
    const unsubscribe = ctrl.onAction((action) => {
      switch (action.type) {
        case 'open':
          openChat();
          break;
        case 'close':
          closeChat();
          break;
        case 'toggle':
          toggleChat();
          break;
        case 'send':
          pendingMessageRef.current = action.text;
          openChat();
          break;
        case 'shutdown':
        case 'boot':
          // Force a fresh chat session on identity change
          closeChat();
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [openChat, closeChat, toggleChat, pendingMessageRef]);

  // Emit open/close events to customer handlers, but only on a real
  // hidden→visible / visible→hidden transition. Without the prev-state
  // guard this fires `close` on every initial render (isVisible=false),
  // which would spam customer analytics handlers.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    const ctrl = getController();
    const wasVisible = wasVisibleRef.current;
    if (isVisible && isAnimating === true && !wasVisible) {
      ctrl.emit('open', undefined);
      wasVisibleRef.current = true;
    } else if (!isVisible && wasVisible) {
      ctrl.emit('close', undefined);
      wasVisibleRef.current = false;
    }
  }, [isVisible, isAnimating]);

  // ── Hover-preload (Phase 6) ────────────────────────────────────────────────
  // Warm the chat chunk on launcher hover so the open animation has zero TTI.
  const preloadChat = useCallback(() => {
    void import('./ChatWindow');
  }, []);

  return (
    <>
      {isVisible && (
        <Suspense fallback={null}>
          <ChatWindow
            onClose={closeChat}
            initialSettings={settings}
            isAnimating={isAnimating}
            initialMessage={pendingMessageRef}
          />
        </Suspense>
      )}
      {/* Launcher fades out while chat is open. LiveChat/Intercom pattern.
          Kept in DOM (not unmounted) so it can fade back in after the close animation. */}
      <div
        className="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-4 transition-opacity duration-200"
        style={{ opacity: isVisible ? 0 : 1, pointerEvents: isVisible ? 'none' : 'auto' }}
        onMouseEnter={preloadChat}
        onTouchStart={preloadChat}
      >
        <Launcher
          isOpen={false}
          toggleChat={toggleChat}
          settings={settings}
          onBubbleSend={handleBubbleSend}
        />
      </div>
    </>
  );
};

export default ChatWidget;
