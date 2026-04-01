import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, Activity, BarChart3, Zap, MessageSquare } from 'lucide-react';
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';
import { getActivityStats, getTopQuestions } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import StatCard from '../components/ui/StatCard';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonChart } from '../components/ui/SkeletonLoader';

export default function Analytics({ embedded = false }) {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [activityData, setActivityData] = useState([]);
    const [topQuestions, setTopQuestions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [timeRange, setTimeRange] = useState('all');

    useEffect(() => {
        const fetchData = async () => {
            setIsLoading(true);
            try {
                const [activity, questions] = await Promise.all([
                    getActivityStats(selectedBot?.id),
                    getTopQuestions(selectedBot?.id)
                ]);

                const activityMap = {};
                activity.forEach(item => {
                    const key = item.date.slice(0, 10);
                    activityMap[key] = (activityMap[key] || 0) + item.messages;
                });

                const toLocalKey = (d) => {
                    const y = d.getFullYear();
                    const m = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    return `${y}-${m}-${day}`;
                };

                const today = new Date();
                today.setHours(0, 0, 0, 0);

                let startDate = new Date(today);
                if (activity.length > 0) {
                    const earliest = activity
                        .map(d => {
                            const [y, mo, dy] = d.date.slice(0, 10).split('-').map(Number);
                            return new Date(y, mo - 1, dy);
                        })
                        .reduce((a, b) => (a < b ? a : b));
                    startDate = earliest;
                } else {
                    startDate.setDate(today.getDate() - 6);
                }

                const filled = [];
                const cursor = new Date(startDate);
                while (cursor <= today) {
                    const key = toLocalKey(cursor);
                    const displayDate = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    filled.push({ date: key, displayDate, messages: activityMap[key] || 0, isReal: !!activityMap[key] });
                    cursor.setDate(cursor.getDate() + 1);
                }

                setActivityData(filled);
                setTopQuestions(questions);
            } catch (error) {
                console.error('Failed to load analytics data', error);
                showToast('error', error.message || 'Failed to load analytics data');
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
    }, [selectedBot?.id]);

    const filteredData = useMemo(() => {
        if (timeRange === 'all') return activityData;
        const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
        return activityData.slice(-days);
    }, [activityData, timeRange]);

    const metrics = useMemo(() => {
        if (!filteredData || filteredData.length === 0) return { total: 0, average: 0, peak: 0, peakDate: '—' };
        const total = filteredData.reduce((sum, item) => sum + item.messages, 0);
        const average = Math.round(total / filteredData.length);
        let peak = 0, peakDate = '—';
        filteredData.forEach(item => {
            if (item.messages > peak) { peak = item.messages; peakDate = item.displayDate; }
        });
        return { total, average, peak, peakDate };
    }, [filteredData]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Analytics" description="Create a chatbot first to start tracking conversation analytics and user engagement." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-secondary-900 p-3 border border-secondary-700 shadow-xl rounded-xl">
                    <p className="text-secondary-400 font-medium text-xs mb-1">{label}</p>
                    <p className="font-bold text-lg text-white">{payload[0].value} <span className="text-sm font-normal text-secondary-400">messages</span></p>
                </div>
            );
        }
        return null;
    };

    const ranges = [
        { id: '7d', label: '7 days' },
        { id: '30d', label: '30 days' },
        { id: '90d', label: '90 days' },
        { id: 'all', label: 'All time' },
    ];

    return (
        <div className={`space-y-6 ${embedded ? '' : 'animate-fade-in'}`}>
            {!embedded && <PageHeader title="Analytics" subtitle="Understand how your chatbot performs" />}

            {/* Metric Cards */}
            {!isLoading && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <StatCard icon={Activity} label="Total Messages" value={metrics.total.toLocaleString()} trendLabel="selected period" />
                    <StatCard icon={BarChart3} label="Daily Average" value={`~${metrics.average.toLocaleString()}`} trendLabel="per day" />
                    <StatCard icon={Zap} label="Peak Traffic" value={metrics.peak.toLocaleString()} trendLabel={metrics.peakDate} />
                </div>
            )}

            {/* Chart */}
            <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                    <div>
                        <h2 className="text-lg font-bold text-secondary-900 flex items-center gap-2">
                            <TrendingUp size={18} className="text-primary-600" />
                            Engagement Timeline
                        </h2>
                        <p className="text-sm text-secondary-500 mt-0.5">Daily message volume</p>
                    </div>
                    {/* Time Range Pills */}
                    <div className="flex items-center gap-1 p-1 bg-secondary-100 rounded-lg">
                        {ranges.map((r) => (
                            <button
                                key={r.id}
                                onClick={() => setTimeRange(r.id)}
                                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                                    timeRange === r.id
                                        ? 'bg-white text-secondary-900 shadow-sm'
                                        : 'text-secondary-500 hover:text-secondary-700:text-secondary-300'
                                }`}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>
                </div>

                {isLoading ? (
                    <div className="h-72 flex items-center justify-center">
                        <div className="animate-pulse w-full h-full bg-secondary-100 rounded-xl" />
                    </div>
                ) : filteredData.length === 0 ? (
                    <div className="h-72 flex flex-col items-center justify-center border-2 border-dashed border-secondary-100 rounded-xl">
                        <TrendingUp className="text-secondary-300 mb-3" size={32} />
                        <p className="text-secondary-500 text-sm">No activity data yet</p>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height={300}>
                        <AreaChart data={filteredData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                            <defs>
                                <linearGradient id="colorMessages" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.15} />
                                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" strokeOpacity={0.5} />
                            <XAxis dataKey="displayDate" tickLine={false} axisLine={false} tick={{ fill: '#a1a1aa', fontSize: 11 }} dy={8} />
                            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#a1a1aa', fontSize: 11 }} width={35} />
                            <Tooltip content={<CustomTooltip />} />
                            <Area type="monotone" dataKey="messages" stroke="#2563eb" strokeWidth={2} fill="url(#colorMessages)" dot={false} activeDot={{ r: 5, fill: '#2563eb', stroke: '#fff', strokeWidth: 2 }} />
                        </AreaChart>
                    </ResponsiveContainer>
                )}
            </div>

            {/* Top Questions */}
            <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                <div className="flex items-center gap-2 mb-5">
                    <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center">
                        <MessageSquare size={18} className="text-primary-600" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-secondary-900">Top User Questions</h2>
                        <p className="text-sm text-secondary-500">Most frequent queries</p>
                    </div>
                </div>

                {isLoading ? (
                    <div className="space-y-3">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="animate-pulse h-12 bg-secondary-100 rounded-xl" />
                        ))}
                    </div>
                ) : topQuestions.length === 0 ? (
                    <div className="py-10 text-center border-2 border-dashed border-secondary-100 rounded-xl">
                        <p className="text-secondary-500 text-sm">No questions recorded yet</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {topQuestions.map((item, index) => {
                            const maxCount = topQuestions[0]?.count || 1;
                            const barWidth = Math.max((item.count / maxCount) * 100, 8);
                            return (
                                <div key={index} className="flex items-center gap-3 p-3 rounded-xl hover:bg-secondary-50:bg-secondary-800/50 transition-all">
                                    <span className="w-7 h-7 rounded-full bg-secondary-100 flex items-center justify-center text-xs font-bold text-secondary-500 shrink-0">
                                        {index + 1}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-secondary-900 truncate">{item.question}</p>
                                        <div className="mt-1.5 h-1.5 bg-secondary-100 rounded-full overflow-hidden">
                                            <div className="h-full bg-primary-500 rounded-full transition-all duration-700" style={{ width: `${barWidth}%` }} />
                                        </div>
                                    </div>
                                    <span className="text-sm font-bold text-primary-600 shrink-0">{item.count}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
