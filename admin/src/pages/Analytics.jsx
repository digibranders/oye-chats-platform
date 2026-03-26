import { useState, useEffect, useRef, useMemo } from 'react';
import { Loader2, TrendingUp, Activity, BarChart3, Zap, MessageSquare } from 'lucide-react';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
} from 'recharts';
import { getActivityStats, getTopQuestions } from '../services/api';
import { useBotContext } from '../context/BotContext';
import NoBotState from '../components/NoBotState';

export default function Analytics() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();

    if (!botsLoading && bots.length === 0) {
        return <NoBotState title="Analytics" subtitle="Create a chatbot first to start tracking conversation analytics and user engagement." />;
    }
    const [activityData, setActivityData] = useState([]);
    const [topQuestions, setTopQuestions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [chartWidth, setChartWidth] = useState(600);
    const chartContainerRef = useRef(null);

    useEffect(() => {
        const fetchData = async () => {
            setIsLoading(true);
            try {
                const botId = selectedBot?.id;
                const [activity, questions] = await Promise.all([
                    getActivityStats(botId),
                    getTopQuestions(botId)
                ]);

                // Build a lookup map: date string -> message count
                const activityMap = {};
                activity.forEach(item => {
                    // Normalise to YYYY-MM-DD (backend sends local dates)
                    const key = item.date.slice(0, 10);
                    activityMap[key] = (activityMap[key] || 0) + item.messages;
                });

                // Helper: build YYYY-MM-DD from a local Date (avoids UTC offset bugs)
                const toLocalKey = (d) => {
                    const y = d.getFullYear();
                    const m = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    return `${y}-${m}-${day}`;
                };

                // Determine the date range: earliest date in data → today
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                let startDate = new Date(today);
                if (activity.length > 0) {
                    // Parse as LOCAL midnight (not UTC) to avoid timezone shifting the range
                    const earliest = activity
                        .map(d => {
                            const [y, mo, dy] = d.date.slice(0, 10).split('-').map(Number);
                            return new Date(y, mo - 1, dy); // local midnight
                        })
                        .reduce((a, b) => (a < b ? a : b));
                    startDate = earliest;
                } else {
                    // No data yet — show last 7 days as empty
                    startDate = new Date(today);
                    startDate.setDate(today.getDate() - 6);
                }

                // Walk every day from startDate to today
                const filled = [];
                const cursor = new Date(startDate);
                while (cursor <= today) {
                    const key = toLocalKey(cursor); // local YYYY-MM-DD, no UTC shift
                    const displayDate = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    filled.push({
                        date: key,
                        displayDate,
                        messages: activityMap[key] || 0,
                        isReal: !!activityMap[key]
                    });
                    cursor.setDate(cursor.getDate() + 1);
                }

                setActivityData(filled);
                setTopQuestions(questions);

                // After data is ready, measure the container width
                setTimeout(() => {
                    if (chartContainerRef.current) {
                        const w = chartContainerRef.current.offsetWidth;
                        setChartWidth(Math.max(w, filled.length * 60));
                    }
                }, 0);

            } catch (error) {
                console.error("Failed to load analytics data", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchData();
    }, [selectedBot?.id]);


    // Calculate Summary Metrics
    const metrics = useMemo(() => {
        if (!activityData || activityData.length === 0) return { total: 0, average: 0, peak: 0, peakDate: '-' };

        const total = activityData.reduce((sum, item) => sum + item.messages, 0);
        const average = Math.round(total / activityData.length);

        let peak = 0;
        let peakDate = '-';
        activityData.forEach(item => {
            if (item.messages > peak) {
                peak = item.messages;
                peakDate = item.displayDate;
            }
        });

        return { total, average, peak, peakDate };
    }, [activityData]);

    // Custom Tooltip for Recharts
    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            const count = payload[0].value;
            const isActive = payload[0].payload.isReal;
            return (
                <div className="bg-slate-800 p-4 border border-slate-700 shadow-lg rounded-2xl transition-all">
                    <p className="text-secondary-400 font-medium text-xs mb-2 uppercase tracking-wider">{label}</p>
                    <div className="flex items-end gap-2">
                        <p className={`font-bold text-2xl leading-none ${isActive ? 'text-primary-400' : 'text-secondary-500'}`}>
                            {count}
                        </p>
                        <p className="font-medium text-secondary-400 text-sm mb-0.5">
                            {count === 1 ? 'Message' : 'Messages'}
                        </p>
                    </div>
                    {!isActive && (
                        <p className="text-xs text-secondary-500 mt-1">No activity this day</p>
                    )}
                </div>
            );
        }
        return null;
    };


    return (
        <div className="space-y-6 animate-slide-up pb-10">
            <div>
                <h1 className="text-2xl font-bold text-secondary-900 dark:text-white">Analytics overview</h1>
                <p className="text-secondary-500 dark:text-secondary-400 mt-1">Track your AI's performance and measure user engagement.</p>
            </div>

            {/* Summary Metrics Cards */}
            {!isLoading && activityData.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                    <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                            <Activity size={48} className="text-primary-600 dark:text-primary-400 scale-150 transform -translate-y-4 translate-x-4" />
                        </div>
                        <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400 flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400 flex items-center justify-center">
                                <Activity size={16} />
                            </div>
                            Total Messages
                        </h3>
                        <p className="text-3xl font-bold text-secondary-900 dark:text-white mt-4">{metrics.total.toLocaleString()}</p>
                        <p className="text-xs text-secondary-500 dark:text-secondary-400 mt-2">Over the selected time period</p>
                    </div>

                    <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                            <BarChart3 size={48} className="text-blue-600 dark:text-blue-400 scale-150 transform -translate-y-4 translate-x-4" />
                        </div>
                        <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400 flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                                <BarChart3 size={16} />
                            </div>
                            Daily Average
                        </h3>
                        <p className="text-3xl font-bold text-secondary-900 dark:text-white mt-4">~{metrics.average.toLocaleString()}</p>
                        <p className="text-xs text-secondary-500 dark:text-secondary-400 mt-2">Messages per active day</p>
                    </div>

                    <div className="bg-white dark:bg-secondary-800 p-6 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                            <Zap size={48} className="text-amber-600 dark:text-amber-400 scale-150 transform -translate-y-4 translate-x-4" />
                        </div>
                        <h3 className="text-sm font-medium text-secondary-500 dark:text-secondary-400 flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                                <Zap size={16} />
                            </div>
                            Peak Traffic
                        </h3>
                        <p className="text-3xl font-bold text-secondary-900 dark:text-white mt-4">{metrics.peak.toLocaleString()}</p>
                        <p className="text-xs text-secondary-500 dark:text-secondary-400 mt-2">Highest day: {metrics.peakDate}</p>
                    </div>
                </div>
            )}

            <div className="bg-white dark:bg-secondary-800 p-6 md:p-8 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm transition-colors relative overflow-hidden">
                {/* Decorative background blur */}
                <div className="absolute -top-24 -right-24 w-64 h-64 bg-primary-400/10 dark:bg-primary-500/5 rounded-full blur-3xl pointer-events-none"></div>

                <div className="flex items-center justify-between mb-8 relative">
                    <div>
                        <h2 className="text-lg font-bold text-secondary-900 dark:text-white flex items-center gap-2">
                            <TrendingUp size={20} className="text-primary-600 dark:text-primary-400" />
                            Engagement Timeline
                        </h2>
                        <p className="text-sm text-secondary-500 dark:text-secondary-400 mt-1">Visualizing daily interactions to understand user activity trends.</p>
                    </div>
                </div>

                {isLoading ? (
                    <div className="flex flex-col items-center justify-center h-64 text-secondary-400 dark:text-secondary-500">
                        <Loader2 className="animate-spin mb-3" size={32} />
                        <p>Loading chart data...</p>
                    </div>
                ) : activityData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-secondary-200 dark:border-secondary-700 rounded-2xl bg-secondary-50 dark:bg-secondary-900/50">
                        <TrendingUp className="text-secondary-400 dark:text-secondary-600 mb-3" size={32} />
                        <p className="text-secondary-600 dark:text-secondary-400 font-medium">No activity data yet.</p>
                        <p className="text-sm text-secondary-500 dark:text-secondary-500 mt-1">Chatting with the widget will populate this chart.</p>
                    </div>
                ) : (
                    <div ref={chartContainerRef} className="overflow-x-auto pb-2">
                        <div style={{ width: chartWidth }}>
                            <BarChart
                                width={chartWidth}
                                height={350}
                                data={activityData}
                                margin={{ top: 10, right: 16, left: 10, bottom: 0 }}
                                barCategoryGap="30%"
                            >
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#334155" strokeOpacity={0.15} />
                                <XAxis
                                    dataKey="displayDate"
                                    tickLine={false}
                                    axisLine={false}
                                    tick={{ fill: '#94a3b8', fontSize: 11, fontWeight: 500 }}
                                    dy={10}
                                    tickMargin={5}
                                    interval={0}
                                />
                                <YAxis
                                    allowDecimals={false}
                                    tickLine={false}
                                    axisLine={false}
                                    tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 500 }}
                                    domain={[0, 'auto']}
                                    tickCount={5}
                                    width={35}
                                />
                                <Tooltip
                                    content={<CustomTooltip />}
                                    cursor={{ fill: '#94a3b8', opacity: 0.1 }}
                                />
                                <Bar
                                    dataKey="messages"
                                    fill="#2563eb"
                                    radius={[6, 6, 0, 0]}
                                    maxBarSize={28}
                                    animationDuration={1200}
                                />
                            </BarChart>
                        </div>
                    </div>


                )}
            </div>

            {/* Top Questions Analysis */}
            <div className="bg-white dark:bg-secondary-800 p-6 md:p-8 rounded-2xl border border-secondary-200 dark:border-secondary-700 shadow-sm transition-colors overflow-hidden">
                <div className="flex items-center gap-2 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                        <MessageSquare size={20} />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-secondary-900 dark:text-white">Top User Questions</h2>
                        <p className="text-sm text-secondary-500 dark:text-secondary-400">The most frequent queries from your users.</p>
                    </div>
                </div>

                {isLoading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="animate-spin text-secondary-300 dark:text-secondary-600" size={32} />
                    </div>
                ) : topQuestions.length === 0 ? (
                    <div className="py-12 text-center text-secondary-500 dark:text-secondary-400 border-2 border-dashed border-secondary-100 dark:border-secondary-700 rounded-2xl">
                        <p>No questions recorded yet.</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {topQuestions.map((item, index) => (
                            <div key={index} className="flex items-center justify-between p-4 bg-secondary-50 dark:bg-secondary-900/40 rounded-xl group hover:bg-white dark:hover:bg-secondary-700 transition-all border border-transparent hover:border-secondary-200 dark:hover:border-secondary-600">
                                <div className="flex items-center gap-4">
                                    <span className="flex items-center justify-center w-8 h-8 rounded-full bg-white dark:bg-secondary-800 text-xs font-bold text-secondary-500 dark:text-secondary-400 border border-secondary-200 dark:border-secondary-700 group-hover:bg-primary-500 group-hover:text-white group-hover:border-primary-500 transition-colors">
                                        {index + 1}
                                    </span>
                                    <p className="text-secondary-900 dark:text-white font-medium line-clamp-1">{item.question}</p>
                                </div>
                                <div className="flex items-center gap-2 px-3 py-1 bg-white dark:bg-secondary-800 rounded-lg border border-secondary-200 dark:border-secondary-700">
                                    <span className="text-sm font-bold text-primary-600 dark:text-primary-400">{item.count}</span>
                                    <span className="text-[10px] uppercase tracking-wider font-bold text-secondary-400 dark:text-secondary-500">times</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
