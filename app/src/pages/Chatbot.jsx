import { useState, useEffect, useRef } from 'react';
import { getAuthState } from '../utils/auth';
import {
    Bot, Plus, Check, Trash2, Code2, Loader2, ArrowLeft,
    X, AlertCircle
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import {
    deleteBot,
    updateBot,
} from '../services/api';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import InstallDrawer from './my-bots/InstallDrawer';
import CreateBotWizard from './my-bots/CreateBotWizard';

import BotSettings from './BotSettings';
import { cn } from '../lib/utils';

export default function Chatbot() {
    const { bots, selectedBot, selectBot, refreshBots, loading, error: botError } = useBotContext();
    const { showToast } = useToast();
    const { isBotManager } = getAuthState();
    const [searchParams, setSearchParams] = useSearchParams();
    const botTab = searchParams.get('tab') || 'bots';
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const isFirstBot = bots.length === 0;
    const [installBot, setInstallBot] = useState(null);
    const [deletingBot, setDeletingBot] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);

    // Inline bot rename state
    const [renamingBot, setRenamingBot] = useState(null);   // botId | null
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef(null);

    // Open the create flow. The wizard self-adapts:
    //   * First bot (bots.length === 0) → one-screen Free path.
    //   * 2nd+ bot → two-step wizard with the plan picker + Razorpay.
    const openCreate = () => setIsCreateOpen(true);

    // Open the create flow if the user reached this page via the
    // ?create=true querystring (clicked "Create new bot" from the sidebar
    // dropdown or a deep link).
    useEffect(() => {
        if (searchParams.get('create') === 'true') {
            setIsCreateOpen(true);
            setSearchParams({}, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    // After the wizard creates a bot: refresh the list, then open the install
    // slide-over for the new bot so the user lands on next steps immediately.
    const handleCreated = async (newBotId) => {
        setIsCreateOpen(false);
        const refreshed = await refreshBots();
        const created = Array.isArray(refreshed)
            ? refreshed.find((b) => b.id === newBotId)
            : bots.find((b) => b.id === newBotId);
        if (created) {
            selectBot(created);
            setInstallBot(created);
        }
    };

    const handleDelete = async (botId, botName) => {
        setDeletingBot(botId);
        try {
            await deleteBot(botId);
            await refreshBots();
            showToast('success', `Bot "${botName}" deleted.`);
            setConfirmDelete(null);
            setInstallBot((prev) => (prev?.id === botId ? null : prev));
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
                    <PageHeader title="Bot Settings" subtitle="Configure your chatbot's personality, appearance, and behavior" />
                </div>
                <BotSettings embedded />
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-fade-in">
            <PageHeader title="My Bots" subtitle="Manage your chatbot instances">
                {isBotManager && (
                    <button
                        onClick={openCreate}
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
                    onAction={isBotManager ? openCreate : undefined}
                />
            ) : (
                <div className="space-y-3">
                    {bots.map((bot) => {
                        const isSelected = selectedBot?.id === bot.id;
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
                                        <button onClick={() => setInstallBot(bot)} className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-surface-600 dark:text-surface-300 bg-surface-100 dark:bg-surface-800 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors">
                                            <Code2 size={13} /> Embed
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
                            </div>
                        );
                    })}
                </div>
            )}

            <InstallDrawer
                key={installBot?.id}
                bot={installBot}
                open={!!installBot}
                onClose={() => setInstallBot(null)}
            />

            {isBotManager && (
                <CreateBotWizard
                    open={isCreateOpen}
                    isFirstBot={isFirstBot}
                    onClose={() => setIsCreateOpen(false)}
                    onCreated={handleCreated}
                />
            )}
        </div>
    );
}
