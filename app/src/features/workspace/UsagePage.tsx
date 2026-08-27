import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Coins } from 'lucide-react';
import {
  ABSENT,
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  DataTable,
  EmptyState,
  ErrorState,
  Eyebrow,
  Grid,
  LoadingRows,
  LockedState,
  Meter,
  NavTabs,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  Select,
  Stack,
  StatRow,
  buttonClass,
  cn,
  formatDateTime,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { useEntitlements } from '../../hooks/useEntitlements';
import { BILLING_SECTIONS } from './billing/sections';
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

function PlanLimits({ pool }: { pool: PoolCredit }) {
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

  // A `CardSection` of the credits card rather than a seventh full-width card:
  // three meters do not need an eyebrow, a title and 20 words of period
  // arithmetic above them.
  return (
    <CardSection className="space-y-4">
      <Eyebrow>{`${pool.name} allowances`}</Eyebrow>
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
    </CardSection>
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

  // The endpoint now reports a total, so "is there an older page" is a fact
  // rather than an inference. The full-page heuristic stays as the fallback for
  // a backend that predates the count: without a total there is no honest way
  // to say how many pages exist, only whether this one filled up.
  const pageRows = usage.ledger.data?.rows ?? [];
  const ledgerTotal = usage.ledger.data?.total ?? null;
  const hasOlder =
    ledgerTotal !== null
      ? page * HISTORY_PAGE_SIZE < ledgerTotal
      : pageRows.length === HISTORY_PAGE_SIZE;

  const balance = usage.balance.data ?? null;
  const pool = balance ? resolveScopedPool(balance, botId) : null;
  const scopeLabel = botId === null ? 'this workspace' : (pool?.name ?? 'this chatbot');

  const scopeOptions = useMemo(
    () => [
      { value: '', label: 'Whole workspace' },
      ...(balance?.botCredits ?? [])
        .filter((entry) => entry.botId !== null)
        // A paused agent stays in the picker and says so in its own label: it
        // still holds credits that still expire, so it is exactly the scope
        // somebody needs to be able to open.
        .map((entry) => ({
          value: String(entry.botId),
          label: entry.isActive ? entry.name : `${entry.name} (paused)`,
        })),
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
          {row.note ? (
            <span className="truncate text-xs text-text-tertiary">{row.note}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'tone',
      header: 'Kind',
      width: '8rem',
      secondary: true,
      render: (row) => (
        <Badge
          tone={row.tone === 'credit' ? 'success' : row.tone === 'expiry' ? 'warning' : 'neutral'}
        >
          {row.tone === 'credit' ? 'Added' : row.tone === 'expiry' ? 'Expired' : 'Spent'}
        </Badge>
      ),
    },
    {
      key: 'delta',
      header: 'Credits',
      type: 'number',
      width: '8rem',
      render: (row) => (
        // A true minus sign, not the ASCII hyphen `formatNumber` emits: U+2212
        // is the same advance width as `+` in Geist Mono, so the column keeps
        // one optical edge.
        <span className={cn('text-sm font-medium', row.delta > 0 && 'text-success')}>
          {row.delta > 0 ? '+' : row.delta < 0 ? '\u2212' : ''}
          {formatNumber(Math.abs(row.delta))}
        </span>
      ),
    },
  ];

  if (usage.balance.isError && errorStatus(usage.balance.error) === 403) {
    return (
      <Page width="wide">
        <PageHeader
          title="Usage"
          titleVisuallyHidden
          toolbar={<NavTabs label="Billing sections" items={BILLING_SECTIONS} />}
        />
        {/* Forbidden, not failed: a seat that may not read the workspace's
            money is a plan/permission state, and `ErrorState` told the customer
            something had gone wrong. */}
        <LockedState
          title="Your seat cannot read this workspace's usage"
          description="Ask an owner or admin if you need the numbers."
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Usage"
        titleVisuallyHidden
        // The scope picker rides the tab row, exactly as `BillingPage` puts
        // the identical control. In `actions` it earned a row of its own above
        // the tabs — one right-aligned select over an otherwise empty shelf —
        // which pushed this tab strip 52px below the Plan tab's. Switching
        // tabs moved the tabs.
        toolbar={
          <NavTabs
            label="Billing sections"
            items={BILLING_SECTIONS}
            trailing={
              scopeOptions.length > 1 ? (
                <Select
                  label="Usage scope"
                  size="sm"
                  options={scopeOptions}
                  value={scopeParam ?? ''}
                  onValueChange={(value) => setParam('chatbot', value || null)}
                />
              ) : undefined
            }
          />
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
              You keep the credits your plan grants each month. Buying extra outright starts at the
              paid plans.
            </Alert>
          ) : null}

          {/* A paused agent is not a cancelled one, and the difference is the
              customer's money: the subscription is live, the balance is real,
              and the top-up credits expire on the same schedule they always
              did. Said before the figures, because it changes how every one of
              them should be read. */}
          {botId !== null && !pool.isActive ? (
            <Alert tone="warning" title="This chatbot is paused">
              It is spending nothing, but its subscription still bills and its credits still expire
              on schedule. Resume it from the chatbot's actions menu.
            </Alert>
          ) : null}

          <Card>
            <CardHeader
              eyebrow={botId === null ? 'Whole workspace' : pool.name}
              title="Credits"
              titleAs="h2"
              /* No `description`. `StatRow` states the window once, as a caption
                 under the four figures it anchors, so `formatPeriod` in the
                 header printed the same string a second time 120px above it. */
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setToppingUp(true)}
                  disabled={!entitlements.features?.topup_allowed}
                >
                  <Coins aria-hidden />
                  Buy credits
                </Button>
              }
            />
            <CardBody flush>
              {/* The low-balance state rides on the tile it is about. It used to
                  be a `CardSection` wrapping an `Alert` — a card inside a card —
                  appended after a second `CardSection` holding one meter. */}
              <StatRow
                label="Credits this period"
                columns={4}
                period={formatPeriod(pool.periodStart, pool.resetsAt)}
                items={[
                  {
                    label: 'Left to spend',
                    value: formatCredits(pool.totalRemaining),
                    size: 'hero',
                    tone:
                      pool.totalRemaining <= 0
                        ? 'danger'
                        : balance.lowBalance
                          ? 'warning'
                          : 'neutral',
                    hint:
                      pool.totalRemaining <= 0
                        ? !pool.isActive
                          ? 'This chatbot has no credits left either'
                          : botId === null
                            ? 'Your chatbots have stopped answering'
                            : 'This chatbot has stopped answering'
                        : balance.lowBalance
                          ? `Under a fifth left${pool.resetsAt ? `, refills ${formatDate(pool.resetsAt)}` : ''}`
                          : undefined,
                  },
                  {
                    label: 'From your plan',
                    value: formatCredits(pool.planRemaining),
                    period: pool.resetsAt
                      ? `Refills ${formatDate(pool.resetsAt)}`
                      : 'No refill date on record',
                  },
                  {
                    label: 'Purchased',
                    value: formatCredits(pool.topupRemaining),
                    period: pool.soonestExpiry
                      ? `Earliest expiry ${formatDate(pool.soonestExpiry)}`
                      : 'Bought outright',
                  },
                  {
                    label: 'Spent this period',
                    value: formatCredits(pool.periodCreditsUsed),
                  },
                ]}
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
                  No monthly grant — everything this scope spends comes from purchased credits.
                </p>
              )}
            </CardSection>
            {botId !== null ? <PlanLimits pool={pool} /> : null}
          </Card>

          {/* The trend and the rate table cover the same period and the reader
              checks one against the other, so they stand side by side rather
              than 400px apart in one column. */}
          {/* Not `align="start"`. These are two panels, and `start` let the
              chart card stop 155px above the rate table beside it — the ragged
              bottom edge `Grid`'s own docstring calls wrong for a row of
              panels. The `description` is here for the same reason: without it
              this header was two lines against the rate card's three, so the
              two cards' body rules sat 21px apart. */}
          <Grid cols={2} gap="section">
            <Card>
              <CardHeader
                eyebrow="Consumption"
                title={`Credits spent per day in ${scopeLabel}`}
                titleAs="h2"
                description={`Last ${days} days`}
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
              />
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

            <CreditCosts costs={balance.costs} pool={pool} />
          </Grid>

          {botId === null && balance.botCredits.length > 0 ? (
            <Section
              title="Per-chatbot balances"
              description="A chatbot with its own subscription keeps its own credits."
            >
              {/* One table, not one card per chatbot. Six chatbots were six
                  cards of about 200px each — 1,200px of mini-cards reproducing
                  the card above them — and there was no way to sort by
                  remaining balance, which is the only question this block
                  answers. */}
              <DataTable
                caption="Credit balance for each chatbot"
                rows={[
                  ...balance.botCredits,
                  ...(balance.accountPool ? [balance.accountPool] : []),
                ]}
                rowKey={(entry) => String(entry.botId ?? 'account')}
                rowNoun="chatbot"
                defaultSort={{ key: 'remaining', direction: 'desc' }}
                columns={[
                  {
                    key: 'name',
                    header: 'Chatbot',
                    pinned: true,
                    width: '16rem',
                    rowHeader: true,
                    sortable: (a, b) => a.name.localeCompare(b.name),
                    render: (entry) => (
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-text-primary">{entry.name}</span>
                        <span className="truncate text-xs text-text-secondary">
                          {entry.planName ?? 'Draws on the shared workspace pool'}
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    width: '8rem',
                    // The word, not only a dimmed row: a paused chatbot that
                    // merely looked quieter would read as one that had stopped
                    // being billed.
                    render: (entry) =>
                      entry.isActive ? (
                        <Badge tone="success" dot>
                          Active
                        </Badge>
                      ) : (
                        <Badge tone="neutral">Paused</Badge>
                      ),
                  },
                  {
                    key: 'remaining',
                    header: 'Left to spend',
                    type: 'number',
                    sortable: (a, b) => a.totalRemaining - b.totalRemaining,
                    render: (entry) => formatCredits(entry.totalRemaining),
                  },
                  {
                    key: 'allowance',
                    header: 'Allowance',
                    width: '10rem',
                    secondary: true,
                    render: (entry) =>
                      entry.monthlyGrant > 0 ? (
                        <Meter
                          className="w-24"
                          size="sm"
                          hideLabel
                          label={`${entry.name} plan allowance used`}
                          used={Math.min(
                            entry.monthlyGrant - entry.planRemaining,
                            entry.monthlyGrant,
                          )}
                          limit={entry.monthlyGrant}
                          unit="credits"
                        />
                      ) : (
                        ABSENT
                      ),
                  },
                  {
                    key: 'spent',
                    header: 'Spent this period',
                    type: 'number',
                    secondary: true,
                    sortable: (a, b) => a.periodCreditsUsed - b.periodCreditsUsed,
                    render: (entry) => formatCredits(entry.periodCreditsUsed),
                  },
                  {
                    key: 'focus',
                    header: <span className="sr-only">Focus</span>,
                    align: 'right',
                    width: '6rem',
                    render: (entry) =>
                      entry.botId !== null ? (
                        <Link
                          to={`/billing/usage?chatbot=${entry.botId}`}
                          className={buttonClass('ghost', 'sm')}
                        >
                          Focus
                        </Link>
                      ) : null,
                  },
                ]}
              />
            </Section>
          ) : null}

          <Card>
            <CardHeader
              eyebrow="Ledger"
              title={botId === null ? 'Credit history' : `Credit history for ${pool.name}`}
              titleAs="h2"
              description="Newest first."
            />
            <CardBody flush>
              {/* `DataTable`'s own pager. This card shipped a hand-rolled
                  `CardFooter` with secondary Newer/Older buttons while the
                  invoices table beside it used the system pager's ghost icon
                  buttons — two pager vocabularies on one surface. Server paging
                  is what the table gained for exactly this.

                  `rowCount` falls back to a lower bound when a backend that
                  predates the count sends none, so "Older" stays reachable
                  rather than silently disappearing. */}
              <DataTable
                seated
                columns={ledgerColumns}
                rows={pageRows}
                rowKey={(row) => row.id}
                caption={`Credit ledger for ${scopeLabel}`}
                rowNoun="movement"
                pageSize={HISTORY_PAGE_SIZE}
                page={page}
                onPageChange={(next) => setParam('page', next === 1 ? null : String(next))}
                rowCount={
                  ledgerTotal ??
                  (page - 1) * HISTORY_PAGE_SIZE + pageRows.length + (hasOlder ? 1 : 0)
                }
                loading={usage.ledger.isPending}
                error={
                  usage.ledger.isError
                    ? errorMessage(usage.ledger.error, 'The credit history did not load.')
                    : null
                }
                onRetry={() => void usage.ledger.refetch()}
                empty={
                  <EmptyState
                    size="inline"
                    title={page > 1 ? 'Nothing further back' : 'No credit movements yet'}
                    description={
                      page > 1
                        ? 'You have reached the end of the ledger for this scope.'
                        : `The first reply your chatbot sends in ${scopeLabel} appears here.`
                    }
                  />
                }
              />
            </CardBody>
          </Card>
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
