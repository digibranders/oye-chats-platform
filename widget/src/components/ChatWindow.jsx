import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Plus, Clock, MoreHorizontal, Mail, Volume2 } from 'lucide-react';
import { sendMessageStream, getChatHistory, submitLeadCapture, requestHandoff, getLeadInfo } from '../services/api';
import { themeConfigs } from './themeConfigs';
import BotAvatar from './BotAvatar';
import MessageBubble from './MessageBubble';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';
import LeadCaptureForm from './LeadCaptureForm';
import HandoffForm from './HandoffForm';
import LiveChatMode from './LiveChatMode';

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
    // When the bot is outside business hours, skip the welcome screen and go straight to unavailable/offline form
    const [showWelcome, setShowWelcome] = useState(isOnline);
    const [welcomeExiting, setWelcomeExiting] = useState(false); // cross-fade transition
    const [showLeadForm, setShowLeadForm] = useState(false);
    const [chatMode, setChatMode] = useState(isOnline ? 'bot' : 'unavailable'); // bot|handoff_form|waiting|live|unavailable
    const [operatorName, setOperatorName] = useState(null);
    const [operatorDepartment, setOperatorDepartment] = useState(null);
    const [streamingId, setStreamingId] = useState(null);
    const [isReturningUser, setIsReturningUser] = useState(false);
    const [showProminentHandoff, setShowProminentHandoff] = useState(false);
    const [liveConnectionStatus, setLiveConnectionStatus] = useState('connected');
    const [existingLeadInfo, setExistingLeadInfo] = useState(null);

    // Header menu state (three-dot menu with Send transcript + Sounds toggle)
    const [showHeaderMenu, setShowHeaderMenu] = useState(false);
    const [soundsEnabled, setSoundsEnabled] = useState(() => {
        try { return localStorage.getItem('oyechats_sounds') !== 'off'; } catch { return true; }
    });
    const headerMenuRef = useRef(null);

    // Streaming chunk buffer — accumulate tokens and flush once per animation frame
    // to cap React re-renders at ~60/s regardless of LLM token throughput.
    const chunkBufferRef = useRef('');
    const rafRef = useRef(null);

    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const recentMessageTimestamps = useRef([]);
    const consecutiveFallbacks = useRef(0);
    const handoffTriggeredRef = useRef(false); // prevents double-trigger race between fallback and suggest_handoff

    const currentTheme = themeConfigs[theme] || themeConfigs.classic;

    // Mobile keyboard push-up — update container height when virtual keyboard opens
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

    // Load History and Settings on Mount
    useEffect(() => {
        const initChat = async () => {
            if (initialSettings) {
                setSettings(initialSettings);
                setMessages(prev => prev.map(m =>
                    m.id === 'welcome' ? { ...m, text: `Hi There, How can I help you today?` } : m
                ));
            }

            // Check if lead form should be shown (new visitors only)
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
                    const history = await getChatHistory(sessionId);
                    if (history && history.length > 0) {
                        const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
                        setIsReturningUser(true);
                        let welcomeBackText = `Welcome back! 👋`;
                        if (lastUserMsg) {
                            const preview = lastUserMsg.content.length > 80
                                ? lastUserMsg.content.substring(0, 80) + '...'
                                : lastUserMsg.content;
                            welcomeBackText += `\n\nLast time you asked about: **"${preview}"**\n\nFeel free to continue where you left off or ask something new!`;
                        } else {
                            welcomeBackText += `\n\nGood to see you again! Feel free to continue where you left off or ask something new.`;
                        }

                        setMessages([{
                            id: 'welcome-back',
                            text: welcomeBackText,
                            sender: 'bot',
                            timestamp: new Date().toISOString(),
                            feedback: null
                        }]);

                        setShowWelcome(false);
                    }
                } catch (error) {
                    console.error("Failed to load history:", error);
                }

                // Fetch existing lead info to pre-fill the handoff form (non-blocking)
                try {
                    const leadData = await getLeadInfo(sessionId);
                    if (leadData) setExistingLeadInfo(leadData);
                } catch {
                    // Non-critical — never fails widget load
                }
            }
            setIsInitializing(false);

            // Auto-send message from greeting bubble (if present)
            if (initialMessage?.current) {
                const text = initialMessage.current;
                initialMessage.current = null;
                // Small delay to let state settle before triggering send
                setTimeout(() => handleSend(null, text), 150);
            }
        };

        initChat();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Scroll to bottom when a new message is added or streaming starts/ends.
    // Intentionally NOT dependent on `messages` so the DOM isn't thrashed on every token.
    useEffect(() => {
        scrollToBottom();
    }, [streamingId, isTyping, messages.length]);

    // Smooth cross-fade transition from welcome screen → chat
    const WELCOME_EXIT_DURATION = 350; // ms — matches CSS transition
    const exitWelcome = useCallback(() => {
        setWelcomeExiting(true);
        setTimeout(() => {
            setShowWelcome(false);
            setWelcomeExiting(false);
        }, WELCOME_EXIT_DURATION);
    }, []);

    // Close header menu when clicking outside
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

    const toggleSounds = () => {
        const next = !soundsEnabled;
        setSoundsEnabled(next);
        try { localStorage.setItem('oyechats_sounds', next ? 'on' : 'off'); } catch { /* noop */ }
        setShowHeaderMenu(false);
    };

    const handleSendTranscript = () => {
        setShowHeaderMenu(false);
        // Compile messages into a mailto: link for now (backend email endpoint can be added later)
        const transcript = messages
            .map(m => `[${m.sender === 'user' ? 'You' : settings.bot_name || 'Bot'}] ${m.text}`)
            .join('\n\n');
        const subject = encodeURIComponent(`Chat transcript — ${settings.bot_name || 'OyeChats'}`);
        const body = encodeURIComponent(transcript);
        window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
    };

    const handleNewChat = () => {
        setIsInitializing(true);
        localStorage.removeItem('chat_session_id');
        const newSession = `session_${crypto.randomUUID()}`;
        setSessionId(newSession);
        localStorage.setItem('chat_session_id', newSession);
        setShowWelcome(true);
        // Reset auto-handoff state for the new session
        handoffTriggeredRef.current = false;
        consecutiveFallbacks.current = 0;
        setExistingLeadInfo(null);
        setTimeout(() => {
            setMessages([{
                id: 'welcome',
                text: `Hi There, How can I help you today?`,
                sender: 'bot',
                timestamp: new Date().toISOString(),
                feedback: null
            }]);
            setIsReturningUser(false);
            setIsInitializing(false);
        }, 600);
    };

    const handleSend = async (e, prefillText) => {
        if (e) e.preventDefault();
        const text = prefillText || inputText;
        if (!text.trim()) return;

        // Smooth cross-fade out of welcome screen
        if (showWelcome) exitWelcome(); else setShowWelcome(false);

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
        }
        setIsTyping(true);

        // Smart handoff: frustration signal → show proactive offer button
        // Keyword-based handoff intent is now detected server-side via suggest_handoff flag
        if (detectFrustration()) {
            setShowProminentHandoff(true);
        }

        try {
            // placeholderId is null until the first token arrives.
            // The TypingIndicator (isTyping=true) stays visible the whole time the
            // bot is "thinking" — it's hidden only when the first chunk is received
            // and the streaming placeholder message is created.
            let placeholderId = null;

            // Reset RAF buffer before each new stream
            chunkBufferRef.current = '';
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }

            await sendMessageStream(userMsg.text, sessionId, {
                onMetadata: (metadata) => {
                    if (metadata.session_id && metadata.session_id !== sessionId) {
                        setSessionId(metadata.session_id);
                        localStorage.setItem('chat_session_id', metadata.session_id);
                    }
                },
                onChunk: (chunk) => {
                    if (placeholderId === null) {
                        // First token — swap TypingIndicator for the streaming message
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
                    // Subsequent tokens — accumulate and flush once per animation frame
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
                            msg.id === placeholderId
                                ? { ...msg, id: finalMeta.message_id }
                                : msg
                        ));
                        setStreamingId(finalMeta.message_id);
                    }
                    // Auto-trigger handoff when backend LLM detected human request intent
                    if (finalMeta.suggest_handoff && !handoffTriggeredRef.current) {
                        handoffTriggeredRef.current = true;
                        // Short delay so user reads the AI's warm response before the form appears
                        setTimeout(() => {
                            triggerHandoff();
                            handoffTriggeredRef.current = false;
                        }, 600);
                    }
                },
                onError: () => {
                    setIsTyping(false);
                    if (placeholderId !== null) {
                        setMessages(prev => prev.map(msg =>
                            msg.id === placeholderId && !msg.text
                                ? { ...msg, text: "I'm sorry, I couldn't generate a response. Please try again." }
                                : msg
                        ));
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

            // Flush any tokens still buffered in the RAF queue before removing cursor
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            if (chunkBufferRef.current && placeholderId !== null) {
                const remaining = chunkBufferRef.current;
                chunkBufferRef.current = '';
                setMessages(prev => prev.map(msg =>
                    msg.id === placeholderId
                        ? { ...msg, text: msg.text + remaining }
                        : msg
                ));
            }

            setIsTyping(false);
            // Stream complete — stop showing cursor
            setStreamingId(null);

            // Smart handoff: track consecutive fallback responses
            // 1st fallback → show prominent button; 2nd+ consecutive → auto-trigger form
            setMessages(prev => {
                // Reverse scan to find the last bot message; Array.find() returns the first match
                const lastBot = [...prev].reverse().find(msg => msg.sender === 'bot');
                if (lastBot && checkBotFallback(lastBot.text)) {
                    consecutiveFallbacks.current += 1;
                    if (consecutiveFallbacks.current >= 2 && !handoffTriggeredRef.current) {
                        handoffTriggeredRef.current = true;
                        consecutiveFallbacks.current = 0;
                        setTimeout(() => {
                            triggerHandoff();
                            handoffTriggeredRef.current = false;
                        }, 600);
                    } else if (consecutiveFallbacks.current === 1) {
                        setShowProminentHandoff(true);
                    }
                } else {
                    consecutiveFallbacks.current = 0; // good answer — reset counter
                }
                return prev;
            });

        } catch (error) {
            console.error("Failed to get response:", error);
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

    // Handle lead form submission
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

    // Handle handoff form submission (debounced to prevent duplicate requests)
    const [isSubmittingHandoff, setIsSubmittingHandoff] = useState(false);
    const handleHandoffSubmit = async (formData) => {
        if (isSubmittingHandoff) return;
        setIsSubmittingHandoff(true);
        try {
            await requestHandoff(sessionId, formData);
            setChatMode('waiting');
        } finally {
            setIsSubmittingHandoff(false);
        }
    };

    // Trigger handoff (called from a button or auto-detected)
    const triggerHandoff = () => {
        // Ensure we have a session for the handoff
        if (!sessionId) {
            const newSession = `session_${crypto.randomUUID()}`;
            setSessionId(newSession);
            localStorage.setItem('chat_session_id', newSession);
        }
        if (showWelcome) {
            // Welcome → handoff: fade out welcome content, then switch mode
            exitWelcome();
            setTimeout(() => setChatMode('handoff_form'), WELCOME_EXIT_DURATION);
        } else {
            setChatMode('handoff_form');
        }
    };

    // --- Smart handoff emphasis logic ---
    // Note: keyword-based handoff intent detection is handled server-side via suggest_handoff flag
    const FALLBACK_PATTERNS = /connect.*with.*(team|support|human)|don't have that specific information|I'm not sure about that|couldn't find.*information|not contained in/i;

    // Detect frustration: 3+ user messages within 30 seconds
    const detectFrustration = useCallback(() => {
        const now = Date.now();
        recentMessageTimestamps.current = recentMessageTimestamps.current.filter(t => now - t < 30000);
        recentMessageTimestamps.current.push(now);
        return recentMessageTimestamps.current.length >= 3;
    }, []);

    // Check if latest bot response is a fallback / low-confidence answer
    const checkBotFallback = useCallback((botText) => {
        return FALLBACK_PATTERNS.test(botText);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Add message from live chat back to main messages (for transition messages)
    const handleLiveChatMessage = (msg) => {
        setMessages(prev => [...prev, msg]);
        setChatMode('bot');
    };

    // Render based on chat mode
    const isLiveMode = ['handoff_form', 'waiting', 'live', 'unavailable'].includes(chatMode);

    // Lead capture form (shown before welcome for new visitors)
    if (showLeadForm) {
        return (
            <LeadCaptureForm
                settings={settings}
                currentTheme={currentTheme}
                onClose={onClose}
                onSubmit={handleLeadFormSubmit}
                isAnimating={isAnimating}
            />
        );
    }

    // Welcome screen — slides up smoothly when exiting (same bg, no black flash)
    if (showWelcome) {
        return (
            <WelcomeScreen
                settings={settings}
                currentTheme={currentTheme}
                onClose={onClose}
                onSend={handleSend}
                inputText={inputText}
                setInputText={setInputText}
                inputRef={inputRef}
                isAnimating={welcomeExiting ? 'done' : isAnimating}
                welcomeExiting={welcomeExiting}
                exitDuration={WELCOME_EXIT_DURATION}
                onTalkToHuman={settings.live_chat_enabled !== false ? triggerHandoff : undefined}
            />
        );
    }

    // Dynamic header content based on chat mode (compact 32px avatars)
    const renderHeader = () => {
        if (chatMode === 'waiting') {
            return (
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                        <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                    <h3 className="font-semibold text-sm text-[#16202C]">Connecting to support...</h3>
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
        // Default: bot mode — timestamp as status bar (identity shown via floating agent badge)
        return (
            <span className="text-[11px] text-gray-400 font-medium tracking-wide">
                {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} &middot; {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
        );
    };

    // Floating glass agent badge — shows who you're chatting with
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

    return (
        <div ref={containerRef} className={`${currentTheme.container} ${isAnimating === true ? 'widget-open' : isAnimating === false ? 'widget-close' : isAnimating === 'done' ? 'widget-visible' : 'widget-hidden'}`}>
            {/* Header — minimal in bot mode (just icons), contextual in other modes */}
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
                    {/* Three-dot menu */}
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

                    {/* Dropdown menu */}
                    {showHeaderMenu && (
                        <div className="absolute top-full right-0 mt-1 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-50 min-w-[180px]" style={{ animation: 'fadeUp 0.15s ease-out' }}>
                            <button
                                onClick={handleSendTranscript}
                                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-[#16202C] hover:bg-gray-50 transition-colors"
                            >
                                <Mail className="w-4 h-4 text-gray-400" />
                                Send transcript
                            </button>
                            <button
                                onClick={toggleSounds}
                                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-[#16202C] hover:bg-gray-50 transition-colors"
                            >
                                <Volume2 className="w-4 h-4 text-gray-400" />
                                <span className="flex-1 text-left">Sounds</span>
                                {/* Toggle switch */}
                                <div className={`w-9 h-5 rounded-full relative transition-colors duration-200 ${soundsEnabled ? 'bg-green-500' : 'bg-gray-300'}`}>
                                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${soundsEnabled ? 'left-[18px]' : 'left-0.5'}`} />
                                </div>
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Floating glass agent badge — overlaps header bottom edge for premium feel */}
            {!isInitializing && !showWelcome && (chatMode === 'bot' || (chatMode === 'live' && operatorName)) && (
                <div className="shrink-0 flex justify-center -mb-5 relative z-30" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    {renderAgentBadge()}
                </div>
            )}

            {/* Content — keyed by chatMode so each mode switch triggers enter animation */}
            <div key={chatMode} className="mode-enter flex flex-col flex-1 overflow-hidden relative">

            {/* Handoff form */}
            {chatMode === 'handoff_form' ? (
                <HandoffForm
                    settings={settings}
                    onSubmit={handleHandoffSubmit}
                    onCancel={() => setChatMode('bot')}
                    existingLeadInfo={existingLeadInfo}
                />
            ) : isLiveMode ? (
                /* Live chat / waiting / unavailable modes */
                <LiveChatMode
                    sessionId={sessionId}
                    settings={settings}
                    chatMode={chatMode}
                    setChatMode={setChatMode}
                    setOperatorName={setOperatorName}
                    setOperatorDepartment={setOperatorDepartment}
                    onNewMessage={handleLiveChatMessage}
                    botMessages={messages.slice(-5)}
                    onConnectionStatusChange={setLiveConnectionStatus}
                />
            ) : (
                /* Normal bot chat mode */
                <>
                    <div className={currentTheme.messagesArea} style={{
                        backgroundColor: (settings.background_color && settings.background_color !== '#ffffff') ? settings.background_color : undefined,
                        paddingTop: !isInitializing ? 24 : undefined,
                    }}>
                        {isInitializing ? (
                            <div className="flex-1 flex flex-col items-center justify-center gap-3">
                                <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
                                <p className="text-gray-500 font-medium animate-pulse text-sm">Starting new chat...</p>
                            </div>
                        ) : (
                            <>
                                {messages.map((msg) => (
                                    <MessageBubble
                                        key={msg.id}
                                        msg={msg}
                                        currentTheme={currentTheme}
                                        settings={settings}
                                        streamingId={streamingId}
                                    />
                                ))}

                                {isTyping && <TypingIndicator settings={settings} />}
                                <div ref={messagesEndRef} />
                            </>
                        )}
                    </div>

                    {/* Input area — branding moved inside ChatInput's action bar */}
                    <ChatInput
                        inputText={inputText}
                        setInputText={setInputText}
                        onSubmit={handleSend}
                        isTyping={isTyping}
                        settings={settings}
                        currentTheme={currentTheme}
                        inputRef={inputRef}
                        onHandoff={!isInitializing && settings.live_chat_enabled !== false ? triggerHandoff : undefined}
                        showProminentHandoff={showProminentHandoff}
                        primaryColor={settings.primary_color}
                        showBranding={settings?.feature_flags?.show_branding !== false}
                    />
                </>
            )}

            </div>{/* end mode-enter content wrapper */}
        </div>
    );
};

export default ChatWindow;
