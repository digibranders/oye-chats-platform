import { useState, useEffect } from 'react';
import { Users, CheckCircle, MessageSquare, BarChart3, Upload, Palette, Code2, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getDashboardStats, getTopQuestions } from '../services/api';
import { useBotContext } from '../context/BotContext';
import StatCard from '../components/ui/StatCard';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';

export default function Dashboard() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const [stats, setStats] = useState(null);
    const [topQuestions, setTopQuestions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const navigate = useNavigate();

    const adminName = localStorage.getItem('admin_name') || 'there';

    useEffect(() => {
        if (!selectedBot?.id) {
            setIsLoading(false);
            return;
        }
        const fetchData = async () => {
            setIsLoading(true);
            try {
                const [statsData, questionsData] = await Promise.all([
                    getDashboardStats(selectedBot.id),
                    getTopQuestions(selectedBot.id)
                ]);
                setStats(statsData);
                setTopQuestions(questionsData);
            } catch (error) {
                console.error('Failed to fetch dashboard data', error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
    }, [selectedBot?.id]);

    // Greeting based on time of day
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    if (!botsLoading && bots.length === 0) {
        return (
            <EmptyState
                title="Welcome to OyeChat"
                description="Create your first chatbot to start seeing analytics, visitor data, and conversation insights here."
                actionLabel="Create Your First Chatbot"
                actionTo="/chatbot"
            />
        );
    }

    const rankColors = ['text-amber-500', 'text-secondary-400', 'text-amber-700'];
    const rankBgs = ['bg-amber-50 border-amber-200', 'bg-secondary-50 border-secondary-200', 'bg-amber-50/50 border-amber-100'];

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Greeting */}
            <div>
                <h1 className="text-2xl font-bold text-secondary-900 tracking-tight">
                    {greeting}, {adminName.split(' ')[0]}
                </h1>
                <p className="text-secondary-500 mt-1 text-sm">{today}</p>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                    icon={Users}
                    label="Active Users"
                    value={isLoading ? '—' : (stats?.active_users || 0)}
                    badge="Live"
                    badgeColor="success"
                    loading={isLoading}
                />
                <StatCard
                    icon={CheckCircle}
                    label="Success Rate"
                    value={isLoading ? '—' : `${stats?.success_rate || 0}%`}
                    loading={isLoading}
                >
                    {!isLoading && (
                        <div className="w-full h-1.5 bg-secondary-100 rounded-full mt-3 overflow-hidden absolute bottom-0 left-0">
                            <div
                                className="h-full bg-primary-500 rounded-full transition-all duration-1000"
                                style={{ width: `${stats?.success_rate || 0}%` }}
                            />
                        </div>
                    )}
                </StatCard>
                <StatCard
                    icon={MessageSquare}
                    label="Conversations"
                    value={isLoading ? '—' : (stats?.total_conversations?.toLocaleString() || '0')}
                    loading={isLoading}
                />
                <StatCard
                    icon={BarChart3}
                    label="Total Messages"
                    value={isLoading ? '—' : (stats?.total_messages?.toLocaleString() || '0')}
                    loading={isLoading}
                />
            </div>

            {/* Quick Actions */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                    { icon: Upload, label: 'Upload documents', desc: 'Add to your knowledge base', to: '/knowledge' },
                    { icon: Palette, label: 'Customize appearance', desc: 'Brand your chatbot', to: '/chatbot?tab=appearance' },
                    { icon: Code2, label: 'Get embed code', desc: 'Add to your website', to: '/chatbot' },
                ].map((action) => (
                    <button
                        key={action.to}
                        onClick={() => navigate(action.to)}
                        className="flex items-center gap-3 p-4 bg-white rounded-xl border border-secondary-200 hover:border-primary-300:border-primary-700 hover:shadow-sm transition-all text-left group"
                    >
                        <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0 group-hover:bg-primary-100:bg-primary-500/20 transition-colors">
                            <action.icon size={18} className="text-primary-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-secondary-900">{action.label}</p>
                            <p className="text-xs text-secondary-500">{action.desc}</p>
                        </div>
                        <ArrowRight size={14} className="text-secondary-300 group-hover:text-primary-500 transition-colors" />
                    </button>
                ))}
            </div>

            {/* Top Questions */}
            <div className="bg-white rounded-2xl border border-secondary-200 shadow-sm">
                <div className="p-6 pb-4 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-primary-50 flex items-center justify-center">
                        <MessageSquare size={20} className="text-primary-600" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-secondary-900">Most Frequent Questions</h2>
                        <p className="text-sm text-secondary-500">Understand what your users are asking about most</p>
                    </div>
                </div>

                <div className="px-6 pb-6">
                    {isLoading ? (
                        <div className="space-y-3">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="animate-pulse flex items-center gap-4 p-4 bg-secondary-50 rounded-xl">
                                    <div className="w-9 h-9 rounded-full bg-secondary-200" />
                                    <div className="flex-1 h-4 bg-secondary-200 rounded-lg" />
                                    <div className="w-16 h-6 bg-secondary-200 rounded-lg" />
                                </div>
                            ))}
                        </div>
                    ) : topQuestions.length === 0 ? (
                        <div className="py-10 text-center border-2 border-dashed border-secondary-100 rounded-xl">
                            <p className="text-secondary-500 text-sm">No queries yet. Interactions will appear here.</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {topQuestions.map((item, index) => (
                                <div
                                    key={index}
                                    className="flex items-center justify-between p-4 rounded-xl hover:bg-secondary-50:bg-secondary-800/50 transition-all group"
                                >
                                    <div className="flex items-center gap-4 min-w-0">
                                        <span className={`flex items-center justify-center w-9 h-9 rounded-full text-sm font-bold border ${
                                            index < 3
                                                ? rankBgs[index]
                                                : 'bg-secondary-50 border-secondary-200'
                                        } ${index < 3 ? rankColors[index] : 'text-secondary-400'} group-hover:scale-105 transition-transform`}>
                                            {index + 1}
                                        </span>
                                        <p className="text-secondary-900 font-medium text-sm truncate">
                                            {item.question}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1.5 px-3 py-1 bg-secondary-100 rounded-lg shrink-0 ml-4">
                                        <span className="text-sm font-bold text-primary-600">{item.count}</span>
                                        <span className="text-[9px] uppercase tracking-wider font-bold text-secondary-400">hits</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
