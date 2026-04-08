import { useState, useEffect } from 'react';
import { Inbox, Mail, Clock, CheckCircle2, Eye, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { getOfflineMessages, updateOfflineMessage, deleteOfflineMessage } from '../services/api';
import { cn } from '../lib/utils';

export default function OfflineMessages({ embedded = false }) {
    const [messages, setMessages] = useState([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [statusFilter, setStatusFilter] = useState('');
    const [loading, setLoading] = useState(true);
    const [selectedMessage, setSelectedMessage] = useState(null);

    const fetchMessages = async () => {
        try {
            setLoading(true);
            const params = { page, limit: 20 };
            if (statusFilter) params.status = statusFilter;
            const data = await getOfflineMessages(params);
            setMessages(data.messages || []);
            setTotal(data.total || 0);
        } catch {
            // silent
        } finally {
            setLoading(false);
        }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { fetchMessages(); }, [page, statusFilter]);

    const handleMarkRead = async (id) => {
        await updateOfflineMessage(id, { status: 'read' });
        fetchMessages();
        if (selectedMessage?.id === id) {
            setSelectedMessage(prev => ({ ...prev, status: 'read' }));
        }
    };

    const handleMarkReplied = async (id) => {
        await updateOfflineMessage(id, { status: 'replied' });
        fetchMessages();
        if (selectedMessage?.id === id) {
            setSelectedMessage(prev => ({ ...prev, status: 'replied' }));
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this message?')) return;
        await deleteOfflineMessage(id);
        if (selectedMessage?.id === id) setSelectedMessage(null);
        fetchMessages();
    };

    const statusBadge = (status) => {
        const styles = {
            new: 'bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400',
            read: 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-400',
            replied: 'bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        };
        return (
            <span className={cn('px-2 py-0.5 rounded-full text-[11px] font-medium', styles[status] || styles.new)}>
                {status}
            </span>
        );
    };

    const totalPages = Math.ceil(total / 20);

    return (
        <div className="space-y-6">
            {!embedded && (
                <div>
                    <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Offline Messages</h1>
                    <p className="text-surface-500 dark:text-surface-400 text-sm mt-1">Messages left by visitors when no agent was available.</p>
                </div>
            )}

            {/* Filters */}
            <div className="flex gap-2">
                {['', 'new', 'read', 'replied'].map((s) => (
                    <button
                        key={s}
                        onClick={() => { setStatusFilter(s); setPage(1); }}
                        className={cn(
                            'px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                            statusFilter === s
                                ? 'bg-primary-50 dark:bg-primary-500/10 border-primary-200 dark:border-primary-500/30 text-primary-700 dark:text-primary-400'
                                : 'bg-white dark:bg-surface-900 border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-800'
                        )}
                    >
                        {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                ))}
            </div>

            <div className="flex gap-6">
                {/* Message List */}
                <div className="flex-1 bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 overflow-hidden">
                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 text-surface-400 dark:text-surface-500">
                            <Inbox size={40} className="mb-3" />
                            <p className="font-medium">No messages</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-surface-100 dark:divide-surface-800">
                            {messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    onClick={() => {
                                        setSelectedMessage(msg);
                                        if (msg.status === 'new') handleMarkRead(msg.id);
                                    }}
                                    className={cn(
                                        'p-4 cursor-pointer transition-colors hover:bg-surface-50 dark:hover:bg-surface-800/50',
                                        selectedMessage?.id === msg.id && 'bg-primary-50/50 dark:bg-primary-500/10',
                                        msg.status === 'new' && 'border-l-3 border-l-blue-500'
                                    )}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="font-semibold text-sm text-surface-900 dark:text-surface-100 truncate">
                                                    {msg.visitor_name}
                                                </span>
                                                {statusBadge(msg.status)}
                                            </div>
                                            <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">{msg.visitor_email}</p>
                                            <p className="text-sm text-surface-700 dark:text-surface-300 line-clamp-2">
                                                {msg.message_body}
                                            </p>
                                        </div>
                                        <div className="text-[11px] text-surface-400 dark:text-surface-500 shrink-0">
                                            {msg.created_at ? new Date(msg.created_at).toLocaleDateString() : ''}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between px-4 py-3 border-t border-surface-100 dark:border-surface-800">
                            <span className="text-xs text-surface-500 dark:text-surface-400">{total} messages</span>
                            <div className="flex gap-1">
                                <button
                                    onClick={() => setPage(p => Math.max(1, p - 1))}
                                    disabled={page === 1}
                                    className="p-1 rounded text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-30 transition-colors"
                                >
                                    <ChevronLeft size={16} />
                                </button>
                                <span className="text-xs text-surface-600 dark:text-surface-400 px-2 py-1">{page} / {totalPages}</span>
                                <button
                                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                    disabled={page >= totalPages}
                                    className="p-1 rounded text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 disabled:opacity-30 transition-colors"
                                >
                                    <ChevronRight size={16} />
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Detail Panel */}
                {selectedMessage && (
                    <div className="w-96 bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5 shrink-0 self-start">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-bold text-surface-900 dark:text-white">Message Details</h3>
                            <div className="flex gap-1">
                                {selectedMessage.status !== 'replied' && (
                                    <button
                                        onClick={() => handleMarkReplied(selectedMessage.id)}
                                        className="p-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 transition-colors"
                                        title="Mark as replied"
                                    >
                                        <CheckCircle2 size={16} />
                                    </button>
                                )}
                                <button
                                    onClick={() => handleDelete(selectedMessage.id)}
                                    className="p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-500/10 text-rose-500 dark:text-rose-400 transition-colors"
                                    title="Delete"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <label className="text-[11px] font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider">From</label>
                                <p className="text-sm font-medium text-surface-900 dark:text-surface-100">{selectedMessage.visitor_name}</p>
                                <p className="text-xs text-surface-500 dark:text-surface-400">{selectedMessage.visitor_email}</p>
                                {selectedMessage.visitor_phone && <p className="text-xs text-surface-500 dark:text-surface-400">{selectedMessage.visitor_phone}</p>}
                            </div>

                            <div>
                                <label className="text-[11px] font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider">Status</label>
                                <div className="mt-0.5">{statusBadge(selectedMessage.status)}</div>
                            </div>

                            {selectedMessage.bot_name && (
                                <div>
                                    <label className="text-[11px] font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider">Bot</label>
                                    <p className="text-sm text-surface-700 dark:text-surface-300">{selectedMessage.bot_name}</p>
                                </div>
                            )}

                            <div>
                                <label className="text-[11px] font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider">Received</label>
                                <p className="text-sm text-surface-700 dark:text-surface-300">
                                    {selectedMessage.created_at ? new Date(selectedMessage.created_at).toLocaleString() : 'Unknown'}
                                </p>
                            </div>

                            <div>
                                <label className="text-[11px] font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider">Message</label>
                                <div className="mt-1 p-3 bg-surface-50 dark:bg-surface-800 rounded-xl">
                                    <p className="text-sm text-surface-800 dark:text-surface-200 whitespace-pre-wrap leading-relaxed">
                                        {selectedMessage.message_body}
                                    </p>
                                </div>
                            </div>

                            {/* Quick reply via email link */}
                            <a
                                href={`mailto:${selectedMessage.visitor_email}?subject=Re: Your message to us&body=Hi ${selectedMessage.visitor_name},\n\nThank you for reaching out.\n\n`}
                                className="flex items-center justify-center gap-2 w-full py-2.5 bg-primary-600 hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600 text-white rounded-xl text-sm font-medium transition-colors"
                                onClick={() => handleMarkReplied(selectedMessage.id)}
                            >
                                <Mail size={15} /> Reply via Email
                            </a>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
