import { useEffect, useState } from 'react';
import { getGlobalFeedbackData } from '../../services/api';
import { ThumbsUp, ThumbsDown, MessageSquareQuote, Search, Calendar, User, BuildingIcon } from 'lucide-react';

export default function SuperadminFeedback() {
    const [feedback, setFeedback] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchFeedback = async () => {
            try {
                const data = await getGlobalFeedbackData();
                setFeedback(data);
            } catch (err) {
                console.error("Failed to load global feedback:", err);
                setError('Failed to load global feedback data.');
            } finally {
                setIsLoading(false);
            }
        };

        fetchFeedback();
    }, []);

    const formatDate = (isoString) => {
        const date = new Date(isoString);
        return new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        }).format(date);
    };

    return (
        <div className="space-y-6 animate-slide-up pb-10">
            {/* Header section */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold bg-gradient-to-r from-secondary-900 to-secondary-600 dark:from-white dark:to-secondary-400 bg-clip-text text-transparent">Global Feedback</h1>
                    <p className="text-secondary-500 dark:text-secondary-400 mt-1">Review live thumbs-up and thumbs-down ratings from users across all clients on the platform.</p>
                </div>
            </div>

            {/* Error State */}
            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-4 rounded-xl border border-red-100 dark:border-red-800/50 flex items-center gap-2">
                    <span className="font-semibold">Error:</span> {error}
                </div>
            )}

            {/* Content Area */}
            {isLoading ? (
                <div className="bg-white dark:bg-secondary-800 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm p-12 flex flex-col items-center justify-center min-h-[400px]">
                    <div className="w-12 h-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>
                    <p className="mt-4 text-secondary-500 font-medium">Loading global feedback data...</p>
                </div>
            ) : feedback.length === 0 ? (
                <div className="bg-white dark:bg-secondary-800 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm p-12 flex flex-col items-center text-center min-h-[400px] justify-center">
                    <div className="w-20 h-20 bg-secondary-50 dark:bg-secondary-700/50 rounded-full flex items-center justify-center mb-6">
                        <MessageSquareQuote className="w-10 h-10 text-indigo-500" />
                    </div>
                    <h3 className="text-xl font-bold text-secondary-900 dark:text-white mb-2">No Global Feedback Yet</h3>
                    <p className="text-secondary-500 max-w-md mx-auto">
                        Your clients' users haven't rated any chatbot responses yet. Once they click the thumbs up or down icons in the widgets, they will appear here.
                    </p>
                </div>
            ) : (
                <div className="bg-white dark:bg-secondary-800 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm overflow-hidden flex flex-col">
                    <div className="overflow-x-auto min-h-[400px]">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-secondary-50 dark:bg-secondary-800/50 border-b border-secondary-200 dark:border-secondary-700 text-secondary-500 dark:text-secondary-400 text-sm font-medium">
                                    <th className="py-4 px-6 truncate"><div className="flex items-center gap-2"><BuildingIcon className="w-4 h-4" /> Client</div></th>
                                    <th className="py-4 px-6 truncate w-32"><div className="flex items-center gap-2"><User className="w-4 h-4" /> User Session</div></th>
                                    <th className="py-4 px-6"><div className="flex items-center gap-2"><Calendar className="w-4 h-4" /> Date</div></th>
                                    <th className="py-4 px-6 w-1/4">User Question</th>
                                    <th className="py-4 px-6 w-1/4">Bot Answer</th>
                                    <th className="py-4 px-6 text-center">Rating</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-secondary-200 dark:divide-secondary-700">
                                {feedback.map((item) => (
                                    <tr key={item.message_id} className="hover:bg-secondary-50/50 dark:hover:bg-secondary-700/20 transition-colors group">
                                        <td className="py-4 px-6 align-top">
                                            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 whitespace-nowrap">
                                                <BuildingIcon className="w-3.5 h-3.5" />
                                                {item.client_name}
                                            </div>
                                        </td>
                                        <td className="py-4 px-6 align-top">
                                            <div className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-secondary-100/80 dark:bg-secondary-700/80 text-secondary-600 dark:text-secondary-300 whitespace-nowrap">
                                                {item.user}
                                            </div>
                                        </td>
                                        <td className="py-4 px-6 text-sm text-secondary-500 dark:text-secondary-400 align-top whitespace-nowrap">
                                            {formatDate(item.created_at)}
                                        </td>
                                        <td className="py-4 px-6 align-top">
                                            <p className="text-secondary-900 dark:text-white text-sm line-clamp-3 group-hover:line-clamp-none transition-all duration-300">
                                                {item.question}
                                            </p>
                                        </td>
                                        <td className="py-4 px-6 align-top">
                                            <p className="text-secondary-600 dark:text-secondary-300 text-sm line-clamp-2 transition-all duration-300 bg-secondary-50 dark:bg-secondary-800/50 p-2 rounded-lg border border-transparent group-hover:border-secondary-200 dark:group-hover:border-secondary-700">
                                                {item.answer}
                                            </p>
                                        </td>
                                        <td className="py-4 px-6 align-middle">
                                            <div className="flex justify-center items-center">
                                                {item.feedback === 1 ? (
                                                    <div className="inline-flex items-center justify-center p-2 rounded-xl bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border border-green-100 dark:border-green-800/50" title="Good Response">
                                                        <ThumbsUp className="w-5 h-5 fill-current" />
                                                    </div>
                                                ) : (
                                                    <div className="inline-flex items-center justify-center p-2 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-800/50" title="Bad Response">
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
            )}
        </div>
    );
}
