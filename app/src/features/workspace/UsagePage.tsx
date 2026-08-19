import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Coins, History } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardFooter,
  CardSection,
  DataTable,
  ErrorState,
  LoadingRows,
  Meter,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  Select,
  Stack,
  StatTile,
  buttonClass,
  formatDateTime,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { useEntitlements } from '../../hooks/useEntitlements';
import { BillingNav } from './billing/BillingNav';
import { ConsumptionTrend } from './usage/ConsumptionTrend';
import { CreditCosts } from './usage/CreditCosts';
import { TopupDialog } from './usage/TopupDialog';
import {
  DEFAULT_TREND_WINDOW,
  HISTORY_PAGE_SIZE,
  TREND_WINDOWS,
  useUsageData,
  type TrendWindow,
} from './useUsageData';
import { useBillingGeo } from './useBillingData';
import {
  formatCredits,
  formatDate,
  formatPeriod,
  resolveScopedPool,
  type LedgerRow,
  type PoolCredit,
} from './usage-model';
import { UNLIMITED_LIMIT, errorMessage, errorStatus } from './billingModel';

/** The plan ceilings the balance endpoint reports usage against, per agent. */
const AGENT_LIMITS = [
  { key: 'operators', label: 'Operator seats' },
  { key: 'documents', label: 'Documents trained' },
  { key: 'leads', label: 'Leads captured this period' },
] as const;

function parseWindow(raw: string | null): TrendWindow {
  const value = Number(raw);
  return (TREND_WINDOWS as readonly number[]).includes(value)
    ? (value as TrendWindow)
    : DEFAULT_TREND_WINDOW;
}

function PlanLimitsCard({ pool }: { pool: PoolCredit }) {
  if (!pool.planLimits || !pool.limitUsage) return null;
  const rows = AGENT_LIMITS.map((limit) => ({
    ...limit,
    // A plan row that declares no such quota is reported as unknown, not as
    // zero: "this plan says nothing about documents" and "this plan allows no
    // documents" are different facts.
    limit: pool.planLimits?.[limit.key],
    used: pool.limitUsage?.[limit.key] ?? 0,
  })).filter((row) => row.limit !== undefined);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader
        eyebrow="Plan limits"
        title={`${pool.name} allowances`}
        titleAs="h3"
        description={`On ${pool.planName ?? 'its plan'}. Counts cover ${formatPeriod(pool.periodStart, pool.resetsAt).toLowerCase()}.`}
      />
      <CardBody className="space-y-4">
        {rows.map((row) =>
          row.limit === UNLIMITED_LIMIT ? (
            <div key={row.key} className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-text-secondary">{row.label}</span>
              <span className="figure text-xs font-medium text-text-primary">
                {formatNumber(row.used)} <span className="text-text-tertiary">of unlimited</span>
              </span>
            </div>
          ) : (
            <Meter key={row.key} label={row.label} used={row.used} limit={row.limit as number} />
          ),
        )}
      </CardBody>
    </Card>
  );
}

/**
 * `/billing/usage` - where the credits went.
 *
 * Three things this page owes the customer that the one it replaces did not
 * give them. The cost of every metered action, read live from the server rather
 * than hard-coded in a component while a super-admin could retune it. The
 * period each figure covers, on the figure. And a credit history that can be
 * scoped to one chatbot - the ledger is bot-scoped in the database and was
 * workspace-scoped in the UI, so a customer running several chatbots on
 * separate subscriptions could see the total and never the split.
 */
export function UsagePage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { entitlements } = useEntitlements();

  const scopeParam = params.get('chatbot');
  const botId = scopeParam && /^\d+$/.test(scopeParam) ? Number(scopeParam) : null;
  const days = parseWindow(params.get('window'));
  const page = Math.max(Number(params.get('page')) || 1, 1);

  const usage = useUsageData({ botId, days, page });
  const geo = useBillingGeo();
  const [toppingUp, setToppingUp] = useState(false);

  // A full page is the only signal the endpoint gives that older movements may
  // exist. When it turns out none do, the next page says so rather than the
  // pager having claimed a total it was never told.
  const pageRows = usage.ledger.data ?? [];
  const hasOlder = pageRows.length === HISTORY_PAGE_SIZE;

  const balance = usage.balance.data ?? null;
  const pool = balance ? resolveScopedPool(balance, botId) : null;
  const scopeLabel = botId === null ? 'this workspace' : (pool?.name ?? 'this chatbot');

  const scopeOptions = useMemo(
    () => [
      { value: '', label: 'Whole workspace' },
      ...(balance?.botCredits ?? [])
        .filter((entry) => entry.botId !== null)
        .map((entry) => ({ value: String(entry.botId), label: entry.name })),
    ],
    [balance],
  );

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // A scope or window change is a different question, so the pager resets.
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  }

  const ledgerColumns: readonly Column<LedgerRow>[] = [
    {
      key: 'createdAt',
      header: 'When',
      width: '12rem',
      render: (row) => <span className="figure text-sm">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'label',
      header: 'Movement',
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm text-text-primary">{row.label}</span>
          {row.note ? <span className="truncate text-xs text-text-tertiary">{row.note}</span> : null}
        </span>
      ),
    },
    {
      key: 'tone',
      header: 'Kind',
      width: '8rem',
      secondary: true,
      render: (row) => (
        <Badge tone={row.tone === 'credit' ? 'success' : row.tone === 'expiry' ? 'warning' : 'neutral'}>
          {row.tone === 'credit' ? 'Added' : row.tone === 'expiry' ? 'Expired' : 'Spent'}
        </Badge>
      ),
    },
    {
      key: 'delta',
      header: 'Credits',
      align: 'right',
      width: '8rem',
      render: (row) => (
        <span
          className={`figure text-sm font-medium ${row.delta > 0 ? 'text-success' : 'text-text-primary'}`}
        >
          {row.delta > 0 ? '+' : ''}
          {formatNumber(row.delta)}
        </span>
      ),
    },
  ];

  if (usage.balance.isError && errorStatus(usage.balance.error) === 403) {
    return (
      <Page width="wide">
        <PageHeader title="Usage" toolbar={<BillingNav />} />
        <Card>
          <ErrorState
            title="Your seat cannot read this workspace's usage"
            description="Credit balances and spend are visible to owners and admins. Ask one of them if you need the numbers."
          />
        </Card>
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Usage"
        description="What your chatbots are spending, on what, and how much of your allowance is left."
        toolbar={<BillingNav />}
        actions={
          <>
            {scopeOptions.length > 1 ? (
              <Select
                aria-label="Usage scope"
                size="sm"
                options={scopeOptions}
                value={scopeParam ?? ''}
                onChange={(event) => setParam('chatbot', event.target.value || null)}
              />
            ) : null}
            <Button
              size="sm"
              onClick={() => setToppingUp(true)}
              disabled={!entitlements.features?.topup_allowed}
            >
              <Coins aria-hidden className="h-4 w-4" />
              Buy credits
            </Button>
          </>
        }
      />

      {usage.balance.isPending ? (
        <Card>
          <CardBody>
            <LoadingRows rows={4} />
          </CardBody>
        </Card>
      ) : usage.balance.isError || !pool || !balance ? (
        <Card>
          <ErrorState
            title="We could not load your usage"
            description={errorMessage(
              usage.balance.error,
              'The credits service did not answer. Your balance has not changed.',
            )}
            onRetry={() => void usage.balance.refetch()}
          />
        </Card>
      ) : (
        <Stack>
          {!entitlements.features?.topup_allowed ? (
            <Alert
              tone="plan"
              title="Top-ups are not available on your plan"
              action={
                <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                  See plans
                </Link>
              }
            >
              You can still spend the credits your plan grants each month. Buying extra credits
              outright is available from the paid plans upwards.
            </Alert>
          ) : null}

          <Card>
            <CardHeader
              eyebrow={botId === null ? 'Whole workspace' : pool.name}
              title="Credits"
              titleAs="h2"
              description={formatPeriod(pool.periodStart, pool.resetsAt)}
            />
            <CardBody className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Left to spend"
                value={formatCredits(pool.totalRemaining)}
                period={formatPeriod(pool.periodStart, pool.resetsAt)}
                tone={
                  pool.totalRemaining <= 0 ? 'danger' : balance.lowBalance ? 'warning' : 'neutral'
                }
                size="lg"
              />
              <StatTile
                label="From your plan"
                value={formatCredits(pool.planRemaining)}
                period={
                  pool.resetsAt ? `Refills ${formatDate(pool.resetsAt)}` : 'No refill date on record'
                }
              />
              <StatTile
                label="Purchased"
                value={formatCredits(pool.topupRemaining)}
                period={
                  pool.soonestExpiry
                    ? `Earliest expiry ${formatDate(pool.soonestExpiry)}`
                    : 'Bought outright'
                }
              />
              <StatTile
                label="Spent this period"
                value={formatCredits(pool.periodCreditsUsed)}
                period={formatPeriod(pool.periodStart, pool.resetsAt)}
              />
            </CardBody>
            <CardSection>
              {pool.monthlyGrant > 0 ? (
                <Meter
                  label={`Plan allowance used (${formatCredits(pool.monthlyGrant)} a month)`}
                  used={Math.min(pool.monthlyGrant - pool.planRemaining, pool.monthlyGrant)}
                  limit={pool.monthlyGrant}
                  unit="credits"
                />
              ) : (
                <p className="text-xs text-text-secondary">
                  This scope has no monthly grant. Everything it spends comes from purchased
                  credits.
                </p>
              )}
            </CardSection>
            {pool.totalRemaining <= 0 ? (
              <CardSection>
                <Alert tone="danger" title="This chatbot has stopped answering">
                  A chatbot with no credits cannot reply to a visitor. Buy a top-up or move to a
                  larger plan to restore it immediately.
                </Alert>
              </CardSection>
            ) : balance.lowBalance ? (
              <CardSection>
                <Alert tone="warning" title="Running low">
                  Less than a fifth of the allowance is left
                  {pool.resetsAt ? ` and it refills on ${formatDate(pool.resetsAt)}` : ''}.
                </Alert>
              </CardSection>
            ) : null}
          </Card>

          <Section
            title="Consumption"
            description={`Credits spent per day in ${scopeLabel}. Grants, top-ups and refunds are movements in the ledger but they are not spend, so they are left out.`}
            actions={
              <SegmentedControl
                label="Trend window"
                size="sm"
                value={String(days)}
                onChange={(next) => setParam('window', next)}
                items={TREND_WINDOWS.map((value) => ({
                  value: String(value),
                  label: `${value} days`,
                }))}
              />
            }
          >
            <Card>
              <CardBody>
                <ConsumptionTrend
                  points={usage.trend.data ?? []}
                  days={days}
                  scopeLabel={scopeLabel}
                  loading={usage.trend.isPending}
                  error={
                    usage.trend.isError
                      ? errorMessage(usage.trend.error, 'The consumption trend did not load.')
                      : null
                  }
                  onRetry={() => void usage.trend.refetch()}
                />
              </CardBody>
            </Card>
          </Section>

          <CreditCosts costs={balance.costs} pool={pool} />

          {botId !== null ? <PlanLimitsCard pool={pool} /> : null}

          {botId === null && balance.botCredits.length > 0 ? (
            <Section
              title="Per-chatbot balances"
              description="Each chatbot with its own subscription keeps its own credits. One running out does not touch the others."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {[...balance.botCredits, ...(balance.accountPool ? [balance.accountPool] : [])].map(
                  (entry) => (
                    <Card key={entry.botId ?? 'account'}>
                      <CardHeader
                        title={entry.name}
                        titleAs="h3"
                        description={entry.planName ?? 'Draws on the shared workspace pool'}
                        actions={
                          entry.botId !== null ? (
                            <Link
                              to={`/billing/usage?chatbot=${entry.botId}`}
                              className={buttonClass('ghost', 'sm')}
                            >
                              Focus
                            </Link>
                          ) : undefined
                        }
                      />
                      <CardBody className="space-y-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs text-text-secondary">Left to spend</span>
                          <span className="figure text-lg font-semibold text-text-primary">
                            {formatCredits(entry.totalRemaining)}
                          </span>
                        </div>
                        {entry.monthlyGrant > 0 ? (
                          <Meter
                            label="Plan allowance used"
                            used={Math.min(
                              entry.monthlyGrant - entry.planRemaining,
                              entry.monthlyGrant,
                            )}
                            limit={entry.monthlyGrant}
                            unit="credits"
                          />
                        ) : null}
                        <p className="text-xs text-text-tertiary">
                          {formatPeriod(entry.periodStart, entry.resetsAt)} ·{' '}
                          {formatCredits(entry.periodCreditsUsed)} spent
                        </p>
                      </CardBody>
                    </Card>
                  ),
                )}
              </div>
            </Section>
          ) : null}

          <Card>
            <CardHeader
              eyebrow="Ledger"
              title={botId === null ? 'Credit history' : `Credit history for ${pool.name}`}
              titleAs="h2"
              description="Every movement, newest first. Grants, purchases, spend, refunds and expiries."
            />
            <DataTable
              columns={ledgerColumns}
              rows={pageRows}
              rowKey={(row) => row.id}
              caption={`Credit ledger for ${scopeLabel}, page ${page}`}
              loading={usage.ledger.isPending}
              error={
                usage.ledger.isError
                  ? errorMessage(usage.ledger.error, 'The credit history did not load.')
                  : null
              }
              onRetry={() => void usage.ledger.refetch()}
              empty={
                <div className="px-6 py-14 text-center">
                  <span className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-surface-sunken">
                    <History aria-hidden className="h-4.5 w-4.5 text-text-tertiary" />
                  </span>
                  <p className="text-base font-medium text-text-primary">
                    {page > 1 ? 'Nothing further back' : 'No credit movements yet'}
                  </p>
                  <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-text-secondary">
                    {page > 1
                      ? 'You have reached the end of the ledger for this scope.'
                      : `Nothing in ${scopeLabel} has granted or spent a credit yet. The first reply your chatbot sends will appear here.`}
                  </p>
                </div>
              }
            />
            {/* `GET /credits/history` pages without reporting a total, so the
                table is deliberately NOT given `rowCount`: its own pager would
                have to print "of N" and the only N available would be invented.
                This says exactly which movements are on screen instead, and
                offers Older only while a full page came back. */}
            {pageRows.length > 0 || page > 1 ? (
              <CardFooter className="justify-between">
                <p className="text-xs text-text-secondary">
                  Movements{' '}
                  <span className="figure">{(page - 1) * HISTORY_PAGE_SIZE + 1}</span>–
                  <span className="figure">{(page - 1) * HISTORY_PAGE_SIZE + pageRows.length}</span>
                  , newest first
                </p>
                <span className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={page <= 1}
                    onClick={() => setParam('page', page > 2 ? String(page - 1) : null)}
                  >
                    Newer
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!hasOlder}
                    onClick={() => setParam('page', String(page + 1))}
                  >
                    Older
                  </Button>
                </span>
              </CardFooter>
            ) : null}
          </Card>

          <p className="text-xs text-text-tertiary">
            Balances refresh a few seconds after a purchase. If a figure still looks wrong once they
            have, that is a bug rather than a delay, and we would like to hear about it.
          </p>
        </Stack>
      )}

      <TopupDialog
        open={toppingUp}
        onOpenChange={setToppingUp}
        displayCurrency={geo.data?.displayCurrency ?? 'INR'}
        balance={balance}
        botId={botId}
        botName={botId === null ? null : (pool?.name ?? null)}
        onPurchased={(message) => {
          toast.success(message);
          usage.refreshAll();
        }}
        onBillingDetailsRequired={(missing) => {
          // The purchase was refused because the account is not invoiceable
          // yet, not because anything failed. Send the customer to the form
          // that fixes it rather than leaving them on a dead error.
          toast.error(
            missing.length > 0
              ? `We need your ${missing.join(', ')} on file before we can charge you.`
              : 'We need your billing details on file before we can charge you.',
          );
          navigate('/billing');
        }}
      />
    </Page>
  );
}
