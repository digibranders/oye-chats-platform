import {
  Button,
  Combobox,
  EmptyState,
  Section,
  Stack,
  Toolbar,
  formatDateTime,
  type Column,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, usePagedRows } from '../recordListState';
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

  const paged = usePagedRows(list.items, {
    url,
    comparators: { processed_at: byDate((row) => row.processed_at) },
  });

  // The provider is an exact-match server filter, so it was a box asking the
  // operator to spell "razorpay" correctly. The options are the distinct
  // providers in the response, plus whatever is already applied.
  const providerOptions = Array.from(
    new Set([...list.items.map((row) => row.provider), ...(provider ? [provider] : [])]),
  )
    .sort()
    .map((value) => ({ value, label: value }));

  const columns: readonly Column<ProcessedWebhookRow>[] = [
    {
      key: 'processed_at',
      header: 'Processed',
      pinned: true,
      width: '14rem',
      sortable: true,
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
        description="Every inbound event id already handled. A missing id means the event never reached us."
      >
        <Toolbar sticky className="mb-3">
          <div className="w-48">
            <Combobox
              size="sm"
              label="Filter by provider"
              value={provider || null}
              onValueChange={(next) => url.set({ provider: next })}
              options={providerOptions}
              placeholder="Every provider"
              clearable
            />
          </div>
          {provider ? (
            <Button size="sm" variant="ghost" onClick={() => url.set({ provider: null })}>
              Show every provider
            </Button>
          ) : null}
        </Toolbar>

        <RecordList
          caption="Processed inbound webhooks, newest first"
          columns={columns}
          paged={paged}
          rowKey={(row) => row.event_id}
          rowNoun="event"
          what="processed webhooks"
          loading={list.loading}
          error={list.error}
          forbidden={list.forbidden}
          onRetry={list.reload}
          loaded={list.items.length}
          cap={SERVER_CAP}
          note="An id you cannot find here may simply be older than the window this endpoint returns."
          empty={
            <EmptyState
              title={provider ? 'No events from that provider' : 'No webhook has been processed'}
              description={
                provider
                  ? 'Nothing from that provider is in the log.'
                  : 'No inbound provider event has ever been handled — on a platform taking payments, that means webhooks are not reaching the API.'
              }
            />
          }
        />
      </Section>
    </Stack>
  );
}
