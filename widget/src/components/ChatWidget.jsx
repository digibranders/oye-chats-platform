import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import Launcher from './Launcher';
import { getChatbotSettings, recordPageVisit, markChatEvent } from '../services/api';
import { readSessionId, writeSessionId, resolveShareDomain, readLocalePreference, writeLocale } from '../services/storage-keys';
import { getController } from '../widget-controller.js';
import { resolveClientLocale, getHtmlLang, getBrowserLanguages } from '../i18n/localeResolver.js';
import { setLocale as setI18nLocale, getLanguageCode, t } from '../i18n/i18n.js';
import ErrorBoundary from './ErrorBoundary';
import { lazyWithRetry } from '../services/lazyWithRetry';

// Lazy-loaded. Chat window ships in its own chunk, only fetched on first widget open.
// This is the largest component (~1900 LOC plus react-markdown), so deferring it
// keeps the initial FAB chunk small (Core Web Vitals win for the host site).
const ChatWindow = lazyWithRetry(() => import('./ChatWindow'));

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

  // How the active locale was arrived at. ChatWindow forwards this to the
  // backend as `language_source`, so an explicit choice is recorded (and
  // locked) as explicit rather than mislabelled as browser detection.
  const localeResolutionRef = useRef(null);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const fetchedSettings = await getChatbotSettings();
        if (fetchedSettings) {
          setSettings(fetchedSettings);
          const langCfg = fetchedSettings?.language_config || {};
          const ctrl = getController();
          const stored = readLocalePreference();
          // A stored locale the visitor picked by hand stays authoritative on
          // their next visit; an auto-resolved one only breaks a tie below the
          // page and browser languages.
          const storedExplicit = stored?.source === 'explicit' ? stored.locale : null;
          // A locale the HOST PAGE set via OyeChats.setLocale()/init() is
          // remembered under source 'site'. Feed it back into the `site` tier
          // rather than letting it fall through to `persisted`: the agreed
          // precedence puts a website-declared locale ABOVE <html lang>, and
          // routing it to `persisted` (which sits below both html lang and the
          // browser) meant a reload silently reverted an integrator's
          // setLocale('hi-IN') to English on any page whose html lang is "en".
          const storedSite = stored?.source === 'site' ? stored.locale : null;
          const resolved = resolveClientLocale({
            explicit: storedExplicit,
            site: ctrl.getRuntimeConfig()?.locale || storedSite || null,
            htmlLang: getHtmlLang(),
            browser: getBrowserLanguages(),
            persisted: storedExplicit || storedSite ? null : stored?.locale || null,
            supportedLocales: langCfg.supported_locales,
            defaultLocale: langCfg.default_locale || 'en-IN',
            // Absent config means multilingual was never enabled for this bot.
            // Matches the backend's `.get("enabled", False)`; treating a
            // missing key as enabled made the two sides disagree.
            enabled: langCfg.enabled === true,
          });
          if (resolved && resolved.locale) {
            setI18nLocale(resolved.locale);
            ctrl.reportActiveLocale(resolved.locale);
            localeResolutionRef.current = resolved;
          }
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

  /**
   * Apply a locale requested through the PUBLIC API
   * (`OyeChats.setLocale()` / `OyeChats.init({locale})` / `update({locale})`).
   *
   * The controller normalises the tag, records it in `runtimeConfig` and emits
   * the customer-facing `localeChanged` event, then dispatches a `setLocale`
   * action. Nothing consumed that action, so the call updated the controller's
   * bookkeeping and fired an event while the widget itself carried on
   * rendering the old language. This is the missing consumer.
   *
   * Narrowed through `resolveClientLocale` rather than applied raw, so the
   * public API cannot put the widget into a locale the bot does not offer -
   * exactly the check the boot path and the in-widget language selector both
   * go through. Requesting `fr-CA` from a bot that supports only `fr-FR`
   * lands on `fr-FR`; requesting a locale it supports not at all is ignored.
   *
   * Emits nothing itself: the controller has already emitted `localeChanged`
   * once for this call, and the i18n store notifies its own subscribers (which
   * is what re-renders ChatWindow and syncs the shadow host's `dir` for RTL).
   */
  const applyExternalLocale = useCallback((requested) => {
    if (!requested) return;
    const ctrl = getController();
    const langCfg = settings?.language_config || {};
    const resolved = resolveClientLocale({
      explicit: requested,
      site: null,
      htmlLang: null,
      browser: [],
      persisted: null,
      supportedLocales: langCfg.supported_locales,
      defaultLocale: langCfg.default_locale || 'en-IN',
      enabled: langCfg.enabled === true,
    });
    // `resolveClientLocale` falls back to the default when the request is not
    // offered. Applying that would silently flip a visitor's language on an
    // unsupported request, so only proceed when the request actually survived.
    const effective = resolved?.locale;
    if (!effective || getLanguageCode(effective) !== getLanguageCode(requested)) return;

    setI18nLocale(effective);
    // 'site' is the honest source: the host page asked for this, the visitor
    // did not pick it by hand. It outranks <html lang> on the next load, which
    // is what makes the choice survive a reload.
    writeLocale(effective, 'site');
    ctrl.reportActiveLocale(effective);
    localeResolutionRef.current = { locale: effective, source: 'site' };
  }, [settings]);

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
        case 'setLocale':
          applyExternalLocale(action.locale);
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
  }, [openChat, closeChat, toggleChat, pendingMessageRef, applyExternalLocale]);

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
        <ErrorBoundary label="ChatWindow" fallback={(retry) => <div className="fixed bottom-6 right-6 z-[9999] p-4 bg-white rounded-lg shadow-lg border text-sm text-red-600 flex flex-col gap-2"><span>{t('system.failed_to_load') || 'Chat failed to load.'}</span><button onClick={retry} className="px-3 py-1 bg-gray-100 rounded hover:bg-gray-200 text-xs font-semibold text-gray-800">{t('system.retry') || 'Retry'}</button></div>}>
          <Suspense fallback={null}>
            <ChatWindow
              onClose={closeChat}
              initialSettings={settings}
              isAnimating={isAnimating}
              initialMessage={pendingMessageRef}
              initialLocaleSource={localeResolutionRef.current?.source || null}
            />
          </Suspense>
        </ErrorBoundary>
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
