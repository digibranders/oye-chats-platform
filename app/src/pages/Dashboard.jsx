import { useState, useEffect } from 'react';
import { Loader2, Users, CheckCircle, MessageSquare } from 'lucide-react';
import { getDashboardStats, getTopQuestions } from '../services/api';
import { useBotContext } from '../context/BotContext';
import NoBotState from '../components/NoBotState';

export default function Dashboard() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const [stats, setStats] = useState(null);
    const [topQuestions, setTopQuestions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!selectedBot?.id) {
            setIsLoading(false);
            return;
        }
        const fetchData = async () => {
            setIsLoading(true);
            try {
                const botId = selectedBot?.id;
                const [statsData, questionsData] = await Promise.all([
                    getDashboardStats(botId),
                    getTopQuestions(botId)
                ]);
                setStats(statsData);
                setTopQuestions(questionsData);
            } catch (error) {
                console.error("Failed to fetch dashboard data", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
    }, [selectedBot?.id]);

    if (!botsLoading && bots.length === 0) {
        return <NoBotState title="Welcome to Your Dashboard" subtitle="Create your first chatbot to start seeing analytics, visitor data, and conversation insights here." />;
    }

    return (
        <div className="space-y-6 animate-slide-up">
            <div>
                <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Dashboard</h1>
                <p className="text-secondary-500 dark:text-secondary-400 mt-1">Welcome to the Admin portal.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                    <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary-500/5 rounded-full blur-2xl group-hover:bg-primary-500/10 transition-colors"></div>
                    <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400 flex items-center gap-2">
                        <Users size={16} className="text-primary-500" />
                        Active Users
                    </h3>
                    {isLoading ? (
                        <Loader2 className="animate-spin text-secondary-300 dark:text-secondary-600 mt-2" size={24} />
                    ) : (
                        <div className="mt-4 flex items-baseline gap-2">
                            <p className="text-3xl font-bold text-secondary-900 dark:text-white">{stats?.active_users || 0}</p>
                            <span className="text-xs font-medium text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">Live</span>
                        </div>
                    )}
                </div>

                <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                    <div className="absolute -right-4 -top-4 w-24 h-24 bg-primary-500/5 rounded-full blur-2xl group-hover:bg-primary-500/10 transition-colors"></div>
                    <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400 flex items-center gap-2">
                        <CheckCircle size={16} className="text-primary-500" />
                        Success Rate
                    </h3>
                    {isLoading ? (
                        <Loader2 className="animate-spin text-secondary-300 dark:text-secondary-600 mt-2" size={24} />
                    ) : (
                        <div className="mt-4">
                            <p className="text-3xl font-bold text-secondary-900 dark:text-white">{stats?.success_rate || 0}%</p>
                            <div className="w-full h-1.5 bg-secondary-100 dark:bg-secondary-700 rounded-full mt-3 overflow-hidden">
                                <div
                                    className="h-full bg-primary-500 rounded-full transition-all duration-1000"
                                    style={{ width: `${stats?.success_rate || 0}%` }}
                                ></div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md">
                    <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400">Total Conversations</h3>
                    {isLoading ? (
                        <Loader2 className="animate-spin text-secondary-300 dark:text-secondary-600 mt-2" size={24} />
                    ) : (
                        <p className="text-3xl font-bold text-secondary-900 dark:text-white mt-4">{stats?.total_conversations?.toLocaleString() || 0}</p>
                    )}
                </div>

                <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md">
                    <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400">Total Messages</h3>
                    {isLoading ? (
                        <Loader2 className="animate-spin text-secondary-300 dark:text-secondary-600 mt-2" size={24} />
                    ) : (
                        <p className="text-3xl font-bold text-secondary-900 dark:text-white mt-4">{stats?.total_messages?.toLocaleString() || 0}</p>
                    )}
                </div>
            </div>

            {/* Top Questions Summary Section */}
            <div className="bg-white dark:bg-secondary-800 p-8 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm transition-all">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-12 h-12 rounded-2xl bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 flex items-center justify-center">
                        <MessageSquare size={24} />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-secondary-900 dark:text-white">Most Frequent Questions</h2>
                        <p className="text-sm text-secondary-500 dark:text-secondary-400 mt-0.5">Understand what your users are asking about most.</p>
                    </div>
                </div>

                {isLoading ? (
                    <div className="flex flex-col items-center justify-center py-12 text-secondary-400">
                        <Loader2 className="animate-spin mb-3" size={32} />
                        <p>Loading summary...</p>
                    </div>
                ) : topQuestions.length === 0 ? (
                    <div className="h-32 flex flex-col items-center justify-center text-secondary-500 border-2 border-dashed border-secondary-100 dark:border-secondary-700 rounded-2xl">
                        <p>No query data yet. Interactions will appear here.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-4">
                        {topQuestions.map((item, index) => (
                            <div key={index} className="flex items-center justify-between p-5 bg-secondary-50 dark:bg-secondary-900/30 rounded-2xl border border-transparent hover:border-primary-100 dark:hover:border-primary-900/30 transition-all group">
                                <div className="flex items-center gap-5">
                                    <span className="flex items-center justify-center w-10 h-10 rounded-full bg-white dark:bg-secondary-800 text-sm font-bold text-secondary-500 dark:text-secondary-400 border border-secondary-200 dark:border-secondary-700 group-hover:bg-primary-500 group-hover:text-white group-hover:border-primary-500 transition-all shadow-sm">
                                        {index + 1}
                                    </span>
                                    <p className="text-secondary-900 dark:text-white font-semibold text-lg line-clamp-1 group-hover:translate-x-1 transition-transform">{item.question}</p>
                                </div>
                                <div className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-secondary-800 rounded-xl border border-secondary-200 dark:border-secondary-700 shadow-sm">
                                    <span className="text-lg font-black text-primary-600 dark:text-primary-400">{item.count}</span>
                                    <span className="text-[12px] uppercase tracking-widest font-bold text-secondary-400 dark:text-secondary-500">Hits</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
