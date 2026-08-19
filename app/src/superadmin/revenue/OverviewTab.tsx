import { useMemo } from 'react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  LockedState,
  RankedBars,
  Section,
  Stack,
  StatTile,
  formatNumber,
  formatPercent,
  type Column,
} from '../../ui';
import { usePlatformList, usePlatformResource } from '../usePlatform';
import { USD_NORMALISED_NOTE, USD_NORMALISED_SHORT, usdCents, usdCentsRounded } from './money';
import { subscriptionLabel, SUBSCRIPTION_STATUSES } from './status';
import type { RevenueCohort, RevenueMetrics } from './types';

/**
 * The shape of the business, in two questions: what is it worth per month, and
 * do the people who sign up stay.
 *
 * Every figure here is the server's normalised USD, which is a reporting
 * convention rather than a currency anyone was actually charged in — so it is
 * labelled as such once, prominently, instead of in eight tooltips nobody
 * opens.
 */
export function OverviewTab() {
  const metrics = usePlatformResource<RevenueMetrics>('/revenue');
  const cohorts = usePlatformList<RevenueCohort>('/revenue/cohorts');

  const counts = metrics.data?.subscription_counts;
  const mix = useMemo(
    () =>
      SUBSCRIPTION_STATUSES.map((status) => ({
        id: status,
        label: subscriptionLabel(status),
        value: counts?.[status] ?? 0,
        display: formatNumber(counts?.[status] ?? 0),
      })),
    [counts],
  );

  // Sorted newest cohort first: the months an operator is actually asked about
  // are the recent ones, and the endpoint returns them oldest-first.
  const rows = useMemo(() => [...cohorts.items].reverse(), [cohorts.items]);

  const columns: readonly Column<RevenueCohort>[] = [
    {
      key: 'cohort',
      header: 'Signup month',
      width: '10rem',
      pinned: true,
      sortable: (a, b) => a.cohort.localeCompare(b.cohort),
      render: (row) => <span className="figure text-sm font-medium">{row.cohort}</span>,
    },
    {
      key: 'signups',
      header: 'Signups',
      align: 'right',
      sortable: (a, b) => a.signups - b.signups,
      render: (row) => <span className="figure">{formatNumber(row.signups)}</span>,
    },
    {
      key: 'retained',
      header: 'Still subscribed',
      align: 'right',
      sortable: (a, b) => a.retained - b.retained,
      render: (row) => <span className="figure">{formatNumber(row.retained)}</span>,
    },
    {
      key: 'retention',
      header: 'Retention',
      align: 'right',
      sortable: (a, b) =>
        (a.signups ? a.retained / a.signups : 0) - (b.signups ? b.retained / b.signups : 0),
      // A cohort with no signups has no retention rate — that is a different
      // fact from 0%, so it renders as absent rather than as a number.
      render: (row) => (
        <span className="figure">{row.signups ? formatPercent(row.retained / row.signups) : '—'}</span>
      ),
    },
    {
      key: 'ltv',
      header: 'Paid to date',
      align: 'right',
      secondary: true,
      sortable: (a, b) => a.ltv_cents - b.ltv_cents,
      render: (row) => <span className="figure">{usdCents(row.ltv_cents)}</span>,
    },
    {
      key: 'per_signup',
      header: 'Per signup',
      align: 'right',
      secondary: true,
      sortable: (a, b) =>
        (a.signups ? a.ltv_cents / a.signups : 0) - (b.signups ? b.ltv_cents / b.signups : 0),
      render: (row) => (
        <span className="figure">{row.signups ? usdCents(row.ltv_cents / row.signups) : '—'}</span>
      ),
    },
  ];

  return (
    <Stack>
      <Alert tone="neutral" title="Every figure on this tab is normalised">
        {USD_NORMALISED_NOTE} An invoice&rsquo;s own amount is never converted — see the Invoices tab
        for what each customer was actually charged.
      </Alert>

      <Section title="Recurring revenue">
        {metrics.forbidden ? (
          <LockedState
            title="You cannot read revenue"
            description="Your super-admin account is not permitted to read the revenue aggregates. Nothing was loaded."
          />
        ) : metrics.error && !metrics.data ? (
          <Card>
            <CardBody>
              <Alert
                tone="danger"
                live
                title="Revenue could not be loaded"
                action={
                  <Button size="sm" variant="secondary" onClick={metrics.reload}>
                    Try again
                  </Button>
                }
              >
                {metrics.error}
              </Alert>
            </CardBody>
          </Card>
        ) : (
          <Card>
            <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="MRR"
                size="lg"
                loading={metrics.loading}
                value={metrics.data ? usdCentsRounded(metrics.data.mrr_cents) : undefined}
                period={USD_NORMALISED_SHORT}
                hint="Active and trialing subscriptions, plan price plus billable seat add-ons."
              />
              <StatTile
                label="ARR"
                size="lg"
                loading={metrics.loading}
                value={metrics.data ? usdCentsRounded(metrics.data.arr_cents) : undefined}
                period={USD_NORMALISED_SHORT}
                hint="MRR × 12. A projection, not booked revenue."
              />
              <StatTile
                label="Collected, all time"
                size="lg"
                loading={metrics.loading}
                value={metrics.data ? usdCentsRounded(metrics.data.total_revenue_cents) : undefined}
                period={USD_NORMALISED_SHORT}
                hint="Every invoice with status paid, converted where it was issued in rupees."
              />
              <StatTile
                label="Paying customers"
                size="lg"
                loading={metrics.loading}
                value={metrics.data ? formatNumber(metrics.data.total_paying_customers) : undefined}
                period="Right now"
                hint="Active plus past due — a past-due account is still on the books."
              />
            </CardBody>
          </Card>
        )}
      </Section>

      <Section title="Subscription mix" description="Every subscription row, by status.">
        <Card>
          {metrics.loading && !metrics.data ? (
            <CardBody>
              <EmptyState compact title="Reading subscriptions…" />
            </CardBody>
          ) : !counts ? (
            <EmptyState
              compact
              title="No subscription counts"
              description="The revenue endpoint returned no status breakdown. That is unusual on a platform with any customers at all, and worth checking."
            />
          ) : (
            <RankedBars label="Subscriptions by status" items={mix} tone="ink" />
          )}
        </Card>
        {counts ? (
          <p className="mt-2 text-xs text-text-tertiary">
            {SUBSCRIPTION_STATUSES.filter((status) => counts[status] > 0)
              .map((status) => `${subscriptionLabel(status)} ${counts[status]}`)
              .join(' · ') || 'No subscriptions of any status.'}
          </p>
        ) : null}
      </Section>

      <Section
        title="Cohorts"
        description="Accounts grouped by the month they signed up, how many still hold a subscription, and what they have paid since."
      >
        {cohorts.forbidden ? (
          <LockedState
            title="You cannot read cohorts"
            description="Your super-admin account is not permitted to read cohort retention. Nothing was loaded."
          />
        ) : (
          <DataTable
            caption="Signup cohorts with retention and lifetime value"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.cohort}
            loading={cohorts.loading}
            error={cohorts.error}
            onRetry={cohorts.reload}
            pageSize={12}
            empty={
              <EmptyState
                title="No cohorts yet"
                description="A cohort appears once an account exists with a creation date. Either nobody has signed up, or every client row predates the created_at column."
              />
            }
          />
        )}
      </Section>
    </Stack>
  );
}
