import { useEffect, useState, useMemo } from 'react';
import { getFeedbackData } from '../services/api';
import { ThumbsUp, ThumbsDown, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import { useBotContext } from '../context/BotContext';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import EmptyState from '../components/ui/EmptyState';

export default function Feedback() {
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

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Feedback" description="Create a chatbot first to start collecting user feedback on responses." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

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

    const formatDate = (isoString) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(isoString));

    const tabs = [
        { id: 'all', label: `All (${stats.total})` },
        { id: 'positive', label: `Positive (${stats.positive})` },
        { id: 'negative', label: `Negative (${stats.negative})` },
    ];

    return (
        <div className="space-y-6 animate-fade-in">
            <PageHeader title="Response Feedback" subtitle="See how users rate your chatbot's responses" />

            {error && (
                <div className="bg-error-50 dark:bg-error-500/10 text-error-600 dark:text-error-500 p-3 rounded-xl border border-error-500/20 text-sm font-medium">
                    {error}
                </div>
            )}

            {isLoading ? (
                <div className="bg-white dark:bg-secondary-900 rounded-2xl border border-secondary-200 dark:border-secondary-800 p-12 flex flex-col items-center justify-center min-h-[400px]">
                    <div className="w-10 h-10 border-3 border-primary-500/20 border-t-primary-500 rounded-full animate-spin" />
                    <p className="mt-4 text-secondary-500 text-sm font-medium">Loading feedback...</p>
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
                    <div className="bg-white dark:bg-secondary-900 rounded-2xl border border-secondary-200 dark:border-secondary-800 p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                        <div className="flex items-center gap-6 flex-1">
                            <div>
                                <p className="text-2xl font-bold text-secondary-900 dark:text-white">{stats.total}</p>
                                <p className="text-xs text-secondary-400">Total ratings</p>
                            </div>
                            <div className="h-8 w-px bg-secondary-200 dark:bg-secondary-800" />
                            <div className="flex items-center gap-2">
                                <ThumbsUp size={16} className="text-success-500" />
                                <span className="text-sm font-bold text-success-600 dark:text-success-500">{stats.rate}%</span>
                                <span className="text-xs text-secondary-400">positive</span>
                            </div>
                        </div>
                        <div className="w-full sm:w-48 h-2 bg-secondary-100 dark:bg-secondary-800 rounded-full overflow-hidden">
                            <div className="h-full bg-success-500 rounded-full transition-all duration-700" style={{ width: `${stats.rate}%` }} />
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
                                <div key={item.message_id} className="bg-white dark:bg-secondary-900 rounded-xl border border-secondary-200 dark:border-secondary-800 overflow-hidden hover:shadow-sm transition-all">
                                    <button
                                        onClick={() => setExpandedId(isExpanded ? null : item.message_id)}
                                        className="w-full flex items-center gap-4 p-4 text-left"
                                    >
                                        <div className={`p-2 rounded-lg shrink-0 ${isPositive ? 'bg-success-50 dark:bg-success-500/10' : 'bg-error-50 dark:bg-error-500/10'}`}>
                                            {isPositive
                                                ? <ThumbsUp size={16} className="text-success-500 fill-current" />
                                                : <ThumbsDown size={16} className="text-error-500 fill-current" />
                                            }
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-secondary-900 dark:text-white truncate">{item.question}</p>
                                            <div className="flex items-center gap-3 mt-1">
                                                <span className="text-[11px] text-secondary-400">{formatDate(item.created_at)}</span>
                                                <span className="text-[11px] text-primary-500 font-medium">{item.user}</span>
                                            </div>
                                        </div>
                                        {isExpanded ? <ChevronUp size={16} className="text-secondary-400 shrink-0" /> : <ChevronDown size={16} className="text-secondary-400 shrink-0" />}
                                    </button>

                                    {isExpanded && (
                                        <div className="px-4 pb-4 pt-0 space-y-3 animate-fade-in">
                                            <div className="p-3 bg-secondary-50 dark:bg-secondary-800/50 rounded-lg">
                                                <p className="text-[10px] font-bold uppercase tracking-wider text-secondary-400 mb-1">User Question</p>
                                                <p className="text-sm text-secondary-900 dark:text-white">{item.question}</p>
                                            </div>
                                            <div className="p-3 bg-secondary-50 dark:bg-secondary-800/50 rounded-lg">
                                                <p className="text-[10px] font-bold uppercase tracking-wider text-secondary-400 mb-1">Bot Answer</p>
                                                <p className="text-sm text-secondary-600 dark:text-secondary-300">{item.answer}</p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}
