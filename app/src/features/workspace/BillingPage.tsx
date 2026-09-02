import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Coins } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  Columns,
  ErrorState,
  Eyebrow,
  Grid,
  LoadingRows,
  LockedState,
  Meter,
  NavTabs,
  Page,
  PageHeader,
  Stack,
  StatRow,
  buttonClass,
  toast,
} from '../../ui';
import { cancelScheduledChange, resumeSubscription } from '../../services/api';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useBotContext } from '../../context/BotContext';
import { keys } from '../../query/keys';
import { BILLING_SECTIONS } from './billing/sections';
import { DunningBanner, ReauthBanner } from './billing/DunningBanner';
import { PlanSummary } from './billing/PlanSummary';
import { InvoicesSection } from './billing/InvoicesSection';
import { PaymentMethodsSection } from './billing/PaymentMethodsSection';
import { BillingIdentitySection } from './billing/BillingIdentitySection';
import { PlanPickerDialog } from './billing/PlanPickerDialog';
import { CancelSubscriptionDialog } from './billing/CancelSubscriptionDialog';
import { BrandingAddonCard } from './billing/BrandingAddonCard';
import { SeatDialog } from './billing/SeatDialog';
import { useBillingData } from './useBillingData';
import {
  errorMessage,
  errorStatus,
  formatCredits,
  formatDate,
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
  const client = useQueryClient();
  const { entitlements } = useEntitlements();

  /**
   * Which chatbot this page is reporting on.
   *
   * Read from the SHELL scope, not from a `?chatbot=` param of this page's own.
   * Billing used to carry a second selector labelled "Billing scope", so once
   * the rail gained a chatbot switcher there were two controls for one concept
   * on screen together — with different state, and the rail one having no
   * effect here. One control now drives every workspace surface.
   *
   * Null means the account-level view: shared credits, and the subscription
   * that funds chatbots with no plan of their own.
   */
  const { selectedBot, bots } = useBotContext();
  const botId = selectedBot?.id ?? null;
  /** A zero balance only silences chatbots that exist. */
  const hasChatbots = bots.length > 0;

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

  /**
   * How many operator seats are filled ON THE THING THIS PAGE IS BILLING.
   *
   * `entitlements.usage.operators` is an ACCOUNT-WIDE count, and everything
   * beside it here - the plan, its ceiling, the subscription - belongs to one
   * chatbot. Mixing them put a workspace's five operators against a chatbot's
   * two-seat plan, and then blocked a reduction from 2 seats to 1 that the
   * server would have accepted, because the seat dialog treated that number as
   * a floor. `resolveScopedPool` falls back to the account pool for a chatbot
   * with no ledger of its own, so the per-chatbot count is only real when the
   * pool that came back IS this chatbot's.
   */
  const scopedPool = botId !== null && pool?.botId === botId ? pool : null;
  const seatsFilled = scopedPool?.limitUsage?.operators ?? entitlements.usage?.operators ?? 0;
  const seatsFilledScope: 'chatbot' | 'workspace' =
    scopedPool?.limitUsage ? 'chatbot' : 'workspace';

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
    onError: (cause) => toast.error(errorMessage(cause, 'We could not restore your subscription.')),
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
        <PageHeader
          title="Billing" titleVisuallyHidden
          toolbar={<NavTabs label="Billing sections" items={BILLING_SECTIONS} />}
        />
        <LockedState
          title="Billing is only visible to workspace owners and admins"
          description="Ask an owner if you need a copy of an invoice."
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Billing" titleVisuallyHidden
        toolbar={
          <NavTabs
            label="Billing sections"
            items={BILLING_SECTIONS}
          />
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
          {/* At most two banners. Six could stack here — dunning, reauth, a
              data-retention deadline, a scheduled change, a pending
              cancellation and a promotion — at roughly 76px plus a 24px gap
              each, so 500px of banner could push the plan entirely off screen,
              with marketing sitting on top of a payment failure. One
              money-critical notice, first match wins, and one plan-state
              notice. The promotion belongs in the plan picker, which is where
              the customer is choosing. */}
          {billing.dunning.data?.pastDue ? (
            <DunningBanner
              dunning={billing.dunning.data}
              onRecheck={() => void billing.dunning.refetch()}
              onChoosePlan={() => setPicking(true)}
            />
          ) : core?.reauth ? (
            <ReauthBanner reauth={core.reauth} onAuthorise={() => setPicking(true)} />
          ) : subscription.dataRetentionUntil ? (
            <Alert tone="danger" title="Your workspace data is scheduled for deletion">
              {`Everything in this workspace is deleted on ${formatDate(subscription.dataRetentionUntil)}. Choose a plan before then to keep it.`}
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
                ? `You keep everything until ${formatDate(subscription.currentPeriodEnd)}.`
                : 'You keep everything until the end of the current period.'}
            </Alert>
          ) : subscription.scheduledChange ? (
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
                ? `The change takes effect on ${formatDate(subscription.scheduledChange.effectiveAt)}.`
                : 'The change takes effect at the end of your current billing period.'}
            </Alert>
          ) : null}

          {/* The plan and the credit balance are the two facts a customer opens
              this page for, so they stand side by side rather than 900px apart
              in one column of full-width cards. */}
          <Columns
            asideWidth="md"
            asideLabel="Credits this period"
            main={
              <PlanSummary
                subscription={subscription}
                plan={plan}
                geo={billing.geo.data ?? null}
                // Resolved from the CHATBOT LIST, never from the credit
                // pool. `resolveScopedPool` falls back to the account pool for
                // a chatbot with no plan of its own, and that pool is named
                // "Free & legacy chatbots" — so sourcing the name from it made
                // the card read "Funding Free & legacy chatbots", which names
                // no chatbot at all.
                scopedBotName={bots.find((b) => b.id === botId)?.name ?? null}
                seatsUsed={seatsFilled}
                seatsUsedScope={seatsFilledScope}
                grossSeatPriceMinor={core?.grossExtraSeatPriceMinor ?? null}
                onChangePlan={() => setPicking(true)}
                onManageSeats={() => setManagingSeats(true)}
                onCancel={() => setCancelling(true)}
                onResume={() => resume.mutate()}
              />
            }
            aside={
              /* Credits get a summary here and a page of their own next door.
                 This card answers one question — am I about to run out — and
                 then hands off rather than duplicating the Usage surface. */
              /* `h-full`: a grid item stretches, but the `Card` inside the
                 aside is a block of its own height, so the two cards in this
                 band ended 62px apart. */
              <Card className="h-full">
                <CardHeader
                  eyebrow="Credits"
                  title="This period"
                  titleAs="h2"
                  /* The scope, not the period. `StatRow` states the window once
                     as a caption under the figures it anchors, so repeating
                     `formatPeriod` here printed the same string twice 150px
                     apart — under a title that already says "This period". The
                     scope is the fact this header was missing: the page has a
                     chatbot selector, and which pool these two numbers belong to
                     was stated nowhere on the card. It also keeps this header
                     the same three lines as the plan header beside it, so the
                     two cards' first rules land on one line. */
                  description={botId === null ? 'Whole workspace' : pool?.name}
                  actions={
                    <Link to="/billing/usage" className={buttonClass('secondary', 'sm')}>
                      See usage
                      <ArrowRight aria-hidden />
                    </Link>
                  }
                />
                {billing.credits.isPending ? (
                  <CardBody>
                    <LoadingRows rows={2} />
                  </CardBody>
                ) : billing.credits.isError || !pool ? (
                  <ErrorState
                    size="panel"
                    title="We could not read your credit balance"
                    description={errorMessage(
                      billing.credits.error,
                      'The credits service did not answer.',
                    )}
                    onRetry={() => void billing.credits.refetch()}
                  />
                ) : (
                  <>
                    <CardBody flush>
                      {/* One vocabulary for credits across `/billing` and
                          `/billing/usage`: the same four `pool` fields were
                          carrying four different labels on two pages. */}
                      <StatRow
                        columns={2}
                        label="Credits this period"
                        period={formatPeriod(pool.periodStart, pool.resetsAt)}
                        items={[
                          {
                            label: 'Left to spend',
                            value: formatCredits(pool.totalRemaining),
                            size: 'lg',
                            tone:
                              pool.totalRemaining <= 0
                                ? 'danger'
                                : pool.lowBalance
                                  ? 'warning'
                                  : 'neutral',
                            hint:
                              pool.topupRemaining > 0
                                ? `${formatCredits(pool.planRemaining)} from your plan, ${formatCredits(pool.topupRemaining)} purchased`
                                : undefined,
                          },
                          {
                            label: 'Spent this period',
                            value: formatCredits(pool.periodCreditsUsed),
                            size: 'lg',
                          },
                        ]}
                      />
                    </CardBody>
                    <CardSection>
                      {pool.planGranted > 0 ? (
                        <>
                          {/* The eyebrow shares the figures' first baseline.
                              A vertically centred meter beside two top-aligned
                              tiles gave three peers in one row three different
                              first baselines. */}
                          <Eyebrow>Plan allowance</Eyebrow>
                          <Meter
                            className="mt-2"
                            hideLabel
                            label="Plan allowance"
                            // Both terms come from the ledger. The ceiling used
                            // to be `plan.credits_per_month`, so any account
                            // whose grant did not match that constant — one
                            // that never landed above all — rendered as a full
                            // bar reading "500 / 500" beside "Spent 0".
                            used={pool.planUsed}
                            limit={pool.planGranted}
                            unit="credits"
                          />
                        </>
                      ) : pool.allowanceInactive ? (
                        <p className="text-xs text-text-secondary">
                          No allowance is running right now, so there is nothing to spend against.
                          Choosing a plan starts one.
                        </p>
                      ) : (
                        <p className="text-xs text-text-secondary">
                          No monthly grant — everything this scope spends comes from purchased
                          credits.
                        </p>
                      )}
                    </CardSection>
                    {pool.lowBalance ? (
                      // A `CardSection`, and the notice rendered flat inside it.
                      // It used to be `<CardBody className="border-t">` — which
                      // is what `CardSection` is — wrapping an `Alert`, so the
                      // card drew a second hairline box 20px inside its own.
                      <CardSection className="flex flex-wrap items-center justify-between gap-3">
                        {/* A `Badge` and a sentence, not a `StatusDot`.
                            `StatusDot` puts its label in an `sr-only` span, so
                            the most consequential sentence on this page — your
                            chatbots have stopped answering — rendered as a bare
                            8px disc beside a button. */}
                        <p className="flex min-w-0 flex-wrap items-center gap-2">
                          <Badge tone={pool.totalRemaining <= 0 ? 'danger' : 'warning'} dot>
                            {pool.totalRemaining <= 0 ? 'Out of credits' : 'Nearly out'}
                          </Badge>
                          <span className="text-xs text-text-secondary">
                            {pool.totalRemaining > 0
                              ? `Refills ${formatDate(pool.resetsAt)}.`
                              : hasChatbots
                                ? 'Your chatbots have stopped answering.'
                                : 'A chatbot created now would have nothing to answer with.'}
                          </span>
                        </p>
                        {/* `topup_allowed` is a plan feature, and Trial and
                            Free do not carry it: `POST /credits/topup` answers
                            403 for both. Offering "Buy credits" here sent the
                            customer to a page whose only content was a notice
                            that they cannot buy any — a round trip to a refusal
                            at the moment they are most willing to pay. The
                            remedy for those plans is the plan picker, so that
                            is what the button opens. */}
                        {entitlements.features?.topup_allowed ? (
                          <Link to="/billing/usage" className={buttonClass('primary', 'sm')}>
                            <Coins aria-hidden />
                            Buy credits
                          </Link>
                        ) : (
                          <Button size="sm" onClick={() => setPicking(true)}>
                            Choose a plan
                          </Button>
                        )}
                      </CardSection>
                    ) : null}
                  </>
                )}
              </Card>
            }
          />

          {/* Beside the plan, because it is bought the same way and billed on
              the same mandate — but not among the plan cards, because no plan
              includes it. */}
          <BrandingAddonCard
            botId={botId}
            hasPaidPlan={!entitlements.is_free && Boolean(subscription)}
            onSettled={(message) => toast.success(message)}
          />

          {entitlements.limits?.credits === UNLIMITED_LIMIT ? (
            <Alert tone="plan">
              <Badge tone="plan">Unlimited</Badge> Your plan places no cap on credits.
            </Alert>
          ) : null}

          <InvoicesSection
            // Only when there is something to disambiguate: more than one
            // chatbot, and the history not already narrowed to one.
            showChatbot={scopeOptions.length > 2 && botId === null}
            invoices={billing.invoices.data ?? []}
            loading={billing.invoices.isPending}
            error={
              billing.invoices.isError
                ? errorMessage(billing.invoices.error, 'The billing history did not load.')
                : null
            }
            onRetry={() => void billing.invoices.refetch()}
          />

          {/* A five-item definition list and a one-item payment list are two
              half-width cards, not two full-width ones. */}
          <Grid cols={2} gap="section">
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
          </Grid>
        </Stack>
      )}

      {subscription ? (
        <>
          <PlanPickerDialog
            open={picking}
            onOpenChange={setPicking}
            plans={billing.plans.data ?? []}
            currentPlan={plan}
            hasActiveSubscription={subscription.hasActive}
            promotion={billing.promotion.data ?? null}
            geo={billing.geo.data ?? null}
            botId={botId}
            onChanged={announce}
            // A live plan is celebrated inside the dialog, so this only re-reads
            // the page; announce() would toast the same news a second time.
            onActivated={() => billing.refreshAll()}
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
            seatsUsed={seatsFilled}
            seatsUsedScope={seatsFilledScope}
            grossSeatPriceMinor={core?.grossExtraSeatPriceMinor ?? null}
            taxRateBps={core?.taxRateBps ?? null}
            onUpgrade={() => setPicking(true)}
            botId={botId}
            onChanged={(message) => {
              announce(message);
              void client.invalidateQueries({
                queryKey: keys.team.operators(),
              });
            }}
          />
        </>
      ) : null}
    </Page>
  );
}
