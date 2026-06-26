import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Headphones, Send, X, User, Mail, MapPin, Monitor, MessageCircle,
    Loader2, Circle, ArrowRightLeft, ChevronRight, ChevronLeft,
    Users, Info, Phone, Building2, Clock, Paperclip, Zap, TrendingUp,
} from 'lucide-react';
import {
    acceptChat, closeOperatorChat, toggleOperatorStatus, getMyOperatorStatus, getChatHistory,
    getCannedResponses, transferChat, getOperators, getDepartments, getSessionDetails, getOperatorQueue,
    uploadOperatorChatFile, getCurrentSubscription,
    getQualifiedBotSessions, sendConnectRequest, cancelConnectRequest,
} from '../services/api';
import { useNavigate } from 'react-router-dom';
import { Lock, Sparkles } from 'lucide-react';
import { getAuthItem } from '../utils/authStorage';
import PageHeader from '../components/ui/PageHeader';
import NoBotState from '../components/NoBotState';
import { useBotContext } from '../context/BotContext';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

/**
 * Render bot markdown in admin chat panels.
 * Handles bold, italic, and line-breaks — the only patterns the LLM emits
 * that look broken when displayed as raw text.
 */
const BotMessage = ({ content }) => {
    if (!content) return null;
    const segments = content.split('\n');
    return (
        <span>
            {segments.map((line, li) => {
                // Split line by bold (**…**) then italic (*…*) tokens
                const parts = [];
                let remaining = line;
                let key = 0;
                while (remaining.length > 0) {
                    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
                    const italicMatch = remaining.match(/^(.*?)\*(.+?)\*(.*)/s);
                    if (boldMatch && (!italicMatch || boldMatch[0].indexOf('**') <= italicMatch[0].indexOf('*'))) {
                        if (boldMatch[1]) parts.push(<React.Fragment key={key++}>{boldMatch[1]}</React.Fragment>);
                        parts.push(<strong key={key++}>{boldMatch[2]}</strong>);
                        remaining = boldMatch[3];
                    } else if (italicMatch) {
                        if (italicMatch[1]) parts.push(<React.Fragment key={key++}>{italicMatch[1]}</React.Fragment>);
                        parts.push(<em key={key++}>{italicMatch[2]}</em>);
                        remaining = italicMatch[3];
                    } else {
                        parts.push(<React.Fragment key={key++}>{remaining}</React.Fragment>);
                        remaining = '';
                    }
                }
                return (
                    <React.Fragment key={li}>
                        {parts}
                        {li < segments.length - 1 && <br />}
                    </React.Fragment>
                );
            })}
        </span>
    );
};

/** Only allow https: URLs for file attachments (blocks javascript:, data:, etc.) */
const isSafeFileUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);

/** Parse a history message, extracting file_url/filename/content_type from markdown file syntax. */
const FILE_RE = /^\[File:\s*(.+?)\]\((.+?)\)$/;
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const parseHistoryMessage = (m, i) => {
    const base = { id: m.id ?? i, dbId: m.id, role: m.role, content: m.content, timestamp: m.timestamp };
    const match = m.content?.match(FILE_RE);
    if (match && isSafeFileUrl(match[2])) {
        const filename = match[1];
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        base.file_url = match[2];
        base.filename = filename;
        base.content_type = IMAGE_EXTS.has(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : (ext === 'pdf' ? 'application/pdf' : 'text/plain');
    }
    return base;
};

export default function LiveChat({ embedded = false }) {
    const { bots, loading: botsLoading } = useBotContext();

    // Core operator state
    const [isOnline, setIsOnline] = useState(false);
    // Plan-feature gate for live chat. ``null`` = not yet loaded (treat as
    // gated so the Go Online button can't be clicked before we know the
    // answer). ``true`` / ``false`` after the /subscriptions/current fetch.
    const [liveChatFeatureEnabled, setLiveChatFeatureEnabled] = useState(null);
    const [currentPlanName, setCurrentPlanName] = useState(null);
    const [showUpgradeModal, setShowUpgradeModal] = useState(false);
    const navigateRouter = useNavigate();
    const [operatorName, setOperatorName] = useState('');
    const [duplicateTabDetected, setDuplicateTabDetected] = useState(false);
    // operatorId is needed for owner accounts (auth_type='client') to pin REST calls
    // to the exact operator record rather than using the fragile .limit(1) DB fallback.
    const operatorIdRef = useRef(
        localStorage.getItem('operator_id') ? Number(localStorage.getItem('operator_id')) : null
    );

    // Chat state
    const [queue, setQueue] = useState([]);             // [{ session_id, name, reason }]
    const [activeChats, setActiveChats] = useState([]); // session IDs
    const [chatNames, setChatNames] = useState({});     // session_id → { name, reason }
    const [selectedChat, setSelectedChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [hasMoreMessages, setHasMoreMessages] = useState(false);
    const [loadingEarlier, setLoadingEarlier] = useState(false);
    const [inputText, setInputText] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [unreadCounts, setUnreadCounts] = useState({}); // session_id → number
    const [lastMessages, setLastMessages] = useState({}); // session_id → preview string

    // Canned responses
    const [cannedResponses, setCannedResponses] = useState([]);
    const [showCannedDropdown, setShowCannedDropdown] = useState(false);
    const [cannedFilter, setCannedFilter] = useState('');
    const [cannedHighlightIndex, setCannedHighlightIndex] = useState(0);

    // Accept loading state
    const [acceptingSessionId, setAcceptingSessionId] = useState(null);

    // Transfer modal
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [transferOperators, setTransferOperators] = useState([]);
    const [transferDepartments, setTransferDepartments] = useState([]);
    // Two-step transfer: null → { id, dept, label } → confirmed
    const [transferTarget, setTransferTarget] = useState(null);

    // Right panel (session info + team roster)
    const [showRightPanel, setShowRightPanel] = useState(true);
    const [rightPanelTab, setRightPanelTab] = useState('team'); // 'session' | 'team'
    const [sessionInfo, setSessionInfo] = useState(null);
    const [operatorsList, setOperatorsList] = useState([]); // full roster from REST + WS updates

    // Visitor connection status per session: session_id → 'online' | 'disconnected'
    const [visitorStatus, setVisitorStatus] = useState({});

    // ── "Chatting with AI" qualified sessions ────────────────────────────────
    // Visitors currently in bot-only mode whose BANT qualification has marked
    // ≥2 of 4 dimensions. Surfaced so operators can proactively engage warm
    // leads before they bounce. Refreshed via 15s poll + qualified_bot_changed
    // WebSocket pings + after any successful takeover.
    const [qualifiedBotSessions, setQualifiedBotSessions] = useState([]);
    const [qualifiedLoading, setQualifiedLoading] = useState(false);
    const [takeoverSessionId, setTakeoverSessionId] = useState(null);
    const [takeoverError, setTakeoverError] = useState(null);
    const qualifiedPollIntervalRef = useRef(null);
    const takeoverErrorTimerRef = useRef(null);

    // Pending connect-request map: session_id → { request_id, expires_at,
    // status: 'pending' | 'declined' | 'accepted' | 'expired', last_change }.
    // Operator UX: button cycles Connect → Awaiting response → Declined (auto-resets).
    const [connectRequests, setConnectRequests] = useState({});
    const connectRequestTimersRef = useRef({}); // session_id → timeout handle

    // Read-only AI preview: when operator clicks a qualified-bot session we
    // load its history into a separate "preview" pane (kept apart from the
    // ``messages`` state used for owned live chats so the two don't collide).
    const [previewSession, setPreviewSession] = useState(null); // qualified-bot row
    const [previewMessages, setPreviewMessages] = useState([]);
    const [previewLoading, setPreviewLoading] = useState(false);
    const previewPollIntervalRef = useRef(null);
    const previewSessionIdRef = useRef(null);

    // Connection state
    const [reconnectCount, setReconnectCount] = useState(0);
    const [connectionLost, setConnectionLost] = useState(false);

    // Separate error states for different contexts (replaces single closeChatError)
    const [closeChatError, setCloseChatError] = useState(null);
    const [sendError, setSendError] = useState(null);
    const [fileError, setFileError] = useState(null);
    const closeChatErrorTimerRef = useRef(null);
    const sendErrorTimerRef = useRef(null);
    const fileErrorTimerRef = useRef(null);
    // Holds the latest handleSelectChat so keyboard-shortcut listener can call
    // it without re-binding the document keydown handler on every render.
    const handleSelectChatRef = useRef(null);

    // Custom confirmation modal (replaces window.confirm)
    const [confirmModal, setConfirmModal] = useState(null); // { title, message, onConfirm }

    // Chat history cache: session_id → messages array (avoids re-fetching on every click)
    const chatHistoryCacheRef = useRef({});

    // File upload
    const fileInputRef = useRef(null);
    const [fileUploading, setFileUploading] = useState(false);
    // Pre-send preview: { file, previewUrl, caption, isImage } — null = no pending file
    const [pendingFile, setPendingFile] = useState(null);
    // Lightbox: URL of image to show full-screen
    const [lightboxSrc, setLightboxSrc] = useState(null);

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
    const typingTimeoutRef = useRef(null);
    // session_id → highest user message dbId acknowledged via read_receipt.
    // Prevents duplicate WS sends when messages re-render or the tab toggles.
    const lastSentReadIdRef = useRef({});

    const emitReadReceiptForSelected = useCallback(() => {
        const sessionId = selectedChatRef.current;
        if (!sessionId) return;
        const socket = wsRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

        let maxDbId = 0;
        for (const m of messages) {
            if (m.role === 'user' && typeof m.dbId === 'number' && m.dbId > maxDbId) {
                maxDbId = m.dbId;
            }
        }
        if (!maxDbId) return;
        if ((lastSentReadIdRef.current[sessionId] || 0) >= maxDbId) return;

        try {
            socket.send(JSON.stringify({
                type: 'read_receipt',
                session_id: sessionId,
                last_read_id: maxDbId,
            }));
            lastSentReadIdRef.current[sessionId] = maxDbId;
        } catch { /* socket flaked — visibility/select effect will retry */ }
    }, [messages]);

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
                .catch(() => setSessionInfo({ error: true }));
        } else {
            setSessionInfo(null);
        }
    }, [selectedChat]);

    // Send read_receipt to the visitor whenever the operator opens a chat
    // or new user messages render while the chat is the selected one.
    useEffect(() => {
        emitReadReceiptForSelected();
    }, [emitReadReceiptForSelected, selectedChat]);

    // Re-emit when the operator's tab regains focus — covers the case where
    // user messages arrived while the tab was hidden.
    useEffect(() => {
        const handler = () => emitReadReceiptForSelected();
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
    }, [emitReadReceiptForSelected]);

    // Keep chatNamesRef in sync to avoid stale closures in WS handler
    useEffect(() => { chatNamesRef.current = chatNames; }, [chatNames]);

    // Request browser notification permission on mount (async to avoid race)
    useEffect(() => {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
    }, []);

    // Restore operator online status from server on mount (prevents forced manual "Go Online" on refresh)
    useEffect(() => {
        getMyOperatorStatus().then(status => {
            if (status && status.is_online) {
                setIsOnline(true);
                if (status.operator_name) setOperatorName(status.operator_name);
                if (status.operator_id) {
                    operatorIdRef.current = status.operator_id;
                    localStorage.setItem('operator_id', String(status.operator_id));
                }
            }
        });
    }, []);

    // Load the client's current plan so we can gate Live Chat behind the
    // plan.features.live_chat flag. The backend also enforces this on the
    // toggle endpoint — this fetch is purely so we can show a clean upgrade
    // CTA instead of letting the user click a button that will only error.
    useEffect(() => {
        let cancelled = false;
        getCurrentSubscription()
            .then((data) => {
                if (cancelled) return;
                const features = data?.plan?.features || {};
                setLiveChatFeatureEnabled(Boolean(features.live_chat));
                setCurrentPlanName(data?.plan?.name || null);
            })
            .catch(() => {
                if (!cancelled) {
                    // Fail closed: if we can't determine the plan, gate the
                    // feature so the visitor sees the upgrade prompt rather
                    // than a confusing silent failure on click.
                    setLiveChatFeatureEnabled(false);
                }
            });
        return () => { cancelled = true; };
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
            new Notification(title, { body, icon: '/oye_favicon_cropped.png' });
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

    const fetchQualifiedBotSessions = useCallback(async () => {
        try {
            setQualifiedLoading(true);
            const data = await getQualifiedBotSessions(50);
            setQualifiedBotSessions(Array.isArray(data?.sessions) ? data.sessions : []);
        } catch {
            // Silent — operator already has Active/Waiting columns; failing
            // this fetch shouldn't block the rest of the dashboard.
        } finally {
            setQualifiedLoading(false);
        }
    }, []);

    const removeSessionFromQueue = useCallback((sessionId) => {
        setQueue(prev => prev.filter(item => item.session_id !== sessionId));
        queueSnapshotRef.current = new Set(
            [...queueSnapshotRef.current].filter(existingSessionId => existingSessionId !== sessionId)
        );
    }, []);

    // WebSocket: connect when online, heartbeat, auto-reconnect with exponential backoff
    // NOTE: selectedChat intentionally NOT in deps — use selectedChatRef to prevent reconnect on every chat click
    useEffect(() => {
        const apiKey = getAuthItem('admin_token');
        const authType = getAuthItem('auth_type');
        if (!apiKey || !isOnline) return;

        clearTimeout(reconnectTimerRef.current);
        manualCloseRef.current = false;

        const wsUrl = API_URL.replace(/^http/, 'ws').replace(/\/+$/, '');
        // Pass auth via Sec-WebSocket-Protocol header instead of query params
        // to avoid leaking credentials in server access logs and browser history.
        const subprotocol = authType === 'operator'
            ? `operator-key.${apiKey}`
            : `api-key.${apiKey}`;
        const socket = new WebSocket(`${wsUrl}/ws/operator`, [subprotocol]);
        wsRef.current = socket;

        socket.onopen = () => {
            console.log('[LiveChat] WebSocket connected');
            reconnectAttemptsRef.current = 0;
            setConnectionLost(false);

            // Visibility-aware heartbeat: shorter interval when tab is active,
            // longer when backgrounded (browsers throttle timers in hidden tabs).
            const startPing = () => {
                clearInterval(pingIntervalRef.current);
                // Adaptive heartbeat: 25s when tab visible, 50s when hidden
                const delay = document.visibilityState === 'visible' ? 25000 : 50000;
                pingIntervalRef.current = setInterval(() => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type: 'ping' }));
                    }
                }, delay);
            };
            startPing();

            // Adjust heartbeat frequency on tab focus change.
            const visHandler = () => startPing();
            document.addEventListener('visibilitychange', visHandler);
            // Store cleanup ref on the socket object for the return() cleanup below.
            socket._visHandler = visHandler;
        };

        socket.onmessage = (event) => {
            let data;
            try { data = JSON.parse(event.data); } catch { return; }


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
                    // Re-broadcast so the LiveChatStatusPill on the Support
                    // page header can refresh instantly instead of waiting
                    // for its 5s poll. Decoupled via a window CustomEvent so
                    // we don't have to introduce a context just for this.
                    window.dispatchEvent(new CustomEvent('oyechats:operators-changed'));
                    break;

                case 'message': {
                    const currentSelected = selectedChatRef.current;
                    // Use server-assigned ID for deduplication when available
                    const msgId = data.id ? `srv-${data.id}` : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
                    // Track last message preview for sidebar
                    setLastMessages(prev => ({
                        ...prev,
                        [data.session_id]: data.content?.slice(0, 60) || '',
                    }));
                    if (data.session_id === currentSelected) {
                        setMessages(prev => {
                            // Deduplicate: skip if server ID already exists (echo of own message)
                            if (data.id && prev.some(m => m.dbId === data.id)) return prev;
                            return [...prev, {
                                id: msgId,
                                dbId: data.id || null,
                                role: data.role,
                                content: data.content,
                                timestamp: data.timestamp,
                            }];
                        });
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

                case 'file': {
                    const currentSelected = selectedChatRef.current;
                    if (data.session_id === currentSelected && isSafeFileUrl(data.file_url)) {
                        setMessages(prev => [...prev, {
                            id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                            role: data.role || 'user',
                            content: data.file_url,
                            file_url: data.file_url,
                            filename: data.filename,
                            content_type: data.content_type,
                            timestamp: data.timestamp,
                        }]);
                    } else {
                        setUnreadCounts(prev => ({
                            ...prev,
                            [data.session_id]: (prev[data.session_id] || 0) + 1,
                        }));
                    }
                    break;
                }

                case 'visitor_typing':
                    if (data.session_id === selectedChatRef.current) {
                        setIsTyping(true);
                        clearTimeout(typingTimeoutRef.current);
                        typingTimeoutRef.current = setTimeout(() => setIsTyping(false), 3000);
                    }
                    break;

                case 'visitor_stopped_typing':
                    if (data.session_id === selectedChatRef.current) {
                        clearTimeout(typingTimeoutRef.current);
                        setIsTyping(false);
                    }
                    break;

                case 'chat_accepted': {
                    setActiveChats(prev => [...new Set([...prev, data.session_id])]);
                    // ``bot_name`` is the bot the visitor was chatting
                    // with — surfaced to the operator UI so they know
                    // which product/intent the conversation came from.
                    const chatNameEntry = {
                        name: data.visitor_name || 'Anonymous',
                        reason: data.reason || null,
                        botName: data.bot_name || null,
                        botId: data.bot_id || null,
                    };
                    chatNamesRef.current = { ...chatNamesRef.current, [data.session_id]: chatNameEntry };
                    setChatNames(prev => ({ ...prev, [data.session_id]: chatNameEntry }));
                    setVisitorStatus(prev => ({ ...prev, [data.session_id]: 'online' }));
                    removeSessionFromQueue(data.session_id);
                    // Notify operator of new/transferred chat
                    playNotification();
                    sendBrowserNotification(
                        'Chat assigned',
                        `${data.visitor_name || 'A visitor'} is now connected`
                    );
                    break;
                }

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
                        setIsTyping(false);
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
                                next[c.session_id] = {
                                    name: c.visitor_name || 'Anonymous',
                                    reason: c.reason || null,
                                    botName: c.bot_name || null,
                                    botId: c.bot_id || null,
                                };
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
                        // Reload history for currently selected chat after reconnect
                        const currentSel = selectedChatRef.current;
                        if (currentSel) {
                            getChatHistory(currentSel)
                                .then(history => {
                                    setMessages(history.map(parseHistoryMessage));
                                    setHasMoreMessages(history.length === 50);
                                })
                                .catch(() => {});
                        }
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

                case 'qualified_bot_changed':
                    // Lightweight ping — refetch the qualified-bot sessions list.
                    fetchQualifiedBotSessions();
                    break;

                case 'connect_request_resolved': {
                    const outcome = data.outcome; // accepted | declined | expired | cancelled
                    const sid = data.session_id;
                    if (!sid) break;
                    if (outcome === 'accepted') {
                        // The accept_chat broadcast that follows will create the
                        // active-chat row; here we just close the preview pane
                        // if the operator was watching this session.
                        if (previewSessionIdRef.current === sid) {
                            previewSessionIdRef.current = null;
                            setPreviewSession(null);
                            setPreviewMessages([]);
                            clearInterval(previewPollIntervalRef.current);
                            previewPollIntervalRef.current = null;
                        }
                        clearTimeout(connectRequestTimersRef.current[sid]);
                        delete connectRequestTimersRef.current[sid];
                        setConnectRequests(prev => {
                            if (!(sid in prev)) return prev;
                            const next = { ...prev };
                            delete next[sid];
                            return next;
                        });
                    } else {
                        // declined | expired | cancelled — flash the chip then auto-clear.
                        setConnectRequests(prev => ({
                            ...prev,
                            [sid]: {
                                ...(prev[sid] || {}),
                                status: outcome,
                                visitor_name: data.visitor_name || prev[sid]?.visitor_name || null,
                                resolved_at: Date.now(),
                            },
                        }));
                        clearTimeout(connectRequestTimersRef.current[sid]);
                        connectRequestTimersRef.current[sid] = setTimeout(() => {
                            setConnectRequests(prev => {
                                if (!(sid in prev)) return prev;
                                const next = { ...prev };
                                delete next[sid];
                                return next;
                            });
                            delete connectRequestTimersRef.current[sid];
                        }, 6000);
                    }
                    break;
                }

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

        socket.onclose = (event) => {
            console.log('[LiveChat] WebSocket closed', event.code, event.reason);
            clearInterval(pingIntervalRef.current);

            // Closed because another tab connected (code 4001) — don't reconnect
            if (event.code === 4001) {
                setConnectionLost(true);
                setDuplicateTabDetected(true);
                manualCloseRef.current = true;
                return;
            }

            if (!manualCloseRef.current) {
                // Show reconnecting banner after 2 failed attempts so brief blips
                // don't flash the UI, but still surface persistent failures.
                if (reconnectAttemptsRef.current >= 2) {
                    setConnectionLost(true);
                }
                // Never give up — operators must stay connected.
                // Exponential backoff with jitter: 3s → 6s → 12s → 24s → 30s (capped).
                const base = Math.min(3000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
                const delay = Math.round(base * (0.9 + Math.random() * 0.2));
                reconnectAttemptsRef.current += 1;
                reconnectTimerRef.current = setTimeout(() => setReconnectCount(c => c + 1), delay);
            }
        };

        return () => {
            manualCloseRef.current = true;
            clearInterval(pingIntervalRef.current);
            clearTimeout(reconnectTimerRef.current);
            clearTimeout(closeChatErrorTimerRef.current);
            if (socket._visHandler) {
                document.removeEventListener('visibilitychange', socket._visHandler);
            }
            socket.close();
            wsRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOnline, reconnectCount, removeSessionFromQueue, syncQueueState, fetchQualifiedBotSessions]);

    // Visibility + network change handlers — reconnect immediately when the operator
    // returns to the tab or network is restored, with a reset backoff counter so
    // they aren't stuck waiting 30 s after a routine tab switch.
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible' || !isOnline) return;
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
                // Verify the connection is still alive with an immediate ping.
                try { ws.send(JSON.stringify({ type: 'ping' })); } catch { ws.close(); }
            } else if (!manualCloseRef.current) {
                // Connection died while backgrounded — reconnect immediately.
                reconnectAttemptsRef.current = 0;
                setReconnectCount(c => c + 1);
            }
        };

        const handleOnline = () => {
            if (!isOnline || manualCloseRef.current) return;
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                reconnectAttemptsRef.current = 0;
                setReconnectCount(c => c + 1);
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('online', handleOnline);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('online', handleOnline);
        };
    }, [isOnline]);

    // Queue polling — always runs as a safety net so lost WS messages
    // don't leave the operator with a stale (empty) queue view.
    // Faster cadence (8s) when WS is down; slower (20s) when connected.
    useEffect(() => {
        clearInterval(queuePollIntervalRef.current);

        if (!isOnline) {
            queueSnapshotRef.current = new Set();
            return undefined;
        }

        const pollInterval = connectionLost ? 8000 : 20000;
        fetchQueueSnapshot();
        queuePollIntervalRef.current = setInterval(fetchQueueSnapshot, pollInterval);

        return () => {
            clearInterval(queuePollIntervalRef.current);
            queuePollIntervalRef.current = null;
        };
    }, [isOnline, connectionLost, fetchQueueSnapshot]);

    // Load operators roster when going online
    useEffect(() => {
        if (isOnline) fetchOperatorsList();
    }, [isOnline, fetchOperatorsList]);

    // Qualified bot-sessions polling — 15s steady-state, 8s when WS is down.
    // The WS push ('qualified_bot_changed') keeps it near-real-time; the poll
    // is just a safety net for missed events / dropped sockets.
    useEffect(() => {
        clearInterval(qualifiedPollIntervalRef.current);
        if (!isOnline) {
            setQualifiedBotSessions([]);
            return undefined;
        }
        const pollInterval = connectionLost ? 8000 : 15000;
        fetchQualifiedBotSessions();
        qualifiedPollIntervalRef.current = setInterval(fetchQualifiedBotSessions, pollInterval);
        return () => {
            clearInterval(qualifiedPollIntervalRef.current);
            qualifiedPollIntervalRef.current = null;
        };
    }, [isOnline, connectionLost, fetchQualifiedBotSessions]);

    const clearConnectRequestState = useCallback((sessionId) => {
        clearTimeout(connectRequestTimersRef.current[sessionId]);
        delete connectRequestTimersRef.current[sessionId];
        setConnectRequests(prev => {
            if (!(sessionId in prev)) return prev;
            const next = { ...prev };
            delete next[sessionId];
            return next;
        });
    }, []);

    const handleSendConnectRequest = useCallback(async (sessionId, visitorName) => {
        if (!sessionId) return;
        setTakeoverError(null);
        setTakeoverSessionId(sessionId);
        try {
            const result = await sendConnectRequest(sessionId, operatorIdRef.current);
            setConnectRequests(prev => ({
                ...prev,
                [sessionId]: {
                    request_id: result?.request_id || null,
                    operator_name: result?.operator_name || operatorName || 'Operator',
                    visitor_name: visitorName || null,
                    expires_at: result?.expires_at || null,
                    status: 'pending',
                    sent_at: Date.now(),
                },
            }));
            // Soft timeout safety — if the visitor never responds before the
            // server-side TTL, flip the chip to 'expired' and clear shortly
            // after so the operator can re-issue.
            const ttlMs = result?.expires_at
                ? Math.max(0, result.expires_at * 1000 - Date.now())
                : 90_000;
            clearTimeout(connectRequestTimersRef.current[sessionId]);
            connectRequestTimersRef.current[sessionId] = setTimeout(() => {
                setConnectRequests(prev => {
                    const current = prev[sessionId];
                    if (!current || current.status !== 'pending') return prev;
                    return {
                        ...prev,
                        [sessionId]: { ...current, status: 'expired', resolved_at: Date.now() },
                    };
                });
                connectRequestTimersRef.current[sessionId] = setTimeout(() => {
                    clearConnectRequestState(sessionId);
                }, 6000);
            }, ttlMs + 2000);
        } catch (err) {
            const msg = err?.message || err?.detail || 'Could not send connect request';
            setTakeoverError(msg);
            clearTimeout(takeoverErrorTimerRef.current);
            takeoverErrorTimerRef.current = setTimeout(() => setTakeoverError(null), 6000);
        } finally {
            setTakeoverSessionId(null);
        }
    }, [operatorName, clearConnectRequestState]);

    const handleCancelConnectRequest = useCallback(async (sessionId) => {
        if (!sessionId) return;
        clearConnectRequestState(sessionId);
        try {
            await cancelConnectRequest(sessionId);
        } catch { /* best-effort — server-side TTL will reap regardless */ }
    }, [clearConnectRequestState]);

    // Read-only AI conversation preview ────────────────────────────────────
    const stopPreviewPolling = useCallback(() => {
        clearInterval(previewPollIntervalRef.current);
        previewPollIntervalRef.current = null;
    }, []);

    const closePreviewSession = useCallback(() => {
        previewSessionIdRef.current = null;
        setPreviewSession(null);
        setPreviewMessages([]);
        stopPreviewPolling();
    }, [stopPreviewPolling]);

    const refreshPreviewMessages = useCallback(async (sessionId) => {
        if (!sessionId) return;
        try {
            const history = await getChatHistory(sessionId);
            if (previewSessionIdRef.current !== sessionId) return;
            const parsed = (history || []).map(parseHistoryMessage);
            setPreviewMessages(parsed);
        } catch { /* preview is best-effort */ }
    }, []);

    const openPreviewSession = useCallback(async (qs) => {
        if (!qs?.session_id) return;
        // Switching previews — make sure we don't keep polling the old one.
        if (previewSessionIdRef.current && previewSessionIdRef.current !== qs.session_id) {
            stopPreviewPolling();
        }
        previewSessionIdRef.current = qs.session_id;
        setPreviewSession(qs);
        // Drop any owned-chat selection so the center pane shows the preview.
        setSelectedChat(null);
        setPreviewLoading(true);
        try {
            await refreshPreviewMessages(qs.session_id);
        } finally {
            setPreviewLoading(false);
        }
        stopPreviewPolling();
        previewPollIntervalRef.current = setInterval(() => {
            refreshPreviewMessages(qs.session_id);
        }, 4000);
    }, [refreshPreviewMessages, stopPreviewPolling]);

    // Stop preview polling when leaving the page / going offline.
    useEffect(() => {
        if (!isOnline) closePreviewSession();
        return undefined;
    }, [isOnline, closePreviewSession]);

    // Clear all timers on unmount.
    useEffect(() => () => {
        Object.values(connectRequestTimersRef.current).forEach(clearTimeout);
        connectRequestTimersRef.current = {};
        clearTimeout(takeoverErrorTimerRef.current);
        stopPreviewPolling();
    }, [stopPreviewPolling]);

    // Auto-scroll messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isTyping]);

    // Keyboard shortcuts — Ctrl+1…9 to switch active chats, Escape to close modal
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                if (showTransferModal) { setShowTransferModal(false); setTransferTarget(null); }
                if (showCannedDropdown) { setShowCannedDropdown(false); setCannedFilter(''); }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '9') {
                const idx = parseInt(e.key, 10) - 1;
                if (idx < activeChats.length) {
                    e.preventDefault();
                    handleSelectChatRef.current?.(activeChats[idx]);
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [showTransferModal, showCannedDropdown, activeChats]);

    // Keep handleSelectChatRef pointing at the latest handleSelectChat closure
    // so the keyboard-shortcut effect above can call the current version
    // without re-binding its document listener on every render.
    useEffect(() => {
        handleSelectChatRef.current = handleSelectChat;
    });

    // Load canned responses once
    useEffect(() => {
        getCannedResponses().then(data => setCannedResponses(data.responses || [])).catch(() => {});
    }, []);

    const executeToggleStatus = async () => {
        try {
            const result = await toggleOperatorStatus();
            setIsOnline(result.is_online);
            setOperatorName(result.operator_name);
            if (result.operator_id) {
                operatorIdRef.current = result.operator_id;
                localStorage.setItem('operator_id', String(result.operator_id));
            }
            if (!result.is_online) {
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
                setDuplicateTabDetected(false);
                reconnectAttemptsRef.current = 0;
            }
        } catch (e) {
            console.error('Failed to toggle status:', e);
        }
    };

    const handleToggleStatus = () => {
        // Plan-feature gate: if the customer's plan doesn't include live chat,
        // surface the upgrade modal instead of letting them go online. The
        // backend would 403 the toggle anyway — this short-circuits to a
        // useful CTA instead of an opaque failure. Only applies when the user
        // is OFFLINE trying to go ONLINE; an already-online operator (e.g.
        // grandfathered, plan downgraded mid-session) should still be able to
        // go offline cleanly via this same button.
        if (!isOnline && liveChatFeatureEnabled === false) {
            setShowUpgradeModal(true);
            return;
        }
        if (isOnline && activeChats.length > 0) {
            setConfirmModal({
                title: 'Go Offline',
                message: `You have ${activeChats.length} active chat(s). Going offline will disconnect them. Continue?`,
                onConfirm: () => { setConfirmModal(null); executeToggleStatus(); },
            });
            return;
        }
        executeToggleStatus();
    };

    const handleAcceptChat = async (sessionId, visitorName, reason) => {
        setAcceptingSessionId(sessionId);
        // Safety timeout: reset loading state if the request hangs for more than 8s
        const acceptTimeoutId = setTimeout(() => setAcceptingSessionId(null), 8000);
        try {
            await acceptChat(sessionId, operatorIdRef.current);
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
                setMessages(history.map(parseHistoryMessage));
                setHasMoreMessages(history.length === 50);
            } catch { setMessages([]); setHasMoreMessages(false); }
        } catch (e) {
            if (e?.status === 409) {
                removeSessionFromQueue(sessionId);
            } else {
                console.error('Failed to accept chat:', e);
            }
        } finally {
            clearTimeout(acceptTimeoutId);
            setAcceptingSessionId(null);
        }
    };

    const handleSelectChat = async (sessionId) => {
        // Selecting an owned chat dismisses any AI-preview pane.
        if (previewSessionIdRef.current) closePreviewSession();
        setSelectedChat(sessionId);
        setHasMoreMessages(false);

        // Use cached history for instant switching; fetch fresh in background
        const cached = chatHistoryCacheRef.current[sessionId];
        if (cached) {
            setMessages(cached);
            setHasMoreMessages(cached.length >= 50);
        }

        try {
            const history = await getChatHistory(sessionId);
            const mapped = history.map((m, i) => ({
                id: m.id ?? i, dbId: m.id, role: m.role, content: m.content, timestamp: m.timestamp,
            }));
            chatHistoryCacheRef.current[sessionId] = mapped;
            setMessages(mapped);
            setHasMoreMessages(history.length === 50);
            if (history.length > 0) {
                setLastMessages(prev => ({ ...prev, [sessionId]: history[history.length - 1].content?.slice(0, 60) || '' }));
            }
        } catch {
            if (!cached) { setMessages([]); setHasMoreMessages(false); }
        }
    };

    const handleLoadEarlier = async () => {
        const firstDbId = messages.find(m => m.dbId != null)?.dbId;
        if (!firstDbId || !selectedChat || loadingEarlier) return;
        setLoadingEarlier(true);
        try {
            const earlier = await getChatHistory(selectedChat, { beforeId: firstDbId });
            setMessages(prev => [
                ...earlier.map(parseHistoryMessage),
                ...prev,
            ]);
            setHasMoreMessages(earlier.length === 50);
        } catch { /* silent */ } finally {
            setLoadingEarlier(false);
        }
    };

    const handleCloseChat = async (sessionId) => {
        try {
            await closeOperatorChat(sessionId);
            setActiveChats(prev => prev.filter(id => id !== sessionId));
            delete chatHistoryCacheRef.current[sessionId];
            if (selectedChat === sessionId) {
                setSelectedChat(null);
                setMessages([]);
            }
        } catch (e) {
            console.error('Failed to close chat:', e);
            clearTimeout(closeChatErrorTimerRef.current);
            setCloseChatError('Failed to end chat. Please try again.');
            closeChatErrorTimerRef.current = setTimeout(() => setCloseChatError(null), 4000);
        }
    };

    const handleInputChange = (e) => {
        const val = e.target.value;
        setInputText(val);
        handleAgentTyping();
        if (val.startsWith('/')) {
            setCannedFilter(val.slice(1).toLowerCase());
            setShowCannedDropdown(true);
            setCannedHighlightIndex(0);
        } else {
            setShowCannedDropdown(false);
        }
    };

    const selectCannedResponse = (response) => {
        // Append to existing input unless the user triggered it with "/" — then replace
        setInputText(prev => prev.startsWith('/') ? response.content : prev + (prev ? ' ' : '') + response.content);
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
        setTransferTarget(null);
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
                ? { target_operator_id: targetOperatorId }
                : { target_department_id: targetDeptId };
            await transferChat(selectedChat, payload);
            setShowTransferModal(false);
            setTransferTarget(null);
            const transferredSession = selectedChat;
            setActiveChats(prev => prev.filter(c => c !== transferredSession));
            setUnreadCounts(prev => { const next = { ...prev }; delete next[transferredSession]; return next; });
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

        try {
            socket.send(JSON.stringify({ type: 'message', session_id: selectedChat, content: inputText }));
        } catch {
            setSendError('Failed to send message. Check your connection.');
            clearTimeout(sendErrorTimerRef.current);
            sendErrorTimerRef.current = setTimeout(() => setSendError(null), 4000);
            return;
        }
        setMessages(prev => [...prev, {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            role: 'operator', content: inputText, timestamp: new Date().toISOString(),
        }]);
        setLastMessages(prev => ({ ...prev, [selectedChat]: inputText.slice(0, 60) }));
        setInputText('');
        inputRef.current?.focus();
    };

    /** Validate and open the pre-send preview for a file. */
    const openFilePreview = (file) => {
        const ALLOWED_TYPES = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf', 'text/plain',
        ];
        if (!ALLOWED_TYPES.includes(file.type)) {
            setFileError('Unsupported file type. Allowed: images, PDF, TXT.');
            clearTimeout(fileErrorTimerRef.current);
            fileErrorTimerRef.current = setTimeout(() => setFileError(null), 4000);
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            setFileError('File must be under 10 MB.');
            clearTimeout(fileErrorTimerRef.current);
            fileErrorTimerRef.current = setTimeout(() => setFileError(null), 4000);
            return;
        }
        const isImage = file.type.startsWith('image/');
        setPendingFile({
            file,
            previewUrl: isImage ? URL.createObjectURL(file) : null,
            caption: '',
            isImage,
        });
    };

    const handleFileUpload = (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file && selectedChat) openFilePreview(file);
    };

    /** Paste handler — intercept clipboard images into the pre-send preview. */
    const handleOperatorPaste = (e) => {
        if (!bots[0]?.feature_flags?.file_sharing || !selectedChat) return;
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

    /** Discard pending file preview and free the object URL. */
    const cancelPendingFile = () => {
        if (pendingFile?.previewUrl) URL.revokeObjectURL(pendingFile.previewUrl);
        setPendingFile(null);
    };

    /** Upload and send the confirmed pending file. */
    const sendPendingFile = async () => {
        if (!pendingFile || !selectedChat) return;
        const { file, previewUrl, caption } = pendingFile;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPendingFile(null);
        setFileUploading(true);
        try {
            const { file_url, filename, content_type } = await uploadOperatorChatFile(file, selectedChat);

            const socket = wsRef.current;
            if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket not connected');

            socket.send(JSON.stringify({
                type: 'file',
                session_id: selectedChat,
                file_url,
                filename,
                content_type,
                role: 'operator',
            }));
            setMessages((prev) => [
                ...prev,
                {
                    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    role: 'operator',
                    content: `[File: ${filename}](${file_url})`,
                    file_url,
                    filename,
                    content_type,
                    timestamp: new Date().toISOString(),
                },
            ]);

            // Send caption as a follow-up text message if provided
            if (caption.trim()) {
                const socket2 = wsRef.current;
                if (socket2 && socket2.readyState === WebSocket.OPEN) {
                    socket2.send(JSON.stringify({ type: 'message', session_id: selectedChat, content: caption.trim() }));
                    setMessages((prev) => [
                        ...prev,
                        {
                            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                            role: 'operator',
                            content: caption.trim(),
                            timestamp: new Date().toISOString(),
                        },
                    ]);
                }
                setLastMessages((prev) => ({ ...prev, [selectedChat]: caption.trim().slice(0, 60) }));
            } else {
                setLastMessages((prev) => ({ ...prev, [selectedChat]: `📎 ${filename}` }));
            }
        } catch {
            setFileError('File upload failed. Please try again.');
            clearTimeout(fileErrorTimerRef.current);
            fileErrorTimerRef.current = setTimeout(() => setFileError(null), 4000);
        } finally {
            setFileUploading(false);
        }
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
        if (status === 'online') return 'bg-emerald-500';
        if (status === 'busy') return 'bg-amber-400';
        return 'bg-surface-300';
    };

    if (!botsLoading && bots.length === 0) {
        return <NoBotState />;
    }

    const currentVisitorName = selectedChat ? (chatNames[selectedChat]?.name || 'Visitor') : 'Visitor';

    return (
        <div
            className={`flex flex-col h-full ${embedded ? '' : 'animate-fade-in'}`}
        >
            {/* Top bar: agent name + status toggle */}
            <div className="flex items-center justify-between mb-4 flex-shrink-0">
                {!embedded && <PageHeader title="Live Chat" subtitle="Chat with visitors in real-time" />}
                <div className={`flex items-center gap-3 ${embedded ? 'w-full justify-between' : ''}`}>
                    {operatorName && <span className="text-sm text-surface-500 dark:text-surface-400">{operatorName}</span>}
                    {connectionLost && (
                        <span className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-1 rounded-lg">
                            {duplicateTabDetected ? (
                                <>
                                    <X className="w-3 h-3" />
                                    Opened in another tab
                                    <button
                                        onClick={() => {
                                            setDuplicateTabDetected(false);
                                            manualCloseRef.current = false;
                                            reconnectAttemptsRef.current = 0;
                                            setReconnectCount(c => c + 1);
                                        }}
                                        className="ml-1 underline hover:text-amber-900 dark:hover:text-amber-300"
                                    >
                                        Take over here
                                    </button>
                                </>
                            ) : (
                                <>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Reconnecting...
                                    <button
                                        onClick={() => { reconnectAttemptsRef.current = 0; setReconnectCount(c => c + 1); }}
                                        className="ml-1 underline hover:text-amber-900 dark:hover:text-amber-300"
                                    >
                                        Retry now
                                    </button>
                                </>
                            )}
                        </span>
                    )}
                    <button
                        onClick={handleToggleStatus}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
                            isOnline
                                ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                                : 'bg-surface-50 dark:bg-surface-800 border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400'
                        }`}
                    >
                        <Circle className={`w-3 h-3 ${isOnline ? 'fill-emerald-500 text-emerald-500' : 'fill-surface-300 text-surface-300 dark:fill-surface-600 dark:text-surface-600'}`} />
                        {isOnline ? 'Online' : 'Offline'}
                    </button>
                </div>
            </div>

            {!isOnline ? (
                <div className="flex flex-col items-center justify-center flex-1 text-center">
                    {liveChatFeatureEnabled === false ? (
                        // Plan-gated state. Same vertical center as "You're offline" so
                        // the layout doesn't shift, but the copy + CTA pivot the visitor
                        // toward upgrade instead of toggling status.
                        <>
                            <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center mb-4">
                                <Lock className="w-8 h-8 text-amber-600 dark:text-amber-400" />
                            </div>
                            <h3 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-2">
                                Live chat isn&apos;t included in your plan
                            </h3>
                            <p className="text-sm text-surface-500 dark:text-surface-400 max-w-sm mb-4">
                                {currentPlanName
                                    ? `The ${currentPlanName} plan doesn't include live chat. Upgrade to start taking conversations with your visitors.`
                                    : "Your current plan doesn't include live chat. Upgrade to start taking conversations with your visitors."}
                            </p>
                            <button
                                onClick={() => navigateRouter('/billing')}
                                className="inline-flex items-center gap-2 px-6 py-2.5 bg-primary-600 dark:bg-primary-500 text-white rounded-xl text-sm font-medium hover:bg-primary-700 dark:hover:bg-primary-600 transition-colors"
                            >
                                <Sparkles className="w-4 h-4" />
                                Upgrade to enable
                            </button>
                        </>
                    ) : (
                        <>
                            <div className="w-16 h-16 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center mb-4">
                                <Headphones className="w-8 h-8 text-surface-400 dark:text-surface-500" />
                            </div>
                            <h3 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-2">You&apos;re offline</h3>
                            <p className="text-sm text-surface-500 dark:text-surface-400 max-w-sm mb-4">
                                Go online to start receiving live chat requests from visitors.
                            </p>
                            <button
                                onClick={handleToggleStatus}
                                disabled={liveChatFeatureEnabled === null}
                                className="px-6 py-2.5 bg-primary-600 dark:bg-primary-500 text-white rounded-xl text-sm font-medium hover:bg-primary-700 dark:hover:bg-primary-600 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {liveChatFeatureEnabled === null ? 'Checking…' : 'Go Online'}
                            </button>
                        </>
                    )}
                </div>
            ) : (
                <div className="flex gap-3 flex-1 min-h-0">

                    {/* ── Left: Queue + Active Chats ── */}
                    <div className="w-64 flex-shrink-0 bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 overflow-hidden flex flex-col">
                        {/* Waiting queue */}
                        {queue.length > 0 && (
                            <div className="border-b border-surface-200 dark:border-surface-700 flex-shrink-0">
                                <div className="px-4 py-3 bg-amber-50 dark:bg-amber-500/10">
                                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                                        Waiting ({queue.length})
                                    </h4>
                                </div>
                                {queue.map(item => (
                                    <div key={item.session_id} className="px-4 py-3 border-b border-surface-100 dark:border-surface-700 hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors">
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                                                {item.name || 'Anonymous'}
                                            </span>
                                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                                        </div>
                                        {item.bot_name && (
                                            <span className="inline-block mb-1.5 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">
                                                {item.bot_name}
                                            </span>
                                        )}
                                        {item.reason && (
                                            <p className="text-[11px] text-surface-500 dark:text-surface-400 truncate mb-2">{item.reason}</p>
                                        )}
                                        <button
                                            onClick={() => handleAcceptChat(item.session_id, item.name, item.reason)}
                                            disabled={acceptingSessionId === item.session_id}
                                            className="w-full py-1.5 bg-primary-600 dark:bg-primary-500 text-white text-[12px] font-medium rounded-lg hover:bg-primary-700 dark:hover:bg-primary-600 transition-colors disabled:opacity-60 flex items-center justify-center gap-1.5"
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
                                <h4 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">
                                    Active ({activeChats.length})
                                </h4>
                            </div>
                            {activeChats.length === 0 ? (
                                <div className="px-4 py-8 text-center text-sm text-surface-400 dark:text-surface-500">
                                    No active chats
                                </div>
                            ) : (
                                activeChats.map(sid => {
                                    const unread = unreadCounts[sid] || 0;
                                    const name = chatNames[sid]?.name || 'Visitor';
                                    const botName = chatNames[sid]?.botName;
                                    const vStatus = visitorStatus[sid] || 'online';
                                    return (
                                        <button
                                            key={sid}
                                            onClick={() => handleSelectChat(sid)}
                                            className={`w-full px-4 py-3 text-left border-b border-surface-100 dark:border-surface-700 transition-colors ${
                                                selectedChat === sid
                                                    ? 'bg-primary-50 dark:bg-primary-500/10 border-l-2 border-l-primary-500'
                                                    : 'hover:bg-surface-50 dark:hover:bg-surface-800'
                                            }`}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="min-w-0">
                                                    <span className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate block">
                                                        {name}
                                                    </span>
                                                    {botName && (
                                                        <span className="inline-block mt-0.5 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">
                                                            {botName}
                                                        </span>
                                                    )}
                                                    {vStatus === 'disconnected' && (
                                                        <span className="text-[10px] text-amber-600 dark:text-amber-400 block">Disconnected</span>
                                                    )}
                                                    {lastMessages[sid] && (
                                                        <p className="text-[11px] text-surface-400 dark:text-surface-500 truncate">{lastMessages[sid]}</p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                                    {unread > 0 && (
                                                        <span
                                                            className="min-w-[18px] h-[18px] px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"
                                                            aria-label={`${unread} unread message${unread !== 1 ? 's' : ''}`}
                                                        >
                                                            {unread > 9 ? '9+' : unread}
                                                        </span>
                                                    )}
                                                    <span className={`w-2 h-2 rounded-full ${vStatus === 'disconnected' ? 'bg-amber-400' : 'bg-emerald-500'}`} />
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })
                            )}

                            {/* ── Chatting with AI (BANT-qualified ≥2) ── */}
                            <div className="border-t border-surface-200 dark:border-surface-700">
                                <div className="px-4 py-3 flex items-center justify-between flex-shrink-0">
                                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">
                                        Chatting with AI ({qualifiedBotSessions.length})
                                    </h4>
                                    {qualifiedLoading && (
                                        <Loader2 className="w-3 h-3 animate-spin text-surface-400" />
                                    )}
                                </div>

                                {takeoverError && (
                                    <div className="mx-3 mb-2 flex items-start gap-2 px-2 py-1.5 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-lg text-[11px] text-rose-700 dark:text-rose-400">
                                        <X className="w-3 h-3 flex-shrink-0 mt-0.5" />
                                        <span className="break-words">{takeoverError}</span>
                                    </div>
                                )}

                                {qualifiedBotSessions.length === 0 ? (
                                    <div className="px-4 py-8 text-center text-sm text-surface-400 dark:text-surface-500">
                                        No qualified AI conversations yet
                                    </div>
                                ) : (
                                    qualifiedBotSessions.map(qs => {
                                        const dims = qs.bant_dimensions || {};
                                        const dimsCount = qs.bant_dimensions_count || 0;
                                        const tier = qs.bant_tier || 'unqualified';
                                        const tierStyles = (
                                            tier === 'sql' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                                                : tier === 'mql' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
                                                : 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400'
                                        );
                                        const score = qs.bant_score || 0;
                                        const sending = takeoverSessionId === qs.session_id;
                                        const cr = connectRequests[qs.session_id];
                                        const isPreviewed = previewSession?.session_id === qs.session_id;
                                        return (
                                            <div
                                                key={qs.session_id}
                                                className={`px-4 py-3 border-b border-surface-100 dark:border-surface-700 transition-colors cursor-pointer ${
                                                    isPreviewed
                                                        ? 'bg-violet-100/60 dark:bg-violet-500/10 border-l-2 border-l-violet-500'
                                                        : 'hover:bg-violet-50/40 dark:hover:bg-violet-500/5'
                                                }`}
                                                onClick={() => openPreviewSession(qs)}
                                                role="button"
                                                tabIndex={0}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' || e.key === ' ') {
                                                        e.preventDefault();
                                                        openPreviewSession(qs);
                                                    }
                                                }}
                                            >
                                                <div className="flex items-start justify-between gap-2 mb-1.5">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                                                                {qs.name || 'Anonymous'}
                                                            </span>
                                                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider flex-shrink-0 ${tierStyles}`}>
                                                                {tier === 'sql' ? 'Hot' : tier === 'mql' ? 'Warm' : 'Lead'}
                                                            </span>
                                                        </div>
                                                        {qs.company && (
                                                            <p className="text-[10px] text-surface-500 dark:text-surface-400 truncate flex items-center gap-1 mt-0.5">
                                                                <Building2 className="w-2.5 h-2.5" />
                                                                {qs.company}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-1 text-[10px] font-semibold text-surface-600 dark:text-surface-300 flex-shrink-0">
                                                        <TrendingUp className="w-3 h-3 text-violet-500" />
                                                        {score}
                                                    </div>
                                                </div>

                                                {/* BANT dimension badges — show recorded signal count
                                                    when >1 so the operator can spot sustained
                                                    engagement vs. single mentions. */}
                                                <div className="flex items-center gap-1 mb-2" aria-label={`BANT dimensions marked: ${dimsCount} of 4`}>
                                                    {['budget', 'authority', 'need', 'timeline'].map(dim => {
                                                        const marked = !!dims[dim];
                                                        const letter = dim.charAt(0).toUpperCase();
                                                        const signalCount = qs.bant_signal_counts?.[dim] || 0;
                                                        const showCount = signalCount > 1;
                                                        const title = `${dim.charAt(0).toUpperCase()}${dim.slice(1)}: ${marked ? 'captured' : 'not captured'}${signalCount ? ` · ${signalCount} signal${signalCount === 1 ? '' : 's'}` : ''}`;
                                                        return (
                                                            <span
                                                                key={dim}
                                                                title={title}
                                                                className={`relative inline-flex items-center justify-center rounded text-[10px] font-bold transition-colors ${
                                                                    showCount ? 'min-w-[24px] px-1 h-5' : 'w-5 h-5'
                                                                } ${
                                                                    marked
                                                                        ? 'bg-emerald-600 text-white dark:bg-emerald-500'
                                                                        : 'bg-surface-100 text-surface-400 dark:bg-surface-800 dark:text-surface-600'
                                                                }`}
                                                            >
                                                                {letter}
                                                                {showCount && (
                                                                    <span className="ml-0.5 text-[9px] font-bold opacity-90">
                                                                        {signalCount > 9 ? '9+' : signalCount}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        );
                                                    })}
                                                    <span className="ml-auto text-[10px] text-surface-400 dark:text-surface-500">
                                                        {dimsCount}/4
                                                        {qs.bant_signal_total > 0 && (
                                                            <span className="ml-1 text-violet-500 dark:text-violet-400" title={`${qs.bant_signal_total} total signals recorded`}>
                                                                · {qs.bant_signal_total}
                                                            </span>
                                                        )}
                                                    </span>
                                                </div>

                                                {qs.last_message_preview && (
                                                    <p className="text-[11px] text-surface-500 dark:text-surface-400 truncate mb-2">
                                                        {qs.last_message_preview}
                                                    </p>
                                                )}

                                                {cr && cr.status === 'pending' && (
                                                    <div className="flex items-center gap-1.5">
                                                        <div className="flex-1 py-1.5 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[11px] font-medium rounded-lg flex items-center justify-center gap-1.5">
                                                            <Loader2 className="w-3 h-3 animate-spin" /> Awaiting reply
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={(e) => { e.stopPropagation(); handleCancelConnectRequest(qs.session_id); }}
                                                            className="px-2 py-1.5 text-[11px] text-surface-500 dark:text-surface-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
                                                            aria-label="Cancel connect request"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                )}

                                                {cr && cr.status === 'declined' && (
                                                    <div className="w-full py-1.5 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 text-[11px] font-medium rounded-lg flex items-center justify-center gap-1.5">
                                                        <X className="w-3 h-3" /> Visitor declined
                                                    </div>
                                                )}

                                                {cr && (cr.status === 'expired' || cr.status === 'cancelled') && (
                                                    <div className="w-full py-1.5 bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 text-[11px] font-medium rounded-lg flex items-center justify-center gap-1.5">
                                                        <Clock className="w-3 h-3" /> {cr.status === 'expired' ? 'No response' : 'Cancelled'}
                                                    </div>
                                                )}

                                                {!cr && (
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleSendConnectRequest(qs.session_id, qs.name); }}
                                                        disabled={sending}
                                                        className="w-full py-1.5 bg-violet-600 dark:bg-violet-500 text-white text-[11px] font-medium rounded-lg hover:bg-violet-700 dark:hover:bg-violet-600 transition-colors disabled:opacity-60 flex items-center justify-center gap-1.5"
                                                    >
                                                        {sending ? (
                                                            <><Loader2 className="w-3 h-3 animate-spin" /> Sending...</>
                                                        ) : (
                                                            <><Zap className="w-3 h-3" /> Connect</>
                                                        )}
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>

                    {/* ── Center: Chat Panel ── */}
                    <div className="flex-1 bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 overflow-hidden flex flex-col min-w-0">
                        {previewSession && !selectedChat ? (
                            <>
                                {/* Preview header */}
                                <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between flex-shrink-0 bg-violet-50/40 dark:bg-violet-500/5">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-500/10 flex items-center justify-center flex-shrink-0">
                                            <User className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <h4 className="text-sm font-semibold text-surface-900 dark:text-surface-100 truncate">
                                                    {previewSession.name || 'Anonymous'}
                                                </h4>
                                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400 flex-shrink-0">
                                                    Chatting with AI
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 mt-0.5">
                                                <div className="flex items-center gap-1">
                                                    {['budget', 'authority', 'need', 'timeline'].map(dim => {
                                                        const marked = !!previewSession.bant_dimensions?.[dim];
                                                        const signalCount = previewSession.bant_signal_counts?.[dim] || 0;
                                                        const showCount = signalCount > 1;
                                                        return (
                                                            <span
                                                                key={dim}
                                                                title={`${dim.charAt(0).toUpperCase()}${dim.slice(1)}: ${marked ? 'captured' : 'not captured'}${signalCount ? ` · ${signalCount} signal${signalCount === 1 ? '' : 's'}` : ''}`}
                                                                className={`inline-flex items-center justify-center rounded text-[9px] font-bold ${
                                                                    showCount ? 'min-w-[22px] px-1 h-4' : 'w-4 h-4'
                                                                } ${
                                                                    marked
                                                                        ? 'bg-emerald-600 text-white dark:bg-emerald-500'
                                                                        : 'bg-surface-100 text-surface-400 dark:bg-surface-800 dark:text-surface-600'
                                                                }`}
                                                            >
                                                                {dim.charAt(0).toUpperCase()}
                                                                {showCount && (
                                                                    <span className="ml-0.5 text-[8px] opacity-90">
                                                                        {signalCount > 9 ? '9+' : signalCount}
                                                                    </span>
                                                                )}
                                                            </span>
                                                        );
                                                    })}
                                                </div>
                                                <span className="text-[11px] text-surface-500 dark:text-surface-400">
                                                    Score {previewSession.bant_score || 0}
                                                    {previewSession.bant_signal_total > 0 && (
                                                        <span className="ml-1 text-violet-500 dark:text-violet-400">
                                                            · {previewSession.bant_signal_total} signals
                                                        </span>
                                                    )}
                                                </span>
                                                {previewLoading && (
                                                    <Loader2 className="w-3 h-3 animate-spin text-surface-400" />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {connectRequests[previewSession.session_id]?.status === 'pending' ? (
                                            <button
                                                onClick={() => handleCancelConnectRequest(previewSession.session_id)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-surface-600 dark:text-surface-300 bg-surface-100 dark:bg-surface-800 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors"
                                            >
                                                <Loader2 className="w-3 h-3 animate-spin" /> Awaiting reply · Cancel
                                            </button>
                                        ) : (
                                            <button
                                                onClick={() => handleSendConnectRequest(previewSession.session_id, previewSession.name)}
                                                disabled={takeoverSessionId === previewSession.session_id}
                                                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-violet-600 dark:bg-violet-500 rounded-lg hover:bg-violet-700 dark:hover:bg-violet-600 transition-colors disabled:opacity-60"
                                            >
                                                {takeoverSessionId === previewSession.session_id ? (
                                                    <><Loader2 className="w-3 h-3 animate-spin" /> Sending</>
                                                ) : (
                                                    <><Zap className="w-3.5 h-3.5" /> Request to connect</>
                                                )}
                                            </button>
                                        )}
                                        <button
                                            onClick={closePreviewSession}
                                            aria-label="Close preview"
                                            className="p-1.5 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-lg transition-colors"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                {/* Preview banner */}
                                <div className="px-4 py-2 bg-violet-50/40 dark:bg-violet-500/5 border-b border-violet-100 dark:border-violet-500/20 text-[11px] text-violet-700 dark:text-violet-300 flex items-center gap-1.5">
                                    <Info className="w-3 h-3" />
                                    Read-only · You'll see new messages as the visitor chats with the AI
                                </div>

                                {/* Read-only messages */}
                                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" aria-live="polite" aria-label="AI conversation preview" role="log">
                                    {previewMessages.length === 0 && !previewLoading && (
                                        <div className="flex flex-col items-center justify-center h-full py-16 text-surface-400 dark:text-surface-500">
                                            <MessageCircle className="w-8 h-8 mb-2 opacity-40" />
                                            <p className="text-sm">No messages yet</p>
                                        </div>
                                    )}
                                    {previewMessages.map((msg) => (
                                        <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                            <div className={`max-w-[75%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
                                                msg.role === 'user'
                                                    ? 'bg-primary-600/10 dark:bg-primary-500/15 text-surface-900 dark:text-surface-100 rounded-br-md border border-primary-200 dark:border-primary-500/20'
                                                    : msg.role === 'bot'
                                                    ? 'bg-violet-50 dark:bg-violet-500/10 text-surface-800 dark:text-surface-200 rounded-bl-md border border-violet-100 dark:border-violet-500/20'
                                                    : 'bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400 italic text-xs rounded-bl-md'
                                            }`}>
                                                <div className="text-[10px] font-semibold uppercase tracking-wider opacity-60 mb-0.5">
                                                    {msg.role === 'user' ? 'Visitor' : msg.role === 'bot' ? 'AI' : 'System'}
                                                </div>
                                                {msg.role === 'bot' ? <BotMessage content={msg.content} /> : msg.content}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </>
                        ) : selectedChat ? (
                            <>
                                {/* Chat header */}
                                <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between flex-shrink-0">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-500/10 flex items-center justify-center flex-shrink-0">
                                            <User className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                                        </div>
                                        <div>
                                            <h4 className="text-sm font-semibold text-surface-900 dark:text-surface-100">{currentVisitorName}</h4>
                                            <p className={`text-[11px] ${(visitorStatus[selectedChat] || 'online') === 'disconnected' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                                {(visitorStatus[selectedChat] || 'online') === 'disconnected' ? 'Disconnected' : 'Connected'}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={openTransferModal}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-500/10 rounded-lg hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors"
                                        >
                                            <ArrowRightLeft className="w-3.5 h-3.5" />
                                            Transfer
                                        </button>
                                        <button
                                            onClick={() => { if (window.confirm(`End chat with ${currentVisitorName}?`)) handleCloseChat(selectedChat); }}
                                            className="px-3 py-1.5 text-[12px] font-medium text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-500/10 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-500/20 transition-colors"
                                        >
                                            End Chat
                                        </button>
                                        <button
                                            onClick={() => setShowRightPanel(p => !p)}
                                            aria-label={showRightPanel ? 'Hide info panel' : 'Show info panel'}
                                            className="p-1.5 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-primary-300"
                                        >
                                            {showRightPanel
                                                ? <ChevronRight className="w-4 h-4" />
                                                : <ChevronLeft className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>

                                {/* Error banners — contextual */}
                                {closeChatError && (
                                    <div className="mx-4 mt-2 flex items-center gap-2 px-3 py-2 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-lg text-xs text-rose-700 dark:text-rose-400">
                                        <X className="w-3.5 h-3.5 flex-shrink-0" />
                                        {closeChatError}
                                    </div>
                                )}
                                {sendError && (
                                    <div className="mx-4 mt-1 flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg text-xs text-amber-700 dark:text-amber-400">
                                        <X className="w-3.5 h-3.5 flex-shrink-0" />
                                        {sendError}
                                    </div>
                                )}
                                {fileError && (
                                    <div className="mx-4 mt-1 flex items-center gap-2 px-3 py-2 bg-orange-50 dark:bg-orange-500/10 border border-orange-200 dark:border-orange-500/30 rounded-lg text-xs text-orange-700 dark:text-orange-400">
                                        <X className="w-3.5 h-3.5 flex-shrink-0" />
                                        {fileError}
                                    </div>
                                )}

                                {/* Messages area */}
                                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" aria-live="polite" aria-label="Conversation messages" role="log">
                                    {/* Load earlier messages */}
                                    {hasMoreMessages && (
                                        <div className="flex justify-center pt-1 pb-2">
                                            <button
                                                onClick={handleLoadEarlier}
                                                disabled={loadingEarlier}
                                                className="text-xs text-surface-500 dark:text-surface-400 hover:text-primary-600 dark:hover:text-primary-400 flex items-center gap-1.5 disabled:opacity-50"
                                            >
                                                {loadingEarlier ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                                {loadingEarlier ? 'Loading...' : 'Load earlier messages'}
                                            </button>
                                        </div>
                                    )}

                                    {/* Empty state */}
                                    {messages.length === 0 && !isTyping && (
                                        <div className="flex flex-col items-center justify-center h-full py-16 text-surface-400 dark:text-surface-500">
                                            <MessageCircle className="w-8 h-8 mb-2 opacity-40" />
                                            <p className="text-sm">No messages yet</p>
                                        </div>
                                    )}

                                    {messages.map((msg) => (
                                        <div key={msg.id} className={`flex ${msg.role === 'operator' ? 'justify-end' : 'justify-start'}`}>
                                            <div className={`max-w-[75%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
                                                msg.role === 'operator'
                                                    ? 'bg-primary-600 dark:bg-primary-500 text-white rounded-br-md'
                                                    : msg.role === 'user'
                                                    ? 'bg-surface-100 dark:bg-surface-800 text-surface-800 dark:text-surface-200 rounded-bl-md'
                                                    : 'bg-surface-50 dark:bg-surface-800 text-surface-600 dark:text-surface-400 italic text-xs rounded-bl-md'
                                            }`}>
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
                                                        <a href={msg.file_url} target="_blank" rel="noopener noreferrer" className="underline break-all">
                                                            📎 {msg.filename || 'file'}
                                                        </a>
                                                    )
                                                ) : msg.role === 'bot' ? <BotMessage content={msg.content} /> : msg.content}
                                            </div>
                                        </div>
                                    ))}
                                    {isTyping && (
                                        <div className="flex justify-start items-end gap-2">
                                            <div className="bg-surface-100 dark:bg-surface-800 px-4 py-3 rounded-2xl rounded-bl-md">
                                                <div className="flex gap-1.5">
                                                    <span className="w-2 h-2 bg-surface-400 dark:bg-surface-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                    <span className="w-2 h-2 bg-surface-400 dark:bg-surface-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                    <span className="w-2 h-2 bg-surface-400 dark:bg-surface-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                                </div>
                                            </div>
                                            <span className="text-[11px] text-surface-400 dark:text-surface-500 pb-1">
                                                {chatNamesRef.current[selectedChat]?.name || 'Visitor'} is typing...
                                            </span>
                                        </div>
                                    )}
                                    <div ref={messagesEndRef} />
                                </div>

                                {/* Message input */}
                                <div className="border-t border-surface-200 dark:border-surface-700 px-4 py-3 relative flex-shrink-0">
                                    {showCannedDropdown && filteredCanned.length > 0 && (
                                        <div className="absolute bottom-full left-4 right-4 mb-1 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-xl shadow-lg max-h-48 overflow-y-auto z-10">
                                            {filteredCanned.slice(0, 8).map((r, idx) => (
                                                <button
                                                    key={r.id}
                                                    onClick={() => selectCannedResponse(r)}
                                                    onMouseEnter={() => setCannedHighlightIndex(idx)}
                                                    className={`w-full text-left px-4 py-2.5 transition-colors border-b border-surface-100 dark:border-surface-700 last:border-b-0 ${idx === cannedHighlightIndex ? 'bg-primary-50 dark:bg-primary-500/10' : 'hover:bg-surface-50 dark:hover:bg-surface-800'}`}
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-sm font-medium text-surface-900 dark:text-surface-100">{r.title}</span>
                                                        {r.shortcut && (
                                                            <span className="px-1.5 py-0.5 bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 text-[10px] font-mono rounded">
                                                                /{r.shortcut}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-[11px] text-surface-500 dark:text-surface-400 truncate mt-0.5">{r.content}</p>
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
                                            onKeyDown={(e) => {
                                                if (!showCannedDropdown) return;
                                                const maxIdx = Math.min(filteredCanned.length, 8) - 1;
                                                if (e.key === 'ArrowDown') {
                                                    e.preventDefault();
                                                    setCannedHighlightIndex(i => Math.min(i + 1, maxIdx));
                                                } else if (e.key === 'ArrowUp') {
                                                    e.preventDefault();
                                                    setCannedHighlightIndex(i => Math.max(i - 1, 0));
                                                } else if (e.key === 'Enter' && filteredCanned[cannedHighlightIndex]) {
                                                    e.preventDefault();
                                                    selectCannedResponse(filteredCanned[cannedHighlightIndex]);
                                                } else if (e.key === 'Escape') {
                                                    setShowCannedDropdown(false);
                                                }
                                            }}
                                            onPaste={handleOperatorPaste}
                                            placeholder="Type your reply... (/ for quick replies)"
                                            className="flex-1 px-4 py-2.5 text-sm bg-surface-50 dark:bg-surface-800 dark:text-surface-100 rounded-xl outline-none border border-transparent dark:border-surface-600 focus:border-primary-300 dark:focus:border-primary-500 transition-colors placeholder:text-surface-400 dark:placeholder:text-surface-500"
                                        />
                                        {/* File attach — visible only when file_sharing feature flag is on */}
                                        {bots[0]?.feature_flags?.file_sharing && (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() => fileInputRef.current?.click()}
                                                    disabled={fileUploading || !selectedChat}
                                                    aria-label="Attach file"
                                                    title="Attach file (images, PDF, TXT — max 10 MB)"
                                                    className="w-10 h-10 flex items-center justify-center text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                                >
                                                    {fileUploading
                                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                                        : <Paperclip className="w-4 h-4" />
                                                    }
                                                </button>
                                                <input
                                                    ref={fileInputRef}
                                                    type="file"
                                                    accept="image/*,.pdf,.txt"
                                                    className="hidden"
                                                    onChange={handleFileUpload}
                                                />
                                            </>
                                        )}
                                        <button
                                            type="submit"
                                            disabled={!inputText.trim()}
                                            aria-label="Send message"
                                            className="w-10 h-10 flex items-center justify-center bg-primary-600 dark:bg-primary-500 text-white rounded-xl hover:bg-primary-700 dark:hover:bg-primary-600 transition-colors disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-primary-300"
                                        >
                                            <Send className="w-4 h-4" />
                                        </button>
                                    </form>
                                </div>
                            </>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
                                <div className="w-16 h-16 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center mb-4">
                                    <MessageCircle className="w-8 h-8 text-surface-400 dark:text-surface-500" />
                                </div>
                                <h3 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-2">No chat selected</h3>
                                <p className="text-sm text-surface-500 dark:text-surface-400">
                                    {queue.length > 0
                                        ? 'Accept a waiting chat from the queue on the left.'
                                        : 'Waiting for visitors to request live support...'}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* ── Right: Session Info + Team Roster ── */}
                    {showRightPanel && (
                        <div className="w-64 flex-shrink-0 bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 overflow-hidden flex flex-col">
                            {/* Tabs — only show tab bar when both tabs are relevant */}
                            {selectedChat ? (
                                <div className="flex border-b border-surface-200 dark:border-surface-700 flex-shrink-0">
                                    <button
                                        onClick={() => setRightPanelTab('session')}
                                        className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[12px] font-medium transition-colors ${
                                            rightPanelTab === 'session'
                                                ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-500'
                                                : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
                                        }`}
                                    >
                                        <Info className="w-3.5 h-3.5" />
                                        Session
                                    </button>
                                    <button
                                        onClick={() => setRightPanelTab('team')}
                                        className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[12px] font-medium transition-colors ${
                                            rightPanelTab === 'team'
                                                ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-500'
                                                : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300'
                                        }`}
                                    >
                                        <Users className="w-3.5 h-3.5" />
                                        Team
                                    </button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-1.5 px-4 py-3 border-b border-surface-200 dark:border-surface-700 flex-shrink-0">
                                    <Users className="w-3.5 h-3.5 text-primary-600 dark:text-primary-400" />
                                    <span className="text-[12px] font-medium text-primary-600 dark:text-primary-400">Team</span>
                                </div>
                            )}

                            <div className="flex-1 overflow-y-auto">
                                {/* Session Info Tab */}
                                {selectedChat && rightPanelTab === 'session' && (
                                    <div className="p-4 space-y-4">
                                        {!selectedChat ? (
                                            <p className="text-sm text-surface-400 dark:text-surface-500 text-center py-8">Select a chat to view details</p>
                                        ) : !sessionInfo ? (
                                            <div className="flex justify-center py-8">
                                                <Loader2 className="w-5 h-5 animate-spin text-surface-400 dark:text-surface-500" />
                                            </div>
                                        ) : (
                                            <>
                                                {sessionInfo.lead_info && (
                                                    <div className="space-y-2.5">
                                                        <h5 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Visitor</h5>
                                                        {sessionInfo.lead_info.name && (
                                                            <div className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                                                <User className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 flex-shrink-0" />
                                                                <span className="truncate">{sessionInfo.lead_info.name}</span>
                                                            </div>
                                                        )}
                                                        {sessionInfo.lead_info.email && (
                                                            <div className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                                                <Mail className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 flex-shrink-0" />
                                                                <span className="truncate">{sessionInfo.lead_info.email}</span>
                                                            </div>
                                                        )}
                                                        {sessionInfo.lead_info.phone && (
                                                            <div className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                                                <Phone className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 flex-shrink-0" />
                                                                <span>{sessionInfo.lead_info.phone}</span>
                                                            </div>
                                                        )}
                                                        {sessionInfo.lead_info.company && (
                                                            <div className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                                                <Building2 className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 flex-shrink-0" />
                                                                <span className="truncate">{sessionInfo.lead_info.company}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                <div className="space-y-2.5 pt-2 border-t border-surface-100 dark:border-surface-700">
                                                    <h5 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Session</h5>
                                                    {sessionInfo.location && (
                                                        <div className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                                            <MapPin className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 flex-shrink-0" />
                                                            <span className="truncate">{sessionInfo.location}</span>
                                                        </div>
                                                    )}
                                                    {sessionInfo.device && (
                                                        <div className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                                            <Monitor className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 flex-shrink-0" />
                                                            <span className="truncate">{sessionInfo.device}</span>
                                                        </div>
                                                    )}
                                                    {sessionInfo.handoff_reason && (
                                                        <div className="flex items-start gap-2 text-sm text-surface-700 dark:text-surface-300">
                                                            <MessageCircle className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 flex-shrink-0 mt-0.5" />
                                                            <span className="break-words">{sessionInfo.handoff_reason}</span>
                                                        </div>
                                                    )}
                                                    {sessionInfo.created_at && (
                                                        <div className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                                            <Clock className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 flex-shrink-0" />
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
                                        <h5 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400 mb-3">
                                            Operators ({operatorsList.length})
                                        </h5>
                                        {operatorsList.length === 0 ? (
                                            <p className="text-sm text-surface-400 dark:text-surface-500 text-center py-6">No operators yet</p>
                                        ) : (
                                            <div className="space-y-2">
                                                {operatorsList.map(operator => {
                                                    const status = getOperatorStatus(operator);
                                                    return (
                                                        <div key={operator.id} className="flex items-center gap-2.5 py-1.5">
                                                            <div className="relative flex-shrink-0">
                                                                <div className="w-7 h-7 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center text-surface-600 dark:text-surface-300 font-bold text-[11px]">
                                                                    {operator.name?.charAt(0).toUpperCase() || '?'}
                                                                </div>
                                                                <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-surface-900 ${statusDotClass(status)}`} />
                                                            </div>
                                                            <div className="min-w-0">
                                                                <p className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">{operator.name}</p>
                                                                <p className="text-[10px] text-surface-400 dark:text-surface-500">
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
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label="Transfer chat">
                    <div className="bg-white dark:bg-surface-900 rounded-xl shadow-xl w-full max-w-md">
                        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-100 dark:border-surface-700">
                            <h2 className="font-semibold text-surface-900 dark:text-surface-100 flex items-center gap-2">
                                <ArrowRightLeft className="w-4 h-4" />
                                {transferTarget ? 'Confirm Transfer' : 'Transfer Chat'}
                            </h2>
                            <button
                                onClick={() => { setShowTransferModal(false); setTransferTarget(null); }}
                                aria-label="Close transfer modal"
                                className="text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 focus-visible:ring-2 focus-visible:ring-primary-300 rounded"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            {/* Step 2: confirmation */}
                            {transferTarget ? (
                                <div className="text-center space-y-4">
                                    <p className="text-sm text-surface-700 dark:text-surface-300">
                                        Transfer this chat to <strong>{transferTarget.label}</strong>?
                                    </p>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => setTransferTarget(null)}
                                            className="flex-1 py-2 rounded-lg border border-surface-200 dark:border-surface-700 text-sm text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
                                        >
                                            Back
                                        </button>
                                        <button
                                            onClick={() => handleTransfer(transferTarget.operatorId, transferTarget.deptId)}
                                            className="flex-1 py-2 rounded-lg bg-primary-600 dark:bg-primary-500 text-white text-sm font-medium hover:bg-primary-700 dark:hover:bg-primary-600 transition-colors"
                                        >
                                            Confirm Transfer
                                        </button>
                                    </div>
                                </div>
                            ) : (
                            <>
                            {transferOperators.length > 0 && (
                                <div>
                                    <h3 className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">Online Operators</h3>
                                    <div className="space-y-1">
                                        {transferOperators.map(operator => (
                                            <button
                                                key={operator.id}
                                                onClick={() => setTransferTarget({ operatorId: operator.id, deptId: null, label: operator.name })}
                                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors text-left"
                                            >
                                                <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-500/10 flex items-center justify-center text-primary-600 dark:text-primary-400 font-bold text-sm">
                                                    {operator.name?.charAt(0).toUpperCase() || '?'}
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-surface-900 dark:text-surface-100">{operator.name}</p>
                                                    <p className="text-[11px] text-surface-500 dark:text-surface-400">
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
                                    <h3 className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">Departments</h3>
                                    <div className="space-y-1">
                                        {transferDepartments.map(dept => (
                                            <button
                                                key={dept.id}
                                                onClick={() => setTransferTarget({ operatorId: null, deptId: dept.id, label: dept.name })}
                                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors text-left"
                                            >
                                                <div className="w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400 font-bold text-sm">
                                                    {dept.name?.charAt(0).toUpperCase() || '?'}
                                                </div>
                                                <p className="text-sm font-medium text-surface-900 dark:text-surface-100">{dept.name}</p>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {transferOperators.length === 0 && transferDepartments.length === 0 && (
                                <p className="text-sm text-surface-500 dark:text-surface-400 text-center py-4">No operators online or departments available.</p>
                            )}
                            </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Pre-send file preview modal ── */}
            {pendingFile && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white dark:bg-surface-900 rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden flex flex-col">
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-100 dark:border-surface-700">
                            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Send file</h3>
                            <button
                                type="button"
                                onClick={cancelPendingFile}
                                aria-label="Cancel"
                                className="text-surface-400 hover:text-surface-700 dark:hover:text-surface-300 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Preview */}
                        <div className="flex items-center justify-center bg-surface-50 dark:bg-surface-800 p-6 min-h-[200px]">
                            {pendingFile.isImage ? (
                                <img
                                    src={pendingFile.previewUrl}
                                    alt="Preview"
                                    className="max-w-full max-h-64 object-contain rounded-xl shadow-sm"
                                />
                            ) : (
                                <div className="flex flex-col items-center gap-3 text-surface-500 dark:text-surface-400">
                                    <div className="w-16 h-16 rounded-2xl bg-surface-200 dark:bg-surface-700 flex items-center justify-center text-2xl">📎</div>
                                    <p className="text-sm font-medium text-surface-800 dark:text-surface-200 text-center break-all">{pendingFile.file.name}</p>
                                    <p className="text-xs text-surface-400 dark:text-surface-500">{(pendingFile.file.size / 1024).toFixed(1)} KB</p>
                                </div>
                            )}
                        </div>

                        {/* Caption + actions */}
                        <div className="px-5 py-4 space-y-3">
                            <input
                                type="text"
                                value={pendingFile.caption}
                                onChange={(e) => setPendingFile((prev) => ({ ...prev, caption: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') sendPendingFile(); }}
                                placeholder="Add a caption…"
                                autoFocus
                                className="w-full px-3 py-2 text-sm rounded-xl border border-surface-200 dark:border-surface-600 bg-surface-50 dark:bg-surface-800 dark:text-surface-100 outline-none focus:border-primary-400 dark:focus:border-primary-500 transition-colors placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            />
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={cancelPendingFile}
                                    className="flex-1 py-2 text-sm font-medium rounded-xl border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={sendPendingFile}
                                    disabled={fileUploading}
                                    className="flex-1 py-2 text-sm font-medium rounded-xl bg-primary-600 dark:bg-primary-500 text-white hover:bg-primary-700 dark:hover:bg-primary-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {fileUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                    Send
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Live-chat-plan upgrade modal ──
                Fired when a customer on a plan without ``features.live_chat``
                clicks the Online / Go Online button. Surfaces a clean
                upgrade CTA so the path forward is obvious; backend would
                403 the toggle either way, so this is purely UX. */}
            {showUpgradeModal && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 animate-fade-in" role="dialog" aria-modal="true" aria-labelledby="upgrade-modal-title">
                    <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-xl p-6 max-w-sm w-full mx-4">
                        <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center mx-auto mb-3">
                            <Lock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
                        </div>
                        <h3
                            id="upgrade-modal-title"
                            className="text-base font-bold text-surface-900 dark:text-surface-100 mb-1 text-center"
                        >
                            Upgrade to use Live Chat
                        </h3>
                        <p className="text-sm text-surface-500 dark:text-surface-400 mb-5 text-center">
                            {currentPlanName
                                ? `Live chat isn't included in the ${currentPlanName} plan. Upgrade to start taking conversations with your visitors directly.`
                                : "Live chat isn't included in your current plan. Upgrade to start taking conversations with your visitors directly."}
                        </p>
                        <div className="flex flex-col gap-2">
                            <button
                                onClick={() => { setShowUpgradeModal(false); navigateRouter('/billing'); }}
                                className="w-full inline-flex items-center justify-center gap-2 py-2.5 text-sm font-medium rounded-xl bg-primary-600 dark:bg-primary-500 text-white hover:bg-primary-700 dark:hover:bg-primary-600 transition-colors"
                            >
                                <Sparkles className="w-4 h-4" />
                                See upgrade options
                            </button>
                            <button
                                onClick={() => setShowUpgradeModal(false)}
                                className="w-full py-2.5 text-sm font-medium rounded-xl border border-surface-200 dark:border-surface-700 text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
                            >
                                Not now
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Confirm modal (replaces window.confirm) ── */}
            {confirmModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" role="dialog" aria-modal="true">
                    <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-xl p-6 max-w-sm w-full mx-4">
                        <h3 className="text-lg font-bold text-surface-900 dark:text-surface-100 mb-2">{confirmModal.title}</h3>
                        <p className="text-sm text-surface-600 dark:text-surface-400 mb-5">{confirmModal.message}</p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setConfirmModal(null)}
                                className="flex-1 py-2.5 text-sm font-medium rounded-xl border border-surface-200 dark:border-surface-700 text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmModal.onConfirm}
                                className="flex-1 py-2.5 text-sm font-medium rounded-xl bg-rose-600 text-white hover:bg-rose-700 transition-colors"
                            >
                                Continue
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Image lightbox ── */}
            {lightboxSrc && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 animate-fade-in"
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
                        <X className="w-7 h-7" />
                    </button>
                    <img
                        src={lightboxSrc}
                        alt="Full size"
                        className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>
            )}
        </div>
    );
}
