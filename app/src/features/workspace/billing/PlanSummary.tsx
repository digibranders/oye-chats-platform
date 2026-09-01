import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardSection,
  Meter,
  SettingRow,
  StatRow,
  formatNumber,
} from '../../../ui';
import {
  CHARGE_CURRENCY,
  chargeDisclosure,
  formatCredits,
  formatMoneyMinor,
  formatOverageRate,
  formatSeatAllowance,
  formatTrialOffer,
  getRenewalDisplay,
  humanizeStatus,
  resolvePlanPrice,
  statusTone,
  UNLIMITED_LIMIT,
  type BillingCycleKey,
  type BillingGeoView,
  type PlanView,
  type SubscriptionView,
} from '../billingModel';

export interface PlanSummaryProps {
  subscription: SubscriptionView;
  plan: PlanView | null;
  geo: BillingGeoView | null;
  /** The chatbot this subscription funds, when the page is scoped to one. */
  scopedBotName?: string | null;
  /** Operator seats currently filled. */
  seatsUsed: number;
  /**
   * What ONE extra seat debits per month, tax included, in the charge currency.
   * From the server, NOT `plan.extraSeatPriceMinor`: seats bill against a single
   * global add-on, so the charge is the canonical price, while the plan row
   * carries a copy that is `0` on every tier which sells no seats.
   */
  grossSeatPriceMinor: number | null;
  onChangePlan: () => void;
  onManageSeats: () => void;
  onCancel: () => void;
  onResume: () => void;
}

/**
 * What the workspace is paying for, and what that entitles it to.
 *
 * The panel this replaces showed a plan name, a price and a renewal date. Four
 * things it never showed are here, all of them configured per plan and all of
 * them things a customer is entitled to know before their allowance runs out:
 * the overage rate, the trial length, the chatbot allowance, and - when the
 * display currency is not the charge currency - the amount that will actually
 * be debited.
 *
 * The four headline figures are a `StatRow`. They used to be four hand-rolled
 * copies of `StatTile` — the same `mt-1.5`, the same `leading-tight` — but at
 * `text-2xl` where the credits figures 400px below were `text-xl`, so two
 * figure sizes shipped for peers on one page. The allowances below are two
 * `SettingRow`s, not two half-cards each with an icon, an `h3`, a meter, a
 * 25-word paragraph and a button.
 */
export function PlanSummary({
  subscription,
  plan,
  geo,
  scopedBotName = null,
  seatsUsed,
  grossSeatPriceMinor,
  onChangePlan,
  onManageSeats,
  onCancel,
  onResume,
}: PlanSummaryProps) {
  const cycle: BillingCycleKey = subscription.billingCycle === 'annual' ? 'annual' : 'monthly';
  const price = plan ? resolvePlanPrice(plan, cycle, geo) : null;
  const disclosure = price ? chargeDisclosure(price) : null;
  const renewal = getRenewalDisplay(subscription, subscription.cancelAtPeriodEnd);
  const overage = plan ? formatOverageRate(plan.overageRateMinor) : null;
  const trialOffer = plan ? formatTrialOffer(plan.trialDays) : null;
  const seatQuota = plan?.includedSeats ?? 0;
  // `limits.operators` is the hard cap on seats this plan can ever hold, and it
  // gates operator creation too. When it leaves no room above the included
  // count there is genuinely nothing to sell, so the row says "upgrade" rather
  // than quoting a per-seat price for a purchase the server would refuse.
  const seatCeiling = plan?.limits?.operators;
  const seatsBuyable =
    seatQuota !== UNLIMITED_LIMIT &&
    typeof seatCeiling === 'number' &&
    seatCeiling !== UNLIMITED_LIMIT &&
    seatCeiling > seatQuota;

  return (
    <Card>
      <CardHeader
        eyebrow="Your plan"
        title={
          <span className="flex flex-wrap items-center gap-2">
            {plan?.name ?? 'No plan'}
            <Badge tone={statusTone(subscription.status)} dot>
              {humanizeStatus(subscription.status)}
            </Badge>
            {subscription.cancelAtPeriodEnd ? <Badge tone="warning">Ending</Badge> : null}
          </span>
        }
        titleAs="h2"
        // Say WHOSE plan this is. The same card shows a chatbot's own
        // subscription when the page is scoped to one, and the account-level
        // subscription when it is not — and the account-level one may be a
        // different plan from anything a chatbot is visibly on. Unlabelled, a
        // customer cannot tell which of the two they are reading.
        //
        // `bot_id IS NULL` on a subscription is not a gap. It funds whichever
        // chatbots have no plan of their own, which is why it needs saying
        // rather than hiding: otherwise it reads as a charge for nothing.
        description={
          plan
            ? scopedBotName
              ? `Funding ${scopedBotName}. Each chatbot has its own subscription.`
              : 'Your account-level subscription. It funds any chatbot that has no plan of its own, and each chatbot on a paid plan has its own subscription.'
            : 'This workspace has no paid subscription.'
        }
        actions={
          <>
            {subscription.cancelAtPeriodEnd ? (
              <Button size="sm" onClick={onResume}>
                Keep my plan
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={subscription.cancelAtPeriodEnd ? 'secondary' : 'primary'}
              onClick={onChangePlan}
            >
              {plan?.isPaid ? 'Change plan' : 'Choose a plan'}
            </Button>
          </>
        }
      />

      <CardBody flush>
        <StatRow
          label="Your plan at a glance"
          columns={4}
          period={cycle === 'annual' ? 'Billed yearly' : 'Billed monthly'}
          items={[
            {
              label: 'Price',
              value: price
                ? formatMoneyMinor(price.displayMinor, price.displayCurrency)
                : undefined,
              period: cycle === 'annual' ? 'Per year' : 'Per month',
              size: 'lg',
              // Only when the two currencies genuinely differ. "Charged in INR"
              // under a price already printed in INR is a line of type carrying
              // nothing.
              hint: price?.crossCurrency ? `Charged in ${price.chargeCurrency}` : undefined,
            },
            {
              label: renewal.caption,
              value: renewal.label,
              size: 'lg',
              period: subscription.cancelAtPeriodEnd
                ? 'Then the workspace drops to Free'
                : trialOffer && subscription.status === 'trialing'
                  ? trialOffer
                  : 'Renews automatically',
            },
            {
              label: 'Credits included',
              value: plan ? formatCredits(plan.creditsPerMonth) : undefined,
              size: 'lg',
            },
            {
              label: 'Extra credits',
              value: overage
                ? formatMoneyMinor(plan?.overageRateMinor ?? 0, CHARGE_CURRENCY)
                : undefined,
              size: 'lg',
              period: overage ? undefined : 'No overage, buy a top-up',
            },
          ]}
        />
      </CardBody>

      {disclosure ? (
        <CardSection tone="sunken">
          <p className="text-prose text-text-secondary">{disclosure}</p>
        </CardSection>
      ) : null}

      <CardBody flush>

        <SettingRow
          label="Operator seats"
          description={
            seatQuota === UNLIMITED_LIMIT
              ? 'Unlimited operator seats.'
              : seatsBuyable && grossSeatPriceMinor
                ? `${formatSeatAllowance(seatQuota)} included, then ${formatMoneyMinor(grossSeatPriceMinor, CHARGE_CURRENCY)} each per month.`
                : `${formatSeatAllowance(seatQuota)} included. Upgrade for more.`
          }
          controlWidth="auto"
        >
          <div className="flex w-full items-center justify-end gap-3">
            {seatQuota === UNLIMITED_LIMIT ? (
              <span className="figure text-sm font-medium text-text-primary">
                {formatNumber(seatsUsed)} <span className="text-text-tertiary">of unlimited</span>
              </span>
            ) : (
              <Meter
                className="w-40"
                label="Operator seats in use"
                hideLabel
                size="sm"
                used={seatsUsed}
                /* The seats this workspace HOLDS: the plan's included count plus
                   any it has paid for. Not `max(seats, quota)`, which reported a
                   phantom seat on a plan including none, because the mirror it
                   read was itself defaulted to one. */
                limit={Math.max(subscription.seats, seatQuota, 0)}
              />
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={onManageSeats}
              disabled={!subscription.hasActive}
            >
              Manage
            </Button>
          </div>
        </SettingRow>
      </CardBody>

      {subscription.hasActive && !subscription.cancelAtPeriodEnd ? (
        <CardFooter className="justify-between">
          {/* The cancellation consequence lives in `CancelSubscriptionDialog`,
              with the real date in it. Repeating it here put the same sentence
              beside the button that opens the dialog that says it. */}
          <p className="text-xs text-text-secondary">
            {trialOffer && subscription.status === 'trialing' ? 'Trial, no card charged yet.' : ''}
          </p>
          <Button size="sm" variant="danger" onClick={onCancel}>
            Cancel subscription
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
