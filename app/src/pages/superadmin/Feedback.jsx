import { useEffect, useState } from 'react';
import { getGlobalFeedbackData, getPlatformFeedback } from '../../services/api';
import { ThumbsUp, ThumbsDown, MessageSquareQuote, Building2 as BuildingIcon, User, Calendar, MessageCircle } from 'lucide-react';

const TABS = [
    { id: 'chat', label: 'Chat Ratings', TabIcon: ThumbsUp },
    { id: 'platform', label: 'Platform Feedback', TabIcon: MessageCircle },
];

const formatDate = (isoString) => {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(date);
};

function EmptyState({ icon, title, description }) {
    const EmptyIcon = icon;
    return (
        <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm p-12 flex flex-col items-center text-center min-h-[400px] justify-center">
            <div className="w-20 h-20 bg-surface-50 dark:bg-surface-800 rounded-full flex items-center justify-center mb-6">
                <EmptyIcon className="w-10 h-10 text-primary-500" />
            </div>
            <h3 className="text-xl font-bold text-surface-900 dark:text-surface-100 mb-2">{title}</h3>
            <p className="text-surface-500 dark:text-surface-400 max-w-md mx-auto">{description}</p>
        </div>
    );
}

function LoadingState() {
    return (
        <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm p-12 flex flex-col items-center justify-center min-h-[400px]">
            <div className="w-12 h-12 border-4 border-primary-500/20 border-t-primary-500 rounded-full animate-spin"></div>
            <p className="mt-4 text-surface-500 dark:text-surface-400 font-medium">Loading...</p>
        </div>
    );
}

function ChatRatingsTab() {
    const [feedback, setFeedback] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        getGlobalFeedbackData()
            .then(setFeedback)
            .catch(() => setError('Failed to load chat ratings.'))
            .finally(() => setIsLoading(false));
    }, []);

    if (isLoading) return <LoadingState />;

    if (error) return (
        <div className="bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 p-4 rounded-xl border border-rose-100 dark:border-rose-700 flex items-center gap-2">
            <span className="font-semibold">Error:</span> {error}
        </div>
    );

    if (feedback.length === 0) return (
        <EmptyState
            icon={MessageSquareQuote}
            title="No Chat Ratings Yet"
            description="Your clients' users haven't rated any chatbot responses yet. Once they click the thumbs up or down icons in the widgets, they will appear here."
        />
    );

    return (
        <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm overflow-hidden flex flex-col">
            <div className="overflow-x-auto min-h-[400px]">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-surface-50 dark:bg-surface-800/50 border-b border-surface-200 dark:border-surface-700 text-surface-500 dark:text-surface-400 text-sm font-medium">
                            <th className="py-4 px-6 truncate"><div className="flex items-center gap-2"><BuildingIcon className="w-4 h-4" /> Client</div></th>
                            <th className="py-4 px-6 truncate w-32"><div className="flex items-center gap-2"><User className="w-4 h-4" /> User Session</div></th>
                            <th className="py-4 px-6"><div className="flex items-center gap-2"><Calendar className="w-4 h-4" /> Date</div></th>
                            <th className="py-4 px-6 w-1/4">User Question</th>
                            <th className="py-4 px-6 w-1/4">Bot Answer</th>
                            <th className="py-4 px-6 text-center">Rating</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-200 dark:divide-surface-800">
                        {feedback.map((item) => (
                            <tr key={item.message_id} className="hover:bg-surface-50/50 dark:hover:bg-surface-800/50 transition-colors group">
                                <td className="py-4 px-6 align-top">
                                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-primary-500/10 text-primary-600 dark:text-primary-400 whitespace-nowrap">
                                        <BuildingIcon className="w-3.5 h-3.5" />
                                        {item.client_name}
                                    </div>
                                </td>
                                <td className="py-4 px-6 align-top">
                                    <div className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-surface-100/80 dark:bg-surface-800 text-surface-600 dark:text-surface-400 whitespace-nowrap">
                                        {item.user}
                                    </div>
                                </td>
                                <td className="py-4 px-6 text-sm text-surface-500 dark:text-surface-400 align-top whitespace-nowrap">
                                    {formatDate(item.created_at)}
                                </td>
                                <td className="py-4 px-6 align-top">
                                    <p className="text-surface-900 dark:text-surface-100 text-sm line-clamp-3 group-hover:line-clamp-none transition-all duration-300">
                                        {item.question}
                                    </p>
                                </td>
                                <td className="py-4 px-6 align-top">
                                    <p className="text-surface-600 dark:text-surface-400 text-sm line-clamp-2 transition-all duration-300 bg-surface-50 dark:bg-surface-800 p-2 rounded-lg border border-transparent group-hover:border-surface-200 dark:group-hover:border-surface-700">
                                        {item.answer}
                                    </p>
                                </td>
                                <td className="py-4 px-6 align-middle">
                                    <div className="flex justify-center items-center">
                                        {item.feedback === 1 ? (
                                            <div className="inline-flex items-center justify-center p-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-700" title="Good Response">
                                                <ThumbsUp className="w-5 h-5 fill-current" />
                                            </div>
                                        ) : (
                                            <div className="inline-flex items-center justify-center p-2 rounded-xl bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 border border-rose-100 dark:border-rose-700" title="Bad Response">
                                                <ThumbsDown className="w-5 h-5 fill-current" />
                                            </div>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function PlatformFeedbackTab() {
    const [items, setItems] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        getPlatformFeedback()
            .then(setItems)
            .catch(() => setError('Failed to load platform feedback.'))
            .finally(() => setIsLoading(false));
    }, []);

    if (isLoading) return <LoadingState />;

    if (error) return (
        <div className="bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 p-4 rounded-xl border border-rose-100 dark:border-rose-700 flex items-center gap-2">
            <span className="font-semibold">Error:</span> {error}
        </div>
    );

    if (items.length === 0) return (
        <EmptyState
            icon={MessageCircle}
            title="No Platform Feedback Yet"
            description="When clients submit feedback via the Feedback side tab in their admin panel, it will appear here."
        />
    );

    return (
        <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-surface-50 dark:bg-surface-800/50 border-b border-surface-200 dark:border-surface-700 text-surface-500 dark:text-surface-400 text-sm font-medium">
                            <th className="py-4 px-6"><div className="flex items-center gap-2"><BuildingIcon className="w-4 h-4" /> Client</div></th>
                            <th className="py-4 px-6"><div className="flex items-center gap-2"><Calendar className="w-4 h-4" /> Date</div></th>
                            <th className="py-4 px-6">Feedback</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-200 dark:divide-surface-800">
                        {items.map((item) => (
                            <tr key={item.id} className="hover:bg-surface-50/50 dark:hover:bg-surface-800/50 transition-colors group">
                                <td className="py-4 px-6 align-top">
                                    <div className="flex flex-col gap-0.5">
                                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-primary-500/10 text-primary-600 dark:text-primary-400 whitespace-nowrap w-fit">
                                            <BuildingIcon className="w-3.5 h-3.5" />
                                            {item.client_name}
                                        </div>
                                        {item.client_email && (
                                            <span className="text-xs text-surface-400 dark:text-surface-500 pl-1">{item.client_email}</span>
                                        )}
                                    </div>
                                </td>
                                <td className="py-4 px-6 text-sm text-surface-500 dark:text-surface-400 align-top whitespace-nowrap">
                                    {formatDate(item.created_at)}
                                </td>
                                <td className="py-4 px-6 align-top">
                                    <p className="text-surface-800 dark:text-surface-200 text-sm leading-relaxed whitespace-pre-wrap">
                                        {item.message}
                                    </p>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default function SuperadminFeedback() {
    const [activeTab, setActiveTab] = useState('chat');

    return (
        <div className="space-y-6 animate-slide-up pb-10">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-surface-900 to-surface-600 dark:from-surface-100 dark:to-surface-400 bg-clip-text text-transparent">
                    Global Feedback
                </h1>
                <p className="text-surface-500 dark:text-surface-400 mt-1">
                    Chat ratings from widget visitors and platform feedback from admin users.
                </p>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 p-1 bg-surface-100 dark:bg-surface-800 rounded-xl w-fit">
                {TABS.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                            activeTab === tab.id
                                ? 'bg-white dark:bg-surface-900 text-surface-900 dark:text-white shadow-sm'
                                : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200'
                        }`}
                    >
                        <tab.TabIcon className="w-4 h-4" />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Tab content */}
            {activeTab === 'chat' ? <ChatRatingsTab /> : <PlatformFeedbackTab />}
        </div>
    );
}
