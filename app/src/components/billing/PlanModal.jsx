import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X, Check, Sparkles, Loader2, Crown, Zap,
    ShieldCheck, ExternalLink, Star, AlertCircle, Mail,
    Gift, CheckCircle2, XCircle, X as XSmall,
} from 'lucide-react';
import {
    getSubscriptionPlans, createCheckoutSession, changePlan,
    applyReferralCode, getBillingGeo, verifyRazorpaySubscription,
    startTrial,
} from '../../services/api';
import { openRazorpayCheckout } from '../../lib/razorpay';
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

// Override at build time via VITE_SALES_EMAIL when the sales address ever
// changes — same env-driven pattern as VITE_API_URL elsewhere in the app.
const SUPPORT_EMAIL = import.meta.env.VITE_SALES_EMAIL || 'support@oyechats.com';

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
    currentSubscriptionStatus = null,
    currentBillingCycle = 'monthly',
    hasActiveSubscription = false,
    // True only when the local subscription row is linked to a real Stripe
    // subscription (``subscription.payment_provider === 'stripe'``). Lets
    // the CTA distinguish a silent prorated swap from a Checkout redirect:
    // both look "active" on the surface, but only the Stripe-linked one
    // can change in place without a payment screen.
    hasStripeSubscription = false,
    onSuccess,
}) {
    const [plans, setPlans] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [billingCycle, setBillingCycle] = useState('monthly');
    const [selectedSlug, setSelectedSlug] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    // Geo / currency profile from /subscriptions/geo. Drives both the
    // displayed currency (INR for Indian customers, USD elsewhere) and the
    // CTA path (live Razorpay checkout vs. Contact Sales). Null while the
    // first fetch is in flight — components below fall back to plan-row
    // currency until it lands.
    const [geo, setGeo] = useState(null);

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
        Promise.all([getSubscriptionPlans(), getBillingGeo().catch(() => null)])
            .then(([rows, geoProfile]) => {
                if (cancelled) return;
                // Defensive sort — backend already sort_order ASC but never
                // trust the wire to be stable.
                const sorted = [...(rows || [])].sort(
                    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
                );
                setPlans(sorted);
                // Geo failure is non-fatal: we fall back to plan-row currency
                // and treat the CTA as available so the user can still try.
                setGeo(geoProfile);
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

    async function handleCta(actionKind = 'auto') {
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
            // Free path. With an active sub the backend schedules a Stripe
            // cancellation at period end; without one there's literally
            // nothing to do.
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

        // Trial-start path. When the user explicitly clicked "Upgrade"
        // (actionKind='paid') we deliberately skip the trial — that's the
        // whole point of the two-button shape. ``actionKind='auto'`` is the
        // legacy single-button code path: take the trial when eligible.
        const trialEligible = canStartTrial({
            plan: selected,
            isCurrent: selected.slug === currentPlanSlug,
            currentPlanSlug,
            currentSubscriptionStatus,
        });
        const takeTrialPath = actionKind === 'trial' || (actionKind === 'auto' && trialEligible);
        if (takeTrialPath) {
            setSubmitError('');
            setSubmitting(true);
            try {
                const trial = await startTrial(selected.slug);
                onSuccess?.({ kind: 'trial_started', plan: selected, trial });
                onClose();
            } catch (err) {
                // The backend's 409 ``already_trialed`` and 400
                // ``plan_not_trialable`` carry useful copy in
                // ``err.message`` — surface them straight to the user
                // rather than swallowing into a generic banner.
                setSubmitError(err?.message || 'Could not start your free trial.');
            } finally {
                setSubmitting(false);
            }
            return;
        }

        // Note: we no longer short-circuit to a mailto when geo signals
        // checkout isn't available. Every customer who reaches a paid plan
        // CTA goes through the real checkout — if the gateway truly can't
        // accept their card the backend returns a 4xx with a usable
        // message, which beats a "Contact sales" dead end every time.

        setSubmitError('');
        setSubmitting(true);
        try {
            // The /change-plan endpoint returns one of three statuses:
            //   * checkout_required → provider-specific payload (Razorpay
            //     subscription_id OR Stripe checkout_url)
            //   * switched          → silent prorated swap on existing sub
            //   * downgraded        → only happens for Free, handled above
            // First-time checkout flows go through /checkout directly; the
            // modal funnels everything else through /change-plan so the
            // backend can decide between an in-place swap and a fresh
            // payment-method capture per existing sub state.
            const res = hasActiveSubscription
                ? await changePlan(selected.id, billingCycle)
                : await createCheckoutSession(selected.id, billingCycle);

            const provider = String(res?.provider || '').toLowerCase();
            const status = String(res?.status || '').toLowerCase();

            // ── Razorpay path (default for all new sign-ups) ──
            // Returned payload: { subscription_id, key_id, name, description, prefill, theme }.
            if (provider === 'razorpay' && res?.subscription_id) {
                try {
                    const cb = await openRazorpayCheckout({
                        key: res.key_id,
                        subscription_id: res.subscription_id,
                        name: res.name,
                        description: res.description,
                        prefill: res.prefill,
                        theme: res.theme,
                        // Only the two methods we promise on the pricing page.
                        // Razorpay still shows them grouped under their own
                        // section headers; this just hides netbanking/wallets.
                        method: { card: true, upi: true },
                    });
                    // Server-side signature verification before treating
                    // the modal callback as trustworthy.
                    await verifyRazorpaySubscription({
                        razorpay_payment_id: cb.razorpay_payment_id,
                        razorpay_subscription_id: cb.razorpay_subscription_id || res.subscription_id,
                        razorpay_signature: cb.razorpay_signature,
                    });
                    onSuccess?.({
                        kind: hasActiveSubscription ? 'switched' : 'subscribed',
                        plan: selected,
                        response: { ...res, ...cb },
                        provider: 'razorpay',
                    });
                    onClose();
                    return;
                } catch (cbErr) {
                    // User-dismissed isn't an error to surface — they may
                    // come back to it. Anything else, we show as-is so the
                    // user sees the failure reason from Razorpay.
                    if (cbErr?.code === 'dismissed') {
                        return;
                    }
                    throw cbErr;
                }
            }

            // ── Stripe path (legacy — only existing Stripe subscribers) ──
            const checkoutUrl = res?.checkout_url;
            if (checkoutUrl || status === 'checkout_required') {
                if (!checkoutUrl || !isTrustedRedirectUrl(checkoutUrl)) {
                    throw new Error('Could not start checkout — invalid response.');
                }
                window.location.href = checkoutUrl;
                return;
            }

            if (status === 'switched') {
                onSuccess?.({ kind: 'switched', plan: selected, response: res });
                onClose();
                return;
            }

            if (status === 'downgraded') {
                onSuccess?.({ kind: 'downgraded', plan: selected, response: res });
                onClose();
                return;
            }

            // New paid→paid Razorpay downgrade path — the backend queues the
            // cutover at period end instead of swapping immediately. Surface
            // the effective date so the parent can render a "switching on X"
            // banner / toast.
            if (status === 'downgrade_scheduled') {
                onSuccess?.({
                    kind: 'downgrade_scheduled',
                    plan: selected,
                    response: res,
                    effectiveAt: res?.effective_at || null,
                });
                onClose();
                return;
            }

            throw new Error(res?.message || 'Unexpected response from server.');
        } catch (err) {
            const detail = err?.response?.data?.detail;
            // Backend returns 402 with {contact_sales} when intl payments
            // are off — turn that into the same mailto path the geo check
            // already takes, in case geo lookup raced or fell back to null.
            if (detail && typeof detail === 'object' && detail.code === 'intl_payments_unavailable') {
                const email = detail.contact_sales || geo?.contact_sales_email || SUPPORT_EMAIL;
                window.open(
                    `mailto:${email}?subject=${encodeURIComponent(
                        `Subscription enquiry — ${selected.name} (${billingCycle})`,
                    )}`,
                    '_blank',
                    'noopener,noreferrer',
                );
                return;
            }
            // Seat-overflow on a downgrade — the customer has more active
            // operators than the target plan allows. The backend's payload
            // includes ``active_seats`` / ``allowed_seats`` / ``excess`` so
            // we can render specific copy ("Deactivate 3 operators") instead
            // of a generic error.
            if (detail && typeof detail === 'object' && detail.code === 'seat_overflow') {
                const excess = detail.excess || (detail.active_seats - detail.allowed_seats);
                setSubmitError(
                    detail.message
                        || `You have ${detail.active_seats} active operator(s) but ${selected.name} only includes ${detail.allowed_seats}. Deactivate ${excess} operator(s) on the Team page before downgrading.`,
                );
                return;
            }
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
                                    we prorate the difference automatically. Pay with card or UPI.
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
                                                geo={geo}
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
                                                geo={geo}
                                                isCurrent={selected.slug === currentPlanSlug}
                                                currentPlanSlug={currentPlanSlug}
                                                currentSubscriptionStatus={currentSubscriptionStatus}
                                                hasActiveSubscription={hasActiveSubscription}
                                                hasStripeSubscription={hasStripeSubscription}
                                                currentPlan={plans.find((p) => p.slug === currentPlanSlug) || null}
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
                                Secure checkout · Cancel anytime · 14-day free trial on Starter plan.
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
        { value: 'annual',  label: 'Annual', save: 'Save 20%' },
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
function TierRailCard({ plan, billingCycle, geo, isSelected, isCurrent, isMostPopular, onSelect }) {
    const meta = TIER_META[plan.slug] || { icon: Sparkles, accent: 'slate', description: '' };
    const Icon = meta.icon;
    const accent = ACCENTS[meta.accent] || ACCENTS.slate;
    const priceLabel = renderPriceLabel(plan, billingCycle, geo, /*compact*/ true);
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
    plan, billingCycle, geo, isCurrent, currentPlanSlug, currentSubscriptionStatus,
    hasActiveSubscription, hasStripeSubscription, currentPlan,
    submitting, submitError, onCta, referral,
}) {
    const meta = TIER_META[plan.slug] || { icon: Sparkles, accent: 'slate', description: '' };
    const accent = ACCENTS[meta.accent] || ACCENTS.slate;
    const features = useMemo(() => buildFeatureList(plan, geo), [plan, geo]);
    const isFree = plan.slug === 'free';
    const isEnterprise = plan.slug === 'enterprise';
    // Detect transition direction so the paid-path CTA can be labelled
    // "Upgrade" vs "Downgrade" honestly. Free / Enterprise / new-customer
    // paths fall through with both flags false — the generic copy applies.
    const currentPrice = Number(currentPlan?.monthly_price_cents || 0);
    const targetPrice = Number(plan.monthly_price_cents || 0);
    const isUpgradeFromPaid = hasActiveSubscription && currentPrice > 0 && targetPrice > currentPrice;
    const isDowngradeFromPaid = hasActiveSubscription && currentPrice > 0 && targetPrice < currentPrice && targetPrice > 0;
    const ctas = ctasFor({
        plan, isCurrent, currentPlanSlug, currentSubscriptionStatus,
        hasActiveSubscription, hasStripeSubscription,
        isUpgradeFromPaid, isDowngradeFromPaid,
    });
    const primary = ctas[0];

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
            <PriceBlock
                plan={plan}
                billingCycle={billingCycle}
                geo={geo}
                discountPct={activeDiscount}
                appliedCode={referralEligible ? referral?.appliedCode : null}
            />

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

            {/* CTAs — usually one button; Starter / Standard with an
                eligible trial render two (trial + paid). The first CTA
                gets the accent style, secondaries get a ghost outline so
                the trial path stays the visual default without removing
                the upgrade option for power users. */}
            <div className="space-y-2">
                {ctas.map((cta, i) => {
                    const isSecondary = cta.variant === 'secondary';
                    const showIcon = !isSecondary && !isCurrent;
                    return (
                        <button
                            key={cta.kind}
                            type="button"
                            onClick={() => onCta(cta.kind)}
                            disabled={submitting || cta.kind === 'current' || cta.kind === 'noop'}
                            className={cn(
                                'w-full inline-flex items-center justify-center gap-2 h-12 rounded-xl font-semibold text-[14px] transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                                'disabled:opacity-60 disabled:cursor-not-allowed',
                                isSecondary
                                    ? 'border border-surface-200 dark:border-surface-700 bg-transparent text-surface-700 dark:text-surface-200 hover:bg-surface-50 dark:hover:bg-surface-800'
                                    : isCurrent
                                        ? 'bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-300 border border-surface-200 dark:border-surface-700'
                                        : accent.cta,
                            )}
                        >
                            {submitting && i === 0 ? (
                                <Loader2 size={16} className="animate-spin" />
                            ) : !showIcon ? null : isEnterprise ? (
                                <Mail size={16} />
                            ) : isFree ? null : (
                                <ExternalLink size={16} />
                            )}
                            {cta.label}
                        </button>
                    );
                })}
            </div>

            <p className="text-[11px] text-surface-500 dark:text-surface-400 leading-relaxed">
                {primary.note}
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

/**
 * Convert a plan-native amount (paise/INR or cents/USD) into the currency
 * the geo profile says we should display. Returns ``{ cents, currency, symbol }``.
 *
 * The conversion is one-way (INR → USD) because plan rows are always
 * INR-priced today. A plan that ever ships pre-priced in USD will pass
 * through unchanged — geo-display currency equals plan currency, no math.
 */
function toDisplayPrice(planCents, planCurrency, geo) {
    const safeCents = Number(planCents) || 0;
    const native = (planCurrency || 'INR').toUpperCase();
    const display = (geo?.display_currency || native).toUpperCase();
    if (!geo || display === native) {
        return {
            cents: safeCents,
            currency: native,
            symbol: native === 'USD' ? '$' : native === 'INR' ? '₹' : `${native} `,
        };
    }
    if (native === 'INR' && display === 'USD') {
        const rate = Number(geo.display_rate) || 83;
        // INR paise → USD cents: divide by rate (rupees per dollar), preserve
        // 2dp by rounding at the cent level rather than the dollar level.
        const usdCents = Math.round((safeCents / 100 / rate) * 100);
        return { cents: usdCents, currency: 'USD', symbol: '$' };
    }
    // Unknown conversion → fall back to native rather than mis-display.
    return {
        cents: safeCents,
        currency: native,
        symbol: native === 'USD' ? '$' : '₹',
    };
}

function PriceBlock({ plan, billingCycle, geo, discountPct = 0, appliedCode = null }) {
    // Plan rows are INR-native (paise in *_cents columns). For Indian
    // customers we render those directly; for everyone else we convert to
    // USD via the geo display rate. The actual charged currency at the
    // gateway is always INR — USD here is informational.
    const planCents = billingCycle === 'annual' ? plan.annual_price_cents : plan.monthly_price_cents;
    const { cents, symbol: sym } = toDisplayPrice(planCents, plan.currency || 'INR', geo);
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
                // Compute the savings in the same display currency the rest
                // of the block uses, so a US visitor never sees a ₹-prefixed
                // savings line right under a $-prefixed headline price.
                const monthly = toDisplayPrice(plan.monthly_price_cents, plan.currency || 'INR', geo).cents;
                const annual = toDisplayPrice(plan.annual_price_cents, plan.currency || 'INR', geo).cents;
                const saved = (monthly * 12 - annual) / 100;
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

/**
 * Trial-eligibility predicate.
 *
 * A customer can start a free trial of ``plan`` when:
 *   1. The plan offers one (``trial_days > 0``).
 *   2. They aren't already on this plan.
 *   3. They aren't *actively paying* for a different paid plan. Customers
 *      on Free (any status), trialing a different plan, or with no sub
 *      at all are eligible. Trial-to-trial swaps are explicitly supported
 *      by the backend so a prospect can evaluate Starter and Standard
 *      sequentially without paying — the lifetime one-trial-per-plan rule
 *      still prevents bouncing back and forth as a credit faucet.
 *
 * The backend also enforces "lifetime one trial per plan" (returns 409
 * ``already_trialed`` on repeat). We surface the CTA optimistically and
 * let ``handleCta`` show that message inline if it fires.
 */
function canStartTrial({ plan, isCurrent, currentPlanSlug, currentSubscriptionStatus }) {
    if (isCurrent) return false;
    const trialDays = Number(plan.trial_days || 0);
    if (trialDays <= 0) return false;
    // The only state that locks the trial path is "active on a paid plan"
    // — that's a real paying customer who must change tiers through the
    // upgrade flow, not restart a trial. Free-tier customers (active on
    // the ``free`` plan) and trialing customers can both start a trial of
    // a different paid plan; the backend has the final word on lifetime
    // one-per-plan.
    const onPaidPlan = currentPlanSlug && currentPlanSlug !== 'free';
    return !(currentSubscriptionStatus === 'active' && onPaidPlan);
}

/**
 * Build the CTA list for the focused plan card. Returns an array so cards
 * that legitimately offer two paths (e.g. Starter — try the trial OR pay
 * immediately) render both buttons stacked. ``kind`` drives the click
 * handler's branching; ``variant`` drives the button style (``primary`` is
 * the accent-coloured CTA, ``secondary`` is a ghost outline that lives
 * underneath).
 */
function ctasFor({
    plan, isCurrent, currentPlanSlug, currentSubscriptionStatus,
    hasActiveSubscription, hasStripeSubscription, isUpgradeFromPaid, isDowngradeFromPaid,
}) {
    if (isCurrent) {
        return [{
            kind: 'current',
            variant: 'primary',
            label: 'Current plan',
            note: 'You’re on this plan. To change billing cycle or cancel, use the billing portal on the Billing overview.',
        }];
    }
    if (plan.slug === 'enterprise') {
        return [{
            kind: 'enterprise',
            variant: 'primary',
            label: 'Contact sales',
            note: 'A sales engineer will reach out within one business day with a custom proposal.',
        }];
    }
    if (plan.slug === 'free') {
        if (hasActiveSubscription) {
            return [{
                kind: 'downgrade_free',
                variant: 'primary',
                label: 'Downgrade to Free',
                note: 'Your current subscription will end at the close of the current billing period. Existing top-up credits stay intact.',
            }];
        }
        return [{
            kind: 'noop',
            variant: 'primary',
            label: 'You’re on Free',
            note: 'Free tier is your default — no action required.',
        }];
    }

    // Compose the paid-path CTA first — its shape depends on whether the
    // customer already has a billable subscription (silent swap vs. fresh
    // checkout) and the direction of the transition (upgrade vs. downgrade).
    let paidLabel;
    let paidNote;
    if (isDowngradeFromPaid) {
        paidLabel = `Downgrade to ${plan.name}`;
        paidNote = 'You’ll keep your current plan until the end of this billing cycle, then switch to ' +
            `${plan.name}. We’ll email you the day before the change.`;
    } else if (hasStripeSubscription) {
        paidLabel = `Switch to ${plan.name}`;
        paidNote = 'We prorate the difference between your current and new plan automatically. Credits reset to the new monthly grant on the next renewal.';
    } else if (isUpgradeFromPaid) {
        paidLabel = `Upgrade to ${plan.name}`;
        paidNote = `A secure Razorpay checkout will open. We credit your unused ${currentPlanSlug ?? 'current plan'} time back as bonus credits the moment the new mandate activates.`;
    } else if (hasActiveSubscription) {
        paidLabel = `Upgrade to ${plan.name}`;
        paidNote = 'A secure Razorpay checkout will open to authorise your card or UPI. The new plan kicks in the moment the first payment clears.';
    } else {
        paidLabel = `Subscribe to ${plan.name}`;
        paidNote = 'A secure checkout will open to authorise your card or UPI. The new plan kicks in the moment the first payment clears.';
    }
    const paid = { kind: 'paid', variant: 'primary', label: paidLabel, note: paidNote };

    // Trial CTA. When a trial is available, we surface both buttons:
    // "Start your 14-day trial" (primary) AND the paid-path CTA (secondary
    // ghost) so the customer can skip the trial and go straight to paid
    // without losing the option. The trial doesn't collect a card so it's
    // strictly the lower-friction default and gets the accent button.
    if (canStartTrial({ plan, isCurrent, currentPlanSlug, currentSubscriptionStatus })) {
        const isSwap = currentSubscriptionStatus === 'trialing';
        const trialDays = Number(plan.trial_days || 14);
        const trial = {
            kind: 'trial',
            variant: 'primary',
            label: `Start your ${trialDays}-day trial`,
            note: isSwap
                ? `Switches your current trial to ${plan.name}. Your trial of ${currentPlanSlug ?? 'the previous plan'} ends immediately; the new ${trialDays} days start now. No card required.`
                : `${trialDays}-day free trial, no card required. Your bot goes live with the plan’s full credit allowance from day one.`,
        };
        return [trial, { ...paid, variant: 'secondary' }];
    }

    return [paid];
}

// Per-slug fallback crawl limits — mirror the latest alembic revision so
// the "Crawl up to N pages" bullet still renders correctly on environments
// where the migration hasn't been applied yet (or on hand-edited rows that
// don't have the JSONB keys). When the migration HAS run, ``plan.limits``
// is the source of truth and this constant is ignored.
//
// Latest values come from revision b8d2faf4c321, which raised page caps
// to align with credit budgets — see the migration's docstring for the
// reasoning. Depth stays per a7c1e9f3b210 since that's a workload
// protection, not a cost one.
const CRAWL_FALLBACK_BY_SLUG = {
    free:       { pages: 100,   depth: 3 },
    starter:    { pages: 600,   depth: 4 },
    standard:   { pages: 1500,  depth: 4 },
    enterprise: { pages: 10000, depth: 5 },
};

function buildFeatureList(plan, geo) {
    const out = [];
    const credits = plan.credits_per_month;
    const seats = plan.included_operator_seats || 0;
    const seatCents = plan.extra_seat_price_cents || 0;
    // Seat add-on price needs to follow the same display currency as the
    // headline plan price; pass through ``toDisplayPrice`` so an Indian
    // visitor sees ₹1,199/mo and a US visitor sees ~$14/mo on the same row.
    const seatDisplay = toDisplayPrice(seatCents, plan.currency || 'INR', geo);
    const sym = seatDisplay.symbol;

    // Plan-aware crawl limits — read from ``plan.limits`` first (source of
    // truth once the migration has run), then fall back to the per-slug
    // constants so the bullet renders on environments that haven't been
    // migrated yet. The bullet is one of the strongest upgrade signals on
    // this modal — never want it to silently disappear.
    const planLimits = plan.limits || {};
    const fallback = CRAWL_FALLBACK_BY_SLUG[plan.slug] || null;
    const maxCrawlPages = planLimits.max_crawl_pages ?? fallback?.pages;
    const maxCrawlDepth = planLimits.max_crawl_depth ?? fallback?.depth;

    if (plan.slug === 'enterprise') {
        out.push('Custom credit allocation');
        out.push('Unlimited operator seats');
        if (maxCrawlPages != null) {
            out.push(`Crawl up to ${maxCrawlPages.toLocaleString()} pages (depth ${maxCrawlDepth ?? 5})`);
        }
        out.push('BANT lead qualification scoring');
        out.push('Dedicated account manager');
        out.push('Custom SLA & uptime guarantee');
        out.push('SSO + audit logs');
        return out;
    }

    if (credits != null) {
        out.push(`${credits.toLocaleString()} credits / month`);
    }
    // Operator seats are a live-chat concept — surfacing them on Free (which
    // has no live chat) is misleading. Suppressed for that slug only; every
    // other tier keeps the seat line.
    if (seats > 0 && plan.slug !== 'free') {
        out.push(
            seatCents > 0
                ? `${seats} operator seat${seats === 1 ? '' : 's'} included (+${sym}${(seatDisplay.cents / 100).toFixed(0)}/mo each extra)`
                : `${seats} operator seat${seats === 1 ? '' : 's'} included`,
        );
    }
    if (maxCrawlPages != null) {
        out.push(
            `Crawl up to ${maxCrawlPages.toLocaleString()} pages` +
                (maxCrawlDepth != null ? ` (depth ${maxCrawlDepth})` : ''),
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
        if (plan.trial_days > 0) out.push(`${plan.trial_days}-day free trial`);
        out.push('Priority email support');
    } else if (plan.slug === 'standard') {
        if (plan.trial_days > 0) out.push(`${plan.trial_days}-day free trial`);
    }

    return out;
}

function renderPriceLabel(plan, billingCycle, geo, compact = false) {
    const planCents = billingCycle === 'annual' ? plan.annual_price_cents : plan.monthly_price_cents;
    const { cents, symbol: sym } = toDisplayPrice(planCents, plan.currency || 'INR', geo);
    if (plan.slug === 'enterprise') return 'Custom';
    if (!cents) return compact ? 'Free' : `${sym}0`;
    const major = cents / 100;
    const value = `${sym}${Number.isInteger(major) ? major.toLocaleString() : major.toFixed(2)}`;
    return compact ? value : `${value} / ${billingCycle === 'annual' ? 'yr' : 'mo'}`;
}
