import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LockedState,
  LoadingRows,
  PropertyGrid,
  Section,
  Stack,
  Switch,
  formatDateTime,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import type {
  EmailTemplates,
  FailedWebhook,
  WebhookDelivery,
  WebhookRegistration,
} from './types';

/**
 * Everything the platform sends out: webhooks and transactional email.
 *
 * The replay controls are the reason this screen is careful. A replay is not a
 * retry of something that failed on our side — it is a **repeat of an event the
 * customer's system may already have processed**. Re-delivering an
 * `order-created` can double-charge somebody downstream, and re-processing a
 * dead-lettered Razorpay event runs the money path again (idempotently, on the
 * provider event id, which is a guarantee about our ledger, not about theirs).
 * So both confirms say that in those words, and neither is a one-click action.
 */

const PAGE_SIZE = 25;

type View = 'deliveries' | 'registrations' | 'failed' | 'email';

function deliveryTone(delivery: WebhookDelivery): { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string } {
  if (delivery.delivered_at) return { tone: 'success', label: `Delivered · ${delivery.status_code ?? '2xx'}` };
  if (delivery.next_retry_at) return { tone: 'warning', label: `Retrying · attempt ${delivery.attempt}` };
  if (delivery.status_code && delivery.status_code >= 400)
    return { tone: 'danger', label: `Failed · ${delivery.status_code}` };
  return { tone: 'neutral', label: `Attempt ${delivery.attempt}` };
}

/**
 * The four outbound surfaces.
 *
 * `view` is a route, not a segmented control inside one: these are peers of
 * Flags and Runtime, not children of a fifth thing, and the console had page
 * title → tab row → segmented control → toolbar → table before the first row of
 * data on every one of them.
 */
export function OutboundScreen({ view }: { view: View }) {
  const url = useUrlState();
  const page = url.getNumber('page', 1);

  const deliveries = usePlatformList<WebhookDelivery>('/webhooks', { enabled: view === 'deliveries' });
  const registrations = usePlatformList<WebhookRegistration>('/webhook-registrations', {
    enabled: view === 'registrations',
  });
  const failed = usePlatformList<FailedWebhook>('/failed-webhooks', { enabled: view === 'failed' });
  const email = usePlatformResource<EmailTemplates>(view === 'email' ? '/email-templates' : null);

  const [replayDelivery, setReplayDelivery] = useState<WebhookDelivery | null>(null);
  const [replayFailed, setReplayFailed] = useState<FailedWebhook | null>(null);
  const [pendingToggle, setPendingToggle] = useState<{ row: WebhookRegistration; next: boolean } | null>(null);
  const [testTarget, setTestTarget] = useState<WebhookRegistration | null>(null);

  function slice<T>(rows: readonly T[]): T[] {
    return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }

  // Failures are deliberately left to throw. `ConfirmDialog` catches them, keeps
  // itself open and renders the message inside — which is where the reader is
  // looking. Surfacing the same failure a second time on the page behind it
  // would put two copies of one sentence on screen at once.
  async function run(action: () => Promise<unknown>, success: string, reload: () => void): Promise<void> {
    await action();
    toast.success(success);
    reload();
  }

  const deliveryColumns: Column<WebhookDelivery>[] = [
    {
      key: 'event',
      header: 'Event',
      pinned: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="figure font-medium text-text-primary">{row.event}</p>
          <p className="figure text-2xs text-text-tertiary">webhook {row.webhook_id}</p>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (row) => {
        const state = deliveryTone(row);
        return <Badge tone={state.tone}>{state.label}</Badge>;
      },
    },
    { key: 'attempt', header: 'Attempt', align: 'right', render: (row) => formatNumber(row.attempt) },
    {
      key: 'created',
      header: 'Queued',
      align: 'right',
      secondary: true,
      sortable: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'delivered',
      header: 'Delivered',
      align: 'right',
      secondary: true,
      render: (row) => (row.delivered_at ? formatDateTime(row.delivered_at) : '—'),
    },
    {
      key: 'next',
      header: 'Next retry',
      align: 'right',
      secondary: true,
      render: (row) => (row.next_retry_at ? formatDateTime(row.next_retry_at) : '—'),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="ghost" onClick={() => setReplayDelivery(row)}>
          Replay
        </Button>
      ),
    },
  ];

  const registrationColumns: Column<WebhookRegistration>[] = [
    {
      key: 'url',
      header: 'Endpoint',
      pinned: true,
      sortable: (a, b) => a.url.localeCompare(b.url),
      render: (row) => (
        <div className="min-w-0">
          <p className="figure truncate font-medium text-text-primary">{row.url}</p>
          <p className="text-2xs text-text-tertiary">
            {row.client_name ?? 'Unknown account'} · {row.bot_name ?? `bot ${row.bot_id}`}
          </p>
        </div>
      ),
    },
    {
      key: 'events',
      header: 'Events',
      render: (row) => (row.events.length > 0 ? row.events.join(', ') : 'Everything'),
    },
    {
      key: 'active',
      header: 'State',
      render: (row) => (
        <Badge tone={row.is_active ? 'success' : 'neutral'} dot>
          {row.is_active ? 'Active' : 'Disabled'}
        </Badge>
      ),
    },
    {
      key: 'created',
      header: 'Registered',
      align: 'right',
      secondary: true,
      sortable: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <span className="flex items-center justify-end gap-2">
          <Switch
            size="sm"
            hideLabel
            label={`${row.is_active ? 'Disable' : 'Enable'} ${row.url}`}
            checked={row.is_active}
            onCheckedChange={(checked) => setPendingToggle({ row, next: checked })}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setTestTarget(row)}
          >
            Send test
          </Button>
        </span>
      ),
    },
  ];

  const failedColumns: Column<FailedWebhook>[] = [
    {
      key: 'event',
      header: 'Event',
      pinned: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="figure font-medium text-text-primary">{row.event_type ?? 'unknown'}</p>
          <p className="figure text-2xs text-text-tertiary">{row.event_id ?? '—'}</p>
        </div>
      ),
    },
    { key: 'provider', header: 'Provider', render: (row) => row.provider },
    {
      key: 'status',
      header: 'State',
      render: (row) => (
        <Badge tone={row.status === 'replayed' ? 'success' : row.status === 'ignored' ? 'neutral' : 'danger'}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'error',
      header: 'Why it dead-lettered',
      secondary: true,
      render: (row) => <span className="figure text-xs">{row.error ?? '—'}</span>,
    },
    {
      key: 'created',
      header: 'Received',
      align: 'right',
      secondary: true,
      sortable: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          disabled={row.status === 'replayed' || row.provider !== 'razorpay'}
          onClick={() => setReplayFailed(row)}
        >
          Replay
        </Button>
      ),
    },
  ];

  const activeList =
    view === 'deliveries' ? deliveries : view === 'registrations' ? registrations : view === 'failed' ? failed : null;

  const templatesByCategory = useMemo(() => {
    const grouped = new Map<string, EmailTemplates['templates']>();
    for (const template of email.data?.templates ?? []) {
      const list = grouped.get(template.category) ?? [];
      list.push(template);
      grouped.set(template.category, list);
    }
    return [...grouped.entries()];
  }, [email.data]);

  if (activeList?.forbidden || email.forbidden) {
    return (
      <LockedState
        title="You cannot read this"
        description="Your super-admin account is not permitted to load these records. Nothing was replayed or changed."
      />
    );
  }

  return (
    <Stack>
      {view === 'deliveries' ? (
        <Section
          title="Outbound deliveries"
          description="The 500 most recent attempts. Retries run at 30s, 2m, 10m, 1h and 4h on their own; a replay is a repeat, and is how a downstream system charges twice."
        >
          <DataTable
            caption="Webhook delivery attempts"
            columns={deliveryColumns}
            rows={slice(deliveries.items)}
            rowKey={(row) => String(row.id)}
            rowLabel={(row) => `${row.event} attempt ${row.attempt}`}
            loading={deliveries.loading && deliveries.items.length === 0}
            error={deliveries.error}
            onRetry={deliveries.reload}
            pageSize={PAGE_SIZE}
            page={page}
            onPageChange={(next) => url.set({ page: next })}
            rowCount={deliveries.items.length}
            empty={
              <EmptyState
                title="Nothing has been delivered"
                description="No customer webhook has fired, or the delivery log has been cleared."
              />
            }
          />
        </Section>
      ) : null}

      {view === 'registrations' ? (
        <Section
          title="Customer registrations"
          description="Registered by customers themselves. The signing secret is never returned by the API."
        >
          <DataTable
            caption="Webhook registrations"
            columns={registrationColumns}
            rows={slice(registrations.items)}
            rowKey={(row) => String(row.id)}
            rowLabel={(row) => row.url}
            loading={registrations.loading && registrations.items.length === 0}
            error={registrations.error}
            onRetry={registrations.reload}
            pageSize={PAGE_SIZE}
            page={page}
            onPageChange={(next) => url.set({ page: next })}
            rowCount={registrations.items.length}
            empty={
              <EmptyState
                title="No customer has registered a webhook"
                description="Registrations need the webhooks entitlement, so only paid plans can create one."
              />
            }
          />
        </Section>
      ) : null}

      {view === 'failed' ? (
        <Section
          title="Dead-lettered billing events"
          description="Inbound Razorpay events whose processing failed. Replaying re-runs the money path: idempotency protects our ledger, not what the event triggers elsewhere."
        >
          <DataTable
            caption="Failed billing webhooks"
            columns={failedColumns}
            rows={slice(failed.items)}
            rowKey={(row) => String(row.id)}
            rowLabel={(row) => row.event_type ?? `event ${row.id}`}
            loading={failed.loading && failed.items.length === 0}
            error={failed.error}
            onRetry={failed.reload}
            pageSize={PAGE_SIZE}
            page={page}
            onPageChange={(next) => url.set({ page: next })}
            rowCount={failed.items.length}
            empty={
              <EmptyState
                title="Nothing has dead-lettered"
                description="Every inbound billing webhook has been processed. That is the healthy reading."
              />
            }
          />
        </Section>
      ) : null}

      {view === 'email' ? (
        <Section
          title="Transactional email"
          description="Names and triggers only — the bodies live in Brevo."
        >
          {email.loading && !email.data ? (
            <Card>
              <CardBody>
                <LoadingRows rows={5} />
              </CardBody>
            </Card>
          ) : email.error && !email.data ? (
            <Alert
              tone="danger"
              title="The template catalogue could not be loaded"
              action={
                <Button size="sm" onClick={email.reload}>
                  Try again
                </Button>
              }
            >
              {email.error}
            </Alert>
          ) : email.data ? (
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader
                  titleAs="h3"
                  title={email.data.provider}
                  description="Sending identity and whether the platform is sending at all."
                  actions={
                    <Badge tone={email.data.enabled ? 'success' : 'danger'} dot>
                      {email.data.enabled ? 'Sending' : 'Disabled'}
                    </Badge>
                  }
                />
                <CardBody>
                  <PropertyGrid
                    columns={2}
                    density="compact"
                    items={[
                      {
                        label: 'From address',
                        value: <span className="figure">{email.data.from_address}</span>,
                      },
                      { label: 'From name', value: email.data.from_name },
                      {
                        label: 'Templates',
                        value: (
                          <span className="figure">{formatNumber(email.data.templates.length)}</span>
                        ),
                      },
                    ]}
                  />
                </CardBody>
              </Card>

              {templatesByCategory.map(([category, templates]) => (
                <Card key={category}>
                  <CardHeader titleAs="h3" title={category.replace(/_/g, ' ')} />
                  <CardBody>
                    <ul className="flex flex-col gap-3">
                      {templates.map((template) => (
                        <li key={template.key} className="border-b border-border pb-3 last:border-b-0 last:pb-0">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <p className="text-base font-medium text-text-primary">{template.name}</p>
                            <span className="flex items-center gap-2">
                              <Badge tone="neutral">{template.audience}</Badge>
                              <span className="figure text-2xs text-text-tertiary">
                                id {template.id ?? '—'}
                              </span>
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                            {template.description}
                          </p>
                          <p className="figure mt-1 text-2xs text-text-tertiary">
                            Triggered by {template.trigger} · {template.sender_fn}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}

      <ConfirmDialog
        open={replayDelivery !== null}
        onOpenChange={(open) => {
          if (!open) setReplayDelivery(null);
        }}
        destructive
        title="Send this event to the customer again?"
        confirmLabel="Replay delivery"
        onConfirm={async () => {
          if (!replayDelivery) return;
          await run(
            () => platform.post(`/webhooks/${replayDelivery.id}/replay`),
            'Replay queued.',
            deliveries.reload,
          );
          setReplayDelivery(null);
        }}
        description={
          replayDelivery ? (
            <div className="space-y-2">
              <p>
                This re-sends <span className="figure">{replayDelivery.event}</span> to the same endpoint as a
                fresh attempt. If an earlier attempt already succeeded, the customer's system will see the
                event twice — a replayed order or payment event can charge or provision somebody twice
                downstream.
              </p>
              <p className="text-xs">
                The parent webhook must still exist and be active, or the API refuses. The replay is recorded
                in the audit log against your account.
              </p>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={replayFailed !== null}
        onOpenChange={(open) => {
          if (!open) setReplayFailed(null);
        }}
        destructive
        title="Re-process this billing event?"
        confirmLabel="Replay event"
        onConfirm={async () => {
          if (!replayFailed) return;
          await run(
            () => platform.post(`/failed-webhooks/${replayFailed.id}/replay`),
            'Event re-processed.',
            failed.reload,
          );
          setReplayFailed(null);
        }}
        description={
          replayFailed ? (
            <div className="space-y-2">
              <p>
                The stored payload is re-verified against the Razorpay webhook secret and handed back to the
                billing handler, so subscriptions, invoices and credit grants can all move.
              </p>
              <p className="text-xs">
                Idempotency on the provider event id makes a repeat safe for our ledger even if the original
                eventually processed. It says nothing about emails already sent or systems already notified.
              </p>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={pendingToggle !== null}
        onOpenChange={(open) => {
          if (!open) setPendingToggle(null);
        }}
        destructive={pendingToggle?.next === false}
        title={
          pendingToggle?.next
            ? 'Re-enable this customer webhook?'
            : "Disable this customer's webhook?"
        }
        confirmLabel={pendingToggle?.next ? 'Enable' : 'Disable'}
        onConfirm={async () => {
          if (!pendingToggle) return;
          await run(
            () =>
              platform.patch(`/webhook-registrations/${pendingToggle.row.id}`, {
                is_active: pendingToggle.next,
              }),
            pendingToggle.next ? 'Registration enabled.' : 'Registration disabled.',
            registrations.reload,
          );
          setPendingToggle(null);
        }}
        description={
          pendingToggle ? (
            pendingToggle.next ? (
              <>
                Events will start reaching <span className="figure">{pendingToggle.row.url}</span> again.
                Anything that fired while it was off is not backfilled.
              </>
            ) : (
              <>
                The customer stops receiving events at <span className="figure">{pendingToggle.row.url}</span>{' '}
                immediately, and they are not told. Nothing is queued for later — the events are simply not
                delivered.
              </>
            )
          ) : null
        }
      />

      <ConfirmDialog
        open={testTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTestTarget(null);
        }}
        title="Send a test event?"
        confirmLabel="Send test"
        onConfirm={async () => {
          if (!testTarget) return;
          await run(
            () => platform.post(`/webhook-registrations/${testTarget.id}/test`),
            'Test event dispatched.',
            registrations.reload,
          );
          setTestTarget(null);
        }}
        description={
          testTarget ? (
            <>
              A sample <span className="figure">tier_transition</span> payload is dispatched to{' '}
              <span className="figure">{testTarget.url}</span>. It carries{' '}
              <span className="figure">test: true</span> and a fabricated session id, but the customer's
              system receives it as a real delivery and will act on it if it does not check that flag.
            </>
          ) : null
        }
      />
    </Stack>
  );
}
