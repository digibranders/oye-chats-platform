import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Headphones, Send, X, User, Mail, MapPin, Monitor, MessageCircle,
    Loader2, Circle, ArrowRightLeft, ChevronRight, ChevronLeft,
    Users, Info, Phone, Building2, Clock,
} from 'lucide-react';
import {
    acceptChat, closeOperatorChat, toggleOperatorStatus, getChatHistory,
    getCannedResponses, transferChat, getOperators, getDepartments, getSessionDetails, getOperatorQueue,
} from '../services/api';
import PageHeader from '../components/ui/PageHeader';
import NoBotState from '../components/NoBotState';
import { useBotContext } from '../context/BotContext';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';
const MAX_RECONNECT_ATTEMPTS = 8;

export default function LiveChat({ embedded = false }) {
    const { bots, loading: botsLoading } = useBotContext();

    // Core operator state
    const [isOnline, setIsOnline] = useState(false);
    const [operatorName, setOperatorName] = useState('');

    // Chat state
    const [queue, setQueue] = useState([]);             // [{ session_id, name, reason }]
    const [activeChats, setActiveChats] = useState([]); // session IDs
    const [chatNames, setChatNames] = useState({});     // session_id → { name, reason }
    const [selectedChat, setSelectedChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [unreadCounts, setUnreadCounts] = useState({}); // session_id → number
    const [lastMessages, setLastMessages] = useState({}); // session_id → preview string

    // Canned responses
    const [cannedResponses, setCannedResponses] = useState([]);
    const [showCannedDropdown, setShowCannedDropdown] = useState(false);
    const [cannedFilter, setCannedFilter] = useState('');

    // Accept loading state
    const [acceptingSessionId, setAcceptingSessionId] = useState(null);

    // Transfer modal
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [transferOperators, setTransferOperators] = useState([]);
    const [transferDepartments, setTransferDepartments] = useState([]);

    // Right panel (session info + team roster)
    const [showRightPanel, setShowRightPanel] = useState(true);
    const [rightPanelTab, setRightPanelTab] = useState('team'); // 'session' | 'team'
    const [sessionInfo, setSessionInfo] = useState(null);
    const [operatorsList, setOperatorsList] = useState([]); // full roster from REST + WS updates

    // Visitor connection status per session: session_id → 'online' | 'disconnected'
    const [visitorStatus, setVisitorStatus] = useState({});

    // Connection state
    const [reconnectCount, setReconnectCount] = useState(0);
    const [connectionLost, setConnectionLost] = useState(false);

    // Refs — avoids stale closures in WebSocket handlers
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);
    const wsRef = useRef(null);
    const pingIntervalRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const manualCloseRef = useRef(false);
    const reconnectAttemptsRef = useRef(0);
    const selectedChatRef = useRef(null); // mirrors selectedChat without causing WS reconnects
    const lastAgentTypingSentRef = useRef(0);
    const queuePollIntervalRef = useRef(null);
    const queueSnapshotRef = useRef(new Set());
    const chatNamesRef = useRef({});

    // Keep selectedChatRef in sync and react to chat selection
    useEffect(() => {
        selectedChatRef.current = selectedChat;
        if (selectedChat) {
            // Clear unread badge
            setUnreadCounts(prev => ({ ...prev, [selectedChat]: 0 }));
            // Switch to session info tab
            setRightPanelTab('session');
            setSessionInfo(null);
            getSessionDetails(selectedChat)
                .then(data => setSessionInfo(data))
                .catch(() => setSessionInfo(null));
        } else {
            setSessionInfo(null);
        }
    }, [selectedChat]);

    // Keep chatNamesRef in sync to avoid stale closures in WS handler
    useEffect(() => { chatNamesRef.current = chatNames; }, [chatNames]);

    // Request browser notification permission on mount
    useEffect(() => {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
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

    const sendBrowserNotification = useCallback((title, body) => {
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
            new Notification(title, { body, icon: '/favicon.ico' });
        }
    }, []);

    // Load full operators roster (for Team panel)
    const fetchOperatorsList = useCallback(async () => {
        try {
            const data = await getOperators();
            setOperatorsList(data.operators || []);
        } catch { /* silent */ }
    }, []);

    const syncQueueState = useCallback((waitingItems = []) => {
        setQueue(waitingItems);

        const previousIds = queueSnapshotRef.current;
        const currentIds = new Set(waitingItems.map(item => item.session_id));
        const hasNewItem = waitingItems.some(item => !previousIds.has(item.session_id));

        if (hasNewItem) {
            playNotification();
            sendBrowserNotification('New chat waiting', 'A visitor is waiting for live support');
        }

        queueSnapshotRef.current = currentIds;
    }, [playNotification, sendBrowserNotification]);

    const fetchQueueSnapshot = useCallback(async () => {
        try {
            const data = await getOperatorQueue();
            syncQueueState(data.queue || []);
        } catch {
            // silent fallback: WebSocket stream may still be active
        }
    }, [syncQueueState]);

    const removeSessionFromQueue = useCallback((sessionId) => {
        setQueue(prev => prev.filter(item => item.session_id !== sessionId));
        queueSnapshotRef.current = new Set(
            [...queueSnapshotRef.current].filter(existingSessionId => existingSessionId !== sessionId)
        );
    }, []);

    // WebSocket: connect when online, heartbeat, auto-reconnect with exponential backoff
    // NOTE: selectedChat intentionally NOT in deps — use selectedChatRef to prevent reconnect on every chat click
    useEffect(() => {
        const apiKey = localStorage.getItem('admin_token');
        const authType = localStorage.getItem('auth_type');
        if (!apiKey || !isOnline) return;

        clearTimeout(reconnectTimerRef.current);
        manualCloseRef.current = false;

        const wsUrl = API_URL.replace(/^http/, 'ws').replace(/\/+$/, '');
        // Bug fix: operators must use operator_key param (their operator_api_key is stored in admin_token).
        // Owners/clients use api_key param (resolves to their first operator record on the backend).
        const encodedKey = encodeURIComponent(apiKey);
        const wsParam = authType === 'operator' ? `operator_key=${encodedKey}` : `api_key=${encodedKey}`;
        const socket = new WebSocket(`${wsUrl}/ws/operator?${wsParam}`);
        wsRef.current = socket;

        socket.onopen = () => {
            console.log('[LiveChat] WebSocket connected');
            reconnectAttemptsRef.current = 0;
            setConnectionLost(false);
            clearInterval(pingIntervalRef.current);
            // Heartbeat: keeps connection alive through proxies/NAT idle timeouts
            pingIntervalRef.current = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 25000);
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'pong':
                    // Heartbeat ack — ignore
                    break;

                case 'init':
                    // Server sends operator name + online status on first connect
                    if (data.operator_name) setOperatorName(data.operator_name);
                    break;

                case 'queue_update':
                    syncQueueState(data.waiting || []);
                    break;

                case 'operators_update':
                    // Merge real-time active_chat counts into roster.
                    // Operators present in the WS update are online; absent ones are offline.
                    setOperatorsList(prev => {
                        const wsMap = {};
                        (data.operators || []).forEach(a => { wsMap[a.operator_id] = a; });
                        return prev.map(operator => {
                            const wsOp = wsMap[operator.id];
                            return wsOp
                                ? { ...operator, active_chats: wsOp.active_chats, is_online: true }
                                : { ...operator, is_online: false, active_chats: 0 };
                        });
                    });
                    break;

                case 'message': {
                    const currentSelected = selectedChatRef.current;
                    // Track last message preview for sidebar
                    setLastMessages(prev => ({
                        ...prev,
                        [data.session_id]: data.content?.slice(0, 60) || '',
                    }));
                    if (data.session_id === currentSelected) {
                        setMessages(prev => [...prev, {
                            id: Date.now(),
                            role: data.role,
                            content: data.content,
                            timestamp: data.timestamp,
                        }]);
                        setIsTyping(false);
                    } else {
                        setUnreadCounts(prev => ({
                            ...prev,
                            [data.session_id]: (prev[data.session_id] || 0) + 1,
                        }));
                    }
                    if (data.role === 'user') {
                        playNotification();
                        sendBrowserNotification(
                            chatNamesRef.current[data.session_id]?.name || 'New message',
                            data.content?.slice(0, 80) || 'Visitor sent a message'
                        );
                    }
                    break;
                }

                case 'visitor_typing':
                    if (data.session_id === selectedChatRef.current) {
                        setIsTyping(true);
                        setTimeout(() => setIsTyping(false), 3000);
                    }
                    break;

                case 'chat_accepted':
                    setActiveChats(prev => [...new Set([...prev, data.session_id])]);
                    setChatNames(prev => ({
                        ...prev,
                        [data.session_id]: {
                            name: data.visitor_name || 'Anonymous',
                            reason: data.reason || null,
                        },
                    }));
                    setVisitorStatus(prev => ({ ...prev, [data.session_id]: 'online' }));
                    removeSessionFromQueue(data.session_id);
                    break;

                case 'chat_transferred':
                    // Chat transferred away from this agent
                    setActiveChats(prev => prev.filter(id => id !== data.session_id));
                    if (selectedChatRef.current === data.session_id) {
                        setSelectedChat(null);
                        setMessages([]);
                    }
                    break;

                case 'chat_closed':
                    setActiveChats(prev => prev.filter(id => id !== data.session_id));
                    setVisitorStatus(prev => { const next = { ...prev }; delete next[data.session_id]; return next; });
                    if (selectedChatRef.current === data.session_id) {
                        setSelectedChat(null);
                        setMessages([]);
                    }
                    break;

                case 'active_chats_restore':
                    // Server sends active assignments on agent reconnect/page refresh
                    if (data.chats && data.chats.length > 0) {
                        setActiveChats(prev => {
                            const ids = new Set(prev);
                            data.chats.forEach(c => ids.add(c.session_id));
                            return [...ids];
                        });
                        setChatNames(prev => {
                            const next = { ...prev };
                            data.chats.forEach(c => {
                                next[c.session_id] = { name: c.visitor_name || 'Anonymous', reason: c.reason || null };
                            });
                            return next;
                        });
                        setVisitorStatus(prev => {
                            const next = { ...prev };
                            data.chats.forEach(c => {
                                next[c.session_id] = c.visitor_online ? 'online' : 'disconnected';
                            });
                            return next;
                        });
                    }
                    break;

                case 'visitor_disconnected':
                    setVisitorStatus(prev => ({ ...prev, [data.session_id]: 'disconnected' }));
                    // Add a system message to the chat if it's currently selected
                    if (data.session_id === selectedChatRef.current) {
                        setMessages(prev => [...prev, {
                            id: `sys-disc-${Date.now()}`,
                            role: 'system',
                            content: 'Visitor has disconnected. They may reconnect shortly.',
                            timestamp: new Date().toISOString(),
                        }]);
                    }
                    break;

                case 'visitor_reconnected':
                    setVisitorStatus(prev => ({ ...prev, [data.session_id]: 'online' }));
                    if (data.session_id === selectedChatRef.current) {
                        setMessages(prev => [...prev, {
                            id: `sys-recon-${Date.now()}`,
                            role: 'system',
                            content: 'Visitor has reconnected.',
                            timestamp: new Date().toISOString(),
                        }]);
                    }
                    break;

                default:
                    break;
            }
        };

        socket.onclose = () => {
            console.log('[LiveChat] WebSocket closed');
            clearInterval(pingIntervalRef.current);
            if (!manualCloseRef.current) {
                if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
                    setConnectionLost(true);
                    return;
                }
                // Exponential backoff: 3s → 6s → 12s → ... capped at 30s
                const delay = Math.min(3000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
                reconnectAttemptsRef.current += 1;
                reconnectTimerRef.current = setTimeout(() => setReconnectCount(c => c + 1), delay);
            }
        };

        return () => {
            manualCloseRef.current = true;
            clearInterval(pingIntervalRef.current);
            clearTimeout(reconnectTimerRef.current);
            socket.close();
            wsRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOnline, reconnectCount, removeSessionFromQueue, syncQueueState]);

    // Queue fallback polling: keeps queue accurate even if WS events are missed.
    useEffect(() => {
        clearInterval(queuePollIntervalRef.current);

        if (!isOnline) {
            queueSnapshotRef.current = new Set();
            return undefined;
        }

        fetchQueueSnapshot();
        queuePollIntervalRef.current = setInterval(fetchQueueSnapshot, 8000);

        return () => {
            clearInterval(queuePollIntervalRef.current);
            queuePollIntervalRef.current = null;
        };
    }, [isOnline, fetchQueueSnapshot]);

    // Load operators roster when going online
    useEffect(() => {
        if (isOnline) fetchOperatorsList();
    }, [isOnline, fetchOperatorsList]);

    // Auto-scroll messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isTyping]);

    // Load canned responses once
    useEffect(() => {
        getCannedResponses().then(data => setCannedResponses(data.responses || [])).catch(() => {});
    }, []);

    const handleToggleStatus = async () => {
        try {
            const result = await toggleOperatorStatus();
            setIsOnline(result.is_online);
            setOperatorName(result.operator_name);
            if (!result.is_online) {
                // Going offline — close WS without triggering reconnect
                manualCloseRef.current = true;
                clearInterval(pingIntervalRef.current);
                clearTimeout(reconnectTimerRef.current);
                clearInterval(queuePollIntervalRef.current);
                queuePollIntervalRef.current = null;
                wsRef.current?.close();
                wsRef.current = null;
                setQueue([]);
                setVisitorStatus({});
                queueSnapshotRef.current = new Set();
                setConnectionLost(false);
                reconnectAttemptsRef.current = 0;
            }
        } catch (e) {
            console.error('Failed to toggle status:', e);
        }
    };

    const handleAcceptChat = async (sessionId, visitorName, reason) => {
        setAcceptingSessionId(sessionId);
        try {
            await acceptChat(sessionId);
            setActiveChats(prev => [...new Set([...prev, sessionId])]);
            setChatNames(prev => ({
                ...prev,
                [sessionId]: { name: visitorName || 'Anonymous', reason: reason || null },
            }));
            setVisitorStatus(prev => ({ ...prev, [sessionId]: 'online' }));
            setSelectedChat(sessionId);
            removeSessionFromQueue(sessionId);
            try {
                const history = await getChatHistory(sessionId);
                setMessages(history.map((m, i) => ({
                    id: i, role: m.role, content: m.content, timestamp: m.timestamp,
                })));
            } catch { setMessages([]); }
        } catch (e) {
            if (e?.status === 409) {
                removeSessionFromQueue(sessionId);
            } else {
                console.error('Failed to accept chat:', e);
            }
        } finally {
            setAcceptingSessionId(null);
        }
    };

    const handleSelectChat = async (sessionId) => {
        setSelectedChat(sessionId);
        try {
            const history = await getChatHistory(sessionId);
            setMessages(history.map((m, i) => ({
                id: i, role: m.role, content: m.content, timestamp: m.timestamp,
            })));
            if (history.length > 0) {
                setLastMessages(prev => ({ ...prev, [sessionId]: history[history.length - 1].content?.slice(0, 60) || '' }));
            }
        } catch { setMessages([]); }
    };

    const handleCloseChat = async (sessionId) => {
        try {
            await closeOperatorChat(sessionId);
            setActiveChats(prev => prev.filter(id => id !== sessionId));
            if (selectedChat === sessionId) {
                setSelectedChat(null);
                setMessages([]);
            }
        } catch (e) {
            console.error('Failed to close chat:', e);
        }
    };

    const handleInputChange = (e) => {
        const val = e.target.value;
        setInputText(val);
        handleAgentTyping();
        if (val.startsWith('/')) {
            setCannedFilter(val.slice(1).toLowerCase());
            setShowCannedDropdown(true);
        } else {
            setShowCannedDropdown(false);
        }
    };

    const selectCannedResponse = (response) => {
        setInputText(response.content);
        setShowCannedDropdown(false);
        inputRef.current?.focus();
    };

    const filteredCanned = cannedResponses.filter(r => {
        if (!cannedFilter) return true;
        return (
            r.title.toLowerCase().includes(cannedFilter) ||
            (r.shortcut && r.shortcut.toLowerCase().includes(cannedFilter)) ||
            r.content.toLowerCase().includes(cannedFilter)
        );
    });

    const openTransferModal = async () => {
        try {
            const [operatorsData, deptsData] = await Promise.all([getOperators(), getDepartments()]);
            setTransferOperators((operatorsData.operators || []).filter(a => a.is_online));
            setTransferDepartments(deptsData.departments || []);
            setShowTransferModal(true);
        } catch { /* silent */ }
    };

    const handleTransfer = async (targetOperatorId, targetDeptId) => {
        if (!selectedChat) return;
        try {
            const payload = targetOperatorId
                ? { target_agent_id: targetOperatorId }
                : { target_department_id: targetDeptId };
            await transferChat(selectedChat, payload);
            setShowTransferModal(false);
            setActiveChats(prev => prev.filter(c => c !== selectedChat));
            setSelectedChat(null);
            setMessages([]);
        } catch (e) {
            console.error('Transfer failed:', e);
        }
    };

    const handleSend = (e) => {
        e?.preventDefault();
        setShowCannedDropdown(false);
        const socket = wsRef.current;
        if (!inputText.trim() || !socket || socket.readyState !== WebSocket.OPEN || !selectedChat) return;

        socket.send(JSON.stringify({ type: 'message', session_id: selectedChat, content: inputText }));
        setMessages(prev => [...prev, {
            id: Date.now(), role: 'agent', content: inputText, timestamp: new Date().toISOString(),
        }]);
        setLastMessages(prev => ({ ...prev, [selectedChat]: inputText.slice(0, 60) }));
        setInputText('');
        inputRef.current?.focus();
    };

    const handleAgentTyping = () => {
        const now = Date.now();
        if (now - lastAgentTypingSentRef.current < 3000) return;
        lastAgentTypingSentRef.current = now;
        const socket = wsRef.current;
        if (socket && socket.readyState === WebSocket.OPEN && selectedChatRef.current) {
            socket.send(JSON.stringify({ type: 'typing', session_id: selectedChatRef.current }));
        }
    };

    const getOperatorStatus = (operator) => {
        if (!operator.is_online) return 'offline';
        if ((operator.active_chats || 0) > 0) return 'busy';
        return 'online';
    };

    const statusDotClass = (status) => {
        if (status === 'online') return 'bg-green-500';
        if (status === 'busy') return 'bg-amber-400';
        return 'bg-secondary-300';
    };

    if (!botsLoading && bots.length === 0) {
        return <NoBotState />;
    }

    const currentVisitorName = selectedChat ? (chatNames[selectedChat]?.name || 'Visitor') : 'Visitor';

    return (
        <div
            className={`flex flex-col ${embedded ? '' : 'animate-fade-in'}`}
            style={{ height: embedded ? 'calc(100vh - 180px)' : 'calc(100vh - 120px)' }}
        >
            {/* Top bar: agent name + status toggle */}
            <div className="flex items-center justify-between mb-4 flex-shrink-0">
                {!embedded && <PageHeader title="Live Chat" subtitle="Chat with visitors in real-time" />}
                <div className={`flex items-center gap-3 ${embedded ? 'w-full justify-between' : ''}`}>
                    {operatorName && <span className="text-sm text-secondary-500">{operatorName}</span>}
                    {connectionLost && (
                        <span className="text-xs text-red-600 bg-red-50 border border-red-200 px-3 py-1 rounded-lg">
                            Connection lost — refresh to reconnect
                        </span>
                    )}
                    <button
                        onClick={handleToggleStatus}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                            isOnline
                                ? 'bg-green-50 border-green-200 text-green-700'
                                : 'bg-secondary-50 border-secondary-200 text-secondary-600'
                        }`}
                    >
                        <Circle className={`w-3 h-3 ${isOnline ? 'fill-green-500 text-green-500' : 'fill-secondary-300 text-secondary-300'}`} />
                        {isOnline ? 'Online' : 'Offline'}
                    </button>
                </div>
            </div>

            {!isOnline ? (
                <div className="flex flex-col items-center justify-center flex-1 text-center">
                    <div className="w-16 h-16 rounded-full bg-secondary-100 flex items-center justify-center mb-4">
                        <Headphones className="w-8 h-8 text-secondary-400" />
                    </div>
                    <h3 className="text-lg font-bold text-secondary-900 mb-2">You're offline</h3>
                    <p className="text-sm text-secondary-500 max-w-sm mb-4">
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
                <div className="flex gap-3 flex-1 min-h-0">

                    {/* ── Left: Queue + Active Chats ── */}
                    <div className="w-64 flex-shrink-0 bg-white rounded-2xl border border-secondary-200 overflow-hidden flex flex-col">
                        {/* Waiting queue */}
                        {queue.length > 0 && (
                            <div className="border-b border-secondary-200 flex-shrink-0">
                                <div className="px-4 py-3 bg-amber-50">
                                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-amber-700">
                                        Waiting ({queue.length})
                                    </h4>
                                </div>
                                {queue.map(item => (
                                    <div key={item.session_id} className="px-4 py-3 border-b border-secondary-100 hover:bg-secondary-50 transition-colors">
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="text-sm font-medium text-secondary-900 truncate">
                                                {item.name || 'Anonymous'}
                                            </span>
                                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                                        </div>
                                        {item.reason && (
                                            <p className="text-[11px] text-secondary-500 truncate mb-2">{item.reason}</p>
                                        )}
                                        <button
                                            onClick={() => handleAcceptChat(item.session_id, item.name, item.reason)}
                                            disabled={acceptingSessionId === item.session_id}
                                            className="w-full py-1.5 bg-primary-600 text-white text-[12px] font-medium rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-1.5"
                                        >
                                            {acceptingSessionId === item.session_id ? (
                                                <><Loader2 className="w-3 h-3 animate-spin" /> Accepting...</>
                                            ) : 'Accept'}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Active chats */}
                        <div className="flex-1 overflow-y-auto">
                            <div className="px-4 py-3 flex-shrink-0">
                                <h4 className="text-[11px] font-bold uppercase tracking-wider text-secondary-500">
                                    Active ({activeChats.length})
                                </h4>
                            </div>
                            {activeChats.length === 0 ? (
                                <div className="px-4 py-8 text-center text-sm text-secondary-400">
                                    No active chats
                                </div>
                            ) : (
                                activeChats.map(sid => {
                                    const unread = unreadCounts[sid] || 0;
                                    const name = chatNames[sid]?.name || 'Visitor';
                                    const vStatus = visitorStatus[sid] || 'online';
                                    return (
                                        <button
                                            key={sid}
                                            onClick={() => handleSelectChat(sid)}
                                            className={`w-full px-4 py-3 text-left border-b border-secondary-100 transition-colors ${
                                                selectedChat === sid
                                                    ? 'bg-primary-50 border-l-2 border-l-primary-500'
                                                    : 'hover:bg-secondary-50'
                                            }`}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="min-w-0">
                                                    <span className="text-sm font-medium text-secondary-900 truncate block">
                                                        {name}
                                                    </span>
                                                    {vStatus === 'disconnected' && (
                                                        <span className="text-[10px] text-amber-600 block">Disconnected</span>
                                                    )}
                                                    {lastMessages[sid] && (
                                                        <p className="text-[11px] text-secondary-400 truncate">{lastMessages[sid]}</p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                                    {unread > 0 && (
                                                        <span className="min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                                                            {unread > 9 ? '9+' : unread}
                                                        </span>
                                                    )}
                                                    <span className={`w-2 h-2 rounded-full ${vStatus === 'disconnected' ? 'bg-amber-400' : 'bg-green-500'}`} />
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>

                    {/* ── Center: Chat Panel ── */}
                    <div className="flex-1 bg-white rounded-2xl border border-secondary-200 overflow-hidden flex flex-col min-w-0">
                        {selectedChat ? (
                            <>
                                {/* Chat header */}
                                <div className="px-4 py-3 border-b border-secondary-200 flex items-center justify-between flex-shrink-0">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
                                            <User className="w-4 h-4 text-primary-600" />
                                        </div>
                                        <div>
                                            <h4 className="text-sm font-semibold text-secondary-900">{currentVisitorName}</h4>
                                            <p className={`text-[11px] ${(visitorStatus[selectedChat] || 'online') === 'disconnected' ? 'text-amber-600' : 'text-green-600'}`}>
                                                {(visitorStatus[selectedChat] || 'online') === 'disconnected' ? 'Disconnected' : 'Connected'}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={openTransferModal}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"
                                        >
                                            <ArrowRightLeft className="w-3.5 h-3.5" />
                                            Transfer
                                        </button>
                                        <button
                                            onClick={() => { if (window.confirm(`End chat with ${currentVisitorName}?`)) handleCloseChat(selectedChat); }}
                                            className="px-3 py-1.5 text-[12px] font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
                                        >
                                            End Chat
                                        </button>
                                        <button
                                            onClick={() => setShowRightPanel(p => !p)}
                                            className="p-1.5 text-secondary-400 hover:text-secondary-600 hover:bg-secondary-100 rounded-lg transition-colors"
                                            title={showRightPanel ? 'Hide panel' : 'Show panel'}
                                        >
                                            {showRightPanel
                                                ? <ChevronRight className="w-4 h-4" />
                                                : <ChevronLeft className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>

                                {/* Messages area */}
                                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                                    {messages.map((msg) => (
                                        <div key={msg.id} className={`flex ${msg.role === 'agent' ? 'justify-end' : 'justify-start'}`}>
                                            <div className={`max-w-[75%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                                                msg.role === 'agent'
                                                    ? 'bg-primary-600 text-white rounded-br-md'
                                                    : msg.role === 'user'
                                                    ? 'bg-secondary-100 text-secondary-800 rounded-bl-md'
                                                    : 'bg-secondary-50 text-secondary-600 italic text-xs rounded-bl-md'
                                            }`}>
                                                {msg.content}
                                            </div>
                                        </div>
                                    ))}
                                    {isTyping && (
                                        <div className="flex justify-start">
                                            <div className="bg-secondary-100 px-4 py-3 rounded-2xl rounded-bl-md">
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

                                {/* Message input */}
                                <div className="border-t border-secondary-200 px-4 py-3 relative flex-shrink-0">
                                    {showCannedDropdown && filteredCanned.length > 0 && (
                                        <div className="absolute bottom-full left-4 right-4 mb-1 bg-white border border-secondary-200 rounded-xl shadow-lg max-h-48 overflow-y-auto z-10">
                                            {filteredCanned.slice(0, 8).map(r => (
                                                <button
                                                    key={r.id}
                                                    onClick={() => selectCannedResponse(r)}
                                                    className="w-full text-left px-4 py-2.5 hover:bg-secondary-50 transition-colors border-b border-secondary-100 last:border-b-0"
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-sm font-medium text-secondary-900">{r.title}</span>
                                                        {r.shortcut && (
                                                            <span className="px-1.5 py-0.5 bg-secondary-100 text-secondary-500 text-[10px] font-mono rounded">
                                                                /{r.shortcut}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-[11px] text-secondary-500 truncate mt-0.5">{r.content}</p>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <form onSubmit={handleSend} className="flex items-center gap-2">
                                        <input
                                            ref={inputRef}
                                            type="text"
                                            value={inputText}
                                            onChange={handleInputChange}
                                            onKeyDown={(e) => { if (e.key === 'Escape') setShowCannedDropdown(false); }}
                                            placeholder="Type your reply... (/ for quick replies)"
                                            className="flex-1 px-4 py-2.5 text-sm bg-secondary-50 rounded-xl outline-none border border-transparent focus:border-primary-300 transition-colors"
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
                                <div className="w-16 h-16 rounded-full bg-secondary-100 flex items-center justify-center mb-4">
                                    <MessageCircle className="w-8 h-8 text-secondary-400" />
                                </div>
                                <h3 className="text-lg font-bold text-secondary-900 mb-2">No chat selected</h3>
                                <p className="text-sm text-secondary-500">
                                    {queue.length > 0
                                        ? 'Accept a waiting chat from the queue on the left.'
                                        : 'Waiting for visitors to request live support...'}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* ── Right: Session Info + Team Roster ── */}
                    {showRightPanel && (
                        <div className="w-64 flex-shrink-0 bg-white rounded-2xl border border-secondary-200 overflow-hidden flex flex-col">
                            {/* Tabs — only show tab bar when both tabs are relevant */}
                            {selectedChat ? (
                                <div className="flex border-b border-secondary-200 flex-shrink-0">
                                    <button
                                        onClick={() => setRightPanelTab('session')}
                                        className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[12px] font-medium transition-colors ${
                                            rightPanelTab === 'session'
                                                ? 'text-primary-600 border-b-2 border-primary-500'
                                                : 'text-secondary-500 hover:text-secondary-700'
                                        }`}
                                    >
                                        <Info className="w-3.5 h-3.5" />
                                        Session
                                    </button>
                                    <button
                                        onClick={() => setRightPanelTab('team')}
                                        className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[12px] font-medium transition-colors ${
                                            rightPanelTab === 'team'
                                                ? 'text-primary-600 border-b-2 border-primary-500'
                                                : 'text-secondary-500 hover:text-secondary-700'
                                        }`}
                                    >
                                        <Users className="w-3.5 h-3.5" />
                                        Team
                                    </button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-1.5 px-4 py-3 border-b border-secondary-200 flex-shrink-0">
                                    <Users className="w-3.5 h-3.5 text-primary-600" />
                                    <span className="text-[12px] font-medium text-primary-600">Team</span>
                                </div>
                            )}

                            <div className="flex-1 overflow-y-auto">
                                {/* Session Info Tab */}
                                {selectedChat && rightPanelTab === 'session' && (
                                    <div className="p-4 space-y-4">
                                        {!selectedChat ? (
                                            <p className="text-sm text-secondary-400 text-center py-8">Select a chat to view details</p>
                                        ) : !sessionInfo ? (
                                            <div className="flex justify-center py-8">
                                                <Loader2 className="w-5 h-5 animate-spin text-secondary-400" />
                                            </div>
                                        ) : (
                                            <>
                                                {sessionInfo.lead_info && (
                                                    <div className="space-y-2.5">
                                                        <h5 className="text-[11px] font-bold uppercase tracking-wider text-secondary-500">Visitor</h5>
                                                        {sessionInfo.lead_info.name && (
                                                            <div className="flex items-center gap-2 text-sm text-secondary-700">
                                                                <User className="w-3.5 h-3.5 text-secondary-400 flex-shrink-0" />
                                                                <span className="truncate">{sessionInfo.lead_info.name}</span>
                                                            </div>
                                                        )}
                                                        {sessionInfo.lead_info.email && (
                                                            <div className="flex items-center gap-2 text-sm text-secondary-700">
                                                                <Mail className="w-3.5 h-3.5 text-secondary-400 flex-shrink-0" />
                                                                <span className="truncate">{sessionInfo.lead_info.email}</span>
                                                            </div>
                                                        )}
                                                        {sessionInfo.lead_info.phone && (
                                                            <div className="flex items-center gap-2 text-sm text-secondary-700">
                                                                <Phone className="w-3.5 h-3.5 text-secondary-400 flex-shrink-0" />
                                                                <span>{sessionInfo.lead_info.phone}</span>
                                                            </div>
                                                        )}
                                                        {sessionInfo.lead_info.company && (
                                                            <div className="flex items-center gap-2 text-sm text-secondary-700">
                                                                <Building2 className="w-3.5 h-3.5 text-secondary-400 flex-shrink-0" />
                                                                <span className="truncate">{sessionInfo.lead_info.company}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                <div className="space-y-2.5 pt-2 border-t border-secondary-100">
                                                    <h5 className="text-[11px] font-bold uppercase tracking-wider text-secondary-500">Session</h5>
                                                    {sessionInfo.location && (
                                                        <div className="flex items-center gap-2 text-sm text-secondary-700">
                                                            <MapPin className="w-3.5 h-3.5 text-secondary-400 flex-shrink-0" />
                                                            <span className="truncate">{sessionInfo.location}</span>
                                                        </div>
                                                    )}
                                                    {sessionInfo.device && (
                                                        <div className="flex items-center gap-2 text-sm text-secondary-700">
                                                            <Monitor className="w-3.5 h-3.5 text-secondary-400 flex-shrink-0" />
                                                            <span className="truncate">{sessionInfo.device}</span>
                                                        </div>
                                                    )}
                                                    {sessionInfo.handoff_reason && (
                                                        <div className="flex items-start gap-2 text-sm text-secondary-700">
                                                            <MessageCircle className="w-3.5 h-3.5 text-secondary-400 flex-shrink-0 mt-0.5" />
                                                            <span className="break-words">{sessionInfo.handoff_reason}</span>
                                                        </div>
                                                    )}
                                                    {sessionInfo.created_at && (
                                                        <div className="flex items-center gap-2 text-sm text-secondary-700">
                                                            <Clock className="w-3.5 h-3.5 text-secondary-400 flex-shrink-0" />
                                                            <span>{new Date(sessionInfo.created_at).toLocaleTimeString()}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}

                                {/* Team Roster Tab */}
                                {(!selectedChat || rightPanelTab === 'team') && (
                                    <div className="p-4">
                                        <h5 className="text-[11px] font-bold uppercase tracking-wider text-secondary-500 mb-3">
                                            Operators ({operatorsList.length})
                                        </h5>
                                        {operatorsList.length === 0 ? (
                                            <p className="text-sm text-secondary-400 text-center py-6">No operators yet</p>
                                        ) : (
                                            <div className="space-y-2">
                                                {operatorsList.map(operator => {
                                                    const status = getOperatorStatus(operator);
                                                    return (
                                                        <div key={operator.id} className="flex items-center gap-2.5 py-1.5">
                                                            <div className="relative flex-shrink-0">
                                                                <div className="w-7 h-7 rounded-full bg-secondary-100 flex items-center justify-center text-secondary-600 font-bold text-[11px]">
                                                                    {operator.name?.charAt(0).toUpperCase() || '?'}
                                                                </div>
                                                                <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${statusDotClass(status)}`} />
                                                            </div>
                                                            <div className="min-w-0">
                                                                <p className="text-sm font-medium text-secondary-900 truncate">{operator.name}</p>
                                                                <p className="text-[10px] text-secondary-400">
                                                                    {status === 'online' && 'Online'}
                                                                    {status === 'busy' && `Busy · ${operator.active_chats} chat${operator.active_chats !== 1 ? 's' : ''}`}
                                                                    {status === 'offline' && 'Offline'}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Transfer Modal */}
            {showTransferModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
                        <div className="flex items-center justify-between px-5 py-4 border-b border-secondary-100">
                            <h2 className="font-semibold text-secondary-900 flex items-center gap-2">
                                <ArrowRightLeft className="w-4 h-4" />
                                Transfer Chat
                            </h2>
                            <button onClick={() => setShowTransferModal(false)} className="text-secondary-400 hover:text-secondary-600">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            {transferOperators.length > 0 && (
                                <div>
                                    <h3 className="text-sm font-medium text-secondary-700 mb-2">Online Operators</h3>
                                    <div className="space-y-1">
                                        {transferOperators.map(operator => (
                                            <button
                                                key={operator.id}
                                                onClick={() => handleTransfer(operator.id, null)}
                                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary-50 transition-colors text-left"
                                            >
                                                <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-sm">
                                                    {operator.name?.charAt(0).toUpperCase() || '?'}
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-secondary-900">{operator.name}</p>
                                                    <p className="text-[11px] text-secondary-500">
                                                        {operator.department_name || 'No department'} · {operator.active_chats || 0} active
                                                    </p>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {transferDepartments.length > 0 && (
                                <div>
                                    <h3 className="text-sm font-medium text-secondary-700 mb-2">Departments</h3>
                                    <div className="space-y-1">
                                        {transferDepartments.map(dept => (
                                            <button
                                                key={dept.id}
                                                onClick={() => handleTransfer(null, dept.id)}
                                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary-50 transition-colors text-left"
                                            >
                                                <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 font-bold text-sm">
                                                    {dept.name?.charAt(0).toUpperCase() || '?'}
                                                </div>
                                                <p className="text-sm font-medium text-secondary-900">{dept.name}</p>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {transferOperators.length === 0 && transferDepartments.length === 0 && (
                                <p className="text-sm text-secondary-500 text-center py-4">No operators online or departments available.</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
