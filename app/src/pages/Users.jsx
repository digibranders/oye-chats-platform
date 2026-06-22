import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircle, X, Loader2, Bot, User, Search, Download } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts';
import { getVisitorsData, getChatHistory } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { cn } from '../lib/utils';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';

const TAG_OPTIONS = [
    { id: 'hot-lead', label: 'Hot Lead', color: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400 border-rose-200 dark:border-rose-500/30' },
    { id: 'support', label: 'Support', color: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-400 border-sky-200 dark:border-sky-500/30' },
    { id: 'spam', label: 'Spam', color: 'bg-surface-100 text-surface-500 dark:bg-surface-800 dark:text-surface-400 border-surface-200 dark:border-surface-700' },
    { id: 'vip', label: 'VIP', color: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 border-amber-200 dark:border-amber-500/30' },
];

function buildTimelineData(messages) {
    const counts = {};
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        counts[key] = 0;
    }
    messages.forEach(msg => {
        const key = new Date(msg.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (key in counts) counts[key]++;
    });
    return Object.entries(counts).map(([date, count]) => ({ date, count }));
}

export default function Users({ embedded = false }) {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [visitors, setVisitors] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedSessionId, setSelectedSessionId] = useState(null);
    const [chatHistory, setChatHistory] = useState([]);
    const [isChatLoading, setIsChatLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [tagsBySession, setTagsBySession] = useState(() => {
        try { return JSON.parse(localStorage.getItem('conv_tags') || '{}'); } catch { return {}; }
    });

    const fetchVisitors = async () => {
        setIsLoading(true);
        try { setVisitors(await getVisitorsData(selectedBot?.id)); }
        catch (error) { console.error('Failed to load visitors:', error); showToast('error', error.message || 'Failed to load visitors'); }
        finally { setIsLoading(false); }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { fetchVisitors(); }, [selectedBot?.id]);

    const handleViewChat = async (sessionId) => {
        setSelectedSessionId(sessionId);
        setIsChatLoading(true);
        try { setChatHistory(await getChatHistory(sessionId)); }
        catch (error) { console.error('Failed to load chat history:', error); showToast('error', error.message || 'Failed to load chat history'); }
        finally { setIsChatLoading(false); }
    };

    const closeChatDrawer = () => { setSelectedSessionId(null); setChatHistory([]); };

    const formatDate = (dateString) => new Date(dateString).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const toggleTag = (sessionId, tagId) => {
        setTagsBySession(prev => {
            const existing = prev[sessionId] || [];
            const updated = existing.includes(tagId)
                ? existing.filter(t => t !== tagId)
                : [...existing, tagId];
            const next = { ...prev, [sessionId]: updated };
            localStorage.setItem('conv_tags', JSON.stringify(next));
            return next;
        });
    };

    const exportChat = () => {
        const blob = new Blob([JSON.stringify(chatHistory, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-${selectedSessionId?.slice(0, 8)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const filtered = useMemo(() => visitors.filter(v => {
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            if (!v.visitor.toLowerCase().includes(q)) return false;
        }
        return true;
    }), [visitors, searchQuery]);

    const timelineData = useMemo(() => buildTimelineData(chatHistory), [chatHistory]);
    const selectedVisitor = visitors.find(v => v.session_id === selectedSessionId);
    const sessionTags = selectedSessionId ? (tagsBySession[selectedSessionId] || []) : [];

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Conversations" description="Create a chatbot first to start tracking visitor sessions and conversations." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    return (
        <div className={cn('space-y-6', !embedded && 'animate-fade-in')}>
            {!embedded && <PageHeader title="Conversations" subtitle="See who's chatting and what they're asking" />}

            {/* Search */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="relative max-w-sm flex-1">
                    <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400 dark:text-surface-500" />
                    <input
                        type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search visitors..."
                        className="w-full pl-10 pr-4 py-2 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm"
                    />
                </div>
            </div>

            {/* Visitors list — compact card layout. We dropped the table
                shell when the column count fell to three; a stretched
                three-column table looked sparse on wide screens. The list
                row groups avatar + name on the left and the chat-count
                badge + view button on the right with natural spacing, so
                the layout reads well at any width without dead whitespace. */}
            {isLoading ? (
                <div className="space-y-2">
                    {[1, 2, 3, 4, 5].map((i) => (
                        <div
                            key={i}
                            className="h-14 bg-surface-100 dark:bg-surface-800/60 rounded-xl animate-pulse"
                        />
                    ))}
                </div>
            ) : filtered.length === 0 ? (
                <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm py-14 text-center">
                    <MessageCircle className="w-8 h-8 mx-auto mb-3 text-surface-300 dark:text-surface-600" />
                    <p className="text-sm text-surface-500 dark:text-surface-400">No visitors found</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {filtered.map((visitor) => (
                        <button
                            key={visitor.session_id}
                            onClick={() => handleViewChat(visitor.session_id)}
                            className={cn(
                                'group w-full flex items-center gap-4 px-4 py-3 rounded-xl',
                                'bg-white dark:bg-surface-900',
                                'border border-surface-200 dark:border-surface-800',
                                'hover:border-primary-300 dark:hover:border-primary-500/40',
                                'hover:shadow-sm transition-all text-left',
                            )}
                        >
                            <div className="w-9 h-9 rounded-full bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center text-primary-600 dark:text-primary-400 font-bold text-xs shrink-0">
                                {visitor.visitor.substring(0, 1).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-surface-900 dark:text-surface-100 group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors truncate">
                                    {visitor.visitor}
                                </p>
                                <p className="text-[11px] text-surface-400 dark:text-surface-500 mt-0.5">
                                    {visitor.chats} {visitor.chats === 1 ? 'message' : 'messages'}
                                </p>
                            </div>
                            <span className="inline-flex items-center justify-center min-w-[1.75rem] h-6 px-2 rounded-full bg-surface-100 dark:bg-surface-800 text-[11px] font-bold text-surface-600 dark:text-surface-300">
                                {visitor.chats}
                            </span>
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-surface-200 dark:border-surface-700 text-xs font-semibold text-surface-600 dark:text-surface-300 group-hover:border-primary-400 dark:group-hover:border-primary-500 group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-all bg-white dark:bg-surface-800">
                                <MessageCircle className="w-3.5 h-3.5" /> View
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {/* Chat History Drawer */}
            <AnimatePresence>
                {selectedSessionId && (
                    <div className="fixed inset-0 z-50 flex">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="absolute inset-0 bg-black/30 dark:bg-black/60 backdrop-blur-sm"
                            onClick={closeChatDrawer}
                        />
                        <motion.div
                            initial={{ x: '100%' }}
                            animate={{ x: 0 }}
                            exit={{ x: '100%' }}
                            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                            className="relative ml-auto h-full w-full max-w-lg bg-white dark:bg-surface-900 shadow-2xl flex flex-col border-l border-surface-200 dark:border-surface-800"
                        >
                            {/* Drawer Header */}
                            <div className="px-5 py-4 border-b border-surface-100 dark:border-surface-800 shrink-0">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-3">
                                        <div className="w-9 h-9 rounded-full bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center">
                                            <MessageCircle className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                                        </div>
                                        <div>
                                            <h3 className="font-bold text-surface-900 dark:text-surface-100 text-sm">{selectedVisitor?.visitor || 'Chat History'}</h3>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        {chatHistory.length > 0 && (
                                            <button
                                                onClick={exportChat}
                                                className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-400 dark:text-surface-500 transition-colors"
                                                title="Export chat as JSON"
                                            >
                                                <Download className="w-4 h-4" />
                                            </button>
                                        )}
                                        <button onClick={closeChatDrawer} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 text-surface-400 dark:text-surface-500 transition-colors">
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                {/* Tags row */}
                                <div className="flex flex-wrap gap-1.5 mb-3">
                                    {TAG_OPTIONS.map(tag => {
                                        const isActive = sessionTags.includes(tag.id);
                                        return (
                                            <button
                                                key={tag.id}
                                                onClick={() => toggleTag(selectedSessionId, tag.id)}
                                                className={cn(
                                                    'px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-all',
                                                    isActive ? tag.color : 'border-dashed border-surface-300 dark:border-surface-600 text-surface-400 dark:text-surface-500 hover:border-solid'
                                                )}
                                            >
                                                {isActive ? '✓ ' : ''}{tag.label}
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Session timeline mini chart */}
                                {!isChatLoading && chatHistory.length > 0 && (
                                    <div className="h-14">
                                        <p className="text-[10px] font-medium text-surface-400 dark:text-surface-500 mb-1">Messages last 7 days</p>
                                        <ResponsiveContainer width="100%" height={36}>
                                            <BarChart data={timelineData} barSize={6}>
                                                <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                                                <ReTooltip
                                                    contentStyle={{ background: 'var(--color-surface-900, #0f172a)', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 8, fontSize: 11 }}
                                                    labelStyle={{ color: '#94a3b8' }}
                                                    itemStyle={{ color: '#a5b4fc' }}
                                                />
                                                <Bar dataKey="count" fill="#6366f1" radius={[2, 2, 0, 0]} />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                )}
                            </div>

                            {/* Chat Messages */}
                            <div className="flex-1 overflow-y-auto p-5 space-y-3">
                                {isChatLoading ? (
                                    <div className="flex flex-col items-center justify-center h-full">
                                        <Loader2 className="w-6 h-6 animate-spin text-primary-500 mb-2" />
                                        <p className="text-sm text-surface-400 dark:text-surface-500">Loading conversation...</p>
                                    </div>
                                ) : chatHistory.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-surface-400 dark:text-surface-500">
                                        <MessageCircle className="w-8 h-8 mb-2 opacity-40" />
                                        <p className="text-sm">No messages in this session</p>
                                    </div>
                                ) : chatHistory.map((msg, index) => {
                                    const isBot = msg.role === 'assistant' || msg.role === 'bot';
                                    const msgDate = new Date(msg.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                                    const prevDate = index > 0 ? new Date(chatHistory[index - 1].timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
                                    const showDivider = msgDate !== prevDate;
                                    return (
                                        <React.Fragment key={index}>
                                            {showDivider && (
                                                <div className="flex justify-center my-4">
                                                    <span className="px-3 py-1 bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 text-[10px] font-bold uppercase tracking-wider rounded-full">{msgDate}</span>
                                                </div>
                                            )}
                                            <div className={cn('flex', isBot ? 'justify-start' : 'justify-end')}>
                                                <div className={cn('flex max-w-[85%] gap-2.5', isBot ? 'flex-row' : 'flex-row-reverse')}>
                                                    <div className="flex-shrink-0 mt-1">
                                                        {isBot ? (
                                                            <div className="w-7 h-7 rounded-full bg-primary-100 dark:bg-primary-500/20 flex items-center justify-center">
                                                                <Bot className="w-3.5 h-3.5 text-primary-600 dark:text-primary-400" />
                                                            </div>
                                                        ) : (
                                                            <div className="w-7 h-7 rounded-full bg-surface-200 dark:bg-surface-700 flex items-center justify-center">
                                                                <User className="w-3.5 h-3.5 text-surface-600 dark:text-surface-300" />
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className={cn('flex flex-col', isBot ? 'items-start' : 'items-end')}>
                                                        <div className={cn(
                                                            'px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed',
                                                            isBot
                                                                ? 'bg-surface-100 dark:bg-surface-800 text-surface-800 dark:text-surface-200 rounded-tl-sm'
                                                                : 'bg-primary-600 dark:bg-primary-500 text-white rounded-tr-sm'
                                                        )}>
                                                            {msg.content}
                                                        </div>
                                                        <span className="text-[10px] text-surface-400 dark:text-surface-500 mt-1 px-1">{formatDate(msg.timestamp)}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </React.Fragment>
                                    );
                                })}
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    );
}
