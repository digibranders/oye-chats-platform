import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import Launcher from './Launcher';
import { getChatbotSettings } from '../services/api';
import { getController } from '../widget-controller.js';

// Lazy-loaded — chat window ships in its own chunk, only fetched on first widget open.
// This is the largest component (~1900 LOC plus react-markdown), so deferring it
// keeps the initial FAB chunk small (Core Web Vitals win for the host site).
const ChatWindow = lazy(() => import('./ChatWindow'));

/** Ref used to pass a pre-typed message from the greeting bubble into the chat window. */
const usePendingMessage = () => {
    const ref = useRef(null);
    return ref;
};

const OPEN_DURATION = 300;  // ms — matches widgetOpen animation (280ms + buffer)
const CLOSE_DURATION = 220; // ms — matches widgetClose animation (200ms + buffer)

/**
 * Returns true if the current time is within the bot's configured business hours.
 * Returns true (open) when business_hours is absent or disabled.
 */
function isWithinBusinessHours(businessHours) {
  if (!businessHours?.enabled) return true;

  try {
    const tz = businessHours.timezone || 'UTC';
    const now = new Date();

    // Resolve current day key (mon/tue/.../sun) in the bot's timezone
    const dayName = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).toLowerCase();
    const dayKey = dayName.slice(0, 3); // "mon", "tue", etc.

    const day = businessHours.days?.[dayKey];
    if (!day?.enabled) return false;

    // Resolve current HH:MM in the bot's timezone
    const timeParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const hour = timeParts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = timeParts.find((p) => p.type === 'minute')?.value ?? '00';
    const currentTime = `${hour}:${minute}`;

    return currentTime >= day.start && currentTime <= day.end;
  } catch {
    // Fallback: treat as open on any parsing error (e.g. unknown timezone)
    return true;
  }
}

// Read the persisted open state SYNCHRONOUSLY before the first render so a
// page navigated to from a bot CTA renders the widget already open — no
// "closed → opening → open" flicker. sessionStorage scope = same tab, so
// this only kicks in for in-tab navigations, not for first-time visits.
const _readPersistedOpen = () => {
  try { return sessionStorage.getItem('oyechats_widget_open') === '1'; } catch { return false; }
};

const ChatWidget = () => {
  const initiallyOpen = _readPersistedOpen();
  const [isVisible, setIsVisible] = useState(initiallyOpen);
  // ``'done'`` skips the open animation entirely — the chat renders in its
  // final open state on the very first paint, eliminating the flicker that
  // otherwise comes from animating from closed → open after a navigation.
  const [isAnimating, setIsAnimating] = useState(initiallyOpen ? 'done' : null);
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

  // Derived: is the bot currently "online" per its business hours schedule?
  const isOnline = isWithinBusinessHours(settings.business_hours);

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

  // ── Live preview bridge ──────────────────────────────────────────────────
  // When the widget is embedded in the admin "Preview on my website" panel,
  // the demo page sets `window.__OYECHATS_PREVIEW_MODE__ = true`. In that
  // mode we accept `oyechats:preview-config` messages from the parent frame
  // and merge them into local settings — no network round-trip, no save.
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

  // Persist the open/closed state in sessionStorage so that clicking a link
  // in a bot answer (which navigates the host page in the same tab) reopens
  // the widget with the conversation intact. sessionStorage scope = same tab,
  // same browsing session — closes when the visitor closes the tab.
  const OPEN_STATE_KEY = 'oyechats_widget_open';

  const openChat = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setIsVisible(true);
    lockBodyScroll();
    try { sessionStorage.setItem(OPEN_STATE_KEY, '1'); } catch { /* private mode */ }
    // Allow React to paint widget-hidden state, then trigger open animation
    setTimeout(() => {
      setIsAnimating(true);
      // After open animation completes, use static class so component switches don't re-trigger animation
      setTimeout(() => setIsAnimating('done'), OPEN_DURATION);
    }, 20);
  }, [lockBodyScroll]);

  const closeChat = useCallback(() => {
    setIsAnimating(false); // triggers close animation
    try { sessionStorage.removeItem(OPEN_STATE_KEY); } catch { /* private mode */ }
    closeTimer.current = setTimeout(() => {
      setIsVisible(false); // unmount after animation
      closeTimer.current = null;
      unlockBodyScroll();
    }, CLOSE_DURATION);
  }, [unlockBodyScroll]);

  // On initial mount, if the chat was restored already-open from sessionStorage
  // (handled synchronously in the useState above for flicker-free first paint),
  // we still need to fire the mobile body-scroll lock — that side effect can't
  // run synchronously during render. Runs exactly once.
  const didRestoreRef = useRef(false);
  useEffect(() => {
    if (didRestoreRef.current) return;
    didRestoreRef.current = true;
    if (initiallyOpen) {
      lockBodyScroll();
    }
    // ``initiallyOpen`` is captured at module-eval and never changes, so the
    // dependency array is intentionally empty — no exhaustive-deps lint rule.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            isOnline={isOnline}
            initialMessage={pendingMessageRef}
          />
        </Suspense>
      )}
      {/* Launcher fades out while chat is open — LiveChat/Intercom pattern.
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
