import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { X, Plus, Clock, MoreHorizontal, Mail, CheckCircle2, AlertCircle, User, Phone, MessageSquare, LogOut, Star, XCircle, ChevronDown, Headphones } from 'lucide-react';
import { sendMessageStream, getChatHistory, submitLeadCapture, requestHandoff, cancelHandoff, getSessionStatus, getLeadInfo, submitOfflineMessage, collectPageContext, sendBehavioralSignals, sendTimeOnPage, submitMeetingBooked, sendTranscriptEmail, getPendingConnectRequest, respondToConnectRequest, submitFeedback } from '../services/api';
import { getController } from '../widget-controller.js';
import { themeConfigs } from './themeConfigs';
import BotAvatar from './BotAvatar';
import MessageBubble from './MessageBubble';
import MessageStatus from './MessageStatus';
import { sanitizeColor, sanitizeImageUrl, sanitizeFileUrl } from '../services/sanitize';
import { getSessionKey, getLeadCapturedKey, isLeadCaptureFresh, markLeadCaptured } from '../services/storage-keys';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';
import QualificationCTA from './QualificationCTA';
import OperatorJoinedToast from './OperatorJoinedToast';
import ConnectRequestPopup from './ConnectRequestPopup';

// Lazy-loaded — only fetched when the user actually triggers handoff, lead capture, or booking.
// Keeps the initial chat chunk lean.
const LeadCaptureForm = lazy(() => import('./LeadCaptureForm'));
const HandoffForm = lazy(() => import('./HandoffForm'));
const LiveChatMode = lazy(() => import('./LiveChatMode'));
const MeetingBooking = lazy(() => import('./MeetingBooking'));

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const FALLBACK_PATTERNS = /don't have that specific information|I'm not sure about that|couldn't find.*information|not contained in/i;

// Chat mode state machine — valid transitions.
// `bot → unavailable` covers the "Leave a message" CTA (header menu option and
// the inline [LEAVE_MESSAGE_CARD] card) that drops the visitor straight from
// the AI chat into the offline-message form without a live-chat handoff first.
// `connecting` is the brief (~10s) "checking with our team" state shown after
// a handoff submission while the resolver re-checks for operator availability.
// From there it either rolls forward to `waiting` (operator found) or
// `unavailable` (timeout — show the compact message-only form).
const _VALID_TRANSITIONS = {
    // ``bot → live`` covers the operator-initiated connect-request consent
    // flow: operator clicks Connect in the dashboard, the visitor accepts the
    // popup, and the session promotes to live chat without ever queueing.
    bot: ['waiting', 'unavailable', 'connecting', 'live'],
    connecting: ['waiting', 'unavailable', 'bot'],
    waiting: ['live', 'bot', 'unavailable'],
    live: ['bot', 'unavailable'],
    unavailable: ['bot'],
};

// Strip trailing orphaned markdown tokens that ReactMarkdown would render as raw text
// e.g. a stream interrupted mid-bold: "Here is **important" → "Here is"
const sanitizeMarkdown = (text) => {
    if (!text) return text;
    return text
        .replace(/\*{1,2}$/, '')  // trailing * or **
        .replace(/_+$/, '')        // trailing _
        .replace(/`+$/, '')        // trailing `
        .trim();
};

// Centered divider — iMessage/WhatsApp style system transition message
const SystemMessage = ({ text }) => (
    <div className="flex items-center gap-2 my-2 px-4">
        <div className="flex-1 h-px bg-gray-100" />
        <span className="text-[11px] text-gray-400 font-medium whitespace-nowrap">{text}</span>
        <div className="flex-1 h-px bg-gray-100" />
    </div>
);

// Initials helper — handles unicode names and empty values defensively.
const getInitials = (name) => {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (parts.length === 0) return '?';
    return parts.map(part => Array.from(part)[0] || '').join('').toUpperCase();
};

// Operator joined notice — replaces the plain "X joined" text divider with a
// prominent pill showing the operator's initials, name, department, and time.
// Mirrors the bot-identity badge style so the live-chat handoff feels like a
// natural identity swap rather than a silent system event.
const OperatorJoinedNotice = ({ name, department, timestamp, settings }) => {
    const primaryColor = sanitizeColor(settings?.primary_color, '#3A0CA3');
    const timeLabel = (() => {
        if (!timestamp) return '';
        const d = new Date(timestamp);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    })();
    return (
        <div className="flex justify-center my-3 px-4" style={{ animation: 'fadeUp 0.35s ease-out' }}>
            <div
                className="inline-flex items-center gap-2.5 rounded-full pl-1.5 pr-3.5 py-1.5 bg-white border shadow-sm"
                style={{ borderColor: `${primaryColor}26` }}
            >
                <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-semibold flex-shrink-0"
                    style={{ backgroundColor: primaryColor }}
                    aria-hidden="true"
                >
                    {getInitials(name)}
                </div>
                <div className="flex flex-col leading-tight">
                    <span className="text-[12px] font-semibold text-[#16202C]">
                        {name || 'Support'}
                        {department ? (
                            <span className="font-normal text-gray-500"> · {department}</span>
                        ) : null}
                    </span>
                    <span className="text-[10px] text-gray-400">
                        joined the chat{timeLabel ? ` · ${timeLabel}` : ''}
                    </span>
                </div>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" aria-hidden="true" />
            </div>
        </div>
    );
};

// Date separator — shown between messages from different days (Intercom/Crisp pattern)
const DateSeparator = ({ date }) => {
    const label = (() => {
        const d = new Date(date);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === today.toDateString()) return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    })();
    return (
        <div className="flex items-center gap-2 my-3 px-4">
            <div className="flex-1 h-px bg-gray-100" />
            <span className="text-[11px] text-gray-400 font-medium whitespace-nowrap">{label}</span>
            <div className="flex-1 h-px bg-gray-100" />
        </div>
    );
};

const ChatWindow = ({ onClose, theme = 'classic', initialSettings, isAnimating = true, isOnline = true, initialMessage }) => {
    const containerRef = useRef(null);
    const [messages, setMessages] = useState([
        {
            id: 'welcome',
            text: "Hi There, How can I help you today?",
            sender: 'bot',
            timestamp: new Date().toISOString(),
            feedback: null
        }
    ]);
    const [settings, setSettings] = useState(initialSettings || {
        bot_name: 'Your Chatbot Name',
        bot_logo: null,
        launcher_name: 'Have Questions?',
        launcher_logo: null,
        primary_color: '#3A0CA3',
        header_color: '#3A0CA3',
        background_color: '#ffffff'
    });
    const [inputText, setInputText] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [isInitializing, setIsInitializing] = useState(true);
    // Track whether the messages list is anchored to the bottom so we can
    // show a "scroll to latest" affordance only when the user has scrolled
    // up. Default true matches the natural mount state (auto-scrolled).
    const [isAtBottom, setIsAtBottom] = useState(true);
    // Brief enlarge pulse the moment the user taps the scroll-to-latest pill.
    // Gives the tap confirmation feedback even though the button itself
    // disappears as soon as the smooth scroll catches up — without the pulse
    // the tap reads as "nothing happened" on touch devices.
    const [scrollBtnPulse, setScrollBtnPulse] = useState(false);
    const [sessionId, setSessionId] = useState(() => {
        try { return localStorage.getItem(getSessionKey()); } catch { return null; }
    });
    const [showWelcome, setShowWelcome] = useState(isOnline);
    const [welcomeExiting, setWelcomeExiting] = useState(false);
    const [showLeadForm, setShowLeadForm] = useState(false);
    const [chatMode, setChatModeRaw] = useState(isOnline ? 'bot' : 'unavailable');
    const setChatMode = useCallback((next) => {
        setChatModeRaw(prev => {
            const allowed = _VALID_TRANSITIONS[prev];
            if (allowed && allowed.includes(next)) return next;
            console.warn(`[OyeChats] Invalid chatMode transition: ${prev} → ${next}`);
            return prev;
        });
    }, []);
    const [operatorName, setOperatorName] = useState(null);
    const [operatorDepartment, setOperatorDepartment] = useState(null);
    const [streamingId, setStreamingId] = useState(null);
    const [isReturningUser, setIsReturningUser] = useState(false);
    const [hasMoreHistory, setHasMoreHistory] = useState(false);
    const [showWelcomeBackBanner, setShowWelcomeBackBanner] = useState(true);
    const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
    const [showProminentHandoff, setShowProminentHandoff] = useState(false);
    // Auto-dismiss the Live-chat pulse 60s after it activates so it doesn't
    // hang as a stale "notification" for the rest of the session. The
    // successful-bot-answer path also dismisses it; this is the time-based
    // safety net for cases where the visitor stops chatting after the burst.
    const prominentHandoffTimerRef = useRef(null);
    useEffect(() => {
        if (!showProminentHandoff) {
            if (prominentHandoffTimerRef.current) {
                clearTimeout(prominentHandoffTimerRef.current);
                prominentHandoffTimerRef.current = null;
            }
            return undefined;
        }
        prominentHandoffTimerRef.current = setTimeout(() => {
            setShowProminentHandoff(false);
            prominentHandoffTimerRef.current = null;
        }, 60000);
        return () => {
            if (prominentHandoffTimerRef.current) {
                clearTimeout(prominentHandoffTimerRef.current);
                prominentHandoffTimerRef.current = null;
            }
        };
    }, [showProminentHandoff]);
    const [activeCTA, setActiveCTA] = useState(null);
    const [showBooking, setShowBooking] = useState(false);
    const [calendlyUrl, setCalendlyUrl] = useState(null);
    const [meetingProvider, setMeetingProvider] = useState(null);
    const [meetingBooked, setMeetingBooked] = useState(false);
    // Inline "Leave a message" CTA — triggered by the [LEAVE_MESSAGE_CARD]
    // sentinel from the RAG pipeline when the visitor asks to email or write
    // to the team. Clicking the button drops them into the offline-message
    // form (chatMode='unavailable') which persists + emails the team.
    const [showLeaveMessageCard, setShowLeaveMessageCard] = useState(false);
    const leaveMessageCardShownRef = useRef(false);
    const ctaShownRef = useRef(false);
    const ctaDimensionsShownRef = useRef(new Set());
    const [liveConnectionStatus, setLiveConnectionStatus] = useState('connected');
    const [existingLeadInfo, setExistingLeadInfo] = useState(null);

    // Header menu
    const [showHeaderMenu, setShowHeaderMenu] = useState(false);
    const headerMenuRef = useRef(null);

    // Transcript email modal
    const [showTranscriptModal, setShowTranscriptModal] = useState(false);
    const [transcriptEmail, setTranscriptEmail] = useState('');
    const [transcriptSending, setTranscriptSending] = useState(false);
    const [transcriptSent, setTranscriptSent] = useState(false);
    const [transcriptError, setTranscriptError] = useState(null);

    // ── Live chat lifted state ───────────────────────────────────────────────────
    const [liveMessages, setLiveMessages] = useState([]);
    const [isOperatorTyping, setIsOperatorTyping] = useState(false);
    const [isLiveReconnecting, setIsLiveReconnecting] = useState(false);
    const [showRating, setShowRating] = useState(false);
    const [ratingSubmitting, setRatingSubmitting] = useState(false);
    const [showEndConfirm, setShowEndConfirm] = useState(false);
    const [surveyStep, setSurveyStep] = useState(1);        // 1 = resolved?, 2 = stars
    const [resolvedAnswer, setResolvedAnswer] = useState(null); // true | false | null
    const [hoveredStar, setHoveredStar] = useState(0);
    const [uploadProgress, setUploadProgress] = useState(null);
    // Waiting screen timer
    const [waitingSeconds, setWaitingSeconds] = useState(0);
    const waitingTimerRef = useRef(null);
    // Offline form
    const [offlineForm, setOfflineForm] = useState({ name: '', email: '', phone: '', message: '' });
    const [offlineSubmitting, setOfflineSubmitting] = useState(false);
    const [offlineSubmitted, setOfflineSubmitted] = useState(false);
    const [offlineError, setOfflineError] = useState(false);

    // WS function handles exposed by LiveChatMode via onWsReady
    const wsSendRef = useRef(null);
    const wsTypingRef = useRef(null);
    const wsFilePickRef = useRef(null);
    const wsPasteRef = useRef(null);
    const wsEndChatRef = useRef(null);

    // Prevent double handoff form injection
    const handoffFormInjectedRef = useRef(false);

    // Streaming chunk buffer
    const chunkBufferRef = useRef('');
    const rafRef = useRef(null);

    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const recentMessageTimestamps = useRef([]);
    const consecutiveFallbacks = useRef(0);
    const handoffTriggeredRef = useRef(false);
    // Stable handle on the latest handleSend so the controller.onSend
    // subscription can invoke it without re-subscribing on every render.
    const handleSendRef = useRef(null);
    const prevOperatorNameRef = useRef(null);
    const pageContextRef = useRef(null);
    const behavioralSentRef = useRef(false);

    const currentTheme = themeConfigs[theme] || themeConfigs.classic;
    const isLiveMode = ['waiting', 'live', 'unavailable'].includes(chatMode);
    const hasActiveHandoffForm = messages.some(
        (m) => m.type === 'handoff_form' && m.status !== 'submitted'
    );

    // ── Mobile viewport sizing (keyboard + iOS safe area) ──────────────────────
    // Exposed imperatively so ChatInput's onBlur can force a re-sync when iOS
    // doesn't fire a reliable visualViewport.resize on keyboard dismiss.
    const resyncViewport = useCallback(() => {
        const vv = window.visualViewport;
        if (!vv || window.innerWidth >= 768 || !containerRef.current) return;
        const container = containerRef.current;
        container.style.height = `${vv.height}px`;
        container.style.width = `${vv.width}px`;
        container.style.top = `${vv.offsetTop}px`;
        container.style.left = '0';
        container.style.bottom = 'auto';
    }, []);

    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;

        const isMobile = () => window.innerWidth < 768;
        let rafId = null;
        let settleTimer = null;

        // Strip the JS-applied mobile inline styles so the Tailwind `md:`
        // responsive classes can resume controlling layout. Without this,
        // resizing the host viewport mobile → desktop (e.g. closing Chrome
        // devtools' responsive mode) leaves the widget pinned at the last
        // mobile dimensions because the inline styles outrank the cascade.
        const clearMobileInlineStyles = () => {
            const el = containerRef.current;
            if (!el) return;
            el.style.height = '';
            el.style.width = '';
            el.style.top = '';
            el.style.left = '';
            el.style.bottom = '';
        };

        const syncViewport = () => {
            if (!isMobile() || !containerRef.current) {
                // Crossed the desktop breakpoint — hand layout back to CSS.
                clearMobileInlineStyles();
                return;
            }

            // Coalesce rapid resize events (iOS keyboard animation fires many)
            // into a single rAF, then do a final authoritative read after the
            // animation settles to avoid intermediate height oscillation.
            if (rafId) cancelAnimationFrame(rafId);
            if (settleTimer) clearTimeout(settleTimer);

            rafId = requestAnimationFrame(() => {
                rafId = null;
                resyncViewport();

                // Final settle pass — re-read once iOS keyboard animation completes
                settleTimer = setTimeout(() => {
                    settleTimer = null;
                    resyncViewport();
                }, 150);
            });
        };

        const handleScroll = () => {
            if (!isMobile() || !containerRef.current) return;
            containerRef.current.style.top = `${vv.offsetTop}px`;
        };

        // Set initial size immediately — covers iOS where dvh may not be supported
        // or where body scroll lock (position: fixed) breaks CSS height resolution
        resyncViewport();

        vv.addEventListener('resize', syncViewport);
        vv.addEventListener('scroll', handleScroll);
        // `visualViewport.resize` doesn't always fire when devtools' responsive
        // mode toggles back to desktop — the visual viewport's INNER pixel
        // dimensions can stay constant while window.innerWidth changes. A
        // window-level resize listener catches that case.
        window.addEventListener('resize', syncViewport);
        // Belt-and-suspenders for browsers that suppress resize during devtools
        // dock changes but still fire matchMedia changes when the breakpoint flips.
        const mql = window.matchMedia('(min-width: 768px)');
        const handleBreakpoint = () => { if (mql.matches) clearMobileInlineStyles(); };
        mql.addEventListener('change', handleBreakpoint);

        const containerEl = containerRef.current;
        return () => {
            vv.removeEventListener('resize', syncViewport);
            vv.removeEventListener('scroll', handleScroll);
            window.removeEventListener('resize', syncViewport);
            mql.removeEventListener('change', handleBreakpoint);
            if (rafId) cancelAnimationFrame(rafId);
            if (settleTimer) clearTimeout(settleTimer);
            if (containerEl) {
                containerEl.style.height = '';
                containerEl.style.width = '';
                containerEl.style.top = '';
                containerEl.style.left = '';
                containerEl.style.bottom = '';
            }
        };
    }, [resyncViewport]);

    // ── Prevent host page scroll-through on mobile ────────────────────────────────
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Cache the messages area element once — it never changes after mount
        const messagesArea = container.querySelector('[data-messages-area]');

        const preventHostScroll = (e) => {
            // Re-evaluate on every event so orientation changes are handled
            if (window.innerWidth >= 768) return;

            // Allow scrolling inside the messages area, but block over-scroll at boundaries
            if (messagesArea && messagesArea.contains(e.target)) {
                const { scrollTop, scrollHeight, clientHeight } = messagesArea;
                const atTop = scrollTop <= 0;
                const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
                const isScrollingUp = e.touches[0]?.clientY > (preventHostScroll._lastY || 0);

                preventHostScroll._lastY = e.touches[0]?.clientY;

                // Block if at boundary and swiping further in that direction
                if ((atTop && isScrollingUp) || (atBottom && !isScrollingUp)) {
                    e.preventDefault();
                }
                return;
            }

            // Allow native touch behavior on the input area (text selection,
            // cursor positioning) — blocking it interferes with iOS keyboard.
            if (e.target.closest?.('form, textarea')) return;

            // Block all other touch scrolling (header, etc.)
            e.preventDefault();
        };

        const trackTouchStart = (e) => {
            preventHostScroll._lastY = e.touches[0]?.clientY;
        };

        container.addEventListener('touchstart', trackTouchStart, { passive: true });
        container.addEventListener('touchmove', preventHostScroll, { passive: false });
        return () => {
            container.removeEventListener('touchstart', trackTouchStart);
            container.removeEventListener('touchmove', preventHostScroll);
        };
    }, []);

    const scrollToBottom = useCallback(() => {
        // Use scrollTo on the messages container instead of scrollIntoView,
        // which can escape the Shadow DOM and scroll the host page on iOS Safari.
        const messagesArea = containerRef.current?.querySelector('[data-messages-area]');
        if (messagesArea) {
            messagesArea.scrollTo({ top: messagesArea.scrollHeight, behavior: 'smooth' });
        }
    }, []);

    // Tap-handler for the floating scroll-to-latest pill. Trips the enlarge
    // pulse on the same frame as the scroll so the animation is visible even
    // when the smooth scroll completes before the user's finger lifts.
    const handleScrollToLatest = useCallback(() => {
        setScrollBtnPulse(true);
        scrollToBottom();
        // 260ms ≈ the perceived "tap pulse" duration in iOS / Material; keeps
        // the enlarge brief enough not to overlap the next user action.
        setTimeout(() => setScrollBtnPulse(false), 260);
    }, [scrollToBottom]);

    // Track whether the user has scrolled away from the latest message.
    // 48px tolerance covers anti-aliasing jitter and the gap-5 (20px) gap
    // between the messagesEndRef sentinel and the last real message — without
    // it, anchoring to the bottom flicks the affordance on briefly during
    // streaming as new tokens push scrollHeight forward each frame.
    useEffect(() => {
        const messagesArea = containerRef.current?.querySelector('[data-messages-area]');
        if (!messagesArea) return undefined;
        const checkPosition = () => {
            const { scrollTop, scrollHeight, clientHeight } = messagesArea;
            setIsAtBottom(scrollTop + clientHeight >= scrollHeight - 48);
        };
        checkPosition();
        messagesArea.addEventListener('scroll', checkPosition, { passive: true });
        return () => messagesArea.removeEventListener('scroll', checkPosition);
    }, [chatMode, isInitializing, showLeadForm]);

    // ── Initialization ───────────────────────────────────────────────────────────
    useEffect(() => {
        const initChat = async () => {
            if (initialSettings) {
                setSettings(initialSettings);
                setMessages(prev => prev.map(m =>
                    m.id === 'welcome' ? { ...m, text: `Hi There, How can I help you today?` } : m
                ));
            }

            const resolvedSettings = initialSettings || settings;
            // Lead form shows whenever it's enabled AND we don't have a fresh
            // capture for THIS bot. We intentionally do NOT gate on sessionId:
            // (1) sessionId can be stale from prior testing, which would
            //     silently suppress the form even on the first real visit;
            // (2) admins who flip the toggle on AFTER a session started must
            //     still be able to capture that visitor on their next reload.
            // The TTL (30d) re-prompts long-returning visitors so leads stay
            // fresh; submission within the window flips the gate immediately.
            const capturedRaw = (() => {
                try { return localStorage.getItem(getLeadCapturedKey()); } catch { return null; }
            })();
            if (resolvedSettings?.lead_form_enabled && !isLeadCaptureFresh(capturedRaw)) {
                setShowLeadForm(true);
                setShowWelcome(false);
                setIsInitializing(false);
                return;
            }

            if (sessionId) {
                try {
                    const history = await getChatHistory(sessionId, { limit: 50 });
                    if (history && history.length > 0) {
                        const mapped = history.map(m => ({
                            id: m.id,
                            text: m.content,
                            sender: m.role === 'user' ? 'user' : 'bot',
                            timestamp: m.timestamp,
                            feedback: typeof m.feedback === 'number' ? m.feedback : null,
                            ...(m.role === 'system' ? { type: 'system' } : {}),
                        }));
                        setMessages(mapped);
                        setIsReturningUser(true);
                        setShowWelcomeBackBanner(true);
                        setHasMoreHistory(history.length >= 50);
                        setShowWelcome(false);
                    }
                } catch {
                    console.error('[OyeChats] Failed to load history');
                }

                try {
                    const leadData = await getLeadInfo(sessionId);
                    if (leadData) setExistingLeadInfo(leadData);
                } catch { /* non-critical */ }

                // Restore chatMode if session was in waiting/live state (e.g., page navigation)
                try {
                    const sessionStatus = await getSessionStatus(sessionId);
                    if (sessionStatus && sessionStatus.status === 'waiting') {
                        setChatModeRaw('waiting');
                    } else if (sessionStatus && sessionStatus.status === 'live') {
                        setChatModeRaw('live');
                        if (sessionStatus.operator_name) {
                            setOperatorName(sessionStatus.operator_name);
                        }
                    }
                } catch { /* non-critical */ }
            }
            setIsInitializing(false);

            if (initialMessage?.current) {
                const text = initialMessage.current;
                initialMessage.current = null;
                setTimeout(() => handleSend(null, text), 150);
            }
        };

        initChat();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Public-API send delivery ────────────────────────────────────────────────
    // OyeChats.send(text) queues into the controller's send channel. ChatWindow
    // subscribes here so the message is sent through the normal handleSend flow
    // even when the chat is already open (the initialMessage ref path only fires
    // once on mount). The controller drains its send queue on subscribe, so
    // messages dispatched before this effect runs aren't lost.
    useEffect(() => {
        const ctrl = getController();
        return ctrl.onSend((text) => {
            const handler = handleSendRef.current;
            if (typeof handler === 'function') {
                handler(null, text);
            }
        });
    }, []);

    // ── Collect page context on mount, send time-on-page on unload ──────────────
    useEffect(() => {
        pageContextRef.current = collectPageContext();

        const handleUnload = () => {
            const sid = sessionId || localStorage.getItem(getSessionKey());
            if (sid && pageContextRef.current) {
                sendTimeOnPage(sid, pageContextRef.current._load_time);
            }
        };
        window.addEventListener('beforeunload', handleUnload);
        return () => window.removeEventListener('beforeunload', handleUnload);
    }, [sessionId]);

    // Scroll when messages or live messages change, or when an inline card
    // (post-chat survey, leave-message prompt) mounts/transitions at the
    // bottom of the stream. Without these deps, ending a live chat surfaces
    // the "Chat ended" card but the view stays anchored, leaving the card
    // clipped below the fold.
    useEffect(() => {
        scrollToBottom();
    }, [
        streamingId,
        isTyping,
        messages.length,
        liveMessages.length,
        showRating,
        surveyStep,
        showLeaveMessageCard,
        scrollToBottom,
    ]);

    // Late-mount catcher: a ResizeObserver re-runs scrollToBottom whenever
    // the messages content grows AND the visitor was already at the bottom.
    // Without this, lazy-imported cards (HandoffForm, operator widgets, the
    // post-chat survey) appear after the auto-scroll above has already fired
    // — leaving them clipped below the fold. The user just sees "the form"
    // but can't tap the submit button. The "was at bottom" gate means we
    // don't yank the view away from someone scrolled up reading history.
    useEffect(() => {
        const messagesArea = containerRef.current?.querySelector('[data-messages-area]');
        if (!messagesArea) return undefined;
        if (typeof ResizeObserver === 'undefined') return undefined;

        let lastHeight = messagesArea.scrollHeight;
        const observer = new ResizeObserver(() => {
            const { scrollTop, scrollHeight, clientHeight } = messagesArea;
            if (scrollHeight === lastHeight) return;
            const wasAtBottom = scrollTop + clientHeight >= lastHeight - 48;
            lastHeight = scrollHeight;
            if (wasAtBottom) {
                // Use the smooth scroll path so it matches the deliberate
                // auto-scrolls elsewhere — late content slides into view
                // rather than snapping.
                scrollToBottom();
            }
        });
        observer.observe(messagesArea);
        // Also observe the inner content wrapper if any direct child carries
        // the actual height (Tailwind ``flex-1`` / Suspense fallbacks).
        Array.from(messagesArea.children).forEach((child) => observer.observe(child));
        return () => observer.disconnect();
    }, [scrollToBottom]);

    // Inject "operator joined" notice when operator first connects.
    // Uses a dedicated `operator_joined` message type (rendered as a richer
    // pill with avatar/name/department) instead of the plain system divider.
    useEffect(() => {
        if (operatorName && !prevOperatorNameRef.current) {
            setMessages(prev => [
                ...prev.filter(m => !(m.type === 'system' && m.text === 'Connecting you with the support team...')),
                {
                    id: `sys-joined-${Date.now()}`,
                    type: 'operator_joined',
                    operatorName,
                    operatorDepartment,
                    timestamp: new Date().toISOString(),
                }
            ]);
        }
        prevOperatorNameRef.current = operatorName;
    }, [operatorName, operatorDepartment]);

    // Strip the "Connecting…" system divider once the offline-message form
    // takes over (handoff timed out or the user chose "Leave a message").
    // The form itself is the new affordance — the divider above it just
    // duplicates intent that no longer matches the state.
    useEffect(() => {
        if (chatMode !== 'unavailable') return;
        setMessages(prev => prev.some(
            m => m.type === 'system' && m.text === 'Connecting you with the support team...'
        )
            ? prev.filter(m => !(m.type === 'system' && m.text === 'Connecting you with the support team...'))
            : prev);
    }, [chatMode]);

    // Connecting state: 10-second "checking with our team" window after a
    // handoff submission. At 5s we re-call the resolver in case an operator
    // came online while the visitor was filling the form; at 10s we give up
    // and fall through to the compact offline form. The re-check is cheap
    // (resolver is 5s-cached) and the side effects on /handoff are still
    // suppressed for the offline_form path, so calling it twice is safe.
    useEffect(() => {
        if (chatMode !== 'connecting') return;

        let cancelled = false;
        const retryTimer = setTimeout(async () => {
            if (cancelled) return;
            try {
                const retry = await requestHandoff(sessionId, {
                    name: liveChatState?.capturedName || offlineForm.name,
                    email: liveChatState?.capturedEmail || offlineForm.email,
                });
                if (cancelled) return;
                const retryAction = retry?.suggested_action;
                if (retryAction === 'route' || retryAction === 'wait') {
                    // Lucky — operator came online in the gap. Roll forward
                    // to the waiting screen instead of the offline form.
                    setLiveChatState({
                        suggestedAction: retryAction,
                        state: retry?.state,
                        queuePosition: retry?.queue_position,
                        etaSeconds: retry?.eta_seconds,
                        queueTimeoutSeconds: retry?.queue_timeout_seconds,
                        onlineOperatorCount: retry?.online_operator_count,
                    });
                    setChatMode('waiting');
                }
            } catch {
                // Network error during the silent re-check is fine — we'll
                // fall through to the offline form at the 10s mark anyway.
            }
        }, 5000);

        const fallbackTimer = setTimeout(() => {
            if (cancelled) return;
            setChatMode('unavailable');
        }, 10000);

        return () => {
            cancelled = true;
            clearTimeout(retryTimer);
            clearTimeout(fallbackTimer);
        };
        // sessionId / form fields are stable for the duration of this
        // connecting window; we intentionally don't re-run the timer on
        // every keystroke. eslint-disable to silence the exhaustive-deps warn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatMode]);

    // Waiting timer + auto-timeout
    const WAITING_TIMEOUT_SECONDS = settings.operator_timeout_seconds || 300; // 5 min default
    useEffect(() => {
        if (chatMode === 'waiting') {
            setWaitingSeconds(0);
            waitingTimerRef.current = setInterval(() => {
                setWaitingSeconds(prev => {
                    if (prev + 1 >= WAITING_TIMEOUT_SECONDS) {
                        clearInterval(waitingTimerRef.current);
                        waitingTimerRef.current = null;
                        setChatMode('unavailable');
                    }
                    return prev + 1;
                });
            }, 1000);
        } else {
            if (waitingTimerRef.current) {
                clearInterval(waitingTimerRef.current);
                waitingTimerRef.current = null;
            }
        }
        return () => {
            if (waitingTimerRef.current) clearInterval(waitingTimerRef.current);
        };
    }, [chatMode, setChatMode, WAITING_TIMEOUT_SECONDS]);

    const getWaitingMessage = () => {
        if (waitingSeconds >= 45) return "Taking a bit longer than usual — you can leave a message if you'd prefer";
        if (waitingSeconds >= 15) return 'Still connecting — our team will be right with you';
        return settings.waiting_message || 'Please wait a moment';
    };

    // ── Welcome exit ─────────────────────────────────────────────────────────────
    const WELCOME_EXIT_DURATION = 350;
    const exitWelcome = useCallback(() => {
        setWelcomeExiting(true);
        setTimeout(() => {
            setShowWelcome(false);
            setWelcomeExiting(false);
        }, WELCOME_EXIT_DURATION);
    }, []);

    // ── Header menu ──────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!showHeaderMenu) return;
        const handler = (e) => {
            // Use composedPath() instead of e.target because the widget renders inside
            // a Shadow DOM — e.target at the document level is retargeted to the shadow
            // host, making contains() always return false for elements inside the shadow.
            if (headerMenuRef.current && !e.composedPath().includes(headerMenuRef.current)) {
                setShowHeaderMenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showHeaderMenu]);

    const handleSendTranscript = () => {
        setShowHeaderMenu(false);
        setTranscriptSent(false);
        setTranscriptError(null);
        // Pre-fill email if we have it from lead capture
        if (existingLeadInfo?.email) {
            setTranscriptEmail(existingLeadInfo.email);
        }
        setShowTranscriptModal(true);
    };

    const handleTranscriptSubmit = async (e) => {
        e.preventDefault();
        if (!transcriptEmail.trim() || transcriptSending) return;
        setTranscriptSending(true);
        setTranscriptError(null);
        try {
            await sendTranscriptEmail(sessionId, transcriptEmail.trim());
            setTranscriptSent(true);
        } catch (err) {
            setTranscriptError(err.message || 'Failed to send transcript');
        } finally {
            setTranscriptSending(false);
        }
    };

    // ── Load earlier messages (cursor-based pagination) ──────────────────────────
    const loadEarlierMessages = async () => {
        if (isLoadingEarlier || !sessionId || messages.length === 0) return;
        const oldestId = messages[0]?.id;
        if (typeof oldestId !== 'number') return; // guard: DB ids are numeric
        setIsLoadingEarlier(true);
        try {
            const earlier = await getChatHistory(sessionId, { before: oldestId, limit: 50 });
            if (earlier && earlier.length > 0) {
                const mapped = earlier.map(m => ({
                    id: m.id,
                    text: m.content,
                    sender: m.role === 'user' ? 'user' : 'bot',
                    timestamp: m.timestamp,
                    feedback: null,
                    ...(m.role === 'system' ? { type: 'system' } : {}),
                }));
                setMessages(prev => [...mapped, ...prev]);
                setHasMoreHistory(earlier.length >= 50);
            } else {
                setHasMoreHistory(false);
            }
        } catch {
            console.error('[OyeChats] Failed to load earlier messages');
        } finally {
            setIsLoadingEarlier(false);
        }
    };

    // ── New chat ─────────────────────────────────────────────────────────────────
    const handleNewChat = () => {
        setIsInitializing(true);
        localStorage.removeItem(getSessionKey());
        const newSession = `session_${crypto.randomUUID()}`;
        setSessionId(newSession);
        localStorage.setItem(getSessionKey(), newSession);
        setShowWelcome(true);
        handoffTriggeredRef.current = false;
        handoffFormInjectedRef.current = false;
        behavioralSentRef.current = false;
        pageContextRef.current = collectPageContext();
        ctaShownRef.current = false;
        ctaDimensionsShownRef.current = new Set();
        setShowBooking(false);
        setCalendlyUrl(null);
        setMeetingBooked(false);
        setMeetingProvider(null);
        consecutiveFallbacks.current = 0;
        setExistingLeadInfo(null);
        setLiveMessages([]);
        setIsOperatorTyping(false);
        setIsLiveReconnecting(false);
        setShowRating(false);
        setShowEndConfirm(false);
        setOfflineSubmitted(false);
        setOfflineError(false);
        setOfflineForm({ name: '', email: '', phone: '', message: '' });
        setTimeout(() => {
            setMessages([{
                id: 'welcome',
                text: `Hi There, How can I help you today?`,
                sender: 'bot',
                timestamp: new Date().toISOString(),
                feedback: null
            }]);
            setIsReturningUser(false);
            setHasMoreHistory(false);
            setShowWelcomeBackBanner(true);
            setChatMode('bot');
            setOperatorName(null);
            setIsInitializing(false);
        }, 600);
    };

    // ── Bot message send ─────────────────────────────────────────────────────────
    const handleSend = async (e, prefillText) => {
        if (e) e.preventDefault();
        const text = prefillText || inputText;
        if (!text.trim()) return;

        if (showWelcome) exitWelcome(); else setShowWelcome(false);
        setShowWelcomeBackBanner(false);
        setActiveCTA(null);

        const userMsg = {
            id: Date.now(),
            text,
            sender: 'user',
            timestamp: new Date().toISOString()
        };

        setMessages(prev => [...prev, userMsg]);
        setInputText('');
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            // Re-focus so the mobile keyboard stays open and the user can type ahead
            inputRef.current.focus();
        }
        setIsTyping(true);

        if (detectFrustration()) setShowProminentHandoff(true);

        try {
            let placeholderId = null;
            chunkBufferRef.current = '';
            if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }

            await sendMessageStream(userMsg.text, sessionId, {
                onMetadata: (metadata) => {
                    if (metadata.session_id && metadata.session_id !== sessionId) {
                        setSessionId(metadata.session_id);
                        localStorage.setItem(getSessionKey(), metadata.session_id);
                    }
                    // Send behavioral signals once per conversation
                    const resolvedSid = metadata.session_id || sessionId;
                    if (resolvedSid && !behavioralSentRef.current && pageContextRef.current) {
                        behavioralSentRef.current = true;
                        sendBehavioralSignals(resolvedSid, pageContextRef.current);
                    }
                },
                onChunk: (chunk) => {
                    if (placeholderId === null) {
                        placeholderId = Date.now() + 1;
                        setIsTyping(false);
                        setMessages(prev => [...prev, {
                            id: placeholderId,
                            text: chunk,
                            sender: 'bot',
                            timestamp: new Date().toISOString(),
                            feedback: null
                        }]);
                        setStreamingId(placeholderId);
                        return;
                    }
                    chunkBufferRef.current += chunk;
                    if (!rafRef.current) {
                        rafRef.current = requestAnimationFrame(() => {
                            const buffered = chunkBufferRef.current;
                            chunkBufferRef.current = '';
                            rafRef.current = null;
                            if (buffered) {
                                setMessages(prev => prev.map(msg =>
                                    msg.id === placeholderId
                                        ? { ...msg, text: msg.text + buffered }
                                        : msg
                                ));
                            }
                        });
                    }
                },
                onFinalMetadata: (finalMeta) => {
                    // Flush any buffered chunks to state BEFORE processing metadata.
                    // Prevents the handoff form from appearing while text is still
                    // waiting in the rAF buffer (race condition: truncated response).
                    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
                    if (chunkBufferRef.current && placeholderId !== null) {
                        const remaining = chunkBufferRef.current;
                        chunkBufferRef.current = '';
                        setMessages(prev => prev.map(msg =>
                            msg.id === placeholderId ? { ...msg, text: msg.text + remaining } : msg
                        ));
                    }

                    if (finalMeta.message_id && placeholderId !== null) {
                        setMessages(prev => prev.map(msg =>
                            msg.id === placeholderId ? { ...msg, id: finalMeta.message_id } : msg
                        ));
                        setStreamingId(finalMeta.message_id);
                    }
                    if (finalMeta.cta) {
                        const dim = finalMeta.cta.dimension;
                        if (!dim || !ctaDimensionsShownRef.current.has(dim)) {
                            if (dim) ctaDimensionsShownRef.current.add(dim);
                            ctaShownRef.current = true;
                            setActiveCTA(finalMeta.cta);
                        }
                    }
                    if (finalMeta.show_booking && finalMeta.calendly_url && !meetingBooked) {
                        setCalendlyUrl(finalMeta.calendly_url);
                        setMeetingProvider(finalMeta.meeting_provider || 'calendly');
                        setShowBooking(true);
                    }
                    if (
                        finalMeta.show_leave_message &&
                        !leaveMessageCardShownRef.current &&
                        !offlineSubmitted
                    ) {
                        leaveMessageCardShownRef.current = true;
                        setShowLeaveMessageCard(true);
                    }
                    if (finalMeta.suggest_handoff && !handoffTriggeredRef.current) {
                        handoffTriggeredRef.current = true;
                        const delay = (settings.handoff_delay_seconds || 0) * 1000 || 600;
                        setTimeout(() => {
                            triggerHandoff();
                            handoffTriggeredRef.current = false;
                        }, delay);
                    }
                },
                onError: (err) => {
                    setIsTyping(false);
                    // Distinguish "bot operator out of credits" / "billing paused"
                    // from a generic stream failure. Visitors must NEVER see internal
                    // billing terms — these messages are deliberately neutral.
                    const friendly =
                        err?.status === 402
                            ? "We're temporarily over capacity for this chatbot. Please try again later or reach us by email."
                            : err?.status === 503
                            ? "We're briefly offline for maintenance. Please try again in a few minutes."
                            : "I'm sorry, I couldn't generate a response. Please try again.";
                    if (placeholderId !== null) {
                        setMessages(prev => prev.map(msg => {
                            if (msg.id !== placeholderId) return msg;
                            const cleaned = sanitizeMarkdown(msg.text || '');
                            if (!cleaned) {
                                return { ...msg, text: friendly };
                            }
                            // Partial content streamed before error — preserve it, mark as interrupted
                            return { ...msg, text: cleaned + '\n\n*Response was interrupted. Please try again.*' };
                        }));
                    } else {
                        setMessages(prev => [...prev, {
                            id: Date.now() + 2,
                            text: friendly,
                            sender: 'bot',
                            timestamp: new Date().toISOString(),
                            feedback: null
                        }]);
                    }
                }
            });

            if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
            if (chunkBufferRef.current && placeholderId !== null) {
                const remaining = chunkBufferRef.current;
                chunkBufferRef.current = '';
                setMessages(prev => prev.map(msg =>
                    msg.id === placeholderId ? { ...msg, text: msg.text + remaining } : msg
                ));
            }

            setIsTyping(false);
            setStreamingId(null);

            setMessages(prev => {
                const lastBot = [...prev].reverse().find(msg => msg.sender === 'bot');
                if (lastBot && checkBotFallback(lastBot.text)) {
                    consecutiveFallbacks.current += 1;
                    if (consecutiveFallbacks.current >= 2 && !handoffTriggeredRef.current) {
                        handoffTriggeredRef.current = true;
                        consecutiveFallbacks.current = 0;
                        setTimeout(() => { triggerHandoff(); handoffTriggeredRef.current = false; }, (settings.handoff_delay_seconds || 0) * 1000 || 600);
                    } else if (consecutiveFallbacks.current === 1) {
                        setShowProminentHandoff(true);
                    }
                } else {
                    consecutiveFallbacks.current = 0;
                    // Successful bot answer → the visitor's frustration just
                    // got resolved. Drop the persistent Live-chat pulse so it
                    // doesn't read as a stale "unread" badge for the rest of
                    // the session. Re-arms automatically on the next
                    // frustration burst or fallback answer.
                    setShowProminentHandoff(false);
                }
                return prev;
            });
        } catch {
            setIsTyping(false);
            setMessages(prev => [...prev, {
                id: Date.now() + 2,
                text: "Sorry, I'm having trouble connecting to the server. Please check if the backend is running.",
                sender: 'bot',
                timestamp: new Date().toISOString(),
                feedback: null
            }]);
        }
    };

    // Keep the ref pointing at the latest handleSend so the controller.onSend
    // subscription (registered once) always invokes the current closure.
    handleSendRef.current = handleSend;

    // ── Handoff flow ─────────────────────────────────────────────────────────────
    const injectHandoffForm = useCallback(() => {
        setMessages(prev => {
            if (prev.some(m => m.type === 'handoff_form')) return prev;
            return [...prev, {
                id: 'handoff-form',
                type: 'handoff_form',
                status: 'pending',
                timestamp: new Date().toISOString(),
            }];
        });
        // Targeted late-mount re-scroll: HandoffForm is lazy-imported via
        // ``React.lazy`` and sits inside ``<Suspense fallback={null}>`` — so
        // the auto-scroll triggered by the ``messages.length`` change above
        // lands on the bottom that doesn't yet include the form (Suspense
        // shows nothing while the chunk loads). Once the lazy chunk resolves
        // and the form (~250px) mounts, scrollHeight jumps but no further
        // state change re-runs the scroll effect — leaving the form clipped
        // and the submit button cut off below the fold (the bug you saw).
        //
        // The ResizeObserver above catches the late mount in normal browser
        // tabs. These extra scrolls cover the case where RO delivery is
        // throttled (background tab, low-end mobile) AND give the visitor a
        // visible "the form slides up into view" cue that the lazy module
        // has finished loading.
        const messagesArea = containerRef.current?.querySelector('[data-messages-area]');
        if (messagesArea) {
            // 60ms: covers the Suspense flush on a warm chunk cache.
            // 280ms: covers a cold lazy import + initial render.
            // 600ms: safety net for slow networks / sluggish renderers.
            const stops = [60, 280, 600];
            stops.forEach((delay) => {
                setTimeout(() => {
                    const area = containerRef.current?.querySelector('[data-messages-area]');
                    area?.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
                }, delay);
            });
        }
    }, []);

    const triggerHandoff = useCallback(() => {
        if (!sessionId) {
            const newSession = `session_${crypto.randomUUID()}`;
            setSessionId(newSession);
            localStorage.setItem(getSessionKey(), newSession);
        }
        if (handoffFormInjectedRef.current) return;
        handoffFormInjectedRef.current = true;

        if (showWelcome) {
            exitWelcome();
            setTimeout(injectHandoffForm, WELCOME_EXIT_DURATION);
        } else {
            injectHandoffForm();
        }
    }, [sessionId, showWelcome, exitWelcome, injectHandoffForm]);

    const [isSubmittingHandoff, setIsSubmittingHandoff] = useState(false);
    // Live chat availability state from the backend resolver. Set on the
    // handoff response so the UI can branch to queue / route / offline_form
    // based on backend state, not assumptions. Cleared when the visitor
    // either connects to an operator, falls back to the form, or leaves.
    const [liveChatState, setLiveChatState] = useState(null);
    // `incomingOperator` is set when the resolver flips from "no operator
    // available" to AVAILABLE while the visitor is on the offline form. It
    // drives the OperatorJoinedToast — null = no toast, string = operator
    // display name (or generic "An agent") to render. Cleared on dismiss
    // or when the visitor switches to chat.
    const [incomingOperator, setIncomingOperator] = useState(null);

    // ── Operator connect-request consent flow ────────────────────────────────
    // While chatting with the AI, an operator may proactively offer to take
    // over the conversation. We poll every 5s, surface a modal popup with
    // their name, and let the visitor decide. Declining keeps the AI flow
    // intact; accepting promotes the session to live chat immediately.
    const [connectRequest, setConnectRequest] = useState(null); // { request_id, operator_name, expires_at }
    const [connectRequestSubmitting, setConnectRequestSubmitting] = useState(false);
    // Track request_ids we've already declined so a slow poll loop can't
    // re-pop a stale invite that the user has already dismissed.
    const dismissedConnectRequestsRef = useRef(new Set());
    const handleHandoffSubmit = async (formData) => {
        if (isSubmittingHandoff) return;
        setIsSubmittingHandoff(true);
        setMessages(prev => prev.map(m =>
            m.type === 'handoff_form' ? { ...m, status: 'submitting' } : m
        ));
        try {
            // The backend state machine returns suggested_action that tells
            // the widget exactly what to render. The visitor never sees a
            // fake "connecting..." spinner when there's literally no one to
            // connect them to — backend tells us instantly.
            const response = await requestHandoff(sessionId, formData);
            const suggestedAction = response?.suggested_action || 'route';
            const fallbackReason = response?.fallback_reason || response?.state || null;

            handoffFormInjectedRef.current = false;

            if (suggestedAction === 'offline_form') {
                // The visitor just submitted name+email. Instantly bouncing
                // them to an offline form feels rude ("we never even tried").
                // Instead: show a 10-second "Connecting you with our team"
                // state, re-check the resolver at 5s in case an operator
                // came online (e.g. they were typing when the visitor
                // clicked Connect), and only fall back to the message form
                // at the timeout. Name+email are pre-stashed so the fallback
                // form asks ONLY for the message.
                setLiveChatState({
                    suggestedAction,
                    state: response?.state,
                    fallbackReason,
                    messageKey: response?.message_key,
                    nextAvailableAt: response?.next_available_at,
                    // Carry the captured contact data so the compact offline
                    // form pre-fills + skips the name/email re-prompt.
                    capturedName: formData.name,
                    capturedEmail: formData.email,
                });
                setOfflineForm(prev => ({
                    ...prev,
                    name: formData.name || prev.name,
                    email: formData.email || prev.email,
                }));
                setMessages(prev => [
                    ...prev.filter(m => m.type !== 'handoff_form'),
                    {
                        id: `sys-connecting-${Date.now()}`,
                        type: 'system',
                        text: 'Connecting you with the support team...',
                        timestamp: new Date().toISOString(),
                    },
                ]);
                setChatMode('connecting');
                return;
            }

            // suggested_action is "route" or "wait" — both proceed to the
            // waiting screen but with different progress UI. Store the queue
            // metadata so LiveChatMode / the waiting overlay can render it.
            setLiveChatState({
                suggestedAction,
                state: response?.state,
                queuePosition: response?.queue_position,
                etaSeconds: response?.eta_seconds,
                queueTimeoutSeconds: response?.queue_timeout_seconds,
                onlineOperatorCount: response?.online_operator_count,
            });
            setMessages(prev => [
                ...prev.filter(m => m.type !== 'handoff_form'),
                {
                    id: `sys-connecting-${Date.now()}`,
                    type: 'system',
                    text: 'Connecting you with the support team...',
                    timestamp: new Date().toISOString(),
                }
            ]);
            setChatMode('waiting');
        } catch {
            setMessages(prev => [
                ...prev.map(m =>
                    m.type === 'handoff_form' ? { ...m, status: 'pending' } : m
                ),
                {
                    id: `sys-handoff-err-${Date.now()}`,
                    type: 'system',
                    text: 'Unable to connect with the support team right now. Please try again.',
                    timestamp: new Date().toISOString(),
                },
            ]);
            handoffFormInjectedRef.current = false;
        } finally {
            setIsSubmittingHandoff(false);
        }
    };

    const handleHandoffCancel = () => {
        setMessages(prev => prev.filter(m => m.type !== 'handoff_form'));
        handoffFormInjectedRef.current = false;
    };

    // ── Operator connect-request polling ─────────────────────────────────────
    //
    // While the visitor is in bot mode we poll for a pending operator
    // invitation every 5 seconds. The endpoint is cheap (single dict lookup
    // on the API) and the visitor experience is "near real-time" — the popup
    // appears within a few seconds of the operator clicking Connect.
    //
    // We deliberately do NOT poll outside ``chatMode === 'bot'`` so we never
    // race against active live-chat handoff flows.
    useEffect(() => {
        if (!sessionId) return undefined;
        if (chatMode !== 'bot') {
            // Leaving bot mode drops any pending request we were displaying.
            setConnectRequest(null);
            return undefined;
        }

        let cancelled = false;
        const tick = async () => {
            try {
                const res = await getPendingConnectRequest(sessionId);
                if (cancelled) return;
                if (!res?.pending) {
                    // Request expired or was cancelled by the operator.
                    setConnectRequest(prev => (prev ? null : prev));
                    return;
                }
                if (dismissedConnectRequestsRef.current.has(res.request_id)) {
                    console.debug('[OyeChats] Skipping dismissed connect-request', res.request_id);
                    return;
                }
                console.debug('[OyeChats] Connect-request received from', res.operator_name);
                setConnectRequest(prev => {
                    // Don't re-render if the same request is still pending.
                    if (prev && prev.request_id === res.request_id) return prev;
                    return {
                        request_id: res.request_id,
                        operator_name: res.operator_name,
                        expires_at: res.expires_at,
                    };
                });
            } catch (err) {
                console.debug('[OyeChats] Connect-request poll failed', err);
            }
        };

        tick();
        const interval = setInterval(tick, 5000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [chatMode, sessionId]);

    const handleConnectRequestAccept = useCallback(async () => {
        if (!connectRequest || connectRequestSubmitting) return;
        setConnectRequestSubmitting(true);
        try {
            const res = await respondToConnectRequest(sessionId, true, connectRequest.request_id);
            if (res?.ok && res.result === 'accepted') {
                const opName = res.operator_name || connectRequest.operator_name || 'An agent';
                setOperatorName(opName);
                setLiveChatState({
                    suggestedAction: 'accepted',
                    state: 'AVAILABLE',
                });
                setMessages(prev => [
                    ...prev.filter(m => m.type !== 'handoff_form'),
                    {
                        id: `sys-connect-accept-${Date.now()}`,
                        type: 'system',
                        text: `${opName} has joined the conversation.`,
                        timestamp: new Date().toISOString(),
                    },
                ]);
                setChatMode('live');
            } else if (res?.result === 'expired' || res?.result === 'stale') {
                // The popup we accepted was already revoked. Clear it.
                setMessages(prev => [
                    ...prev,
                    {
                        id: `sys-connect-stale-${Date.now()}`,
                        type: 'system',
                        text: 'That invitation expired before we could connect you.',
                        timestamp: new Date().toISOString(),
                    },
                ]);
            }
        } finally {
            if (connectRequest?.request_id) {
                dismissedConnectRequestsRef.current.add(connectRequest.request_id);
            }
            setConnectRequest(null);
            setConnectRequestSubmitting(false);
        }
    }, [connectRequest, connectRequestSubmitting, sessionId, setChatMode]);

    const handleConnectRequestDecline = useCallback(async () => {
        if (!connectRequest || connectRequestSubmitting) return;
        const requestId = connectRequest.request_id;
        if (requestId) dismissedConnectRequestsRef.current.add(requestId);
        setConnectRequest(null);
        // Fire-and-forget — keeps the AI conversation responsive.
        respondToConnectRequest(sessionId, false, requestId).catch(() => {});
    }, [connectRequest, connectRequestSubmitting, sessionId]);

    const handleConnectRequestExpire = useCallback(() => {
        if (!connectRequest) return;
        if (connectRequest.request_id) {
            dismissedConnectRequestsRef.current.add(connectRequest.request_id);
        }
        setConnectRequest(null);
    }, [connectRequest]);

    // ── Bot message feedback (thumbs up/down) ───────────────────────────────
    // Optimistic update — flip the local state first so the UI feels instant,
    // then sync to the server. If the server call fails we revert so the
    // visitor doesn't think their reaction was recorded when it wasn't.
    const handleBotMessageFeedback = useCallback(async (messageId, nextValue) => {
        if (messageId == null) return;
        let previousValue = null;
        setMessages(prev => prev.map(m => {
            if (m.id !== messageId) return m;
            previousValue = m.feedback ?? null;
            return { ...m, feedback: nextValue };
        }));
        try {
            await submitFeedback(messageId, nextValue);
        } catch {
            // Network/server failure — revert the optimistic update.
            setMessages(prev => prev.map(m =>
                m.id === messageId ? { ...m, feedback: previousValue } : m
            ));
        }
    }, []);

    // ── Offline-form availability polling ────────────────────────────────────
    //
    // While the visitor is on the offline form, an operator may come online.
    // We poll the resolver (every 15s, resolver itself is 5s-cached) and if
    // the suggested_action flips to "route" or "wait" we surface the
    // OperatorJoinedToast giving the visitor the choice to switch into a
    // live conversation without losing what they typed. We don't auto-switch
    // — silently swapping the form would be hostile UX.
    //
    // Only runs when the visitor arrived here from the handoff-fallback path
    // (liveChatState.fallbackReason is set) — visitors who explicitly chose
    // "Leave a message" never see the toast.
    useEffect(() => {
        if (chatMode !== 'unavailable') {
            setIncomingOperator(null);
            return;
        }
        if (!liveChatState?.fallbackReason) return;
        if (offlineSubmitted) return;

        let cancelled = false;
        const poll = async () => {
            try {
                const res = await requestHandoff(sessionId, {
                    name: liveChatState?.capturedName || offlineForm.name,
                    email: liveChatState?.capturedEmail || offlineForm.email,
                });
                if (cancelled) return;
                const action = res?.suggested_action;
                if (action === 'route' || action === 'wait') {
                    const opName = res?.online_operator_name || res?.operator_name || 'An agent';
                    setIncomingOperator(opName);
                    setLiveChatState(prev => ({
                        ...(prev || {}),
                        suggestedAction: action,
                        state: res?.state,
                        queuePosition: res?.queue_position,
                        etaSeconds: res?.eta_seconds,
                        queueTimeoutSeconds: res?.queue_timeout_seconds,
                        onlineOperatorCount: res?.online_operator_count,
                    }));
                }
            } catch {
                // Silent — next tick will retry. The visitor is still happily
                // typing their offline message either way.
            }
        };

        const interval = setInterval(poll, 15000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatMode, liveChatState?.fallbackReason, offlineSubmitted, sessionId]);

    const handleSwitchToLiveChat = () => {
        setIncomingOperator(null);
        setMessages(prev => [
            ...prev,
            {
                id: `sys-connecting-${Date.now()}`,
                type: 'system',
                text: 'Connecting you with the support team...',
                timestamp: new Date().toISOString(),
            },
        ]);
        setChatMode('waiting');
    };

    const handleDismissOperatorToast = () => {
        setIncomingOperator(null);
    };

    // ── Lead form submit ─────────────────────────────────────────────────────────
    const handleLeadFormSubmit = async (formData) => {
        const newSessionId = sessionId || `session_${crypto.randomUUID()}`;
        if (!sessionId) {
            setSessionId(newSessionId);
            localStorage.setItem(getSessionKey(), newSessionId);
        }
        await submitLeadCapture(newSessionId, formData);
        markLeadCaptured();
        setShowLeadForm(false);
        setShowWelcome(true);
    };

    // ── Live chat send (via WS) ──────────────────────────────────────────────────
    const handleLiveSend = useCallback((text) => {
        if (!wsSendRef.current || !text.trim()) return;
        setShowWelcomeBackBanner(false);

        const msgId = `live-${Date.now()}`;
        const clientMsgId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = new Date().toISOString();
        // Optimistic render: start in "sending" — the server's message_ack
        // will flip this to "sent" (no operator online) or "delivered"
        // (operator socket received it), and a later read_receipt flips it
        // to "read" (green double-check).
        const newMsg = {
            id: msgId,
            text,
            sender: 'user',
            timestamp,
            clientMsgId,
            failed: false,
            status: 'sending',
        };

        try {
            wsSendRef.current(text, clientMsgId);
        } catch {
            newMsg.failed = true;
            newMsg.status = 'failed';
        }
        setLiveMessages(prev => [...prev, newMsg]);
    }, []);

    // ── Header close — ask for confirmation during live/waiting chat ───────────
    const handleHeaderClose = useCallback(() => {
        if (chatMode === 'live' || chatMode === 'waiting') {
            setShowEndConfirm(true);
        } else {
            onClose();
        }
    }, [chatMode, onClose]);

    // ── Return to bot after live chat ends ───────────────────────────────────────
    const handleReturnToBot = useCallback(() => {
        // Snapshot whether we're returning from a successful offline submission
        // before we reset the flag below — used to surface a confirmation line
        // in the bot stream so the visitor sees their request landed.
        const wasOfflineSubmitted = offlineSubmitted;
        setShowRating(false);
        setShowEndConfirm(false);
        setSurveyStep(1);
        setResolvedAnswer(null);
        setHoveredStar(0);
        setLiveMessages([]);
        setIsOperatorTyping(false);
        setIsLiveReconnecting(false);
        setOfflineSubmitted(false);
        setOfflineError(false);
        setOfflineForm({ name: '', email: '', phone: '', message: '' });
        setShowLeaveMessageCard(false);
        leaveMessageCardShownRef.current = false;
        setChatMode('bot');
        setOperatorName(null);
        handoffFormInjectedRef.current = false;
        setMessages(prev => {
            const now = Date.now();
            const next = [...prev];
            if (wasOfflineSubmitted) {
                next.push({
                    id: `sys-offline-recorded-${now}`,
                    type: 'system',
                    text: "Your message has been recorded — we'll get back to you shortly.",
                    timestamp: new Date().toISOString(),
                });
            }
            next.push({
                id: now,
                text: 'Thanks for reaching out to our support! Feel free to ask me anything.',
                sender: 'bot',
                timestamp: new Date().toISOString(),
                feedback: null,
            });
            return next;
        });
    }, [setChatMode, offlineSubmitted]);

    const handleChatEnded = useCallback(() => {
        // Read the departing operator from the ref so this works regardless of
        // who initiated the end (visitor or operator) and survives the stale
        // closure in LiveChatMode's WS effect (deps: [sessionId]).
        const departingOperator = prevOperatorNameRef.current;
        if (departingOperator) {
            setMessages(prev => [...prev, {
                id: `sys-left-${Date.now()}`,
                type: 'system',
                text: `${departingOperator} left`,
                timestamp: new Date().toISOString(),
            }]);
        }
        if (settings?.feature_flags?.post_chat_rating === false) {
            handleReturnToBot();
        } else {
            setShowRating(true);
        }
    }, [settings, handleReturnToBot]);

    const handleSubmitRating = async (stars) => {
        setRatingSubmitting(true);
        const payload = { rating: stars };
        if (resolvedAnswer !== null) payload.resolved = resolvedAnswer;
        try {
            await fetch(`${API_URL}/operators/sessions/${sessionId}/rating`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Bot-Key': settings.bot_key || window.OYECHATS_BOT_KEY || '',
                },
                body: JSON.stringify(payload),
            });
        } catch { /* non-fatal */ } finally {
            setRatingSubmitting(false);
            setSurveyStep(1);
            setResolvedAnswer(null);
            setHoveredStar(0);
            handleReturnToBot();
        }
    };

    // ── Offline message submit ───────────────────────────────────────────────────
    const handleOfflineSubmit = async (e) => {
        e.preventDefault();
        setOfflineSubmitting(true);
        try {
            // Build the chat transcript from rendered messages so the responding
            // operator has full conversation context. Cap at 200 turns (backend
            // also caps, this is just a network-saver).
            const transcript = (messages || [])
                .filter(m => m.type !== 'handoff_form' && m.type !== 'system' && m.text)
                .slice(-200)
                .map(m => ({
                    role: m.sender === 'bot' ? 'bot' : 'user',
                    content: typeof m.text === 'string' ? m.text : '',
                    ts: m.timestamp || '',
                }));

            await submitOfflineMessage({
                name: offlineForm.name,
                email: offlineForm.email,
                phone: offlineForm.phone || null,
                message: offlineForm.message,
                session_id: sessionId,
                // The resolver state that drove the fallback. Used by the
                // admin panel to filter / categorize offline messages.
                reason: liveChatState?.fallbackReason || 'manual',
                transcript,
            });
            setOfflineSubmitted(true);
        } catch {
            setOfflineError(true);
        } finally {
            setOfflineSubmitting(false);
        }
    };

    // ── WS callbacks exposed from LiveChatMode ───────────────────────────────────
    const handleWsReady = useCallback(({ send, typing, triggerFilePick, handlePaste, endChat }) => {
        wsSendRef.current = send;
        wsTypingRef.current = typing;
        wsFilePickRef.current = triggerFilePick;
        wsPasteRef.current = handlePaste;
        wsEndChatRef.current = endChat;
    }, []);

    const handleLiveMessagesChange = useCallback((updater) => {
        setLiveMessages(typeof updater === 'function' ? updater : () => updater);
    }, []);

    // ── Smart handoff helpers ────────────────────────────────────────────────────
    const detectFrustration = useCallback(() => {
        const now = Date.now();
        recentMessageTimestamps.current = recentMessageTimestamps.current.filter(t => now - t < 30000);
        recentMessageTimestamps.current.push(now);
        return recentMessageTimestamps.current.length >= 3;
    }, []);

    const checkBotFallback = useCallback((botText) => {
        const fallbackPatterns = /don't have.*specific information|I'm not sure about that|couldn't find.*specific information|not contained in/i;
        return fallbackPatterns.test(botText);
    }, []);

    // ── Header rendering ─────────────────────────────────────────────────────────
    // Waiting + live modes both keep the bot-mode date/time chrome so the
    // widget's header doesn't reshuffle as the session transitions. The
    // "Connecting…" state is communicated in-band: a system line in the
    // transcript, the input placeholder, and the body waiting indicator —
    // duplicating it in the header was redundant. A subtle "Reconnecting..."
    // overlay still appears when the WS is dropping mid-live-chat: that's a
    // connection-health signal, not an identity swap.
    const renderHeader = () => {
        if (chatMode === 'live' && liveConnectionStatus === 'reconnecting') {
            return (
                <span className="text-[11px] font-medium text-amber-600 tracking-wide">
                    Reconnecting...
                </span>
            );
        }
        return (
            <span className="text-[11px] text-gray-400 font-medium tracking-wide">
                {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} &middot; {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
        );
    };

    // ── Floating agent badge ─────────────────────────────────────────────────────
    // Always shows the bot identity (avatar + name + subtitle) regardless
    // of chatMode. Switching to the operator's name and initials when a
    // human joined created a jarring chrome swap mid-conversation — the
    // bot brand should anchor the widget consistently. Operator presence
    // is communicated in-band via the "<Name> joined" system line and the
    // per-message author labels.
    const renderAgentBadge = () => {
        return (
            <div
                className="inline-flex items-center gap-2 rounded-full pl-1.5 pr-3.5 py-1.5 shadow-lg border border-white/40 pointer-events-auto"
                style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
            >
                <BotAvatar settings={settings} size="sm" />
                <div className="flex flex-col">
                    <span className="text-[12px] font-semibold text-[#16202C] leading-tight">
                        {settings.bot_name || 'AI Assistant'}
                    </span>
                    <span className="text-[10px] text-gray-400 leading-tight">
                        AI Assistant
                    </span>
                </div>
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
            </div>
        );
    };

    // Tick gate: show WhatsApp-style status (sent/delivered/read) on a
    // visitor's outgoing live message ONLY after the operator has actually
    // engaged — that is, after at least one operator message exists in
    // ``liveMessages``. Until that happens, the visitor's mental model is
    // "I'm still talking to the bot" (or "I'm waiting for someone to join"),
    // and a green double-tick reads as a false read-receipt from a human
    // who hasn't shown up yet. Once the operator sends their first
    // message, ticks light up on the visitor's prior live messages too —
    // the existing read_receipt handler upgrades their status as usual.
    const operatorHasEngaged = liveMessages.some((m) => m.sender === 'operator');

    // ── Inline live message renderer ─────────────────────────────────────────────
    const renderLiveMessage = (msg) => {
        const userBubbleBg = sanitizeColor(settings.user_bubble_color, '#DBE9FF');
        const primaryColor = sanitizeColor(settings.primary_color, '#3A0CA3');

        if (msg.sender === 'user') {
            return (
                <div key={msg.id} className="flex flex-col items-end">
                    <div className="flex justify-end w-full">
                        <div
                            className="max-w-[85%] px-4 py-3 rounded-2xl text-[14px] break-words"
                            style={{ backgroundColor: userBubbleBg, color: '#16202C' }}
                        >
                            {sanitizeFileUrl(msg.file_url) ? (
                                msg.content_type?.startsWith('image/') ? (
                                    <img
                                        src={sanitizeImageUrl(msg.file_url)}
                                        alt={msg.filename || 'image'}
                                        className="max-w-[200px] rounded-xl block cursor-zoom-in hover:opacity-90 transition-opacity"
                                    />
                                ) : (
                                    <a href={sanitizeFileUrl(msg.file_url)} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline text-sm break-all">
                                        📎 {msg.filename || 'file'}
                                    </a>
                                )
                            ) : (
                                <p className="break-words" style={{ color: '#16202C' }}>{msg.text}</p>
                            )}
                        </div>
                    </div>
                    {/*
                       Live-mode user messages get a WhatsApp-style status
                       indicator (sending → sent → delivered → read) so the
                       visitor sees their message reached the operator.
                       Bot-mode user messages stay clean (no status) since
                       there is no "read" concept when talking to the bot.
                       A failed send swaps in a retry affordance instead.
                    */}
                    <div className="flex items-center gap-1 mt-0.5 mr-1">
                        {msg.failed || msg.status === 'failed' ? (
                            <button
                                type="button"
                                aria-label="Message not sent — tap to retry"
                                onClick={() => {
                                    if (!wsSendRef.current) return;
                                    const retryId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                                    try {
                                        if (msg.text) {
                                            wsSendRef.current(msg.text, retryId);
                                            setLiveMessages(prev => prev.map(m =>
                                                m.id === msg.id
                                                    ? { ...m, failed: false, status: 'sending', clientMsgId: retryId }
                                                    : m
                                            ));
                                        }
                                    } catch { /* stay failed */ }
                                }}
                                className="text-[10px] text-red-500 flex items-center gap-0.5 hover:text-red-700 underline cursor-pointer"
                            >
                                <AlertCircle className="w-3 h-3" /> Not sent · Retry
                            </button>
                        ) : operatorHasEngaged ? (
                            <MessageStatus
                                status={msg.status || 'sending'}
                                sentAt={msg.sentAt || msg.timestamp}
                                deliveredAt={msg.deliveredAt}
                                readAt={msg.readAt}
                            />
                        ) : null}
                    </div>
                </div>
            );
        }

        // Operator message
        return (
            <div key={msg.id} className="flex flex-col items-start w-full">
                {msg.operatorName && (
                    <p className="text-[11px] font-semibold mb-0.5 ml-0.5" style={{ color: primaryColor }}>{msg.operatorName}</p>
                )}
                {sanitizeFileUrl(msg.file_url) ? (
                    msg.content_type?.startsWith('image/') ? (
                        <img
                            src={sanitizeImageUrl(msg.file_url)}
                            alt={msg.filename || 'image'}
                            className="max-w-[200px] rounded-xl block hover:opacity-90 transition-opacity"
                        />
                    ) : (
                        <a href={sanitizeFileUrl(msg.file_url)} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline text-sm break-all">
                            📎 {msg.filename || 'file'}
                        </a>
                    )
                ) : (
                    <p className="text-[14px] text-[#16202C] leading-relaxed break-words">{msg.text}</p>
                )}
            </div>
        );
    };

    // ── Main render ──────────────────────────────────────────────────────────────
    return (
        <div
            ref={containerRef}
            className={`${currentTheme.container} ${isAnimating === true ? 'widget-open' : isAnimating === false ? 'widget-close' : isAnimating === 'done' ? 'widget-visible' : 'widget-hidden'}`}
        >
            {/* ── Header ── */}
            <div className={`${currentTheme.header} oyechats-safe-top`}>
                {renderHeader() || <div />}
                {(() => {
                    const showTranscriptOption = settings.feature_flags?.email_transcript !== false && messages.length > 0;
                    const showLeaveMessageOption = !settings.live_chat_enabled && chatMode === 'bot';
                    const hasMenuOptions = showTranscriptOption || showLeaveMessageOption;
                    return (
                        <div className="flex items-center gap-1 relative" ref={headerMenuRef}>
                            {chatMode === 'bot' && (isReturningUser || messages.filter(m => m.sender === 'user').length > 0) && (
                                <button
                                    onClick={handleNewChat}
                                    className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors text-gray-400 hover:text-gray-600"
                                    title="Start New Chat"
                                >
                                    <Plus className="w-4 h-4" />
                                </button>
                            )}
                            {hasMenuOptions && (
                                <button
                                    onClick={() => setShowHeaderMenu(prev => !prev)}
                                    className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors text-gray-400 hover:text-gray-600"
                                    title="More options"
                                >
                                    <MoreHorizontal className="w-4 h-4" />
                                </button>
                            )}
                            <button
                                onClick={handleHeaderClose}
                                className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                                title="Close"
                            >
                                <X className="w-5 h-5" />
                            </button>

                            {showHeaderMenu && hasMenuOptions && (
                                <div className="absolute top-full right-0 mt-1 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-50 min-w-[180px]" style={{ animation: 'fadeUp 0.15s ease-out' }}>
                                    {showTranscriptOption && (
                                        <button
                                            onClick={handleSendTranscript}
                                            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-[#16202C] hover:bg-gray-50 transition-colors"
                                        >
                                            <Mail className="w-4 h-4 text-gray-400" />
                                            Send transcript
                                        </button>
                                    )}
                                    {showLeaveMessageOption && (
                                        <button
                                            onClick={() => {
                                                setShowHeaderMenu(false);
                                                if (showWelcome) exitWelcome();
                                                setChatMode('unavailable');
                                            }}
                                            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-[#16202C] hover:bg-gray-50 transition-colors"
                                        >
                                            <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
                                            </svg>
                                            Leave a message
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })()}
            </div>

            {/* ── Floating agent badge (always on top of messages area) ──
                Shown in both bot and live modes — badge shows bot identity
                regardless of mode. Hidden during waiting/unavailable where
                dedicated state screens own the header, and during
                initialization/lead form where chrome is suppressed.
                ALSO hidden when an operator has joined (chatMode === 'live'):
                the in-stream "<Operator> joined the chat" pill + per-message
                author label already communicate identity, and keeping the
                AI Assistant badge floating above an active human conversation
                reads as a stale notification ("are you still talking to the
                bot?"). Restored automatically when the operator leaves and
                chatMode falls back to 'bot'. */}
            {!isInitializing && !showLeadForm && chatMode === 'bot' && (
                <div className="shrink-0 flex justify-center -mb-5 relative z-30" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    {renderAgentBadge()}
                </div>
            )}

            {/* ── Unified messages area — one scroll, always visible ── */}
            <div
                className={`${currentTheme.messagesArea} relative`}
                data-messages-area
                style={{
                    backgroundColor: (settings.background_color && settings.background_color !== '#ffffff') ? sanitizeColor(settings.background_color, '#ffffff') : undefined,
                    paddingTop: !isInitializing && !showLeadForm ? 24 : undefined,
                }}
                aria-live="polite"
                aria-label="Chat messages"
                role="log"
            >
                {/* Welcome overlay — absolute, covers the messages area until first send */}
                {showWelcome && !isInitializing && (
                    <div
                        className="absolute inset-0 z-10 flex flex-col items-start justify-end px-5 pb-4 pointer-events-auto"
                        style={{
                            backgroundColor: (settings.background_color && settings.background_color !== '#ffffff')
                                ? sanitizeColor(settings.background_color, '#F8F8F8')
                                : '#F8F8F8',
                        }}
                    >
                        <WelcomeScreen
                            settings={settings}
                            onSend={handleSend}
                            onTalkToHuman={settings.live_chat_enabled !== false ? triggerHandoff : undefined}
                            welcomeExiting={welcomeExiting}
                            exitDuration={WELCOME_EXIT_DURATION}
                        />
                    </div>
                )}

                {/* Pre-chat lead form — sits inside the messages area so the
                    parent ChatWindow's header (bot avatar, name, close button)
                    stays visible above it. Do NOT pass currentTheme/onClose
                    here — the form renders content only, not its own chrome. */}
                {showLeadForm && (
                    <div className="absolute inset-0 z-20 pointer-events-auto">
                        <Suspense fallback={null}>
                            <LeadCaptureForm
                                settings={settings}
                                onSubmit={handleLeadFormSubmit}
                            />
                        </Suspense>
                    </div>
                )}



                {/* Loading spinner */}
                {isInitializing && (
                    <div className="flex-1 flex flex-col items-center justify-center gap-3">
                        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
                        <p className="text-gray-500 font-medium animate-pulse text-sm">Starting new chat...</p>
                    </div>
                )}

                {/* Load earlier messages — cursor-based pagination */}
                {!isInitializing && isReturningUser && hasMoreHistory && (
                    <div className="flex justify-center py-3">
                        <button
                            onClick={loadEarlierMessages}
                            disabled={isLoadingEarlier}
                            className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-medium text-gray-500 bg-white border border-gray-200 rounded-full hover:bg-gray-50 hover:border-gray-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isLoadingEarlier ? (
                                <><div className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />Loading...</>
                            ) : (
                                'Load earlier messages'
                            )}
                        </button>
                    </div>
                )}

                {/* Bot conversation messages — with date separators for returning users */}
                {!isInitializing && (() => {
                    const items = [];
                    let lastDateStr = null;
                    messages.forEach((msg) => {
                        // Insert a date separator when the day changes (only for returning users with history)
                        if (isReturningUser && msg.timestamp) {
                            const msgDateStr = new Date(msg.timestamp).toDateString();
                            if (msgDateStr !== lastDateStr) {
                                items.push(<DateSeparator key={`sep-${msgDateStr}-${msg.id}`} date={msg.timestamp} />);
                                lastDateStr = msgDateStr;
                            }
                        }
                        if (msg.type === 'system') {
                            items.push(<SystemMessage key={msg.id} text={msg.text} />);
                        } else if (msg.type === 'operator_joined') {
                            items.push(
                                <OperatorJoinedNotice
                                    key={msg.id}
                                    name={msg.operatorName}
                                    department={msg.operatorDepartment}
                                    timestamp={msg.timestamp}
                                    settings={settings}
                                />
                            );
                        } else if (msg.type === 'handoff_form' && msg.status !== 'submitted') {
                            items.push(
                                <div key={msg.id} className="mx-3 my-2" style={{ animation: 'fadeUp 0.3s ease-out' }}>
                                    <Suspense fallback={null}>
                                        <HandoffForm
                                            settings={settings}
                                            onSubmit={handleHandoffSubmit}
                                            onCancel={handleHandoffCancel}
                                            existingLeadInfo={existingLeadInfo}
                                            status={msg.status}
                                        />
                                    </Suspense>
                                </div>
                            );
                        } else if (msg.type === 'handoff_form') {
                            // Already submitted — skip
                        } else {
                            items.push(
                                <MessageBubble
                                    key={msg.id}
                                    msg={msg}
                                    currentTheme={currentTheme}
                                    settings={settings}
                                    streamingId={streamingId}
                                    onFeedback={handleBotMessageFeedback}
                                />
                            );
                        }
                    });
                    return items;
                })()}

                {/* Bot typing indicator */}
                {isTyping && <TypingIndicator settings={settings} />}

                {/* Meeting booking widget for qualified leads */}
                {showBooking && calendlyUrl && (
                    <Suspense fallback={null}>
                    <MeetingBooking
                        calendlyUrl={calendlyUrl}
                        sessionId={sessionId}
                        provider={meetingProvider || 'calendly'}
                        onDismiss={() => setShowBooking(false)}
                        onBooked={async (bookingData) => {
                            const sid = sessionId || bookingData.session_id;
                            if (!sid) return;
                            try {
                                await submitMeetingBooked(sid, bookingData);
                                setMeetingBooked(true);
                                setShowBooking(false);
                                setMessages(prev => [
                                    ...prev,
                                    {
                                        id: `meeting-booked-${Date.now()}`,
                                        text: 'Great, your meeting is confirmed. Our team will connect with you soon.',
                                        sender: 'bot',
                                        timestamp: new Date().toISOString(),
                                        feedback: null,
                                    }
                                ]);
                            } catch {
                                setMessages(prev => [
                                    ...prev,
                                    {
                                        id: `meeting-booked-error-${Date.now()}`,
                                        text: 'Your booking was detected, but we could not sync it yet. We will still follow up with you.',
                                        sender: 'bot',
                                        timestamp: new Date().toISOString(),
                                        feedback: null,
                                    }
                                ]);
                            }
                        }}
                    />
                    </Suspense>
                )}

                {/* Leave-a-message CTA — inline prompt to open the offline form.
                    Triggered by the [LEAVE_MESSAGE_CARD] sentinel from the RAG
                    pipeline when the visitor asks to email/write to the team.
                    Only shown while in bot mode; transitioning to 'unavailable'
                    (on click) reveals the existing offline form below. */}
                {showLeaveMessageCard && chatMode === 'bot' && !offlineSubmitted && (
                    <div
                        className="mx-3 my-2 rounded-2xl border border-gray-100 shadow-sm bg-white p-4"
                        style={{ animation: 'fadeUp 0.3s ease-out' }}
                    >
                        <div className="flex items-center gap-2 mb-2">
                            <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            <p className="text-[13px] font-semibold text-[#16202C]">Leave a message for our team</p>
                        </div>
                        <p className="text-[12px] text-gray-500 mb-3">
                            We&apos;ll reply by email as soon as we can.
                        </p>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    setShowLeaveMessageCard(false);
                                    setChatMode('unavailable');
                                }}
                                className="flex-1 py-2 rounded-xl text-white text-[13px] font-medium transition-opacity hover:opacity-90"
                                style={{ backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}
                            >
                                Leave a message
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setShowLeaveMessageCard(false);
                                    // Allow the card to re-trigger if the visitor
                                    // asks again — without this, the per-session
                                    // ref locks the card out for the rest of the chat.
                                    leaveMessageCardShownRef.current = false;
                                }}
                                className="px-4 py-2 rounded-xl border border-gray-200 text-[13px] font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                            >
                                Not now
                            </button>
                        </div>
                    </div>
                )}

                {/* BANT qualification quick-reply chips */}
                <QualificationCTA
                    cta={activeCTA}
                    dismissed={!activeCTA}
                    onSelect={(option) => {
                        setActiveCTA(null);
                        handleSend(null, option);
                    }}
                />

                {/* Reconnecting banner */}
                {isLiveReconnecting && (
                    <div className="mx-3 my-1 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2">
                        <div className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                        <span className="text-xs text-amber-700 font-medium">Reconnecting...</span>
                    </div>
                )}

                {/* Live chat session timestamp divider */}
                {!isInitializing && liveMessages.length > 0 && (
                    <SystemMessage text={new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
                )}

                {/* Live chat messages — seamless continuation in the same stream */}
                {!isInitializing && liveMessages.map(renderLiveMessage)}

                {/* Operator typing indicator */}
                {isOperatorTyping && (
                    <div className="flex justify-start px-5">
                        <div className="flex gap-1.5 px-1 py-2">
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '0ms', backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3'), opacity: 0.6 }} />
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '150ms', backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3'), opacity: 0.6 }} />
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '300ms', backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3'), opacity: 0.6 }} />
                        </div>
                    </div>
                )}

                {/* Waiting state — inline spinner below the handoff system message */}
                {chatMode === 'waiting' && !isInitializing && (
                    <div className="flex flex-col items-center py-4 px-4" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                        <div
                            className="w-8 h-8 border-4 border-t-transparent rounded-full animate-spin mb-2"
                            style={{ borderColor: `${sanitizeColor(settings.primary_color, '#3A0CA3')}40`, borderTopColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}
                        />
                        <p
                            className="text-[13px] text-gray-500 text-center"
                            key={getWaitingMessage()}
                            style={{ animation: 'fadeUp 0.3s ease-out' }}
                        >
                            {getWaitingMessage()}
                        </p>
                        {waitingSeconds >= 45 && (
                            <button
                                onClick={() => setChatMode('unavailable')}
                                className="mt-2 text-[12px] font-medium hover:underline transition-colors"
                                style={{ color: sanitizeColor(settings.primary_color, '#3A0CA3') }}
                            >
                                Leave a message instead
                            </button>
                        )}
                        <button
                            onClick={() => {
                                // Try WS first, fall back to REST for when WS hasn't connected yet
                                if (wsEndChatRef.current) {
                                    wsEndChatRef.current();
                                } else if (sessionId) {
                                    cancelHandoff(sessionId);
                                }
                                setChatModeRaw('bot');
                                setOperatorName(null);
                            }}
                            className="mt-1 text-[12px] text-gray-400 hover:text-gray-600 transition-colors"
                        >
                            Cancel and return to AI chat
                        </button>
                    </div>
                )}

                {/* Offline message form — inline in stream */}
                {/* Connecting state — 10-second "checking with our team"
                    window. Either rolls forward to waiting/live (operator
                    came online during the 5s re-check) or transitions to
                    the compact offline form below. */}
                {chatMode === 'connecting' && !isInitializing && (
                    <div
                        className="mx-3 my-2 rounded-2xl border border-gray-100 shadow-sm bg-white p-4 max-w-xs"
                        style={{ animation: 'fadeUp 0.3s ease-out' }}
                    >
                        <div className="flex items-center gap-3">
                            <div className="relative flex-shrink-0">
                                <div
                                    className="w-9 h-9 rounded-full flex items-center justify-center"
                                    style={{ backgroundColor: `${sanitizeColor(settings.primary_color, '#3A0CA3')}15` }}
                                >
                                    <Headphones
                                        className="w-4 h-4"
                                        style={{ color: sanitizeColor(settings.primary_color, '#3A0CA3') }}
                                    />
                                </div>
                                <span
                                    className="absolute inset-0 rounded-full animate-ping"
                                    style={{
                                        backgroundColor: `${sanitizeColor(settings.primary_color, '#3A0CA3')}30`,
                                        animationDuration: '1.8s',
                                    }}
                                />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[13px] font-semibold text-[#16202C] leading-tight">
                                    Connecting you with our team
                                </p>
                                <p className="text-[11px] text-gray-400 leading-tight mt-1">
                                    This usually takes just a few seconds…
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {chatMode === 'unavailable' && !isInitializing && incomingOperator && !offlineSubmitted && (
                    <OperatorJoinedToast
                        operatorName={incomingOperator}
                        primaryColor={settings.primary_color}
                        onSwitchToChat={handleSwitchToLiveChat}
                        onDismiss={handleDismissOperatorToast}
                    />
                )}

                {chatMode === 'unavailable' && !isInitializing && (
                    <div
                        className="mx-3 my-2 rounded-2xl border border-gray-100 shadow-sm bg-white p-4"
                        style={{ animation: 'fadeUp 0.3s ease-out' }}
                    >
                        {offlineError ? (
                            <div className="text-center py-2">
                                <AlertCircle className="w-7 h-7 text-red-400 mx-auto mb-2" />
                                <p className="text-[13px] text-gray-600 mb-3">We couldn&apos;t send your message. Please try again.</p>
                                <button
                                    onClick={() => setOfflineError(false)}
                                    className="w-full py-2 rounded-xl text-white text-[13px] font-medium"
                                    style={{ backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}
                                >
                                    Try Again
                                </button>
                            </div>
                        ) : offlineSubmitted ? (
                            <div className="text-center py-2">
                                <CheckCircle2 className="w-7 h-7 text-green-500 mx-auto mb-2" />
                                <p className="text-[13px] font-semibold text-[#16202C] mb-1">Message sent!</p>
                                <p className="text-[12px] text-gray-500 mb-3">
                                    We&apos;ll get back to you at <strong>{offlineForm.email}</strong>
                                    {offlineForm.phone ? ' or give you a callback' : ''} as soon as possible.
                                </p>
                                <button
                                    onClick={handleReturnToBot}
                                    className="w-full py-2 rounded-xl text-white text-[13px] font-medium"
                                    style={{ backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}
                                >
                                    Continue chatting with AI
                                </button>
                            </div>
                        ) : (() => {
                            // Compact mode: when the visitor came here from a
                            // handoff fallback they already gave us name+email
                            // in HandoffForm. Re-prompting for them would be
                            // hostile UX. Detect via `liveChatState?.fallbackReason`
                            // — only set on the handoff-fallback path, never on
                            // the direct "Leave a message" CTA.
                            const isCompact = !!(
                                liveChatState?.fallbackReason &&
                                offlineForm.name?.trim() &&
                                offlineForm.email?.trim()
                            );

                            if (isCompact) {
                                return (
                                    <>
                                        <div className="flex items-center gap-2 mb-1">
                                            <Mail className="w-4 h-4 flex-shrink-0" style={{ color: sanitizeColor(settings.primary_color, '#3A0CA3') }} />
                                            <p className="text-[13px] font-semibold text-[#16202C]">We&apos;ll be right back!</p>
                                        </div>
                                        <p className="text-[12px] text-gray-500 mb-3">
                                            Leave a message and we&apos;ll get back to you at{' '}
                                            <strong className="text-gray-700">{offlineForm.email}</strong>.
                                        </p>
                                        <form onSubmit={handleOfflineSubmit} className="space-y-2">
                                            <div className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2 focus-within:border-blue-300 focus-within:bg-white transition-colors">
                                                <MessageSquare className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                                                <textarea
                                                    placeholder="How can we help you?"
                                                    required
                                                    rows={3}
                                                    autoFocus
                                                    value={offlineForm.message}
                                                    onChange={(e) => setOfflineForm(p => ({ ...p, message: e.target.value }))}
                                                    className="flex-1 bg-transparent outline-none text-[13px] text-gray-900 placeholder:text-gray-400 resize-none"
                                                />
                                            </div>
                                            <button
                                                type="submit"
                                                disabled={offlineSubmitting || !offlineForm.message.trim()}
                                                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-white text-[13px] font-medium disabled:opacity-60"
                                                style={{ backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}
                                            >
                                                {offlineSubmitting
                                                    ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                    : 'Send Message'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleReturnToBot}
                                                disabled={offlineSubmitting}
                                                className="w-full text-center text-[12px] text-gray-500 hover:text-gray-700 transition-colors pt-1 disabled:opacity-60"
                                            >
                                                Continue with AI instead
                                            </button>
                                        </form>
                                    </>
                                );
                            }

                            return (
                            <>
                                <div className="flex items-center gap-2 mb-1">
                                    <Mail className="w-4 h-4 flex-shrink-0" style={{ color: sanitizeColor(settings.primary_color, '#3A0CA3') }} />
                                    <p className="text-[13px] font-semibold text-[#16202C]">Send us a message</p>
                                </div>
                                <p className="text-[12px] text-gray-500 mb-3">We&apos;ll get back to you as soon as we can.</p>
                                <form onSubmit={handleOfflineSubmit} className="space-y-2">
                                    <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2">
                                        <User className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                                        <input type="text" placeholder="Your name" required value={offlineForm.name}
                                            onChange={(e) => setOfflineForm(p => ({ ...p, name: e.target.value }))}
                                            className="flex-1 bg-transparent outline-none text-[13px] text-gray-900 placeholder:text-gray-400" />
                                    </div>
                                    <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2">
                                        <Mail className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                                        <input type="email" placeholder="Email address" required value={offlineForm.email}
                                            onChange={(e) => setOfflineForm(p => ({ ...p, email: e.target.value }))}
                                            className="flex-1 bg-transparent outline-none text-[13px] text-gray-900 placeholder:text-gray-400" />
                                    </div>
                                    <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2">
                                        <Phone className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                                        <input type="tel" placeholder="Phone number (optional)" value={offlineForm.phone}
                                            onChange={(e) => setOfflineForm(p => ({ ...p, phone: e.target.value }))}
                                            className="flex-1 bg-transparent outline-none text-[13px] text-gray-900 placeholder:text-gray-400" />
                                    </div>
                                    <div className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2">
                                        <MessageSquare className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                                        <textarea placeholder="How can we help you?" required rows={2} value={offlineForm.message}
                                            onChange={(e) => setOfflineForm(p => ({ ...p, message: e.target.value }))}
                                            className="flex-1 bg-transparent outline-none text-[13px] text-gray-900 placeholder:text-gray-400 resize-none" />
                                    </div>
                                    <button type="submit" disabled={offlineSubmitting}
                                        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-white text-[13px] font-medium disabled:opacity-60"
                                        style={{ backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}>
                                        {offlineSubmitting
                                            ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                            : 'Send Message'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleReturnToBot}
                                        disabled={offlineSubmitting}
                                        className="w-full text-center text-[12px] text-gray-500 hover:text-gray-700 transition-colors pt-1 disabled:opacity-60"
                                    >
                                        Continue with AI instead
                                    </button>
                                </form>
                            </>
                            );
                        })()}
                    </div>
                )}

                {/* 2-step post-chat survey — inline in stream after live chat ends */}
                {showRating && settings?.feature_flags?.post_chat_rating !== false && (
                    <div
                        className="mx-3 my-2 rounded-2xl border border-gray-100 shadow-sm bg-white p-4 text-center"
                        style={{ animation: 'fadeUp 0.4s ease-out' }}
                    >
                        <CheckCircle2 className="w-7 h-7 mx-auto mb-2" style={{ color: sanitizeColor(settings.primary_color, '#3A0CA3') }} />
                        <p className="text-[13px] font-semibold text-[#16202C] mb-0.5">Chat ended</p>

                        {/* Step 1: Was your issue resolved? */}
                        {surveyStep === 1 && (
                            <div style={{ animation: 'fadeUp 0.25s ease-out' }}>
                                <p className="text-[12px] text-gray-500 mb-3">Was your issue resolved?</p>
                                <div className="flex justify-center gap-3 mb-3">
                                    <button
                                        onClick={() => { setResolvedAnswer(true); setSurveyStep(2); }}
                                        disabled={ratingSubmitting}
                                        aria-label="Yes, issue was resolved"
                                        className="flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl border border-green-200 bg-green-50 text-green-700 text-[13px] font-medium cursor-pointer transition-all duration-200 hover:bg-green-100 hover:border-green-300 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400 disabled:opacity-50"
                                    >
                                        <CheckCircle2 className="w-4 h-4" />
                                        Yes
                                    </button>
                                    <button
                                        onClick={() => { setResolvedAnswer(false); setSurveyStep(2); }}
                                        disabled={ratingSubmitting}
                                        aria-label="No, issue was not resolved"
                                        className="flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl border border-red-200 bg-red-50 text-red-700 text-[13px] font-medium cursor-pointer transition-all duration-200 hover:bg-red-100 hover:border-red-300 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50"
                                    >
                                        <XCircle className="w-4 h-4" />
                                        No
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Step 2: Star rating */}
                        {surveyStep === 2 && (
                            <div style={{ animation: 'fadeUp 0.25s ease-out' }}>
                                <p className="text-[12px] text-gray-500 mb-3">
                                    {settings?.widget_messages?.rating_prompt || 'How would you rate this experience?'}
                                </p>
                                <div
                                    className="flex justify-center gap-2 mb-3"
                                    onMouseLeave={() => setHoveredStar(0)}
                                >
                                    {[1, 2, 3, 4, 5].map((star) => (
                                        <button
                                            key={star}
                                            onClick={() => !ratingSubmitting && handleSubmitRating(star)}
                                            onMouseEnter={() => setHoveredStar(star)}
                                            disabled={ratingSubmitting}
                                            aria-label={`Rate ${star} star${star !== 1 ? 's' : ''}`}
                                            className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center cursor-pointer transition-all duration-200 hover:scale-110 active:scale-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded-lg"
                                        >
                                            <Star
                                                className="w-7 h-7 transition-colors duration-150"
                                                fill={star <= hoveredStar ? '#F59E0B' : 'none'}
                                                stroke={star <= hoveredStar ? '#F59E0B' : '#D1D5DB'}
                                                strokeWidth={1.5}
                                            />
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Step dots + skip */}
                        <div className="flex items-center justify-center gap-3">
                            <div className="flex gap-1.5" aria-label={`Step ${surveyStep} of 2`}>
                                <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-200 ${surveyStep === 1 ? 'bg-gray-600' : 'bg-gray-300'}`} />
                                <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-200 ${surveyStep === 2 ? 'bg-gray-600' : 'bg-gray-300'}`} />
                            </div>
                            <button
                                onClick={() => { setSurveyStep(1); setResolvedAnswer(null); setHoveredStar(0); handleReturnToBot(); }}
                                disabled={ratingSubmitting}
                                className="text-[12px] text-gray-400 hover:text-gray-600 transition-colors cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded px-1"
                            >
                                Skip
                            </button>
                        </div>
                    </div>
                )}

                {/* End-chat confirmation modal moved out of the messages area to
                    the widget root (see below) so its backdrop covers the
                    entire widget (header + scroll area + input) instead of
                    just the messages-area viewport. */}

                {/* Welcome-back banner — dismissable, shown just above input after history loads */}
                {!isInitializing && isReturningUser && showWelcomeBackBanner && (
                    <div
                        className="mx-4 mb-2 mt-1 rounded-xl border border-gray-100 bg-gray-50 px-4 py-2.5 flex items-center justify-between gap-3"
                        style={{ animation: 'fadeUp 0.3s ease-out' }}
                    >
                        <span className="text-[12px] text-gray-500 leading-snug">
                            Welcome back! Continue your conversation or start something new.
                        </span>
                        <button
                            onClick={() => setShowWelcomeBackBanner(false)}
                            className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
                            aria-label="Dismiss welcome banner"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}

                <div ref={messagesEndRef} />

                {/* Scroll-to-latest affordance. Always mounted so the
                    show/hide transition can animate cleanly — toggling the
                    JSX would skip the CSS transition and snap. Opacity + a
                    downward translate make the affordance "rise up" into
                    its resting position when the user scrolls away from
                    the bottom, then fade + slide back down when they return. */}
                <button
                    type="button"
                    onClick={handleScrollToLatest}
                    aria-label="Scroll to latest message"
                    aria-hidden={isAtBottom}
                    tabIndex={isAtBottom ? -1 : 0}
                    className={`sticky bottom-1 self-center mt-auto w-[34px] h-[34px] aspect-square rounded-full shrink-0 bg-white shadow-md flex items-center justify-center text-black cursor-pointer origin-center transform-gpu transition-all duration-300 ease-out z-10 ${isAtBottom ? 'opacity-0 translate-y-6 pointer-events-none' : 'opacity-100 translate-y-3 pointer-events-auto'} ${scrollBtnPulse ? 'scale-125' : 'hover:scale-125 active:scale-95'}`}
                >
                    <ChevronDown className="w-4 h-4" strokeWidth={2} />
                </button>
            </div>

            {/* ── Unified ChatInput — hidden when any form is active ── */}
            {!showLeadForm &&
             !showRating &&
             !hasActiveHandoffForm &&
             chatMode !== 'unavailable' && (
                <ChatInput
                    inputText={inputText}
                    setInputText={setInputText}
                    onSubmit={handleSend}
                    isTyping={isTyping}
                    currentTheme={currentTheme}
                    inputRef={inputRef}
                    settings={settings}
                    onHandoff={!isInitializing && chatMode === 'bot' && settings.live_chat_enabled !== false ? triggerHandoff : undefined}
                    showProminentHandoff={showProminentHandoff}
                    primaryColor={sanitizeColor(settings.primary_color)}
                    showBranding={settings?.feature_flags?.show_branding !== false}
                    chatMode={chatMode}
                    onLiveSend={handleLiveSend}
                    onLiveTyping={() => wsTypingRef.current?.()}
                    onEndChat={() => setShowEndConfirm(true)}
                    onFilePick={() => wsFilePickRef.current?.()}
                    onPaste={(e) => wsPasteRef.current?.(e)}
                    fileSharing={settings?.feature_flags?.file_sharing === true}
                    isReconnecting={isLiveReconnecting}
                    uploadProgress={uploadProgress}
                    onInputFocus={scrollToBottom}
                    onInputBlur={resyncViewport}
                    meetingBookingEnabled={!!settings.meeting_booking_enabled && !meetingBooked}
                    onBookMeeting={() => {
                        if (settings.meeting_booking_enabled && !meetingBooked) {
                            const p = settings.meeting_provider || 'calendly';
                            const url = p === 'zcal' ? settings.zcal_url : settings.calendly_url;
                            if (url) {
                                setCalendlyUrl(url);
                                setMeetingProvider(p);
                                setShowBooking(true);
                            }
                        }
                    }}
                />
            )}

            {/* ── Headless LiveChatMode — WebSocket + file upload logic only ── */}
            {isLiveMode && sessionId && (
                <Suspense fallback={null}>
                    <LiveChatMode
                        sessionId={sessionId}
                        settings={settings}
                        chatMode={chatMode}
                        setChatMode={setChatMode}
                        setOperatorName={setOperatorName}
                        setOperatorDepartment={setOperatorDepartment}
                        onConnectionStatusChange={(status) => {
                            setLiveConnectionStatus(status);
                            if (status === 'reconnecting') setIsLiveReconnecting(true);
                            else if (status === 'connected') setIsLiveReconnecting(false);
                        }}
                        onLiveMessagesChange={handleLiveMessagesChange}
                        onOperatorTyping={setIsOperatorTyping}
                        onReconnectingChange={setIsLiveReconnecting}
                        onWsReady={handleWsReady}
                        onChatEnded={handleChatEnded}
                        onUploadProgressChange={setUploadProgress}
                    />
                </Suspense>
            )}

            {/* ── Transcript Email Modal ── */}
            {showTranscriptModal && (
                <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => setShowTranscriptModal(false)}>
                    <div className="bg-white rounded-2xl shadow-xl mx-4 w-full max-w-[320px] p-6" onClick={(e) => e.stopPropagation()}>
                        <button
                            onClick={() => setShowTranscriptModal(false)}
                            className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>

                        {transcriptSent ? (
                            <div className="text-center py-4">
                                <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-3">
                                    <svg className="w-6 h-6 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                    </svg>
                                </div>
                                <p className="text-sm font-medium text-gray-800 mb-1">Transcript sent!</p>
                                <p className="text-xs text-gray-500">Check your inbox at {transcriptEmail}</p>
                                <button
                                    onClick={() => setShowTranscriptModal(false)}
                                    className="mt-4 w-full py-2.5 rounded-xl text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
                                >
                                    Close
                                </button>
                            </div>
                        ) : (
                            <form onSubmit={handleTranscriptSubmit}>
                                <div className="flex justify-center mb-4">
                                    <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                                        <Mail className="w-5 h-5 text-gray-500" />
                                    </div>
                                </div>
                                <p className="text-sm font-medium text-gray-800 text-center mb-4">
                                    Send the chat transcript to your e-mail.
                                </p>
                                <input
                                    type="email"
                                    value={transcriptEmail}
                                    onChange={(e) => setTranscriptEmail(e.target.value)}
                                    placeholder="your@email.com"
                                    required
                                    autoFocus
                                    className="w-full px-4 py-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 mb-3"
                                />
                                {transcriptError && (
                                    <p className="text-xs text-red-500 mb-3">{transcriptError}</p>
                                )}
                                <button
                                    type="submit"
                                    disabled={transcriptSending || !transcriptEmail.trim()}
                                    className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50"
                                    style={{ backgroundColor: sanitizeColor(settings.primary_color, '#2563eb') }}
                                >
                                    {transcriptSending ? 'Sending...' : 'Send'}
                                </button>
                            </form>
                        )}
                    </div>
                </div>
            )}

            {/* ── End-chat confirmation modal ──
                Lives at the widget-root level (sibling of header / messages /
                input) so its ``absolute inset-0`` backdrop covers the FULL
                widget area, not just the messages-area scroll viewport.
                Previously rendered inside [data-messages-area]: the dim only
                spanned the visible scroll region, leaving the chat input and
                lower portions un-dimmed (and undimmed text visible through). */}
            {showEndConfirm && (
                <div
                    className="absolute inset-0 z-[60] flex items-center justify-center"
                    style={{ animation: 'fadeIn 0.2s ease-out' }}
                >
                    {/* Backdrop — covers the whole widget */}
                    <div
                        className="absolute inset-0 bg-black/40"
                        onClick={() => setShowEndConfirm(false)}
                        aria-hidden="true"
                    />
                    {/* Modal card */}
                    <div
                        role="alertdialog"
                        aria-modal="true"
                        aria-labelledby="end-chat-title"
                        aria-describedby="end-chat-desc"
                        className="relative bg-white rounded-2xl shadow-xl p-5 mx-4 max-w-[280px] w-full text-center"
                        style={{ animation: 'scaleIn 0.2s ease-out' }}
                        onKeyDown={(e) => { if (e.key === 'Escape') setShowEndConfirm(false); }}
                    >
                        <div
                            className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center"
                            style={{ backgroundColor: `${sanitizeColor(settings.primary_color, '#3A0CA3')}15` }}
                        >
                            <LogOut className="w-5 h-5" style={{ color: sanitizeColor(settings.primary_color, '#3A0CA3') }} />
                        </div>
                        <p id="end-chat-title" className="text-[14px] font-semibold text-[#16202C] mb-0.5">
                            End conversation?
                        </p>
                        {operatorName && (
                            <p className="text-[12px] text-gray-500 mb-1">with {operatorName}</p>
                        )}
                        <p id="end-chat-desc" className="text-[12px] text-gray-400 mb-4">
                            You'll be returned to the AI assistant.
                        </p>
                        <div className="flex flex-col gap-2">
                            <button
                                onClick={() => {
                                    if (wsEndChatRef.current) wsEndChatRef.current();
                                    setShowEndConfirm(false);
                                }}
                                className="w-full py-2.5 min-h-[44px] rounded-xl bg-red-500 text-white text-[13px] font-medium cursor-pointer transition-all duration-200 hover:bg-red-600 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                            >
                                End chat
                            </button>
                            <button
                                onClick={() => setShowEndConfirm(false)}
                                autoFocus
                                className="w-full py-2.5 min-h-[44px] rounded-xl bg-white border border-gray-200 text-gray-600 text-[13px] font-medium cursor-pointer transition-all duration-200 hover:bg-gray-50 hover:border-gray-300 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                            >
                                Keep chatting
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Operator → visitor connect-request popup. Lives at widget-root
                level (sibling of header/messages/input) so it overlays the
                entire widget regardless of scroll position or theme. */}
            {chatMode === 'bot' && connectRequest && (
                <ConnectRequestPopup
                    operatorName={connectRequest.operator_name}
                    expiresAt={connectRequest.expires_at}
                    submitting={connectRequestSubmitting}
                    onAccept={handleConnectRequestAccept}
                    onDecline={handleConnectRequestDecline}
                    onExpire={handleConnectRequestExpire}
                    primaryColor={settings.primary_color}
                />
            )}
        </div>
    );
};

export default ChatWindow;
