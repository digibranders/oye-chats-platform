import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import SendIcon from './SendIcon';
import { getChatHistory } from '../services/api';

const API_URL = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

/**
 * Headless WebSocket provider for live chat.
 *
 * This component manages the WebSocket connection lifecycle (connect, reconnect,
 * heartbeat, file uploads, read receipts, pending message retry) but renders NO
 * message list, scroll area, or input of its own. Instead it lifts all data up via
 * callbacks so ChatWindow can render everything in one unified stream.
 *
 * What it DOES render (absolutely-positioned overlays):
 *   - Pre-send file preview overlay
 *   - Full-screen image lightbox
 */
const LiveChatMode = ({
    sessionId,
    settings,
    chatMode,
    setChatMode,
    setOperatorName,
    setOperatorDepartment,
    onConnectionStatusChange,
    // Lifted state callbacks
    onLiveMessagesChange,   // (updaterFn | array) => void  — controls liveMessages in parent
    onOperatorTyping,       // (bool) => void
    onLastReadAtChange,     // (isoString) => void
    onReconnectingChange,   // (bool) => void
    onWsReady,              // ({ send, typing, triggerFilePick, endChat }) => void
    onChatEnded,            // () => void — called when chat ends (show rating or return to bot)
    onUploadProgressChange, // (number|null) => void — syncs upload progress to parent
}) => {
    const [ws, setWs] = useState(null);
    const reconnectAttempt = useRef(0);
    const reconnectTimer = useRef(null);
    const intentionalClose = useRef(false);
    const lastTypingSentRef = useRef(0);
    const msgIdCounter = useRef(0);
    const typingTimeoutRef = useRef(null);
    const historyLoadedRef = useRef(false);
    const stoppedTypingTimerRef = useRef(null);
    const fileInputRef = useRef(null);
    const heartbeatRef = useRef(null);
    const pongTimeoutRef = useRef(null);

    const statusCheckRef = useRef(null);

    const [uploadProgress, setUploadProgressLocal] = useState(null);
    // Pre-send preview: { file, previewUrl, caption, isImage }
    const [pendingFile, setPendingFile] = useState(null);
    // Full-screen image lightbox
    const [lightboxSrc, setLightboxSrc] = useState(null);
    // Pending messages that failed to send — retried on reconnect
    const [pendingMessages, setPendingMessages] = useState([]);
    const [fileError, setFileError] = useState(null);

    // Sync upload progress to both local state and parent
    const setUploadProgress = (val) => {
        setUploadProgressLocal(val);
        onUploadProgressChange?.(val);
    };

    // ─── Periodic status check — recovers from lost "connected" messages ────────
    useEffect(() => {
        if (chatMode === 'waiting' && ws && ws.readyState === WebSocket.OPEN) {
            statusCheckRef.current = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'status_check' }));
                }
            }, 8000);
        } else {
            clearInterval(statusCheckRef.current);
        }
        return () => clearInterval(statusCheckRef.current);
    }, [chatMode, ws]);

    // ─── WebSocket connection ───────────────────────────────────────────────────

    useEffect(() => {
        if (!sessionId) return;

        const botKey = window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || '';
        const wsUrl = API_URL.replace(/^http/, 'ws');

        const connect = () => {
            const wsUrlObj = new URL(`${wsUrl}/ws/chat/${sessionId}`);
            wsUrlObj.searchParams.set('bot_key', botKey);
            const socket = new WebSocket(wsUrlObj.toString());

            socket.onopen = () => {
                console.log('[OyeChats] Live chat WebSocket connected');
                reconnectAttempt.current = 0;
                onReconnectingChange?.(false);
                onConnectionStatusChange?.('connected_ws');

                // Expose send/typing/filePick handles to ChatWindow
                onWsReady?.({
                    send: (text) => {
                        if (socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({ type: 'message', content: text }));
                        }
                    },
                    typing: () => {
                        if (settings?.feature_flags?.typing_preview === false) return;
                        const now = Date.now();
                        if (now - lastTypingSentRef.current < 3000) return;
                        lastTypingSentRef.current = now;
                        if (socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({ type: 'typing' }));
                        }
                        clearTimeout(stoppedTypingTimerRef.current);
                        stoppedTypingTimerRef.current = setTimeout(() => {
                            if (socket.readyState === WebSocket.OPEN) {
                                socket.send(JSON.stringify({ type: 'stopped_typing' }));
                            }
                        }, 2000);
                    },
                    triggerFilePick: () => fileInputRef.current?.click(),
                    endChat: () => {
                        if (socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({ type: 'visitor_end_chat' }));
                        }
                        intentionalClose.current = true;
                        socket.close();
                        onChatEnded?.();
                    },
                });
            };

            socket.onmessage = (event) => {
                let data;
                try { data = JSON.parse(event.data); } catch { return; }

                switch (data.type) {
                    case 'status':
                        if (data.status === 'waiting') {
                            setChatMode('waiting');
                        } else if (data.status === 'connected') {
                            setChatMode('live');
                            setOperatorName(data.operator_name || 'Support');
                            setOperatorDepartment?.(data.operator_department || null);
                            onConnectionStatusChange?.('connected');
                            // On reconnect/refresh, restore chat history from backend
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
                                            onLiveMessagesChange?.(prev => {
                                                if (!Array.isArray(prev) || prev.length === 0) return restored;
                                                const existingIds = new Set(prev.map(m => m.id));
                                                const newMsgs = restored.filter(m => !existingIds.has(m.id));
                                                return newMsgs.length > 0 ? [...newMsgs, ...prev] : prev;
                                            });
                                        }
                                    })
                                    .catch(() => { /* non-fatal */ });
                            }
                        } else if (data.status === 'closed') {
                            intentionalClose.current = true;
                            socket.close();
                            onLiveMessagesChange?.([]);
                            setOperatorName(null);
                            onChatEnded?.();
                        } else if (data.status === 'unavailable') {
                            intentionalClose.current = true;
                            setChatMode('unavailable');
                        }
                        break;

                    case 'message': {
                        onOperatorTyping?.(false);
                        const msg = {
                            id: `live-${++msgIdCounter.current}`,
                            text: data.content,
                            sender: data.role === 'operator' ? 'operator' : 'user',
                            operatorName: data.operator_name,
                            timestamp: data.timestamp || new Date().toISOString(),
                        };
                        onLiveMessagesChange?.(prev => [...(prev || []), msg]);
                        break;
                    }

                    case 'operator_typing':
                        onOperatorTyping?.(true);
                        clearTimeout(typingTimeoutRef.current);
                        typingTimeoutRef.current = setTimeout(() => onOperatorTyping?.(false), 3000);
                        break;

                    case 'ping':
                        socket.send(JSON.stringify({ type: 'pong' }));
                        break;

                    case 'pong':
                        clearTimeout(pongTimeoutRef.current);
                        break;

                    case 'read_receipt':
                        if (data.reader === 'operator') {
                            onLastReadAtChange?.(new Date().toISOString());
                        }
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
                    onReconnectingChange?.(true);
                    onConnectionStatusChange?.('reconnecting');
                    reconnectTimer.current = setTimeout(connect, delay);
                } else if (reconnectAttempt.current >= 15) {
                    onReconnectingChange?.(false);
                    onConnectionStatusChange?.('disconnected');
                }
            };

            socket.onerror = () => {
                // onclose fires after onerror — reconnect handled there
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

    // ─── Visibility-aware heartbeat ─────────────────────────────────────────────

    useEffect(() => {
        if (!ws) return;

        const sendPing = () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
                clearTimeout(pongTimeoutRef.current);
                pongTimeoutRef.current = setTimeout(() => {
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

    // ─── Stale-connection detection on tab return / network restore ─────────────

    useEffect(() => {
        if (!ws) return;

        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ type: 'ping' })); } catch { ws.close(); }
            } else if (
                (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) &&
                !intentionalClose.current
            ) {
                reconnectAttempt.current = 0;
                ws.close();
            }
        };

        const handleOnline = () => {
            if (!intentionalClose.current && ws.readyState !== WebSocket.OPEN) {
                reconnectAttempt.current = 0;
                ws.close();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('online', handleOnline);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('online', handleOnline);
        };
    }, [ws]);

    // ─── Pending message retry on reconnect ─────────────────────────────────────

    useEffect(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN || pendingMessages.length === 0) return;

        const toRetry = [...pendingMessages];
        const stillFailed = [];

        for (const msg of toRetry) {
            try {
                ws.send(JSON.stringify({ type: 'message', content: msg.text }));
                onLiveMessagesChange?.(prev =>
                    (prev || []).map(m => m.id === msg.id ? { ...m, failed: false } : m)
                );
            } catch {
                stillFailed.push(msg);
            }
        }
        setPendingMessages(stillFailed);
    }, [ws, pendingMessages]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── File upload helpers ─────────────────────────────────────────────────────

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

    const cancelPendingFile = () => {
        if (pendingFile?.previewUrl) URL.revokeObjectURL(pendingFile.previewUrl);
        setPendingFile(null);
    };

    const sendPendingFile = async () => {
        if (!pendingFile) return;
        const { file, previewUrl, caption } = pendingFile;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPendingFile(null);
        setFileError(null);
        setUploadProgress(0);
        try {
            const res = await fetch(`${API_URL}/chat/upload-url`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Bot-Key': settings.bot_key || '' },
                body: JSON.stringify({ filename: file.name, content_type: file.type, size: file.size }),
            });
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                throw new Error(`Upload URL failed (${res.status}): ${detail}`);
            }
            const { upload_url, file_url } = await res.json();

            const putRes = await fetch(upload_url, {
                method: 'PUT',
                headers: { 'Content-Type': file.type },
                body: file,
            });
            if (!putRes.ok) throw new Error(`File upload failed (${putRes.status})`);
            setUploadProgress(100);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'file', file_url, filename: file.name, content_type: file.type }));
                onLiveMessagesChange?.(prev => [...(prev || []), {
                    id: `live-file-${++msgIdCounter.current}`,
                    sender: 'user',
                    file_url,
                    filename: file.name,
                    content_type: file.type,
                    status: 'sent',
                    timestamp: new Date().toISOString(),
                }]);

                if (caption.trim()) {
                    ws.send(JSON.stringify({ type: 'message', content: caption.trim() }));
                    onLiveMessagesChange?.(prev => [...(prev || []), {
                        id: `live-msg-${++msgIdCounter.current}`,
                        sender: 'user',
                        text: caption.trim(),
                        status: 'sent',
                        timestamp: new Date().toISOString(),
                    }]);
                }
            } else {
                setFileError('Connection lost — please try again.');
            }
        } catch (err) {
            console.error('[OyeChats] File upload error:', err);
            setFileError('Failed to send file. Please try again.');
        } finally {
            setUploadProgress(null);
        }
    };

    // ─── Render ──────────────────────────────────────────────────────────────────
    // Hidden file input (triggered by ChatInput's paperclip via onFilePick → triggerFilePick)
    // Pre-send file preview overlay and image lightbox are the only visible elements.

    return (
        <>
            {/* Hidden file input */}
            {settings?.feature_flags?.file_sharing && (
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.pdf,.txt"
                    className="hidden"
                    onChange={handleFileSelect}
                />
            )}

            {/* ── Pre-send file preview overlay ── */}
            {pendingFile && (
                <div className="absolute inset-0 z-30 flex flex-col bg-white">
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

            {/* ── File upload error toast ── */}
            {fileError && (
                <div className="absolute bottom-20 left-4 right-4 z-30 rounded-xl bg-red-50 border border-red-200 px-4 py-2.5 flex items-center justify-between gap-2">
                    <span className="text-[12px] text-red-600">{fileError}</span>
                    <button
                        onClick={() => setFileError(null)}
                        className="shrink-0 text-red-400 hover:text-red-600 transition-colors"
                        aria-label="Dismiss"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
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
