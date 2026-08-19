import {
  Alert,
  Button,
  DataTable,
  EmptyState,
  Input,
  LockedState,
  Section,
  Stack,
  Toolbar,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import type { ProcessedWebhookRow } from './types';

/**
 * The inbound idempotency log.
 *
 * Not a delivery log and not a debugging trace: this table records that a
 * provider event id has been seen and handled, so that a redelivery of the same
 * event cannot grant the same credits twice. It answers exactly one question —
 * "did we already process this event?" — and it is the right screen to open
 * when a customer says a payment succeeded at the gateway but nothing happened
 * here.
 *
 * There is no payload and no status column because the endpoint returns
 * neither. Adding one would mean inventing it.
 */

/** `list_processed_webhooks` `.limit(500)`. */
const SERVER_CAP = 500;

export function WebhooksTab() {
  const url = useUrlState();
  const provider = url.get('provider');

  const list = usePlatformList<ProcessedWebhookRow>('/processed-webhooks', {
    params: provider ? { provider } : undefined,
  });

  const columns: readonly Column<ProcessedWebhookRow>[] = [
    {
      key: 'processed_at',
      header: 'Processed',
      pinned: true,
      width: '14rem',
      sortable: (a, b) => (a.processed_at ?? '').localeCompare(b.processed_at ?? ''),
      render: (row) => <span className="figure text-sm">{formatDateTime(row.processed_at)}</span>,
    },
    {
      key: 'provider',
      header: 'Provider',
      width: '10rem',
      render: (row) => <span className="text-sm text-text-secondary">{row.provider}</span>,
    },
    {
      key: 'event_id',
      header: 'Event id',
      // Full, not truncated: the whole point of this screen is matching an id
      // somebody is reading out of the Razorpay dashboard.
      render: (row) => <span className="figure break-all text-sm">{row.event_id}</span>,
    },
  ];

  return (
    <Stack>
      <Section
        title="Processed provider webhooks"
        description="Every inbound event id already handled, newest first. A missing id means the event never reached us — the place to look next is the gateway's own delivery log."
      >
        <Toolbar className="mb-3">
          <Input
            size="sm"
            aria-label="Filter by provider"
            placeholder="Provider, e.g. razorpay"
            className="w-52"
            value={provider}
            onChange={(event) => url.set({ provider: event.target.value })}
          />
          {provider ? (
            <Button size="sm" variant="ghost" onClick={() => url.set({ provider: null })}>
              Show every provider
            </Button>
          ) : null}
          <span className="figure ml-auto text-xs text-text-tertiary">
            {list.loading ? 'Loading…' : `${formatNumber(list.items.length)} shown`}
          </span>
        </Toolbar>

        {list.items.length >= SERVER_CAP ? (
          <Alert tone="warning" className="mb-3" title="Truncated at 500 events">
            The endpoint returns at most {SERVER_CAP} rows and does not paginate, so anything older
            than the {SERVER_CAP}th most recent event is not shown. An id you cannot find here may
            simply be older than the window.
          </Alert>
        ) : null}

        {list.forbidden ? (
          <LockedState
            title="You cannot read the webhook log"
            description="Your super-admin account is not permitted to read processed webhooks. Nothing was loaded."
          />
        ) : (
          <DataTable
            caption="Processed inbound webhooks, newest first"
            columns={columns}
            rows={list.items}
            rowKey={(row) => row.event_id}
            loading={list.loading}
            error={list.error}
            onRetry={list.reload}
            pageSize={25}
            empty={
              <EmptyState
                title={provider ? 'No events from that provider' : 'No webhook has been processed'}
                description={
                  provider
                    ? 'Nothing from that provider name is in the log. Provider names are matched exactly — check the spelling.'
                    : 'No inbound provider event has ever been handled. On a platform taking payments that means webhooks are not reaching the API at all, which is worth acting on.'
                }
              />
            }
          />
        )}
      </Section>
    </Stack>
  );
}
