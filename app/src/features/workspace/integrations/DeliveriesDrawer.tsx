import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Radio } from 'lucide-react';
import {
  Badge,
  DataTable,
  Drawer,
  EmptyState,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../../ui';
import { getWebhookDeliveries } from '../../../services/api';
import { keys } from '../../../query/keys';
import type { Webhook, WebhookDelivery } from '../../../types/domain';
import {
  DELIVERY_LABEL,
  DELIVERY_TONE,
  deliveryOutcome,
  eventLabel,
} from './webhookModel';

const PAGE_SIZE = 50;

export interface DeliveriesDrawerProps {
  webhook: Webhook | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Every attempt we have made against one endpoint.
 *
 * This is the only place a customer can find out *why* their CRM has no leads
 * in it. It is server-paged rather than client-sliced: a busy endpoint has
 * thousands of attempts, and a pager over whatever one request returned reports
 * "1–50 of 50" for a log with nine thousand rows in it.
 */
export function DeliveriesDrawer({ webhook, onOpenChange }: DeliveriesDrawerProps) {
  const [page, setPage] = useState(1);

  const deliveries = useQuery({
    queryKey: keys.workspace.deliveries(webhook?.id ?? 0, page),
    queryFn: () => getWebhookDeliveries(webhook!.id, page),
    enabled: webhook !== null,
    staleTime: 15_000,
  });

  const columns: Column<WebhookDelivery>[] = [
    {
      key: 'event',
      header: 'Event',
      pinned: true,
      width: '11rem',
      render: (row) => <span className="text-text-primary">{eventLabel(row.event_type)}</span>,
    },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (row) => {
        const outcome = deliveryOutcome(row.status_code);
        return (
          <span className="flex items-center gap-1.5">
            <Badge tone={DELIVERY_TONE[outcome]}>{DELIVERY_LABEL[outcome]}</Badge>
            {row.status_code != null ? (
              <span className="figure text-xs text-text-tertiary">{row.status_code}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'attempt',
      header: 'Attempt',
      align: 'right',
      secondary: true,
      render: (row) => <span className="figure">{formatNumber(row.attempt)}</span>,
    },
    {
      key: 'when',
      header: 'When',
      align: 'right',
      render: (row) => (
        <span className="figure text-text-secondary">
          {formatDateTime(row.delivered_at ?? row.created_at)}
        </span>
      ),
    },
  ];

  return (
    <Drawer
      open={webhook !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPage(1);
          onOpenChange(false);
        }
      }}
      width="lg"
      title="Delivery log"
      description={webhook?.url}
    >
      <DataTable
        caption={`Delivery attempts for ${webhook?.url ?? 'this endpoint'}`}
        columns={columns}
        rows={deliveries.data?.deliveries ?? []}
        rowKey={(row) => String(row.id)}
        loading={deliveries.isPending}
        error={
          deliveries.isError
            ? deliveries.error instanceof Error
              ? deliveries.error.message
              : 'We could not load the delivery log.'
            : null
        }
        onRetry={() => void deliveries.refetch()}
        page={page}
        onPageChange={setPage}
        pageSize={PAGE_SIZE}
        rowCount={deliveries.data?.total ?? 0}
        empty={
          <EmptyState
            icon={Radio}
            compact
            title="Nothing sent yet"
            description="Attempts appear here as soon as one of the subscribed events happens. Use Send test to check the endpoint now."
          />
        }
      />
    </Drawer>
  );
}
