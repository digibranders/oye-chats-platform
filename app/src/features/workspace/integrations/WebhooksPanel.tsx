import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  Radio,
  Send,
  Trash2,
  Webhook as WebhookIcon,
} from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  CodeBlock,
  ConfirmDialog,
  DataTable,
  Disclosure,
  EmptyState,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Stack,
  buttonClass,
  toast,
  type Column,
} from '../../../ui';
import { deleteWebhook, getWebhooks, testWebhook, updateWebhook } from '../../../services/api';
import { keys } from '../../../query/keys';
import type { Webhook } from '../../../types/domain';
import { PAYLOAD_EXAMPLE, describeEvents } from './webhookModel';
import { WebhookDialog } from './WebhookDialog';
import { DeliveriesDrawer } from './DeliveriesDrawer';

export interface WebhooksPanelProps {
  botId: number | null;
}

/**
 * Endpoints we POST to when something happens.
 *
 * The delivery log is a first-class action rather than an inline expander: it
 * is a paged table, and expanding one inside the row pushed everything below it
 * hundreds of pixels down, so the endpoint being investigated left the screen.
 */
export function WebhooksPanel({ botId }: WebhooksPanelProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Webhook | null | 'new'>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [inspecting, setInspecting] = useState<Webhook | null>(null);

  const webhooks = useQuery({
    queryKey: keys.workspace.webhooks(botId),
    queryFn: () => getWebhooks(botId ?? undefined),
    enabled: botId != null,
    staleTime: 30_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: keys.workspace.webhooks(botId),
    });
  };

  const toggle = useMutation({
    mutationFn: ({ webhook, active }: { webhook: Webhook; active: boolean }) =>
      updateWebhook(webhook.id, { is_active: active }),
    onSuccess: (_data, { active }) => {
      toast.success(active ? 'Endpoint resumed' : 'Endpoint paused');
      invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not change that endpoint.'),
  });

  const test = useMutation({
    mutationFn: (webhook: Webhook) => testWebhook(webhook.id),
    onSuccess: () => {
      toast.success('Test event sent', {
        description: 'Open the delivery log to see how your endpoint answered.',
      });
      invalidate();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Could not send the test event.'),
  });

  const remove = useMutation({
    mutationFn: (webhook: Webhook) => deleteWebhook(webhook.id),
    onSuccess: () => {
      toast.success('Endpoint deleted');
      setDeleting(null);
      invalidate();
    },
  });

  const columns: Column<Webhook>[] = [
    {
      key: 'url',
      header: 'Endpoint',
      pinned: true,
      width: '18rem',
      render: (webhook) => (
        <div className="min-w-0">
          <p className="figure truncate text-sm text-text-primary">{webhook.url}</p>
          <p className="truncate text-xs text-text-secondary">{describeEvents(webhook.events)}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (webhook) => (
        <Badge tone={webhook.is_active ? 'success' : 'neutral'} dot>
          {webhook.is_active ? 'Sending' : 'Paused'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '3rem',
      render: (webhook) => (
        <MenuRoot>
          <MenuTrigger
            aria-label={`Actions for ${webhook.url}`}
            className={buttonClass('ghost', 'icon-sm')}
          >
            <MoreHorizontal aria-hidden />
          </MenuTrigger>
          <MenuContent>
            {/* Pause and Resume live here, not in a second column. `Status` and
                `Send events` were two columns saying `is_active` twice — and
                the switch column was `secondary`, so below `md` the badge
                stayed and the only way to pause disappeared. */}
            <MenuItem
              icon={<Power aria-hidden />}
              onSelect={() => toggle.mutate({ webhook, active: !webhook.is_active })}
            >
              {webhook.is_active ? 'Pause' : 'Resume'}
            </MenuItem>
            <MenuItem icon={<Radio aria-hidden />} onSelect={() => setInspecting(webhook)}>
              Delivery log
            </MenuItem>
            <MenuItem icon={<Send aria-hidden />} onSelect={() => test.mutate(webhook)}>
              Send test event
            </MenuItem>
            <MenuItem icon={<Pencil aria-hidden />} onSelect={() => setEditing(webhook)}>
              Edit
            </MenuItem>
            <MenuItem
              destructive
              icon={<Trash2 aria-hidden />}
              onSelect={() => setDeleting(webhook)}
            >
              Delete
            </MenuItem>
          </MenuContent>
        </MenuRoot>
      ),
    },
  ];

  return (
    <Stack>
      {botId == null ? (
        <Alert tone="warning" title="No chatbot selected">
          Endpoints belong to a chatbot, so pick one before adding any.
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Endpoints"
          titleAs="h2"
          description="We POST JSON as events happen, and retry five times over about six hours."
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEditing('new')}
              disabled={botId == null}
              iconLeft={<Plus aria-hidden />}
            >
              Add endpoint
            </Button>
          }
        />
        <CardBody flush>
          <DataTable
            seated
            rowNoun="endpoint"
            caption="Webhook endpoints registered for this chatbot"
            columns={columns}
            rows={webhooks.data ?? []}
            rowKey={(webhook) => String(webhook.id)}
            rowLabel={(webhook) => webhook.url}
            loading={webhooks.isPending && botId != null}
            error={
              webhooks.isError
                ? webhooks.error instanceof Error
                  ? webhooks.error.message
                  : 'We could not load your endpoints.'
                : null
            }
            onRetry={() => void webhooks.refetch()}
            empty={
              <EmptyState
                icon={WebhookIcon}
                title="No endpoints yet"
                description="Push qualified leads straight into your CRM, Zapier or Make."
                action={
                  <Button size="sm" onClick={() => setEditing('new')} disabled={botId == null}>
                    Add your first endpoint
                  </Button>
                }
              />
            }
          />
        </CardBody>
        {/* Collapsed. 300px of payload example is a first-run need, and it was
            being charged to every later visit as a `Section` plus a `Card` for
            one code block. */}
        <CardSection>
          <Disclosure summary="What we send">
            <div className="space-y-3">
              <CodeBlock code={PAYLOAD_EXAMPLE} label="example payload" caption="POST body" />
              <Alert tone="neutral">
                Every request carries an HMAC signature computed with the endpoint's signing secret.
                Verify it before you trust the body — otherwise anyone who learns your URL can
                create leads in your CRM.
              </Alert>
            </div>
          </Disclosure>
        </CardSection>
      </Card>

      <WebhookDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        webhook={editing === 'new' ? null : editing}
        botId={botId}
        onSaved={invalidate}
      />

      <DeliveriesDrawer webhook={inspecting} onOpenChange={() => setInspecting(null)} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this endpoint?"
        description={
          <>
            We stop sending events to {deleting?.url} immediately and its delivery history goes with
            it. Anything downstream stops working, silently. To stop it for now, pause it instead.
          </>
        }
        confirmLabel="Delete endpoint"
        destructive
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting);
        }}
      />
    </Stack>
  );
}
