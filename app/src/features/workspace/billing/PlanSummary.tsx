import { ArrowUpRight, Bot as BotIcon, Users } from 'lucide-react';
import {
  ABSENT,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardSection,
  Meter,
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
        description={
          plan
            ? `Billed ${cycle === 'annual' ? 'yearly' : 'monthly'}.`
            : 'This workspace has no paid subscription.'
        }
        actions={
          <>
            {subscription.cancelAtPeriodEnd ? (
              <Button size="sm" onClick={onResume}>
                Keep my plan
              </Button>
            ) : null}
            <Button size="sm" variant={subscription.cancelAtPeriodEnd ? 'secondary' : 'primary'} onClick={onChangePlan}>
              {plan?.isPaid ? 'Change plan' : 'Choose a plan'}
            </Button>
          </>
        }
      />

      <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
            {cycle === 'annual' ? 'Per year' : 'Per month'}
          </p>
          <p className="figure mt-1.5 text-2xl font-semibold leading-tight text-text-primary">
            {price ? formatMoneyMinor(price.displayMinor, price.displayCurrency) : ABSENT}
          </p>
          <p className="mt-1 text-xs text-text-tertiary">
            {price?.crossCurrency
              ? `Shown in ${price.displayCurrency}, charged in ${price.chargeCurrency}`
              : `Charged in ${CHARGE_CURRENCY}`}
          </p>
        </div>
        <div>
          <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
            {renewal.caption}
          </p>
          <p className="figure mt-1.5 text-2xl font-semibold leading-tight text-text-primary">
            {renewal.label}
          </p>
          <p className="mt-1 text-xs text-text-tertiary">
            {subscription.cancelAtPeriodEnd
              ? 'Then the workspace drops to Free'
              : trialOffer && subscription.status === 'trialing'
                ? trialOffer
                : 'Renews automatically'}
          </p>
        </div>
        <div>
          <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
            Credits included
          </p>
          <p className="figure mt-1.5 text-2xl font-semibold leading-tight text-text-primary">
            {plan ? formatCredits(plan.creditsPerMonth) : ABSENT}
          </p>
          <p className="mt-1 text-xs text-text-tertiary">Granted every month</p>
        </div>
        <div>
          <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
            Extra credits
          </p>
          <p className="figure mt-1.5 text-2xl font-semibold leading-tight text-text-primary">
            {overage ? formatMoneyMinor(plan?.overageRateMinor ?? 0, CHARGE_CURRENCY) : ABSENT}
          </p>
          <p className="mt-1 text-xs text-text-tertiary">
            {overage
              ? 'Per credit past your allowance'
              : 'This plan does not bill for overage; buy a top-up instead'}
          </p>
        </div>
      </CardBody>

      {disclosure ? (
        <CardSection className="bg-surface-sunken">
          <p className="text-prose text-text-secondary">{disclosure}</p>
        </CardSection>
      ) : null}

      <CardSection>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <BotIcon aria-hidden className="h-3.5 w-3.5 text-text-tertiary" />
              <h3 className="text-base font-medium text-text-primary">Chatbots</h3>
            </div>
            {agentQuota === undefined ? (
              <p className="text-xs text-text-secondary">
                This plan declares no chatbot allowance. Contact support before adding another.
              </p>
            ) : agentQuota === UNLIMITED_LIMIT ? (
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-text-secondary">In this workspace</span>
                <span className="figure text-xs font-medium text-text-primary">
                  {formatNumber(agentsUsed)}{' '}
                  <span className="text-text-tertiary">of unlimited</span>
                </span>
              </div>
            ) : (
              <Meter label="Chatbots in use" used={agentsUsed} limit={agentQuota} />
            )}
            <p className="mt-2 text-xs leading-snug text-text-secondary">
              {formatAgentAllowance(plan)} on this plan. Each additional chatbot is funded by its
              own subscription rather than a seat on this one.
            </p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={onAddChatbot}>
              Add a chatbot
              <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2">
              <Users aria-hidden className="h-3.5 w-3.5 text-text-tertiary" />
              <h3 className="text-base font-medium text-text-primary">Operator seats</h3>
            </div>
            {seatQuota === UNLIMITED_LIMIT ? (
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-text-secondary">Seats in use</span>
                <span className="figure text-xs font-medium text-text-primary">
                  {formatNumber(seatsUsed)} <span className="text-text-tertiary">of unlimited</span>
                </span>
              </div>
            ) : (
              <Meter
                label="Seats in use"
                used={seatsUsed}
                limit={Math.max(subscription.seats, seatQuota)}
              />
            )}
            <p className="mt-2 text-xs leading-snug text-text-secondary">
              {formatSeatAllowance(seatQuota)} included
              {plan && plan.extraSeatPriceMinor > 0 && seatQuota !== UNLIMITED_LIMIT
                ? `, then ${formatMoneyMinor(plan.extraSeatPriceMinor, CHARGE_CURRENCY)} per extra seat each month.`
                : '.'}
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={onManageSeats}
              disabled={!subscription.hasActive}
            >
              Manage seats
            </Button>
          </div>
        </div>
      </CardSection>

      {subscription.hasActive && !subscription.cancelAtPeriodEnd ? (
        <CardFooter className="justify-between">
          <p className="text-xs text-text-secondary">
            {trialOffer && subscription.status === 'trialing'
              ? `You are on a ${trialOffer.toLowerCase()}. No card has been charged yet.`
              : 'Cancelling keeps your plan until the end of the period you have paid for.'}
          </p>
          <Button size="sm" variant="danger" onClick={onCancel}>
            Cancel subscription
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
