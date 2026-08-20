import { useMemo } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Combobox,
  EmptyState,
  LoadingBars,
  LockedState,
  RankedBars,
  Section,
  SegmentedControl,
  Stack,
  Toolbar,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import { RecordList } from '../RecordList';
import { byDate, byText, usePagedRows } from '../recordListState';
import type { ClientRow } from '../customers/types';
import type { BillingFunnelResponse, PaymentMethodRow } from './types';

/**
 * How customers pay, and where paying goes wrong.
 *
 * Two endpoints that belong together: the payment instruments on file, and the
 * telemetry of people who opened a Razorpay sheet and did not finish. One says
 * what the platform can charge, the other says what it failed to.
 */

/** `list_payment_methods` `.limit(500)`. */
const SERVER_CAP = 500;

/** `billing_funnel` bounds `days` at 90 and `limit` at 200. */
const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

const RECENT_LIMIT = 50;

export function PaymentsTab() {
  const url = useUrlState();
  const clientId = url.get('client');
  const days = RANGES.some((range) => range.value === url.get('days')) ? url.get('days') : '7';

  const methods = usePlatformList<PaymentMethodRow>('/payment-methods', {
    params: clientId ? { client_id: clientId } : undefined,
  });

  // The query string is part of the path here because this endpoint returns a
  // record (`{days, counts, recent}`) rather than a list, and the resource hook
  // takes no params. It is one request either way; splitting it into two hooks
  // to satisfy the shape would double the traffic for the same data.
  const clients = usePlatformList<ClientRow>('/clients');

  const methodsPaged = usePagedRows(methods.items, {
    url,
    pageKey: 'mpage',
    sortKey: 'msort',
    comparators: { synced: byDate((row) => row.synced_at) },
  });

  const funnel = usePlatformResource<BillingFunnelResponse>(
    `/billing-funnel?days=${days}&limit=${RECENT_LIMIT}`,
  );

  const bars = useMemo(
    () =>
      (funnel.data?.counts ?? []).map((entry) => ({
        id: `${entry.surface}:${entry.event}`,
        label: entry.event.replace(/_/g, ' '),
        value: entry.count,
        display: formatNumber(entry.count),
        meta: `on ${entry.surface}`,
      })),
    [funnel.data],
  );

  const methodColumns: readonly Column<PaymentMethodRow>[] = [
    {
      key: 'client',
      header: 'Customer',
      pinned: true,
      width: '15rem',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">
            {row.client_name ?? `client #${row.client_id}`}
          </p>
          <p className="figure truncate text-2xs text-text-tertiary">client #{row.client_id}</p>
        </div>
      ),
    },
    {
      key: 'instrument',
      header: 'Instrument',
      width: '16rem',
      render: (row) => (
        <div className="min-w-0">
          <p className="text-sm text-text-primary">
            {row.type ?? 'unknown type'}
            {row.last4 ? <span className="figure"> ···· {row.last4}</span> : null}
          </p>
          <p className="truncate text-2xs text-text-tertiary">
            {[row.network, row.issuer, row.upi_handle].filter(Boolean).join(' · ') || 'no further detail stored'}
          </p>
        </div>
      ),
    },
    {
      key: 'provider',
      header: 'Provider',
      width: '8rem',
      secondary: true,
      render: (row) => <span className="text-sm text-text-secondary">{row.provider ?? '—'}</span>,
    },
    {
      key: 'default',
      header: 'Default',
      width: '7rem',
      render: (row) =>
        row.is_default ? <Badge tone="success">Default</Badge> : <span className="text-text-tertiary">—</span>,
    },
    {
      key: 'synced',
      header: 'Last synced',
      width: '12rem',
      secondary: true,
      sortable: true,
      render: (row) => <span className="figure text-sm">{formatDateTime(row.synced_at)}</span>,
    },
  ];

  const eventColumns: readonly Column<BillingFunnelResponse['recent'][number]>[] = [
    {
      key: 'created',
      header: 'When',
      pinned: true,
      width: '12rem',
      render: (row) => <span className="figure text-sm">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: 'event',
      header: 'Event',
      width: '12rem',
      render: (row) => <span className="text-sm text-text-primary">{row.event.replace(/_/g, ' ')}</span>,
    },
    {
      key: 'surface',
      header: 'Surface',
      width: '11rem',
      render: (row) => <span className="text-sm text-text-secondary">{row.surface}</span>,
    },
    {
      key: 'client',
      header: 'Customer',
      render: (row) => (
        <span className="figure text-sm text-text-secondary">
          {row.client_email ?? `client #${row.client_id}`}
        </span>
      ),
    },
  ];

  const eventsPaged = usePagedRows(funnel.data?.recent ?? [], {
    url,
    pageKey: 'epage',
    sortKey: 'esort',
    comparators: { event: byText((row) => row.event), surface: byText((row) => row.surface) },
  });

  return (
    <Stack>
      <Section
        title="Payment drop-off"
        description="Who opened a Razorpay checkout sheet and did not complete it, aggregated per surface."
        actions={
          <SegmentedControl
            size="sm"
            label="Range"
            value={days}
            onChange={(next) => url.set({ days: next })}
            items={RANGES}
          />
        }
      >
        {funnel.forbidden ? (
          <LockedState
            size="panel"
            title={FORBIDDEN_TITLE}
            description={forbiddenDescription('billing funnel events')}
          />
        ) : (
          <Card>
            <CardHeader
              title="Events in the window"
              titleAs="h3"
              description="Counts are per surface and event, largest first. An abandoned sheet is not a failure — a declined one is."
            />
            {funnel.loading && !funnel.data ? (
              <CardBody>
                <LoadingBars rows={4} />
              </CardBody>
            ) : funnel.error && !funnel.data ? (
              <CardBody>
                <Alert
                  tone="danger"
                  live
                  title="The payment funnel could not be loaded"
                  action={
                    <Button size="sm" variant="secondary" onClick={funnel.reload}>
                      Try again
                    </Button>
                  }
                >
                  {funnel.error}
                </Alert>
              </CardBody>
            ) : bars.length === 0 ? (
              <EmptyState
                compact
                title="No checkout activity in this window"
                description="Nobody opened a payment sheet in this range — or the event is not being recorded."
              />
            ) : (
              <CardBody>
                <RankedBars label="Billing funnel events by surface" items={bars} />
              </CardBody>
            )}
          </Card>
        )}
      </Section>

      <Section
        title="Most recent checkout events"
        description={`The last ${RECENT_LIMIT} events in the window, newest first.`}
      >
        <RecordList
          caption="Recent billing funnel events"
          columns={eventColumns}
          paged={eventsPaged}
          rowKey={(row) => String(row.id)}
          rowNoun="event"
          what="billing funnel events"
          loading={funnel.loading && !funnel.data}
          error={funnel.error && !funnel.data ? funnel.error : null}
          forbidden={funnel.forbidden}
          onRetry={funnel.reload}
          empty={
            <EmptyState
              title="No checkout events"
              description="Nothing was recorded in this window. Widen the range, or check the checkout surfaces are emitting events at all."
            />
          }
        />
      </Section>

      <Section
        title="Stored payment methods"
        description="UPI handles are masked server-side; no gateway token is ever returned."
      >
        <Toolbar sticky className="mb-3">
          <div className="w-48">
            <Combobox
              size="sm"
              label="Filter payment methods by account"
              value={clientId || null}
              onValueChange={(next) => url.set({ client: next })}
              options={clients.items.map((row) => ({
                value: String(row.id),
                label: row.name,
                description: row.email,
                keywords: row.email,
              }))}
              placeholder="Every customer"
              clearable
            />
          </div>
          {clientId ? (
            <Button size="sm" variant="ghost" onClick={() => url.set({ client: null })}>
              Show every customer
            </Button>
          ) : null}
        </Toolbar>

        <RecordList
          caption="Stored payment methods, newest first"
          columns={methodColumns}
          paged={methodsPaged}
          rowKey={(row) => String(row.id)}
          rowNoun="method"
          what="stored payment instruments"
          loading={methods.loading}
          error={methods.error}
          forbidden={methods.forbidden}
          onRetry={methods.reload}
          loaded={methods.items.length}
          cap={SERVER_CAP}
          empty={
            <EmptyState
              title={clientId ? 'No methods for that client' : 'No payment methods stored'}
              description={
                clientId
                  ? 'That account has no card, UPI mandate or bank reference on file.'
                  : 'Nobody has a payment instrument on file.'
              }
            />
          }
        />
      </Section>
    </Stack>
  );
}
