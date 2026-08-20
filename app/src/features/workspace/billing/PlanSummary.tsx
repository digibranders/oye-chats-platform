import { ArrowUpRight } from 'lucide-react';
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
  formatAgentAllowance,
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
  /** Chatbots currently active in the workspace, from the entitlements usage map. */
  agentsUsed: number;
  /** Operator seats currently filled. */
  seatsUsed: number;
  onChangePlan: () => void;
  onManageSeats: () => void;
  onCancel: () => void;
  onResume: () => void;
  onAddChatbot: () => void;
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
  agentsUsed,
  seatsUsed,
  onChangePlan,
  onManageSeats,
  onCancel,
  onResume,
  onAddChatbot,
}: PlanSummaryProps) {
  const cycle: BillingCycleKey = subscription.billingCycle === 'annual' ? 'annual' : 'monthly';
  const price = plan ? resolvePlanPrice(plan, cycle, geo) : null;
  const disclosure = price ? chargeDisclosure(price) : null;
  const renewal = getRenewalDisplay(subscription, subscription.cancelAtPeriodEnd);
  const overage = plan ? formatOverageRate(plan.overageRateMinor) : null;
  const trialOffer = plan ? formatTrialOffer(plan.trialDays) : null;
  const agentQuota = plan?.limits.bots;
  const seatQuota = plan?.includedSeats ?? 0;

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
        description={plan ? undefined : 'This workspace has no paid subscription.'}
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
              period: overage ? undefined : 'No overage — buy a top-up',
            },
          ]}
        />
      </CardBody>

      {disclosure ? (
        <CardSection className="bg-surface-sunken">
          <p className="text-prose text-text-secondary">{disclosure}</p>
        </CardSection>
      ) : null}

      <CardBody flush>
        <SettingRow
          label="Chatbots"
          description={
            agentQuota === undefined
              ? 'This plan declares no chatbot allowance — ask support before adding another.'
              : `${formatAgentAllowance(plan)}. Each extra chatbot has its own subscription.`
          }
          controlWidth="auto"
        >
          <div className="flex w-full items-center justify-end gap-3">
            {agentQuota === undefined ? null : agentQuota === UNLIMITED_LIMIT ? (
              <span className="figure text-sm font-medium text-text-primary">
                {formatNumber(agentsUsed)} <span className="text-text-tertiary">of unlimited</span>
              </span>
            ) : (
              <Meter
                className="w-40"
                label="In use"
                size="sm"
                used={agentsUsed}
                limit={agentQuota}
              />
            )}
            <Button size="sm" variant="secondary" onClick={onAddChatbot}>
              Add
              <ArrowUpRight aria-hidden />
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label="Operator seats"
          description={
            plan && plan.extraSeatPriceMinor > 0 && seatQuota !== UNLIMITED_LIMIT
              ? `${formatSeatAllowance(seatQuota)} included, then ${formatMoneyMinor(plan.extraSeatPriceMinor, CHARGE_CURRENCY)} each per month.`
              : `${formatSeatAllowance(seatQuota)} included.`
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
                label="In use"
                size="sm"
                used={seatsUsed}
                limit={Math.max(subscription.seats, seatQuota)}
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
            {trialOffer && subscription.status === 'trialing' ? 'Trial — no card charged yet.' : ''}
          </p>
          <Button size="sm" variant="danger" onClick={onCancel}>
            Cancel subscription
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
