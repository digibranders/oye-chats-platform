import { useMemo } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  LockedState,
  Section,
  Stack,
  StatTile,
  formatDate,
  formatNumber,
  type Column,
} from '../../ui';
import { usePlatformResource } from '../usePlatform';
import { docMoneyWithCode } from '../revenue/money';
import { atRiskByCurrency, cadenceSummary, sortByUrgency, urgencyLabel, urgencyTone } from './dunning';
import type { DunningItem, DunningResponse } from './types';

/**
 * The save-call queue.
 *
 * Every row is a customer whose payment failed and whose chatbots stop
 * answering when the grace period runs out, so the list is ordered by **how
 * long they have left**, not by id and not by value. That ordering is the whole
 * screen: an operator with twenty minutes should work down it from the top and
 * stop, and the ordering is what makes that the right thing to do.
 *
 * Two things the server gets subtly wrong are corrected here rather than
 * repeated:
 *
 * * `at_risk_minor_total` sums every row's minor units regardless of currency,
 *   so on a platform with both INR and USD plans it adds paise to cents. This
 *   screen totals per currency instead and never prints the mixed figure.
 * * `at_risk_minor` is the plan's *monthly* price even for an annually billed
 *   subscription, so an annual row understates the cycle at risk. The column
 *   says so rather than presenting it as the amount outstanding.
 */
export function DunningTab() {
  const dunning = usePlatformResource<DunningResponse>('/billing/dunning');

  const items = useMemo(() => sortByUrgency(dunning.data?.items ?? []), [dunning.data]);
  const totals = useMemo(() => atRiskByCurrency(items), [items]);
  const critical = items.filter((item) => item.days_left != null && item.days_left <= 2).length;

  const columns: readonly Column<DunningItem>[] = [
    {
      key: 'urgency',
      header: 'Grace',
      pinned: true,
      width: '11rem',
      render: (row) => (
        <Badge tone={urgencyTone(row.days_left)} dot>
          {urgencyLabel(row.days_left)}
        </Badge>
      ),
    },
    {
      key: 'client',
      header: 'Customer',
      width: '18rem',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">
            {row.client_email ?? `client #${row.client_id}`}
          </p>
          <p className="figure truncate text-2xs text-text-tertiary">
            client #{row.client_id} · subscription #{row.subscription_id}
          </p>
        </div>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      width: '12rem',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-text-primary">{row.plan_name ?? 'No plan on record'}</p>
          <p className="text-2xs text-text-tertiary">{row.billing_cycle ?? 'cycle not set'}</p>
        </div>
      ),
    },
    {
      key: 'since',
      header: 'Failing since',
      width: '12rem',
      render: (row) => (
        <div className="min-w-0">
          <p className="figure text-sm text-text-primary">{formatDate(row.past_due_since)}</p>
          <p className="figure text-2xs text-text-tertiary">
            {row.days_elapsed == null
              ? 'no timestamp recorded'
              : `${row.days_elapsed} day${row.days_elapsed === 1 ? '' : 's'} ago`}
          </p>
        </div>
      ),
    },
    {
      key: 'at_risk',
      header: 'Monthly at risk',
      align: 'right',
      width: '12rem',
      render: (row) => (
        <div>
          <p className="figure text-sm text-text-primary">
            {docMoneyWithCode(row.at_risk_minor, row.currency)}
          </p>
          {row.billing_cycle === 'annual' ? (
            <p className="text-2xs text-text-tertiary">monthly price of an annual plan</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'cadence',
      header: 'Dunning emails',
      secondary: true,
      render: (row) => (
        <span className="text-sm text-text-secondary">{cadenceSummary(row.emails_sent)}</span>
      ),
    },
  ];

  if (dunning.forbidden) {
    return (
      <LockedState
        title="You cannot read dunning"
        description="Your super-admin account is not permitted to read failing subscriptions. Nothing was loaded."
      />
    );
  }

  return (
    <Stack>
      {critical > 0 ? (
        <Alert tone="danger" live title={`${critical} account${critical === 1 ? '' : 's'} about to lose access`}>
          {critical === 1 ? 'One customer has' : `${critical} customers have`} two days of grace or
          less. When it runs out their chatbots stop answering visitors — call them before that, not
          after.
        </Alert>
      ) : null}

      <Section title="What is at stake">
        <Card>
          <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Failing now"
              size="lg"
              loading={dunning.loading && !dunning.data}
              value={dunning.data ? formatNumber(dunning.data.count) : undefined}
              period="Right now"
              tone={dunning.data && dunning.data.count > 0 ? 'danger' : 'neutral'}
              hint="Subscriptions in past_due."
            />
            <StatTile
              label="Grace period"
              size="lg"
              loading={dunning.loading && !dunning.data}
              value={dunning.data ? `${dunning.data.grace_days} days` : undefined}
              period="Platform setting"
              hint="From PAYMENT_FAILED_GRACE_DAYS on the API."
            />
            {totals.length === 0 ? (
              <StatTile label="At risk" size="lg" value={undefined} period="Nothing failing" />
            ) : (
              totals.map((total) => (
                <StatTile
                  key={total.currency}
                  label={`At risk (${total.currency})`}
                  size="lg"
                  value={docMoneyWithCode(total.minor, total.currency)}
                  period="One month's plan price"
                  hint="Totalled per currency — the API's own total adds paise to cents."
                />
              ))
            )}
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Who to call, in order"
        description="Least grace remaining first. Rows with no recorded past-due date sort last: they cannot be scheduled, so they should not head the queue."
        actions={
          <Button size="sm" variant="secondary" onClick={dunning.reload} loading={dunning.loading}>
            Refresh
          </Button>
        }
      >
        <DataTable
          caption="Past-due subscriptions, most urgent first"
          columns={columns}
          rows={items}
          rowKey={(row) => String(row.subscription_id)}
          loading={dunning.loading && !dunning.data}
          error={dunning.error && !dunning.data ? dunning.error : null}
          onRetry={dunning.reload}
          pageSize={25}
          empty={
            <EmptyState
              title="Nobody is failing payment"
              description="No subscription is in past_due. This list is empty in a healthy month, which is what it should look like."
            />
          }
        />
      </Section>

      <Alert tone="neutral" title="A recovered subscription still owes one cycle">
        Razorpay does not re-attempt the missed charge when a halted subscription returns to active,
        so every recovery leaves one uncollected cycle unless somebody charges it manually. There is
        no console action for that — it is done in the Razorpay dashboard.
      </Alert>
    </Stack>
  );
}
