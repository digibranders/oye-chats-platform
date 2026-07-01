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
    createBot,
    deleteBot,
    crawlWebsite,
    updateBot,
    getSubscriptionPlans,
    createBotCheckout,
    verifyBotCheckout,
} from '../services/api';
import { openRazorpayCheckout } from '../lib/razorpay';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import InstallDrawer from './my-bots/InstallDrawer';

import BotSettings from './BotSettings';
import { cn, normalizeUrl } from '../lib/utils';

export default function Chatbot() {
    const { bots, selectedBot, selectBot, refreshBots, loading, error: botError } = useBotContext();
    const { showToast } = useToast();
    const { isBotManager } = getAuthState();
    const [searchParams, setSearchParams] = useSearchParams();
    const botTab = searchParams.get('tab') || 'bots';
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [newBotName, setNewBotName] = useState('');
    const [newBotWebsite, setNewBotWebsite] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');
    // Two-step create flow for the 2nd+ bot: 'details' (name/website) →
    // 'plan' (plan picker + monthly/annual toggle + checkout CTA). The
    // first bot on an account skips step 2 entirely (no payment needed
    // for the included Free bot).
    const [createStep, setCreateStep] = useState('details');
    const [billingCycle, setBillingCycle] = useState('monthly');
    const [selectedPlanSlug, setSelectedPlanSlug] = useState('starter');
    const [paidPlans, setPaidPlans] = useState([]);
    const isFirstBot = bots.length === 0;
    const [installBot, setInstallBot] = useState(null);
    const [deletingBot, setDeletingBot] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);

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
        // Open the create wizard for everyone. It self-adapts:
        //   * First bot (bots.length === 0) → one-screen Free path.
        //   * 2nd+ bot → two-step wizard with the plan picker + Razorpay.
        // The generic UpgradeModal isn't routed for ``add_bot`` anymore —
        // it would just be an extra click before the same pricing step
        // the wizard already shows.
        setIsCreateOpen(true);
        setCreateStep('details');
        return true;
    };

    useEffect(() => {
        if (searchParams.get('create') === 'true') {
            tryOpenCreate();
            setSearchParams({}, { replace: true });
        }
        // The effect's job is purely to react to the URL flag; the wizard
        // adapts itself based on the current bots list (no dependency on
        // entitlements needed here).
    }, [searchParams, setSearchParams]);

    // Pre-load the active plans the first time the create modal opens so
    // the pricing step renders without a flash. Falls back silently to
    // the hardcoded starter/standard slugs if the call fails.
    useEffect(() => {
        if (!isCreateOpen || isFirstBot || paidPlans.length > 0) return;
        getSubscriptionPlans()
            .then((all) => {
                const paid = (all || [])
                    .filter((p) => p.slug !== 'free' && p.slug !== 'enterprise')
                    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
                setPaidPlans(paid);
                if (paid.length > 0 && !paid.find((p) => p.slug === selectedPlanSlug)) {
                    setSelectedPlanSlug(paid[0].slug);
                }
            })
            .catch((err) => console.error('Failed to load plans for bot checkout:', err));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isCreateOpen, isFirstBot]);

    const selectedPlan = paidPlans.find((p) => p.slug === selectedPlanSlug) || null;
    const planPriceCents = selectedPlan
        ? (billingCycle === 'annual'
            ? Math.round((selectedPlan.annual_price_cents ?? selectedPlan.monthly_price_cents ?? 0) / 12)
            : (selectedPlan.monthly_price_cents ?? 0))
        : 0;
    const planCurrencySymbol = selectedPlan?.currency === 'INR' ? '₹' : '$';
    const planPriceLabel = `${planCurrencySymbol}${(planPriceCents / 100).toFixed(0)}/mo`;

    // Dismiss path: close the modal, reset all wizard state, and snap the
    // sidebar selection back to bot 1 so the user lands somewhere
    // concrete after abandoning the create flow.
    const closeCreateAndReturnToBot1 = () => {
        setIsCreateOpen(false);
        setCreateStep('details');
        setError('');
        setNewBotName('');
        setNewBotWebsite('');
        setBillingCycle('monthly');
        if (bots.length > 0) selectBot(bots[0]);
    };

    const handleContinueToPricing = (e) => {
        e.preventDefault();
        if (!newBotName.trim()) return;
        setError('');
        if (isFirstBot) {
            // First bot path — skip checkout; create directly under the Free plan.
            handleCreateFreeBot();
            return;
        }
        setCreateStep('plan');
    };

    const handleCreateFreeBot = async () => {
        const normalizedWebsite = normalizeUrl(newBotWebsite);
        setIsSubmitting(true);
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
        } catch (err) {
            // Edge case — Free bot path should never 402 (bot count was 0
            // when the modal opened) but handle defensively if a sibling
            // tab raced and created the first bot just now.
            if (err?.status === 402 && err?.data?.detail?.must_subscribe) {
                setCreateStep('plan');
                return;
            }
            setError(err.message || 'Failed to create bot');
        } finally { setIsSubmitting(false); }
    };

    const handleSubscribeAndCreate = async () => {
        if (!newBotName.trim() || !selectedPlan) return;
        const normalizedWebsite = normalizeUrl(newBotWebsite);
        setError(''); setIsSubmitting(true);
        try {
            const order = await createBotCheckout({
                name: newBotName.trim(),
                website: normalizedWebsite || undefined,
                plan_slug: selectedPlan.slug,
                billing_cycle: billingCycle,
            });
            const callback = await openRazorpayCheckout({
                key: order.key_id,
                subscription_id: order.subscription_id,
                name: order.name || 'OyeChats',
                description: order.description,
                prefill: order.prefill || {},
                theme: order.theme || { color: '#6366f1' },
            });
            const verifyResult = await verifyBotCheckout({
                razorpay_payment_id: callback.razorpay_payment_id,
                razorpay_subscription_id: callback.razorpay_subscription_id,
                razorpay_signature: callback.razorpay_signature,
            });
            await refreshBots();
            const newBotId = verifyResult?.bot_id;
            if (normalizedWebsite && newBotId) {
                crawlWebsite(normalizedWebsite, newBotId).catch((err) => {
                    console.error('Background website crawl failed:', err);
                });
            }
            setIsCreateOpen(false);
            setCreateStep('details');
            setNewBotName(''); setNewBotWebsite('');
            showToast('success', `Bot "${newBotName.trim()}" created and subscribed!`);
        } catch (err) {
            // Razorpay modal dismissed — treat as abandon and snap back to bot 1.
            if (err?.code === 'dismissed') {
                closeCreateAndReturnToBot1();
                return;
            }
            setError(err.message || 'Could not complete bot subscription. Try again.');
        } finally { setIsSubmitting(false); }
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

            {/* Create Bot Modal — simple two-step wizard.
                Step 1: name + website. Step 2 (2nd+ bot only): plan picker
                + monthly/annual toggle → Razorpay Checkout. */}
            {isBotManager && isCreateOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 dark:bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white dark:bg-surface-900 rounded-2xl shadow-xl w-full max-w-md border border-surface-200 dark:border-surface-700 overflow-hidden animate-scale-in">
                        <div className="p-6">
                            <div className="flex items-center gap-3 mb-5">
                                <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
                                    <Bot size={20} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div>
                                    <h2 className="text-base font-semibold text-surface-900 dark:text-surface-100">
                                        {createStep === 'plan' ? 'Pick a plan' : 'Create new chatbot'}
                                    </h2>
                                    <p className="text-xs text-surface-500 dark:text-surface-400">
                                        {createStep === 'plan'
                                            ? 'Each bot is its own subscription'
                                            : isFirstBot
                                                ? 'Included free on every account'
                                                : 'Step 1 of 2 — name your bot'}
                                    </p>
                                </div>
                            </div>

                            {error && (
                                <div className="mb-4 p-3 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 text-sm rounded-xl border border-rose-500/20 dark:border-rose-500/30 flex items-center gap-2">
                                    <AlertCircle size={14} />{error}
                                </div>
                            )}

                            {createStep === 'details' ? (
                                <form onSubmit={handleContinueToPricing} className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                                            Bot name <span className="text-rose-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            required
                                            value={newBotName}
                                            onChange={(e) => setNewBotName(e.target.value)}
                                            className="w-full h-11 px-3 rounded-xl border border-surface-200 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400 outline-none transition-all text-sm placeholder:text-surface-400 dark:placeholder:text-surface-500"
                                            placeholder="e.g. Support Bot"
                                            maxLength={50}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                                            Website <span className="text-xs font-normal text-surface-400">(optional)</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={newBotWebsite}
                                            onChange={(e) => setNewBotWebsite(e.target.value)}
                                            className="w-full h-11 px-3 rounded-xl border border-surface-200 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400 outline-none transition-all text-sm placeholder:text-surface-400 dark:placeholder:text-surface-500"
                                            placeholder="https://yourwebsite.com"
                                        />
                                    </div>
                                    <div className="flex gap-3 pt-2">
                                        <button
                                            type="button"
                                            onClick={closeCreateAndReturnToBot1}
                                            className="flex-1 py-2.5 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-600 text-surface-700 dark:text-surface-300 rounded-xl text-sm font-medium transition-colors hover:bg-surface-50 dark:hover:bg-surface-700"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={isSubmitting || !newBotName.trim()}
                                            className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white rounded-xl text-sm font-medium transition-colors flex justify-center items-center disabled:opacity-70"
                                        >
                                            {isSubmitting
                                                ? <Loader2 size={16} className="animate-spin" />
                                                : isFirstBot ? 'Create bot' : 'Continue'}
                                        </button>
                                    </div>
                                </form>
                            ) : (
                                <div className="space-y-4">
                                    {/* Monthly / Annual toggle */}
                                    <div className="flex items-center justify-center">
                                        <div className="inline-flex p-1 rounded-lg bg-surface-100 dark:bg-surface-800">
                                            {['monthly', 'annual'].map((cycle) => (
                                                <button
                                                    key={cycle}
                                                    type="button"
                                                    onClick={() => setBillingCycle(cycle)}
                                                    className={cn(
                                                        'px-4 py-1.5 rounded-md text-xs font-medium transition-colors',
                                                        billingCycle === cycle
                                                            ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-surface-100 shadow-sm'
                                                            : 'text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-300',
                                                    )}
                                                >
                                                    {cycle === 'monthly' ? 'Monthly' : 'Annual'}
                                                    {cycle === 'annual' && (
                                                        <span className="ml-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">Save 20%</span>
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Plan cards */}
                                    {paidPlans.length === 0 ? (
                                        <div className="py-6 flex justify-center text-surface-400">
                                            <Loader2 size={20} className="animate-spin" />
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {paidPlans.map((plan) => {
                                                const monthlyCents = billingCycle === 'annual'
                                                    ? Math.round((plan.annual_price_cents ?? plan.monthly_price_cents ?? 0) / 12)
                                                    : (plan.monthly_price_cents ?? 0);
                                                const symbol = plan.currency === 'INR' ? '₹' : '$';
                                                const isSelected = selectedPlanSlug === plan.slug;
                                                return (
                                                    <button
                                                        key={plan.slug}
                                                        type="button"
                                                        onClick={() => setSelectedPlanSlug(plan.slug)}
                                                        className={cn(
                                                            'w-full text-left p-3.5 rounded-xl border transition-all flex items-center justify-between gap-3',
                                                            isSelected
                                                                ? 'border-primary-500 bg-primary-50/40 dark:bg-primary-500/10'
                                                                : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600',
                                                        )}
                                                    >
                                                        <div>
                                                            <div className="text-sm font-semibold text-surface-900 dark:text-surface-100">{plan.name}</div>
                                                            <div className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                                                                {(plan.credits_per_month ?? 0).toLocaleString()} credits / month
                                                            </div>
                                                        </div>
                                                        <div className="text-right shrink-0">
                                                            <div className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                                                                {symbol}{(monthlyCents / 100).toFixed(0)}
                                                                <span className="text-xs font-normal text-surface-500 dark:text-surface-400">/mo</span>
                                                            </div>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}

                                    <p className="text-xs text-surface-500 dark:text-surface-400">
                                        Charged immediately. No free trial on additional bots.
                                    </p>

                                    <div className="flex gap-3 pt-1">
                                        <button
                                            type="button"
                                            onClick={() => { setCreateStep('details'); setError(''); }}
                                            disabled={isSubmitting}
                                            className="py-2.5 px-4 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-600 text-surface-700 dark:text-surface-300 rounded-xl text-sm font-medium transition-colors hover:bg-surface-50 dark:hover:bg-surface-700 disabled:opacity-60"
                                        >
                                            Back
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleSubscribeAndCreate}
                                            disabled={isSubmitting || !selectedPlan}
                                            className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white rounded-xl text-sm font-medium transition-colors flex justify-center items-center disabled:opacity-70"
                                        >
                                            {isSubmitting
                                                ? <Loader2 size={16} className="animate-spin" />
                                                : `Subscribe · ${planPriceLabel}`}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
