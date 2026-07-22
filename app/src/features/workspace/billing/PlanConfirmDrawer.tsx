import { type ReactElement, useEffect, useState } from 'react';
import { AlertCircle, Check, ExternalLink, Info, Loader2 } from 'lucide-react';
import { Button, Drawer, Skeleton, cn } from '../../../design-system';
import { getCheckoutQuote } from '../../../services/api';
import { formatCredits, formatMoneyMinor, type PlanView } from '../billingModel';
import type { BillingCycle } from './planMath';
import { isTrialEligible, usePlanCheckout } from './usePlanCheckout';

/** Compact "what you get" bullet list for the plan being confirmed. */
function PlanHighlights({ plan }: { plan: PlanView }): ReactElement {
  const items = [
    `${formatCredits(plan.creditsPerMonth)} credits / month`,
    plan.includedSeats > 0
      ? `${plan.includedSeats} operator seat${plan.includedSeats === 1 ? '' : 's'}`
      : 'No operator seats',
  ];
  return (
    <ul className="space-y-1.5 text-[13px] text-[var(--ds-text-muted)]">
      {items.map((item) => (
        <li key={item} className="flex items-center gap-2">
          <Check size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-success)]" />
          {item}
        </li>
      ))}
    </ul>
  );
}

const SALES_EMAIL = 'developer@oyechats.com';

type Intent = 'trial' | 'subscribe' | 'upgrade' | 'downgrade' | 'downgrade_free';

interface QuoteState {
  loading: boolean;
  amountDisplay: string | null;
  /** Non-null only when checkout is blocked (e.g. international USD-pending). */
  blockedReason: string | null;
  contactSales: string | null;
}

function resolveIntent(
  plan: PlanView,
  hasActiveSubscription: boolean,
  currentMonthlyPriceMinor: number,
  trialEligible: boolean,
): Intent {
  if (plan.slug === 'free') return 'downgrade_free';
  if (!hasActiveSubscription) return trialEligible ? 'trial' : 'subscribe';
  return plan.monthlyPriceMinor > currentMonthlyPriceMinor ? 'upgrade' : 'downgrade';
}

function priceText(plan: PlanView, cycle: BillingCycle): string {
  if (!plan.isPaid) return 'Free';
  const useAnnual = cycle === 'annual' && plan.annualPriceMinor > 0;
  const minor = useAnnual ? plan.annualPriceMinor : plan.monthlyPriceMinor;
  return `${formatMoneyMinor(minor)}${useAnnual ? ' / yr' : ' / mo'}`;
}

const INTENT_NOTE: Record<Intent, string> = {
  trial: 'No card is charged during your free trial. We’ll remind you before it ends, and you can cancel anytime.',
  subscribe: 'Secure checkout via Razorpay — UPI, card, or NetBanking. Cancel anytime.',
  upgrade: 'Your plan changes immediately. Billing adjusts automatically on your next invoice.',
  downgrade:
    'Takes effect at the end of your current billing period — you keep your current plan and credits until then.',
  downgrade_free:
    'Your subscription ends at the close of the current billing period. Existing top-up credits stay intact.',
};

export interface PlanConfirmDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The plan being confirmed. Null keeps the drawer closed. */
  plan: PlanView | null;
  cycle: BillingCycle;
  currentPlanSlug: string;
  currentSubscriptionStatus: string | null;
  hasActiveSubscription: boolean;
  /** Monthly price of the current plan (minor units) — decides upgrade vs downgrade. */
  currentMonthlyPriceMinor: number;
  onSuccess: (message: string) => void;
}

/**
 * PlanConfirmDrawer — the slim, right-anchored confirmation that replaces the
 * old full-screen plan modal. It states exactly what will happen (the honest
 * price from `/checkout/quote`, the effect of the change, and any card charge)
 * and runs the shared {@link usePlanCheckout} money-path. It never invents a
 * proration figure — proration is applied server-side at activation.
 */
export function PlanConfirmDrawer({
  open,
  onClose,
  plan,
  cycle,
  currentPlanSlug,
  currentSubscriptionStatus,
  hasActiveSubscription,
  currentMonthlyPriceMinor,
  onSuccess,
}: PlanConfirmDrawerProps): ReactElement | null {
  const checkout = usePlanCheckout({
    currentPlanSlug,
    currentSubscriptionStatus,
    hasActiveSubscription,
    onSuccess,
    onDone: onClose,
  });
  const { reset } = checkout;

  const [quote, setQuote] = useState<QuoteState>({
    loading: false,
    amountDisplay: null,
    blockedReason: null,
    contactSales: null,
  });

  // Fetch the honest quote whenever the drawer opens for a paid plan. The
  // quote is informational for price + gating (intl USD pending); a failure
  // degrades to the local PlanView price so the confirm still works.
  useEffect(() => {
    if (!open || !plan) return undefined;
    reset();
    let cancelled = false;
    // All quote state is set inside this async closure (never synchronously in
    // the effect body) so a fast re-open can't cascade renders.
    void (async () => {
      if (!plan.isPaid) {
        if (!cancelled) {
          setQuote({ loading: false, amountDisplay: 'Free', blockedReason: null, contactSales: null });
        }
        return;
      }
      setQuote({ loading: true, amountDisplay: null, blockedReason: null, contactSales: null });
      try {
        const res = (await getCheckoutQuote(plan.id, cycle)) as Record<string, unknown>;
        if (cancelled) return;
        const supported = res?.checkout_supported !== false;
        const reason = String(res?.reason || '');
        setQuote({
          loading: false,
          amountDisplay: (res?.amount_display as string) || priceText(plan, cycle),
          // free_plan is an expected "unsupported" (downgrade path); only a
          // genuine block like intl_usd_pending should stop the pay button.
          blockedReason: !supported && reason !== 'free_plan' ? reason : null,
          contactSales: (res?.contact_sales as string) || null,
        });
      } catch {
        if (!cancelled) {
          setQuote({ loading: false, amountDisplay: priceText(plan, cycle), blockedReason: null, contactSales: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, plan, cycle, reset]);

  if (!open || !plan) return null;

  const trialEligible = isTrialEligible(plan, currentPlanSlug, currentSubscriptionStatus);
  const intent = resolveIntent(plan, hasActiveSubscription, currentMonthlyPriceMinor, trialEligible);
  const blocked = quote.blockedReason !== null;

  const primaryLabel =
    intent === 'trial'
      ? `Start ${plan.trialDays || 7}-day free trial`
      : intent === 'subscribe'
        ? 'Subscribe & pay'
        : intent === 'upgrade'
          ? `Upgrade to ${plan.name}`
          : intent === 'downgrade'
            ? 'Schedule downgrade'
            : 'Downgrade to Free';

  const primaryActionKind = intent === 'trial' ? 'trial' : 'auto';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      dismissible={!checkout.submitting}
      title={`Confirm ${plan.name}`}
      footer={
        blocked ? (
          <a
            href={`mailto:${quote.contactSales || SALES_EMAIL}?subject=${encodeURIComponent(`${plan.name} plan inquiry`)}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-4 py-2 text-[13px] font-medium text-[var(--ds-accent-fg)] transition-opacity hover:opacity-90"
          >
            <ExternalLink size={15} aria-hidden="true" />
            Contact sales
          </a>
        ) : (
          <div className="flex w-full items-center justify-between gap-3">
            {intent === 'trial' ? (
              <button
                type="button"
                onClick={() => void checkout.submit(plan, cycle, 'paid')}
                disabled={checkout.submitting}
                className="text-[13px] font-medium text-[var(--ds-text-muted)] underline-offset-2 hover:text-[var(--ds-text)] hover:underline disabled:opacity-50"
              >
                Pay now instead
              </button>
            ) : (
              <span />
            )}
            <Button onClick={() => void checkout.submit(plan, cycle, primaryActionKind)} disabled={checkout.submitting}>
              {checkout.submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              {primaryLabel}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-5">
        {/* Price */}
        <div>
          <p className="text-[12px] font-medium text-[var(--ds-text-muted)]">
            {cycle === 'annual' ? 'Billed annually' : 'Billed monthly'}
          </p>
          {quote.loading ? (
            <Skeleton className="mt-1 h-8 w-32 rounded" />
          ) : (
            <p className="mt-1 text-3xl font-bold tracking-tight text-[var(--ds-text)]">
              {quote.amountDisplay ?? priceText(plan, cycle)}
            </p>
          )}
        </div>

        {/* What you get */}
        <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-subtle)] p-4">
          <PlanHighlights plan={plan} />
        </div>

        {/* What will happen */}
        {blocked ? (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]">
            <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
            International USD billing is coming soon — our team will set you up directly.
          </div>
        ) : (
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
            <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" />
            {INTENT_NOTE[intent]}
          </p>
        )}

        {/* Money-path feedback */}
        {checkout.error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]">
            <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-danger)]" />
            {checkout.error}
          </div>
        )}
        {checkout.notice && (
          <div className={cn('flex items-start gap-2 rounded-lg border border-[var(--ds-info)] bg-[var(--ds-info-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]')}>
            <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-info)]" />
            {checkout.notice}
          </div>
        )}
      </div>
    </Drawer>
  );
}
