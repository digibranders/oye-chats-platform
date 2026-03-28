import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Send, User, Mail, MessageSquare, ArrowRight, CheckCircle2 } from 'lucide-react';
import { submitOfflineMessage } from '../services/api';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const LiveChatMode = ({ sessionId, settings, chatMode, setChatMode, setAgentName, onNewMessage }) => {
    const [ws, setWs] = useState(null);
    const [inputText, setInputText] = useState('');
    const [messages, setMessages] = useState([]);
    const [isAgentTyping, setIsAgentTyping] = useState(false);
    const [queuePosition, setQueuePosition] = useState(null);
    const [offlineForm, setOfflineForm] = useState({ name: '', email: '', message: '' });
    const [offlineSubmitted, setOfflineSubmitted] = useState(false);
    const [offlineSubmitting, setOfflineSubmitting] = useState(false);
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(() => {
        if (!sessionId) return;

        const botKey = window.OYECHAT_BOT_KEY || window.OYECHAT_API_KEY || '';
        const wsUrl = API_URL.replace(/^http/, 'ws');
        const socket = new WebSocket(`${wsUrl}/ws/chat/${sessionId}?bot_key=${botKey}`);

        socket.onopen = () => {
            console.log('[OyeChat] Live chat WebSocket connected');
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'status':
                    if (data.status === 'waiting') {
                        setChatMode('waiting');
                        setQueuePosition(data.queue_position || null);
                    } else if (data.status === 'connected') {
                        setChatMode('live');
                        setAgentName(data.agent_name || 'Support');
                    } else if (data.status === 'closed') {
                        setChatMode('bot');
                        setAgentName(null);
                        onNewMessage({
                            id: Date.now(),
                            text: `You're now chatting with ${data.bot_name || 'AI Assistant'} again. Feel free to continue asking questions!`,
                            sender: 'bot',
                            timestamp: new Date().toISOString(),
                            feedback: null,
                        });
                    } else if (data.status === 'unavailable') {
                        setChatMode('unavailable');
                    }
                    break;

                case 'message': {
                    setIsAgentTyping(false);
                    const msg = {
                        id: Date.now(),
                        text: data.content,
                        sender: data.role === 'agent' ? 'agent' : 'user',
                        agentName: data.agent_name,
                        timestamp: data.timestamp || new Date().toISOString(),
                    };
                    setMessages(prev => [...prev, msg]);
                    break;
                }

                case 'agent_typing':
                    setIsAgentTyping(true);
                    setTimeout(() => setIsAgentTyping(false), 3000);
                    break;
            }
        };

        socket.onclose = () => {
            console.log('[OyeChat] Live chat WebSocket closed');
        };

        setWs(socket);
        return () => socket.close();
    }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isAgentTyping]);

    const handleSend = (e) => {
        e?.preventDefault();
        if (!inputText.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;

        ws.send(JSON.stringify({ type: 'message', content: inputText }));

        setMessages(prev => [...prev, {
            id: Date.now(),
            text: inputText,
            sender: 'user',
            timestamp: new Date().toISOString(),
        }]);

        setInputText('');
        inputRef.current?.focus();
    };

    const handleTyping = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'typing' }));
        }
    };

    const handleOfflineSubmit = async (e) => {
        e.preventDefault();
        setOfflineSubmitting(true);
        try {
            await submitOfflineMessage({
                name: offlineForm.name,
                email: offlineForm.email,
                message: offlineForm.message,
                session_id: sessionId,
            });
            setOfflineSubmitted(true);
        } catch {
            // Still show success to avoid frustrating the user
            setOfflineSubmitted(true);
        } finally {
            setOfflineSubmitting(false);
        }
    };

    const handleReturnToBot = () => {
        setChatMode('bot');
        setAgentName(null);
        onNewMessage({
            id: Date.now(),
            text: "Thanks for your message! We'll get back to you soon. In the meantime, feel free to ask me anything.",
            sender: 'bot',
            timestamp: new Date().toISOString(),
            feedback: null,
        });
    };

    // Waiting screen
    if (chatMode === 'waiting') {
        return (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-8" style={{ backgroundColor: settings.background_color || '#fff' }}>
                <div className="text-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    <div className="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin mx-auto mb-4" style={{ borderColor: `${settings.primary_color || '#3A0CA3'}40`, borderTopColor: settings.primary_color || '#3A0CA3' }} />
                    <h3 className="text-[#16202C] font-bold text-base mb-1">Connecting you to support...</h3>
                    <p className="text-gray-500 text-sm">
                        {queuePosition ? `You're #${queuePosition} in the queue` : 'Please wait a moment'}
                    </p>
                </div>
                <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
            </div>
        );
    }

    // Unavailable screen with "Leave a Message" form
    if (chatMode === 'unavailable') {
        // Success state
        if (offlineSubmitted) {
            return (
                <div className="flex-1 flex flex-col items-center justify-center px-5 py-6" style={{ backgroundColor: settings.background_color || '#fff' }}>
                    <div className="w-full max-w-sm text-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                            <CheckCircle2 className="w-7 h-7 text-green-600" />
                        </div>
                        <h3 className="text-[#16202C] font-bold text-base mb-2">Message sent!</h3>
                        <p className="text-gray-500 text-sm mb-5">We'll get back to you at <strong>{offlineForm.email}</strong> as soon as possible.</p>
                        <button
                            onClick={handleReturnToBot}
                            className="w-full py-2.5 rounded-xl text-white text-sm font-medium"
                            style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                        >
                            Continue chatting with AI
                        </button>
                    </div>
                    <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
                </div>
            );
        }

        return (
            <div className="flex-1 flex flex-col items-center justify-center px-5 py-6" style={{ backgroundColor: settings.background_color || '#fff' }}>
                <div className="w-full max-w-sm" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    <div className="text-center mb-5">
                        <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-3">
                            <span className="text-2xl">🕐</span>
                        </div>
                        <h3 className="text-[#16202C] font-bold text-base mb-1">Team is currently unavailable</h3>
                        <p className="text-gray-500 text-sm">Leave us a message and we'll get back to you.</p>
                    </div>

                    <form onSubmit={handleOfflineSubmit} className="space-y-3">
                        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2.5">
                            <User className="w-4 h-4 text-gray-400 shrink-0" />
                            <input
                                type="text"
                                placeholder="Your name"
                                required
                                value={offlineForm.name}
                                onChange={(e) => setOfflineForm(prev => ({ ...prev, name: e.target.value }))}
                                className="flex-1 bg-transparent outline-none text-sm"
                            />
                        </div>
                        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2.5">
                            <Mail className="w-4 h-4 text-gray-400 shrink-0" />
                            <input
                                type="email"
                                placeholder="Email address"
                                required
                                value={offlineForm.email}
                                onChange={(e) => setOfflineForm(prev => ({ ...prev, email: e.target.value }))}
                                className="flex-1 bg-transparent outline-none text-sm"
                            />
                        </div>
                        <div className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2.5">
                            <MessageSquare className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
                            <textarea
                                placeholder="How can we help you?"
                                required
                                rows={3}
                                value={offlineForm.message}
                                onChange={(e) => setOfflineForm(prev => ({ ...prev, message: e.target.value }))}
                                className="flex-1 bg-transparent outline-none text-sm resize-none"
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={offlineSubmitting}
                            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white text-sm font-medium disabled:opacity-60"
                            style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                        >
                            {offlineSubmitting ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <>Send Message <ArrowRight className="w-4 h-4" /></>
                            )}
                        </button>
                    </form>
                </div>
                <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
            </div>
        );
    }

    // Live chat messages
    return (
        <>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" style={{ backgroundColor: settings.background_color || '#fff' }}>
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                        <div
                            className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                                msg.sender === 'user'
                                    ? 'bg-[#16202C] text-white rounded-br-md'
                                    : 'bg-gray-100 text-[#16202C] rounded-bl-md'
                            }`}
                        >
                            {msg.sender === 'agent' && msg.agentName && (
                                <p className="text-[10px] font-bold text-gray-500 mb-0.5">{msg.agentName}</p>
                            )}
                            {msg.text}
                        </div>
                    </div>
                ))}

                {isAgentTyping && (
                    <div className="flex justify-start">
                        <div className="bg-gray-100 px-4 py-3 rounded-2xl rounded-bl-md">
                            <div className="flex gap-1.5">
                                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-gray-100 px-3 py-2.5">
                <form onSubmit={handleSend} className="flex items-center gap-2">
                    <input
                        ref={inputRef}
                        type="text"
                        value={inputText}
                        onChange={(e) => { setInputText(e.target.value); handleTyping(); }}
                        placeholder="Type a message..."
                        className="flex-1 px-3 py-2 text-sm bg-gray-50 rounded-xl outline-none focus:bg-white border border-transparent focus:border-gray-200 transition-colors"
                    />
                    <button
                        type="submit"
                        disabled={!inputText.trim()}
                        className="w-9 h-9 flex items-center justify-center rounded-xl transition-all disabled:opacity-30"
                        style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                    >
                        <Send className="w-4 h-4 text-white" />
                    </button>
                </form>
            </div>
        </>
    );
};

export default LiveChatMode;
