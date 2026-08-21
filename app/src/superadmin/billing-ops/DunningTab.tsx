import { useMemo } from 'react';
import {
  ABSENT,
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
  StatRow,
  Tooltip,
  formatDate,
  formatNumber,
  type Column,
} from '../../ui';
import { usePlatformResource } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import { PAGE_SIZE } from '../recordListState';
import { docMoneyWithCode } from '../money';
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
 * Both figures the server used to get wrong are now right at the source: the
 * per-row amount is cycle-aware and rail-aware, and the totals arrive already
 * split per currency. Two things this screen still does itself:
 *
 * * It totals the rows **on screen** rather than printing the server's totals,
 *   which cover every past-due subscription. Both numbers are useful and they
 *   are not the same, so the tiles say which they are.
 * * It never converts between currencies to produce one grand total. A dunning
 *   screen showing a converted figure invites somebody to book it as revenue.
 *
 * And whatever the number is, it is one cycle **at risk** — not an amount owed.
 * Razorpay does not re-attempt the missed cycle.
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
      width: '17rem',
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
      width: '9rem',
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
      width: '11rem',
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
      header: (
        <Tooltip content="Razorpay does not re-attempt the missed charge when a halted subscription returns to active, so a recovery still leaves this cycle uncollected. It is charged from the Razorpay dashboard.">
          <span className="cursor-help underline decoration-dotted underline-offset-2">
            Cycle at risk
          </span>
        </Tooltip>
      ),
      align: 'right',
      width: '11rem',
      render: (row) => (
        <div>
          <p className="figure text-sm text-text-primary">
            {row.cycle_at_risk_minor === null
              ? ABSENT
              : docMoneyWithCode(row.cycle_at_risk_minor, row.currency)}
          </p>
          {row.cycle_at_risk_minor === null ? (
            // Not zero, and not the other rail's number: the plan has no price
            // recorded on this customer's currency, which is a data defect
            // somebody needs to fix rather than a smaller amount at risk.
            <p className="text-2xs text-warning">
              no {row.currency} price on this plan
            </p>
          ) : row.billing_cycle === 'annual' ? (
            <p className="text-2xs text-text-tertiary">one annual cycle</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'cadence',
      header: 'Dunning emails',
      // This column had no declared width, so `DataTable` fell back to auto
      // layout and sized the table to "3 emails sent (day_1, day_3, day_5)" —
      // which pushed the whole column off the card's right edge on every row.
      // The count is the column; which steps went out is a tooltip.
      width: '11rem',
      secondary: true,
      render: (row) =>
        row.emails_sent.length === 0 ? (
          <span className="text-sm text-text-tertiary">None sent</span>
        ) : (
          <Tooltip content={cadenceSummary(row.emails_sent)}>
            <span className="text-sm text-text-secondary">
              {row.emails_sent.length === 1 ? '1 email sent' : `${row.emails_sent.length} emails sent`}
            </span>
          </Tooltip>
        ),
    },
  ];

  if (dunning.forbidden) {
    return (
      <LockedState title={FORBIDDEN_TITLE} description={forbiddenDescription('failing subscriptions')} />
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
          <CardBody flush>
            <StatRow
              label="Dunning exposure"
              period="Right now"
              loading={dunning.loading && !dunning.data}
              items={[
                {
                  // What each figure *is* is a hint; the strip states the window.
                  // These were `period`s while `StatRow` dropped the one it was
                  // given — a workaround that made "Platform setting" read as a
                  // time window.
                  label: 'Failing now',
                  size: 'hero',
                  value: dunning.data ? formatNumber(dunning.data.count) : undefined,
                  tone: dunning.data && dunning.data.count > 0 ? 'danger' : 'neutral',
                  hint: 'Subscriptions in past_due',
                },
                {
                  label: 'Grace period',
                  value: dunning.data ? `${dunning.data.grace_days} days` : undefined,
                  hint: 'Platform setting',
                },
                ...(totals.length === 0
                  ? [{ label: 'At risk', value: undefined, hint: 'Nothing failing' }]
                  : totals.map((total) => ({
                      label: `At risk (${total.currency})`,
                      value: docMoneyWithCode(total.minor, total.currency),
                      // Per currency: the API's own total adds paise to cents.
                      hint: "One month's plan price",
                    }))),
              ]}
            />
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Who to call, in order"
        description="Least grace remaining first. Rows with no past-due date sort last — they cannot be scheduled."
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
          rowNoun="subscription"
          loading={dunning.loading && !dunning.data}
          error={dunning.error && !dunning.data ? dunning.error : null}
          onRetry={dunning.reload}
          pageSize={PAGE_SIZE}
          empty={
            <EmptyState
              title="Nobody is failing payment"
              description="No subscription is in past_due. This list is empty in a healthy month."
            />
          }
        />
      </Section>
    </Stack>
  );
}
