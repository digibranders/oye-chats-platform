import { useState, useEffect, useRef } from 'react';
import { getAuthState } from '../utils/auth';
import {
    Bot, Plus, Copy, Check, Trash2, Code2, Key, Loader2, ArrowLeft,
    X, AlertCircle, ChevronDown, ChevronRight, Eye, EyeOff, ExternalLink, Link2
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import { useUpgradeModal } from '../context/UpgradeModalContext';
import useEntitlements from '../hooks/useEntitlements';
import { createBot, deleteBot, crawlWebsite, getBotDemoUrl, getBotPreviewUrl, trackDemoShareClick, updateBot } from '../services/api';
import { platforms } from '../data/platformIntegrations';
import PlatformSelector from '../components/PlatformSelector';
import IntegrationGuide from '../components/IntegrationGuide';
import DomainRestrictions from '../components/DomainRestrictions';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';

import Interface from './Interface';
import { cn, normalizeUrl } from '../lib/utils';

export default function Chatbot() {
    const { bots, selectedBot, selectBot, refreshBots, loading, error: botError } = useBotContext();
    const { showToast } = useToast();
    const { isBotManager } = getAuthState();
    const { requestUpgrade } = useUpgradeModal();
    const { entitlements: ent } = useEntitlements();
    const [searchParams, setSearchParams] = useSearchParams();
    const botTab = searchParams.get('tab') || 'bots';
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

    // Inline bot rename state
    const [renamingBot, setRenamingBot] = useState(null);   // botId | null
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef(null);

    // Open the create flow if the user reached this page via the
    // ?create=true querystring (clicked "Create new bot" from the sidebar
    // dropdown or a deep link). The plan-limit gate runs HERE rather than
    // only on the visible Add button so URL-walkers and deep links hit the
    // same upgrade upsell as everyone else.
    const tryOpenCreate = () => {
        const botLimit = ent.limitFor('bots');
        if (!ent.withinLimit('bots', bots.length)) {
            requestUpgrade('add_bot', {
                current: bots.length,
                limit: botLimit,
                planName: ent.planName,
                canPurchase: ent.canPurchaseBotSeat,
                hardCap: (ent.limits || {}).max_bots_cap,
            });
            return false;
        }
        setIsCreateOpen(true);
        return true;
    };

    useEffect(() => {
        if (searchParams.get('create') === 'true') {
            tryOpenCreate();
            setSearchParams({}, { replace: true });
        }
        // tryOpenCreate closes over `bots` / entitlements, which we re-evaluate
        // every render; the effect's job is purely to react to the URL flag.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams, setSearchParams]);

    const handleCopy = async (text, field, onCopied) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedField(field);
            setTimeout(() => setCopiedField(null), 2000);
            await onCopied?.();
        } catch (err) {
            console.error('Failed to copy text:', err);
            showToast('error', 'Failed to copy to clipboard');
        }
    };

    const handleDemoCopy = async (bot) => {
        await handleCopy(getBotDemoUrl(bot.bot_key), `demo-${bot.id}`, async () => {
            try {
                await trackDemoShareClick(bot.id);
            } catch (err) {
                console.error('Failed to track demo share click:', err);
            }
        });
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!newBotName.trim()) return;
        const normalizedWebsite = normalizeUrl(newBotWebsite);
        setError(''); setIsSubmitting(true);
        try {
            const result = await createBot({ name: newBotName.trim(), website: normalizedWebsite || undefined });
            if (normalizedWebsite) {
                crawlWebsite(normalizedWebsite, result.bot_id).catch((err) => {
                    console.error('Background website crawl failed:', err);
                    showToast('error', err.message || 'Failed to crawl website');
                });
            }
            await refreshBots();
            setNewBotName(''); setNewBotWebsite(''); setIsCreateOpen(false);
            showToast('success', `Bot "${result.name}" created!`);
            setExpandedBot(result.bot_id);
        } catch (err) {
            setError(err.message || 'Failed to create bot');
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
            showToast('error', err.message || 'Failed to delete bot');
        } finally { setDeletingBot(null); setConfirmDelete(null); }
    };

    const startRename = (bot) => {
        setRenamingBot(bot.id);
        setRenameValue(bot.name);
        // Focus the input after React paints
        setTimeout(() => renameInputRef.current?.focus(), 30);
    };

    const cancelRename = () => {
        setRenamingBot(null);
        setRenameValue('');
    };

    const commitRename = async (botId) => {
        const trimmed = renameValue.trim();
        if (!trimmed) { cancelRename(); return; }
        const originalBot = bots.find(b => b.id === botId);
        if (trimmed === originalBot?.name) { cancelRename(); return; }
        try {
            await updateBot(botId, { name: trimmed });
            await refreshBots();
            showToast('success', 'Bot renamed successfully.');
        } catch (err) {
            showToast('error', err.message || 'Failed to rename bot');
        } finally {
            cancelRename();
        }
    };

    const toggleKey = (botId) => setShowKeys(prev => ({ ...prev, [botId]: !prev[botId] }));
    const maskKey = (key) => key ? key.substring(0, 6) + '••••••••' + key.substring(key.length - 4) : '';

    if (botTab === 'appearance') {
        return (
            <div className="space-y-4 animate-fade-in">
                <div>
                    <button
                        onClick={() => setSearchParams({}, { replace: true })}
                        className="flex items-center gap-1.5 text-[13px] font-medium text-surface-400 dark:text-surface-500 hover:text-surface-700 dark:hover:text-surface-200 transition-colors mb-2"
                    >
                        <ArrowLeft size={14} />
                        My Bots
                    </button>
                    <PageHeader title="Appearance" subtitle="Customize your chatbot's look and feel" />
                </div>
                <Interface embedded />
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-fade-in">
            <PageHeader title="My Bots" subtitle="Manage your chatbot instances">
                {isBotManager && (
                    <button
                        onClick={tryOpenCreate}
                        className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white rounded-xl text-sm font-medium shadow-sm transition-all hover:shadow-md"
                    >
                        <Plus size={16} /> Add Chatbot
                    </button>
                )}
            </PageHeader>

            {loading ? (
                <div className="flex flex-col items-center py-16 text-surface-400 dark:text-surface-500">
                    <Loader2 className="animate-spin mb-3" size={28} />
                    <p className="text-sm">Loading chatbots...</p>
                </div>
            ) : botError ? (
                <div className="rounded-2xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 p-6">
                    <div className="flex items-start gap-3">
                        <AlertCircle size={18} className="mt-0.5 text-rose-600 dark:text-rose-400 flex-shrink-0" />
                        <div className="space-y-2">
                            <div>
                                <h3 className="text-sm font-semibold text-rose-700 dark:text-rose-300">Unable to load chatbots</h3>
                                <p className="text-sm text-rose-600 dark:text-rose-400">
                                    {botError.message}
                                    {botError.status ? ` (HTTP ${botError.status})` : ''}
                                </p>
                            </div>
                            <p className="text-sm text-rose-600 dark:text-rose-400">
                                If this is an agent login, verify the agent belongs to the same workspace as the owner account.
                            </p>
                            <button
                                onClick={() => refreshBots()}
                                className="inline-flex items-center gap-2 rounded-xl bg-white dark:bg-surface-900 px-3 py-2 text-sm font-medium text-rose-700 dark:text-rose-300 shadow-sm ring-1 ring-rose-200 dark:ring-rose-500/30 transition-colors hover:bg-rose-100 dark:hover:bg-rose-500/20"
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
                    onAction={isBotManager ? tryOpenCreate : undefined}
                />
            ) : (
                <div className="space-y-3">
                    {bots.map((bot) => {
                        const isExpanded = expandedBot === bot.id;
                        const isSelected = selectedBot?.id === bot.id;
                        const currentEmbedTab = embedTab[bot.id] || 'production';
                        return (
                            <div
                                key={bot.id}
                                className={cn(
                                    'bg-white dark:bg-surface-900 rounded-2xl border shadow-sm transition-all overflow-hidden',
                                    isSelected
                                        ? 'border-primary-300 dark:border-primary-500/50 ring-1 ring-primary-200/50 dark:ring-primary-500/20'
                                        : 'border-surface-200 dark:border-surface-700'
                                )}
                            >
                                <div className="p-5 flex items-center gap-4">
                                    <div className={cn(
                                        'w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0',
                                        isSelected
                                            ? 'bg-primary-100 dark:bg-primary-500/15'
                                            : 'bg-surface-100 dark:bg-surface-800'
                                    )}>
                                        {bot.bot_logo ? <img src={bot.bot_logo} alt="" className="w-full h-full object-cover rounded-xl" /> : <Bot size={20} className={isSelected ? 'text-primary-600 dark:text-primary-400' : 'text-surface-400 dark:text-surface-500'} />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            {renamingBot === bot.id ? (
                                                <input
                                                    ref={renameInputRef}
                                                    type="text"
                                                    value={renameValue}
                                                    onChange={(e) => setRenameValue(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') { e.preventDefault(); commitRename(bot.id); }
                                                        else if (e.key === 'Escape') cancelRename();
                                                    }}
                                                    onBlur={() => commitRename(bot.id)}
                                                    maxLength={50}
                                                    className="text-sm font-bold text-surface-900 dark:text-surface-100 bg-white dark:bg-surface-800 border border-primary-400 dark:border-primary-500 rounded-md px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-400/30 w-48"
                                                />
                                            ) : (
                                                <h3
                                                    className={cn(
                                                        'text-sm font-bold text-surface-900 dark:text-surface-100 truncate',
                                                        isBotManager && 'cursor-text hover:underline decoration-dashed underline-offset-2'
                                                    )}
                                                    title={isBotManager ? 'Click to rename' : undefined}
                                                    onClick={isBotManager ? () => startRename(bot) : undefined}
                                                >
                                                    {bot.name}
                                                </h3>
                                            )}
                                            {isSelected && <span className="px-2 py-0.5 text-[9px] font-bold text-primary-600 dark:text-primary-400 bg-primary-100 dark:bg-primary-500/15 rounded-full uppercase">Active</span>}
                                        </div>
                                        <div className="flex items-center gap-3 mt-0.5">
                                            <span className="text-[11px] text-surface-400 dark:text-surface-500 font-mono">{maskKey(bot.bot_key)}</span>
                                            <span className="text-[10px] text-surface-400 dark:text-surface-500">Created {new Date(bot.created_at).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        {!isSelected && (
                                            <button onClick={() => selectBot(bot)} className="px-3 py-1.5 text-[11px] font-bold text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-500/10 rounded-lg hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors">Set Active</button>
                                        )}
                                        <button onClick={() => setExpandedBot(isExpanded ? null : bot.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-surface-600 dark:text-surface-300 bg-surface-100 dark:bg-surface-800 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors">
                                            <Code2 size={13} /> Embed {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                        </button>
                                        {isBotManager && (
                                            confirmDelete === bot.id ? (
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[10px] text-surface-400 dark:text-surface-500">Sure?</span>
                                                    <button onClick={() => handleDelete(bot.id, bot.name)} disabled={deletingBot === bot.id} className="p-1.5 rounded-lg bg-rose-500 text-white hover:bg-rose-600 dark:hover:bg-rose-400 transition-colors">{deletingBot === bot.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}</button>
                                                    <button onClick={() => setConfirmDelete(null)} className="p-1.5 rounded-lg bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 transition-colors"><X size={12} /></button>
                                                </div>
                                            ) : (
                                                <button onClick={() => setConfirmDelete(bot.id)} className="p-1.5 rounded-lg text-surface-400 dark:text-surface-500 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors"><Trash2 size={14} /></button>
                                            )
                                        )}
                                    </div>
                                </div>

                                {isExpanded && (
                                    <div className="border-t border-surface-100 dark:border-surface-700 bg-surface-50/50 dark:bg-surface-800/50 p-5 space-y-4 animate-fade-in">
                                        {/* Bot Key */}
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <label className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 flex items-center gap-1.5"><Key size={11} /> Bot Key</label>
                                                <div className="flex items-center gap-2">
                                                    <button onClick={() => toggleKey(bot.id)} className="text-surface-400 dark:text-surface-500 hover:text-surface-600 dark:hover:text-surface-300 transition-colors">{showKeys[bot.id] ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                                                    <button onClick={() => handleCopy(bot.bot_key, `key-${bot.id}`)} className="flex items-center gap-1 text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors">
                                                        {copiedField === `key-${bot.id}` ? <Check size={11} /> : <Copy size={11} />}
                                                        <span className="text-[9px] font-bold uppercase">{copiedField === `key-${bot.id}` ? 'Copied' : 'Copy'}</span>
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="flex items-center bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg px-3 py-2">
                                                <Key className="w-3.5 h-3.5 text-amber-500 mr-2 flex-shrink-0" />
                                                <code className="text-xs text-surface-700 dark:text-surface-300 font-mono break-all">{showKeys[bot.id] ? bot.bot_key : maskKey(bot.bot_key)}</code>
                                            </div>
                                        </div>

                                        {isBotManager && (
                                            <div>
                                                <label className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500">Preview &amp; Share</label>
                                                <p className="text-xs text-surface-500 dark:text-surface-400 mt-1 mb-3">
                                                    {bot.website
                                                        ? 'Preview the widget on your website, or share a demo link with teammates.'
                                                        : 'Share a live preview page to test the widget before embedding.'}
                                                </p>
                                                <div className="flex items-center gap-2">
                                                    <a
                                                        href={getBotPreviewUrl(bot.bot_key, bot.website)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white text-xs font-semibold rounded-lg transition-colors"
                                                    >
                                                        <ExternalLink size={13} />
                                                        View Demo
                                                    </a>
                                                    <button
                                                        onClick={() => handleDemoCopy(bot)}
                                                        className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-surface-200 dark:border-surface-600 hover:border-surface-300 dark:hover:border-surface-500 text-surface-600 dark:text-surface-300 hover:text-surface-700 dark:hover:text-surface-200 text-xs font-semibold rounded-lg transition-colors bg-white dark:bg-surface-900"
                                                    >
                                                        {copiedField === `demo-${bot.id}` ? <Check size={13} /> : <Link2 size={13} />}
                                                        {copiedField === `demo-${bot.id}` ? 'Copied!' : 'Copy Link'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {/* Domain restrictions (widget embed whitelist) */}
                                        {isBotManager && (
                                            <DomainRestrictions
                                                botId={bot.id}
                                                initialAllowedDomains={bot.allowed_domains || []}
                                                initialDomainCheckEnabled={Boolean(bot.domain_check_enabled)}
                                                botWebsite={bot.website}
                                            />
                                        )}

                                        {/* Platform Integration Guide */}
                                        <div>
                                            <label className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 flex items-center gap-1.5 mb-3">
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
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 dark:bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white dark:bg-surface-900 rounded-2xl shadow-xl w-full max-w-md border border-surface-200 dark:border-surface-700 overflow-hidden animate-scale-in">
                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
                                    <Bot size={20} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100">Create New Chatbot</h2>
                                    <p className="text-xs text-surface-500 dark:text-surface-400">Set up a new bot with its own embed key</p>
                                </div>
                            </div>
                            <form onSubmit={handleCreate} className="space-y-4">
                                {error && <div className="p-3 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 text-sm rounded-xl border border-rose-500/20 dark:border-rose-500/30 flex items-center gap-2"><AlertCircle size={14} />{error}</div>}
                                <div>
                                    <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">Bot Name <span className="text-rose-500">*</span></label>
                                    <input type="text" required value={newBotName} onChange={(e) => setNewBotName(e.target.value)} className="w-full h-11 px-3 rounded-xl border border-surface-200 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-400/30 focus:border-primary-500 dark:focus:border-primary-400 outline-none transition-all text-sm placeholder:text-surface-400 dark:placeholder:text-surface-500" placeholder="e.g. Support Bot, Sales Assistant..." maxLength={50} />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">Website</label>
                                    <input type="text" value={newBotWebsite} onChange={(e) => setNewBotWebsite(e.target.value)} className="w-full h-11 px-3 rounded-xl border border-surface-200 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-400/30 focus:border-primary-500 dark:focus:border-primary-400 outline-none transition-all text-sm placeholder:text-surface-400 dark:placeholder:text-surface-500" placeholder="https://yourwebsite.com" />
                                    <p className="mt-1.5 text-[11px] text-surface-500 dark:text-surface-400">
                                        We&apos;ll automatically restrict your widget to this site. You can edit the allowed domains anytime.
                                    </p>
                                </div>
                                <div className="flex gap-3 pt-2">
                                    <button type="button" onClick={() => { setIsCreateOpen(false); setError(''); setNewBotName(''); setNewBotWebsite(''); }} className="flex-1 py-2.5 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-600 text-surface-700 dark:text-surface-300 rounded-xl text-sm font-medium transition-colors hover:bg-surface-50 dark:hover:bg-surface-700">Cancel</button>
                                    <button type="submit" disabled={isSubmitting || !newBotName.trim()} className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white rounded-xl text-sm font-medium shadow-sm transition-colors flex justify-center items-center disabled:opacity-70">{isSubmitting ? <Loader2 size={16} className="animate-spin" /> : 'Create Bot'}</button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
