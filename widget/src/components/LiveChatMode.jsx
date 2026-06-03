import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import SendIcon from './SendIcon';
import { getChatHistory } from '../services/api';
import { sanitizeColor } from '../services/sanitize';

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
    onLastReadAtChange,     // (isoString) => void — kept for backwards compat (file-list/legacy callers)
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
            // Use Sec-WebSocket-Protocol header instead of query params to avoid
            // leaking the bot key in server access logs and browser history.
            const socket = new WebSocket(wsUrlObj.toString(), [`bot-key.${botKey}`]);

            socket.onopen = () => {
                console.log('[OyeChats] Live chat WebSocket connected');
                reconnectAttempt.current = 0;
                onReconnectingChange?.(false);
                onConnectionStatusChange?.('connected_ws');

                // Expose send/typing/filePick handles to ChatWindow
                onWsReady?.({
                    send: (text, clientMsgId) => {
                        if (socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify({
                                type: 'message',
                                content: text,
                                client_msg_id: clientMsgId,
                            }));
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
                    handlePaste: (e) => {
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
                    },
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
                            // Always re-fetch history on (re)connect — covers the
                            // window where the visitor's WS dropped and operator
                            // messages were sent into a dead socket. Without this,
                            // those messages live in the DB but never reach the UI.
                            historyLoadedRef.current = true;
                            getChatHistory(sessionId)
                                .then(history => {
                                    if (!history || history.length === 0) return;
                                    // Match file messages stored as markdown: [File: name](url)
                                    const fileRe = /^\[File:\s*(.+?)\]\((.+?)\)$/;
                                    const restored = history
                                        .filter(m => m.role === 'user' || m.role === 'operator')
                                        .map((m) => {
                                            const fileMatch = m.content?.match(fileRe);
                                            const isUser = m.role !== 'operator';
                                            const base = {
                                                id: m.id ? `srv-${m.id}` : `restored-${Date.now()}-${Math.random()}`,
                                                sender: isUser ? 'user' : 'operator',
                                                operatorName: !isUser ? (data.operator_name || 'Support') : undefined,
                                                timestamp: m.timestamp || m.created_at,
                                                ...(isUser ? {
                                                    dbId: typeof m.id === 'number' ? m.id : undefined,
                                                    // Restored visitor messages are by definition persisted
                                                    // — start them at "delivered". A subsequent read_receipt
                                                    // (sent by the operator when they open the chat) will
                                                    // upgrade them to "read".
                                                    status: 'delivered',
                                                    sentAt: m.timestamp || m.created_at,
                                                    deliveredAt: m.timestamp || m.created_at,
                                                } : {}),
                                            };
                                            if (fileMatch) {
                                                const filename = fileMatch[1];
                                                const url = fileMatch[2];
                                                const ext = filename.split('.').pop()?.toLowerCase() || '';
                                                const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
                                                return {
                                                    ...base,
                                                    file_url: url,
                                                    filename,
                                                    content_type: imageExts.includes(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : (ext === 'pdf' ? 'application/pdf' : 'text/plain'),
                                                };
                                            }
                                            return { ...base, text: m.content };
                                        });
                                    onLiveMessagesChange?.(prev => {
                                        if (!Array.isArray(prev) || prev.length === 0) return restored;
                                        // Append-by-timestamp: pick up messages that
                                        // arrived in the DB after the last one we
                                        // already have in memory. Preserves local
                                        // state (failed/sent flags) on existing
                                        // entries instead of clobbering with a full
                                        // replace.
                                        const latestTs = prev.reduce((max, m) => {
                                            const ts = m.timestamp || '';
                                            return ts > max ? ts : max;
                                        }, '');
                                        const toAppend = restored.filter(m => (m.timestamp || '') > latestTs);
                                        return toAppend.length > 0 ? [...prev, ...toAppend] : prev;
                                    });
                                })
                                .catch(() => { /* non-fatal */ });
                        } else if (data.status === 'closed') {
                            intentionalClose.current = true;
                            socket.close();
                            // Don't wipe messages — preserve conversation for rating survey.
                            // Messages are cleared in handleReturnToBot after rating is submitted.
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
                            dbId: typeof data.message_id === 'number' ? data.message_id : undefined,
                            timestamp: data.timestamp || new Date().toISOString(),
                        };
                        onLiveMessagesChange?.(prev => [...(prev || []), msg]);
                        break;
                    }

                    case 'file': {
                        onOperatorTyping?.(false);
                        const fileMsg = {
                            id: `live-file-${++msgIdCounter.current}`,
                            sender: data.role === 'operator' ? 'operator' : 'user',
                            file_url: data.file_url,
                            filename: data.filename,
                            content_type: data.content_type,
                            operatorName: data.operator_name,
                            dbId: typeof data.message_id === 'number' ? data.message_id : undefined,
                            timestamp: data.timestamp || new Date().toISOString(),
                        };
                        onLiveMessagesChange?.(prev => [...(prev || []), fileMsg]);
                        break;
                    }

                    case 'message_ack': {
                        // Server has persisted (and possibly delivered) the visitor's
                        // outgoing message. Find it by client_msg_id and upgrade the
                        // tick state from "sending" to "sent" or "delivered", and
                        // attach the dbId so the next read_receipt can address it.
                        const { client_msg_id: clientId, message_id: dbId, status: ackStatus, timestamp: ackTs } = data;
                        if (!clientId) break;
                        onLiveMessagesChange?.(prev =>
                            (prev || []).map(m => {
                                if (m.clientMsgId !== clientId) return m;
                                // Don't downgrade from "read" if a later receipt already arrived.
                                if (m.status === 'read') return { ...m, dbId: dbId ?? m.dbId };
                                const nextStatus = ackStatus === 'delivered' ? 'delivered' : 'sent';
                                return {
                                    ...m,
                                    status: nextStatus,
                                    dbId: dbId ?? m.dbId,
                                    sentAt: m.sentAt || ackTs || new Date().toISOString(),
                                    deliveredAt: ackStatus === 'delivered'
                                        ? (m.deliveredAt || ackTs || new Date().toISOString())
                                        : m.deliveredAt,
                                };
                            })
                        );
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

                    case 'read_receipt': {
                        if (data.reader !== 'operator') break;
                        const readAt = new Date().toISOString();
                        const lastReadId = typeof data.last_read_id === 'number' ? data.last_read_id : null;

                        // Notify legacy listeners (kept for back-compat with
                        // any consumer still reading lastReadAt).
                        onLastReadAtChange?.(readAt);

                        // Per-message "read" upgrade: only the visitor's own
                        // outgoing messages whose dbId is ≤ last_read_id flip
                        // to green. Messages without a dbId (pre-ack, queued)
                        // are left alone — they'll flip on the next receipt
                        // after the ack arrives.
                        onLiveMessagesChange?.(prev =>
                            (prev || []).map(m => {
                                if (m.sender !== 'user') return m;
                                if (m.status === 'failed' || m.status === 'sending') return m;
                                if (lastReadId !== null) {
                                    if (typeof m.dbId !== 'number' || m.dbId > lastReadId) return m;
                                }
                                if (m.status === 'read') return m;
                                return { ...m, status: 'read', readAt };
                            })
                        );
                        break;
                    }

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
                const clientId = msg.clientMsgId || `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                ws.send(JSON.stringify({ type: 'message', content: msg.text, client_msg_id: clientId }));
                onLiveMessagesChange?.(prev =>
                    (prev || []).map(m => m.id === msg.id
                        ? { ...m, failed: false, status: 'sending', clientMsgId: clientId }
                        : m
                    )
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
        if (!ALLOWED.includes(file.type)) {
            setFileError('Unsupported file type. Allowed: images, PDF, and text files.');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            setFileError('File is too large. Maximum size is 10 MB.');
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
                const fileClientId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                ws.send(JSON.stringify({
                    type: 'file',
                    file_url,
                    filename: file.name,
                    content_type: file.type,
                    client_msg_id: fileClientId,
                }));
                onLiveMessagesChange?.(prev => [...(prev || []), {
                    id: `live-file-${++msgIdCounter.current}`,
                    sender: 'user',
                    file_url,
                    filename: file.name,
                    content_type: file.type,
                    clientMsgId: fileClientId,
                    status: 'sending',
                    timestamp: new Date().toISOString(),
                }]);

                if (caption.trim()) {
                    const captionClientId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    ws.send(JSON.stringify({
                        type: 'message',
                        content: caption.trim(),
                        client_msg_id: captionClientId,
                    }));
                    onLiveMessagesChange?.(prev => [...(prev || []), {
                        id: `live-msg-${++msgIdCounter.current}`,
                        sender: 'user',
                        text: caption.trim(),
                        clientMsgId: captionClientId,
                        status: 'sending',
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
                                    style={{ width: `${uploadProgress}%`, backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}
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
                                style={{ backgroundColor: sanitizeColor(settings.primary_color, '#3A0CA3') }}
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
