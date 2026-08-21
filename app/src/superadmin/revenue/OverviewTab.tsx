import { useMemo } from 'react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  LoadingBars,
  LockedState,
  Measure,
  RankedBars,
  Section,
  Stack,
  StatRow,
  formatNumber,
  formatPercent,
  type Column,
} from '../../ui';
import { usePlatformList, usePlatformResource } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import { PAGE_SIZE } from '../recordListState';
import { USD_NORMALISED_NOTE, usdCents, usdCentsRounded } from '../money';
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
      <Section
        title="Recurring revenue"
        // "…normalised to USD." — the note opens with the currency, so the
        // prefix has to run into it. It used to end with a full stop, which
        // left "Every figure on this tab is normalised. USD. Amounts…": a
        // one-word sentence in the middle of the only prose on the page.
        description={`Every figure on this tab is normalised to ${USD_NORMALISED_NOTE}`}
      >
        {metrics.forbidden ? (
          <LockedState
            size="panel"
            title={FORBIDDEN_TITLE}
            description={forbiddenDescription('the revenue aggregates')}
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
            <CardBody flush>
              {/* One strip, one statement of the window, hairline-divided.

                  The unit is stated by the section's own description and
                  nowhere else. It used to be a `period` on every tile — the
                  workaround for a `StatRow` that dropped the window it was
                  given — and then a `hint` on every tile, which is the same
                  three identical grey lines one row lower, under a paragraph
                  that had already said it. */}
              <StatRow
                label="Recurring revenue"
                period="Right now"
                loading={metrics.loading}
                items={[
                  {
                    label: 'MRR',
                    size: 'hero',
                    value: metrics.data ? usdCentsRounded(metrics.data.mrr_cents) : undefined,
                  },
                  {
                    label: 'ARR',
                    value: metrics.data ? usdCentsRounded(metrics.data.arr_cents) : undefined,
                  },
                  {
                    // The window is in the label because it differs from the
                    // strip's, and a tile whose `period` differs prints its own
                    // line — which would make this one tile a line taller than
                    // its three neighbours.
                    label: 'Collected, all time',
                    value: metrics.data
                      ? usdCentsRounded(metrics.data.total_revenue_cents)
                      : undefined,
                  },
                  {
                    label: 'Paying customers',
                    hint: 'Active and past due',
                    value: metrics.data
                      ? formatNumber(metrics.data.total_paying_customers)
                      : undefined,
                  },
                ]}
              />
            </CardBody>
          </Card>
        )}
      </Section>

      {/* `RankedBars` caps its row at `--container-pair` on purpose, so a
          full-width card left 440px of empty surface to the right of every
          figure. The measure belongs to the content. */}
      <Section title="Subscription mix" description="Every subscription row, by status.">
        <Measure width="reading">
          <Card>
            {metrics.loading && !metrics.data ? (
              <CardBody>
                <LoadingBars rows={5} />
              </CardBody>
            ) : !counts ? (
              <EmptyState
                compact
                title="No subscription counts"
                description="The revenue endpoint returned no status breakdown — unusual on a platform with any customers at all."
              />
            ) : (
              <CardBody>
                <RankedBars label="Subscriptions by status" items={mix} />
              </CardBody>
            )}
          </Card>
        </Measure>
      </Section>

      <Section
        title="Cohorts"
        description="Grouped by signup month: how many still hold a subscription, and what they have paid since."
      >
        <DataTable
          caption="Signup cohorts with retention and lifetime value"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.cohort}
          rowNoun="cohort"
          loading={cohorts.loading}
          error={cohorts.error}
          forbidden={
            cohorts.forbidden
              ? { title: FORBIDDEN_TITLE, description: forbiddenDescription('cohort retention') }
              : null
          }
          onRetry={cohorts.reload}
          pageSize={PAGE_SIZE}
          empty={
            <EmptyState
              title="No cohorts yet"
              description="A cohort appears once an account exists with a creation date."
            />
          }
        />
      </Section>
    </Stack>
  );
}
