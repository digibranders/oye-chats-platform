import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Paperclip, User, Mail, MessageSquare, ArrowRight, CheckCircle2, Phone, Clock, AlertCircle, X } from 'lucide-react';
import SendIcon from './SendIcon';
import { submitOfflineMessage, getChatHistory } from '../services/api';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

const LiveChatMode = ({ sessionId, settings, chatMode, setChatMode, setOperatorName, onNewMessage, botMessages = [], onConnectionStatusChange }) => {
    const [ws, setWs] = useState(null);
    const [inputText, setInputText] = useState('');
    const [messages, setMessages] = useState([]);
    const [isOperatorTyping, setIsOperatorTyping] = useState(false);
    const [queuePosition, setQueuePosition] = useState(null);
    const [showRating, setShowRating] = useState(false);
    const [ratingSubmitting, setRatingSubmitting] = useState(false);
    const [offlineForm, setOfflineForm] = useState({ name: '', email: '', phone: '', message: '' });
    const [offlineSubmitted, setOfflineSubmitted] = useState(false);
    const [offlineSubmitting, setOfflineSubmitting] = useState(false);
    const [isReconnecting, setIsReconnecting] = useState(false);
    const [waitingSeconds, setWaitingSeconds] = useState(0);
    const [offlineError, setOfflineError] = useState(false);
    const [pendingMessages, setPendingMessages] = useState([]); // queued failed messages
    const [showEndConfirm, setShowEndConfirm] = useState(false); // end chat confirmation
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const reconnectAttempt = useRef(0);
    const reconnectTimer = useRef(null);
    const intentionalClose = useRef(false);
    const waitingTimerRef = useRef(null);
    const lastTypingSentRef = useRef(0);
    const msgIdCounter = useRef(0);
    const typingTimeoutRef = useRef(null);
    const historyLoadedRef = useRef(false);
    const sessionStartTime = useRef(new Date());
    const stoppedTypingTimerRef = useRef(null);
    const fileInputRef = useRef(null);
    const [uploadProgress, setUploadProgress] = useState(null); // null | 0–100
    // Pre-send preview: { file, previewUrl, caption, isImage } — null means no pending file
    const [pendingFile, setPendingFile] = useState(null);
    // Lightbox: URL of the image to show full-screen, null = closed
    const [lightboxSrc, setLightboxSrc] = useState(null);

    useEffect(() => {
        if (!sessionId) return;

        const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || '';
        const wsUrl = API_URL.replace(/^http/, 'ws');

        const connect = () => {
            const socket = new WebSocket(`${wsUrl}/ws/chat/${sessionId}?bot_key=${botKey}`);

            socket.onopen = () => {
                console.log('[OyeChats] Live chat WebSocket connected');
                reconnectAttempt.current = 0;
                setIsReconnecting(false);
                // Don't signal 'connected' here — wait for the backend's
                // status: 'connected' message which confirms operator assignment.
            };

            socket.onmessage = (event) => {
                let data;
                try { data = JSON.parse(event.data); } catch { return; }

                switch (data.type) {
                    case 'status':
                        if (data.status === 'waiting') {
                            setChatMode('waiting');
                            setQueuePosition(data.queue_position || null);
                        } else if (data.status === 'connected') {
                            setChatMode('live');
                            setOperatorName(data.operator_name || 'Support');
                            onConnectionStatusChange?.('connected');
                            // On reconnect/refresh, restore chat history from backend
                            // so the visitor doesn't see an empty chat.
                            if (!historyLoadedRef.current) {
                                historyLoadedRef.current = true;
                                getChatHistory(sessionId)
                                    .then(history => {
                                        if (history && history.length > 0) {
                                            const restored = history
                                                .filter(m => m.role === 'user' || m.role === 'operator')
                                                .map((m, i) => ({
                                                    id: `restored-${i}`,
                                                    text: m.content,
                                                    sender: m.role === 'operator' ? 'operator' : 'user',
                                                    operatorName: m.role === 'operator' ? (data.operator_name || 'Support') : undefined,
                                                    timestamp: m.timestamp || m.created_at,
                                                }));
                                            setMessages(prev => {
                                                if (prev.length === 0) return restored;
                                                // Deduplicate: merge restored with existing
                                                const existingIds = new Set(prev.map(m => m.id));
                                                const newMsgs = restored.filter(m => !existingIds.has(m.id));
                                                return newMsgs.length > 0 ? [...newMsgs, ...prev] : prev;
                                            });
                                        }
                                    })
                                    .catch(() => { /* non-fatal — chat continues without history */ });
                            }
                        } else if (data.status === 'closed') {
                            intentionalClose.current = true;
                            socket.close();
                            setMessages([]);
                            setOperatorName(null);
                            handleChatEnded();
                        } else if (data.status === 'unavailable') {
                            intentionalClose.current = true;
                            setChatMode('unavailable');
                        }
                        break;

                    case 'message': {
                        setIsOperatorTyping(false);
                        const msg = {
                            id: `live-${++msgIdCounter.current}`,
                            text: data.content,
                            sender: data.role === 'operator' ? 'operator' : 'user',
                            operatorName: data.operator_name,
                            timestamp: data.timestamp || new Date().toISOString(),
                        };
                        setMessages(prev => [...prev, msg]);
                        break;
                    }

                    case 'operator_typing':
                        setIsOperatorTyping(true);
                        clearTimeout(typingTimeoutRef.current);
                        typingTimeoutRef.current = setTimeout(() => setIsOperatorTyping(false), 3000);
                        break;

                    case 'ping':
                        socket.send(JSON.stringify({ type: 'pong' }));
                        break;

                    case 'pong':
                        clearTimeout(pongTimeoutRef.current);
                        break;

                    default:
                        break;
                }
            };

            socket.onclose = () => {
                console.log('[OyeChats] Live chat WebSocket closed');
                if (!intentionalClose.current && reconnectAttempt.current < 15) {
                    const base = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30000);
                    const delay = Math.round(base * (0.9 + Math.random() * 0.2));
                    reconnectAttempt.current += 1;
                    setIsReconnecting(true);
                    onConnectionStatusChange?.('reconnecting');
                    reconnectTimer.current = setTimeout(connect, delay);
                } else if (reconnectAttempt.current >= 15) {
                    setIsReconnecting(false);
                    onConnectionStatusChange?.('disconnected');
                }
            };

            socket.onerror = () => {
                // onclose will fire after onerror, reconnect is handled there
            };

            setWs(socket);
        };

        intentionalClose.current = false;
        connect();

        return () => {
            intentionalClose.current = true;
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            clearTimeout(typingTimeoutRef.current);
            clearTimeout(stoppedTypingTimerRef.current);
            setWs(prev => { prev?.close(); return null; });
        };
    }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Visibility-aware heartbeat — keeps the WebSocket alive through load-balancer
    // idle timeouts. Interval is shorter when the tab is visible (25 s) and longer
    // when backgrounded (50 s) because browsers throttle timers in hidden tabs.
    const heartbeatRef = useRef(null);
    const pongTimeoutRef = useRef(null);
    useEffect(() => {
        if (!ws) return;

        const sendPing = () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
                clearTimeout(pongTimeoutRef.current);
                pongTimeoutRef.current = setTimeout(() => {
                    // No pong received — connection is dead
                    ws.close();
                }, 10000);
            }
        };

        const startHeartbeat = () => {
            clearInterval(heartbeatRef.current);
            const delay = document.visibilityState === 'visible' ? 25000 : 50000;
            heartbeatRef.current = setInterval(sendPing, delay);
        };

        startHeartbeat();
        document.addEventListener('visibilitychange', startHeartbeat);
        return () => {
            clearInterval(heartbeatRef.current);
            clearTimeout(pongTimeoutRef.current);
            document.removeEventListener('visibilitychange', startHeartbeat);
        };
    }, [ws]);

    // Visibility + network change handlers — detect stale connections on tab return
    // or network restoration and trigger an immediate reconnect if needed.
    useEffect(() => {
        if (!ws) return;

        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (ws.readyState === WebSocket.OPEN) {
                // Send an immediate ping to verify the connection is still alive.
                try { ws.send(JSON.stringify({ type: 'ping' })); } catch { ws.close(); }
            } else if (
                (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) &&
                !intentionalClose.current
            ) {
                // Connection died while the tab was backgrounded — reconnect immediately
                // with a reset backoff so the user isn't penalised for sleeping.
                reconnectAttempt.current = 0;
                ws.close(); // triggers onclose → connect()
            }
        };

        const handleOnline = () => {
            if (!intentionalClose.current && ws.readyState !== WebSocket.OPEN) {
                reconnectAttempt.current = 0;
                ws.close(); // triggers onclose → connect()
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('online', handleOnline);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('online', handleOnline);
        };
    }, [ws]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isOperatorTyping]);

    const handleSend = (e) => {
        e?.preventDefault();
        if (!inputText.trim()) return;

        const text = inputText;
        const msgId = `live-${++msgIdCounter.current}`;
        const timestamp = new Date().toISOString();

        const newMsg = { id: msgId, text, sender: 'user', timestamp, failed: false, status: 'sent' };

        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type: 'message', content: text }));
            } catch {
                newMsg.failed = true;
                setPendingMessages(prev => [...prev, { id: msgId, text }]);
            }
        } else {
            newMsg.failed = true;
            setPendingMessages(prev => [...prev, { id: msgId, text }]);
        }

        setMessages(prev => [...prev, newMsg]);
        setInputText('');
        inputRef.current?.focus();
    };

    // Retry pending messages when WebSocket reconnects
    useEffect(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN || pendingMessages.length === 0) return;

        const toRetry = [...pendingMessages];
        const stillFailed = [];

        for (const msg of toRetry) {
            try {
                ws.send(JSON.stringify({ type: 'message', content: msg.text }));
                setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, failed: false } : m));
            } catch {
                stillFailed.push(msg);
            }
        }
        setPendingMessages(stillFailed);
    }, [ws, pendingMessages]);

    const handleTyping = () => {
        const now = Date.now();
        if (now - lastTypingSentRef.current < 3000) return;
        lastTypingSentRef.current = now;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'typing' }));
        }
        // Send stopped_typing after 2s of inactivity
        clearTimeout(stoppedTypingTimerRef.current);
        stoppedTypingTimerRef.current = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'stopped_typing' }));
            }
        }, 2000);
    };

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

    const handleReturnToBot = () => {
        setShowRating(false);
        setChatMode('bot');
        setOperatorName(null);
        onNewMessage({
            id: Date.now(),
            text: "Thanks for your message! We'll get back to you soon. In the meantime, feel free to ask me anything.",
            sender: 'bot',
            timestamp: new Date().toISOString(),
            feedback: null,
        });
    };

    // Show rating survey before returning to bot (called when live chat ends)
    const handleChatEnded = () => {
        setShowRating(true);
    };

    const handleSubmitRating = async (stars) => {
        setRatingSubmitting(true);
        try {
            await fetch(`${API_URL}/operators/sessions/${sessionId}/rating`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Bot-Key': settings.bot_key || '',
                },
                body: JSON.stringify({ rating: stars }),
            });
        } catch { /* non-fatal — still proceed */ } finally {
            setRatingSubmitting(false);
            handleReturnToBot();
        }
    };

    /** Open the pre-send preview for a file (from picker or clipboard paste). */
    const openFilePreview = (file) => {
        const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'];
        if (!ALLOWED.includes(file.type)) return;
        if (file.size > 10 * 1024 * 1024) return;
        const isImage = file.type.startsWith('image/');
        setPendingFile({
            file,
            previewUrl: isImage ? URL.createObjectURL(file) : null,
            caption: '',
            isImage,
        });
    };

    const handleFileSelect = (e) => {
        const file = e.target.files?.[0];
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (file) openFilePreview(file);
    };

    /** Paste handler — intercepts clipboard images. */
    const handlePaste = (e) => {
        if (!settings?.feature_flags?.file_sharing) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) openFilePreview(file);
                break;
            }
        }
    };

    /** Discard the pending file preview and free the object URL. */
    const cancelPendingFile = () => {
        if (pendingFile?.previewUrl) URL.revokeObjectURL(pendingFile.previewUrl);
        setPendingFile(null);
    };

    /** Upload and send the confirmed pending file. */
    const sendPendingFile = async () => {
        if (!pendingFile) return;
        const { file, previewUrl, caption } = pendingFile;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPendingFile(null);
        setUploadProgress(0);
        try {
            // 1. Get presigned PUT URL
            const res = await fetch(`${API_URL}/chat/upload-url`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Bot-Key': settings.bot_key || '' },
                body: JSON.stringify({ filename: file.name, content_type: file.type, size: file.size }),
            });
            if (!res.ok) throw new Error('Failed to get upload URL');
            const { upload_url, file_url } = await res.json();

            // 2. PUT directly to B2
            const putRes = await fetch(upload_url, {
                method: 'PUT',
                headers: { 'Content-Type': file.type },
                body: file,
            });
            if (!putRes.ok) throw new Error(`B2 upload failed: ${putRes.status}`);
            setUploadProgress(100);

            // 3. Send file WS message + optimistic local render
            const wsInstance = ws;
            if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
                wsInstance.send(JSON.stringify({
                    type: 'file',
                    file_url,
                    filename: file.name,
                    content_type: file.type,
                }));
                setMessages(prev => [...prev, {
                    id: `live-file-${++msgIdCounter.current}`,
                    sender: 'user',
                    file_url,
                    filename: file.name,
                    content_type: file.type,
                    status: 'sent',
                    timestamp: new Date().toISOString(),
                }]);

                // 4. Send caption as a follow-up text message if provided
                if (caption.trim()) {
                    wsInstance.send(JSON.stringify({ type: 'message', content: caption.trim() }));
                    setMessages(prev => [...prev, {
                        id: `live-msg-${++msgIdCounter.current}`,
                        sender: 'user',
                        text: caption.trim(),
                        status: 'sent',
                        timestamp: new Date().toISOString(),
                    }]);
                }
            }
        } catch {
            /* silent — user can retry by re-selecting */
        } finally {
            setUploadProgress(null);
        }
    };

    // Progressive delay messages for waiting screen
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
        return queuePosition ? `You're #${queuePosition} in the queue` : 'Please wait a moment';
    };

    // Post-chat satisfaction survey screen
    if (showRating) {
        const primaryColor = settings.primary_color || '#3A0CA3';
        return (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-8" style={{ backgroundColor: settings.background_color || '#fff' }}>
                <div className="w-full max-w-sm text-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4" style={{ backgroundColor: `${primaryColor}15` }}>
                        <CheckCircle2 className="w-7 h-7" style={{ color: primaryColor }} />
                    </div>
                    <h3 className="text-[#16202C] font-bold text-base mb-1">Chat ended</h3>
                    <p className="text-gray-500 text-sm mb-6">How was your experience?</p>

                    <div className="flex justify-center gap-3 mb-6">
                        {[1, 2, 3, 4, 5].map((star) => (
                            <button
                                key={star}
                                onClick={() => !ratingSubmitting && handleSubmitRating(star)}
                                disabled={ratingSubmitting}
                                aria-label={`Rate ${star} star${star !== 1 ? 's' : ''}`}
                                className="text-3xl transition-transform hover:scale-125 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 rounded"
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
                <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
            </div>
        );
    }

    // Waiting screen
    if (chatMode === 'waiting') {
        return (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-8" style={{ backgroundColor: settings.background_color || '#fff' }}>
                <div className="text-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    <div className="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin mx-auto mb-4" style={{ borderColor: `${settings.primary_color || '#3A0CA3'}40`, borderTopColor: settings.primary_color || '#3A0CA3' }} />
                    <h3 className="text-[#16202C] font-bold text-base mb-1">Connecting you to support...</h3>
                    <p className="text-gray-500 text-sm" key={getWaitingMessage()} style={{ animation: 'fadeUp 0.3s ease-out' }}>
                        {getWaitingMessage()}
                    </p>
                    {waitingSeconds >= 45 && (
                        <button
                            onClick={() => setChatMode('unavailable')}
                            className="mt-3 text-[12px] font-medium hover:underline transition-colors"
                            style={{ color: settings.primary_color || '#3A0CA3' }}
                        >
                            Leave a message instead
                        </button>
                    )}
                    <button
                        onClick={() => {
                            // Notify backend to remove from queue immediately.
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'visitor_end_chat' }));
                            }
                            intentionalClose.current = true;
                            ws?.close();
                            setChatMode('bot');
                            setOperatorName(null);
                        }}
                        className="mt-3 text-[12px] text-gray-400 hover:text-gray-600 transition-colors"
                    >
                        Cancel and return to AI chat
                    </button>
                </div>
                <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
            </div>
        );
    }

    // Unavailable screen with "Leave a Message" form
    if (chatMode === 'unavailable') {
        // Error state
        if (offlineError) {
            return (
                <div className="flex-1 flex flex-col items-center justify-center px-5 py-6" style={{ backgroundColor: settings.background_color || '#fff' }}>
                    <div className="w-full max-w-sm text-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                        <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                            <AlertCircle className="w-7 h-7 text-red-500" />
                        </div>
                        <h3 className="text-[#16202C] font-bold text-base mb-2">Something went wrong</h3>
                        <p className="text-gray-500 text-sm mb-5">We couldn't send your message. Please try again.</p>
                        <button
                            onClick={() => { setOfflineError(false); }}
                            className="w-full py-2.5 rounded-xl text-white text-sm font-medium"
                            style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                        >
                            Try Again
                        </button>
                    </div>
                    <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
                </div>
            );
        }

        // Success state
        if (offlineSubmitted) {
            return (
                <div className="flex-1 flex flex-col items-center justify-center px-5 py-6" style={{ backgroundColor: settings.background_color || '#fff' }}>
                    <div className="w-full max-w-sm text-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                            <CheckCircle2 className="w-7 h-7 text-green-600" />
                        </div>
                        <h3 className="text-[#16202C] font-bold text-base mb-2">Message sent!</h3>
                        <p className="text-gray-500 text-sm mb-5">
                            We'll get back to you at <strong>{offlineForm.email}</strong>
                            {offlineForm.phone ? ' or give you a callback' : ''} as soon as possible.
                        </p>
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
                            <Clock className="w-6 h-6 text-amber-500" />
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
                                className="flex-1 bg-transparent outline-none text-sm text-gray-900 placeholder:text-gray-400"
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
                                className="flex-1 bg-transparent outline-none text-sm text-gray-900 placeholder:text-gray-400"
                            />
                        </div>
                        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2.5">
                            <Phone className="w-4 h-4 text-gray-400 shrink-0" />
                            <input
                                type="tel"
                                placeholder="Phone number (for callback)"
                                value={offlineForm.phone}
                                onChange={(e) => setOfflineForm(prev => ({ ...prev, phone: e.target.value }))}
                                className="flex-1 bg-transparent outline-none text-sm text-gray-900 placeholder:text-gray-400"
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
                                className="flex-1 bg-transparent outline-none text-sm text-gray-900 placeholder:text-gray-400 resize-none"
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

    // Derive user bubble color to match bot mode (MessageBubble.jsx)
    const userBubbleBg = settings.user_bubble_color || '#DBE9FF';
    const userBubbleText = '#16202C';

    // Live chat messages
    return (
        <>
            {isReconnecting && (
                <div className="px-4 py-1.5 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-amber-700 font-medium">Reconnecting...</span>
                </div>
            )}
            <div
                className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5"
                style={{ backgroundColor: settings.background_color || '#fff' }}
                aria-live="polite"
                aria-label="Chat messages"
                role="log"
            >
                {/* Previous bot conversation context */}
                {botMessages.length > 0 && messages.length === 0 && (
                    <>
                        {botMessages.map((msg) => (
                            <div key={`bot-ctx-${msg.id}`} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                                <div className={`flex ${msg.sender === 'user' ? 'justify-end' : ''} w-full`}>
                                    <div
                                        className={`max-w-[85%] px-4 py-3 rounded-2xl text-[14px] leading-relaxed opacity-50 ${
                                            msg.sender === 'user' ? '' : ''
                                        }`}
                                        style={msg.sender === 'user'
                                            ? { backgroundColor: userBubbleBg, color: userBubbleText }
                                            : {}}
                                    >
                                        {msg.text}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </>
                )}

                {/* Session start timestamp divider */}
                <div className="flex items-center gap-2 py-1">
                    <div className="flex-1 h-px bg-gray-200" />
                    <span className="text-[10px] text-gray-400 font-medium whitespace-nowrap">
                        {sessionStartTime.current.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <div className="flex-1 h-px bg-gray-200" />
                </div>

                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start w-full'}`}
                    >
                        {msg.sender === 'user' ? (
                            /* User message — matches bot mode MessageBubble styling */
                            <>
                                <div className="flex justify-end w-full">
                                    <div
                                        className="max-w-[85%] px-4 py-3 rounded-2xl text-[14px] break-words"
                                        style={{ backgroundColor: userBubbleBg, color: userBubbleText }}
                                    >
                                        {msg.file_url ? (
                                            msg.content_type?.startsWith('image/') ? (
                                                <button
                                                    type="button"
                                                    onClick={() => setLightboxSrc(msg.file_url)}
                                                    className="focus:outline-none"
                                                    aria-label="View image"
                                                >
                                                    <img
                                                        src={msg.file_url}
                                                        alt={msg.filename || 'image'}
                                                        className="max-w-[200px] rounded-xl block cursor-zoom-in hover:opacity-90 transition-opacity"
                                                    />
                                                </button>
                                            ) : (
                                                <a href={msg.file_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline text-sm break-all">
                                                    📎 {msg.filename || 'file'}
                                                </a>
                                            )
                                        ) : (
                                            <p className="prose prose-sm max-w-none break-words" style={{ color: userBubbleText }}>
                                                {msg.text}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                {/* WhatsApp-style read status — tap to retry if failed */}
                                <div className="flex items-center gap-1 mt-0.5 mr-1">
                                    {msg.failed ? (
                                        <button
                                            type="button"
                                            aria-label="Message not sent — tap to retry"
                                            onClick={() => {
                                                if (ws && ws.readyState === WebSocket.OPEN) {
                                                    try {
                                                        ws.send(JSON.stringify({ type: 'message', content: msg.text }));
                                                        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, failed: false, status: 'sent' } : m));
                                                        setPendingMessages(prev => prev.filter(p => p.id !== msg.id));
                                                    } catch { /* stay failed */ }
                                                }
                                            }}
                                            className="text-[10px] text-red-500 flex items-center gap-0.5 hover:text-red-700 underline cursor-pointer"
                                        >
                                            <AlertCircle className="w-3 h-3" /> Not sent · Retry
                                        </button>
                                    ) : (
                                        <span className="text-[10px] text-gray-400">
                                            {msg.status === 'read' ? (
                                                <span style={{ color: '#53bdeb' }}>Read</span>
                                            ) : msg.status === 'delivered' ? (
                                                'Delivered'
                                            ) : (
                                                'Sent'
                                            )}
                                        </span>
                                    )}
                                </div>
                            </>
                        ) : (
                            /* Operator message */
                            <div className="w-full">
                                {msg.operatorName && (
                                    <p className="text-[11px] font-semibold mb-0.5 ml-0.5" style={{ color: settings.primary_color || '#3A0CA3' }}>{msg.operatorName}</p>
                                )}
                                {msg.file_url ? (
                                    msg.content_type?.startsWith('image/') ? (
                                        <button
                                            type="button"
                                            onClick={() => setLightboxSrc(msg.file_url)}
                                            className="focus:outline-none"
                                            aria-label="View image"
                                        >
                                            <img
                                                src={msg.file_url}
                                                alt={msg.filename || 'image'}
                                                className="max-w-[200px] rounded-xl block cursor-zoom-in hover:opacity-90 transition-opacity"
                                            />
                                        </button>
                                    ) : (
                                        <a href={msg.file_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline text-sm break-all">
                                            📎 {msg.filename || 'file'}
                                        </a>
                                    )
                                ) : (
                                    <p className="text-[14px] text-[#16202C] leading-relaxed break-words">
                                        {msg.text}
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                ))}

                {isOperatorTyping && (
                    <div className="flex justify-start">
                        <div className="flex gap-1.5 px-1 py-2">
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '0ms', backgroundColor: settings.primary_color || '#3A0CA3', opacity: 0.6 }} />
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '150ms', backgroundColor: settings.primary_color || '#3A0CA3', opacity: 0.6 }} />
                            <span className="w-2 h-2 rounded-full animate-bounce" style={{ animationDelay: '300ms', backgroundColor: settings.primary_color || '#3A0CA3', opacity: 0.6 }} />
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* End chat confirmation dialog */}
            {showEndConfirm && (
                <div className="px-4 py-3 bg-red-50 border-t border-red-200">
                    <p className="text-xs text-red-700 font-medium mb-2">End this conversation and return to AI?</p>
                    <div className="flex gap-2">
                        <button
                            onClick={() => {
                                if (ws && ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ type: 'visitor_end_chat' }));
                                }
                                intentionalClose.current = true;
                                ws?.close();
                                setShowEndConfirm(false);
                                handleChatEnded();
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

            {/* Input — matches bot mode ChatInput styling */}
            <div className="px-4 pb-4 pt-2 bg-white shrink-0">
                <div className="flex items-center justify-center mb-2">
                    <button
                        onClick={() => setShowEndConfirm(true)}
                        aria-label="End live chat and return to AI assistant"
                        className="text-[11px] text-gray-400 hover:text-red-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 rounded"
                    >
                        End chat and return to AI
                    </button>
                </div>
                <div className="rounded-2xl border border-[#BBE7FF]/50 bg-white px-4 pt-3 pb-2 shadow-sm">
                    {/* Upload progress bar */}
                    {uploadProgress !== null && (
                        <div className="w-full h-1 bg-gray-100 rounded-full mb-2 overflow-hidden">
                            <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{ width: `${uploadProgress}%`, backgroundColor: settings.primary_color || '#3A0CA3' }}
                            />
                        </div>
                    )}
                    <form onSubmit={handleSend}>
                        <textarea
                            ref={inputRef}
                            value={inputText}
                            onChange={(e) => {
                                setInputText(e.target.value);
                                handleTyping();
                                e.target.style.height = 'auto';
                                e.target.style.height = e.target.scrollHeight + 'px';
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSend(e);
                                }
                            }}
                            onPaste={handlePaste}
                            placeholder="Type a message..."
                            rows={1}
                            className="w-full outline-none bg-transparent text-[14px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-hidden min-h-[24px] max-h-[100px]"
                            style={{ border: 'none' }}
                        />
                        <div className="flex items-center justify-between mt-2">
                            {settings?.feature_flags?.file_sharing && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={uploadProgress !== null || isReconnecting}
                                    title="Attach file"
                                    aria-label="Attach file"
                                    className={`transition-opacity ${(uploadProgress !== null || isReconnecting) ? 'opacity-30 cursor-not-allowed' : 'opacity-60 hover:opacity-100'}`}
                                >
                                    <Paperclip size={20} className="text-[#16202C]" />
                                </button>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*,.pdf,.txt"
                                    className="hidden"
                                    onChange={handleFileSelect}
                                />
                            </>
                        )}
                            <button
                                type="submit"
                                disabled={!inputText.trim()}
                                aria-label="Send message"
                                className="w-11 h-11 flex items-center justify-center transition-all disabled:cursor-not-allowed rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                            >
                                <SendIcon
                                    size={20}
                                    className={`transition-colors ${inputText.trim() ? 'text-[#16202C]' : 'text-[#BBE7FF]'}`}
                                />
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            {/* ── Pre-send file preview overlay ── */}
            {pendingFile && (
                <div className="absolute inset-0 z-20 flex flex-col bg-white">
                    {/* Header */}
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
                        <button
                            type="button"
                            onClick={cancelPendingFile}
                            aria-label="Cancel"
                            className="text-gray-400 hover:text-gray-700 transition-colors"
                        >
                            <X size={20} />
                        </button>
                        <span className="text-sm font-semibold text-[#16202C]">Send file</span>
                    </div>

                    {/* Preview area */}
                    <div className="flex-1 flex items-center justify-center p-6 bg-gray-50 overflow-hidden">
                        {pendingFile.isImage ? (
                            <img
                                src={pendingFile.previewUrl}
                                alt="Preview"
                                className="max-w-full max-h-full object-contain rounded-xl shadow-sm"
                            />
                        ) : (
                            <div className="flex flex-col items-center gap-3 text-gray-500">
                                <div className="w-16 h-16 rounded-2xl bg-gray-200 flex items-center justify-center text-2xl">
                                    📎
                                </div>
                                <p className="text-sm font-medium text-[#16202C] text-center break-all px-4">
                                    {pendingFile.file.name}
                                </p>
                                <p className="text-xs text-gray-400">
                                    {(pendingFile.file.size / 1024).toFixed(1)} KB
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Caption + send */}
                    <div className="px-4 pb-4 pt-2 bg-white border-t border-gray-100">
                        {uploadProgress !== null && (
                            <div className="w-full h-1 bg-gray-100 rounded-full mb-3 overflow-hidden">
                                <div
                                    className="h-full rounded-full transition-all duration-300"
                                    style={{ width: `${uploadProgress}%`, backgroundColor: settings.primary_color || '#3A0CA3' }}
                                />
                            </div>
                        )}
                        <div className="flex items-center gap-2 rounded-2xl border border-[#BBE7FF]/50 bg-white px-4 py-2 shadow-sm">
                            <input
                                type="text"
                                value={pendingFile.caption}
                                onChange={(e) => setPendingFile(prev => ({ ...prev, caption: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') sendPendingFile(); }}
                                placeholder="Add a caption…"
                                className="flex-1 outline-none bg-transparent text-[14px] text-[#16202C] placeholder:text-gray-400"
                                autoFocus
                            />
                            <button
                                type="button"
                                onClick={sendPendingFile}
                                disabled={uploadProgress !== null}
                                aria-label="Send"
                                className="w-9 h-9 flex items-center justify-center rounded-xl transition-all disabled:opacity-40"
                                style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                            >
                                <SendIcon size={16} className="text-white" />
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Image lightbox ── */}
            {lightboxSrc && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90"
                    onClick={() => setLightboxSrc(null)}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Image viewer"
                >
                    <button
                        type="button"
                        onClick={() => setLightboxSrc(null)}
                        aria-label="Close"
                        className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors"
                    >
                        <X size={28} />
                    </button>
                    <img
                        src={lightboxSrc}
                        alt="Full size"
                        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
            )}
        </>
    );
};

export default LiveChatMode;
