import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Plus, Clock, MoreHorizontal, Mail, CheckCircle2, AlertCircle, User, Phone, MessageSquare, LogOut, Star, XCircle } from 'lucide-react';
import { sendMessageStream, getChatHistory, submitLeadCapture, requestHandoff, getLeadInfo, submitOfflineMessage, collectPageContext, sendBehavioralSignals, sendTimeOnPage, submitMeetingBooked, sendTranscriptEmail } from '../services/api';
import { themeConfigs } from './themeConfigs';
import BotAvatar from './BotAvatar';
import MessageBubble from './MessageBubble';
import { sanitizeColor } from '../services/sanitize';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';
import LeadCaptureForm from './LeadCaptureForm';
import HandoffForm from './HandoffForm';
import LiveChatMode from './LiveChatMode';
import MeetingBooking from './MeetingBooking';
import QualificationCTA from './QualificationCTA';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const FALLBACK_PATTERNS = /don't have that specific information|I'm not sure about that|couldn't find.*information|not contained in/i;

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
    const [sessionId, setSessionId] = useState(() => {
        try { return localStorage.getItem('chat_session_id'); } catch { return null; }
    });
    const [showWelcome, setShowWelcome] = useState(isOnline);
    const [welcomeExiting, setWelcomeExiting] = useState(false);
    const [showLeadForm, setShowLeadForm] = useState(false);
    // bot | waiting | live | unavailable
    const [chatMode, setChatMode] = useState(isOnline ? 'bot' : 'unavailable');
    const [operatorName, setOperatorName] = useState(null);
    const [operatorDepartment, setOperatorDepartment] = useState(null);
    const [streamingId, setStreamingId] = useState(null);
    const [isReturningUser, setIsReturningUser] = useState(false);
    const [hasMoreHistory, setHasMoreHistory] = useState(false);
    const [showWelcomeBackBanner, setShowWelcomeBackBanner] = useState(true);
    const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
    const [showProminentHandoff, setShowProminentHandoff] = useState(false);
    const [activeCTA, setActiveCTA] = useState(null);
    const [showBooking, setShowBooking] = useState(false);
    const [calendlyUrl, setCalendlyUrl] = useState(null);
    const [meetingBooked, setMeetingBooked] = useState(false);
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
    const [lastReadAt, setLastReadAt] = useState(null);
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

        const syncViewport = () => {
            if (!isMobile() || !containerRef.current) return;

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

        const containerEl = containerRef.current;
        return () => {
            vv.removeEventListener('resize', syncViewport);
            vv.removeEventListener('scroll', handleScroll);
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
            const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || 'default';
            const leadCapturedKey = `oyechats_lead_captured_${botKey}`;
            if (resolvedSettings?.lead_form_enabled && !localStorage.getItem(leadCapturedKey) && !sessionId) {
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
                            feedback: null,
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

    // ── Collect page context on mount, send time-on-page on unload ──────────────
    useEffect(() => {
        pageContextRef.current = collectPageContext();

        const handleUnload = () => {
            const sid = sessionId || localStorage.getItem('chat_session_id');
            if (sid && pageContextRef.current) {
                sendTimeOnPage(sid, pageContextRef.current._load_time);
            }
        };
        window.addEventListener('beforeunload', handleUnload);
        return () => window.removeEventListener('beforeunload', handleUnload);
    }, [sessionId]);

    // Scroll when messages or live messages change
    useEffect(() => {
        scrollToBottom();
    }, [streamingId, isTyping, messages.length, liveMessages.length, scrollToBottom]);

    // Inject "operator joined" system message when operator first connects
    useEffect(() => {
        if (operatorName && !prevOperatorNameRef.current) {
            setMessages(prev => [
                ...prev.filter(m => !(m.type === 'system' && m.text === 'Connecting you with the support team...')),
                {
                    id: `sys-joined-${Date.now()}`,
                    type: 'system',
                    text: `${operatorName}${operatorDepartment ? ` from ${operatorDepartment}` : ''} joined`,
                    timestamp: new Date().toISOString(),
                }
            ]);
        }
        prevOperatorNameRef.current = operatorName;
    }, [operatorName, operatorDepartment]);

    // Waiting timer
    useEffect(() => {
        if (chatMode === 'waiting') {
            setWaitingSeconds(0);
            waitingTimerRef.current = setInterval(() => {
                setWaitingSeconds(prev => prev + 1);
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
    }, [chatMode]);

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
        localStorage.removeItem('chat_session_id');
        const newSession = `session_${crypto.randomUUID()}`;
        setSessionId(newSession);
        localStorage.setItem('chat_session_id', newSession);
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
        consecutiveFallbacks.current = 0;
        setExistingLeadInfo(null);
        setLiveMessages([]);
        setIsOperatorTyping(false);
        setLastReadAt(null);
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
        if (inputRef.current) inputRef.current.style.height = 'auto';
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
                        localStorage.setItem('chat_session_id', metadata.session_id);
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
                        setShowBooking(true);
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
                onError: () => {
                    setIsTyping(false);
                    if (placeholderId !== null) {
                        setMessages(prev => prev.map(msg => {
                            if (msg.id !== placeholderId) return msg;
                            const cleaned = sanitizeMarkdown(msg.text || '');
                            if (!cleaned) {
                                return { ...msg, text: "I'm sorry, I couldn't generate a response. Please try again." };
                            }
                            // Partial content streamed before error — preserve it, mark as interrupted
                            return { ...msg, text: cleaned + '\n\n*Response was interrupted. Please try again.*' };
                        }));
                    } else {
                        setMessages(prev => [...prev, {
                            id: Date.now() + 2,
                            text: "I'm sorry, I couldn't generate a response. Please try again.",
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
    }, []);

    const triggerHandoff = useCallback(() => {
        if (!sessionId) {
            const newSession = `session_${crypto.randomUUID()}`;
            setSessionId(newSession);
            localStorage.setItem('chat_session_id', newSession);
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
    const handleHandoffSubmit = async (formData) => {
        if (isSubmittingHandoff) return;
        setIsSubmittingHandoff(true);
        setMessages(prev => prev.map(m =>
            m.type === 'handoff_form' ? { ...m, status: 'submitting' } : m
        ));
        try {
            await requestHandoff(sessionId, formData);
            setMessages(prev => [
                ...prev.filter(m => m.type !== 'handoff_form'),
                {
                    id: `sys-connecting-${Date.now()}`,
                    type: 'system',
                    text: 'Connecting you with the support team...',
                    timestamp: new Date().toISOString(),
                }
            ]);
            handoffFormInjectedRef.current = false;
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

    // ── Lead form submit ─────────────────────────────────────────────────────────
    const handleLeadFormSubmit = async (formData) => {
        const newSessionId = sessionId || `session_${crypto.randomUUID()}`;
        if (!sessionId) {
            setSessionId(newSessionId);
            localStorage.setItem('chat_session_id', newSessionId);
        }
        await submitLeadCapture(newSessionId, formData);
        const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || 'default';
        localStorage.setItem(`oyechats_lead_captured_${botKey}`, 'true');
        setShowLeadForm(false);
        setShowWelcome(true);
    };

    // ── Live chat send (via WS) ──────────────────────────────────────────────────
    const handleLiveSend = useCallback((text) => {
        if (!wsSendRef.current || !text.trim()) return;
        setShowWelcomeBackBanner(false);

        const msgId = `live-${Date.now()}`;
        const timestamp = new Date().toISOString();
        const newMsg = { id: msgId, text, sender: 'user', timestamp, failed: false, status: 'sent' };

        try {
            wsSendRef.current(text);
        } catch {
            newMsg.failed = true;
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
        setShowRating(false);
        setShowEndConfirm(false);
        setSurveyStep(1);
        setResolvedAnswer(null);
        setHoveredStar(0);
        setLiveMessages([]);
        setIsOperatorTyping(false);
        setLastReadAt(null);
        setIsLiveReconnecting(false);
        setOfflineSubmitted(false);
        setOfflineError(false);
        setOfflineForm({ name: '', email: '', phone: '', message: '' });
        setChatMode('bot');
        setOperatorName(null);
        handoffFormInjectedRef.current = false;
        setMessages(prev => [...prev, {
            id: Date.now(),
            text: "Thanks for your message! We'll get back to you soon. In the meantime, feel free to ask me anything.",
            sender: 'bot',
            timestamp: new Date().toISOString(),
            feedback: null,
        }]);
    }, []);

    const handleChatEnded = useCallback(() => {
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
            await submitOfflineMessage({
                name: offlineForm.name,
                email: offlineForm.email,
                phone: offlineForm.phone || null,
                message: offlineForm.message,
                session_id: sessionId,
            });
            setOfflineSubmitted(true);
        } catch {
            setOfflineError(true);
        } finally {
            setOfflineSubmitting(false);
        }
    };

    // ── WS callbacks exposed from LiveChatMode ───────────────────────────────────
    const handleWsReady = useCallback(({ send, typing, triggerFilePick, endChat }) => {
        wsSendRef.current = send;
        wsTypingRef.current = typing;
        wsFilePickRef.current = triggerFilePick;
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
    const renderHeader = () => {
        if (chatMode === 'waiting') {
            return (
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                        <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                    <h3 className="font-semibold text-sm text-[#16202C]">{settings.waiting_message || 'Connecting to support...'}</h3>
                </div>
            );
        }
        if (chatMode === 'live' && operatorName) {
            const primaryColor = sanitizeColor(settings.primary_color, '#3A0CA3');
            const isReconnecting = liveConnectionStatus === 'reconnecting';
            return (
                <div className="flex items-center gap-2.5">
                    <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
                        style={{ backgroundColor: isReconnecting ? '#F59E0B' : primaryColor }}
                    >
                        {operatorName?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div>
                        <h3 className="font-semibold text-sm text-[#16202C]">{operatorName}</h3>
                        {isReconnecting && (
                            <p className="text-[10px] font-medium text-amber-600">Reconnecting...</p>
                        )}
                    </div>
                </div>
            );
        }
        return (
            <span className="text-[11px] text-gray-400 font-medium tracking-wide">
                {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} &middot; {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
        );
    };

    // ── Floating agent badge ─────────────────────────────────────────────────────
    const renderAgentBadge = () => {
        const isLive = chatMode === 'live' && operatorName;
        return (
            <div
                className="inline-flex items-center gap-2 rounded-full pl-1.5 pr-3.5 py-1.5 shadow-lg border border-white/40 pointer-events-auto"
                style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
            >
                {isLive ? (
                    <div
                        className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                        style={{ backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}
                    >
                        {operatorName?.charAt(0)?.toUpperCase() || 'S'}
                    </div>
                ) : (
                    <BotAvatar settings={settings} size="sm" />
                )}
                <div className="flex flex-col">
                    <span className="text-[12px] font-semibold text-[#16202C] leading-tight">
                        {isLive ? operatorName : (settings.bot_name || 'AI Assistant')}
                    </span>
                    <span className="text-[10px] text-gray-400 leading-tight">
                        {isLive ? (operatorDepartment || 'Support Team') : 'AI Assistant'}
                    </span>
                </div>
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
            </div>
        );
    };

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
                            {msg.file_url ? (
                                msg.content_type?.startsWith('image/') ? (
                                    <img
                                        src={msg.file_url}
                                        alt={msg.filename || 'image'}
                                        className="max-w-[200px] rounded-xl block cursor-zoom-in hover:opacity-90 transition-opacity"
                                    />
                                ) : (
                                    <a href={msg.file_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline text-sm break-all">
                                        📎 {msg.filename || 'file'}
                                    </a>
                                )
                            ) : (
                                <p className="break-words" style={{ color: '#16202C' }}>{msg.text}</p>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 mr-1">
                        {msg.failed ? (
                            <button
                                type="button"
                                aria-label="Message not sent — tap to retry"
                                onClick={() => {
                                    if (wsSendRef.current && msg.text) {
                                        try {
                                            wsSendRef.current(msg.text);
                                            setLiveMessages(prev => prev.map(m =>
                                                m.id === msg.id ? { ...m, failed: false, status: 'sent' } : m
                                            ));
                                        } catch { /* stay failed */ }
                                    }
                                }}
                                className="text-[10px] text-red-500 flex items-center gap-0.5 hover:text-red-700 underline cursor-pointer"
                            >
                                <AlertCircle className="w-3 h-3" /> Not sent · Retry
                            </button>
                        ) : (
                            <span
                                className="text-[10px] select-none"
                                style={{ color: (lastReadAt && msg.timestamp <= lastReadAt) ? '#53bdeb' : '#9CA3AF' }}
                                title={(lastReadAt && msg.timestamp <= lastReadAt) ? 'Read' : 'Sent'}
                            >
                                {(lastReadAt && msg.timestamp <= lastReadAt) ? '✓✓' : '✓'}
                            </span>
                        )}
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
                {msg.file_url ? (
                    msg.content_type?.startsWith('image/') ? (
                        <img
                            src={msg.file_url}
                            alt={msg.filename || 'image'}
                            className="max-w-[200px] rounded-xl block hover:opacity-90 transition-opacity"
                        />
                    ) : (
                        <a href={msg.file_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline text-sm break-all">
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

            {/* ── Floating agent badge (always on top of messages area) ── */}
            {!isInitializing && !showLeadForm && (chatMode === 'bot' || (chatMode === 'live' && operatorName)) && (
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

                {/* Lead capture form overlay — shown before any conversation begins */}
                {showLeadForm && (
                    <div className="absolute inset-0 z-20 pointer-events-auto">
                        <LeadCaptureForm
                            settings={settings}
                            currentTheme={currentTheme}
                            onClose={onClose}
                            onSubmit={handleLeadFormSubmit}
                            isAnimating={isAnimating}
                        />
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
                        } else if (msg.type === 'handoff_form' && msg.status !== 'submitted') {
                            items.push(
                                <div key={msg.id} className="mx-3 my-2" style={{ animation: 'fadeUp 0.3s ease-out' }}>
                                    <HandoffForm
                                        settings={settings}
                                        onSubmit={handleHandoffSubmit}
                                        onCancel={handleHandoffCancel}
                                        existingLeadInfo={existingLeadInfo}
                                        status={msg.status}
                                    />
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
                    <MeetingBooking
                        calendlyUrl={calendlyUrl}
                        sessionId={sessionId}
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
                                if (wsEndChatRef.current) wsEndChatRef.current();
                                setChatMode('bot');
                                setOperatorName(null);
                            }}
                            className="mt-1 text-[12px] text-gray-400 hover:text-gray-600 transition-colors"
                        >
                            Cancel and return to AI chat
                        </button>
                    </div>
                )}

                {/* Offline message form — inline in stream */}
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
                        ) : (
                            <>
                                <div className="flex items-center gap-2 mb-2">
                                    <Clock className="w-4 h-4 text-amber-500 flex-shrink-0" />
                                    <p className="text-[13px] font-semibold text-[#16202C]">{settings.offline_message || 'Our team is currently unavailable'}</p>
                                </div>
                                <p className="text-[12px] text-gray-500 mb-3">Leave us a message and we&apos;ll get back to you.</p>
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
                                </form>
                            </>
                        )}
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

                {/* End-chat confirmation modal overlay */}
                {showEndConfirm && (
                    <div
                        className="absolute inset-0 z-50 flex items-center justify-center"
                        style={{ animation: 'fadeIn 0.2s ease-out' }}
                    >
                        {/* Backdrop */}
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
                    fileSharing={settings?.feature_flags?.file_sharing === true}
                    isReconnecting={isLiveReconnecting}
                    uploadProgress={uploadProgress}
                    onInputFocus={scrollToBottom}
                    onInputBlur={resyncViewport}
                />
            )}

            {/* ── Headless LiveChatMode — WebSocket + file upload logic only ── */}
            {isLiveMode && sessionId && (
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
                    onLastReadAtChange={setLastReadAt}
                    onReconnectingChange={setIsLiveReconnecting}
                    onWsReady={handleWsReady}
                    onChatEnded={handleChatEnded}
                    onUploadProgressChange={setUploadProgress}
                />
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
        </div>
    );
};

export default ChatWindow;
