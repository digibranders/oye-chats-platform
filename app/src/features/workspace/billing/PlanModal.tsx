import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Crown,
  ExternalLink,
  Gift,
  Loader2,
  Mail,
  ShieldCheck,
  Sparkles,
  Star,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Button, Modal, StatusBadge, cn } from '../../../design-system';
import { useCurrency } from '../../../context/CurrencyContext';
import { trialDaysLeft, formatTrialDate, daysUntil } from '../../../utils/trial';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import {
  getSubscriptionPlans,
  getBillingGeo,
  getReferralStatus,
  applyReferralCode,
  startTrial,
  changePlan,
  createCheckoutSession,
  verifyRazorpaySubscription,
} from '../../../services/api';
import {
  buildFeatureList,
  canStartTrial,
  ctasFor,
  renderPriceLabel,
  resolveDisplayCents,
  MOST_POPULAR_SLUG,
  TIER_META,
  type BillingCycle,
  type Geo,
  type PlanRow,
} from './planMath';

const SUPPORT_EMAIL = (import.meta.env.VITE_SALES_EMAIL as string | undefined) || 'support@oyechats.com';

const TIER_ICON: Record<string, LucideIcon> = {
  free: Sparkles,
  starter: Zap,
  standard: Crown,
  enterprise: ShieldCheck,
};

type ReferralStatus = 'idle' | 'applying' | 'applied' | 'invalid';

export interface PlanModalProps {
  open: boolean;
  onClose: () => void;
  currentPlanSlug: string | null;
  currentSubscriptionStatus?: string | null;
  currentBillingCycle?: BillingCycle;
  hasActiveSubscription?: boolean;
  trialEndIso?: string | null;
  dataRetentionUntilIso?: string | null;
  /** Plan slug to focus on open (e.g. a comparison card the user clicked). */
  initialSlug?: string | null;
  /** Fired after a successful mutation with a human-readable status message. */
  onSuccess?: (message: string) => void;
}

/**
 * PlanModal — the redesigned plan picker / upgrade dialog. Two-pane layout
 * (tier rail + focused plan) inside the DS Modal. The money-path logic
 * (checkout, change-plan, trial, referral, Razorpay verify) is ported verbatim
 * from the legacy `components/billing/PlanModal.jsx`; only the presentation is
 * rebuilt in the design system. All prices show in the account's charge currency.
 */
export function PlanModal({
  open,
  onClose,
  currentPlanSlug,
  currentSubscriptionStatus = null,
  currentBillingCycle = 'monthly',
  hasActiveSubscription = false,
  trialEndIso = null,
  dataRetentionUntilIso = null,
  initialSlug = null,
  onSuccess,
}: PlanModalProps): ReactElement | null {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitNotice, setSubmitNotice] = useState('');
  const [geo, setGeo] = useState<Geo | null>(null);

  const [referralInput, setReferralInput] = useState('');
  const [referralStatus, setReferralStatus] = useState<ReferralStatus>('idle');
  const [referralMessage, setReferralMessage] = useState('');
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [discountPct, setDiscountPct] = useState(0);
  const referralInputRef = useRef<HTMLInputElement>(null);

  const { country: acctCountry, currency: acctCurrency } = useCurrency();
  const effectiveCountry = acctCountry || geo?.country || null;
  const effGeo = useMemo<Geo | null>(
    () =>
      geo
        ? { ...geo, country: effectiveCountry, display_currency: (acctCurrency || 'usd').toUpperCase() }
        : geo,
    [geo, effectiveCountry, acctCurrency],
  );

  // Lazy-load plans + geo + standing referral whenever the modal opens.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setSubmitError('');
    setSubmitNotice('');
    setBillingCycle(currentBillingCycle || 'monthly');
    setSelectedSlug(initialSlug || currentPlanSlug || MOST_POPULAR_SLUG);
    setReferralInput('');
    setReferralStatus('idle');
    setReferralMessage('');
    setAppliedCode(null);
    setDiscountPct(0);

    // Standing attribution is optional — a flaky /referrals/status must never
    // become an unhandled rejection (the modal works fine without it).
    getReferralStatus()
      .then((rs) => {
        if (cancelled || !rs?.attributed) return;
        setReferralStatus('applied');
        setAppliedCode(rs.code ?? null);
        setDiscountPct(Number(rs.discount_pct) || 0);
      })
      .catch(() => {
        /* no standing referral / endpoint unavailable — ignore */
      });

    Promise.all([getSubscriptionPlans(), getBillingGeo().catch(() => null)])
      .then(([rows, geoProfile]) => {
        if (cancelled) return;
        const sorted = [...((rows as unknown as PlanRow[]) || [])].sort(
          (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
        );
        setPlans(sorted);
        setGeo((geoProfile as Geo | null) ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load plans.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentPlanSlug, currentBillingCycle, initialSlug]);

  const selected = useMemo(
    () => plans.find((p) => p.slug === selectedSlug) || null,
    [plans, selectedSlug],
  );

  async function handleApplyReferral(): Promise<void> {
    const code = referralInput.trim().toUpperCase();
    if (!code) return;
    setReferralStatus('applying');
    setReferralMessage('');
    try {
      const result = await applyReferralCode(code);
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
    } catch (err: unknown) {
      setReferralStatus('invalid');
      setReferralMessage(err instanceof Error ? err.message : 'Failed to apply referral code.');
      setAppliedCode(null);
      setDiscountPct(0);
    }
  }

  async function handleCta(actionKind: string = 'auto'): Promise<void> {
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
      if (hasActiveSubscription) {
        setSubmitError('');
        setSubmitNotice('');
        setSubmitting(true);
        try {
          await changePlan(selected.id, billingCycle);
          onSuccess?.(`You’ll move to Free at the end of your current billing period.`);
          onClose();
        } catch (err: unknown) {
          setSubmitError(err instanceof Error ? err.message : 'Could not downgrade.');
        } finally {
          setSubmitting(false);
        }
        return;
      }
      onClose();
      return;
    }

    const trialEligible = canStartTrial({
      plan: selected,
      isCurrent: selected.slug === currentPlanSlug,
      currentPlanSlug,
      currentSubscriptionStatus,
    });
    const takeTrialPath = actionKind === 'trial' || (actionKind === 'auto' && trialEligible);
    if (takeTrialPath) {
      setSubmitError('');
      setSubmitNotice('');
      setSubmitting(true);
      try {
        await startTrial(selected.slug);
        onSuccess?.(`Your ${selected.trial_days || 7}-day ${selected.name} trial has started.`);
        onClose();
      } catch (err: unknown) {
        setSubmitError(err instanceof Error ? err.message : 'Could not start your free trial.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setSubmitError('');
    setSubmitting(true);
    try {
      const res = (hasActiveSubscription
        ? await changePlan(selected.id, billingCycle)
        : await createCheckoutSession(selected.id, billingCycle, effectiveCountry)) as Record<
        string,
        unknown
      >;

      const provider = String(res?.provider || '').toLowerCase();
      const status = String(res?.status || '').toLowerCase();

      if (provider === 'razorpay' && res?.subscription_id) {
        if (!res.key_id) {
          setSubmitError('Checkout is temporarily unavailable. Please try again in a moment.');
          return;
        }
        // Stage 1 — the charge/authorisation. A throw here means the payment did
        // NOT go through (dismissed, card declined); safe to surface as an error.
        let cb: Awaited<ReturnType<typeof openRazorpayCheckout>>;
        try {
          cb = await openRazorpayCheckout({
            key: String(res.key_id),
            subscription_id: String(res.subscription_id),
            name: res.name as string | undefined,
            description: res.description as string | undefined,
            prefill: res.prefill as Record<string, unknown> | undefined,
            theme: res.theme as Record<string, unknown> | undefined,
            method: { card: true, upi: true },
          });
        } catch (cbErr: unknown) {
          if ((cbErr as { code?: string })?.code === 'dismissed') {
            setSubmitNotice('Payment cancelled — you have not been charged.');
            return;
          }
          throw cbErr;
        }

        // Stage 2 — server-side signature verification. The customer has ALREADY
        // been charged by this point, so a failure here must NOT read as a
        // payment error. The activation webhook is the authoritative reconciler;
        // reassure and let the reloaded page reflect the new plan once it lands.
        try {
          await verifyRazorpaySubscription({
            razorpay_payment_id: cb.razorpay_payment_id,
            razorpay_subscription_id: cb.razorpay_subscription_id || String(res.subscription_id),
            razorpay_signature: cb.razorpay_signature,
          });
        } catch {
          setSubmitNotice(
            'Payment received — we’re finalising your subscription. It’ll activate within a minute; if not, contact support.',
          );
          onSuccess?.('Payment received — finalising your subscription.');
          onClose();
          return;
        }

        onSuccess?.(
          hasActiveSubscription
            ? `Your plan changed to ${selected.name}.`
            : `You’re now subscribed to ${selected.name}.`,
        );
        onClose();
        return;
      }

      if (status === 'switched') {
        onSuccess?.(`Your plan changed to ${selected.name}.`);
        onClose();
        return;
      }
      if (status === 'downgraded') {
        onSuccess?.(`You’ll move to ${selected.name} at the end of your billing period.`);
        onClose();
        return;
      }
      if (status === 'downgrade_scheduled') {
        const effectiveAt = res?.effective_at ? formatTrialDate(String(res.effective_at)) : null;
        onSuccess?.(
          `Downgrade to ${selected.name} scheduled${effectiveAt ? ` for ${effectiveAt}` : ''}.`,
        );
        onClose();
        return;
      }

      throw new Error((res?.message as string) || 'Unexpected response from server.');
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: unknown } }; detail?: unknown })?.response?.data
          ?.detail ?? (err as { detail?: unknown })?.detail;

      if (detail && typeof detail === 'object' && (detail as { reason?: string }).reason === 'intl_usd_pending') {
        setSubmitNotice(
          (detail as { message?: string }).message ||
            'USD billing for international customers is coming soon. Please contact sales.',
        );
        return;
      }
      if (detail && typeof detail === 'object' && (detail as { code?: string }).code === 'seat_overflow') {
        const d = detail as { message?: string; excess?: number; active_seats?: number; allowed_seats?: number };
        const excess = d.excess || (Number(d.active_seats) - Number(d.allowed_seats));
        setSubmitError(
          d.message ||
            `You have ${d.active_seats} active operator(s) but ${selected.name} only includes ${d.allowed_seats}. Deactivate ${excess} operator(s) on the Members page before downgrading.`,
        );
        return;
      }
      setSubmitError(err instanceof Error ? err.message : 'Could not start checkout.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!submitting}
      size="xl"
      hideHeader
      title="Choose a plan"
      className="p-0"
    >
      {/* Header (custom, so the cycle toggle can live inline) */}
      <div className="-mx-6 -mt-5 mb-5 flex items-start justify-between gap-4 border-b border-[var(--ds-border)] px-6 pb-4 pt-1">
        <div className="min-w-0 pr-4">
          <h2 className="text-[17px] font-semibold text-[var(--ds-text)]">Choose a plan</h2>
          <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">
            Every plan ships with the embeddable chat widget. Upgrade any time — we prorate the
            difference automatically. Pay with card or UPI.
          </p>
        </div>
        <CycleToggle value={billingCycle} onChange={setBillingCycle} disabled={submitting} />
      </div>

      <div className="-mx-6 -mb-5 grid gap-0 md:grid-cols-[260px_1fr]">
        {/* Left rail */}
        <div className="space-y-3 border-b border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4 md:border-b-0 md:border-r">
          {loading && plans.length === 0 ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[84px] animate-pulse rounded-xl bg-[var(--ds-bg-hover)]" />
            ))
          ) : loadError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-3 text-[12px] text-[var(--ds-danger)]"
            >
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{loadError}</span>
            </div>
          ) : (
            plans.map((p) => (
              <TierRailCard
                key={p.id}
                plan={p}
                billingCycle={billingCycle}
                geo={effGeo}
                isSelected={p.slug === selectedSlug}
                isCurrent={p.slug === currentPlanSlug}
                isMostPopular={p.slug === MOST_POPULAR_SLUG}
                onSelect={() => setSelectedSlug(p.slug)}
              />
            ))
          )}
        </div>

        {/* Right pane */}
        <div className="min-h-[520px] p-5 md:p-6">
          {selected ? (
            <FocusedPlan
              plan={selected}
              billingCycle={billingCycle}
              geo={effGeo}
              currentPlanSlug={currentPlanSlug}
              currentSubscriptionStatus={currentSubscriptionStatus}
              hasActiveSubscription={hasActiveSubscription}
              trialEndIso={trialEndIso}
              dataRetentionUntilIso={dataRetentionUntilIso}
              currentPlan={plans.find((p) => p.slug === currentPlanSlug) || null}
              submitting={submitting}
              submitError={submitError}
              submitNotice={submitNotice}
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
              }}
            />
          ) : (
            <p className="text-[13px] text-[var(--ds-text-muted)]">
              Select a plan on the left to see its details.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Cycle toggle ──────────────────────────────────────────────────────────────

function CycleToggle({
  value,
  onChange,
  disabled,
}: {
  value: BillingCycle;
  onChange: (v: BillingCycle) => void;
  disabled?: boolean;
}): ReactElement {
  const opts: { value: BillingCycle; label: string; save?: string }[] = [
    { value: 'monthly', label: 'Monthly' },
    { value: 'annual', label: 'Annual', save: 'Save 20%' },
  ];
  return (
    <div
      role="tablist"
      aria-label="Billing cycle"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--ds-bg-sunken)] p-0.5 text-[12px] font-medium"
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
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50',
            value === o.value
              ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
              : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
          )}
        >
          {o.label}
          {o.save && value === o.value && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--ds-success)]">
              {o.save}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Tier rail card ────────────────────────────────────────────────────────────

function TierRailCard({
  plan,
  billingCycle,
  geo,
  isSelected,
  isCurrent,
  isMostPopular,
  onSelect,
}: {
  plan: PlanRow;
  billingCycle: BillingCycle;
  geo: Geo | null;
  isSelected: boolean;
  isCurrent: boolean;
  isMostPopular: boolean;
  onSelect: () => void;
}): ReactElement {
  const Icon = TIER_ICON[plan.slug] || Sparkles;
  const priceLabel = renderPriceLabel(plan, billingCycle, geo, true);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className={cn(
        'relative w-full min-h-[84px] rounded-xl border px-4 py-3.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]',
        isSelected
          ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] shadow-[var(--ds-shadow-sm)]'
          : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] hover:border-[var(--ds-border-strong,var(--ds-text-subtle))]',
      )}
    >
      {isMostPopular && (
        <span className="absolute -top-2 left-4 inline-flex items-center gap-1 rounded-md bg-[var(--ds-accent)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--ds-accent-fg)] shadow-[var(--ds-shadow-sm)]">
          <Star size={9} fill="currentColor" />
          Popular
        </span>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
              isSelected
                ? 'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]'
                : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]',
            )}
          >
            <Icon size={12} />
          </span>
          <span className="truncate text-[13.5px] font-semibold text-[var(--ds-text)]">{plan.name}</span>
          {isCurrent && (
            <StatusBadge tone="neutral" className="shrink-0">
              Current
            </StatusBadge>
          )}
        </div>
        <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
          {priceLabel}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-[11.5px] leading-snug text-[var(--ds-text-subtle)]">
        {plan.description || TIER_META[plan.slug]?.description || ''}
      </p>
    </button>
  );
}

// ── Focused plan pane ─────────────────────────────────────────────────────────

interface ReferralView {
  input: string;
  setInput: (v: string) => void;
  status: ReferralStatus;
  setStatus: (s: ReferralStatus) => void;
  setMessage: (m: string) => void;
  message: string;
  appliedCode: string | null;
  discountPct: number;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onApply: () => void;
}

function FocusedPlan({
  plan,
  billingCycle,
  geo,
  currentPlanSlug,
  currentSubscriptionStatus,
  hasActiveSubscription,
  trialEndIso,
  dataRetentionUntilIso,
  currentPlan,
  submitting,
  submitError,
  submitNotice,
  onCta,
  referral,
}: {
  plan: PlanRow;
  billingCycle: BillingCycle;
  geo: Geo | null;
  currentPlanSlug: string | null;
  currentSubscriptionStatus: string | null;
  hasActiveSubscription: boolean;
  trialEndIso: string | null;
  dataRetentionUntilIso: string | null;
  currentPlan: PlanRow | null;
  submitting: boolean;
  submitError: string;
  submitNotice: string;
  onCta: (kind: string) => void;
  referral: ReferralView;
}): ReactElement {
  const isCurrent = plan.slug === currentPlanSlug;
  const features = useMemo(() => buildFeatureList(plan, geo), [plan, geo]);
  const isFree = plan.slug === 'free';
  const isEnterprise = plan.slug === 'enterprise';
  const currentPrice = Number(currentPlan?.monthly_price_usd_cents || currentPlan?.monthly_price_cents || 0);
  const targetPrice = Number(plan.monthly_price_usd_cents || plan.monthly_price_cents || 0);
  const isUpgradeFromPaid = hasActiveSubscription && currentPrice > 0 && targetPrice > currentPrice;
  const isDowngradeFromPaid =
    hasActiveSubscription && currentPrice > 0 && targetPrice < currentPrice && targetPrice > 0;
  const ctas = ctasFor({
    plan,
    isCurrent,
    currentPlanSlug,
    currentSubscriptionStatus,
    hasActiveSubscription,
    isUpgradeFromPaid,
    isDowngradeFromPaid,
  });
  const primary = ctas[0];

  const referralEligible = !isFree && !isEnterprise;
  const activeDiscount = referralEligible && referral.appliedCode ? referral.discountPct || 0 : 0;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[20px] font-bold tracking-tight text-[var(--ds-text)]">{plan.name}</h3>
        <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
          {plan.description || TIER_META[plan.slug]?.description || ''}
        </p>
      </div>

      {isCurrent && (
        <TrialContextStrip
          status={currentSubscriptionStatus}
          planName={plan.name}
          trialDays={plan.trial_days ?? null}
          trialEndIso={trialEndIso}
          dataRetentionUntilIso={dataRetentionUntilIso}
        />
      )}

      <PriceBlock
        plan={plan}
        billingCycle={billingCycle}
        geo={geo}
        discountPct={activeDiscount}
        appliedCode={referralEligible ? referral.appliedCode : null}
      />

      {referralEligible && <ReferralBlock referral={referral} />}

      <div className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
          Features you’ll love
        </h4>
        <ul className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {features.map((f, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[13px] text-[var(--ds-text)]">
              <Check size={13} className="mt-0.5 shrink-0 text-[var(--ds-success)]" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </div>

      {submitError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-danger)]"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{submitError}</span>
        </div>
      )}
      {!submitError && submitNotice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-[var(--ds-info)] bg-[var(--ds-info-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--ds-info)]" />
          <span>{submitNotice}</span>
        </div>
      )}

      <div className="space-y-2">
        {ctas.map((cta, i) => {
          const isDeadCta = cta.kind === 'current' || cta.kind === 'noop';
          const showIcon = cta.variant !== 'secondary' && !isDeadCta;
          return (
            <Button
              key={cta.kind}
              variant={cta.variant === 'secondary' ? 'outline' : isDeadCta ? 'secondary' : 'primary'}
              size="lg"
              className="w-full"
              onClick={() => onCta(cta.kind)}
              disabled={submitting || isDeadCta}
            >
              {submitting && i === 0 ? (
                <Loader2 size={16} className="animate-spin" />
              ) : !showIcon ? null : isEnterprise ? (
                <Mail size={16} />
              ) : isFree ? null : (
                <ExternalLink size={16} />
              )}
              {cta.label}
            </Button>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-[var(--ds-text-subtle)]">{primary.note}</p>

      <p className="flex items-center gap-1.5 border-t border-[var(--ds-border)] pt-3 text-[11px] text-[var(--ds-text-subtle)]">
        <ShieldCheck size={12} />
        Secure checkout · Cancel anytime · 7-day free trial on Standard.
      </p>
    </div>
  );
}

// ── Price block ───────────────────────────────────────────────────────────────

function PriceBlock({
  plan,
  billingCycle,
  geo,
  discountPct = 0,
  appliedCode = null,
}: {
  plan: PlanRow;
  billingCycle: BillingCycle;
  geo: Geo | null;
  discountPct?: number;
  appliedCode?: string | null;
}): ReactElement {
  if (plan.slug === 'enterprise') {
    return (
      <div>
        <span className="text-4xl font-bold tracking-tight text-[var(--ds-text)]">Custom</span>
        <p className="mt-1 text-[12px] text-[var(--ds-text-muted)]">
          Tailored credit allocation, dedicated account manager, SLA.
        </p>
      </div>
    );
  }

  const { cents, symbol: sym, hasMonthlyCents, hasAnnualCents } = resolveDisplayCents(
    plan,
    billingCycle,
    geo,
  );

  if (!cents) {
    return (
      <div>
        <span className="text-4xl font-bold tracking-tight text-[var(--ds-text)]">{sym}0</span>
        <p className="mt-1 text-[12px] text-[var(--ds-text-muted)]">Forever. No card required.</p>
      </div>
    );
  }

  const hasDiscount = discountPct > 0 && Boolean(appliedCode);
  const bps = Math.max(0, Math.min(10_000, Math.round((discountPct || 0) * 100)));
  const chargedCents = hasDiscount ? cents - Math.floor((cents * bps) / 10_000) : cents;
  const major = cents / 100;
  const chargedMajor = chargedCents / 100;
  const monthlyEquiv = billingCycle === 'annual' && hasMonthlyCents ? chargedCents / 12 / 100 : null;
  const fmt = (val: number): string =>
    `${sym}${Number.isInteger(val) ? val.toLocaleString() : val.toFixed(2)}`;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            'text-4xl font-bold tracking-tight tabular-nums',
            hasDiscount ? 'text-[var(--ds-success)]' : 'text-[var(--ds-text)]',
          )}
        >
          {fmt(chargedMajor)}
        </span>
        {hasDiscount && (
          <span className="text-lg font-medium tabular-nums text-[var(--ds-text-subtle)] line-through">
            {fmt(major)}
          </span>
        )}
        <span className="text-[13px] text-[var(--ds-text-muted)]">
          / {billingCycle === 'annual' ? 'year' : 'month'}
        </span>
        {hasDiscount && (
          <span className="inline-flex items-center gap-1 rounded-md bg-[var(--ds-success)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--ds-status-fg,white)]">
            <Sparkles size={10} />
            {discountPct.toFixed(0)}% off
          </span>
        )}
      </div>
      {monthlyEquiv != null && (
        <p className="text-[12px] text-[var(--ds-text-muted)]">
          Equivalent to{' '}
          <span className="font-semibold tabular-nums text-[var(--ds-text)]">
            {sym}
            {monthlyEquiv.toFixed(2)}
          </span>{' '}
          / month — save vs paying month-to-month.
        </p>
      )}
      {!hasDiscount &&
        billingCycle === 'monthly' &&
        hasMonthlyCents &&
        hasAnnualCents &&
        (() => {
          const monthly = resolveDisplayCents(plan, 'monthly', geo).cents;
          const annual = resolveDisplayCents(plan, 'annual', geo).cents;
          const saved = (monthly * 12 - annual) / 100;
          return saved > 0 ? (
            <p className="text-[12px] text-[var(--ds-success)]">
              Switch to annual and save{' '}
              <strong>
                {sym}
                {saved.toFixed(0)}/yr
              </strong>
              .
            </p>
          ) : null;
        })()}
      {hasDiscount && (
        <p className="text-[12px] text-[var(--ds-success)]">
          Saving{' '}
          <strong>
            {sym}
            {((cents - chargedCents) / 100).toFixed(2)}/{billingCycle === 'annual' ? 'yr' : 'mo'}
          </strong>{' '}
          with code <code className="font-mono font-bold uppercase">{appliedCode}</code>.
        </p>
      )}
    </div>
  );
}

// ── Referral block ────────────────────────────────────────────────────────────

function ReferralBlock({ referral }: { referral: ReferralView }): ReactElement {
  const { input, setInput, status, setStatus, setMessage, message, appliedCode, discountPct, inputRef, onApply } =
    referral;
  const isApplied = status === 'applied' && Boolean(appliedCode);

  return (
    <div
      className={cn(
        'rounded-xl border p-3 transition-colors',
        isApplied
          ? 'border-[var(--ds-success)] bg-[var(--ds-success-soft)]'
          : 'border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]',
      )}
    >
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-text-muted)]">
        <Gift size={14} className={isApplied ? 'text-[var(--ds-success)]' : 'text-[var(--ds-accent-text)]'} />
        {isApplied ? 'Referral code active' : 'Have a referral code?'}
      </p>

      {isApplied ? (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-success)] bg-[var(--ds-success-soft)] px-3 py-2">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[var(--ds-success)]" />
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-[var(--ds-text)]">
              <code className="font-mono tracking-wider">{appliedCode}</code>
              {discountPct > 0 ? (
                <span className="ml-1 font-bold">— {discountPct.toFixed(0)}% off every renewal</span>
              ) : (
                <span className="ml-1 font-normal text-[var(--ds-text-muted)]">
                  — thanks, your referrer is credited
                </span>
              )}
            </p>
            <p className="mt-1 text-[11px] text-[var(--ds-text-muted)]">
              Applied automatically at checkout — linked to your account and can’t be removed.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
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
              'flex-1 rounded-lg border bg-[var(--ds-bg-surface)] px-3 py-1.5 font-mono text-sm uppercase tracking-widest text-[var(--ds-text)]',
              'placeholder:font-sans placeholder:tracking-normal placeholder:text-[var(--ds-text-subtle)]',
              'focus:outline-none focus:ring-2 focus:ring-[var(--ds-ring)] disabled:opacity-60',
              status === 'invalid' ? 'border-[var(--ds-danger)]' : 'border-[var(--ds-border)]',
            )}
          />
          <Button variant="primary" size="md" onClick={onApply} disabled={!input.trim() || status === 'applying'}>
            {status === 'applying' ? <Loader2 size={16} className="animate-spin" /> : 'Apply'}
          </Button>
        </div>
      )}

      {status === 'invalid' && message && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-[var(--ds-danger)]">
          <AlertCircle size={12} className="shrink-0" />
          {message}
        </p>
      )}
    </div>
  );
}

// ── Trial context strip ───────────────────────────────────────────────────────

function TrialContextStrip({
  status,
  planName,
  trialDays,
  trialEndIso,
  dataRetentionUntilIso,
}: {
  status: string | null;
  planName: string;
  trialDays: number | null;
  trialEndIso: string | null;
  dataRetentionUntilIso: string | null;
}): ReactElement | null {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (status !== 'trialing' && status !== 'trial_expired') return null;

  if (status === 'trialing') {
    if (!trialEndIso) return null;
    const liveDaysLeft = trialDaysLeft(trialEndIso, now);
    const configuredDays = Number(trialDays) > 0 ? Number(trialDays) : 7;
    const daysForHeadline = liveDaysLeft ?? configuredDays;
    let headline: string;
    if (daysForHeadline <= 0) headline = 'Free trial ends today';
    else if (daysForHeadline === 1) headline = '1 day free trial left';
    else headline = `${daysForHeadline} days free trial`;
    const deadlineLabel = formatTrialDate(trialEndIso);
    return (
      <div
        role="status"
        className="rounded-xl border border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] p-4"
      >
        <div className="text-[14px] font-bold tracking-tight text-[var(--ds-accent-text)]">{headline}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--ds-text)]">
          Your chatbot is live with the full <strong className="font-semibold">{planName}</strong> feature set
          right now. Authorise your card or UPI to keep it running past{' '}
          <strong className="font-semibold text-[var(--ds-accent-text)]">{deadlineLabel}</strong>.
        </p>
      </div>
    );
  }

  if (!dataRetentionUntilIso) return null;
  const daysLeft = daysUntil(dataRetentionUntilIso, now);
  if (daysLeft === null) return null;
  const isAlarm = daysLeft <= 3;
  const deadlineLabel = formatTrialDate(dataRetentionUntilIso);
  let statusLabel: string;
  if (daysLeft <= 0) statusLabel = 'Your workspace is scheduled for deletion today';
  else if (daysLeft === 1) statusLabel = '1 day left to save your workspace';
  else statusLabel = `${daysLeft} days left to save your workspace`;
  return (
    <div
      role={isAlarm ? 'alert' : 'status'}
      className={cn(
        'rounded-xl border p-3.5',
        isAlarm
          ? 'border-[var(--ds-danger)] bg-[var(--ds-danger-soft)]'
          : 'border-[var(--ds-warning)] bg-[var(--ds-warning-soft)]',
      )}
    >
      <div className={cn('text-[13px] font-semibold', isAlarm ? 'text-[var(--ds-danger)]' : 'text-[var(--ds-warning)]')}>
        {statusLabel}
      </div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text)]">
        Your trial ended and your chatbot is currently offline on visitor sites. Your knowledge base, leads,
        and settings stay intact until <strong>{deadlineLabel}</strong>, then get permanently deleted. Upgrade
        to bring the bot back live.
      </p>
    </div>
  );
}
