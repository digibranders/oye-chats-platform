import { useState, useEffect } from 'react';
import { Users, CheckCircle, MessageSquare, BarChart3, Upload, Palette, Code2, ArrowRight, TrendingUp, Sparkles, Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { getDashboardStats, getTopQuestions } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import StatCard from '../components/ui/StatCard';
import EmptyState from '../components/ui/EmptyState';
import { cn } from '../lib/utils';

const DATE_RANGES = [
  { id: 7, label: '7 days' },
  { id: 30, label: '30 days' },
  { id: 90, label: '90 days' },
  { id: null, label: 'All time' },
];

const stagger = {
  animate: { transition: { staggerChildren: 0.06 } },
};
const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

export default function Dashboard() {
  const { selectedBot, bots, loading: botsLoading } = useBotContext();
  const { showToast } = useToast();
  const [stats, setStats] = useState(null);
  const [topQuestions, setTopQuestions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState(null);
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
          getDashboardStats(selectedBot.id, dateRange),
          getTopQuestions(selectedBot.id),
        ]);
        setStats(statsData);
        setTopQuestions(questionsData);
      } catch (error) {
        console.error('Failed to fetch dashboard data', error);
        showToast('error', error.message || 'Failed to load dashboard data');
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [selectedBot?.id, dateRange, showToast]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  if (!botsLoading && bots.length === 0) {
    return (
      <EmptyState
        title="Welcome to OyeChats"
        description="Create your first chatbot to start seeing analytics, visitor data, and conversation insights here."
        actionLabel="Create Your First Chatbot"
        actionTo="/chatbot"
      />
    );
  }

  const quickActions = [
    { icon: Upload, label: 'Upload documents', desc: 'Add to your knowledge base', to: '/knowledge', color: 'from-primary-500/10 to-violet-500/10 dark:from-primary-500/20 dark:to-violet-500/20' },
    { icon: Palette, label: 'Customize appearance', desc: 'Brand your chatbot', to: '/chatbot?tab=appearance', color: 'from-amber-500/10 to-orange-500/10 dark:from-amber-500/20 dark:to-orange-500/20' },
    { icon: Code2, label: 'Get embed code', desc: 'Add to your website', to: '/chatbot', color: 'from-emerald-500/10 to-sky-500/10 dark:from-emerald-500/20 dark:to-sky-500/20' },
  ];

  return (
    <motion.div
      variants={stagger}
      initial="initial"
      animate="animate"
      className="space-y-6"
    >
      {/* Greeting */}
      <motion.div variants={fadeUp} className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white tracking-tight flex items-center gap-2">
            {greeting}, {adminName.split(' ')[0]}
            <motion.span
              animate={{ rotate: [0, 14, -8, 14, -4, 10, 0] }}
              transition={{ duration: 2, delay: 0.5 }}
              className="inline-block origin-[70%_80%]"
            >
              <Sparkles size={22} className="text-primary-500" />
            </motion.span>
          </h1>
          <p className="text-surface-500 mt-1 text-sm flex items-center gap-1.5">
            <Clock size={13} />
            {today}
          </p>
        </div>
      </motion.div>

      {/* Date Range Pills */}
      <motion.div variants={fadeUp} className="flex items-center gap-1 p-1 bg-surface-100 dark:bg-surface-800 rounded-lg w-fit">
        {DATE_RANGES.map((r) => (
          <button
            key={String(r.id)}
            onClick={() => setDateRange(r.id)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-all',
              dateRange === r.id
                ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300'
            )}
          >
            {r.label}
          </button>
        ))}
      </motion.div>

      {/* Stat Cards */}
      <motion.div variants={fadeUp} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Users}
          label="Active Users"
          value={isLoading ? '—' : (stats?.active_users || 0)}
          badge="Live"
          badgeColor="success"
          loading={isLoading}
          sparkline={[3, 5, 4, 7, 6, 8, 9]}
        />
        <StatCard
          icon={CheckCircle}
          label="Success Rate"
          value={isLoading ? '—' : `${stats?.success_rate || 0}%`}
          loading={isLoading}
          sparkline={[40, 55, 60, 58, 65, 70, 68]}
        />
        <StatCard
          icon={MessageSquare}
          label="Conversations"
          value={isLoading ? '—' : (stats?.total_conversations?.toLocaleString() || '0')}
          loading={isLoading}
          sparkline={[10, 20, 15, 25, 30, 22, 35]}
        />
        <StatCard
          icon={BarChart3}
          label="Total Messages"
          value={isLoading ? '—' : (stats?.total_messages?.toLocaleString() || '0')}
          loading={isLoading}
          sparkline={[50, 80, 60, 90, 100, 85, 120]}
        />
      </motion.div>

      {/* Quick Actions */}
      <motion.div variants={fadeUp} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {quickActions.map((action) => (
          <button
            key={action.to}
            onClick={() => navigate(action.to)}
            className={cn(
              'flex items-center gap-3 p-4 rounded-xl border transition-all text-left group',
              'bg-gradient-to-br border-surface-200 dark:border-surface-800',
              'hover:border-primary-300 dark:hover:border-primary-700 hover:shadow-sm',
              action.color
            )}
          >
            <div className="w-10 h-10 rounded-lg bg-white dark:bg-surface-800 shadow-sm flex items-center justify-center flex-shrink-0 group-hover:scale-105 transition-transform">
              <action.icon size={18} className="text-primary-600 dark:text-primary-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-surface-900 dark:text-white">{action.label}</p>
              <p className="text-xs text-surface-500">{action.desc}</p>
            </div>
            <ArrowRight size={14} className="text-surface-600 dark:text-surface-300 group-hover:text-primary-500 group-hover:translate-x-0.5 transition-all" />
          </button>
        ))}
      </motion.div>

      {/* Top Questions */}
      <motion.div variants={fadeUp} className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm overflow-hidden">
        <div className="p-6 pb-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
            <TrendingUp size={20} className="text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-surface-900 dark:text-white">Most Frequent Questions</h2>
            <p className="text-sm text-surface-500">Understand what your users are asking about most</p>
          </div>
        </div>

        <div className="px-6 pb-6">
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse flex items-center gap-4 p-4 bg-surface-50 dark:bg-surface-800 rounded-xl">
                  <div className="w-9 h-9 rounded-full bg-surface-200 dark:bg-surface-700" />
                  <div className="flex-1 h-4 bg-surface-200 dark:bg-surface-700 rounded-lg" />
                  <div className="w-16 h-6 bg-surface-200 dark:bg-surface-700 rounded-lg" />
                </div>
              ))}
            </div>
          ) : topQuestions.length === 0 ? (
            <div className="py-10 text-center border-2 border-dashed border-surface-200 dark:border-surface-800 rounded-xl">
              <MessageSquare className="mx-auto text-surface-600 dark:text-surface-300 mb-3" size={28} />
              <p className="text-surface-500 text-sm">No queries yet. Interactions will appear here.</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {topQuestions.map((item, index) => {
                const maxCount = topQuestions[0]?.count || 1;
                const barWidth = Math.max((item.count / maxCount) * 100, 8);
                return (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.04 }}
                    className="flex items-center justify-between gap-4 p-3.5 rounded-xl hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-all group"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span className={cn(
                        'flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold border',
                        index < 3
                          ? cn(
                              index === 0 && 'bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30 text-amber-600 dark:text-amber-400',
                              index === 1 && 'bg-surface-50 dark:bg-surface-800 border-surface-200 dark:border-surface-700 text-surface-500',
                              index === 2 && 'bg-amber-50/50 dark:bg-amber-500/5 border-amber-100 dark:border-amber-500/20 text-amber-700 dark:text-amber-500',
                            )
                          : 'bg-surface-50 dark:bg-surface-800 border-surface-200 dark:border-surface-700 text-surface-400',
                        'group-hover:scale-105 transition-transform shrink-0'
                      )}>
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-surface-900 dark:text-white truncate">
                          {item.question}
                        </p>
                        <div className="mt-1.5 h-1 bg-surface-100 dark:bg-surface-800 rounded-full overflow-hidden">
                          <motion.div
                            className="h-full bg-primary-500/60 rounded-full"
                            initial={{ width: 0 }}
                            animate={{ width: `${barWidth}%` }}
                            transition={{ duration: 0.7, delay: 0.2 + index * 0.05 }}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-100 dark:bg-surface-800 rounded-lg shrink-0">
                      <span className="text-sm font-bold text-primary-600 dark:text-primary-400">{item.count}</span>
                      <span className="text-[9px] uppercase tracking-wider font-bold text-surface-400">hits</span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
