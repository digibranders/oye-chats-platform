import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, Activity, BarChart3, Zap, MessageSquare, Star, CheckCircle2, XCircle, Target, Users } from 'lucide-react';
import {
    AreaChart,
    Area,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    RadialBarChart,
    RadialBar,
    PieChart,
    Pie,
    Cell,
    Legend,
} from 'recharts';
import { motion } from 'framer-motion';
import { getActivityStats, getTopQuestions, getRatingsSummary, getResolutionSummary, getLeadStats } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { cn } from '../lib/utils';
import StatCard from '../components/ui/StatCard';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';

const stagger = {
    animate: { transition: { staggerChildren: 0.06 } },
};
const fadeUp = {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

export default function Analytics({ embedded = false }) {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [activityData, setActivityData] = useState([]);
    const [topQuestions, setTopQuestions] = useState([]);
    const [ratingsSummary, setRatingsSummary] = useState(null);
    const [resolutionSummary, setResolutionSummary] = useState(null);
    const [leadStats, setLeadStats] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [timeRange, setTimeRange] = useState('all');
    const [activeTab, setActiveTab] = useState('overview');

    useEffect(() => {
        const fetchData = async () => {
            setIsLoading(true);
            try {
                const [activity, questions, ratings, resolution, leads] = await Promise.all([
                    getActivityStats(selectedBot?.id),
                    getTopQuestions(selectedBot?.id),
                    getRatingsSummary(selectedBot?.id),
                    getResolutionSummary(selectedBot?.id),
                    getLeadStats(selectedBot?.id).catch(() => null),
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
                setRatingsSummary(ratings);
                setResolutionSummary(resolution);
                setLeadStats(leads);
            } catch (error) {
                console.error('Failed to load analytics data', error);
                showToast('error', error.message || 'Failed to load analytics data');
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
    }, [selectedBot?.id, showToast]);

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
                <div className="bg-white dark:bg-surface-800 p-3 border border-surface-200 dark:border-surface-700 shadow-xl rounded-xl">
                    <p className="text-surface-500 dark:text-surface-400 font-medium text-xs mb-1">{label}</p>
                    <p className="font-bold text-lg text-surface-900 dark:text-white">{payload[0].value} <span className="text-sm font-normal text-surface-500 dark:text-surface-400">messages</span></p>
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
        <motion.div
            variants={stagger}
            initial="initial"
            animate="animate"
            className={cn('space-y-6', !embedded && 'animate-fade-in')}
        >
            {!embedded && <PageHeader title="Analytics" subtitle="Understand how your chatbot performs" />}

            {/* Tab Navigation */}
            {!embedded && (
                <motion.div variants={fadeUp} className="flex gap-1 p-1 bg-surface-100 dark:bg-surface-800 rounded-xl w-fit">
                    {[
                        { id: 'overview', label: 'Overview', icon: Activity },
                        { id: 'messages', label: 'Messages', icon: MessageSquare },
                        { id: 'leads', label: 'Leads', icon: Target },
                        { id: 'satisfaction', label: 'Satisfaction', icon: Star },
                    ].map(tab => {
                        const Icon = tab.icon;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={cn(
                                    'flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg transition-all',
                                    activeTab === tab.id
                                        ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                                        : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
                                )}
                            >
                                <Icon size={13} />
                                {tab.label}
                            </button>
                        );
                    })}
                </motion.div>
            )}

            {/* Metric Cards */}
            {!isLoading && activeTab === 'overview' && (
                <motion.div variants={fadeUp} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <StatCard icon={Activity} label="Total Messages" value={metrics.total.toLocaleString()} trendLabel="selected period" />
                    <StatCard icon={BarChart3} label="Daily Average" value={`~${metrics.average.toLocaleString()}`} trendLabel="per day" />
                    <StatCard icon={Zap} label="Peak Traffic" value={metrics.peak.toLocaleString()} trendLabel={metrics.peakDate} />
                </motion.div>
            )}
            {!isLoading && activeTab === 'leads' && leadStats && (
                <motion.div variants={fadeUp} className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {[
                        { label: 'Total Leads', value: leadStats.total || 0, icon: Users, color: 'text-surface-700 dark:text-surface-200' },
                        { label: 'MQL', value: leadStats.warm || leadStats.mql || 0, icon: Target, color: 'text-sky-600 dark:text-sky-400' },
                        { label: 'SAL', value: leadStats.hot || leadStats.sal || 0, icon: TrendingUp, color: 'text-orange-500 dark:text-orange-400' },
                        { label: 'SQL (Qualified)', value: leadStats.qualified || leadStats.sql || 0, icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400' },
                    ].map(s => (
                        <StatCard key={s.label} icon={s.icon} label={s.label} value={s.value} />
                    ))}
                </motion.div>
            )}

            {/* Messages Tab — BarChart */}
            {activeTab === 'messages' && (
                <motion.div variants={fadeUp} className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                        <div>
                            <h2 className="text-lg font-bold text-surface-900 dark:text-white flex items-center gap-2">
                                <MessageSquare size={18} className="text-primary-600 dark:text-primary-400" />
                                Daily Message Volume
                            </h2>
                            <p className="text-sm text-surface-500 mt-0.5">Messages per day over time</p>
                        </div>
                        <div className="flex items-center gap-1 p-1 bg-surface-100 dark:bg-surface-800 rounded-lg">
                            {ranges.map((r) => (
                                <button key={r.id} onClick={() => setTimeRange(r.id)}
                                    className={cn('px-3 py-1.5 text-xs font-medium rounded-md transition-all',
                                        timeRange === r.id ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm' : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
                                    )}>
                                    {r.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    {isLoading ? (
                        <div className="h-72 bg-surface-100 dark:bg-surface-800 rounded-xl animate-pulse" />
                    ) : filteredData.length === 0 ? (
                        <div className="h-72 flex items-center justify-center border-2 border-dashed border-surface-200 dark:border-surface-800 rounded-xl">
                            <p className="text-surface-500 text-sm">No data for this range</p>
                        </div>
                    ) : (
                        <ResponsiveContainer width="100%" height={300}>
                            <BarChart data={filteredData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" strokeOpacity={0.4} />
                                <XAxis dataKey="displayDate" tickLine={false} axisLine={false} tick={{ fill: '#a1a1aa', fontSize: 11 }} dy={8} />
                                <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#a1a1aa', fontSize: 11 }} width={35} />
                                <Tooltip content={<CustomTooltip />} />
                                <Bar dataKey="messages" fill="#6366f1" radius={[4, 4, 0, 0]} maxBarSize={40} />
                            </BarChart>
                        </ResponsiveContainer>
                    )}
                </motion.div>
            )}

            {/* Leads Tab — Funnel + BANT distribution */}
            {activeTab === 'leads' && (
                <motion.div variants={fadeUp} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                        <h2 className="text-base font-bold text-surface-900 dark:text-white mb-4 flex items-center gap-2">
                            <Target size={16} className="text-emerald-500" /> Lead Stage Distribution
                        </h2>
                        {leadStats ? (
                            <ResponsiveContainer width="100%" height={220}>
                                <BarChart layout="vertical" data={[
                                    { name: 'Unqualified', value: leadStats.cold || leadStats.unqualified || 0, fill: '#94a3b8' },
                                    { name: 'MQL', value: leadStats.warm || leadStats.mql || 0, fill: '#38bdf8' },
                                    { name: 'SAL', value: leadStats.hot || leadStats.sal || 0, fill: '#f97316' },
                                    { name: 'SQL', value: leadStats.qualified || leadStats.sql || 0, fill: '#22c55e' },
                                ]} margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                                    <XAxis type="number" tickLine={false} axisLine={false} tick={{ fill: '#a1a1aa', fontSize: 11 }} />
                                    <YAxis dataKey="name" type="category" tickLine={false} axisLine={false} tick={{ fill: '#a1a1aa', fontSize: 11 }} width={70} />
                                    <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }} />
                                    <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={24}>
                                        {[{ fill: '#94a3b8' }, { fill: '#38bdf8' }, { fill: '#f97316' }, { fill: '#22c55e' }].map((e, i) => (
                                            <Cell key={i} fill={e.fill} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        ) : <div className="h-48 flex items-center justify-center text-surface-400 text-sm">No lead data</div>}
                    </div>
                    <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                        <h2 className="text-base font-bold text-surface-900 dark:text-white mb-4 flex items-center gap-2">
                            <CheckCircle2 size={16} className="text-primary-500" /> Conversion Funnel
                        </h2>
                        {leadStats && leadStats.total > 0 ? (
                            <div className="space-y-3">
                                {[
                                    { label: 'Total Leads', value: leadStats.total, pct: 100, color: 'bg-surface-400 dark:bg-surface-500' },
                                    { label: 'MQL+', value: (leadStats.warm || 0) + (leadStats.hot || 0) + (leadStats.qualified || 0), pct: Math.round(((((leadStats.warm || 0) + (leadStats.hot || 0) + (leadStats.qualified || 0)) / leadStats.total) * 100)), color: 'bg-sky-400' },
                                    { label: 'SAL+', value: (leadStats.hot || 0) + (leadStats.qualified || 0), pct: Math.round(((((leadStats.hot || 0) + (leadStats.qualified || 0)) / leadStats.total) * 100)), color: 'bg-orange-400' },
                                    { label: 'SQL', value: leadStats.qualified || 0, pct: Math.round(((leadStats.qualified || 0) / leadStats.total) * 100), color: 'bg-emerald-500' },
                                ].map(row => (
                                    <div key={row.label}>
                                        <div className="flex justify-between text-xs mb-1">
                                            <span className="text-surface-600 dark:text-surface-300 font-medium">{row.label}</span>
                                            <span className="text-surface-500 dark:text-surface-400">{row.value} ({row.pct}%)</span>
                                        </div>
                                        <div className="h-2 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                                            <motion.div className={cn('h-full rounded-full', row.color)} initial={{ width: 0 }} animate={{ width: `${row.pct}%` }} transition={{ duration: 0.8, delay: 0.1 }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : <div className="h-48 flex items-center justify-center text-surface-400 text-sm">No lead data</div>}
                    </div>
                </motion.div>
            )}

            {/* Satisfaction Tab — Radial rings */}
            {activeTab === 'satisfaction' && (
                <motion.div variants={fadeUp} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                        <h2 className="text-base font-bold text-surface-900 dark:text-white mb-1 flex items-center gap-2">
                            <Star size={16} className="text-amber-500" /> Rating Distribution
                        </h2>
                        <p className="text-xs text-surface-500 mb-4">Post-chat satisfaction ratings</p>
                        {isLoading ? (
                            <div className="h-48 bg-surface-100 dark:bg-surface-800 rounded-xl animate-pulse" />
                        ) : ratingsSummary && ratingsSummary.total > 0 ? (
                            <div className="space-y-2.5">
                                {[5, 4, 3, 2, 1].map((star) => {
                                    const count = ratingsSummary?.distribution?.[star] ?? 0;
                                    const pct = ratingsSummary?.total > 0 ? Math.round((count / ratingsSummary.total) * 100) : 0;
                                    const barColor = star >= 4 ? 'bg-emerald-400' : star === 3 ? 'bg-amber-400' : 'bg-rose-400';
                                    return (
                                        <div key={star} className="flex items-center gap-3">
                                            <span className="text-xs font-medium text-surface-500 dark:text-surface-400 w-8 shrink-0 flex items-center gap-0.5">
                                                {star}<Star size={10} className="text-amber-400 fill-amber-400 inline" />
                                            </span>
                                            <div className="flex-1 h-4 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                                                <motion.div className={cn('h-full rounded-full', barColor)} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.7, delay: 0.1 }} />
                                            </div>
                                            <span className="text-xs font-medium text-surface-500 dark:text-surface-400 w-10 text-right shrink-0">{pct}%</span>
                                        </div>
                                    );
                                })}
                                <div className="pt-2 border-t border-surface-100 dark:border-surface-800 flex items-baseline gap-1.5">
                                    <span className="text-3xl font-bold text-surface-900 dark:text-white">{ratingsSummary.avg}</span>
                                    <span className="text-sm text-surface-400">/ 5</span>
                                    <span className="text-xs text-surface-400 ml-1">({ratingsSummary.total} ratings)</span>
                                </div>
                            </div>
                        ) : <div className="h-48 flex items-center justify-center text-surface-400 text-sm">No ratings yet</div>}
                    </div>
                    <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                        <h2 className="text-base font-bold text-surface-900 dark:text-white mb-1 flex items-center gap-2">
                            <CheckCircle2 size={16} className="text-emerald-500" /> Resolution Rate
                        </h2>
                        <p className="text-xs text-surface-500 mb-4">Were visitor issues resolved?</p>
                        {isLoading ? (
                            <div className="h-48 bg-surface-100 dark:bg-surface-800 rounded-xl animate-pulse" />
                        ) : resolutionSummary && resolutionSummary.total > 0 ? (
                            <>
                                <div className="flex justify-center mb-4">
                                    <ResponsiveContainer width={180} height={180}>
                                        <PieChart>
                                            <Pie data={[
                                                { name: 'Resolved', value: resolutionSummary.resolved },
                                                { name: 'Unresolved', value: resolutionSummary.unresolved },
                                            ]} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" paddingAngle={3}>
                                                <Cell fill="#22c55e" />
                                                <Cell fill="#fb7185" />
                                            </Pie>
                                            <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }} />
                                        </PieChart>
                                    </ResponsiveContainer>
                                </div>
                                <div className="flex gap-4 justify-center">
                                    <div className="flex items-center gap-2 text-sm">
                                        <div className="w-3 h-3 rounded-full bg-emerald-500" />
                                        <span className="text-surface-600 dark:text-surface-300">Resolved ({resolutionSummary.rate}%)</span>
                                    </div>
                                    <div className="flex items-center gap-2 text-sm">
                                        <div className="w-3 h-3 rounded-full bg-rose-400" />
                                        <span className="text-surface-600 dark:text-surface-300">Unresolved</span>
                                    </div>
                                </div>
                            </>
                        ) : <div className="h-48 flex items-center justify-center text-surface-400 text-sm">No resolution data yet</div>}
                    </div>
                </motion.div>
            )}

            {/* Overview Tab — Original charts */}
            {(embedded || activeTab === 'overview') && (<>
            <motion.div variants={fadeUp} className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                    <div>
                        <h2 className="text-lg font-bold text-surface-900 dark:text-white flex items-center gap-2">
                            <TrendingUp size={18} className="text-primary-600 dark:text-primary-400" />
                            Engagement Timeline
                        </h2>
                        <p className="text-sm text-surface-500 mt-0.5">Daily message volume</p>
                    </div>
                    {/* Time Range Pills */}
                    <div className="flex items-center gap-1 p-1 bg-surface-100 dark:bg-surface-800 rounded-lg">
                        {ranges.map((r) => (
                            <button
                                key={r.id}
                                onClick={() => setTimeRange(r.id)}
                                className={cn(
                                    'px-3 py-1.5 text-xs font-medium rounded-md transition-all',
                                    timeRange === r.id
                                        ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                                        : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
                                )}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>
                </div>

                {isLoading ? (
                    <div className="h-72 flex items-center justify-center">
                        <div className="animate-pulse w-full h-full bg-surface-100 dark:bg-surface-800 rounded-xl" />
                    </div>
                ) : filteredData.length === 0 ? (
                    <div className="h-72 flex flex-col items-center justify-center border-2 border-dashed border-surface-200 dark:border-surface-800 rounded-xl">
                        <TrendingUp className="text-surface-600 dark:text-surface-300 mb-3" size={32} />
                        <p className="text-surface-500 text-sm">No activity data yet</p>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height={300}>
                        <AreaChart data={filteredData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                            <defs>
                                <linearGradient id="colorMessages" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.15} />
                                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" strokeOpacity={0.5} />
                            <XAxis dataKey="displayDate" tickLine={false} axisLine={false} tick={{ fill: '#a1a1aa', fontSize: 11 }} dy={8} />
                            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#a1a1aa', fontSize: 11 }} width={35} />
                            <Tooltip content={<CustomTooltip />} />
                            <Area type="monotone" dataKey="messages" stroke="#6366f1" strokeWidth={2} fill="url(#colorMessages)" dot={false} activeDot={{ r: 5, fill: '#6366f1', stroke: '#fff', strokeWidth: 2 }} />
                        </AreaChart>
                    </ResponsiveContainer>
                )}
            </motion.div>

            {/* Top Questions */}
            <motion.div variants={fadeUp} className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                <div className="flex items-center gap-2 mb-5">
                    <div className="w-9 h-9 rounded-lg bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
                        <MessageSquare size={18} className="text-primary-600 dark:text-primary-400" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-surface-900 dark:text-white">Top User Questions</h2>
                        <p className="text-sm text-surface-500">Most frequent queries</p>
                    </div>
                </div>

                {isLoading ? (
                    <div className="space-y-3">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="animate-pulse h-12 bg-surface-100 dark:bg-surface-800 rounded-xl" />
                        ))}
                    </div>
                ) : topQuestions.length === 0 ? (
                    <div className="py-10 text-center border-2 border-dashed border-surface-200 dark:border-surface-800 rounded-xl">
                        <p className="text-surface-500 text-sm">No questions recorded yet</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {topQuestions.map((item, index) => {
                            const maxCount = topQuestions[0]?.count || 1;
                            const barWidth = Math.max((item.count / maxCount) * 100, 8);
                            return (
                                <motion.div
                                    key={index}
                                    initial={{ opacity: 0, x: -8 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{ delay: index * 0.04 }}
                                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-all group"
                                >
                                    <span className="w-7 h-7 rounded-full bg-surface-100 dark:bg-surface-800 flex items-center justify-center text-xs font-bold text-surface-500 dark:text-surface-400 shrink-0 group-hover:scale-105 transition-transform">
                                        {index + 1}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-surface-900 dark:text-white truncate">{item.question}</p>
                                        <div className="mt-1.5 h-1.5 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                                            <motion.div
                                                className="h-full bg-primary-500 rounded-full"
                                                initial={{ width: 0 }}
                                                animate={{ width: `${barWidth}%` }}
                                                transition={{ duration: 0.7, delay: 0.2 + index * 0.05 }}
                                            />
                                        </div>
                                    </div>
                                    <span className="text-sm font-bold text-primary-600 dark:text-primary-400 shrink-0">{item.count}</span>
                                </motion.div>
                            );
                        })}
                    </div>
                )}
            </motion.div>

            {/* Customer Satisfaction (post-chat ratings) */}
            {(isLoading || (ratingsSummary && ratingsSummary.total > 0)) && (
                <motion.div variants={fadeUp} className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                    <div className="flex items-center gap-2 mb-5">
                        <div className="w-9 h-9 rounded-lg bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center">
                            <Star size={18} className="text-amber-500 dark:text-amber-400" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-surface-900 dark:text-white">Customer Satisfaction</h2>
                            <p className="text-sm text-surface-500">Post-chat ratings from live chat sessions</p>
                        </div>
                        {!isLoading && ratingsSummary?.avg != null && (
                            <div className="ml-auto flex items-baseline gap-1">
                                <span className="text-3xl font-bold text-surface-900 dark:text-white">{ratingsSummary.avg}</span>
                                <span className="text-sm text-surface-400">/ 5</span>
                                <span className="ml-2 text-xs text-surface-400">({ratingsSummary.total} rating{ratingsSummary.total !== 1 ? 's' : ''})</span>
                            </div>
                        )}
                    </div>

                    {isLoading ? (
                        <div className="space-y-2">
                            {[5, 4, 3, 2, 1].map(s => (
                                <div key={s} className="animate-pulse flex items-center gap-3 h-6">
                                    <div className="w-10 h-4 bg-surface-100 dark:bg-surface-800 rounded" />
                                    <div className="flex-1 h-4 bg-surface-100 dark:bg-surface-800 rounded-full" />
                                    <div className="w-8 h-4 bg-surface-100 dark:bg-surface-800 rounded" />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="space-y-2.5">
                            {[5, 4, 3, 2, 1].map((star) => {
                                const count = ratingsSummary?.distribution?.[star] ?? 0;
                                const pct = ratingsSummary?.total > 0
                                    ? Math.round((count / ratingsSummary.total) * 100)
                                    : 0;
                                const barColor = star >= 4 ? 'bg-emerald-400' : star === 3 ? 'bg-amber-400' : 'bg-rose-400';
                                return (
                                    <div key={star} className="flex items-center gap-3">
                                        <span className="text-xs font-medium text-surface-500 dark:text-surface-400 w-8 shrink-0 flex items-center gap-0.5">
                                            {star}<Star size={10} className="text-amber-400 fill-amber-400 inline" />
                                        </span>
                                        <div className="flex-1 h-4 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                                            <motion.div
                                                className={cn('h-full rounded-full', barColor)}
                                                initial={{ width: 0 }}
                                                animate={{ width: `${pct}%` }}
                                                transition={{ duration: 0.7, delay: 0.1 }}
                                            />
                                        </div>
                                        <span className="text-xs font-medium text-surface-500 dark:text-surface-400 w-10 text-right shrink-0">
                                            {pct}%
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </motion.div>
            )}

            {/* Resolution Rate (post-chat survey) */}
            {(isLoading || (resolutionSummary && resolutionSummary.total > 0)) && (
                <motion.div variants={fadeUp} className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm">
                    <div className="flex items-center gap-2 mb-5">
                        <div className="w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center">
                            <CheckCircle2 size={18} className="text-emerald-500 dark:text-emerald-400" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-surface-900 dark:text-white">Resolution Rate</h2>
                            <p className="text-sm text-surface-500">Were visitor issues resolved during live chat?</p>
                        </div>
                        {!isLoading && resolutionSummary?.rate != null && (
                            <div className="ml-auto flex items-baseline gap-1">
                                <span className="text-3xl font-bold text-surface-900 dark:text-white">{resolutionSummary.rate}%</span>
                                <span className="ml-2 text-xs text-surface-400">({resolutionSummary.total} response{resolutionSummary.total !== 1 ? 's' : ''})</span>
                            </div>
                        )}
                    </div>

                    {isLoading ? (
                        <div className="animate-pulse flex gap-4">
                            <div className="flex-1 h-16 bg-surface-100 dark:bg-surface-800 rounded-xl" />
                            <div className="flex-1 h-16 bg-surface-100 dark:bg-surface-800 rounded-xl" />
                        </div>
                    ) : (
                        <div className="flex gap-4">
                            <div className="flex-1 p-4 bg-emerald-50 dark:bg-emerald-500/10 rounded-xl border border-emerald-100 dark:border-emerald-500/20">
                                <div className="flex items-center gap-2 mb-1">
                                    <CheckCircle2 size={14} className="text-emerald-500 dark:text-emerald-400" />
                                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Resolved</span>
                                </div>
                                <span className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{resolutionSummary?.resolved ?? 0}</span>
                                {resolutionSummary?.total > 0 && (
                                    <span className="text-xs text-emerald-500 dark:text-emerald-400/70 ml-1.5">
                                        ({Math.round((resolutionSummary.resolved / resolutionSummary.total) * 100)}%)
                                    </span>
                                )}
                            </div>
                            <div className="flex-1 p-4 bg-rose-50 dark:bg-rose-500/10 rounded-xl border border-rose-100 dark:border-rose-500/20">
                                <div className="flex items-center gap-2 mb-1">
                                    <XCircle size={14} className="text-rose-500 dark:text-rose-400" />
                                    <span className="text-xs font-medium text-rose-700 dark:text-rose-400">Unresolved</span>
                                </div>
                                <span className="text-2xl font-bold text-rose-700 dark:text-rose-400">{resolutionSummary?.unresolved ?? 0}</span>
                                {resolutionSummary?.total > 0 && (
                                    <span className="text-xs text-rose-500 dark:text-rose-400/70 ml-1.5">
                                        ({Math.round((resolutionSummary.unresolved / resolutionSummary.total) * 100)}%)
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                </motion.div>
            )}
            </>)}
        </motion.div>
    );
}
