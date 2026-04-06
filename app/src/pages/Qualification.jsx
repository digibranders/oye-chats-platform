import { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Sliders, Loader2, Save, Plus, Trash2, GripVertical } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import Tabs from '../components/ui/Tabs';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { getLeadStats, getBot, updateBot } from '../services/api';

const tabs = [
    { id: 'scorecard', label: 'Scorecard', icon: ClipboardList },
    { id: 'configuration', label: 'Configuration', icon: Sliders },
];

const STATUS_CARDS = [
    { key: 'unqualified', label: 'Unqualified', color: 'text-secondary-600', border: 'border-secondary-200', bg: 'bg-secondary-50' },
    { key: 'mql', label: 'MQL', color: 'text-blue-600', border: 'border-blue-200', bg: 'bg-blue-50' },
    { key: 'sal', label: 'SAL', color: 'text-orange-600', border: 'border-orange-200', bg: 'bg-orange-50' },
    { key: 'sql', label: 'SQL', color: 'text-green-600', border: 'border-green-200', bg: 'bg-green-50' },
];

const DIMENSION_LABELS = {
    need: 'Need',
    timeline: 'Timeline',
    authority: 'Authority',
    budget: 'Budget',
};

const DEFAULT_CONFIG = {
    need: {
        enabled: true, weight: 25,
        options: [
            { label: 'Just browsing', score: 5 },
            { label: 'Exploring solutions', score: 10 },
            { label: 'Active pain point', score: 15 },
            { label: 'Urgent need', score: 20 },
            { label: 'Critical / blocking', score: 25 },
        ],
        cta_enabled: true, cta_prompt: 'What best describes your situation?',
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
        cta_enabled: true, cta_prompt: 'When are you looking to get started?',
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
        cta_enabled: false, cta_prompt: "What's your role in this decision?",
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
        cta_enabled: false, cta_prompt: 'Do you have a budget range in mind?',
    },
    thresholds: { mql: 30, sal: 55, sql: 75 },
    conversation_order: ['need', 'timeline', 'authority', 'budget'],
    decay: { enabled: true, timeline_decay_per_30d: 5, need_decay_per_30d: 3 },
};

// ── Scorecard Tab ──

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
            {/* Status cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {STATUS_CARDS.map((card) => {
                    const count = counts[card.key] || 0;
                    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    return (
                        <div
                            key={card.key}
                            className={`p-5 rounded-xl border ${card.border} ${card.bg} transition-all`}
                        >
                            <p className="text-[12px] font-bold uppercase tracking-wider text-secondary-500">{card.label}</p>
                            <p className={`text-3xl font-bold mt-1 ${card.color}`}>{count}</p>
                            <p className="text-[12px] text-secondary-400 mt-0.5">{pct}% of total</p>
                        </div>
                    );
                })}
            </div>

            {/* Average Score */}
            <div className="bg-white rounded-xl border border-secondary-200 p-5">
                <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-semibold text-secondary-700">Average Lead Score</p>
                    <span className="text-lg font-bold text-secondary-900">{Math.round(avgScore)}</span>
                </div>
                <div className="w-full h-3 bg-secondary-100 rounded-full overflow-hidden">
                    <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                            width: `${Math.min(avgScore, 100)}%`,
                            backgroundColor: avgScore >= 75 ? '#22c55e' : avgScore >= 50 ? '#f97316' : avgScore >= 25 ? '#eab308' : '#94a3b8',
                        }}
                    />
                </div>
                <div className="flex justify-between mt-1.5 text-[11px] text-secondary-400">
                    <span>0</span>
                    <span>25</span>
                    <span>50</span>
                    <span>75</span>
                    <span>100</span>
                </div>
            </div>
        </div>
    );
}

// ── Configuration Tab ──

function ConfigurationTab() {
    const { bots, selectedBot, loading: botsLoading } = useBotContext();
    const { showToast } = useToast();
    const [selectedBotId, setSelectedBotId] = useState(selectedBot?.id || null);
    const [config, setConfig] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // Sync selector when context bot changes
    useEffect(() => {
        if (selectedBot?.id) setSelectedBotId(selectedBot.id);
    }, [selectedBot?.id]);

    const loadConfig = useCallback(async (botId) => {
        if (!botId) return;
        setIsLoading(true);
        try {
            const bot = await getBot(botId);
            const saved = bot.bant_config;
            setConfig(saved && Object.keys(saved).length > 0 ? structuredClone(saved) : structuredClone(DEFAULT_CONFIG));
        } catch (err) {
            showToast('error', err.message || 'Failed to load bot config');
        } finally {
            setIsLoading(false);
        }
    }, [showToast]);

    useEffect(() => {
        loadConfig(selectedBotId);
    }, [selectedBotId, loadConfig]);

    const handleSave = async () => {
        if (!selectedBotId || !config) return;
        setIsSaving(true);
        try {
            await updateBot(selectedBotId, { bant_config: config });
            showToast('success', 'Qualification config saved');
        } catch (err) {
            showToast('error', err.message || 'Failed to save config');
        } finally {
            setIsSaving(false);
        }
    };

    const updateDimension = (dim, field, value) => {
        setConfig((prev) => ({ ...prev, [dim]: { ...prev[dim], [field]: value } }));
    };

    const updateOption = (dim, idx, field, value) => {
        setConfig((prev) => {
            const next = { ...prev, [dim]: { ...prev[dim], options: [...prev[dim].options] } };
            next[dim].options[idx] = { ...next[dim].options[idx], [field]: value };
            return next;
        });
    };

    const addOption = (dim) => {
        setConfig((prev) => {
            const opts = prev[dim].options;
            return { ...prev, [dim]: { ...prev[dim], options: [...opts, { label: '', score: 0 }] } };
        });
    };

    const removeOption = (dim, idx) => {
        setConfig((prev) => {
            const opts = prev[dim].options.filter((_, i) => i !== idx);
            return { ...prev, [dim]: { ...prev[dim], options: opts } };
        });
    };

    const updateThreshold = (field, value) => {
        setConfig((prev) => ({ ...prev, thresholds: { ...prev.thresholds, [field]: Number(value) || 0 } }));
    };

    const updateDecay = (field, value) => {
        const parsed = field === 'enabled' ? value : (Number(value) || 0);
        setConfig((prev) => ({ ...prev, decay: { ...prev.decay, [field]: parsed } }));
    };

    if (!botsLoading && bots.length === 0) {
        return <EmptyState title="Qualification" description="Create a chatbot first to configure qualification." actionLabel="Create Chatbot" actionTo="/chatbot" />;
    }

    return (
        <div className="space-y-6">
            {/* Bot selector */}
            <div className="bg-white rounded-xl border border-secondary-200 p-5">
                <label className="block text-sm font-semibold text-secondary-700 mb-2">Select Bot</label>
                <select
                    value={selectedBotId || ''}
                    onChange={(e) => setSelectedBotId(Number(e.target.value))}
                    className="w-full max-w-xs px-3 py-2 text-sm bg-white border border-secondary-200 rounded-lg focus:outline-none focus:border-primary-400"
                >
                    <option value="" disabled>Choose a bot...</option>
                    {bots.map((bot) => (
                        <option key={bot.id} value={bot.id}>{bot.name}</option>
                    ))}
                </select>
            </div>

            {isLoading && (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-7 h-7 animate-spin text-primary-500" />
                </div>
            )}

            {!isLoading && config && (
                <>
                    {/* Dimension sections */}
                    {Object.keys(DIMENSION_LABELS).map((dim) => {
                        const d = config[dim];
                        if (!d) return null;
                        return (
                            <div key={dim} className="bg-white rounded-xl border border-secondary-200 p-5 space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-base font-bold text-secondary-900">{DIMENSION_LABELS[dim]}</h3>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <span className="text-[12px] font-medium text-secondary-500">
                                            {d.enabled ? 'Enabled' : 'Disabled'}
                                        </span>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={d.enabled}
                                            onClick={() => updateDimension(dim, 'enabled', !d.enabled)}
                                            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${d.enabled ? 'bg-primary-500' : 'bg-secondary-300'}`}
                                        >
                                            <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${d.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                                        </button>
                                    </label>
                                </div>

                                {d.enabled && (
                                    <>
                                        {/* Options */}
                                        <div className="space-y-2">
                                            <p className="text-[12px] font-bold uppercase tracking-wider text-secondary-500">Options</p>
                                            {d.options.map((opt, idx) => (
                                                <div key={idx} className="flex items-center gap-3">
                                                    <GripVertical size={14} className="text-secondary-300 flex-shrink-0" />
                                                    <input
                                                        type="text"
                                                        value={opt.label}
                                                        onChange={(e) => updateOption(dim, idx, 'label', e.target.value)}
                                                        placeholder="Option label"
                                                        className="flex-1 px-3 py-2 text-sm bg-white border border-secondary-200 rounded-lg focus:outline-none focus:border-primary-400"
                                                    />
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        max={25}
                                                        value={opt.score}
                                                        onChange={(e) => updateOption(dim, idx, 'score', Number(e.target.value) || 0)}
                                                        className="w-20 px-3 py-2 text-sm bg-white border border-secondary-200 rounded-lg focus:outline-none focus:border-primary-400 text-center"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => removeOption(dim, idx)}
                                                        className="p-1.5 text-secondary-400 hover:text-red-500 transition-colors"
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

                                        {/* CTA */}
                                        <div className="border-t border-secondary-100 pt-4 space-y-3">
                                            <div className="flex items-center gap-3">
                                                <label className="flex items-center gap-2 cursor-pointer">
                                                    <span className="text-sm font-medium text-secondary-700">CTA Enabled</span>
                                                    <button
                                                        type="button"
                                                        role="switch"
                                                        aria-checked={d.cta_enabled}
                                                        onClick={() => updateDimension(dim, 'cta_enabled', !d.cta_enabled)}
                                                        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${d.cta_enabled ? 'bg-primary-500' : 'bg-secondary-300'}`}
                                                    >
                                                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${d.cta_enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                                                    </button>
                                                </label>
                                            </div>
                                            {d.cta_enabled && (
                                                <input
                                                    type="text"
                                                    value={d.cta_prompt}
                                                    onChange={(e) => updateDimension(dim, 'cta_prompt', e.target.value)}
                                                    placeholder="CTA prompt text"
                                                    className="w-full px-3 py-2 text-sm bg-white border border-secondary-200 rounded-lg focus:outline-none focus:border-primary-400"
                                                />
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}

                    {/* Thresholds */}
                    <div className="bg-white rounded-xl border border-secondary-200 p-5 space-y-4">
                        <h3 className="text-base font-bold text-secondary-900">Thresholds</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            {[
                                { key: 'mql', label: 'MQL Threshold' },
                                { key: 'sal', label: 'SAL Threshold' },
                                { key: 'sql', label: 'SQL Threshold' },
                            ].map(({ key, label }) => (
                                <div key={key}>
                                    <label className="block text-[12px] font-bold text-secondary-500 mb-1">{label}</label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={100}
                                        value={config.thresholds?.[key] ?? 0}
                                        onChange={(e) => updateThreshold(key, e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white border border-secondary-200 rounded-lg focus:outline-none focus:border-primary-400"
                                    />
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Decay */}
                    <div className="bg-white rounded-xl border border-secondary-200 p-5 space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-base font-bold text-secondary-900">Score Decay</h3>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={config.decay?.enabled ?? false}
                                onClick={() => updateDecay('enabled', !(config.decay?.enabled ?? false))}
                                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${config.decay?.enabled ? 'bg-primary-500' : 'bg-secondary-300'}`}
                            >
                                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${config.decay?.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                            </button>
                        </div>
                        {config.decay?.enabled && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-[12px] font-bold text-secondary-500 mb-1">Timeline decay per 30d</label>
                                    <input
                                        type="number"
                                        min={0}
                                        value={config.decay?.timeline_decay_per_30d ?? 0}
                                        onChange={(e) => updateDecay('timeline_decay_per_30d', e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white border border-secondary-200 rounded-lg focus:outline-none focus:border-primary-400"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[12px] font-bold text-secondary-500 mb-1">Need decay per 30d</label>
                                    <input
                                        type="number"
                                        min={0}
                                        value={config.decay?.need_decay_per_30d ?? 0}
                                        onChange={(e) => updateDecay('need_decay_per_30d', e.target.value)}
                                        className="w-full px-3 py-2 text-sm bg-white border border-secondary-200 rounded-lg focus:outline-none focus:border-primary-400"
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Save */}
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

// ── Main Page ──

export default function Qualification() {
    const [searchParams] = useSearchParams();
    const initialTab = searchParams.get('tab') || 'scorecard';
    const [activeTab, setActiveTab] = useState(initialTab);

    return (
        <div className="space-y-4 animate-fade-in">
            <PageHeader title="Qualification" subtitle="Configure BANT scoring and review lead qualification metrics" />
            <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'scorecard' && <ScorecardTab />}
            {activeTab === 'configuration' && <ConfigurationTab />}
        </div>
    );
}
