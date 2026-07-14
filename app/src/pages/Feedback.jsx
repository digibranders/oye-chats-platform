import { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getFeedbackData } from '../services/api';
import { ThumbsUp, ThumbsDown, MessageSquare, ChevronDown, ChevronUp, Download, Clock } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts';
import { useBotContext } from '../context/BotContext';
import { cn } from '../lib/utils';
import PageHeader from '../components/PageHeader';
import Tabs from '../components/ui/Tabs';
import EmptyState from '../components/ui/EmptyState';

const DATE_FILTERS = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: 'All', days: 0 },
];

function buildTrendData(feedback, days) {
    const cutoff = days ? new Date(Date.now() - days * 86400000) : null;
    const filtered = cutoff ? feedback.filter(f => new Date(f.created_at) >= cutoff) : feedback;

    const buckets = {};
    filtered.forEach(f => {
        const date = new Date(f.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (!buckets[date]) buckets[date] = { date, positive: 0, total: 0 };
        buckets[date].total++;
        if (f.feedback === 1) buckets[date].positive++;
    });

    return Object.values(buckets).slice(-14).map(b => ({
        date: b.date,
        rate: b.total > 0 ? Math.round((b.positive / b.total) * 100) : 0,
        total: b.total,
    }));
}

// Group negatives by (normalized) question text and return the top N most
// frequently downvoted prompts. This surfaces the answers customers should
// actually improve — replaces the earlier keyword-based category donut,
// which was cosmetic rather than actionable.
function buildTopDownvoted(feedback, limit = 5) {
    const buckets = new Map();
    feedback.forEach(f => {
        if (f.feedback === 1) return;
        const raw = (f.question || '').trim();
        if (!raw) return;
        const key = raw.toLowerCase().replace(/\s+/g, ' ');
        const existing = buckets.get(key);
        if (existing) {
            existing.count += 1;
            const existingAt = new Date(existing.lastAt).getTime();
            const currentAt = new Date(f.created_at).getTime();
            if (currentAt > existingAt) existing.lastAt = f.created_at;
        } else {
            buckets.set(key, { question: raw, count: 1, lastAt: f.created_at });
        }
    });
    return Array.from(buckets.values())
        .sort((a, b) => b.count - a.count || new Date(b.lastAt) - new Date(a.lastAt))
        .slice(0, limit);
}

function exportFeedbackCsv(feedback) {
    const rows = ['Date,User,Type,Question,Answer']
        .concat(feedback.map(f => [
            new Date(f.created_at).toLocaleDateString(),
            (f.user || '').replace(/,/g, ''),
            f.feedback === 1 ? 'Positive' : 'Negative',
            (f.question || '').replace(/,/g, '').replace(/"/g, '""'),
            (f.answer || '').replace(/,/g, '').replace(/"/g, '""'),
        ].map(v => `"${v}"`).join(',')))
        .join('\n');
    const blob = new Blob([rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'feedback.csv'; a.click();
    URL.revokeObjectURL(url);
}

export default function Feedback({ embedded = false }) {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const [feedback, setFeedback] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('all');
    const [expandedId, setExpandedId] = useState(null);
    const [dateFilter, setDateFilter] = useState(0);

    useEffect(() => {
        const fetchFeedback = async () => {
            setIsLoading(true);
            try { setFeedback(await getFeedbackData(selectedBot?.id)); }
            catch (err) { console.error('Failed to load feedback:', err); setError('Failed to load feedback data.'); }
            finally { setIsLoading(false); }
        };
        fetchFeedback();
    }, [selectedBot?.id]);

    const dateFiltered = useMemo(() => {
        if (!dateFilter) return feedback;
        const cutoff = new Date(Date.now() - dateFilter * 86400000);
        return feedback.filter(f => new Date(f.created_at) >= cutoff);
    }, [feedback, dateFilter]);

    const filtered = useMemo(() => {
        if (filter === 'positive') return dateFiltered.filter(f => f.feedback === 1);
        if (filter === 'negative') return dateFiltered.filter(f => f.feedback !== 1);
        return dateFiltered;
    }, [dateFiltered, filter]);

    const stats = useMemo(() => {
        const total = dateFiltered.length;
        const positive = dateFiltered.filter(f => f.feedback === 1).length;
        const negative = total - positive;
        const rate = total > 0 ? Math.round((positive / total) * 100) : 0;
        return { total, positive, negative, rate };
    }, [dateFiltered]);

    const trendData = useMemo(() => buildTrendData(feedback, dateFilter), [feedback, dateFilter]);
    const topDownvoted = useMemo(() => buildTopDownvoted(dateFiltered), [dateFiltered]);
    const maxDownvotes = topDownvoted[0]?.count || 0;

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Feedback" description="Create a chatbot first to start collecting user feedback on responses." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const formatDate = (isoString) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(isoString));

    const tabs = [
        { id: 'all', label: `All (${stats.total})` },
        { id: 'positive', label: `Positive (${stats.positive})` },
        { id: 'negative', label: `Negative (${stats.negative})` },
    ];

    return (
        <motion.div
            initial={embedded ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            className="space-y-6"
        >
            {!embedded && (
                <PageHeader
                    crumbs={[{ label: 'Home', to: '/' }, { label: 'Response Feedback' }]}
                    title="Response Feedback"
                    actions={(
                        <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1 bg-surface-100 dark:bg-surface-800 rounded-lg p-0.5">
                                {DATE_FILTERS.map(df => (
                                    <button
                                        key={df.days}
                                        onClick={() => setDateFilter(df.days)}
                                        className={cn(
                                            'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                                            dateFilter === df.days
                                                ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-100 shadow-sm'
                                                : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200'
                                        )}
                                    >
                                        {df.label}
                                    </button>
                                ))}
                            </div>
                            {feedback.length > 0 && (
                                <button
                                    onClick={() => exportFeedbackCsv(filtered)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-surface-600 dark:text-surface-300 bg-[var(--bg-card)] dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors"
                                >
                                    <Download size={13} /> Export CSV
                                </button>
                            )}
                        </div>
                    )}
                />
            )}

            {error && (
                <div className="bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 p-3 rounded-xl border border-rose-500/20 text-sm font-medium">
                    {error}
                </div>
            )}

            {isLoading ? (
                <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-12 flex flex-col items-center justify-center min-h-[400px]">
                    <div className="w-10 h-10 border-3 border-primary-500/20 border-t-primary-500 rounded-full animate-spin" />
                    <p className="mt-4 text-surface-500 dark:text-surface-400 text-sm font-medium">Loading feedback...</p>
                </div>
            ) : feedback.length === 0 ? (
                <EmptyState
                    icon={MessageSquare}
                    title="No Feedback Yet"
                    description="Your users haven't rated any chatbot responses yet. Ratings will appear here once they use the thumbs up/down buttons."
                    compact
                />
            ) : (
                <>
                    {/* Summary Bar */}
                    <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                        <div className="flex items-center gap-6 flex-1">
                            <div>
                                <p className="text-2xl font-bold text-surface-900 dark:text-white tabular-nums">{stats.total}</p>
                                <p className="text-xs text-surface-400 dark:text-surface-500">Total ratings</p>
                            </div>
                            <div className="h-8 w-px bg-surface-200 dark:bg-surface-700" />
                            <div className="flex items-center gap-2">
                                <ThumbsUp size={16} className="text-emerald-500" />
                                <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{stats.rate}%</span>
                                <span className="text-xs text-surface-400 dark:text-surface-500">positive</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <ThumbsDown size={16} className="text-rose-500" />
                                <span className="text-sm font-bold text-rose-600 dark:text-rose-400 tabular-nums">{stats.negative}</span>
                                <span className="text-xs text-surface-400 dark:text-surface-500">negative</span>
                            </div>
                        </div>
                        <div className="w-full sm:w-48 h-2 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full transition-all duration-700" style={{ width: `${stats.rate}%` }} />
                        </div>
                    </div>

                    {/* Charts row */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* CSAT Trend Line */}
                        {trendData.length > 1 && (
                            <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5">
                                <h3 className="text-base font-bold text-surface-900 dark:text-surface-100 mb-4">Satisfaction Trend</h3>
                                <ResponsiveContainer width="100%" height={160}>
                                    <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} padding={{ left: 12, right: 12 }} />
                                        <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} width={40} />
                                        <ReTooltip
                                            contentStyle={{ background: 'var(--color-surface-900, #0f172a)', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 8, fontSize: 11, color: 'var(--color-surface-50, #f8fafc)' }}
                                            itemStyle={{ color: 'var(--color-surface-50, #f8fafc)' }}
                                            labelStyle={{ color: 'var(--color-surface-300, #d6d3d1)' }}
                                            formatter={(v) => [`${v}%`, 'Positive rate']}
                                        />
                                        <Line type="monotone" dataKey="rate" stroke="#22c55e" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        )}

                        {/* Top Downvoted Questions — actionable: these are the answers
                            the bot is losing users on and should be improved. Clicking
                            a row jumps into the detailed card below by matching the
                            question to any one negative feedback entry. */}
                        {topDownvoted.length > 0 && (
                            <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5">
                                <div className="flex items-center justify-between mb-4">
                                    <h3 className="text-base font-bold text-surface-900 dark:text-surface-100">Top downvoted questions</h3>
                                    <span className="text-[10px] font-medium uppercase tracking-wider text-surface-400 dark:text-surface-500">Fix these first</span>
                                </div>
                                <ul className="space-y-2.5">
                                    {topDownvoted.map((item) => {
                                        const width = maxDownvotes > 0 ? Math.max(6, Math.round((item.count / maxDownvotes) * 100)) : 0;
                                        return (
                                            <li key={item.question}>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const key = item.question.toLowerCase().replace(/\s+/g, ' ');
                                                        const match = dateFiltered.find(
                                                            f => f.feedback !== 1 && (f.question || '').trim().toLowerCase().replace(/\s+/g, ' ') === key
                                                        );
                                                        if (match) {
                                                            setFilter('negative');
                                                            setExpandedId(match.message_id);
                                                            requestAnimationFrame(() => {
                                                                document.querySelector(`[data-feedback-id="${match.message_id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                                            });
                                                        }
                                                    }}
                                                    className="w-full text-left group"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <p className="flex-1 text-sm text-surface-800 dark:text-surface-200 group-hover:text-primary-500 dark:group-hover:text-primary-400 truncate transition-colors">
                                                            {item.question}
                                                        </p>
                                                        <span className="text-xs font-bold text-rose-500 tabular-nums shrink-0">
                                                            {item.count}
                                                        </span>
                                                    </div>
                                                    <div className="mt-1.5 h-1.5 w-full bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-rose-500/80 group-hover:bg-rose-500 rounded-full transition-all duration-500"
                                                            style={{ width: `${width}%` }}
                                                        />
                                                    </div>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        )}
                    </div>

                    {/* Filter Tabs */}
                    <Tabs tabs={tabs} activeTab={filter} onChange={setFilter} />

                    {/* Feedback Cards */}
                    <div className="space-y-3">
                        {filtered.map((item) => {
                            const isExpanded = expandedId === item.message_id;
                            const isPositive = item.feedback === 1;
                            return (
                                <div
                                    key={item.message_id}
                                    data-feedback-id={item.message_id}
                                    className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-xl border border-surface-200 dark:border-surface-800 overflow-hidden hover:shadow-sm dark:hover:shadow-surface-950/30 transition-all"
                                >
                                    <button
                                        onClick={() => setExpandedId(isExpanded ? null : item.message_id)}
                                        className="w-full flex items-center gap-4 p-4 text-left"
                                    >
                                        <div className={cn(
                                            'p-2 rounded-lg shrink-0',
                                            isPositive
                                                ? 'bg-emerald-50 dark:bg-emerald-500/10'
                                                : 'bg-rose-50 dark:bg-rose-500/10'
                                        )}>
                                            {isPositive
                                                ? <ThumbsUp size={16} className="text-emerald-500 fill-current" />
                                                : <ThumbsDown size={16} className="text-rose-500 fill-current" />
                                            }
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">{item.question}</p>
                                            <div className="flex items-center gap-3 mt-1">
                                                <span className="text-[11px] text-surface-400 dark:text-surface-500">{formatDate(item.created_at)}</span>
                                                <span className="text-[11px] text-primary-500 dark:text-primary-400 font-medium">{item.user}</span>
                                            </div>
                                        </div>
                                        {isExpanded
                                            ? <ChevronUp size={16} className="text-surface-400 dark:text-surface-500 shrink-0" />
                                            : <ChevronDown size={16} className="text-surface-400 dark:text-surface-500 shrink-0" />
                                        }
                                    </button>

                                    <AnimatePresence>
                                        {isExpanded && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.25, ease: 'easeInOut' }}
                                                className="overflow-hidden"
                                            >
                                                <div className="px-4 pb-4 pt-0 space-y-3">
                                                    <div className="p-3 bg-surface-50 dark:bg-surface-800 rounded-lg">
                                                        <p className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 mb-1">User Question</p>
                                                        <p className="text-sm text-surface-900 dark:text-surface-100">{item.question}</p>
                                                    </div>
                                                    <div className="p-3 bg-surface-50 dark:bg-surface-800 rounded-lg">
                                                        <p className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 mb-1">Bot Answer</p>
                                                        <p className="text-sm text-surface-600 dark:text-surface-300">{item.answer}</p>
                                                    </div>
                                                    {!isPositive && (
                                                        <button
                                                            onClick={() => {
                                                                const text = `Issue: Poor chatbot response\n\nQuestion: ${item.question}\n\nBot Answer: ${item.answer}\n\nFeedback: Negative (thumbs down)`;
                                                                navigator.clipboard.writeText(text);
                                                            }}
                                                            className="w-full py-1.5 px-3 text-xs font-medium border border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors"
                                                        >
                                                            Copy issue to clipboard
                                                        </button>
                                                    )}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </motion.div>
    );
}
