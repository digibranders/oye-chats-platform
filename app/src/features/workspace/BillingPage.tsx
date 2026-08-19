import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Coins } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  LoadingRows,
  LockedState,
  Meter,
  Page,
  PageHeader,
  Select,
  Stack,
  StatTile,
  buttonClass,
  toast,
} from '../../ui';
import { cancelScheduledChange, resumeSubscription } from '../../services/api';
import { useEntitlements } from '../../hooks/useEntitlements';
import { keys } from '../../query/keys';
import { BillingNav } from './billing/BillingNav';
import { DunningBanner, ReauthBanner } from './billing/DunningBanner';
import { PlanSummary } from './billing/PlanSummary';
import { InvoicesSection } from './billing/InvoicesSection';
import { PaymentMethodsSection } from './billing/PaymentMethodsSection';
import { BillingIdentitySection } from './billing/BillingIdentitySection';
import { PlanPickerDialog } from './billing/PlanPickerDialog';
import { CancelSubscriptionDialog } from './billing/CancelSubscriptionDialog';
import { SeatDialog } from './billing/SeatDialog';
import { useBillingData } from './useBillingData';
import {
  errorMessage,
  errorStatus,
  formatCredits,
  formatDate,
  formatFreeMonths,
  formatPromotionScope,
  UNLIMITED_LIMIT,
} from './billingModel';
import { formatPeriod, resolveScopedPool } from './usage-model';

/**
 * `/billing` - what this workspace is paying, and everything that follows from it.
 *
 * The page it replaces was 1,400 lines that answered one question ("which plan
 * am I on") and hid four that matter more: whether the last payment actually
 * went through, what the tax on each invoice was, how many chatbots the plan
 * allows, and what a credit costs once the allowance runs out. Every one of
 * those was already in the API.
 *
 * The scope selector is deliberate and deliberately in the URL. This product
 * sells per-chatbot subscriptions, so "the plan" is ambiguous the moment a
 * workspace has two - and the previous surface resolved that ambiguity from the
 * shell's agent switcher, which is exactly the pattern that had the Experience
 * tab streaming replies from the wrong chatbot. Here the object being billed is
 * named on screen and addressable by link.
 */
export function BillingPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { entitlements } = useEntitlements();

  const scopeParam = params.get('chatbot');
  const botId = scopeParam && /^\d+$/.test(scopeParam) ? Number(scopeParam) : null;

  const billing = useBillingData(botId);
  const [picking, setPicking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [managingSeats, setManagingSeats] = useState(false);
  const [demandedFields, setDemandedFields] = useState<string[] | null>(null);

  const core = billing.core.data;
  const subscription = core?.subscription ?? null;
  const plan = core?.plan ?? null;
  const balance = billing.credits.data ?? null;
  const pool = balance ? resolveScopedPool(balance, botId) : null;

  const scopeOptions = useMemo(() => {
    const perAgent = balance?.botCredits ?? [];
    return [
      { value: '', label: 'Whole workspace' },
      ...perAgent
        .filter((entry) => entry.botId !== null)
        .map((entry) => ({ value: String(entry.botId), label: entry.name })),
    ];
  }, [balance]);

  function announce(message: string) {
    toast.success(message);
    billing.refreshAll();
  }

  const resume = useMutation({
    mutationFn: () => resumeSubscription(botId),
    onSuccess: () => announce('Your subscription will continue. Nothing was interrupted.'),
    onError: (cause) =>
      toast.error(errorMessage(cause, 'We could not restore your subscription.')),
  });

  const dropScheduled = useMutation({
    mutationFn: () => cancelScheduledChange(),
    onSuccess: () => announce('The scheduled plan change has been called off.'),
    onError: (cause) => toast.error(errorMessage(cause, 'We could not call that change off.')),
  });

  // Billing is never plan-gated - it is how a free workspace upgrades in the
  // first place - so the only forbidden case is a seat that is not entitled to
  // read the workspace's money at all.
  if (billing.core.isError && errorStatus(billing.core.error) === 403) {
    return (
      <Page width="wide">
        <PageHeader title="Billing" toolbar={<BillingNav />} />
        <LockedState
          title="Billing is only visible to workspace owners and admins"
          description="Your seat can use the inbox and the leads it produces, but not the workspace's plan, invoices or payment methods. Ask an owner if you need a copy of an invoice."
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Billing"
        description="Your plan, what it entitles you to, and every charge we have issued."
        toolbar={<BillingNav />}
        actions={
          scopeOptions.length > 1 ? (
            <Select
              aria-label="Billing scope"
              size="sm"
              options={scopeOptions}
              value={scopeParam ?? ''}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.value) next.set('chatbot', event.target.value);
                else next.delete('chatbot');
                setParams(next, { replace: true });
              }}
            />
          ) : undefined
        }
      />

      {billing.core.isPending ? (
        <Card>
          <CardBody>
            <LoadingRows rows={4} />
          </CardBody>
        </Card>
      ) : billing.core.isError || !subscription ? (
        <Card>
          <ErrorState
            title="We could not load your billing information"
            description={errorMessage(
              billing.core.error,
              'The subscription service did not answer. Nothing has changed on your account.',
            )}
            onRetry={() => void billing.core.refetch()}
          />
        </Card>
      ) : (
        <Stack>
          {/* Money problems first. A customer whose card failed needs to know
              that before they read anything else on this page. */}
          {billing.dunning.data?.pastDue ? (
            <DunningBanner
              dunning={billing.dunning.data}
              onRecheck={() => void billing.dunning.refetch()}
              onChoosePlan={() => setPicking(true)}
            />
          ) : null}

          {core?.reauth ? (
            <ReauthBanner reauth={core.reauth} onAuthorise={() => setPicking(true)} />
          ) : null}

          {subscription.dataRetentionUntil ? (
            <Alert tone="danger" title="Your workspace data is scheduled for deletion">
              {`Your trial has ended and everything in this workspace is deleted on ${formatDate(subscription.dataRetentionUntil)}. Choose a plan before then to keep your chatbots, documents and conversations.`}
            </Alert>
          ) : null}

          {subscription.scheduledChange ? (
            <Alert
              tone="neutral"
              title={`Switching to ${subscription.scheduledChange.planName ?? 'another plan'}`}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => dropScheduled.mutate()}
                  disabled={dropScheduled.isPending}
                >
                  {dropScheduled.isPending ? 'Working…' : 'Call it off'}
                </Button>
              }
            >
              {subscription.scheduledChange.effectiveAt
                ? `The change takes effect on ${formatDate(subscription.scheduledChange.effectiveAt)}. Until then nothing about your current plan changes.`
                : 'The change takes effect at the end of your current billing period.'}
            </Alert>
          ) : null}

          {subscription.cancelAtPeriodEnd ? (
            <Alert
              tone="warning"
              title="Your subscription is set to end"
              action={
                <Button size="sm" onClick={() => resume.mutate()} disabled={resume.isPending}>
                  {resume.isPending ? 'Working…' : 'Keep my plan'}
                </Button>
              }
            >
              {subscription.currentPeriodEnd
                ? `You keep everything until ${formatDate(subscription.currentPeriodEnd)}, and you can change your mind until then.`
                : 'You keep everything until the end of the current period, and you can change your mind until then.'}
            </Alert>
          ) : null}

          {billing.promotion.data && billing.plans.data ? (
            <Alert tone="plan" title={billing.promotion.data.name ?? 'Launch offer'}>
              {`Your first ${formatFreeMonths(billing.promotion.data.freeCycles)} are free on ${formatPromotionScope(billing.promotion.data, billing.plans.data)}. `}
              {billing.promotion.data.endsAt
                ? `The offer closes on ${formatDate(billing.promotion.data.endsAt)}.`
                : ''}
            </Alert>
          ) : null}

          <PlanSummary
            subscription={subscription}
            plan={plan}
            geo={billing.geo.data ?? null}
            agentsUsed={entitlements.usage?.bots ?? 0}
            seatsUsed={entitlements.usage?.operators ?? 0}
            onChangePlan={() => setPicking(true)}
            onManageSeats={() => setManagingSeats(true)}
            onCancel={() => setCancelling(true)}
            onResume={() => resume.mutate()}
            onAddChatbot={() => navigate('/chatbots?new=1')}
          />

          {/* Credits get a summary here and a page of their own next door. This
              card exists to answer one question - am I about to run out - and
              then hand off rather than duplicate the Usage surface. */}
          <Card>
            <CardHeader
              eyebrow="Credits"
              title="This period"
              titleAs="h2"
              description={
                pool
                  ? formatPeriod(pool.periodStart, pool.resetsAt)
                  : 'Your plan allowance and anything you have bought on top of it.'
              }
              actions={
                <Link to="/billing/usage" className={buttonClass('secondary', 'sm')}>
                  See usage
                  <ArrowRight aria-hidden className="h-3.5 w-3.5" />
                </Link>
              }
            />
            {billing.credits.isPending ? (
              <CardBody>
                <LoadingRows rows={2} />
              </CardBody>
            ) : billing.credits.isError || !pool ? (
              <ErrorState
                compact
                title="We could not read your credit balance"
                description={errorMessage(billing.credits.error, 'The credits service did not answer.')}
                onRetry={() => void billing.credits.refetch()}
              />
            ) : (
              <CardBody className="grid gap-6 sm:grid-cols-3">
                <StatTile
                  label="Credits left"
                  value={formatCredits(pool.totalRemaining)}
                  period={formatPeriod(pool.periodStart, pool.resetsAt)}
                  tone={pool.totalRemaining <= 0 ? 'danger' : balance?.lowBalance ? 'warning' : 'neutral'}
                  hint={
                    pool.topupRemaining > 0
                      ? `${formatCredits(pool.planRemaining)} from your plan, ${formatCredits(pool.topupRemaining)} purchased`
                      : undefined
                  }
                />
                <StatTile
                  label="Used this period"
                  value={formatCredits(pool.periodCreditsUsed)}
                  period={formatPeriod(pool.periodStart, pool.resetsAt)}
                />
                <div className="flex flex-col justify-center">
                  {pool.monthlyGrant > 0 ? (
                    <Meter
                      label="Plan allowance"
                      used={Math.min(pool.monthlyGrant - pool.planRemaining, pool.monthlyGrant)}
                      limit={pool.monthlyGrant}
                      unit="credits"
                    />
                  ) : (
                    <p className="text-xs text-text-secondary">
                      This scope has no monthly grant, so everything it spends comes from purchased
                      credits.
                    </p>
                  )}
                </div>
              </CardBody>
            )}
            {balance && balance.lowBalance ? (
              <CardBody className="border-t border-border">
                <Alert
                  tone={pool && pool.totalRemaining <= 0 ? 'danger' : 'warning'}
                  title={
                    pool && pool.totalRemaining <= 0
                      ? 'Your chatbots have stopped answering'
                      : 'You are close to running out of credits'
                  }
                  action={
                    <Link to="/billing/usage" className={buttonClass('primary', 'sm')}>
                      <Coins aria-hidden className="h-3.5 w-3.5" />
                      Buy credits
                    </Link>
                  }
                >
                  {pool && pool.totalRemaining <= 0
                    ? 'A chatbot with no credits cannot reply to a visitor. Buy a top-up or upgrade to restore it immediately.'
                    : `Less than a fifth of this period's allowance is left. It refills on ${formatDate(pool?.resetsAt ?? null)}.`}
                </Alert>
              </CardBody>
            ) : null}
          </Card>

          {entitlements.limits?.credits === UNLIMITED_LIMIT ? (
            <Alert tone="plan">
              <Badge tone="plan">Unlimited</Badge> Your plan places no cap on credits.
            </Alert>
          ) : null}

          <InvoicesSection
            invoices={billing.invoices.data ?? []}
            loading={billing.invoices.isPending}
            error={
              billing.invoices.isError
                ? errorMessage(billing.invoices.error, 'The billing history did not load.')
                : null
            }
            onRetry={() => void billing.invoices.refetch()}
          />

          <BillingIdentitySection
            details={billing.details.data?.view ?? null}
            raw={billing.details.data?.raw ?? null}
            loading={billing.details.isPending}
            error={
              billing.details.isError
                ? errorMessage(billing.details.error, 'The billing details did not load.')
                : null
            }
            demandedFields={demandedFields}
            onDemandCleared={() => setDemandedFields(null)}
            fallbackCountry={billing.geo.data?.country ?? null}
          />

          <PaymentMethodsSection
            provider={subscription.paymentProvider}
            hasPaidPlan={subscription.hasActive && (plan?.isPaid ?? false)}
          />
        </Stack>
      )}

      {subscription ? (
        <>
          <PlanPickerDialog
            open={picking}
            onOpenChange={setPicking}
            plans={billing.plans.data ?? []}
            currentPlan={plan}
            currentStatus={subscription.status || null}
            hasActiveSubscription={subscription.hasActive}
            trialUsed={core?.trialUsed ?? false}
            promotion={billing.promotion.data ?? null}
            geo={billing.geo.data ?? null}
            botId={botId}
            onChanged={announce}
            onBillingDetailsRequired={(missing) => setDemandedFields(missing)}
          />
          <CancelSubscriptionDialog
            open={cancelling}
            onOpenChange={setCancelling}
            subscription={subscription}
            plan={plan}
            topupCreditsRemaining={pool?.topupRemaining ?? 0}
            botId={botId}
            onCancelled={announce}
          />
          <SeatDialog
            open={managingSeats}
            onOpenChange={setManagingSeats}
            plan={plan}
            currentSeats={subscription.seats}
            seatsUsed={entitlements.usage?.operators ?? 0}
            botId={botId}
            onChanged={(message) => {
              announce(message);
              void client.invalidateQueries({ queryKey: keys.team.operators() });
            }}
          />
        </>
      ) : null}
    </Page>
  );
}
