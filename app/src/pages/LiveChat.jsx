import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Headphones, Send, X, User, Mail, MapPin, Monitor, Target, MessageCircle, Loader2, Circle } from 'lucide-react';
import { getAgentQueue, acceptChat, closeAgentChat, toggleAgentStatus, getChatHistory } from '../services/api';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { useBotContext } from '../context/BotContext';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

export default function LiveChat() {
    const { bots, loading: botsLoading } = useBotContext();
    const [isOnline, setIsOnline] = useState(false);
    const [agentName, setAgentName] = useState('');
    const [queue, setQueue] = useState([]);
    const [activeChats, setActiveChats] = useState([]);
    const [selectedChat, setSelectedChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [ws, setWs] = useState(null);
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

    // Fetch queue on mount and periodically
    const fetchQueue = useCallback(async () => {
        try {
            const data = await getAgentQueue();
            setQueue(data.queue || []);
        } catch (err) {
            console.error('Failed to fetch queue:', err);
        }
    }, []);

    const playNotification = useCallback(() => {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.3);
        } catch { /* ignore audio errors */ }
    }, []);

    // WebSocket connection
    useEffect(() => {
        const apiKey = localStorage.getItem('admin_token');
        if (!apiKey || !isOnline) return;

        const wsUrl = API_URL.replace(/^http/, 'ws');
        const socket = new WebSocket(`${wsUrl}/ws/agent?api_key=${apiKey}`);

        socket.onopen = () => {
            console.log('[LiveChat] Agent WebSocket connected');
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'queue_update':
                    fetchQueue();
                    break;
                case 'message':
                    if (data.session_id === selectedChat) {
                        setMessages(prev => [...prev, {
                            id: Date.now(),
                            role: data.role,
                            content: data.content,
                            timestamp: data.timestamp,
                        }]);
                        setIsTyping(false);
                    }
                    // Play notification sound for new messages
                    if (data.role === 'user') playNotification();
                    break;
                case 'visitor_typing':
                    if (data.session_id === selectedChat) {
                        setIsTyping(true);
                        setTimeout(() => setIsTyping(false), 3000);
                    }
                    break;
                case 'chat_accepted':
                    setActiveChats(prev => [...new Set([...prev, data.session_id])]);
                    fetchQueue();
                    break;
                case 'chat_closed':
                    setActiveChats(prev => prev.filter(id => id !== data.session_id));
                    if (selectedChat === data.session_id) {
                        setSelectedChat(null);
                        setMessages([]);
                    }
                    break;
            }
        };

        socket.onclose = () => console.log('[LiveChat] Agent WebSocket closed');

        setWs(socket); // eslint-disable-line react-hooks/set-state-in-effect -- storing WebSocket ref from external subscription
        return () => socket.close();
    }, [isOnline, selectedChat, fetchQueue, playNotification]);

    useEffect(() => {
        if (isOnline) {
            fetchQueue(); // eslint-disable-line react-hooks/set-state-in-effect -- initial fetch on mount
            const interval = setInterval(fetchQueue, 10000);
            return () => clearInterval(interval);
        }
    }, [isOnline, fetchQueue]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isTyping]);

    const handleToggleStatus = async () => {
        try {
            const result = await toggleAgentStatus();
            setIsOnline(result.is_online);
            setAgentName(result.agent_name);
        } catch (e) {
            console.error('Failed to toggle status:', e);
        }
    };

    const handleAcceptChat = async (sessionId) => {
        try {
            await acceptChat(sessionId);
            setActiveChats(prev => [...new Set([...prev, sessionId])]);
            setSelectedChat(sessionId);
            fetchQueue();
            // Load chat history
            try {
                const history = await getChatHistory(sessionId);
                setMessages(history.map((m, i) => ({
                    id: i,
                    role: m.role,
                    content: m.content,
                    timestamp: m.timestamp,
                })));
            } catch { setMessages([]); }
        } catch (e) {
            console.error('Failed to accept chat:', e);
        }
    };

    const handleSelectChat = async (sessionId) => {
        setSelectedChat(sessionId);
        try {
            const history = await getChatHistory(sessionId);
            setMessages(history.map((m, i) => ({
                id: i,
                role: m.role,
                content: m.content,
                timestamp: m.timestamp,
            })));
        } catch { setMessages([]); }
    };

    const handleCloseChat = async (sessionId) => {
        try {
            await closeAgentChat(sessionId);
            setActiveChats(prev => prev.filter(id => id !== sessionId));
            if (selectedChat === sessionId) {
                setSelectedChat(null);
                setMessages([]);
            }
        } catch (e) {
            console.error('Failed to close chat:', e);
        }
    };

    const handleSend = (e) => {
        e?.preventDefault();
        if (!inputText.trim() || !ws || !selectedChat) return;

        ws.send(JSON.stringify({
            type: 'message',
            session_id: selectedChat,
            content: inputText,
        }));

        setMessages(prev => [...prev, {
            id: Date.now(),
            role: 'agent',
            content: inputText,
            timestamp: new Date().toISOString(),
        }]);

        setInputText('');
        inputRef.current?.focus();
    };

    const handleAgentTyping = () => {
        if (ws && selectedChat) {
            ws.send(JSON.stringify({ type: 'typing', session_id: selectedChat }));
        }
    };

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Live Chat" description="Create a chatbot first to enable live support." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    return (
        <div className="space-y-4 animate-fade-in h-[calc(100vh-120px)]">
            <div className="flex items-center justify-between">
                <PageHeader title="Live Chat" subtitle="Chat with visitors in real-time" />
                <div className="flex items-center gap-3">
                    {agentName && <span className="text-sm text-secondary-500 dark:text-secondary-400">{agentName}</span>}
                    <button
                        onClick={handleToggleStatus}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                            isOnline
                                ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700 text-green-700 dark:text-green-400'
                                : 'bg-secondary-50 dark:bg-secondary-800 border-secondary-200 dark:border-secondary-700 text-secondary-600 dark:text-secondary-400'
                        }`}
                    >
                        <Circle className={`w-3 h-3 ${isOnline ? 'fill-green-500 text-green-500' : 'fill-secondary-300 text-secondary-300'}`} />
                        {isOnline ? 'Online' : 'Offline'}
                    </button>
                </div>
            </div>

            {!isOnline ? (
                <div className="flex flex-col items-center justify-center h-96 text-center">
                    <div className="w-16 h-16 rounded-full bg-secondary-100 dark:bg-secondary-800 flex items-center justify-center mb-4">
                        <Headphones className="w-8 h-8 text-secondary-400" />
                    </div>
                    <h3 className="text-lg font-bold text-secondary-900 dark:text-white mb-2">You're offline</h3>
                    <p className="text-sm text-secondary-500 dark:text-secondary-400 max-w-sm mb-4">
                        Go online to start receiving live chat requests from visitors.
                    </p>
                    <button
                        onClick={handleToggleStatus}
                        className="px-6 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-medium hover:bg-primary-700 transition-colors"
                    >
                        Go Online
                    </button>
                </div>
            ) : (
                <div className="flex gap-4 h-full">
                    {/* Left: Queue + Active Chats */}
                    <div className="w-72 flex-shrink-0 bg-white dark:bg-secondary-800 rounded-2xl border border-secondary-200 dark:border-secondary-700 overflow-hidden flex flex-col">
                        {/* Waiting Queue */}
                        {queue.length > 0 && (
                            <div className="border-b border-secondary-200 dark:border-secondary-700">
                                <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/20">
                                    <h4 className="text-[12px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                                        Waiting ({queue.length})
                                    </h4>
                                </div>
                                {queue.map(item => (
                                    <div key={item.session_id} className="px-4 py-3 border-b border-secondary-100 dark:border-secondary-700/50 hover:bg-secondary-50 dark:hover:bg-secondary-700/30">
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="text-sm font-medium text-secondary-900 dark:text-white truncate">
                                                {item.name || 'Anonymous'}
                                            </span>
                                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                                        </div>
                                        {item.reason && <p className="text-[11px] text-secondary-500 truncate mb-2">{item.reason}</p>}
                                        <button
                                            onClick={() => handleAcceptChat(item.session_id)}
                                            className="w-full py-1.5 bg-primary-600 text-white text-[12px] font-medium rounded-lg hover:bg-primary-700 transition-colors"
                                        >
                                            Accept
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Active Chats */}
                        <div className="flex-1 overflow-y-auto">
                            <div className="px-4 py-3">
                                <h4 className="text-[12px] font-bold uppercase tracking-wider text-secondary-500">
                                    Active ({activeChats.length})
                                </h4>
                            </div>
                            {activeChats.length === 0 ? (
                                <div className="px-4 py-8 text-center text-sm text-secondary-400">
                                    No active chats
                                </div>
                            ) : (
                                activeChats.map(sid => (
                                    <button
                                        key={sid}
                                        onClick={() => handleSelectChat(sid)}
                                        className={`w-full px-4 py-3 text-left border-b border-secondary-100 dark:border-secondary-700/50 transition-colors ${
                                            selectedChat === sid
                                                ? 'bg-primary-50 dark:bg-primary-900/20 border-l-2 border-l-primary-500'
                                                : 'hover:bg-secondary-50 dark:hover:bg-secondary-700/30'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm font-medium text-secondary-900 dark:text-white truncate">
                                                {sid.substring(0, 16)}...
                                            </span>
                                            <span className="w-2 h-2 rounded-full bg-green-500" />
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>
                    </div>

                    {/* Center: Chat Panel */}
                    <div className="flex-1 bg-white dark:bg-secondary-800 rounded-2xl border border-secondary-200 dark:border-secondary-700 overflow-hidden flex flex-col">
                        {selectedChat ? (
                            <>
                                {/* Chat Header */}
                                <div className="px-4 py-3 border-b border-secondary-200 dark:border-secondary-700 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center">
                                            <User className="w-4 h-4 text-primary-600" />
                                        </div>
                                        <div>
                                            <h4 className="text-sm font-semibold text-secondary-900 dark:text-white">Visitor</h4>
                                            <p className="text-[11px] text-green-600">Connected</p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleCloseChat(selectedChat)}
                                        className="px-3 py-1.5 text-[12px] font-medium text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg hover:bg-red-100 transition-colors"
                                    >
                                        End Chat
                                    </button>
                                </div>

                                {/* Messages */}
                                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                                    {messages.map((msg) => (
                                        <div key={msg.id} className={`flex ${msg.role === 'agent' ? 'justify-end' : 'justify-start'}`}>
                                            <div className={`max-w-[75%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                                                msg.role === 'agent'
                                                    ? 'bg-primary-600 text-white rounded-br-md'
                                                    : msg.role === 'user'
                                                    ? 'bg-secondary-100 dark:bg-secondary-700 text-secondary-800 dark:text-secondary-200 rounded-bl-md'
                                                    : 'bg-secondary-50 dark:bg-secondary-800 text-secondary-600 italic text-xs rounded-bl-md'
                                            }`}>
                                                {msg.content}
                                            </div>
                                        </div>
                                    ))}
                                    {isTyping && (
                                        <div className="flex justify-start">
                                            <div className="bg-secondary-100 dark:bg-secondary-700 px-4 py-3 rounded-2xl rounded-bl-md">
                                                <div className="flex gap-1.5">
                                                    <span className="w-2 h-2 bg-secondary-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                    <span className="w-2 h-2 bg-secondary-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                    <span className="w-2 h-2 bg-secondary-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                    <div ref={messagesEndRef} />
                                </div>

                                {/* Input */}
                                <div className="border-t border-secondary-200 dark:border-secondary-700 px-4 py-3">
                                    <form onSubmit={handleSend} className="flex items-center gap-2">
                                        <input
                                            ref={inputRef}
                                            type="text"
                                            value={inputText}
                                            onChange={(e) => { setInputText(e.target.value); handleAgentTyping(); }}
                                            placeholder="Type your reply..."
                                            className="flex-1 px-4 py-2.5 text-sm bg-secondary-50 dark:bg-secondary-900 rounded-xl outline-none border border-transparent focus:border-primary-300 transition-colors"
                                        />
                                        <button
                                            type="submit"
                                            disabled={!inputText.trim()}
                                            className="w-10 h-10 flex items-center justify-center bg-primary-600 text-white rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-30"
                                        >
                                            <Send className="w-4 h-4" />
                                        </button>
                                    </form>
                                </div>
                            </>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
                                <div className="w-16 h-16 rounded-full bg-secondary-100 dark:bg-secondary-700 flex items-center justify-center mb-4">
                                    <MessageCircle className="w-8 h-8 text-secondary-400" />
                                </div>
                                <h3 className="text-lg font-bold text-secondary-900 dark:text-white mb-2">No chat selected</h3>
                                <p className="text-sm text-secondary-500 dark:text-secondary-400">
                                    {queue.length > 0
                                        ? 'Accept a waiting chat from the queue on the left.'
                                        : 'Waiting for visitors to request live support...'}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
