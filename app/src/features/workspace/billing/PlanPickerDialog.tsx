import { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  PurchaseSuccess,
  SegmentedControl,
  Spinner,
  buttonClass,
  cn,
} from '../../../ui';
import {
  annualSavingPercent,
  chargeDisclosure,
  formatCredits,
  formatDate,
  formatFreeMonths,
  formatPromotionScope,
  formatAgentAllowance,
  formatSeatAllowance,
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
import { DiscountCodeField, type AppliedCode } from './DiscountCodeField';
import { TaxNote } from './TaxNote';
import { usePlanCheckout } from './usePlanCheckout';
import { usePlanActivation } from './usePlanActivation';

export interface PlanPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: PlanView[];
  currentPlan: PlanView | null;
  hasActiveSubscription: boolean;
  promotion: PromotionView | null;
  geo: BillingGeoView | null;
  botId?: number | null;
  /** Fired after any successful mutation so the page can re-read itself. */
  onChanged: (message: string) => void;
  /**
   * Fired when a paid plan goes live. Separate from `onChanged` because this
   * moment is celebrated inside the dialog, so the page should re-read itself
   * WITHOUT also raising a toast that repeats what the congratulations already
   * says, one of them under the modal scrim.
   */
  onActivated?: () => void;
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

  // Annual plans lead with the per-month equivalent, the figure a customer can
  // compare against the monthly toggle at a glance, and name the yearly total
  // and the saving in a line beneath it. This is how the price actually differs
  // between the two cycles: the headline number alone (₹28,188/yr vs ₹2,499/mo)
  // is not comparable, so it hid the discount the toggle exists to advertise.
  const annual = cycle === 'annual';
  // The per-month headline is rounded to a whole rupee (or dollar) so it reads
  // as a clean comparison figure rather than "₹790.83/mo". It is explicitly an
  // at-a-glance equivalent; the exact amount billed is the yearly total named
  // in full beneath it, so nothing about the charge is rounded away.
  const headlineMinor = annual
    ? Math.round(price.displayMinor / 12 / 100) * 100
    : price.displayMinor;
  const saving = annual ? annualSavingPercent(plan) : 0;

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-surface p-5',
        // A 2px ring without shifting layout. It used to be one shade darker
        // than the neighbours' hairline — 3.58:1 against 1.28:1 — which reads
        // as a rendering artefact rather than as "this is your plan".
        current ? 'border-plan shadow-[inset_0_0_0_1px_var(--color-plan)]' : 'border-border',
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
          {formatMoneyMinor(headlineMinor, price.displayCurrency)}
          <span className="ml-1 font-sans text-xs font-normal text-text-tertiary">/mo</span>
        </p>
      )}
      {/* On the annual cycle the headline is per-month, so the yearly total it
          bills — and the saving against paying monthly — are named right below
          it. Skipped for free (nothing is billed) and contact-sales tiers. */}
      {annual && !plan.isContactSales && price.displayMinor > 0 ? (
        <p className="mt-1 text-xs leading-snug text-text-secondary">
          {formatMoneyMinor(price.displayMinor, price.displayCurrency)} billed yearly
          {saving > 0 ? <span className="text-success"> · save {saving}%</span> : null}
        </p>
      ) : null}
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
      ) : null}

      <div className="mt-4">
        {plan.isContactSales ? (
          <a
            href={`mailto:${SALES_EMAIL}`}
            className={cn(buttonClass('secondary', 'md'), 'w-full')}
          >
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
  hasActiveSubscription,
  promotion,
  geo,
  botId = null,
  onChanged,
  onActivated,
  onBillingDetailsRequired,
}: PlanPickerDialogProps) {
  const [cycle, setCycle] = useState<BillingCycleKey>('monthly');
  // Tracks "an activation poll has been started for this attempt". Written
  // synchronously so `onDone` can read it in the same tick; see its comment.
  const activationStarted = useRef(false);

  const activation = usePlanActivation({
    botId,
    // The dialog names the plan in its own congratulations, so this only asks
    // the page to re-read itself; it deliberately does not raise a toast.
    onSettled: () => onActivated?.(),
  });

  // Held here rather than inside the field: the code has to survive that
  // component's own state and reach `checkout.submit` on whichever plan card
  // the buyer eventually presses.
  const [appliedCode, setAppliedCode] = useState<AppliedCode | null>(null);

  const checkout = usePlanCheckout({
    hasActiveSubscription,
    promotion,
    botId,
    onSuccess: onChanged,
    onDone: () => {
      // Only close when nothing is still settling. A dialog that closes over an
      // in-flight activation takes the one explanation the customer has with it.
      //
      // Read from a REF, not from `activation.blocking`. `onDone` is invoked
      // synchronously in the same handler that just called `activation.begin`,
      // so the `activation` object this closure captured is the pre-update
      // render's — `blocking` is still false there, always, and the dialog
      // closed over every single pending activation. A ref is written
      // synchronously, so it is the only signal that is already true by now.
      if (!activationStarted.current && !activation.blocking) onOpenChange(false);
    },
    onActivationPending: (plan, hint) => {
      activationStarted.current = true;
      activation.begin(plan, hint);
    },
    onBillingDetailsRequired: (missing) => {
      onOpenChange(false);
      onBillingDetailsRequired(missing);
    },
  });

  // Clear the previous attempt's terminal state whenever the dialog opens.
  // This used to live in `Dialog.onOpenChange`, which Base UI calls only for
  // its OWN dismissals — the page opens this dialog by setting `open`, so the
  // reset never ran and a stale error (or a settled congratulations, or the
  // `activationPending` latch that disables the footer) survived close→reopen.
  useEffect(() => {
    if (!open) return;
    activationStarted.current = false;
    checkout.reset();
    activation.reset();
    // Only on the open edge: adding the hooks here would re-reset on every
    // render they produce, wiping the very state this dialog is displaying.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const bestSaving = useMemo(() => maxAnnualSavingPercent(plans), [plans]);
  // The plan is genuinely live. This is the one moment the flow celebrates,
  // rather than dropping the customer back on the grid with the new plan merely
  // marked "Current" — the silent arrival the old flow shipped.
  const settled = activation.status === 'settled';
  // `checkout.activationPending` latches true and is only cleared by `reset()`,
  // so once the poll settled it still counted as "locked": the celebration
  // screen rendered with a disabled Done AND no close control (`dismissible`
  // follows `locked`), trapping the customer until they reloaded the page.
  // A settled activation is precisely when leaving must be possible.
  const locked =
    !settled && (checkout.submitting || checkout.activationPending || activation.blocking);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && locked) return;
        onOpenChange(next);
      }}
      // The one condition under which a dialog may refuse to close.
      dismissible={!locked}
      title={settled ? "You're all set" : 'Choose a plan'}
      description={
        settled
          ? undefined
          : 'Prices are per workspace, paid by card or UPI through Razorpay. A downgrade takes effect at the end of the period you have already paid for.'
      }
      size="xl"
      footer={
        <Button
          variant={settled ? 'primary' : 'ghost'}
          onClick={() => onOpenChange(false)}
          disabled={locked}
        >
          Done
        </Button>
      }
    >
      {settled ? (
        // The grid gave way to this mid-open, so it is announced rather than
        // merely rendered — a screen-reader user was told nothing otherwise.
        <div aria-live="polite">
          <PurchaseSuccess
            message={
              <>
                You’re on{' '}
                <span className="font-medium text-text-primary">
                  {activation.planName ?? 'your new plan'}
                </span>
                . Your new credits and limits are available now.
              </>
            }
          />
        </div>
      ) : (
      <div className="space-y-4">
        {/* Every price on this dialog is a BASE price. Razorpay debits the
            gross, and the gap between the two is only ever learned here —
            after the payment sheet opens it is too late to be a disclosure. */}
        <TaxNote />

        {/* The promotion, where the customer is choosing. It used to be a sixth
            banner on `/billing`, above the plan and — when a card had just
            failed — above the payment failure. */}
        {promotion && plans.length > 0 ? (
          <Alert tone="plan" title={promotion.name ?? 'Launch offer'}>
            {`Your first ${formatFreeMonths(promotion.freeCycles)} are free on ${formatPromotionScope(promotion, plans)}.`}
            {promotion.endsAt ? ` The offer closes on ${formatDate(promotion.endsAt)}.` : ''}
          </Alert>
        ) : null}

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

        {/* Above the grid, because the code changes every price under it.
            Hidden while a downgrade to Free is the only thing on offer: there
            is nothing for a discount to apply to. */}
        {plans.some((plan) => plan.isPaid) ? (
          <DiscountCodeField
            planId={null}
            billingCycle={cycle}
            applied={appliedCode}
            // The cards below show list prices and this dialog has no per-plan
            // quote to refetch, so the field states the discount itself rather
            // than leaving the buyer to infer it from a number that did not move.
            onApplied={setAppliedCode}
            disabled={locked}
          />
        ) : null}

        {/* Not `Grid`: `cols={3}` reaches three at `@5xl/page` (1024) and the
            widest dialog body in the system is 856px, so three plans would
            render as two and a widow. See the round-two report. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
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
                    : hasActiveSubscription
                      ? 'Switch to this plan'
                      : 'Subscribe'
                }
                onSelect={() => void checkout.submit(plan, cycle, appliedCode?.couponCode ?? null)}
              />
            );
          })}
        </div>
      </div>
      )}
    </Dialog>
  );
}
