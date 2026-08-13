import { type ReactElement, useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Check, ExternalLink, Gift, Info, Loader2, Sparkles } from 'lucide-react';
import { Button, Input, Modal, Skeleton, cn } from '../../../design-system';
import { applyReferralCode, getCheckoutQuote, getReferralStatus } from '../../../services/api';
import {
  formatCredits,
  formatFreeMonths,
  formatMoneyMinor,
  formatSeatAllowance,
  promotionAppliesToPlan,
  type PlanView,
  type PromotionView,
} from '../billingModel';
import type { BillingCycle } from './planMath';
import { isTrialEligible, usePlanCheckout } from './usePlanCheckout';

/** Compact "what you get" bullet list for the plan being confirmed. */
function PlanHighlights({ plan }: { plan: PlanView }): ReactElement {
  const items = [
    `${formatCredits(plan.creditsPerMonth)} credits / month`,
    formatSeatAllowance(plan.includedSeats),
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
  isCurrentPlan: boolean,
  status: string | null,
): Intent {
  if (plan.slug === 'free') return 'downgrade_free';
  // A trialing (or post-trial) customer selecting THEIR OWN plan is converting
  // the trial to a paid subscription - not downgrading. Route to pay/activate
  // (change-plan trialing→active, or checkout when the trial has expired).
  if (isCurrentPlan && (status === 'trialing' || status === 'trial_expired')) return 'subscribe';
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
  subscribe: 'Secure checkout via Razorpay - UPI, card, or NetBanking. Cancel anytime.',
  upgrade: 'Your plan changes immediately. Billing adjusts automatically on your next invoice.',
  downgrade:
    'Takes effect at the end of your current billing period - you keep your current plan and credits until then.',
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
  /** True once the client has used their lifetime free trial - hides the trial CTA. */
  trialUsed: boolean;
  /** Monthly price of the current plan (minor units) - decides upgrade vs downgrade. */
  currentMonthlyPriceMinor: number;
  /**
   * Current plan's chat-history retention window (`limits.chat_history_days`;
   * `-1` = unlimited, `null`/omitted = unknown). Used only to warn, on a
   * downgrade, when the visible history window will shrink.
   */
  currentChatHistoryDays?: number | null;
  /** Active launch promotion the client qualifies for, if any (drives the free-period display + checkout routing). */
  promotion?: PromotionView | null;
  /** Bot whose subscription this change targets (agent switcher selection); null = account-level view. */
  botId?: number | null;
  onSuccess: (message: string) => void;
  /**
   * Fired when checkout is refused because the buyer's statutory billing
   * identity is incomplete. The host closes this modal and opens the
   * billing-details form.
   */
  onBillingDetailsRequired?: (missing: string[]) => void;
}

/**
 * PlanConfirmModal - a focused, centered confirmation for a plan change. A
 * single decision belongs in a centered modal (not a side drawer): it states
 * exactly what will happen - the honest price from `/checkout/quote`, the
 * effect of the change, and any card charge - and runs the shared
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
  trialUsed,
  currentMonthlyPriceMinor,
  currentChatHistoryDays = null,
  promotion,
  botId = null,
  onSuccess,
  onBillingDetailsRequired,
}: PlanConfirmModalProps): ReactElement | null {
  const checkout = usePlanCheckout({
    currentPlanSlug,
    currentSubscriptionStatus,
    hasActiveSubscription,
    trialUsed,
    promotion,
    botId,
    onSuccess,
    onDone: onClose,
    onBillingDetailsRequired,
  });
  const { reset } = checkout;

  // When the promo covers this plan, the customer pays ₹0 now and the first
  // charge is deferred, so the modal must say so, not quote the full price.
  // Monthly-only: annual + promo would bill a full year after the free period.
  const promoApplies = plan ? cycle === 'monthly' && promotionAppliesToPlan(promotion ?? null, plan) : false;

  const [quote, setQuote] = useState<QuoteState>({
    loading: false,
    amountDisplay: null,
    blockedReason: null,
    contactSales: null,
  });

  // Referral / coupon state. Applying a code attaches standing attribution to
  // the account server-side, so the checkout quote below picks up the discount -
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
  // already carry a code from signup - its discount applies at checkout even if
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
        /* no standing attribution - leave idle */
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
      // An enterprise tier is priced on request - there is no checkout quote to
      // fetch; it routes to sales instead.
      if (plan.isEnterprise) {
        if (!cancelled) {
          setQuote({ loading: false, amountDisplay: 'Custom', blockedReason: null, contactSales: null });
        }
        return;
      }
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

  const isCurrentPlan = plan.slug === currentPlanSlug;
  const trialEligible = isTrialEligible(plan, currentPlanSlug, currentSubscriptionStatus, trialUsed);
  const intent = resolveIntent(
    plan,
    hasActiveSubscription,
    currentMonthlyPriceMinor,
    trialEligible,
    isCurrentPlan,
    currentSubscriptionStatus,
  );
  const blocked = quote.blockedReason !== null;
  // A "contact sales" tier (enterprise) or a genuinely blocked checkout (intl
  // USD pending) both route to the sales team rather than the pay button.
  const contactOnly = blocked || plan.isEnterprise;

  // Chat-history visibility drop. On a paid→paid downgrade to a tier with a
  // shorter (finite) retention window, older conversations disappear from view.
  // Only warn on a REAL shrink (current unlimited, or strictly larger than the
  // target); a shorter target with an unknown/equal current stays silent to
  // avoid a false alarm. Data is retained, not deleted — say so.
  const targetHistoryDays = plan.limits?.chat_history_days;
  const showHistoryWarning =
    intent === 'downgrade' &&
    typeof targetHistoryDays === 'number' &&
    targetHistoryDays > 0 &&
    (currentChatHistoryDays === -1 ||
      (typeof currentChatHistoryDays === 'number' && currentChatHistoryDays > targetHistoryDays));

  // Referral discount preview. The platform charges on the INR rail (a blocked
  // intl checkout never reaches this UI), so the discounted headline from the
  // server quote, the struck original, and the savings figure are all INR and
  // stay coherent.
  const annual = cycle === 'annual' && plan.annualPriceMinor > 0;
  const originalMinor = annual ? plan.annualPriceMinor : plan.monthlyPriceMinor;
  const cycleSuffix = annual ? '/yr' : '/mo';
  const discountActive =
    plan.isPaid && !contactOnly && referral.status === 'applied' && referral.discountPct > 0;
  const savingsMinor = discountActive ? Math.round(originalMinor * (referral.discountPct / 100)) : 0;

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
        contactOnly ? (
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
        {/* Price hero - the plan name pill sits above a large, honest figure. */}
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
            <div className="mt-3 space-y-1">
              {promoApplies && promotion ? (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <p className="text-[34px] font-bold leading-none tracking-tight text-[var(--ds-text)]">
                      Free
                    </p>
                    <span className="text-[16px] font-medium text-[var(--ds-text-subtle)] line-through">
                      {priceText(plan, cycle)}
                    </span>
                  </div>
                  <p className="text-[12px] font-medium text-[var(--ds-accent-text)]">
                    First {formatFreeMonths(promotion.freeCycles)} free · then {priceText(plan, cycle)} · ₹0 today
                  </p>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <p className="text-[34px] font-bold leading-none tracking-tight text-[var(--ds-text)]">
                      {quote.amountDisplay ?? priceText(plan, cycle)}
                    </p>
                    {discountActive && (
                      <>
                        <span className="text-[16px] font-medium text-[var(--ds-text-subtle)] line-through">
                          {formatMoneyMinor(originalMinor)}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-[var(--ds-success-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ds-success)]">
                          {referral.discountPct}% off
                        </span>
                      </>
                    )}
                  </div>
                  {discountActive && savingsMinor > 0 && (
                    <p className="text-[12px] font-medium text-[var(--ds-success)]">
                      You save {formatMoneyMinor(savingsMinor)}
                      {cycleSuffix} with code {referral.code}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          <div className="mt-4 border-t border-[var(--ds-border)] pt-4">
            <PlanHighlights plan={plan} />
          </div>
        </div>

        {/* Trial context strip - a calm, delightful reassurance that the free
            trial charges nothing today. Only when this change starts a trial. */}
        {intent === 'trial' && (
          <div className="flex items-center gap-2.5 rounded-xl border border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] px-3.5 py-2.5 text-[13px] text-[var(--ds-text)]">
            <Gift size={15} aria-hidden="true" className="shrink-0 text-[var(--ds-accent-text)]" />
            <span>
              <span className="font-semibold">{plan.trialDays || 7} days free</span>
              <span className="text-[var(--ds-text-muted)]">
                {' '}
                - you won’t be charged today. Cancel anytime before it ends.
              </span>
            </span>
          </div>
        )}

        {/* Referral / coupon code - only where a discount can apply (paid, not a
            downgrade, not blocked). Applying attaches the code server-side; the
            quote above re-fetches to show the discounted price. */}
        {plan.isPaid && !contactOnly && intent !== 'downgrade' && intent !== 'downgrade_free' && (
          <div className="rounded-xl border border-[var(--ds-border)] p-4">
            {referral.status === 'applied' ? (
              <div className="flex items-center gap-2 text-[13px]">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-success-soft)] text-[var(--ds-success)]">
                  <Check size={13} aria-hidden="true" />
                </span>
                <span className="text-[var(--ds-text)]">
                  Code <span className="font-semibold">{referral.code}</span> applied
                  {referral.discountPct > 0 ? ` - ${referral.discountPct}% off` : ''}.
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
        {contactOnly ? (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]">
            <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
            {plan.isEnterprise
              ? 'This plan is tailored to your needs - our team will set you up with custom pricing and onboarding.'
              : 'International USD billing is coming soon - our team will set you up directly.'}
          </div>
        ) : (
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
            <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" />
            {INTENT_NOTE[intent]}
          </p>
        )}

        {/* Downgrade heads-up: the visible conversation-history window shrinks.
            Informational (not a blocker) - the data is retained, just hidden. */}
        {showHistoryWarning && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]">
            <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
            <span>
              On {plan.name} you’ll see the most recent{' '}
              <span className="font-medium">{targetHistoryDays} days</span> of conversation history.
              Older conversations stay stored but are hidden until you’re back on a higher plan.
            </span>
          </div>
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
