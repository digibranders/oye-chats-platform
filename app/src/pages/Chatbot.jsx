import { useState, useEffect } from 'react';
import {
    Bot, Plus, Copy, Check, Trash2, Code2, Key, Loader2,
    X, AlertCircle, ChevronDown, ChevronRight, Eye, EyeOff, Palette
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { createBot, deleteBot } from '../services/api';
import { platforms } from '../data/platformIntegrations';
import PlatformSelector from '../components/PlatformSelector';
import IntegrationGuide from '../components/IntegrationGuide';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import Tabs from '../components/ui/Tabs';
import Interface from './Interface';

const botPageTabs = [
    { id: 'bots', label: 'Bots', icon: Bot },
    { id: 'appearance', label: 'Appearance', icon: Palette },
];

export default function Chatbot() {
    const { bots, selectedBot, selectBot, refreshBots, loading, error: botError } = useBotContext();
    const { showToast } = useToast();
    const isBotManager = localStorage.getItem('auth_type') !== 'agent'
        || ['owner', 'admin'].includes(localStorage.getItem('agent_role') || '');
    const [searchParams, setSearchParams] = useSearchParams();
    const [botTab, setBotTab] = useState(searchParams.get('tab') || 'bots');
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [newBotName, setNewBotName] = useState('');
    const [newBotWebsite, setNewBotWebsite] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [copiedField, setCopiedField] = useState(null);
    const [expandedBot, setExpandedBot] = useState(null);
    const [deletingBot, setDeletingBot] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [showKeys, setShowKeys] = useState({});
    const [embedTab, setEmbedTab] = useState({});
    const [selectedPlatform, setSelectedPlatform] = useState({});

    // Auto-open create modal when navigated with ?create=true
    useEffect(() => {
        if (searchParams.get('create') === 'true') {
            setIsCreateOpen(true);
            setSearchParams({}, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    const handleCopy = (text, field) => {
        navigator.clipboard.writeText(text);
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 2000);
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!newBotName.trim()) return;
        setError(''); setIsSubmitting(true);
        try {
            const result = await createBot({ name: newBotName.trim(), website: newBotWebsite.trim() || undefined });
            await refreshBots();
            setNewBotName(''); setNewBotWebsite(''); setIsCreateOpen(false);
            showToast('success', `Bot "${result.name}" created!`);
            setExpandedBot(result.bot_id);
        } catch (err) {
            setError(typeof err === 'string' ? err : err?.detail || 'Failed to create bot');
        } finally { setIsSubmitting(false); }
    };

    const handleDelete = async (botId, botName) => {
        setDeletingBot(botId);
        try {
            await deleteBot(botId);
            await refreshBots();
            showToast('success', `Bot "${botName}" deleted.`);
            setConfirmDelete(null);
            if (expandedBot === botId) setExpandedBot(null);
        } catch (err) {
            showToast('error', typeof err === 'string' ? err : err?.detail || 'Failed to delete bot');
        } finally { setDeletingBot(null); setConfirmDelete(null); }
    };

    const toggleKey = (botId) => setShowKeys(prev => ({ ...prev, [botId]: !prev[botId] }));
    const maskKey = (key) => key ? key.substring(0, 6) + '••••••••' + key.substring(key.length - 4) : '';

    if (botTab === 'appearance') {
        return (
            <div className="space-y-4 animate-fade-in">
                <PageHeader title="My Bots" subtitle="Manage your chatbot instances and customize appearance" />
                <Tabs tabs={botPageTabs} activeTab={botTab} onChange={setBotTab} />
                <Interface embedded />
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-fade-in">
            <PageHeader title="My Bots" subtitle="Manage your chatbot instances and customize appearance">
                {isBotManager && (
                    <button
                        onClick={() => setIsCreateOpen(true)}
                        className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all hover:shadow-md"
                    >
                        <Plus size={16} /> Add Chatbot
                    </button>
                )}
            </PageHeader>
            <Tabs tabs={botPageTabs} activeTab={botTab} onChange={setBotTab} />

            {loading ? (
                <div className="flex flex-col items-center py-16 text-secondary-400">
                    <Loader2 className="animate-spin mb-3" size={28} />
                    <p className="text-sm">Loading chatbots...</p>
                </div>
            ) : botError ? (
                <div className="rounded-2xl border border-error-200 bg-error-50 p-6">
                    <div className="flex items-start gap-3">
                        <AlertCircle size={18} className="mt-0.5 text-error-600 flex-shrink-0" />
                        <div className="space-y-2">
                            <div>
                                <h3 className="text-sm font-semibold text-error-700">Unable to load chatbots</h3>
                                <p className="text-sm text-error-600">
                                    {botError.message}
                                    {botError.status ? ` (HTTP ${botError.status})` : ''}
                                </p>
                            </div>
                            <p className="text-sm text-error-600">
                                If this is an agent login, verify the agent belongs to the same workspace as the owner account.
                            </p>
                            <button
                                onClick={() => refreshBots()}
                                className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-medium text-error-700 shadow-sm ring-1 ring-error-200 transition-colors hover:bg-error-100"
                            >
                                Retry
                            </button>
                        </div>
                    </div>
                </div>
            ) : bots.length === 0 ? (
                <EmptyState
                    title="No chatbots yet"
                    description={isBotManager
                        ? 'Create your first chatbot to get started. Each bot gets its own embed code and knowledge base.'
                        : 'No chatbots are currently available for this workspace.'}
                    actionLabel={isBotManager ? 'Create Chatbot' : undefined}
                    onAction={isBotManager ? () => setIsCreateOpen(true) : undefined}
                />
            ) : (
                <div className="space-y-3">
                    {bots.map((bot) => {
                        const isExpanded = expandedBot === bot.id;
                        const isSelected = selectedBot?.id === bot.id;
                        const currentEmbedTab = embedTab[bot.id] || 'production';
                        return (
                            <div key={bot.id} className={`bg-white rounded-2xl border shadow-sm transition-all overflow-hidden ${isSelected ? 'border-primary-300 ring-1 ring-primary-200/50' : 'border-secondary-200'}`}>
                                <div className="p-5 flex items-center gap-4">
                                    <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${isSelected ? 'bg-primary-100' : 'bg-secondary-100'}`}>
                                        {bot.bot_logo ? <img src={bot.bot_logo} alt="" className="w-full h-full object-cover rounded-xl" /> : <Bot size={20} className={isSelected ? 'text-primary-600' : 'text-secondary-400'} />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-sm font-bold text-secondary-900 truncate">{bot.name}</h3>
                                            {isSelected && <span className="px-2 py-0.5 text-[9px] font-bold text-primary-600 bg-primary-100 rounded-full uppercase">Active</span>}
                                        </div>
                                        <div className="flex items-center gap-3 mt-0.5">
                                            <span className="text-[11px] text-secondary-400 font-mono">{maskKey(bot.bot_key)}</span>
                                            <span className="text-[10px] text-secondary-400">Created {new Date(bot.created_at).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        {!isSelected && (
                                            <button onClick={() => selectBot(bot)} className="px-3 py-1.5 text-[11px] font-bold text-primary-600 bg-primary-50 rounded-lg hover:bg-primary-100:bg-primary-500/20 transition-colors">Set Active</button>
                                        )}
                                        <button onClick={() => setExpandedBot(isExpanded ? null : bot.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-secondary-600 bg-secondary-100 rounded-lg hover:bg-secondary-200:bg-secondary-700 transition-colors">
                                            <Code2 size={13} /> Embed {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                        </button>
                                        {isBotManager && (
                                            confirmDelete === bot.id ? (
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[10px] text-secondary-400">Sure?</span>
                                                    <button onClick={() => handleDelete(bot.id, bot.name)} disabled={deletingBot === bot.id} className="p-1.5 rounded-lg bg-error-500 text-white hover:bg-error-600 transition-colors">{deletingBot === bot.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}</button>
                                                    <button onClick={() => setConfirmDelete(null)} className="p-1.5 rounded-lg bg-secondary-100 text-secondary-500 transition-colors"><X size={12} /></button>
                                                </div>
                                            ) : (
                                                <button onClick={() => setConfirmDelete(bot.id)} className="p-1.5 rounded-lg text-secondary-400 hover:text-error-500 hover:bg-error-50:bg-error-500/10 transition-colors"><Trash2 size={14} /></button>
                                            )
                                        )}
                                    </div>
                                </div>

                                {isExpanded && (
                                    <div className="border-t border-secondary-100 bg-secondary-50/50 p-5 space-y-4 animate-fade-in">
                                        {/* Bot Key */}
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <label className="text-[10px] font-bold uppercase tracking-wider text-secondary-400 flex items-center gap-1.5"><Key size={11} /> Bot Key</label>
                                                <div className="flex items-center gap-2">
                                                    <button onClick={() => toggleKey(bot.id)} className="text-secondary-400 hover:text-secondary-600:text-secondary-300 transition-colors">{showKeys[bot.id] ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                                                    <button onClick={() => handleCopy(bot.bot_key, `key-${bot.id}`)} className="flex items-center gap-1 text-primary-600 hover:text-primary-700 transition-colors">
                                                        {copiedField === `key-${bot.id}` ? <Check size={11} /> : <Copy size={11} />}
                                                        <span className="text-[9px] font-bold uppercase">{copiedField === `key-${bot.id}` ? 'Copied' : 'Copy'}</span>
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="flex items-center bg-white border border-secondary-200 rounded-lg px-3 py-2">
                                                <Key className="w-3.5 h-3.5 text-amber-500 mr-2 flex-shrink-0" />
                                                <code className="text-xs text-secondary-700 font-mono break-all">{showKeys[bot.id] ? bot.bot_key : maskKey(bot.bot_key)}</code>
                                            </div>
                                        </div>

                                        {/* Platform Integration Guide */}
                                        <div>
                                            <label className="text-[10px] font-bold uppercase tracking-wider text-secondary-400 flex items-center gap-1.5 mb-3">
                                                <Code2 size={11} /> Integration Guide
                                            </label>
                                            {selectedPlatform[bot.id] ? (
                                                <IntegrationGuide
                                                    platform={platforms.find((p) => p.id === selectedPlatform[bot.id])}
                                                    botKey={bot.bot_key}
                                                    env={currentEmbedTab}
                                                    onEnvChange={(env) => setEmbedTab({ ...embedTab, [bot.id]: env })}
                                                    onBack={() => setSelectedPlatform({ ...selectedPlatform, [bot.id]: null })}
                                                    onCopy={handleCopy}
                                                    copiedField={copiedField}
                                                />
                                            ) : (
                                                <PlatformSelector
                                                    platforms={platforms}
                                                    selectedId={null}
                                                    onSelect={(id) => setSelectedPlatform({ ...selectedPlatform, [bot.id]: id })}
                                                />
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Create Bot Modal */}
            {isBotManager && isCreateOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-secondary-200 overflow-hidden animate-scale-in">
                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-10 h-10 rounded-xl bg-primary-50 flex items-center justify-center">
                                    <Bot size={20} className="text-primary-600" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-secondary-900">Create New Chatbot</h2>
                                    <p className="text-xs text-secondary-500">Set up a new bot with its own embed key</p>
                                </div>
                            </div>
                            <form onSubmit={handleCreate} className="space-y-4">
                                {error && <div className="p-3 bg-error-50 text-error-600 text-sm rounded-xl border border-error-500/20 flex items-center gap-2"><AlertCircle size={14} />{error}</div>}
                                <div>
                                    <label className="block text-sm font-medium text-secondary-700 mb-1.5">Bot Name <span className="text-error-500">*</span></label>
                                    <input type="text" required value={newBotName} onChange={(e) => setNewBotName(e.target.value)} className="w-full h-11 px-3 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm" placeholder="e.g. Support Bot, Sales Assistant..." maxLength={50} />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-secondary-700 mb-1.5">Website <span className="text-secondary-400">(optional)</span></label>
                                    <input type="url" value={newBotWebsite} onChange={(e) => setNewBotWebsite(e.target.value)} className="w-full h-11 px-3 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all text-sm" placeholder="https://yourwebsite.com" />
                                </div>
                                <div className="flex gap-3 pt-2">
                                    <button type="button" onClick={() => { setIsCreateOpen(false); setError(''); setNewBotName(''); setNewBotWebsite(''); }} className="flex-1 py-2.5 bg-white border border-secondary-200 text-secondary-700 rounded-xl text-sm font-medium transition-colors hover:bg-secondary-50:bg-secondary-700">Cancel</button>
                                    <button type="submit" disabled={isSubmitting || !newBotName.trim()} className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-medium shadow-sm transition-colors flex justify-center items-center disabled:opacity-70">{isSubmitting ? <Loader2 size={16} className="animate-spin" /> : 'Create Bot'}</button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
