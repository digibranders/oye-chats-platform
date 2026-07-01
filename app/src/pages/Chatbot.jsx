import { useState, useEffect } from 'react';
import { getAuthState } from '../utils/auth';
import { Plus, Loader2, ArrowLeft, AlertCircle } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useBotContext } from '../context/BotContext';
import { useToast } from '../context/ToastContext';
import {
    deleteBot,
    updateBot,
    getBotDemoUrl,
    trackDemoShareClick,
} from '../services/api';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import BotCard from './my-bots/BotCard';
import InstallDrawer from './my-bots/InstallDrawer';
import CreateBotWizard from './my-bots/CreateBotWizard';

import BotSettings from './BotSettings';

export default function Chatbot() {
    const { bots, selectedBot, selectBot, refreshBots, loading, error: botError } = useBotContext();
    const { showToast } = useToast();
    const { isBotManager } = getAuthState();
    const [searchParams, setSearchParams] = useSearchParams();
    const botTab = searchParams.get('tab') || 'bots';
    // Seed the create flow open when the user arrives via the ?create=true
    // deep-link (sidebar "Create new bot"); the effect below then strips the
    // flag from the URL so a refresh doesn't reopen it.
    const [isCreateOpen, setIsCreateOpen] = useState(() => searchParams.get('create') === 'true');
    const isFirstBot = bots.length === 0;
    const [installBot, setInstallBot] = useState(null);

    // Open the create flow. The wizard self-adapts:
    //   * First bot (bots.length === 0) → one-screen Free path.
    //   * 2nd+ bot → two-step wizard with the plan picker + Razorpay.
    const openCreate = () => setIsCreateOpen(true);

    // Strip the ?create=true flag from the URL once consumed so a refresh
    // doesn't reopen the wizard. This only mutates the URL (no local setState).
    useEffect(() => {
        if (searchParams.get('create') === 'true') {
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

    // Manage = set the bot active and open its Bot Settings editor.
    const handleManage = (bot) => {
        selectBot(bot);
        setSearchParams({ tab: 'appearance' });
    };

    const handleDelete = async (bot) => {
        try {
            await deleteBot(bot.id);
            await refreshBots();
            showToast('success', `Bot "${bot.name}" deleted.`);
            setInstallBot((prev) => (prev?.id === bot.id ? null : prev));
        } catch (err) {
            showToast('error', err.message || 'Failed to delete bot');
        }
    };

    const handleRename = async (bot, name) => {
        try {
            await updateBot(bot.id, { name });
            await refreshBots();
            showToast('success', 'Bot renamed successfully.');
        } catch (err) {
            showToast('error', err.message || 'Failed to rename bot');
        }
    };

    // Copy a bot's demo/share link and record the share click. The card's ⋯
    // menu owns the interaction; this handler owns the clipboard + tracking.
    const handleDemoCopy = async (bot) => {
        try {
            await navigator.clipboard.writeText(getBotDemoUrl(bot.bot_key));
            showToast('success', 'Demo link copied to clipboard');
            trackDemoShareClick(bot.id).catch((err) => {
                console.error('Failed to track demo share click:', err);
            });
        } catch (err) {
            console.error('Failed to copy demo link:', err);
            showToast('error', 'Failed to copy to clipboard');
        }
    };

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
                    {bots.map((bot) => (
                        <BotCard
                            key={bot.id}
                            bot={bot}
                            isActive={selectedBot?.id === bot.id}
                            isBotManager={isBotManager}
                            onManage={handleManage}
                            onInstall={setInstallBot}
                            onRename={handleRename}
                            onDelete={handleDelete}
                            onDemo={handleDemoCopy}
                        />
                    ))}
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
