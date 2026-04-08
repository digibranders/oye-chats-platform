import { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Sliders, Loader2, Save, Plus, Trash2, GripVertical, Info } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useSearchParams } from 'react-router-dom';
import Tabs from '../components/ui/Tabs';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonChart } from '../components/ui/SkeletonLoader';
import StatCard from '../components/ui/StatCard';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { getBot, getFrameworkPresets, getLeadStats, getQualificationFunnel, updateBot } from '../services/api';

const tabs = [
    { id: 'scorecard', label: 'Scorecard', icon: ClipboardList },
    { id: 'configuration', label: 'Configuration', icon: Sliders },
    { id: 'funnel', label: 'Funnel', icon: ClipboardList },
];

const STATUS_CARDS = [
    { key: 'unqualified', label: 'Unqualified', color: 'text-surface-600', border: 'border-surface-200', bg: 'bg-surface-50' },
    { key: 'mql', label: 'MQL', color: 'text-blue-600', border: 'border-blue-200', bg: 'bg-blue-50' },
    { key: 'sal', label: 'SAL', color: 'text-orange-600', border: 'border-orange-200', bg: 'bg-orange-50' },
    { key: 'sql', label: 'SQL', color: 'text-green-600', border: 'border-green-200', bg: 'bg-green-50' },
];

const KPI_INFO = {
    unqualified: 'Leads with a score below the MQL threshold. These leads typically need more nurturing.',
    mql: 'Marketing Qualified Leads. Score has crossed the MQL threshold and shows early buying intent.',
    sal: 'Sales Accepted Leads. Score has crossed the SAL threshold and is ready for sales follow-up.',
    sql: 'Sales Qualified Leads. Score has crossed the SQL threshold and is considered high intent.',
    avgScore: 'Average qualification score across all leads. Higher scores indicate stronger sales readiness.',
};

const FRAMEWORK_OPTIONS = [
    { key: 'bant', label: 'BANT (Default)' },
    { key: 'meddic', label: 'MEDDIC' },
    { key: 'champ', label: 'CHAMP' },
    { key: 'gpctba_ci', label: 'GPCTBA/CI' },
    { key: 'custom', label: 'Custom' },
];

const META_KEYS = new Set(['framework', 'thresholds', 'conversation_order', 'decay', 'behavioral_config']);
const FUNNEL_STAGE_LABELS = {
    total_visitors: 'Visitors',
    engaged: 'Engaged',
    mql: 'MQL',
    sal: 'SAL',
    sql: 'SQL',
    meetings_booked: 'Meetings',
};
const FUNNEL_COLORS = ['#94a3b8', '#3b82f6', '#4f46e5', '#6366f1', '#16a34a', '#15803d'];

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
        cta_enabled: true, cta_prompt: 'What best describes your situation?', label: 'Need',
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
        cta_enabled: true, cta_prompt: 'When are you looking to get started?', label: 'Timeline',
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
                className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-surface-300 text-surface-500 hover:text-surface-700 hover:border-surface-400 focus:outline-none focus:ring-2 focus:ring-primary-400/60"
                title={text}
                aria-label={label}
            >
                <Info className="w-2.5 h-2.5" />
            </button>
            <div className="pointer-events-none absolute z-20 left-1/2 top-full mt-2 w-64 -translate-x-1/2 rounded-lg border border-surface-200 bg-white px-3 py-2 text-[11px] font-medium text-surface-600 shadow-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                {text}
            </div>
        </div>
    );
}

function ScorecardTab() {
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [stats, setStats] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { fetchStats(); }, [selectedBot?.id]);

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Qualification" description="Create a chatbot first to start qualifying leads." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const fetchStats = async () => {
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
    };

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

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {STATUS_CARDS.map((card) => {
                    const count = counts[card.key] || 0;
                    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    return (
                        <div key={card.key} className={`p-5 rounded-xl border ${card.border} ${card.bg} transition-all`}>
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-[12px] font-bold uppercase tracking-wider text-surface-500">{card.label}</p>
                                <KpiInfoButton text={KPI_INFO[card.key]} label={`${card.label} metric info`} />
                            </div>
                            <p className={`text-3xl font-bold mt-1 ${card.color}`}>{count}</p>
                            <p className="text-[12px] text-surface-400 mt-0.5">{pct}% of total</p>
                        </div>
                    );
                })}
            </div>

            <div className="bg-white rounded-xl border border-surface-200 p-5">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-surface-700">Average Lead Score</p>
                        <KpiInfoButton text={KPI_INFO.avgScore} label="Average lead score metric info" />
                    </div>
                    <span className="text-lg font-bold text-surface-900">{Math.round(avgScore)}</span>
                </div>
                <div className="w-full h-3 bg-surface-100 rounded-full overflow-hidden">
                    <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                            width: `${Math.min(avgScore, 100)}%`,
                            backgroundColor: avgScore >= 75 ? '#22c55e' : avgScore >= 50 ? '#f97316' : avgScore >= 25 ? '#eab308' : '#94a3b8',
                        }}
                    />
                </div>
                <div className="flex justify-between mt-1.5 text-[11px] text-surface-400">
                    <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
                </div>
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
            let base = 'dimension';
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
            <div className="bg-white rounded-xl border border-surface-200 p-5 space-y-4">
                <div>
                    <label className="block text-sm font-semibold text-surface-700 mb-2">Select Bot</label>
                    <select
                        value={selectedBotId || ''}
                        onChange={(e) => setSelectedBotId(Number(e.target.value))}
                        className="w-full max-w-xs px-3 py-2 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
                    >
                        <option value="" disabled>Choose a bot...</option>
                        {bots.map((bot) => (
                            <option key={bot.id} value={bot.id}>{bot.name}</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label className="block text-sm font-semibold text-surface-700 mb-2">Qualification Framework</label>
                    <div className="flex flex-wrap items-center gap-3">
                        <select
                            value={selectedFramework}
                            onChange={(e) => handleFrameworkChange(e.target.value)}
                            className="w-full max-w-sm px-3 py-2 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
                        >
                            {FRAMEWORK_OPTIONS.map((opt) => (
                                <option key={opt.key} value={opt.key}>{opt.label}</option>
                            ))}
                        </select>
                        {selectedFramework === 'custom' && (
                            <button
                                type="button"
                                onClick={addDimension}
                                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-primary-200 text-primary-700 hover:bg-primary-50"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Add Dimension
                            </button>
                        )}
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
                        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[12px] text-amber-700">
                            Dimension weights currently sum to {totalWeight}. Recommended total is 100.
                        </div>
                    )}

                    {dimensionKeys.map((dim) => {
                        const d = config[dim];
                        if (!d) return null;
                        const label = d.label || toLabel(dim);
                        return (
                            <div key={dim} className="bg-white rounded-xl border border-surface-200 p-5 space-y-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1 space-y-2">
                                        {selectedFramework === 'custom' ? (
                                            <input
                                                type="text"
                                                value={label}
                                                onChange={(e) => updateDimensionName(dim, e.target.value)}
                                                className="w-full max-w-sm px-3 py-2 text-sm font-semibold bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
                                            />
                                        ) : (
                                            <h3 className="text-base font-bold text-surface-900">{label}</h3>
                                        )}
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] text-surface-400">Weight</span>
                                            <input
                                                type="number"
                                                min={0}
                                                max={100}
                                                value={d.weight ?? 0}
                                                onChange={(e) => updateDimension(dim, 'weight', Number(e.target.value) || 0)}
                                                className="w-20 px-2 py-1 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400 text-center"
                                            />
                                            <span className="text-[11px] text-surface-400">/100</span>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={d.enabled}
                                            onClick={() => updateDimension(dim, 'enabled', !d.enabled)}
                                            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${d.enabled ? 'bg-primary-500' : 'bg-surface-300'}`}
                                        >
                                            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${d.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                                        </button>
                                        {selectedFramework === 'custom' && (
                                            <button
                                                type="button"
                                                onClick={() => removeDimension(dim)}
                                                className="p-1.5 text-surface-400 hover:text-red-500"
                                                title="Remove dimension"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {d.enabled && (
                                    <>
                                        <div className="space-y-2">
                                            <p className="text-[12px] font-bold uppercase tracking-wider text-surface-500">Options</p>
                                            {(d.options || []).map((opt, idx) => (
                                                <div key={idx} className="flex items-center gap-3">
                                                    <GripVertical size={14} className="text-surface-300 flex-shrink-0" />
                                                    <input
                                                        type="text"
                                                        value={opt.label}
                                                        onChange={(e) => updateOption(dim, idx, 'label', e.target.value)}
                                                        placeholder="Option label"
                                                        className="flex-1 px-3 py-2 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
                                                    />
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        max={100}
                                                        value={opt.score}
                                                        onChange={(e) => updateOption(dim, idx, 'score', e.target.value)}
                                                        className="w-20 px-3 py-2 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400 text-center"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => removeOption(dim, idx)}
                                                        className="p-1.5 text-surface-400 hover:text-red-500 transition-colors"
                                                        title="Remove option"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </div>
                                            ))}
                                            <button
                                                type="button"
                                                onClick={() => addOption(dim)}
                                                className="flex items-center gap-1.5 text-[12px] font-medium text-primary-600 hover:text-primary-700 transition-colors mt-1"
                                            >
                                                <Plus size={14} />
                                                Add option
                                            </button>
                                        </div>

                                        <div className="border-t border-surface-100 pt-4 space-y-3">
                                            <div className="flex items-center gap-3">
                                                <label className="flex items-center gap-2 cursor-pointer">
                                                    <span className="text-sm font-medium text-surface-700">CTA Enabled</span>
                                                    <button
                                                        type="button"
                                                        role="switch"
                                                        aria-checked={d.cta_enabled}
                                                        onClick={() => updateDimension(dim, 'cta_enabled', !d.cta_enabled)}
                                                        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${d.cta_enabled ? 'bg-primary-500' : 'bg-surface-300'}`}
                                                    >
                                                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${d.cta_enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                                                    </button>
                                                </label>
                                            </div>
                                            {d.cta_enabled && (
                                                <input
                                                    type="text"
                                                    value={d.cta_prompt || ''}
                                                    onChange={(e) => updateDimension(dim, 'cta_prompt', e.target.value)}
                                                    placeholder="CTA prompt text"
                                                    className="w-full px-3 py-2 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
                                                />
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}

                    <div className="bg-white rounded-xl border border-surface-200 p-5 space-y-4">
                        <h3 className="text-base font-bold text-surface-900">Thresholds</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {[
                                { key: 'mql', label: 'MQL Threshold' },
                                { key: 'sal', label: 'SAL Threshold' },
                                { key: 'sql', label: 'SQL Threshold' },
                            ].map(({ key, label }) => (
                                <div key={key}>
                                    <label className="block text-[12px] font-bold text-surface-500 mb-1">{label}</label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={100}
                                        value={config.thresholds?.[key] ?? 0}
                                        onChange={(e) => updateThreshold(key, e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
                                    />
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="bg-white rounded-xl border border-surface-200 p-5 space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-base font-bold text-surface-900">Score Decay</h3>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={config.decay?.enabled ?? false}
                                onClick={() => updateDecay('enabled', !(config.decay?.enabled ?? false))}
                                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${config.decay?.enabled ? 'bg-primary-500' : 'bg-surface-300'}`}
                            >
                                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${config.decay?.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                            </button>
                        </div>
                        {config.decay?.enabled && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-[12px] font-bold text-surface-500 mb-1">Timeline decay per 30d</label>
                                    <input
                                        type="number"
                                        min={0}
                                        value={config.decay?.timeline_decay_per_30d ?? 0}
                                        onChange={(e) => updateDecay('timeline_decay_per_30d', e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[12px] font-bold text-surface-500 mb-1">Need decay per 30d</label>
                                    <input
                                        type="number"
                                        min={0}
                                        value={config.decay?.need_decay_per_30d ?? 0}
                                        onChange={(e) => updateDecay('need_decay_per_30d', e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
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
                            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-primary-600 rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-50"
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

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Qualification Funnel" description="Create a chatbot first to view funnel analytics." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    const chartData = funnel.map((item, idx) => ({
        ...item,
        stageLabel: FUNNEL_STAGE_LABELS[item.stage] || item.stage,
        fill: FUNNEL_COLORS[idx] || '#94a3b8',
    }));

    const visitors = chartData[0]?.count || 0;
    const sql = chartData.find((s) => s.stage === 'sql')?.count || 0;
    const meetings = chartData.find((s) => s.stage === 'meetings_booked')?.count || 0;
    const sqlConversionRate = visitors > 0 ? ((sql / visitors) * 100).toFixed(1) : '0.0';
    const meetingConversionRate = sql > 0 ? ((meetings / sql) * 100).toFixed(1) : '0.0';
    const avgTimeToQualify = 'N/A';

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap gap-2">
                {[
                    { key: '7d', label: '7 days' },
                    { key: '30d', label: '30 days' },
                    { key: '90d', label: '90 days' },
                    { key: 'all', label: 'All time' },
                ].map((opt) => (
                    <button
                        key={opt.key}
                        onClick={() => setPeriod(opt.key)}
                        className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                            period === opt.key
                                ? 'bg-primary-50 border-primary-300 text-primary-700'
                                : 'bg-white border-surface-200 text-surface-600 hover:bg-surface-50'
                        }`}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {isLoading ? (
                <SkeletonChart />
            ) : (
                <div className="bg-white rounded-xl border border-surface-200 p-5">
                    <div className="h-[340px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart
                                data={chartData}
                                layout="vertical"
                                margin={{ top: 8, right: 28, left: 16, bottom: 8 }}
                            >
                                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                                <XAxis type="number" />
                                <YAxis dataKey="stageLabel" type="category" width={90} />
                                <Tooltip
                                    formatter={(value, _name, payload) => {
                                        const conv = payload?.payload?.conversion_rate_from_previous ?? 0;
                                        return [`${value}`, `Count (${conv}% from previous)`];
                                    }}
                                />
                                <Bar dataKey="count">
                                    {chartData.map((entry, index) => (
                                        <Cell key={`bar-${entry.stage}-${index}`} fill={entry.fill} />
                                    ))}
                                    <LabelList dataKey="count" position="right" />
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard label="Total Visitors" value={visitors} />
                <StatCard label="SQL Conversion Rate" value={`${sqlConversionRate}%`} />
                <StatCard label="Avg Time to Qualify" value={avgTimeToQualify} />
            </div>
            <div className="text-xs text-surface-500">
                SQL to meeting conversion: <span className="font-semibold">{meetingConversionRate}%</span>
            </div>
        </div>
    );
}

export default function Qualification() {
    const [searchParams] = useSearchParams();
    const initialTab = searchParams.get('tab') || 'scorecard';
    const [activeTab, setActiveTab] = useState(initialTab);

    return (
        <div className="space-y-4 animate-fade-in">
            <PageHeader title="Qualification" subtitle="Configure qualification frameworks and review lead metrics" />
            <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
            {activeTab === 'scorecard' && <ScorecardTab />}
            {activeTab === 'configuration' && <ConfigurationTab />}
            {activeTab === 'funnel' && <FunnelTab />}
        </div>
    );
}
