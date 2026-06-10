import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X, Check, Sparkles, Loader2, Crown, Zap,
    ShieldCheck, ExternalLink, Star, AlertCircle, Mail,
    Gift, CheckCircle2, XCircle, X as XSmall,
} from 'lucide-react';
import {
    getSubscriptionPlans, createCheckoutSession, changePlan,
    applyReferralCode,
} from '../../services/api';
import { cn } from '../../lib/utils';

const TRUSTED_REDIRECT_DOMAINS = ['checkout.stripe.com', 'billing.stripe.com'];
function isTrustedRedirectUrl(url) {
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === 'https:' &&
            TRUSTED_REDIRECT_DOMAINS.some(
                (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d),
            )
        );
    } catch {
        return false;
    }
}

const SUPPORT_EMAIL = 'sales@oyechats.com';

// Slug → tier-card metadata. Kept here so the modal can render a fallback
// icon + ribbon even when the API row hasn't been seeded with one. The
// MOST_POPULAR_SLUG is highlighted in both the left rail and the right
// pane regardless of which tier the user is currently on.
const MOST_POPULAR_SLUG = 'standard';
const TIER_META = {
    free:       { icon: Sparkles, accent: 'slate',   description: 'Start exploring AI-powered chat' },
    starter:    { icon: Zap,      accent: 'sky',     description: 'For growing teams with live chat needs' },
    standard:   { icon: Crown,    accent: 'primary', description: 'Full AI + BANT sales intelligence' },
    enterprise: { icon: ShieldCheck, accent: 'violet', description: 'Custom credits, dedicated support' },
};

const ACCENTS = {
    slate: {
        rail:       'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600',
        railActive: 'border-surface-400 dark:border-surface-500 bg-surface-50 dark:bg-surface-800/60 shadow-sm',
        chip:       'bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-300',
        cta:        'bg-surface-900 dark:bg-white text-white dark:text-surface-900 hover:bg-surface-800 dark:hover:bg-surface-100',
    },
    sky: {
        rail:       'border-surface-200 dark:border-surface-700 hover:border-sky-300 dark:hover:border-sky-500/40',
        railActive: 'border-sky-400 dark:border-sky-500/60 bg-sky-50/70 dark:bg-sky-500/10 shadow-[0_0_0_3px_rgba(56,189,248,0.12)]',
        chip:       'bg-sky-100 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300',
        cta:        'bg-sky-600 hover:bg-sky-700 text-white',
    },
    primary: {
        rail:       'border-surface-200 dark:border-surface-700 hover:border-primary-300 dark:hover:border-primary-500/40',
        railActive: 'border-primary-500 dark:border-primary-500/70 bg-primary-50/70 dark:bg-primary-500/10 shadow-[0_0_0_3px_rgba(99,102,241,0.18)]',
        chip:       'bg-primary-100 dark:bg-primary-500/15 text-primary-700 dark:text-primary-300',
        cta:        'bg-primary-600 hover:bg-primary-700 text-white',
    },
    violet: {
        rail:       'border-surface-200 dark:border-surface-700 hover:border-violet-300 dark:hover:border-violet-500/40',
        railActive: 'border-violet-400 dark:border-violet-500/60 bg-violet-50/70 dark:bg-violet-500/10 shadow-[0_0_0_3px_rgba(168,85,247,0.14)]',
        chip:       'bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300',
        cta:        'bg-violet-600 hover:bg-violet-700 text-white',
    },
};

/**
 * Plan picker / upgrade modal — the centrepiece of the Billing → Plan & seats
 * tab. Renders a two-column layout: tier rail on the left, focus-pane on the
 * right with the selected plan's price, features, and a context-aware CTA.
 *
 * CTA behaviour decides itself from three signals:
 *   1. Is this the user's current active plan? → "Current plan" (disabled).
 *   2. Is the user on no paid sub yet?        → "Start free trial" /
 *                                                  "Get started" (free) /
 *                                                  "Contact sales" (enterprise)
 *      Hits POST /subscriptions/checkout → Stripe redirect.
 *   3. Already paying?                       → "Switch to <Plan>"
 *      Hits POST /subscriptions/change-plan (Stripe handles proration).
 *
 * Annual toggle persists in component state only — the prior selection on
 * close is discarded (intentional; re-opening from a clean slate prevents
 * "wait, I thought I was looking at monthly?" surprises).
 */
export default function PlanModal({
    open,
    onClose,
    currentPlanSlug,
    currentBillingCycle = 'monthly',
    hasActiveSubscription = false,
    onSuccess,
}) {
    const [plans, setPlans] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [billingCycle, setBillingCycle] = useState('monthly');
    const [selectedSlug, setSelectedSlug] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');

    // ── Referral discount state ──
    // ``referralStatus`` is a 4-state machine: idle (input empty / typing),
    // applying (round-trip in flight), applied (server confirmed it's a real
    // code), invalid (server rejected it). ``appliedCode`` / ``discountPct``
    // mirror the server response so the strikethrough always matches what
    // Stripe will actually charge after the user clicks the CTA.
    const [referralInput, setReferralInput] = useState('');
    const [referralStatus, setReferralStatus] = useState('idle');
    const [referralMessage, setReferralMessage] = useState('');
    const [appliedCode, setAppliedCode] = useState(null);
    const [discountPct, setDiscountPct] = useState(0);
    const referralInputRef = useRef(null);

    // ESC closes.
    useEffect(() => {
        if (!open) return undefined;
        const handler = (e) => {
            if (e.key === 'Escape' && !submitting) onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, submitting, onClose]);

    // Lazy-load the plan list whenever the modal opens. Reusing the
    // /subscriptions/plans payload — no separate "presentation plans"
    // endpoint, since the same rows feed checkout, change-plan, and
    // the marketing site.
    useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        setLoading(true);
        setLoadError('');
        setSubmitError('');
        setBillingCycle(currentBillingCycle || 'monthly');
        setSelectedSlug(currentPlanSlug || MOST_POPULAR_SLUG);
        // Reset referral state on every open so we don't flash a previous
        // session's chip while the new fetch resolves. Persisting it across
        // close/reopen would also be wrong semantically — the user might
        // intend a different code on a second pass.
        setReferralInput('');
        setReferralStatus('idle');
        setReferralMessage('');
        setAppliedCode(null);
        setDiscountPct(0);
        getSubscriptionPlans()
            .then((rows) => {
                if (cancelled) return;
                // Defensive sort — backend already sort_order ASC but never
                // trust the wire to be stable.
                const sorted = [...(rows || [])].sort(
                    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
                );
                setPlans(sorted);
            })
            .catch((err) => {
                if (!cancelled) setLoadError(err?.message || 'Failed to load plans.');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, currentPlanSlug, currentBillingCycle]);

    const selected = useMemo(
        () => plans.find((p) => p.slug === selectedSlug) || null,
        [plans, selectedSlug],
    );

    async function handleApplyReferral() {
        const code = referralInput.trim().toUpperCase();
        if (!code) return;
        setReferralStatus('applying');
        setReferralMessage('');
        try {
            const result = await applyReferralCode(code);
            // Backend returns ``code`` + ``discount_pct`` on every valid code,
            // even when the account had already been attributed previously
            // (idempotent re-entry). Null ``code`` means "invalid input".
            if (result.code) {
                setReferralStatus('applied');
                setReferralMessage(result.message);
                setAppliedCode(result.code);
                setDiscountPct(Number(result.discount_pct) || 0);
            } else {
                setReferralStatus('invalid');
                setReferralMessage(result.message);
                setAppliedCode(null);
                setDiscountPct(0);
            }
        } catch (err) {
            setReferralStatus('invalid');
            setReferralMessage(err?.message || 'Failed to apply referral code.');
            setAppliedCode(null);
            setDiscountPct(0);
        }
    }

    function handleClearReferral() {
        setReferralInput('');
        setReferralStatus('idle');
        setReferralMessage('');
        setAppliedCode(null);
        setDiscountPct(0);
        setTimeout(() => referralInputRef.current?.focus(), 40);
    }

    async function handleCta() {
        if (!selected) return;
        if (selected.slug === 'enterprise') {
            window.open(
                `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Enterprise plan inquiry')}`,
                '_blank',
                'noopener,noreferrer',
            );
            return;
        }
        if (selected.slug === 'free') {
            // The free tier doesn't pass through checkout — we just mark the
            // intent and close. If the customer is currently paying, this
            // route asks the backend to downgrade them; otherwise no-op.
            if (hasActiveSubscription) {
                setSubmitError('');
                setSubmitting(true);
                try {
                    await changePlan(selected.id, billingCycle);
                    onSuccess?.({ kind: 'downgraded', plan: selected });
                    onClose();
                } catch (err) {
                    setSubmitError(err?.message || 'Could not downgrade.');
                } finally {
                    setSubmitting(false);
                }
                return;
            }
            onClose();
            return;
        }

        setSubmitError('');
        setSubmitting(true);
        try {
            if (hasActiveSubscription) {
                // Existing subscriber switching tier — Stripe handles
                // proration in-place, no checkout redirect.
                const res = await changePlan(selected.id, billingCycle);
                onSuccess?.({ kind: 'switched', plan: selected, response: res });
                onClose();
                return;
            }
            const res = await createCheckoutSession(selected.id, billingCycle);
            const provider = String(res?.provider || '').toLowerCase();
            if (provider === 'stripe' || res?.checkout_url) {
                const url = res?.checkout_url;
                if (!url || !isTrustedRedirectUrl(url)) {
                    throw new Error('Could not start checkout — invalid response.');
                }
                window.location.href = url;
                return;
            }
            throw new Error(`Unsupported provider: ${provider || 'none'}`);
        } catch (err) {
            setSubmitError(err?.message || 'Could not start checkout.');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AnimatePresence>
            {open && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="plan-modal-title"
                >
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="absolute inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm"
                        onClick={() => !submitting && onClose()}
                    />
                    <motion.div
                        initial={{ opacity: 0, y: 16, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 16, scale: 0.97 }}
                        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                        className="relative w-full max-w-5xl max-h-[90vh] bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-800 flex flex-col overflow-hidden"
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between px-6 py-4 border-b border-surface-200 dark:border-surface-800 shrink-0">
                            <div className="min-w-0 pr-6">
                                <h2
                                    id="plan-modal-title"
                                    className="text-[18px] font-bold tracking-tight text-surface-900 dark:text-surface-50"
                                >
                                    Choose a plan
                                </h2>
                                <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-0.5">
                                    Every plan ships with the embeddable chat widget. Upgrade any time —
                                    Stripe prorates the difference automatically.
                                </p>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                                <CycleToggle value={billingCycle} onChange={setBillingCycle} disabled={submitting} />
                                <button
                                    type="button"
                                    onClick={() => !submitting && onClose()}
                                    aria-label="Close"
                                    disabled={submitting}
                                    className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300 disabled:opacity-50"
                                >
                                    <X size={18} />
                                </button>
                            </div>
                        </div>

                        {/* Body — two-pane on md+, stacked on mobile */}
                        <div className="flex-1 overflow-y-auto">
                            <div className="grid md:grid-cols-[280px_1fr] gap-0">
                                {/* Left rail — tier picker */}
                                <div className="p-4 md:p-5 md:border-r border-surface-200 dark:border-surface-800 space-y-3 bg-surface-50/60 dark:bg-surface-950/40">
                                    {loading && plans.length === 0 ? (
                                        Array.from({ length: 4 }).map((_, i) => (
                                            <div
                                                key={i}
                                                className="h-[88px] rounded-xl bg-surface-100 dark:bg-surface-800 animate-pulse"
                                            />
                                        ))
                                    ) : loadError ? (
                                        <div
                                            role="alert"
                                            className="flex items-start gap-2 px-3 py-3 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-[12px]"
                                        >
                                            <AlertCircle size={13} className="shrink-0 mt-0.5" />
                                            <span>{loadError}</span>
                                        </div>
                                    ) : (
                                        plans.map((p) => (
                                            <TierRailCard
                                                key={p.id}
                                                plan={p}
                                                billingCycle={billingCycle}
                                                isSelected={p.slug === selectedSlug}
                                                isCurrent={p.slug === currentPlanSlug}
                                                isMostPopular={p.slug === MOST_POPULAR_SLUG}
                                                onSelect={() => setSelectedSlug(p.slug)}
                                            />
                                        ))
                                    )}
                                </div>

                                {/* Right pane — focused plan.
                                    ``min-h`` reserves vertical space so the modal stops
                                    pumping up/down as the user clicks between plans with
                                    different feature counts. The number is sized to fit
                                    Standard (the busiest tier) without making Free look
                                    awkwardly tall — anything taller scrolls inside the
                                    outer body's ``overflow-y-auto`` instead. */}
                                <div className="p-5 md:p-7 md:min-h-[560px]">
                                    {selected ? (
                                        <motion.div
                                            // Keying by slug means the crossfade only fires
                                            // when the user actually picks a different tier;
                                            // changing the billing-cycle toggle no longer
                                            // teardown-and-remounts the whole right pane,
                                            // which removed the second source of jumpiness.
                                            key={selected.slug}
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={{ duration: 0.16, ease: 'easeOut' }}
                                        >
                                            <FocusedPlan
                                                plan={selected}
                                                billingCycle={billingCycle}
                                                isCurrent={selected.slug === currentPlanSlug}
                                                hasActiveSubscription={hasActiveSubscription}
                                                submitting={submitting}
                                                submitError={submitError}
                                                onCta={handleCta}
                                                referral={{
                                                    input: referralInput,
                                                    setInput: setReferralInput,
                                                    status: referralStatus,
                                                    setStatus: setReferralStatus,
                                                    setMessage: setReferralMessage,
                                                    message: referralMessage,
                                                    appliedCode,
                                                    discountPct,
                                                    inputRef: referralInputRef,
                                                    onApply: handleApplyReferral,
                                                    onClear: handleClearReferral,
                                                }}
                                            />
                                        </motion.div>
                                    ) : (
                                        <div className="text-sm text-surface-500 dark:text-surface-400">
                                            Select a plan on the left to see its details.
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-3 border-t border-surface-200 dark:border-surface-800 shrink-0 flex items-center justify-between text-[11px] text-surface-500 dark:text-surface-400">
                            <span className="flex items-center gap-1.5">
                                <ShieldCheck size={12} />
                                Secure checkout · Cancel anytime · 14-day free trial on paid plans
                            </span>
                            <span className="hidden sm:inline">
                                Need help? <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary-600 dark:text-primary-400 hover:underline">{SUPPORT_EMAIL}</a>
                            </span>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}

/** Monthly / Annual segmented control. */
function CycleToggle({ value, onChange, disabled }) {
    const opts = [
        { value: 'monthly', label: 'Monthly' },
        { value: 'annual',  label: 'Annual', save: 'Save 30%' },
    ];
    return (
        <div
            role="tablist"
            aria-label="Billing cycle"
            className="inline-flex items-center bg-surface-100 dark:bg-surface-800 rounded-lg p-0.5 text-[12px] font-medium"
        >
            {opts.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={value === o.value}
                    onClick={() => onChange(o.value)}
                    disabled={disabled}
                    className={cn(
                        'px-3 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5',
                        value === o.value
                            ? 'bg-white dark:bg-surface-900 text-surface-900 dark:text-surface-50 shadow-sm'
                            : 'text-surface-600 dark:text-surface-400 hover:text-surface-900 dark:hover:text-surface-200',
                    )}
                >
                    {o.label}
                    {o.save && value === o.value && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            {o.save}
                        </span>
                    )}
                </button>
            ))}
        </div>
    );
}

/** A single card in the left rail. */
function TierRailCard({ plan, billingCycle, isSelected, isCurrent, isMostPopular, onSelect }) {
    const meta = TIER_META[plan.slug] || { icon: Sparkles, accent: 'slate', description: '' };
    const Icon = meta.icon;
    const accent = ACCENTS[meta.accent] || ACCENTS.slate;
    const priceLabel = renderPriceLabel(plan, billingCycle, /*compact*/ true);
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={isSelected}
            className={cn(
                // Larger padding + min-height keeps every tier card the same
                // size regardless of description length — no more "Free" being
                // shorter than "Standard" in the rail.
                'relative w-full text-left rounded-xl border px-4 py-3.5 min-h-[88px]',
                'transition-colors duration-200 group',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                isSelected ? accent.railActive : accent.rail + ' bg-white dark:bg-surface-900',
            )}
        >
            {isMostPopular && (
                <span className="absolute -top-2 left-4 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-primary-600 text-white shadow-sm">
                    <Star size={9} fill="currentColor" />
                    Most popular
                </span>
            )}
            {/* Title row — icon + name + (optional) current chip + price */}
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                    <span className={cn(
                        'w-6 h-6 rounded-md flex items-center justify-center shrink-0',
                        accent.chip,
                    )}>
                        <Icon size={12} />
                    </span>
                    <span className="text-[13.5px] font-bold text-surface-900 dark:text-surface-50 truncate">
                        {plan.name}
                    </span>
                    {isCurrent && (
                        <span className={cn(
                            'inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0',
                            accent.chip,
                        )}>
                            <Check size={9} /> Current
                        </span>
                    )}
                </div>
                <span className="text-[12.5px] tabular-nums text-surface-700 dark:text-surface-300 font-semibold shrink-0">
                    {priceLabel}
                </span>
            </div>
            {/* Description on its own line for legibility */}
            <p className="mt-2 text-[11.5px] text-surface-500 dark:text-surface-400 leading-snug line-clamp-2">
                {plan.description || meta.description}
            </p>
        </button>
    );
}

/** The right-hand "focused plan" detail pane. */
function FocusedPlan({
    plan, billingCycle, isCurrent, hasActiveSubscription, submitting, submitError, onCta, referral,
}) {
    const meta = TIER_META[plan.slug] || { icon: Sparkles, accent: 'slate', description: '' };
    const accent = ACCENTS[meta.accent] || ACCENTS.slate;
    const features = useMemo(() => buildFeatureList(plan), [plan]);
    const isFree = plan.slug === 'free';
    const isEnterprise = plan.slug === 'enterprise';
    const cta = ctaFor({ plan, isCurrent, hasActiveSubscription });

    // Referral discount only applies to paid recurring plans. Free has no
    // price to discount; Enterprise is a custom-quote conversation.
    const referralEligible = !isFree && !isEnterprise;
    const activeDiscount = referralEligible && referral?.appliedCode ? referral.discountPct || 0 : 0;

    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-[20px] font-bold tracking-tight text-surface-900 dark:text-surface-50">
                    {plan.name}
                </h3>
                <p className="text-[13px] text-surface-600 dark:text-surface-300 mt-0.5">
                    {plan.description || meta.description}
                </p>
            </div>

            {/* Price */}
            <PriceBlock plan={plan} billingCycle={billingCycle} discountPct={activeDiscount} appliedCode={referralEligible ? referral?.appliedCode : null} />

            {/* Referral chip — paid plans only. */}
            {referralEligible && <ReferralBlock referral={referral} />}

            {/* Features */}
            <div className="space-y-2">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">
                    Features you’ll love
                </h4>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                    {features.map((f, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[13px] text-surface-700 dark:text-surface-200">
                            <Check size={13} className="text-emerald-500 dark:text-emerald-400 mt-0.5 shrink-0" />
                            <span>{f}</span>
                        </li>
                    ))}
                </ul>
            </div>

            {submitError && (
                <div
                    role="alert"
                    className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-[13px]"
                >
                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                    <span>{submitError}</span>
                </div>
            )}

            {/* CTA */}
            <button
                type="button"
                onClick={onCta}
                disabled={submitting || isCurrent}
                className={cn(
                    'w-full inline-flex items-center justify-center gap-2 h-12 rounded-xl font-semibold text-[14px] transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                    isCurrent
                        ? 'bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-300 border border-surface-200 dark:border-surface-700'
                        : accent.cta,
                )}
            >
                {submitting ? (
                    <Loader2 size={16} className="animate-spin" />
                ) : isEnterprise ? (
                    <Mail size={16} />
                ) : isFree ? null : (
                    <ExternalLink size={16} />
                )}
                {cta.label}
            </button>

            <p className="text-[11px] text-surface-500 dark:text-surface-400 leading-relaxed">
                {cta.note}
            </p>
        </div>
    );
}

/**
 * Inline referral-code input + applied-chip — only rendered for paid
 * recurring plans. Same UX language as the strikethrough/AnimatePresence
 * pattern from the old TopupModal, ported across to the subscription
 * surface where the discount actually fires.
 */
function ReferralBlock({ referral }) {
    if (!referral) return null;
    const {
        input, setInput, status, setStatus, setMessage, message,
        appliedCode, discountPct, inputRef, onApply, onClear,
    } = referral;
    const isApplied = status === 'applied' && appliedCode;

    return (
        <motion.div
            animate={
                isApplied
                    ? { borderColor: 'rgba(16, 185, 129, 0.6)', backgroundColor: 'rgba(16, 185, 129, 0.06)' }
                    : {}
            }
            transition={{ duration: 0.25 }}
            className="rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/50 p-3"
        >
            <p className="text-[11px] font-medium text-surface-600 dark:text-surface-300 mb-2 flex items-center gap-1.5">
                <Gift className={cn('w-3.5 h-3.5 transition-colors', isApplied ? 'text-emerald-500' : 'text-primary-500')} />
                {isApplied ? 'Referral code active' : 'Have a referral code?'}
            </p>

            <AnimatePresence mode="wait">
                {isApplied ? (
                    <motion.div
                        key="chip"
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 px-3 py-2"
                    >
                        <div className="flex items-center gap-2 min-w-0">
                            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            <p className="text-[12.5px] font-semibold text-emerald-700 dark:text-emerald-300 truncate">
                                <code className="font-mono tracking-wider">{appliedCode}</code> applied
                                {discountPct > 0 && (
                                    <span className="ml-1 font-bold">— {discountPct.toFixed(0)}% off every renewal</span>
                                )}
                                {discountPct === 0 && (
                                    <span className="ml-1 text-emerald-600/80 dark:text-emerald-400/80 font-normal">
                                        — thanks, your referrer is credited
                                    </span>
                                )}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={onClear}
                            className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 transition-colors"
                            aria-label="Remove referral code"
                            title="Remove referral code"
                        >
                            <XSmall className="w-3.5 h-3.5" />
                        </button>
                    </motion.div>
                ) : (
                    <motion.div
                        key="input"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="flex gap-2"
                    >
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={(e) => {
                                setInput(e.target.value.toUpperCase());
                                if (status !== 'idle') {
                                    setStatus('idle');
                                    setMessage('');
                                }
                            }}
                            onKeyDown={(e) => e.key === 'Enter' && onApply()}
                            placeholder="e.g. FRIEND20"
                            disabled={status === 'applying'}
                            maxLength={20}
                            className={cn(
                                'flex-1 rounded-lg border px-3 py-1.5 text-sm font-mono tracking-widest uppercase',
                                'bg-white dark:bg-surface-900 text-surface-900 dark:text-surface-50',
                                'placeholder:text-surface-400 dark:placeholder:text-surface-500 placeholder:font-sans placeholder:tracking-normal',
                                'focus:outline-none focus:ring-2 focus:ring-primary-500/40',
                                'disabled:opacity-60 disabled:cursor-not-allowed',
                                status === 'invalid'
                                    ? 'border-red-400 dark:border-red-500'
                                    : 'border-surface-300 dark:border-surface-600',
                            )}
                        />
                        <button
                            type="button"
                            onClick={onApply}
                            disabled={!input.trim() || status === 'applying'}
                            className={cn(
                                'shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                                'bg-primary-600 text-white hover:bg-primary-700',
                            )}
                        >
                            {status === 'applying' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply'}
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {status === 'invalid' && message && (
                    <motion.p
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.18 }}
                        className="mt-1.5 text-xs flex items-center gap-1 text-red-500 dark:text-red-400"
                    >
                        <XCircle className="w-3 h-3 shrink-0" />
                        {message}
                    </motion.p>
                )}
            </AnimatePresence>
        </motion.div>
    );
}

function PriceBlock({ plan, billingCycle, discountPct = 0, appliedCode = null }) {
    const cents = billingCycle === 'annual' ? plan.annual_price_cents : plan.monthly_price_cents;
    const currency = plan.currency || 'USD';
    const sym = currency === 'USD' ? '$' : currency === 'INR' ? '₹' : `${currency} `;
    if (plan.slug === 'enterprise') {
        return (
            <div>
                <span className="text-4xl font-bold tracking-tight text-surface-900 dark:text-surface-50">Custom</span>
                <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1">
                    Tailored credit allocation, dedicated account manager, SLA.
                </p>
            </div>
        );
    }
    if (!cents) {
        return (
            <div>
                <span className="text-4xl font-bold tracking-tight text-surface-900 dark:text-surface-50">{sym}0</span>
                <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1">
                    Forever. No card required.
                </p>
            </div>
        );
    }
    // Apply the discount in cents so the strikethrough matches what
    // Stripe actually charges (10% off $19 = $17.10, not $18 — done in
    // minor units to preserve sub-currency precision).
    const hasDiscount = discountPct > 0 && appliedCode;
    const bps = Math.max(0, Math.min(10_000, Math.round((discountPct || 0) * 100)));
    const chargedCents = hasDiscount ? cents - Math.floor((cents * bps) / 10_000) : cents;
    const major = cents / 100;
    const chargedMajor = chargedCents / 100;
    const monthlyEquiv = billingCycle === 'annual' && plan.monthly_price_cents > 0
        ? (chargedCents / 12) / 100
        : null;
    const fmt = (val) => `${sym}${Number.isInteger(val) ? val.toLocaleString() : val.toFixed(2)}`;
    return (
        <div className="space-y-1">
            <div className="flex items-baseline gap-2 flex-wrap">
                <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                        key={hasDiscount ? `d-${chargedCents}` : `f-${cents}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                        className={cn(
                            'text-4xl font-bold tracking-tight tabular-nums',
                            hasDiscount
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-surface-900 dark:text-surface-50',
                        )}
                    >
                        {fmt(chargedMajor)}
                    </motion.span>
                </AnimatePresence>
                <AnimatePresence>
                    {hasDiscount && (
                        <motion.span
                            key="strike"
                            initial={{ opacity: 0, x: -4 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -4 }}
                            transition={{ duration: 0.22, delay: 0.05 }}
                            className="text-lg font-medium line-through text-surface-400 dark:text-surface-500 tabular-nums"
                        >
                            {fmt(major)}
                        </motion.span>
                    )}
                </AnimatePresence>
                <span className="text-[13px] text-surface-500 dark:text-surface-400">
                    / {billingCycle === 'annual' ? 'year' : 'month'}
                </span>
                <AnimatePresence>
                    {hasDiscount && (
                        <motion.span
                            key="off-pill"
                            initial={{ opacity: 0, scale: 0.85 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.85 }}
                            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                            className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-emerald-500 text-white shadow-sm shadow-emerald-500/30"
                        >
                            <Sparkles className="w-2.5 h-2.5" />
                            {discountPct.toFixed(0)}% off
                        </motion.span>
                    )}
                </AnimatePresence>
            </div>
            {monthlyEquiv != null && (
                <p className="text-[12px] text-surface-500 dark:text-surface-400">
                    Equivalent to{' '}
                    <span className="font-semibold text-surface-700 dark:text-surface-300 tabular-nums">
                        {sym}{monthlyEquiv.toFixed(2)}
                    </span>{' '}
                    / month — save vs paying month-to-month.
                </p>
            )}
            {!hasDiscount && billingCycle === 'monthly' && plan.annual_price_cents > 0 && plan.monthly_price_cents > 0 && (() => {
                const saved = (plan.monthly_price_cents * 12 - plan.annual_price_cents) / 100;
                return saved > 0 ? (
                    <p className="text-[12px] text-emerald-600 dark:text-emerald-400">
                        Switch to annual and save <strong>{sym}{saved.toFixed(0)}/yr</strong>.
                    </p>
                ) : null;
            })()}
            {hasDiscount && (
                <p className="text-[12px] text-emerald-600 dark:text-emerald-400">
                    Saving{' '}
                    <strong>{sym}{((cents - chargedCents) / 100).toFixed(2)}/{billingCycle === 'annual' ? 'yr' : 'mo'}</strong>{' '}
                    with code <code className="font-mono font-bold uppercase">{appliedCode}</code>.
                </p>
            )}
        </div>
    );
}

function ctaFor({ plan, isCurrent, hasActiveSubscription }) {
    if (isCurrent) {
        return {
            label: 'Current plan',
            note: 'You’re on this plan. To change billing cycle or cancel, use the Stripe billing portal on the Billing overview.',
        };
    }
    if (plan.slug === 'enterprise') {
        return {
            label: 'Contact sales',
            note: 'A sales engineer will reach out within one business day with a custom proposal.',
        };
    }
    if (plan.slug === 'free') {
        if (hasActiveSubscription) {
            return {
                label: 'Downgrade to Free',
                note: 'Your current subscription will end at the close of the current billing period. Existing top-up credits stay intact.',
            };
        }
        return {
            label: 'You’re on Free',
            note: 'Free tier is your default — no action required.',
        };
    }
    if (hasActiveSubscription) {
        return {
            label: `Switch to ${plan.name}`,
            note: 'Stripe prorates the difference between your current and new plan automatically. Credits are reset to the new monthly grant on the next renewal.',
        };
    }
    return {
        label: `Start free trial — ${plan.name}`,
        note: `14-day free trial. Cancel any time before the trial ends and you won’t be charged.`,
    };
}

function buildFeatureList(plan) {
    const out = [];
    const credits = plan.credits_per_month;
    const seats = plan.included_operator_seats || 0;
    const seatCents = plan.extra_seat_price_cents || 0;
    const currency = plan.currency || 'USD';
    const sym = currency === 'USD' ? '$' : currency === 'INR' ? '₹' : `${currency} `;

    if (plan.slug === 'enterprise') {
        out.push('Custom credit allocation');
        out.push('Unlimited operator seats');
        out.push('BANT lead qualification scoring');
        out.push('Dedicated account manager');
        out.push('Custom SLA & uptime guarantee');
        out.push('SSO + audit logs');
        return out;
    }

    if (credits != null) {
        out.push(`${credits.toLocaleString()} credits / month`);
    }
    if (seats > 0) {
        out.push(
            seatCents > 0
                ? `${seats} operator seat${seats === 1 ? '' : 's'} included (+${sym}${seatCents / 100}/mo each extra)`
                : `${seats} operator seat${seats === 1 ? '' : 's'} included`,
        );
    }

    const features = plan.features || {};
    if (features.live_chat) out.push('Live chat enabled');
    if (features.bant)      out.push('BANT lead qualification scoring');
    if (features.bant)      out.push('Behavioral tracking & UTM capture');
    if (features.live_chat) out.push('Webhooks (5 event types)');

    if (plan.slug === 'free') {
        // Marketing-site-aligned bullets so the free tier doesn't feel empty.
        out.push('1 chatbot');
        out.push('Basic widget customization');
        out.push('Lead capture forms');
    } else if (plan.slug === 'starter') {
        out.push('Up to 3 chatbots');
        if (plan.trial_days > 0) out.push(`${plan.trial_days}-day free trial`);
        out.push('Priority email support');
    } else if (plan.slug === 'standard') {
        out.push('Unlimited chatbots');
        if (plan.trial_days > 0) out.push(`${plan.trial_days}-day free trial`);
    }

    return out;
}

function renderPriceLabel(plan, billingCycle, compact = false) {
    const cents = billingCycle === 'annual' ? plan.annual_price_cents : plan.monthly_price_cents;
    const currency = plan.currency || 'USD';
    const sym = currency === 'USD' ? '$' : currency === 'INR' ? '₹' : `${currency} `;
    if (plan.slug === 'enterprise') return 'Custom';
    if (!cents) return compact ? 'Free' : `${sym}0`;
    const major = cents / 100;
    const value = `${sym}${Number.isInteger(major) ? major.toLocaleString() : major.toFixed(2)}`;
    return compact ? value : `${value} / ${billingCycle === 'annual' ? 'yr' : 'mo'}`;
}
