import { type ReactElement, useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Check, ExternalLink, Gift, Info, Loader2, Sparkles } from 'lucide-react';
import { Button, Input, Modal, Skeleton, cn } from '../../../design-system';
import { applyReferralCode, getCheckoutQuote, getReferralStatus } from '../../../services/api';
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
    <ul className="space-y-2 text-[13px] text-[var(--ds-text-muted)]">
      {items.map((item) => (
        <li key={item} className="flex items-center gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ds-success-soft)] text-[var(--ds-success)]">
            <Check size={12} aria-hidden="true" />
          </span>
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

interface ReferralState {
  input: string;
  /** idle (empty/typing) · applying · applied (attached) · invalid (rejected). */
  status: 'idle' | 'applying' | 'applied' | 'invalid';
  message: string;
  code: string | null;
  discountPct: number;
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

export interface PlanConfirmModalProps {
  open: boolean;
  onClose: () => void;
  /** The plan being confirmed. Null keeps the modal closed. */
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
 * PlanConfirmModal — a focused, centered confirmation for a plan change. A
 * single decision belongs in a centered modal (not a side drawer): it states
 * exactly what will happen — the honest price from `/checkout/quote`, the
 * effect of the change, and any card charge — and runs the shared
 * {@link usePlanCheckout} money-path. It never invents a proration figure;
 * proration is applied server-side at activation.
 */
export function PlanConfirmModal({
  open,
  onClose,
  plan,
  cycle,
  currentPlanSlug,
  currentSubscriptionStatus,
  hasActiveSubscription,
  currentMonthlyPriceMinor,
  onSuccess,
}: PlanConfirmModalProps): ReactElement | null {
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

  // Referral / coupon state. Applying a code attaches standing attribution to
  // the account server-side, so the checkout quote below picks up the discount —
  // we re-fetch it after a successful apply via `quoteToken`.
  const [referral, setReferral] = useState<ReferralState>({
    input: '',
    status: 'idle',
    message: '',
    code: null,
    discountPct: 0,
  });
  const [quoteToken, setQuoteToken] = useState(0);

  // Seed any standing referral attribution when the modal opens (an account can
  // already carry a code from signup — its discount applies at checkout even if
  // the field looks empty). Reset per open so a prior code can't flash.
  useEffect(() => {
    if (!open || !plan?.isPaid) return undefined;
    let cancelled = false;
    setReferral({ input: '', status: 'idle', message: '', code: null, discountPct: 0 });
    void (async () => {
      try {
        const status = await getReferralStatus();
        if (!cancelled && status?.attributed && status.code) {
          setReferral({
            input: status.code,
            status: 'applied',
            message: '',
            code: status.code,
            discountPct: Number(status.discount_pct) || 0,
          });
        }
      } catch {
        /* no standing attribution — leave idle */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, plan?.isPaid]);

  async function handleApplyReferral(): Promise<void> {
    const code = referral.input.trim().toUpperCase();
    if (!code || referral.status === 'applying') return;
    setReferral((prev) => ({ ...prev, status: 'applying', message: '' }));
    try {
      const result = await applyReferralCode(code);
      if (result.code) {
        setReferral({
          input: result.code,
          status: 'applied',
          message: '',
          code: result.code,
          discountPct: Number(result.discount_pct) || 0,
        });
        // Re-fetch the quote so the discounted price shows immediately.
        setQuoteToken((token) => token + 1);
      } else {
        setReferral((prev) => ({
          ...prev,
          status: 'invalid',
          message: result.message || 'That code isn’t valid.',
        }));
      }
    } catch (error) {
      setReferral((prev) => ({
        ...prev,
        status: 'invalid',
        message: error instanceof Error ? error.message : 'Couldn’t apply that code.',
      }));
    }
  }

  // Fetch the honest quote whenever the modal opens for a paid plan (and after a
  // referral is applied). The quote is informational for price + gating (intl
  // USD pending); a failure degrades to the local PlanView price.
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
  }, [open, plan, cycle, reset, quoteToken]);

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
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!checkout.submitting}
      size="sm"
      title={`Confirm ${plan.name}`}
      description="Review the change before it takes effect."
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
              {checkout.submitting ? (
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight size={16} aria-hidden="true" />
              )}
              {primaryLabel}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-5">
        {/* Price hero — the plan name pill sits above a large, honest figure. */}
        <div className="rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-subtle)] p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ds-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ds-accent-text)]">
              <Sparkles size={12} aria-hidden="true" />
              {plan.name}
            </span>
            <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
              {cycle === 'annual' ? 'Billed annually' : 'Billed monthly'}
            </span>
          </div>
          {quote.loading ? (
            <Skeleton className="mt-3 h-9 w-32 rounded" />
          ) : (
            <p className="mt-3 text-[34px] font-bold leading-none tracking-tight text-[var(--ds-text)]">
              {quote.amountDisplay ?? priceText(plan, cycle)}
            </p>
          )}
          <div className="mt-4 border-t border-[var(--ds-border)] pt-4">
            <PlanHighlights plan={plan} />
          </div>
        </div>

        {/* Referral / coupon code — only where a discount can apply (paid, not a
            downgrade, not blocked). Applying attaches the code server-side; the
            quote above re-fetches to show the discounted price. */}
        {plan.isPaid && !blocked && intent !== 'downgrade' && intent !== 'downgrade_free' && (
          <div className="rounded-xl border border-[var(--ds-border)] p-4">
            {referral.status === 'applied' ? (
              <div className="flex items-center gap-2 text-[13px]">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-success-soft)] text-[var(--ds-success)]">
                  <Check size={13} aria-hidden="true" />
                </span>
                <span className="text-[var(--ds-text)]">
                  Code <span className="font-semibold">{referral.code}</span> applied
                  {referral.discountPct > 0 ? ` — ${referral.discountPct}% off` : ''}.
                </span>
              </div>
            ) : (
              <>
                <label
                  htmlFor="referral-code"
                  className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-[var(--ds-text-muted)]"
                >
                  <Gift size={13} aria-hidden="true" />
                  Have a referral code?
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="referral-code"
                    value={referral.input}
                    onChange={(e) =>
                      setReferral((prev) => ({
                        ...prev,
                        input: e.target.value,
                        status: prev.status === 'invalid' ? 'idle' : prev.status,
                        message: '',
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleApplyReferral();
                      }
                    }}
                    placeholder="e.g. FRIEND20"
                    className="font-mono uppercase"
                    aria-invalid={referral.status === 'invalid' ? true : undefined}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void handleApplyReferral()}
                    disabled={referral.status === 'applying' || !referral.input.trim()}
                  >
                    {referral.status === 'applying' ? 'Applying…' : 'Apply'}
                  </Button>
                </div>
                {referral.status === 'invalid' && referral.message && (
                  <p role="alert" className="mt-1.5 text-[12px] text-[var(--ds-danger)]">
                    {referral.message}
                  </p>
                )}
              </>
            )}
          </div>
        )}

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
    </Modal>
  );
}
