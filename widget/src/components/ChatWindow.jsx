import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Plus, Clock, MoreHorizontal, Mail, CheckCircle2, AlertCircle, User, Phone, MessageSquare } from 'lucide-react';
import { sendMessageStream, getChatHistory, submitLeadCapture, requestHandoff, getLeadInfo, submitOfflineMessage, collectPageContext, sendBehavioralSignals, sendTimeOnPage, submitMeetingBooked } from '../services/api';
import { themeConfigs } from './themeConfigs';
import BotAvatar from './BotAvatar';
import MessageBubble from './MessageBubble';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';
import LeadCaptureForm from './LeadCaptureForm';
import HandoffForm from './HandoffForm';
import LiveChatMode from './LiveChatMode';
import MeetingBooking from './MeetingBooking';
import QualificationCTA from './QualificationCTA';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const FALLBACK_PATTERNS = /connect.*with.*(team|support|human)|don't have that specific information|I'm not sure about that|couldn't find.*information|not contained in/i;

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

    // ── Live chat lifted state ───────────────────────────────────────────────────
    const [liveMessages, setLiveMessages] = useState([]);
    const [isOperatorTyping, setIsOperatorTyping] = useState(false);
    const [lastReadAt, setLastReadAt] = useState(null);
    const [isLiveReconnecting, setIsLiveReconnecting] = useState(false);
    const [showRating, setShowRating] = useState(false);
    const [ratingSubmitting, setRatingSubmitting] = useState(false);
    const [showEndConfirm, setShowEndConfirm] = useState(false);
    const [uploadProgress] = useState(null); // controlled by LiveChatMode file upload
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

    // ── Mobile keyboard push-up ──────────────────────────────────────────────────
    useEffect(() => {
        const viewport = window.visualViewport;
        if (!viewport || window.innerWidth >= 768) return;
        const handleResize = () => {
            if (containerRef.current) {
                containerRef.current.style.height = `${viewport.height}px`;
            }
        };
        viewport.addEventListener('resize', handleResize);
        return () => viewport.removeEventListener('resize', handleResize);
    }, []);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

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
    }, [streamingId, isTyping, messages.length, liveMessages.length]);

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
            if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) {
                setShowHeaderMenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showHeaderMenu]);

    const handleSendTranscript = () => {
        setShowHeaderMenu(false);
        const transcript = messages
            .map(m => `[${m.sender === 'user' ? 'You' : settings.bot_name || 'Bot'}] ${m.text}`)
            .join('\n\n');
        const subject = encodeURIComponent(`Chat transcript — ${settings.bot_name || 'OyeChats'}`);
        const body = encodeURIComponent(transcript);
        window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
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
            setMessages(prev => prev.map(m =>
                m.type === 'handoff_form' ? { ...m, status: 'pending' } : m
            ));
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

    // ── Return to bot after live chat ends ───────────────────────────────────────
    const handleReturnToBot = useCallback(() => {
        setShowRating(false);
        setShowEndConfirm(false);
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
        try {
            await fetch(`${API_URL}/operators/sessions/${sessionId}/rating`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Bot-Key': settings.bot_key || window.OYECHATS_BOT_KEY || '',
                },
                body: JSON.stringify({ rating: stars }),
            });
        } catch { /* non-fatal */ } finally {
            setRatingSubmitting(false);
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
        const fallbackPatterns = /connect.*with.*(team|support|human)|don't have.*specific information|I'm not sure about that|couldn't find.*specific information|not contained in/i;
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
            const primaryColor = settings.primary_color || '#3A0CA3';
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
        if (chatMode === 'unavailable') {
            return (
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 flex-shrink-0">
                        <Clock className="w-4 h-4" />
                    </div>
                    <h3 className="font-semibold text-sm text-gray-500">Support Unavailable</h3>
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
                        style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
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
        const userBubbleBg = settings.user_bubble_color || '#DBE9FF';
        const primaryColor = settings.primary_color || '#3A0CA3';

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
            <div className={currentTheme.header}>
                {renderHeader() || <div />}
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
                    <button
                        onClick={() => setShowHeaderMenu(prev => !prev)}
                        className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors text-gray-400 hover:text-gray-600"
                        title="More options"
                    >
                        <MoreHorizontal className="w-4 h-4" />
                    </button>
                    <button
                        onClick={onClose}
                        className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                        title="Close"
                    >
                        <X className="w-5 h-5" />
                    </button>

                    {showHeaderMenu && (
                        <div className="absolute top-full right-0 mt-1 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-50 min-w-[180px]" style={{ animation: 'fadeUp 0.15s ease-out' }}>
                            <button
                                onClick={handleSendTranscript}
                                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-[#16202C] hover:bg-gray-50 transition-colors"
                            >
                                <Mail className="w-4 h-4 text-gray-400" />
                                Send transcript
                            </button>
                        </div>
                    )}
                </div>
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
                style={{
                    backgroundColor: (settings.background_color && settings.background_color !== '#ffffff') ? settings.background_color : undefined,
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
                                ? settings.background_color
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
                        } else if (msg.type === 'handoff_form') {
                            items.push(
                                <HandoffForm
                                    key={msg.id}
                                    settings={settings}
                                    onSubmit={handleHandoffSubmit}
                                    onCancel={handleHandoffCancel}
                                    existingLeadInfo={existingLeadInfo}
                                    status={msg.status}
                                />
                            );
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
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '0ms', backgroundColor: settings.primary_color || '#3A0CA3', opacity: 0.6 }} />
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '150ms', backgroundColor: settings.primary_color || '#3A0CA3', opacity: 0.6 }} />
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '300ms', backgroundColor: settings.primary_color || '#3A0CA3', opacity: 0.6 }} />
                        </div>
                    </div>
                )}

                {/* Waiting state — inline spinner below the handoff system message */}
                {chatMode === 'waiting' && !isInitializing && (
                    <div className="flex flex-col items-center py-4 px-4" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                        <div
                            className="w-8 h-8 border-4 border-t-transparent rounded-full animate-spin mb-2"
                            style={{ borderColor: `${settings.primary_color || '#3A0CA3'}40`, borderTopColor: settings.primary_color || '#3A0CA3' }}
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
                                style={{ color: settings.primary_color || '#3A0CA3' }}
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

                {/* Unavailable — offline message form as inline card */}
                {chatMode === 'unavailable' && !isInitializing && (
                    <div className="mx-3 my-2 rounded-2xl border border-gray-100 shadow-sm bg-white p-4" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                        {offlineError ? (
                            <div className="text-center py-2">
                                <AlertCircle className="w-7 h-7 text-red-400 mx-auto mb-2" />
                                <p className="text-[13px] text-gray-600 mb-3">We couldn't send your message. Please try again.</p>
                                <button
                                    onClick={() => setOfflineError(false)}
                                    className="w-full py-2 rounded-xl text-white text-[13px] font-medium"
                                    style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                                >
                                    Try Again
                                </button>
                            </div>
                        ) : offlineSubmitted ? (
                            <div className="text-center py-2">
                                <CheckCircle2 className="w-7 h-7 text-green-500 mx-auto mb-2" />
                                <p className="text-[13px] font-semibold text-[#16202C] mb-1">Message sent!</p>
                                <p className="text-[12px] text-gray-500 mb-3">
                                    We'll get back to you at <strong>{offlineForm.email}</strong>
                                    {offlineForm.phone ? ' or give you a callback' : ''} as soon as possible.
                                </p>
                                <button
                                    onClick={handleReturnToBot}
                                    className="w-full py-2 rounded-xl text-white text-[13px] font-medium"
                                    style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                                >
                                    Continue chatting with AI
                                </button>
                            </div>
                        ) : (
                            <>
                                <div className="flex items-center gap-2 mb-2">
                                    <Clock className="w-4 h-4 text-amber-500 flex-shrink-0" />
                                    <p className="text-[13px] font-semibold text-[#16202C]">{settings.offline_message || 'Team is currently unavailable'}</p>
                                </div>
                                <p className="text-[12px] text-gray-500 mb-3">Leave us a message and we'll get back to you.</p>
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
                                        style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}>
                                        {offlineSubmitting
                                            ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                            : 'Send Message'}
                                    </button>
                                </form>
                            </>
                        )}
                    </div>
                )}

                {/* Rating card — inline in stream after live chat ends */}
                {showRating && settings?.feature_flags?.post_chat_rating !== false && (
                    <div className="mx-3 my-2 rounded-2xl border border-gray-100 shadow-sm bg-white p-4 text-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                        <CheckCircle2 className="w-7 h-7 mx-auto mb-2" style={{ color: settings.primary_color || '#3A0CA3' }} />
                        <p className="text-[13px] font-semibold text-[#16202C] mb-0.5">Chat ended</p>
                        <p className="text-[12px] text-gray-500 mb-3">How was your experience?</p>
                        <div className="flex justify-center gap-2 mb-2">
                            {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                    key={star}
                                    onClick={() => !ratingSubmitting && handleSubmitRating(star)}
                                    disabled={ratingSubmitting}
                                    aria-label={`Rate ${star} star${star !== 1 ? 's' : ''}`}
                                    className="text-2xl transition-transform hover:scale-125 disabled:opacity-50 focus-visible:outline-none"
                                >
                                    ⭐
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => !ratingSubmitting && handleReturnToBot()}
                            disabled={ratingSubmitting}
                            className="text-[12px] text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
                        >
                            Skip
                        </button>
                    </div>
                )}

                {/* End-chat confirmation */}
                {showEndConfirm && (
                    <div className="mx-3 my-1 px-3 py-3 bg-red-50 border border-red-200 rounded-2xl">
                        <p className="text-xs text-red-700 font-medium mb-2">End this conversation and return to AI?</p>
                        <div className="flex gap-2">
                            <button
                                onClick={() => {
                                    if (wsEndChatRef.current) wsEndChatRef.current();
                                    setShowEndConfirm(false);
                                }}
                                className="flex-1 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium"
                            >
                                Yes, end chat
                            </button>
                            <button
                                onClick={() => setShowEndConfirm(false)}
                                className="flex-1 py-1.5 rounded-lg bg-white border border-gray-200 text-gray-600 text-xs font-medium"
                            >
                                Cancel
                            </button>
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
                    primaryColor={settings.primary_color}
                    showBranding={settings?.feature_flags?.show_branding !== false}
                    chatMode={chatMode}
                    onLiveSend={handleLiveSend}
                    onLiveTyping={() => wsTypingRef.current?.()}
                    onEndChat={() => setShowEndConfirm(true)}
                    onFilePick={() => wsFilePickRef.current?.()}
                    fileSharing={settings?.feature_flags?.file_sharing === true}
                    isReconnecting={isLiveReconnecting}
                    uploadProgress={uploadProgress}
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
                />
            )}
        </div>
    );
};

export default ChatWindow;
