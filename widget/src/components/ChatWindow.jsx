import React, { useState, useEffect, useRef } from 'react';
import { X, Plus } from 'lucide-react';
import { sendMessage, getChatHistory, submitFeedback } from '../services/api';
import { themeConfigs } from './themeConfigs';
import BotAvatar from './BotAvatar';
import MessageBubble from './MessageBubble';
import TypingIndicator from './TypingIndicator';
import ChatInput from './ChatInput';
import WelcomeScreen from './WelcomeScreen';

const ChatWindow = ({ onClose, theme = 'classic', initialSettings }) => {
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
    const [streamingId, setStreamingId] = useState(null);
    const [isReturningUser, setIsReturningUser] = useState(false);

    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

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

        try {
            const data = await sendMessage(userMsg.text, sessionId);

            if (data.session_id && data.session_id !== sessionId) {
                setSessionId(data.session_id);
                localStorage.setItem('chat_session_id', data.session_id);
            }

            const botMsgId = data.message_id || Date.now();
            const botMsg = {
                id: botMsgId,
                text: data.answer || "I'm sorry, I couldn't generate a response.",
                sender: 'bot',
                timestamp: new Date().toISOString(),
                feedback: null
            };

            setStreamingId(botMsgId);
            setMessages(prev => [...prev, botMsg]);
            setIsTyping(false);

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
            />
        );
    }

    return (
        <div className={currentTheme.container}>
            {/* Header — clean white, matches Figma */}
            <div className={currentTheme.header}>
                <div className="flex items-center gap-3">
                    <BotAvatar settings={settings} size="md" />
                    <h3 className="font-semibold text-sm text-[#16202C]">{settings.bot_name}</h3>
                </div>
                <div className="flex items-center gap-2">
                    {(isReturningUser || messages.filter(m => m.sender === 'user').length > 0) && (
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

            {/* Messages */}
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

                        {isTyping && (
                            <TypingIndicator />
                        )}

                        <div ref={messagesEndRef} />
                    </>
                )}
            </div>

            {/* Input */}
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
    );
};

export default ChatWindow;
