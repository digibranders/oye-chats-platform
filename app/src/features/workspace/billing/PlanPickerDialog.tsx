import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  SegmentedControl,
  Spinner,
  buttonClass,
  cn,
} from '../../../ui';
import {
  chargeDisclosure,
  formatCredits,
  formatAgentAllowance,
  formatSeatAllowance,
  formatTrialOffer,
  formatMoneyMinor,
  maxAnnualSavingPercent,
  promotionAppliesToPlan,
  resolvePlanPrice,
  SALES_EMAIL,
  type BillingCycleKey,
  type BillingGeoView,
  type PlanView,
  type PromotionView,
} from '../billingModel';
import { isTrialEligible, usePlanCheckout } from './usePlanCheckout';
import { usePlanActivation } from './usePlanActivation';

export interface PlanPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: PlanView[];
  currentPlan: PlanView | null;
  currentStatus: string | null;
  hasActiveSubscription: boolean;
  trialUsed: boolean;
  promotion: PromotionView | null;
  geo: BillingGeoView | null;
  botId?: number | null;
  /** Fired after any successful mutation so the page can re-read itself. */
  onChanged: (message: string) => void;
  onBillingDetailsRequired: (missing: string[]) => void;
}

function PlanCard({
  plan,
  cycle,
  geo,
  current,
  promoApplies,
  disabled,
  ctaLabel,
  onSelect,
}: {
  plan: PlanView;
  cycle: BillingCycleKey;
  geo: BillingGeoView | null;
  current: boolean;
  promoApplies: boolean;
  disabled: boolean;
  ctaLabel: string;
  onSelect: () => void;
}) {
  const price = resolvePlanPrice(plan, cycle, geo);
  const disclosure = chargeDisclosure(price);
  const trial = formatTrialOffer(plan.trialDays);

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-surface p-5',
        current ? 'border-border-strong' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-text-primary">{plan.name}</h3>
        {current ? <Badge tone="plan">Current</Badge> : null}
      </div>

      {plan.isContactSales ? (
        <p className="figure mt-2 text-lg font-semibold text-text-primary">Custom</p>
      ) : (
        <p className="figure mt-2 text-2xl font-semibold leading-tight text-text-primary">
          {formatMoneyMinor(price.displayMinor, price.displayCurrency)}
          <span className="ml-1 font-sans text-xs font-normal text-text-tertiary">
            /{cycle === 'annual' ? 'yr' : 'mo'}
          </span>
        </p>
      )}
      {disclosure && !plan.isContactSales ? (
        <p className="mt-1 text-xs leading-snug text-text-secondary">{disclosure}</p>
      ) : null}

      <ul className="mt-4 flex-1 space-y-1.5 text-xs text-text-secondary">
        <li className="flex gap-1.5">
          <Check aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-success" />
          <span className="figure">{formatCredits(plan.creditsPerMonth)}</span> credits a month
        </li>
        <li className="flex gap-1.5">
          <Check aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-success" />
          {formatAgentAllowance(plan)}
        </li>
        <li className="flex gap-1.5">
          <Check aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-success" />
          {formatSeatAllowance(plan.includedSeats)}
        </li>
        {plan.overageRateMinor > 0 ? (
          <li className="flex gap-1.5">
            <Check aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-success" />
            {formatMoneyMinor(plan.overageRateMinor, price.chargeCurrency)} per credit beyond that
          </li>
        ) : null}
      </ul>

      {promoApplies ? (
        <p className="mt-3 rounded-sm bg-plan-tint px-2 py-1 text-xs text-plan">
          Your launch offer applies to this plan.
        </p>
      ) : trial && !current ? (
        <p className="mt-3 text-xs text-text-tertiary">{trial}, no card needed.</p>
      ) : null}

      <div className="mt-4">
        {plan.isContactSales ? (
          <a href={`mailto:${SALES_EMAIL}`} className={cn(buttonClass('secondary', 'md'), 'w-full')}>
            Contact sales
          </a>
        ) : (
          <Button
            className="w-full"
            variant={current ? 'secondary' : 'primary'}
            disabled={disabled || current}
            onClick={onSelect}
          >
            {current ? 'Your plan' : ctaLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The plan picker.
 *
 * Two rules make this a money surface rather than a card grid.
 *
 * First, it cannot be dismissed while a charge is in flight. A customer who
 * closes a dialog mid-payment has no way to tell whether they were charged, and
 * the honest answer is that we do not know either until the mandate settles.
 *
 * Second, once money has moved the pay button never comes back. Activation is
 * out of band, so the moment the charge lands the surface switches to a
 * persistent "activating" state and polls `/subscriptions/current` until the
 * plan is genuinely live. The silence this replaces is what produced a second
 * Razorpay subscription and a second charge in production.
 */
export function PlanPickerDialog({
  open,
  onOpenChange,
  plans,
  currentPlan,
  currentStatus,
  hasActiveSubscription,
  trialUsed,
  promotion,
  geo,
  botId = null,
  onChanged,
  onBillingDetailsRequired,
}: PlanPickerDialogProps) {
  const [cycle, setCycle] = useState<BillingCycleKey>('monthly');

  const activation = usePlanActivation({
    botId,
    onSettled: (plan) => onChanged(`You are now on ${plan.name}.`),
  });

  const checkout = usePlanCheckout({
    currentPlanSlug: currentPlan?.slug ?? 'free',
    currentSubscriptionStatus: currentStatus,
    hasActiveSubscription,
    trialUsed,
    promotion,
    botId,
    onSuccess: onChanged,
    onDone: () => {
      // Only close when nothing is still settling. A dialog that closes over an
      // in-flight activation takes the one explanation the customer has with it.
      if (!activation.blocking) onOpenChange(false);
    },
    onActivationPending: (plan, hint) => activation.begin(plan, hint),
    onBillingDetailsRequired: (missing) => {
      onOpenChange(false);
      onBillingDetailsRequired(missing);
    },
  });

  const bestSaving = useMemo(() => maxAnnualSavingPercent(plans), [plans]);
  const locked = checkout.submitting || checkout.activationPending || activation.blocking;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && locked) return;
        if (next) {
          checkout.reset();
          activation.reset();
        }
        onOpenChange(next);
      }}
      // The one condition under which a dialog may refuse to close.
      dismissible={!locked}
      title="Choose a plan"
      description="Prices are per workspace. You can change or cancel at any time; a downgrade takes effect at the end of the period you have already paid for."
      size="xl"
      footer={
        <p className="mr-auto text-xs text-text-secondary">
          Paid by card or UPI through Razorpay. Cancelling stops the next charge, never the one you
          have already made.
        </p>
      }
    >
      <div className="space-y-4">
        <SegmentedControl
          label="Billing cycle"
          value={cycle}
          onChange={(next) => setCycle(next)}
          items={[
            { value: 'monthly', label: 'Monthly' },
            {
              value: 'annual',
              label: bestSaving > 0 ? `Yearly · save up to ${bestSaving}%` : 'Yearly',
            },
          ]}
        />

        {activation.blocking ? (
          <Alert
            tone={activation.status === 'timeout' ? 'warning' : 'neutral'}
            title={
              activation.status === 'timeout'
                ? 'Your payment landed, activation is taking longer than usual'
                : `Activating ${activation.planName ?? 'your plan'}`
            }
            live
            icon={activation.status === 'timeout' ? undefined : <Spinner />}
          >
            {activation.status === 'timeout'
              ? 'You have been charged and you do not need to pay again. If the plan has not switched on within a few minutes, contact support with your payment reference.'
              : 'Your payment went through. We are waiting for the gateway to confirm the subscription; this usually takes under a minute. Do not pay again.'}
          </Alert>
        ) : null}

        {checkout.error ? (
          <Alert tone="danger" live title="We could not complete that">
            {checkout.error}
            {checkout.emailVerificationRequired
              ? ' Verify your email address first, then try again.'
              : null}
          </Alert>
        ) : null}

        {checkout.notice && !checkout.error && !activation.blocking ? (
          <Alert tone="neutral" live>
            {checkout.notice}
          </Alert>
        ) : null}

        {geo && !geo.checkoutAvailable ? (
          <Alert tone="warning" title="Checkout is unavailable right now">
            Our payment gateway is not reachable, so no plan can be purchased at the moment. Email{' '}
            {geo.contactSalesEmail} and we will set it up for you.
          </Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const trialPath =
              !trialUsed && isTrialEligible(plan, currentPlan?.slug ?? 'free', currentStatus, trialUsed);
            return (
              <PlanCard
                key={plan.id}
                plan={plan}
                cycle={cycle}
                geo={geo}
                current={plan.slug === currentPlan?.slug}
                promoApplies={cycle === 'monthly' && promotionAppliesToPlan(promotion, plan)}
                disabled={locked || (geo != null && !geo.checkoutAvailable && plan.isPaid)}
                ctaLabel={
                  !plan.isPaid
                    ? 'Move to Free'
                    : trialPath
                      ? `Start ${plan.trialDays}-day trial`
                      : hasActiveSubscription
                        ? 'Switch to this plan'
                        : 'Subscribe'
                }
                onSelect={() => void checkout.submit(plan, cycle)}
              />
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
