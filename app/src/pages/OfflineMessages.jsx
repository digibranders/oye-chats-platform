import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Inbox, Mail, Clock, CheckCircle2, Trash2, ChevronLeft, ChevronRight, CheckSquare, Square, BarChart2, MessageSquare, TrendingUp } from 'lucide-react';
import { getOfflineMessages, updateOfflineMessage, deleteOfflineMessage } from '../services/api';
import { useToast } from '../context/ToastContext';
import { cn } from '../lib/utils';

const DATE_FILTERS = [
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
    { label: 'All', days: 0 },
];

const QUICK_REPLIES = [
    { label: 'Will follow up', body: "Hi {name},\n\nThank you for reaching out! We've received your message and will follow up with you shortly.\n\nBest regards" },
    { label: 'Sent info', body: "Hi {name},\n\nThank you for your message. We've sent you the information you requested — please check your inbox.\n\nBest regards" },
    { label: 'Resolved', body: "Hi {name},\n\nThank you for contacting us. We're happy to let you know that your issue has been resolved. Please don't hesitate to reach out if you need further assistance.\n\nBest regards" },
];

function detectSentiment(text) {
    if (!text) return 'neutral';
    const lower = text.toLowerCase();
    const negative = ['problem', 'issue', 'broken', 'error', 'fail', 'frustrated', 'angry', 'terrible', 'bad', 'wrong', 'not working', 'cannot', "can't", 'urgent', 'asap'];
    const positive = ['thank', 'great', 'awesome', 'love', 'perfect', 'excellent', 'wonderful', 'happy', 'appreciate', 'good', 'amazing'];
    const negCount = negative.filter(w => lower.includes(w)).length;
    const posCount = positive.filter(w => lower.includes(w)).length;
    if (negCount > posCount) return 'negative';
    if (posCount > negCount) return 'positive';
    return 'neutral';
}

const SENTIMENT_CONFIG = {
    positive: { label: 'Positive', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400' },
    neutral: { label: 'Neutral', color: 'bg-surface-100 text-surface-500 dark:bg-surface-800 dark:text-surface-400' },
    negative: { label: 'Negative', color: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400' },
};

export default function OfflineMessages({ embedded = false }) {
    const { showToast } = useToast();
    const [messages, setMessages] = useState([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [statusFilter, setStatusFilter] = useState('');
    const [dateFilter, setDateFilter] = useState(0);
    const [loading, setLoading] = useState(true);
    const [selectedMessage, setSelectedMessage] = useState(null);
    const [selectedIds, setSelectedIds] = useState(new Set());

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
        try {
            await updateOfflineMessage(id, { status: 'read' });
            fetchMessages();
            if (selectedMessage?.id === id) {
                setSelectedMessage(prev => ({ ...prev, status: 'read' }));
            }
        } catch {
            showToast('error', 'Failed to mark message as read.');
        }
    };

    const handleMarkReplied = async (id) => {
        try {
            await updateOfflineMessage(id, { status: 'replied' });
            fetchMessages();
            if (selectedMessage?.id === id) {
                setSelectedMessage(prev => ({ ...prev, status: 'replied' }));
            }
        } catch {
            showToast('error', 'Failed to mark message as replied.');
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this message?')) return;
        try {
            await deleteOfflineMessage(id);
            if (selectedMessage?.id === id) setSelectedMessage(null);
            fetchMessages();
        } catch {
            showToast('error', 'Failed to delete message.');
        }
    };

    const handleBulkMarkRead = async () => {
        const ids = Array.from(selectedIds);
        await Promise.allSettled(ids.map(id => updateOfflineMessage(id, { status: 'read' })));
        setSelectedIds(new Set());
        fetchMessages();
    };

    const toggleSelect = (id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const filteredByDate = useMemo(() => {
        if (!dateFilter) return messages;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - dateFilter);
        return messages.filter(m => m.created_at && new Date(m.created_at) >= cutoff);
    }, [messages, dateFilter]);

    const stats = useMemo(() => {
        const total_ = messages.length;
        const unread = messages.filter(m => m.status === 'new').length;
        const replied = messages.filter(m => m.status === 'replied').length;
        const replyRate = total_ > 0 ? Math.round((replied / total_) * 100) : 0;
        return { total: total_, unread, replied, replyRate };
    }, [messages]);

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
    const allVisibleSelected = filteredByDate.length > 0 && filteredByDate.every(m => selectedIds.has(m.id));

    return (
        <div className="space-y-6">
            {!embedded && (
                <div>
                    <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Offline Messages</h1>
                    <p className="text-surface-500 dark:text-surface-400 text-sm mt-1">Messages left by visitors when no agent was available.</p>
                </div>
            )}

            {/* Stats bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                    { label: 'Total', value: stats.total, icon: MessageSquare, color: 'text-surface-700 dark:text-surface-200' },
                    { label: 'Unread', value: stats.unread, icon: Inbox, color: 'text-blue-600 dark:text-blue-400' },
                    { label: 'Replied', value: stats.replied, icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400' },
                    { label: 'Reply Rate', value: `${stats.replyRate}%`, icon: TrendingUp, color: 'text-primary-600 dark:text-primary-400' },
                ].map(s => (
                    <div key={s.label} className="bg-white dark:bg-surface-900 rounded-xl border border-surface-200 dark:border-surface-800 p-4 flex items-center gap-3">
                        <s.icon size={18} className={cn('shrink-0', s.color)} />
                        <div>
                            <p className="text-[11px] text-surface-400 dark:text-surface-500">{s.label}</p>
                            <p className={cn('text-xl font-bold', s.color)}>{s.value}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
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
                <div className="ml-auto flex items-center gap-1.5">
                    <Clock size={13} className="text-surface-400 dark:text-surface-500" />
                    {DATE_FILTERS.map(df => (
                        <button
                            key={df.days}
                            onClick={() => setDateFilter(df.days)}
                            className={cn(
                                'px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors',
                                dateFilter === df.days
                                    ? 'bg-surface-100 dark:bg-surface-800 border-surface-300 dark:border-surface-600 text-surface-700 dark:text-surface-300'
                                    : 'border-transparent text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200'
                            )}
                        >
                            {df.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Bulk action bar */}
            <AnimatePresence>
                {selectedIds.size > 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="flex items-center gap-3 p-3.5 bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/30 rounded-xl"
                    >
                        <span className="text-sm font-medium text-primary-700 dark:text-primary-300">{selectedIds.size} selected</span>
                        <button
                            onClick={handleBulkMarkRead}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-surface-900 border border-primary-300 dark:border-primary-500/40 text-primary-700 dark:text-primary-300 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-colors"
                        >
                            <CheckCircle2 size={13} /> Mark as read
                        </button>
                        <button
                            onClick={() => setSelectedIds(new Set())}
                            className="ml-auto text-xs text-primary-500 dark:text-primary-400 hover:underline"
                        >
                            Clear
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            <div className="flex gap-6">
                {/* Message List */}
                <div className="flex-1 bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 overflow-hidden">
                    {/* Select all header */}
                    {filteredByDate.length > 0 && (
                        <div className="px-4 py-2.5 border-b border-surface-100 dark:border-surface-800 flex items-center gap-3">
                            <button
                                onClick={() => {
                                    if (allVisibleSelected) {
                                        setSelectedIds(new Set());
                                    } else {
                                        setSelectedIds(new Set(filteredByDate.map(m => m.id)));
                                    }
                                }}
                                className="flex items-center gap-2 text-xs text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200"
                            >
                                {allVisibleSelected
                                    ? <CheckSquare size={14} className="text-primary-500" />
                                    : <Square size={14} />}
                                Select all
                            </button>
                            <span className="text-xs text-surface-400 dark:text-surface-500">{filteredByDate.length} messages</span>
                        </div>
                    )}

                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : filteredByDate.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 text-surface-400 dark:text-surface-500">
                            <Inbox size={40} className="mb-3" />
                            <p className="font-medium">No messages</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-surface-100 dark:divide-surface-800">
                            {filteredByDate.map((msg) => {
                                const sentiment = detectSentiment(msg.message_body);
                                const sc = SENTIMENT_CONFIG[sentiment];
                                return (
                                    <div
                                        key={msg.id}
                                        className={cn(
                                            'p-4 cursor-pointer transition-colors hover:bg-surface-50 dark:hover:bg-surface-800/50 flex gap-3',
                                            selectedMessage?.id === msg.id && 'bg-primary-50/50 dark:bg-primary-500/10',
                                            msg.status === 'new' && 'border-l-2 border-l-blue-500'
                                        )}
                                    >
                                        <button
                                            onClick={(e) => { e.stopPropagation(); toggleSelect(msg.id); }}
                                            className="shrink-0 mt-0.5"
                                        >
                                            {selectedIds.has(msg.id)
                                                ? <CheckSquare size={14} className="text-primary-500" />
                                                : <Square size={14} className="text-surface-400 dark:text-surface-500" />}
                                        </button>
                                        <div
                                            className="flex-1 min-w-0"
                                            onClick={() => {
                                                setSelectedMessage(msg);
                                                if (msg.status === 'new') handleMarkRead(msg.id);
                                            }}
                                        >
                                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                <span className="font-semibold text-sm text-surface-900 dark:text-surface-100 truncate">
                                                    {msg.visitor_name}
                                                </span>
                                                {statusBadge(msg.status)}
                                                <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', sc.color)}>{sc.label}</span>
                                                {msg.bot_name && (
                                                    <span
                                                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300"
                                                        title={`From ${msg.bot_name}`}
                                                    >
                                                        {msg.bot_name}
                                                    </span>
                                                )}
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
                                );
                            })}
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
                    <div className="w-96 bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5 shrink-0 self-start sticky top-4">
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

                            <div className="flex items-center gap-3">
                                <div>
                                    <label className="text-[11px] font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider">Status</label>
                                    <div className="mt-0.5">{statusBadge(selectedMessage.status)}</div>
                                </div>
                                <div>
                                    <label className="text-[11px] font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider">Sentiment</label>
                                    <div className="mt-0.5">
                                        <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', SENTIMENT_CONFIG[detectSentiment(selectedMessage.message_body)].color)}>
                                            {SENTIMENT_CONFIG[detectSentiment(selectedMessage.message_body)].label}
                                        </span>
                                    </div>
                                </div>
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

                            {/* Quick reply templates */}
                            <div>
                                <label className="text-[11px] font-medium text-surface-400 dark:text-surface-500 uppercase tracking-wider block mb-2">Quick Reply</label>
                                <div className="flex flex-col gap-1.5">
                                    {QUICK_REPLIES.map(qr => (
                                        <a
                                            key={qr.label}
                                            href={`mailto:${selectedMessage.visitor_email}?subject=Re: Your message&body=${encodeURIComponent(qr.body.replace('{name}', selectedMessage.visitor_name || 'there'))}`}
                                            onClick={() => handleMarkReplied(selectedMessage.id)}
                                            className="px-3 py-2 text-xs font-medium text-left border border-surface-200 dark:border-surface-700 rounded-lg hover:border-primary-400 dark:hover:border-primary-500 hover:bg-primary-50 dark:hover:bg-primary-500/10 text-surface-600 dark:text-surface-300 transition-colors"
                                        >
                                            {qr.label}
                                        </a>
                                    ))}
                                </div>
                            </div>

                            {/* Full reply link */}
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
