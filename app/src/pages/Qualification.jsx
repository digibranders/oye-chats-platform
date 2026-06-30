import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    ClipboardList,
    Sliders,
    Loader2,
    Save,
    Plus,
    Trash2,
    GripVertical,
    Info,
    Snowflake,
    Flame,
    Target,
    Trophy,
    TrendingUp,
    TrendingDown,
    Minus,
    Users,
    Activity,
    Sparkles,
    Calendar,
    ArrowRight,
    Filter,
    ChevronDown,
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    LabelList,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { useSearchParams } from 'react-router-dom';
import Tabs from '../components/ui/Tabs';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonChart } from '../components/ui/SkeletonLoader';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { getBot, getFrameworkPresets, getLeadStats, getQualificationFunnel, updateBot } from '../services/api';

const tabs = [
    { id: 'scorecard', label: 'Scorecard', icon: ClipboardList },
    { id: 'configuration', label: 'Configuration', icon: Sliders },
    { id: 'funnel', label: 'Funnel', icon: Activity },
];

const TIER_META = {
    unqualified: {
        label: 'Unqualified',
        sublabel: 'Cold leads, nurturing required',
        icon: Snowflake,
        accent: 'text-slate-500 dark:text-slate-400',
        chip: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
        dot: '#94a3b8',
    },
    mql: {
        label: 'MQL',
        sublabel: 'Marketing qualified',
        icon: Flame,
        accent: 'text-sky-600 dark:text-sky-400',
        chip: 'bg-sky-500/10 text-sky-600 dark:text-sky-300',
        dot: '#38bdf8',
    },
    sal: {
        label: 'SAL',
        sublabel: 'Sales accepted',
        icon: Target,
        accent: 'text-amber-600 dark:text-amber-400',
        chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
        dot: '#f59e0b',
    },
    sql: {
        label: 'SQL',
        sublabel: 'Sales qualified, hot',
        icon: Trophy,
        accent: 'text-emerald-600 dark:text-emerald-400',
        chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
        dot: '#10b981',
    },
};

const TIER_ORDER = ['unqualified', 'mql', 'sal', 'sql'];

const KPI_INFO = {
    unqualified: 'Leads with a score below the MQL threshold. These leads typically need more nurturing.',
    mql: 'Marketing Qualified Leads. Score has crossed the MQL threshold and shows early buying intent.',
    sal: 'Sales Accepted Leads. Score has crossed the SAL threshold and is ready for sales follow-up.',
    sql: 'Sales Qualified Leads. Score has crossed the SQL threshold and is considered high intent.',
    avgScore: 'Average qualification score across all leads. Higher scores indicate stronger sales readiness.',
    qualifiedRate: 'Share of total leads that have reached MQL or higher.',
    pipelineValue: 'Estimated weighted pipeline based on lead tier distribution.',
};

const FRAMEWORK_OPTIONS = [
    { key: 'bant', label: 'BANT (Default)' },
    { key: 'meddic', label: 'MEDDIC' },
    { key: 'champ', label: 'CHAMP' },
    { key: 'gpctba_ci', label: 'GPCTBA/CI' },
    { key: 'custom', label: 'Custom' },
];

const META_KEYS = new Set(['framework', 'thresholds', 'conversation_order', 'decay', 'behavioral_config']);

const FUNNEL_STAGES = [
    { key: 'total_visitors', label: 'Visitors', sublabel: 'Site visits', icon: Users, color: '#64748b' },
    { key: 'engaged', label: 'Engaged', sublabel: 'Started conversation', icon: Activity, color: '#0ea5e9' },
    { key: 'mql', label: 'MQL', sublabel: 'Marketing qualified', icon: Flame, color: '#6366f1' },
    { key: 'sal', label: 'SAL', sublabel: 'Sales accepted', icon: Target, color: '#f59e0b' },
    { key: 'sql', label: 'SQL', sublabel: 'Sales qualified', icon: Trophy, color: '#10b981' },
    { key: 'meetings_booked', label: 'Meetings', sublabel: 'Calendar booked', icon: Calendar, color: '#22d3ee' },
];

const cloneConfig = (value) => JSON.parse(JSON.stringify(value));
const normalizeDimensionKey = (value) => value.toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
const toLabel = (key) => (key || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

const DEFAULT_CONFIG = {
    framework: 'bant',
    need: {
        enabled: true, weight: 25,
        options: [
            { label: 'Just browsing', score: 5 },
            { label: 'Exploring solutions', score: 10 },
            { label: 'Active pain point', score: 15 },
            { label: 'Urgent need', score: 20 },
            { label: 'Critical / blocking', score: 25 },
        ],
        // Default OFF — Need-tier pill questions read as qualification fishing
        // to modern B2B visitors. Background LLM extraction still scores Need
        // from conversation text. Customers who want the explicit chip can
        // toggle it on here. Mirrors the BANT preset in qualification_service.py.
        cta_enabled: false, cta_prompt: 'What best describes your situation?', label: 'Need',
    },
    timeline: {
        enabled: true, weight: 25,
        options: [
            { label: 'No timeline', score: 5 },
            { label: '6-12 months', score: 10 },
            { label: '3-6 months', score: 15 },
            { label: '1-3 months', score: 20 },
            { label: 'This month', score: 25 },
        ],
        // Default OFF — Timeline pill still reads as a qualification chip
        // to most visitors. Background LLM extraction at ``qualification_service``
        // still infers timeline from conversation text so the tier signal
        // is preserved. Customers who want the explicit chip can toggle it
        // on here. Mirrors the BANT preset in qualification_service.py.
        cta_enabled: false, cta_prompt: 'When are you looking to get started?', label: 'Timeline',
    },
    authority: {
        enabled: true, weight: 25,
        options: [
            { label: 'Researching for someone', score: 5 },
            { label: 'Team member / influencer', score: 10 },
            { label: 'Manager / champion', score: 15 },
            { label: 'Decision maker', score: 20 },
            { label: 'Budget owner', score: 25 },
        ],
        cta_enabled: false, cta_prompt: "What's your role in this decision?", label: 'Authority',
    },
    budget: {
        enabled: true, weight: 25,
        options: [
            { label: 'No budget yet', score: 5 },
            { label: 'Under $1K/mo', score: 10 },
            { label: '$1K-5K/mo', score: 15 },
            { label: '$5K-20K/mo', score: 20 },
            { label: '$20K+/mo', score: 25 },
        ],
        cta_enabled: false, cta_prompt: 'Do you have a budget range in mind?', label: 'Budget',
    },
    thresholds: { mql: 30, sal: 55, sql: 75 },
    conversation_order: ['need', 'timeline', 'authority', 'budget'],
    decay: { enabled: true, timeline_decay_per_30d: 5, need_decay_per_30d: 3 },
};

function getDimensionKeys(config) {
    if (!config) return [];
    const order = Array.isArray(config.conversation_order) ? config.conversation_order : [];
    const keys = [];
    order.forEach((key) => {
        if (config[key] && !META_KEYS.has(key)) keys.push(key);
    });
    Object.keys(config).forEach((key) => {
        if (META_KEYS.has(key)) return;
        if (!keys.includes(key) && typeof config[key] === 'object') keys.push(key);
    });
    return keys;
}

function KpiInfoButton({ text, label }) {
    return (
        <div className="relative group">
            <button
                type="button"
                className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-surface-300 dark:border-surface-700 text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 hover:border-surface-400 dark:hover:border-surface-500 focus:outline-none focus:ring-2 focus:ring-primary-400/60"
                title={text}
                aria-label={label}
            >
                <Info className="w-2.5 h-2.5" />
            </button>
            <div className="pointer-events-none absolute z-20 right-0 top-full mt-2 w-64 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 px-3 py-2 text-[11px] font-medium text-surface-600 dark:text-surface-300 shadow-xl opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                {text}
            </div>
        </div>
    );
}

function AnimatedCounter({ value, duration = 800 }) {
    const [count, setCount] = useState(0);

    useEffect(() => {
        let start = count;
        const end = Math.round(value);
        if (start === end) return;

        const startTime = performance.now();
        let animationFrameId;

        const animate = (currentTime) => {
            const elapsedTime = currentTime - startTime;
            const progress = Math.min(elapsedTime / duration, 1);
            // Ease out quad
            const easeProgress = progress * (2 - progress);
            const currentVal = Math.round(start + (end - start) * easeProgress);

            setCount(currentVal);

            if (progress < 1) {
                animationFrameId = requestAnimationFrame(animate);
            }
        };

        animationFrameId = requestAnimationFrame(animate);

        return () => cancelAnimationFrame(animationFrameId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    return <span className="tabular-nums">{count}</span>;
}

function ScoreGauge({ score }) {
    const clamped = Math.max(0, Math.min(100, score));
    const radius = 78;
    const stroke = 12;
    const circ = Math.PI * radius;
    const offset = circ - (clamped / 100) * circ;

    const color = clamped >= 75 ? '#10b981' : clamped >= 55 ? '#f59e0b' : clamped >= 30 ? '#6366f1' : '#64748b';
    const tier = clamped >= 75 ? 'SQL' : clamped >= 55 ? 'SAL' : clamped >= 30 ? 'MQL' : 'Cold';

    return (
        <div className="relative w-[200px] h-[120px]">
            <svg viewBox="0 0 200 120" className="w-full h-full">
                <defs>
                    <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#64748b" />
                        <stop offset="33%" stopColor="#6366f1" />
                        <stop offset="66%" stopColor="#f59e0b" />
                        <stop offset="100%" stopColor="#10b981" />
                    </linearGradient>
                </defs>
                <path
                    d="M 22 100 A 78 78 0 0 1 178 100"
                    fill="none"
                    stroke="currentColor"
                    className="text-surface-200 dark:text-surface-800"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                />
                <path
                    d="M 22 100 A 78 78 0 0 1 178 100"
                    fill="none"
                    stroke="url(#gaugeGrad)"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeDasharray={circ}
                    strokeDashoffset={offset}
                    style={{ transition: 'stroke-dashoffset 0.8s ease-out' }}
                />
            </svg>
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
                <span className="text-4xl font-bold tabular-nums" style={{ color }}>
                    <AnimatedCounter value={clamped} />
                </span>
                <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color }}>{tier}</span>
            </div>
        </div>
    );
}

function TierCard({ tierKey, count, total, delay = 0 }) {
    const meta = TIER_META[tierKey];
    const Icon = meta.icon;
    const pct = total > 0 ? (count / total) * 100 : 0;

    return (
        <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}
            className="relative rounded-xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-5 transition-colors hover:border-surface-300 dark:hover:border-surface-700"
        >
            <div className="flex items-start justify-between mb-4">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${meta.chip}`}>
                    <Icon size={18} />
                </div>
                <KpiInfoButton text={KPI_INFO[tierKey]} label={`${meta.label} info`} />
            </div>
            <p className={`text-[11px] font-bold uppercase tracking-widest ${meta.accent}`}>{meta.label}</p>
            <p className="text-[10.5px] text-surface-500 dark:text-surface-400 mt-0.5">{meta.sublabel}</p>
            <div className="mt-4 flex items-baseline gap-2">
                <span className="text-4xl font-bold tabular-nums text-surface-900 dark:text-surface-50">
                    <AnimatedCounter value={count} />
                </span>
                <span className="text-sm font-semibold text-surface-500 dark:text-surface-400">{pct.toFixed(1)}%</span>
            </div>
            <div className="mt-3 h-1 w-full rounded-full bg-surface-100 dark:bg-surface-800 overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                        width: `${Math.max(pct, count > 0 ? 4 : 0)}%`,
                        backgroundColor: meta.dot,
                    }}
                />
            </div>
        </motion.div>
    );
}

function DistributionBar({ counts, total }) {
    if (total === 0) {
        return <div className="h-2 w-full rounded-full bg-surface-100 dark:bg-surface-800" />;
    }
    return (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-100 dark:bg-surface-800">
            {TIER_ORDER.map((key) => {
                const value = counts[key] || 0;
                const pct = (value / total) * 100;
                if (pct === 0) return null;
                const meta = TIER_META[key];
                return (
                    <div
                        key={key}
                        className="transition-all duration-700"
                        style={{ width: `${pct}%`, backgroundColor: meta.dot }}
                        title={`${meta.label}: ${value} (${pct.toFixed(1)}%)`}
                    />
                );
            })}
        </div>
    );
}

function ConversionFlow({ counts }) {
    const arr = TIER_ORDER.map((key) => ({ key, value: counts[key] || 0, meta: TIER_META[key] }));
    return (
        <div className="flex items-center gap-2 overflow-x-auto">
            {arr.map((node, idx) => {
                const Icon = node.meta.icon;
                const next = arr[idx + 1];
                const conv = next && node.value > 0 ? (next.value / node.value) * 100 : null;
                return (
                    <div key={node.key} className="flex items-center gap-2 shrink-0">
                        <div className="flex flex-col items-center min-w-[78px]">
                            <div className={`w-11 h-11 rounded-xl flex items-center justify-center ring-1 ${node.meta.ring} ${node.meta.chip}`}>
                                <Icon size={18} />
                            </div>
                            <span className="mt-1.5 text-[10px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">{node.meta.label}</span>
                            <span className="text-base font-bold tabular-nums text-surface-900 dark:text-surface-50">{node.value}</span>
                        </div>
                        {next && (
                            <div className="flex flex-col items-center text-surface-400 dark:text-surface-500">
                                <ArrowRight size={16} />
                                <span className="text-[10px] font-semibold mt-0.5">
                                    {conv !== null ? `${conv.toFixed(0)}%` : '—'}
                                </span>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function HeroStat({ label, value, sub, icon: Icon, accent = 'text-primary-400', tooltip }) {
    return (
        <div className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {Icon && <Icon size={14} className={accent} />}
                    <span className="text-[11px] font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400">{label}</span>
                </div>
                {tooltip && <KpiInfoButton text={tooltip} label={`${label} info`} />}
            </div>
            <div className="mt-2 text-2xl font-bold tabular-nums text-surface-900 dark:text-surface-50">{value}</div>
            {sub && <div className="mt-1 text-[11px] text-surface-500 dark:text-surface-400">{sub}</div>}
        </div>
    );
}

function ScorecardTab() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [stats, setStats] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    const fetchStats = useCallback(async () => {
        if (!selectedBot?.id) return;
        setIsLoading(true);
        try {
            const data = await getLeadStats(selectedBot.id);
            setStats(data);
        } catch (err) {
            showToast('error', err.message || 'Failed to load stats');
        } finally {
            setIsLoading(false);
        }
    }, [selectedBot?.id, showToast]);

    useEffect(() => {
        fetchStats();
    }, [fetchStats]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Qualification" description="Create a chatbot first to start qualifying leads." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
            </div>
        );
    }

    if (!stats) return null;

    const total = stats.total || 0;
    const counts = {
        unqualified: stats.cold ?? stats.unqualified ?? 0,
        mql: stats.warm ?? stats.mql ?? 0,
        sal: stats.hot ?? stats.sal ?? 0,
        sql: stats.qualified ?? stats.sql ?? 0,
    };
    const avgScore = stats.avg_score ?? 0;
    const qualifiedCount = counts.mql + counts.sal + counts.sql;
    const qualifiedRate = total > 0 ? (qualifiedCount / total) * 100 : 0;

    return (
        <div className="space-y-6">
            {/* Hero summary */}
            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="rounded-xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6"
            >
                <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 items-center">
                    <div className="space-y-4">
                        <div className="inline-flex items-center gap-1.5">
                            <Sparkles size={12} className="text-primary-500 dark:text-primary-400" />
                            <span className="text-[10.5px] font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400">Pipeline overview</span>
                        </div>
                        <div className="flex items-baseline gap-3 flex-wrap">
                            <span className="text-5xl font-bold tabular-nums leading-none text-surface-900 dark:text-surface-50">
                                <AnimatedCounter value={total} />
                            </span>
                            <span className="text-sm font-semibold text-surface-500 dark:text-surface-400">total leads</span>
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${qualifiedRate > 0 ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400'}`}>
                                {qualifiedRate > 0 ? <TrendingUp size={11} /> : <Minus size={11} />}
                                {qualifiedRate.toFixed(1)}% qualified
                            </span>
                        </div>
                        <DistributionBar counts={counts} total={total} />
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
                            {TIER_ORDER.map((key) => (
                                <div key={key} className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: TIER_META[key].dot }} />
                                    <span className="font-medium text-surface-700 dark:text-surface-300">{TIER_META[key].label}</span>
                                    <span className="tabular-nums text-surface-500 dark:text-surface-400">{counts[key] || 0}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-col items-center lg:items-end gap-2">
                        <ScoreGauge score={avgScore} />
                        <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400">Avg lead score</span>
                            <KpiInfoButton text={KPI_INFO.avgScore} label="Average lead score info" />
                        </div>
                    </div>
                </div>
            </motion.div>

            {/* Tier cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {TIER_ORDER.map((key, idx) => (
                    <TierCard key={key} tierKey={key} count={counts[key] || 0} total={total} delay={idx * 0.05} />
                ))}
            </div>

        </div>
    );
}

function ConfigurationTab() {
    const { bots, selectedBot, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();

    const [selectedBotId, setSelectedBotId] = useState(selectedBot?.id || null);
    const [config, setConfig] = useState(null);
    const [frameworkPresets, setFrameworkPresets] = useState({});
    const [selectedFramework, setSelectedFramework] = useState('bant');
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (selectedBot?.id) setSelectedBotId(selectedBot.id);
    }, [selectedBot?.id]);

    const loadBotConfig = useCallback(async (botId) => {
        if (!botId) return;
        setIsLoading(true);
        try {
            const bot = await getBot(botId);
            const saved = bot.bant_config && Object.keys(bot.bant_config).length > 0
                ? cloneConfig(bot.bant_config)
                : cloneConfig(DEFAULT_CONFIG);
            const framework = saved.framework || 'bant';
            setSelectedFramework(framework);
            setConfig(saved);
        } catch (err) {
            showToast('error', err.message || 'Failed to load bot config');
        } finally {
            setIsLoading(false);
        }
    }, [showToast]);

    const loadFrameworkPresets = useCallback(async (botId) => {
        if (!botId) return;
        try {
            const presets = await getFrameworkPresets(botId);
            setFrameworkPresets(presets || {});
        } catch (err) {
            showToast('error', err.message || 'Failed to load framework presets');
        }
    }, [showToast]);

    useEffect(() => {
        loadBotConfig(selectedBotId);
        loadFrameworkPresets(selectedBotId);
    }, [selectedBotId, loadBotConfig, loadFrameworkPresets]);

    const handleSave = async () => {
        if (!selectedBotId || !config) return;
        setIsSaving(true);
        try {
            const payload = cloneConfig(config);
            payload.framework = selectedFramework;
            await updateBot(selectedBotId, { bant_config: payload, qualification_framework: selectedFramework });
            showToast('success', 'Qualification config saved');
        } catch (err) {
            showToast('error', err.message || 'Failed to save config');
        } finally {
            setIsSaving(false);
        }
    };

    const handleFrameworkChange = (frameworkKey) => {
        setSelectedFramework(frameworkKey);
        if (frameworkKey === 'custom') {
            setConfig((prev) => ({ ...(prev || cloneConfig(DEFAULT_CONFIG)), framework: 'custom' }));
            return;
        }
        const preset = frameworkPresets[frameworkKey];
        if (preset) {
            setConfig({ ...cloneConfig(preset), framework: frameworkKey });
        }
    };

    const updateDimension = (dim, field, value) => {
        setConfig((prev) => ({ ...prev, [dim]: { ...prev[dim], [field]: value } }));
    };

    const updateDimensionName = (oldKey, nextNameRaw) => {
        const nextKey = normalizeDimensionKey(nextNameRaw);
        if (!nextKey || nextKey === oldKey) {
            updateDimension(oldKey, 'label', nextNameRaw);
            return;
        }
        setConfig((prev) => {
            if (!prev || prev[nextKey]) return prev;
            const next = cloneConfig(prev);
            next[nextKey] = { ...next[oldKey], label: nextNameRaw };
            delete next[oldKey];
            next.conversation_order = (next.conversation_order || []).map((item) => (item === oldKey ? nextKey : item));
            return next;
        });
    };

    const updateOption = (dim, idx, field, value) => {
        setConfig((prev) => {
            const next = cloneConfig(prev);
            next[dim].options[idx][field] = field === 'score' ? Number(value) || 0 : value;
            return next;
        });
    };

    const addOption = (dim) => {
        setConfig((prev) => {
            const next = cloneConfig(prev);
            next[dim].options.push({ label: '', score: 0 });
            return next;
        });
    };

    const removeOption = (dim, idx) => {
        setConfig((prev) => {
            const next = cloneConfig(prev);
            next[dim].options = next[dim].options.filter((_, i) => i !== idx);
            return next;
        });
    };

    const addDimension = () => {
        if (selectedFramework !== 'custom') return;
        setConfig((prev) => {
            const next = cloneConfig(prev || {});
            const base = 'dimension';
            let key = `${base}_${(next.conversation_order || []).length + 1}`;
            let i = 2;
            while (next[key]) {
                key = `${base}_${i}`;
                i += 1;
            }
            next[key] = {
                enabled: true,
                weight: 10,
                options: [
                    { label: 'Low', score: 4 },
                    { label: 'Medium', score: 8 },
                    { label: 'High', score: 12 },
                ],
                cta_enabled: false,
                cta_prompt: '',
                label: toLabel(key),
            };
            next.conversation_order = [...(next.conversation_order || []), key];
            return next;
        });
    };

    const removeDimension = (dim) => {
        if (selectedFramework !== 'custom') return;
        setConfig((prev) => {
            const next = cloneConfig(prev);
            delete next[dim];
            next.conversation_order = (next.conversation_order || []).filter((item) => item !== dim);
            return next;
        });
    };

    const updateThreshold = (field, value) => {
        setConfig((prev) => ({ ...prev, thresholds: { ...prev.thresholds, [field]: Number(value) || 0 } }));
    };

    const updateDecay = (field, value) => {
        const parsed = field === 'enabled' ? value : (Number(value) || 0);
        setConfig((prev) => ({ ...prev, decay: { ...prev.decay, [field]: parsed } }));
    };

    const dimensionKeys = getDimensionKeys(config);
    const totalWeight = dimensionKeys.reduce((acc, dim) => {
        const enabled = config?.[dim]?.enabled ?? true;
        const weight = Number(config?.[dim]?.weight || 0);
        return enabled ? acc + weight : acc;
    }, 0);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Qualification" description="Create a chatbot first to configure qualification." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    return (
        <div className="space-y-6">
            <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400 mb-2">Select Bot</label>
                        <div className="relative">
                            <select
                                value={selectedBotId || ''}
                                onChange={(e) => setSelectedBotId(Number(e.target.value))}
                                className="w-full appearance-none px-3 pr-9 py-2.5 text-sm bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:focus:border-primary-500 dark:text-surface-100"
                            >
                                <option value="" disabled>Choose a bot...</option>
                                {bots.map((bot) => (
                                    <option key={bot.id} value={bot.id}>{bot.name}</option>
                                ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                        </div>
                    </div>
                    <div>
                        <label className="block text-[11px] font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400 mb-2">Qualification Framework</label>
                        <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                                <select
                                    value={selectedFramework}
                                    onChange={(e) => handleFrameworkChange(e.target.value)}
                                    className="w-full appearance-none px-3 pr-9 py-2.5 text-sm bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:focus:border-primary-500 dark:text-surface-100"
                                >
                                    {FRAMEWORK_OPTIONS.map((opt) => (
                                        <option key={opt.key} value={opt.key}>{opt.label}</option>
                                    ))}
                                </select>
                                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
                            </div>
                            {selectedFramework === 'custom' && (
                                <button
                                    type="button"
                                    onClick={addDimension}
                                    className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-lg border border-primary-300 dark:border-primary-500/40 text-primary-700 dark:text-primary-300 hover:bg-primary-50 dark:hover:bg-primary-500/10"
                                >
                                    <Plus className="w-3.5 h-3.5" />
                                    Add
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {isLoading && (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-7 h-7 animate-spin text-primary-500" />
                </div>
            )}

            {!isLoading && config && (
                <>
                    {totalWeight !== 100 && (
                        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-4 py-3 text-[12px] text-amber-700 dark:text-amber-300">
                            Dimension weights currently sum to {totalWeight}. Recommended total is 100.
                        </div>
                    )}

                    {dimensionKeys.map((dim) => {
                        const d = config[dim];
                        if (!d) return null;
                        const label = d.label || toLabel(dim);
                        return (
                            <div key={dim} className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 overflow-hidden">
                                {/* ── Card header ─────────────────────────────── */}
                                <div className="flex items-center gap-4 px-5 py-4 border-b border-surface-100 dark:border-surface-800 bg-surface-50/60 dark:bg-surface-800/40">
                                    {/* Title */}
                                    <div className="flex-1 min-w-0">
                                        {selectedFramework === 'custom' ? (
                                            <input
                                                type="text"
                                                value={label}
                                                onChange={(e) => updateDimensionName(dim, e.target.value)}
                                                className="w-full max-w-xs px-3 py-1.5 text-sm font-semibold bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:text-surface-100"
                                            />
                                        ) : (
                                            <h3 className="text-base font-bold text-surface-900 dark:text-surface-50 truncate">{label}</h3>
                                        )}
                                    </div>

                                    {/* Weight pill */}
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <span className="text-[11px] font-semibold text-surface-500 dark:text-surface-400">Weight</span>
                                        <input
                                            type="number"
                                            min={0}
                                            max={100}
                                            value={d.weight ?? 0}
                                            onChange={(e) => updateDimension(dim, 'weight', Number(e.target.value) || 0)}
                                            className="w-14 px-2 py-1 text-sm font-semibold text-center bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:text-surface-100"
                                        />
                                        <span className="text-[11px] text-surface-400 dark:text-surface-500">/100</span>
                                    </div>

                                    {/* Toggle + delete */}
                                    <div className="flex items-center gap-3 shrink-0">
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={d.enabled}
                                            onClick={() => updateDimension(dim, 'enabled', !d.enabled)}
                                            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${d.enabled ? 'bg-primary-500' : 'bg-surface-300 dark:bg-surface-700'}`}
                                        >
                                            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${d.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                                        </button>
                                        {selectedFramework === 'custom' && (
                                            <button
                                                type="button"
                                                onClick={() => removeDimension(dim)}
                                                className="p-1.5 rounded-lg text-surface-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors"
                                                title="Remove dimension"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* ── Options body ────────────────────────────── */}
                                {d.enabled && (
                                    <div className="px-5 py-4 space-y-4">
                                        {/* Column headers */}
                                        <div className="grid grid-cols-[20px_1fr_72px_32px] items-center gap-3">
                                            <div />
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-surface-400 dark:text-surface-500">Label</span>
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-surface-400 dark:text-surface-500 text-center">Score</span>
                                            <div />
                                        </div>

                                        {/* Option rows */}
                                        <div className="space-y-2">
                                            {(d.options || []).map((opt, idx) => (
                                                <div key={idx} className="grid grid-cols-[20px_1fr_72px_32px] items-center gap-3">
                                                    <GripVertical size={14} className="text-surface-300 dark:text-surface-600" />
                                                    <input
                                                        type="text"
                                                        value={opt.label}
                                                        onChange={(e) => updateOption(dim, idx, 'label', e.target.value)}
                                                        placeholder="Option label"
                                                        className="px-3 py-2 text-sm bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:text-surface-100"
                                                    />
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        max={100}
                                                        value={opt.score}
                                                        onChange={(e) => updateOption(dim, idx, 'score', e.target.value)}
                                                        className="w-full px-2 py-2 text-sm font-semibold text-center bg-surface-50 dark:bg-surface-800/80 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:text-surface-100"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => removeOption(dim, idx)}
                                                        className="flex items-center justify-center w-8 h-8 rounded-lg text-surface-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors"
                                                        title="Remove option"
                                                    >
                                                        <Trash2 size={13} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>

                                        <button
                                            type="button"
                                            onClick={() => addOption(dim)}
                                            className="flex items-center gap-1.5 text-[12px] font-semibold text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors"
                                        >
                                            <Plus size={13} />
                                            Add option
                                        </button>

                                        {/* CTA row */}
                                        <div className="flex items-center justify-between gap-4 pt-2 border-t border-surface-100 dark:border-surface-800">
                                            <div>
                                                <p className="text-sm font-semibold text-surface-700 dark:text-surface-300">CTA Enabled</p>
                                                <p className="text-[11px] text-surface-500 dark:text-surface-400 mt-0.5">Show qualification chips to the visitor</p>
                                            </div>
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={d.cta_enabled}
                                                onClick={() => updateDimension(dim, 'cta_enabled', !d.cta_enabled)}
                                                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${d.cta_enabled ? 'bg-primary-500' : 'bg-surface-300 dark:bg-surface-700'}`}
                                            >
                                                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${d.cta_enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                                            </button>
                                        </div>
                                        {d.cta_enabled && (
                                            <input
                                                type="text"
                                                value={d.cta_prompt || ''}
                                                onChange={(e) => updateDimension(dim, 'cta_prompt', e.target.value)}
                                                placeholder="CTA prompt text shown to the visitor"
                                                className="w-full px-3 py-2 text-sm bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:text-surface-100"
                                            />
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5 space-y-4">
                        <h3 className="text-base font-bold text-surface-900 dark:text-surface-50">Thresholds</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {[
                                { key: 'mql', label: 'MQL Threshold' },
                                { key: 'sal', label: 'SAL Threshold' },
                                { key: 'sql', label: 'SQL Threshold' },
                            ].map(({ key, label }) => (
                                <div key={key}>
                                    <label className="block text-[11px] font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400 mb-1">{label}</label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={100}
                                        value={config.thresholds?.[key] ?? 0}
                                        onChange={(e) => updateThreshold(key, e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:text-surface-100"
                                    />
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-5 space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-base font-bold text-surface-900 dark:text-surface-50">Score Decay</h3>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={config.decay?.enabled ?? false}
                                onClick={() => updateDecay('enabled', !(config.decay?.enabled ?? false))}
                                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${config.decay?.enabled ? 'bg-primary-500' : 'bg-surface-300 dark:bg-surface-700'}`}
                            >
                                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${config.decay?.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                            </button>
                        </div>
                        {config.decay?.enabled && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-[11px] font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400 mb-1">Timeline decay per 30d</label>
                                    <input
                                        type="number"
                                        min={0}
                                        value={config.decay?.timeline_decay_per_30d ?? 0}
                                        onChange={(e) => updateDecay('timeline_decay_per_30d', e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:text-surface-100"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[11px] font-bold uppercase tracking-widest text-surface-500 dark:text-surface-400 mb-1">Need decay per 30d</label>
                                    <input
                                        type="number"
                                        min={0}
                                        value={config.decay?.need_decay_per_30d ?? 0}
                                        onChange={(e) => updateDecay('need_decay_per_30d', e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:text-surface-100"
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={isSaving}
                            className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-primary-600 dark:bg-primary-500 rounded-xl hover:bg-primary-700 dark:hover:bg-primary-600 transition-colors disabled:opacity-50 shadow-sm shadow-primary-500/20"
                        >
                            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Save Configuration
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

function FunnelVisualization({ stages, maxValue }) {
    if (stages.length === 0) return null;
    const minWidth = 4;

    return (
        <div className="space-y-2">
            {stages.map((stage, idx) => {
                const Icon = stage.icon;
                const ratio = maxValue > 0 ? stage.value / maxValue : 0;
                const width = stage.value > 0 ? Math.max(minWidth, 100 * ratio) : 0;
                const prev = idx > 0 ? stages[idx - 1] : null;
                const isTop = idx === 0;
                const dropFromPrev = prev && prev.value > 0
                    ? ((prev.value - stage.value) / prev.value) * 100
                    : null;
                const convFromPrev = prev && prev.value > 0
                    ? (stage.value / prev.value) * 100
                    : null;
                const labelInside = width >= 12;
                const toneText =
                    convFromPrev === null ? 'text-surface-400 dark:text-surface-500'
                    : convFromPrev >= 50 ? 'text-emerald-600 dark:text-emerald-400'
                    : convFromPrev >= 20 ? 'text-amber-600 dark:text-amber-400'
                    : 'text-rose-600 dark:text-rose-400';

                return (
                    <motion.div
                        key={stage.key}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.4, delay: idx * 0.05, ease: [0.16, 1, 0.3, 1] }}
                    >
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2.5 w-[160px] shrink-0">
                                <div
                                    className="w-9 h-9 rounded-lg flex items-center justify-center"
                                    style={{
                                        backgroundColor: `${stage.color}1a`,
                                        color: stage.color,
                                    }}
                                >
                                    <Icon size={16} />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[13px] font-semibold text-surface-900 dark:text-surface-50 leading-tight">{stage.label}</p>
                                    <p className="text-[10.5px] text-surface-500 dark:text-surface-400 leading-tight">{stage.sublabel}</p>
                                </div>
                            </div>
                            <div className="flex-1 relative h-9">
                                {/* Empty rail */}
                                <div className="absolute inset-y-0 left-0 right-0 rounded-md bg-surface-100 dark:bg-surface-800" />
                                {/* Active bar */}
                                {stage.value > 0 && (
                                    <div
                                        className="absolute inset-y-0 left-0 rounded-md flex items-center px-3 transition-all duration-700"
                                        style={{ width: `${width}%`, backgroundColor: stage.color }}
                                    >
                                        {labelInside && (
                                            <span className="text-[13px] font-semibold tabular-nums text-white">
                                                {stage.value.toLocaleString()}
                                            </span>
                                        )}
                                    </div>
                                )}
                                {!labelInside && (
                                    <span
                                        className="absolute top-1/2 -translate-y-1/2 text-[12.5px] font-semibold tabular-nums"
                                        style={{
                                            left: stage.value > 0 ? `calc(${width}% + 10px)` : '12px',
                                            color: stage.value > 0 ? stage.color : 'rgb(100 116 139)',
                                        }}
                                    >
                                        {stage.value.toLocaleString()}
                                    </span>
                                )}
                            </div>
                            <div className="w-[120px] text-right shrink-0">
                                {isTop ? (
                                    <div className="text-[10px] uppercase tracking-widest font-semibold text-surface-500 dark:text-surface-400">Top of funnel</div>
                                ) : convFromPrev !== null ? (
                                    <div className="space-y-0.5">
                                        <div className={`text-[13px] font-semibold tabular-nums ${toneText}`}>
                                            {convFromPrev.toFixed(1)}%
                                        </div>
                                        <div className="text-[10px] text-surface-500 dark:text-surface-400">
                                            {dropFromPrev > 0 ? `−${dropFromPrev.toFixed(1)}% drop` : 'No drop'}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="space-y-0.5">
                                        <div className="text-[13px] font-semibold tabular-nums text-surface-400 dark:text-surface-600">—</div>
                                        <div className="text-[10px] text-surface-500 dark:text-surface-400">No upstream data</div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                );
            })}
        </div>
    );
}

function FunnelTab() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [period, setPeriod] = useState('30d');
    const [funnel, setFunnel] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    const loadFunnel = useCallback(async () => {
        if (!selectedBot?.id) return;
        setIsLoading(true);
        try {
            const data = await getQualificationFunnel(selectedBot.id, period);
            setFunnel(data.funnel || []);
        } catch (err) {
            showToast('error', err.message || 'Failed to load qualification funnel');
            setFunnel([]);
        } finally {
            setIsLoading(false);
        }
    }, [period, selectedBot?.id, showToast]);

    useEffect(() => {
        loadFunnel();
    }, [loadFunnel]);

    const stages = useMemo(() => {
        const byKey = new Map(funnel.map((item) => [item.stage, item]));
        return FUNNEL_STAGES.map((s) => ({
            ...s,
            value: byKey.get(s.key)?.count || 0,
            conversion_rate_from_previous: byKey.get(s.key)?.conversion_rate_from_previous ?? 0,
        }));
    }, [funnel]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Qualification Funnel" description="Create a chatbot first to view funnel analytics." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const visitors = stages.find((s) => s.key === 'total_visitors')?.value || 0;
    const engaged = stages.find((s) => s.key === 'engaged')?.value || 0;
    const mql = stages.find((s) => s.key === 'mql')?.value || 0;
    const sql = stages.find((s) => s.key === 'sql')?.value || 0;
    const meetings = stages.find((s) => s.key === 'meetings_booked')?.value || 0;

    const engagementRate = visitors > 0 ? (engaged / visitors) * 100 : 0;
    const mqlRate = visitors > 0 ? (mql / visitors) * 100 : 0;
    const sqlRate = visitors > 0 ? (sql / visitors) * 100 : 0;
    const meetingRate = sql > 0 ? (meetings / sql) * 100 : 0;

    const periodOptions = [
        { key: '7d', label: '7 days' },
        { key: '30d', label: '30 days' },
        { key: '90d', label: '90 days' },
        { key: 'all', label: 'All time' },
    ];

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex p-1 bg-surface-100 dark:bg-surface-800 rounded-xl">
                    {periodOptions.map((opt) => (
                        <button
                            key={opt.key}
                            onClick={() => setPeriod(opt.key)}
                            className={`relative px-3.5 py-1.5 text-[12px] font-semibold rounded-lg transition-colors ${
                                period === opt.key
                                    ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-50 shadow-sm'
                                    : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200'
                            }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
                <div className="inline-flex items-center gap-2 text-[11px] font-medium text-surface-500 dark:text-surface-400">
                    <Filter size={12} />
                    <span>Period: {periodOptions.find((p) => p.key === period)?.label}</span>
                </div>
            </div>

            {isLoading ? (
                <SkeletonChart />
            ) : (
                <>
                    {/* KPI bar */}
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                        <HeroStat label="Visitors" value={visitors.toLocaleString()} sub="Top of funnel" icon={Users} accent="text-slate-400" />
                        <HeroStat label="Engagement" value={`${engagementRate.toFixed(1)}%`} sub={`${engaged.toLocaleString()} engaged`} icon={Activity} accent="text-sky-400" />
                        <HeroStat label="MQL rate" value={`${mqlRate.toFixed(1)}%`} sub={`${mql.toLocaleString()} qualified`} icon={Flame} accent="text-indigo-400" />
                        <HeroStat label="SQL rate" value={`${sqlRate.toFixed(1)}%`} sub={`${sql.toLocaleString()} sales-ready`} icon={Trophy} accent="text-emerald-400" />
                        <HeroStat label="Meeting rate" value={`${meetingRate.toFixed(1)}%`} sub={`${meetings.toLocaleString()} booked`} icon={Calendar} accent="text-cyan-400" />
                    </div>

                    {/* Funnel visualization */}
                    <motion.div
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        className="relative overflow-hidden rounded-2xl border border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-900 p-6"
                    >
                        <div className="mb-5">
                            <p className="text-sm font-semibold text-surface-900 dark:text-surface-50">Visitor → Meeting funnel</p>
                            <p className="text-[11px] text-surface-500 dark:text-surface-400 mt-0.5">Each stage shows volume, conversion rate from previous stage, and drop-off</p>
                        </div>
                        <div className="flex items-center gap-4 px-1 pb-3 mb-1 border-b border-surface-200 dark:border-surface-800 text-[10px] font-semibold uppercase tracking-widest text-surface-500 dark:text-surface-400">
                            <div className="w-[160px] shrink-0">Stage</div>
                            <div className="flex-1">Volume</div>
                            <div className="w-[120px] text-right shrink-0">Conversion</div>
                        </div>
                        <FunnelVisualization stages={stages} maxValue={visitors || stages[0]?.value || 0} />
                    </motion.div>
                </>
            )}
        </div>
    );
}

export default function Qualification() {
    const [searchParams] = useSearchParams();
    const initialTab = searchParams.get('tab') || 'scorecard';
    const [activeTab, setActiveTab] = useState(initialTab);

    return (
        <div className="space-y-5 animate-fade-in">
            <PageHeader title="Qualification" subtitle="Configure qualification frameworks and review lead metrics" />
            <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
            {activeTab === 'scorecard' && <ScorecardTab />}
            {activeTab === 'configuration' && <ConfigurationTab />}
            {activeTab === 'funnel' && <FunnelTab />}
        </div>
    );
}
