import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, AlertCircle, Check } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import {
    createBot,
    crawlWebsite,
    getSubscriptionPlans,
    createBotCheckout,
    verifyBotCheckout,
} from '../../services/api';
import { openRazorpayCheckout } from '../../lib/razorpay';
import { cn, normalizeUrl } from '../../lib/utils';
import { useBotPricing } from './useBotPricing';

/**
 * Create-bot wizard modal. Self-adapts based on `isFirstBot`:
 *   - First bot → one-screen Free path (no payment; skips the plan step).
 *   - 2nd+ bot → two-step wizard: details → plan picker + Razorpay checkout.
 *
 * Owns its own step/checkout state. Prices render in USD via the geo display
 * rule (useBotPricing). On success it calls `onCreated(botId)` so the shell can
 * refresh the list and open the InstallDrawer for the new bot. A dismissed
 * Razorpay modal is treated as an abandon → `onClose()`.
 *
 * Props: { open, isFirstBot, onClose, onCreated }
 */
export default function CreateBotWizard({ open, isFirstBot, onClose, onCreated }) {
    const { showToast } = useToast();
    const { price } = useBotPricing();

    const [newBotName, setNewBotName] = useState('');
    const [newBotWebsite, setNewBotWebsite] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [createStep, setCreateStep] = useState('details');
    const [billingCycle, setBillingCycle] = useState('monthly');
    const [selectedPlanSlug, setSelectedPlanSlug] = useState('starter');
    const [paidPlans, setPaidPlans] = useState([]);

    const nameInputRef = useRef(null);
    const panelRef = useRef(null);
    const triggerRef = useRef(null);

    // Esc-to-close + Tab focus-trap + body scroll-lock + focus management while
    // open. Focus the bot-name field on open; restore focus to the trigger on
    // close.
    useEffect(() => {
        if (!open) return undefined;
        triggerRef.current = document.activeElement;
        const onKey = (e) => {
            if (e.key === 'Escape') {
                onClose();
                return;
            }
            if (e.key !== 'Tab') return;
            const panel = panelRef.current;
            if (!panel) return;
            const focusable = panel.querySelectorAll(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            );
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const focusTimer = setTimeout(() => nameInputRef.current?.focus(), 40);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
            clearTimeout(focusTimer);
            if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
        };
    }, [open, onClose]);

    // Pre-load the active paid plans the first time the plan step is needed so
    // the pricing cards render without a flash. Silent-fails to an empty list.
    useEffect(() => {
        if (!open || isFirstBot || paidPlans.length > 0) return;
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
    }, [open, isFirstBot]);

    if (!open) return null; // lazy content: nothing mounted when closed

    const selectedPlan = paidPlans.find((p) => p.slug === selectedPlanSlug) || null;
    const { cents: planPriceCents, symbol: planCurrencySymbol } = price(selectedPlan, billingCycle);
    const planPriceLabel = `${planCurrencySymbol}${(planPriceCents / 100).toFixed(0)}/mo`;
    const nameValid = newBotName.trim().length > 0;

    const resetAndClose = () => {
        setCreateStep('details');
        setError('');
        setNewBotName('');
        setNewBotWebsite('');
        setBillingCycle('monthly');
        onClose();
    };

    const handleContinueToPricing = (e) => {
        e.preventDefault();
        if (!nameValid) return;
        setError('');
        if (isFirstBot) {
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
            showToast('success', `Bot "${result.name}" created!`);
            onCreated?.(result.bot_id);
        } catch (err) {
            // Edge case — Free path should never 402 (bot count was 0 when the
            // modal opened) but handle defensively if a sibling tab raced.
            if (err?.status === 402 && err?.data?.detail?.must_subscribe) {
                setCreateStep('plan');
                return;
            }
            setError(err.message || 'Failed to create bot');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleSubscribeAndCreate = async () => {
        if (!nameValid || !selectedPlan) return;
        const normalizedWebsite = normalizeUrl(newBotWebsite);
        setError('');
        setIsSubmitting(true);
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
            const newBotId = verifyResult?.bot_id;
            if (normalizedWebsite && newBotId) {
                crawlWebsite(normalizedWebsite, newBotId).catch((err) => {
                    console.error('Background website crawl failed:', err);
                });
            }
            showToast('success', `Bot "${newBotName.trim()}" created and subscribed!`);
            onCreated?.(newBotId);
        } catch (err) {
            // Razorpay modal dismissed — treat as abandon and close the wizard.
            if (err?.code === 'dismissed') {
                resetAndClose();
                return;
            }
            setError(err.message || 'Could not complete bot subscription. Try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 dark:bg-black/60 backdrop-blur-sm animate-fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-bot-title"
            onMouseDown={(e) => { if (e.target === e.currentTarget) resetAndClose(); }}
        >
            <div ref={panelRef} className="bg-white dark:bg-surface-900 rounded-2xl shadow-xl w-full max-w-md border border-surface-200 dark:border-surface-700 overflow-hidden animate-scale-in">
                <div className="p-6">
                    <div className="flex items-center gap-3 mb-5">
                        <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
                            <Bot size={20} className="text-primary-600 dark:text-primary-400" />
                        </div>
                        <div>
                            <h2 id="create-bot-title" className="text-base font-semibold text-surface-900 dark:text-surface-100">
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

                    {/* Step indicator (2nd+ bot only — the free path is one screen) */}
                    {!isFirstBot && (
                        <div className="flex items-center gap-2 mb-5" aria-hidden="true">
                            {['details', 'plan'].map((step, idx) => {
                                const isCurrent = createStep === step;
                                const isDone = step === 'details' && createStep === 'plan';
                                return (
                                    <div key={step} className="flex items-center gap-2 flex-1">
                                        <span
                                            className={cn(
                                                'flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold transition-colors',
                                                isDone
                                                    ? 'bg-primary-600 text-white'
                                                    : isCurrent
                                                        ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300 ring-1 ring-primary-400 dark:ring-primary-500'
                                                        : 'bg-surface-100 dark:bg-surface-800 text-surface-400 dark:text-surface-500',
                                            )}
                                        >
                                            {isDone ? <Check size={11} /> : idx + 1}
                                        </span>
                                        <div className={cn(
                                            'h-0.5 flex-1 rounded-full transition-colors',
                                            createStep === 'plan' && step === 'details'
                                                ? 'bg-primary-500'
                                                : 'bg-surface-100 dark:bg-surface-800',
                                        )}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {error && (
                        <div className="mb-4 p-3 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 text-sm rounded-xl border border-rose-500/20 dark:border-rose-500/30 flex items-center gap-2">
                            <AlertCircle size={14} />{error}
                        </div>
                    )}

                    {createStep === 'details' ? (
                        <form onSubmit={handleContinueToPricing} className="space-y-4">
                            <div>
                                <label htmlFor="create-bot-name" className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                                    Bot name <span className="text-rose-500">*</span>
                                </label>
                                <input
                                    id="create-bot-name"
                                    ref={nameInputRef}
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
                                <label htmlFor="create-bot-website" className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                                    Website <span className="text-xs font-normal text-surface-400">(optional)</span>
                                </label>
                                <input
                                    id="create-bot-website"
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
                                    onClick={resetAndClose}
                                    className="flex-1 py-2.5 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-600 text-surface-700 dark:text-surface-300 rounded-xl text-sm font-medium transition-colors hover:bg-surface-50 dark:hover:bg-surface-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={isSubmitting || !nameValid}
                                    className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white rounded-xl text-sm font-medium transition-colors flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
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
                                                'px-4 py-1.5 rounded-md text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50',
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
                                        const { cents: monthlyCents, symbol } = price(plan, billingCycle);
                                        const isSelected = selectedPlanSlug === plan.slug;
                                        return (
                                            <button
                                                key={plan.slug}
                                                type="button"
                                                aria-pressed={isSelected}
                                                onClick={() => setSelectedPlanSlug(plan.slug)}
                                                className={cn(
                                                    'w-full text-left p-3.5 rounded-xl border transition-all flex items-center justify-between gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50',
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
                                    className="py-2.5 px-4 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-600 text-surface-700 dark:text-surface-300 rounded-xl text-sm font-medium transition-colors hover:bg-surface-50 dark:hover:bg-surface-700 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
                                >
                                    Back
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSubscribeAndCreate}
                                    disabled={isSubmitting || !selectedPlan}
                                    className="flex-1 py-2.5 bg-primary-600 hover:bg-primary-700 dark:hover:bg-primary-500 text-white rounded-xl text-sm font-medium transition-colors flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50"
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
    );
}
