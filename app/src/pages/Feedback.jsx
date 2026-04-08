import { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getFeedbackData } from '../services/api';
import { ThumbsUp, ThumbsDown, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import { useBotContext } from '../context/BotContext';
import { cn } from '../lib/utils';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import EmptyState from '../components/ui/EmptyState';

export default function Feedback({ embedded = false }) {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const [feedback, setFeedback] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('all');
    const [expandedId, setExpandedId] = useState(null);

    useEffect(() => {
        const fetchFeedback = async () => {
            setIsLoading(true);
            try { setFeedback(await getFeedbackData(selectedBot?.id)); }
            catch (err) { console.error('Failed to load feedback:', err); setError('Failed to load feedback data.'); }
            finally { setIsLoading(false); }
        };
        fetchFeedback();
    }, [selectedBot?.id]);

    const filtered = useMemo(() => {
        if (filter === 'positive') return feedback.filter(f => f.feedback === 1);
        if (filter === 'negative') return feedback.filter(f => f.feedback !== 1);
        return feedback;
    }, [feedback, filter]);

    const stats = useMemo(() => {
        const total = feedback.length;
        const positive = feedback.filter(f => f.feedback === 1).length;
        const negative = total - positive;
        const rate = total > 0 ? Math.round((positive / total) * 100) : 0;
        return { total, positive, negative, rate };
    }, [feedback]);

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
            {!embedded && <PageHeader title="Response Feedback" subtitle="See how users rate your chatbot's responses" />}

            {error && (
                <div className="bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 p-3 rounded-xl border border-rose-500/20 text-sm font-medium">
                    {error}
                </div>
            )}

            {isLoading ? (
                <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-12 flex flex-col items-center justify-center min-h-[400px]">
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
                    <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                        <div className="flex items-center gap-6 flex-1">
                            <div>
                                <p className="text-2xl font-bold text-surface-900 dark:text-white">{stats.total}</p>
                                <p className="text-xs text-surface-400 dark:text-surface-500">Total ratings</p>
                            </div>
                            <div className="h-8 w-px bg-surface-200 dark:bg-surface-700" />
                            <div className="flex items-center gap-2">
                                <ThumbsUp size={16} className="text-emerald-500" />
                                <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{stats.rate}%</span>
                                <span className="text-xs text-surface-400 dark:text-surface-500">positive</span>
                            </div>
                        </div>
                        <div className="w-full sm:w-48 h-2 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full transition-all duration-700" style={{ width: `${stats.rate}%` }} />
                        </div>
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
                                    className="bg-white dark:bg-surface-900 rounded-xl border border-surface-200 dark:border-surface-800 overflow-hidden hover:shadow-sm dark:hover:shadow-surface-950/30 transition-all"
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
