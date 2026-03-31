import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Plus } from 'lucide-react';
import { sendMessageStream, getChatHistory, submitFeedback, submitLeadCapture, requestHandoff } from '../services/api';
import { themeConfigs } from './themeConfigs';
import BotAvatar from './BotAvatar';
import MessageBubble from './MessageBubble';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';
import LeadCaptureForm from './LeadCaptureForm';
import HandoffForm from './HandoffForm';
import LiveChatMode from './LiveChatMode';

const ChatWindow = ({ onClose, theme = 'classic', initialSettings, isAnimating = true }) => {
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
    const [copiedId, setCopiedId] = useState(null);
    const [sessionId, setSessionId] = useState(() => localStorage.getItem('chat_session_id'));
    const [showWelcome, setShowWelcome] = useState(true);
    const [showLeadForm, setShowLeadForm] = useState(false);
    const [chatMode, setChatMode] = useState('bot'); // bot|handoff_form|waiting|live|unavailable
    const [agentName, setAgentName] = useState(null);
    const [streamingId, setStreamingId] = useState(null);
    const [isReturningUser, setIsReturningUser] = useState(false);
    const [showProminentHandoff, setShowProminentHandoff] = useState(false);

    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const recentMessageTimestamps = useRef([]);

    const currentTheme = themeConfigs[theme] || themeConfigs.classic;

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
            const botKey = window.OYECHAT_BOT_KEY || window.OYECHAT_API_KEY || 'default';
            const leadCapturedKey = `oyechat_lead_captured_${botKey}`;
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
            }
            setIsInitializing(false);
        };

        initChat();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, isTyping]);

    const handleNewChat = () => {
        setIsInitializing(true);
        localStorage.removeItem('chat_session_id');
        const newSession = `session_${Date.now()}`;
        setSessionId(newSession);
        localStorage.setItem('chat_session_id', newSession);
        setShowWelcome(true);
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

        setShowWelcome(false);

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

        // Smart handoff: detect frustration or keywords in user message
        if (detectFrustration() || checkHandoffKeywords(text)) {
            setShowProminentHandoff(true);
        }

        try {
            // Create a placeholder bot message for progressive rendering
            const placeholderId = Date.now() + 1;
            const botMsg = {
                id: placeholderId,
                text: '',
                sender: 'bot',
                timestamp: new Date().toISOString(),
                feedback: null
            };

            setMessages(prev => [...prev, botMsg]);
            setStreamingId(placeholderId);
            setIsTyping(false);

            await sendMessageStream(userMsg.text, sessionId, {
                onMetadata: (metadata) => {
                    if (metadata.session_id && metadata.session_id !== sessionId) {
                        setSessionId(metadata.session_id);
                        localStorage.setItem('chat_session_id', metadata.session_id);
                    }
                },
                onChunk: (chunk) => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === placeholderId
                            ? { ...msg, text: msg.text + chunk }
                            : msg
                    ));
                },
                onFinalMetadata: (finalMeta) => {
                    if (finalMeta.message_id) {
                        setMessages(prev => prev.map(msg =>
                            msg.id === placeholderId
                                ? { ...msg, id: finalMeta.message_id }
                                : msg
                        ));
                        setStreamingId(finalMeta.message_id);
                    }
                },
                onError: () => {
                    setMessages(prev => prev.map(msg =>
                        msg.id === placeholderId && !msg.text
                            ? { ...msg, text: "I'm sorry, I couldn't generate a response. Please try again." }
                            : msg
                    ));
                }
            });

            // Smart handoff: detect fallback/low-confidence bot response
            setMessages(prev => {
                const lastBot = prev.find(msg => msg.id === placeholderId || msg.sender === 'bot');
                if (lastBot && checkBotFallback(lastBot.text)) {
                    setShowProminentHandoff(true);
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

    const handleCopy = (text, id) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const handleFeedback = async (id, type) => {
        const currentMsg = messages.find(m => m.id === id);
        if (!currentMsg) return;

        const newFeedback = currentMsg.feedback === type ? null : type;

        setMessages(prev => prev.map(msg =>
            msg.id === id ? { ...msg, feedback: newFeedback } : msg
        ));

        if (typeof id === 'number' && id < 1000000000) {
            try {
                const feedbackValue = newFeedback === 'like' ? 1 : (newFeedback === 'dislike' ? -1 : null);
                if (feedbackValue !== null) {
                    await submitFeedback(id, feedbackValue);
                }
            } catch (error) {
                console.error("Feedback failed to save", error);
            }
        }
    };

    // Handle lead form submission
    const handleLeadFormSubmit = async (formData) => {
        const newSessionId = sessionId || `session_${Date.now()}`;
        if (!sessionId) {
            setSessionId(newSessionId);
            localStorage.setItem('chat_session_id', newSessionId);
        }
        await submitLeadCapture(newSessionId, formData);
        const botKey = window.OYECHAT_BOT_KEY || window.OYECHAT_API_KEY || 'default';
        localStorage.setItem(`oyechat_lead_captured_${botKey}`, 'true');
        setShowLeadForm(false);
        setShowWelcome(true);
    };

    // Handle handoff form submission
    const handleHandoffSubmit = async (formData) => {
        await requestHandoff(sessionId, formData);
        setChatMode('waiting');
    };

    // Trigger handoff (called from a button or auto-detected)
    const triggerHandoff = () => {
        // Ensure we have a session for the handoff
        if (!sessionId) {
            const newSession = `session_${Date.now()}`;
            setSessionId(newSession);
            localStorage.setItem('chat_session_id', newSession);
        }
        setShowWelcome(false);
        setChatMode('handoff_form');
    };

    // --- Smart handoff emphasis logic ---
    const HANDOFF_KEYWORDS = /\b(human|agent|speak to someone|real person|support|talk to a person|representative|help me)\b/i;
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

    // Check user input for handoff keywords
    const checkHandoffKeywords = useCallback((text) => {
        return HANDOFF_KEYWORDS.test(text);
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

    // Welcome screen
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
                isAnimating={isAnimating}
                onTalkToHuman={settings.live_chat_enabled !== false ? triggerHandoff : undefined}
            />
        );
    }

    // Dynamic header content based on chat mode
    const renderHeader = () => {
        if (chatMode === 'waiting') {
            return (
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
                        <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                    <h3 className="font-semibold text-sm text-[#16202C]">Connecting to support...</h3>
                </div>
            );
        }
        if (chatMode === 'live' && agentName) {
            return (
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-sm">
                            {agentName.charAt(0).toUpperCase()}
                        </div>
                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-white" />
                    </div>
                    <div>
                        <h3 className="font-semibold text-sm text-[#16202C]">{agentName}</h3>
                        <p className="text-[10px] text-green-600 font-medium">Online</p>
                    </div>
                </div>
            );
        }
        if (chatMode === 'unavailable') {
            return (
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-400">
                        <span className="text-sm">⏸</span>
                    </div>
                    <h3 className="font-semibold text-sm text-gray-500">Support Unavailable</h3>
                </div>
            );
        }
        // Default: bot mode
        return (
            <div className="flex items-center gap-3">
                <BotAvatar settings={settings} size="md" />
                <h3 className="font-semibold text-sm text-[#16202C]">{settings.bot_name}</h3>
            </div>
        );
    };

    return (
        <div className={`${currentTheme.container} ${isAnimating === true ? 'widget-open' : isAnimating === false ? 'widget-close' : isAnimating === 'done' ? 'widget-visible' : 'widget-hidden'}`}>
            {/* Header — dynamic based on chat mode */}
            <div className={currentTheme.header}>
                {renderHeader()}
                <div className="flex items-center gap-2">
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
                        onClick={onClose}
                        className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                        title="Close"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
            </div>

            {/* Handoff form */}
            {chatMode === 'handoff_form' ? (
                <HandoffForm
                    settings={settings}
                    onSubmit={handleHandoffSubmit}
                    existingLeadInfo={null}
                />
            ) : isLiveMode ? (
                /* Live chat / waiting / unavailable modes */
                <LiveChatMode
                    sessionId={sessionId}
                    settings={settings}
                    chatMode={chatMode}
                    setChatMode={setChatMode}
                    setAgentName={setAgentName}
                    onNewMessage={handleLiveChatMessage}
                />
            ) : (
                /* Normal bot chat mode */
                <>
                    <div className={currentTheme.messagesArea} style={{ backgroundColor: settings.background_color }}>
                        {isInitializing ? (
                            <div className="flex-1 flex flex-col items-center justify-center gap-3">
                                <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
                                <p className="text-gray-500 font-medium animate-pulse text-sm">Starting new chat...</p>
                            </div>
                        ) : (
                            <>
                                <div className="text-center">
                                    <span className="inline-block px-3 rounded-full text-xs" style={{ backgroundColor: 'rgba(0,0,0,0.05)', color: '#999' }}>
                                        {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} &middot; {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>

                                {messages.map((msg) => (
                                    <MessageBubble
                                        key={msg.id}
                                        msg={msg}
                                        theme={theme}
                                        currentTheme={currentTheme}
                                        settings={settings}
                                        streamingId={streamingId}
                                        setStreamingId={setStreamingId}
                                        copiedId={copiedId}
                                        onCopy={handleCopy}
                                        onFeedback={handleFeedback}
                                    />
                                ))}

                                {isTyping && <TypingIndicator />}
                                <div ref={messagesEndRef} />
                            </>
                        )}
                    </div>

                    {/* Input + Connect with support button */}
                    <div>
                        {!isInitializing && chatMode === 'bot' && settings.live_chat_enabled !== false && (
                            <div className="px-3 pb-1">
                                <button
                                    onClick={triggerHandoff}
                                    className={`w-full py-2 text-[12px] font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                                        showProminentHandoff
                                            ? 'text-white shadow-sm'
                                            : 'text-gray-400 hover:text-indigo-600 hover:bg-indigo-50'
                                    }`}
                                    style={showProminentHandoff ? { backgroundColor: settings.primary_color || '#3A0CA3' } : undefined}
                                >
                                    {showProminentHandoff ? '🙋 Talk to a human' : '💬 Talk to a human'}
                                </button>
                            </div>
                        )}
                        <ChatInput
                            inputText={inputText}
                            setInputText={setInputText}
                            onSubmit={handleSend}
                            isTyping={isTyping}
                            settings={settings}
                            currentTheme={currentTheme}
                            inputRef={inputRef}
                        />
                    </div>
                </>
            )}
        </div>
    );
};

export default ChatWindow;
