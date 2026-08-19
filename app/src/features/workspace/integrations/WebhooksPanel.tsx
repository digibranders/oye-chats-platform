import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Plus, Radio, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  DataTable,
  EmptyState,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Section,
  Stack,
  Switch,
  buttonClass,
  toast,
  type Column,
} from '../../../ui';
import {
  deleteWebhook,
  getWebhooks,
  testWebhook,
  updateWebhook,
} from '../../../services/api';
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
    void queryClient.invalidateQueries({ queryKey: keys.workspace.webhooks(botId) });
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
      key: 'active',
      header: 'Send events',
      align: 'right',
      secondary: true,
      render: (webhook) => (
        <Switch
          size="sm"
          hideLabel
          label={`Send events to ${webhook.url}`}
          checked={Boolean(webhook.is_active)}
          onCheckedChange={(active) => toggle.mutate({ webhook, active })}
        />
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
            <MoreHorizontal aria-hidden className="h-4 w-4" />
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              icon={<Radio aria-hidden className="h-3.5 w-3.5" />}
              onSelect={() => setInspecting(webhook)}
            >
              Delivery log
            </MenuItem>
            <MenuItem
              icon={<Send aria-hidden className="h-3.5 w-3.5" />}
              onSelect={() => test.mutate(webhook)}
            >
              Send test event
            </MenuItem>
            <MenuItem
              icon={<Pencil aria-hidden className="h-3.5 w-3.5" />}
              onSelect={() => setEditing(webhook)}
            >
              Edit
            </MenuItem>
            <MenuItem
              destructive
              icon={<Trash2 aria-hidden className="h-3.5 w-3.5" />}
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
          description="We POST JSON to each of these as events happen, and retry five times over about six hours before giving up."
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEditing('new')}
              disabled={botId == null}
              iconLeft={<Plus aria-hidden className="h-3.5 w-3.5" />}
            >
              Add endpoint
            </Button>
          }
        />
        <DataTable
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
              description="Add one to push qualified leads straight into your CRM, or into Zapier or Make, without anyone re-typing them."
              action={
                <Button size="sm" onClick={() => setEditing('new')} disabled={botId == null}>
                  Add your first endpoint
                </Button>
              }
            />
          }
        />
      </Card>

      <Section
        title="What we send"
        description="The exact body an endpoint receives, so you can map it onto a CRM field by field."
      >
        <Card>
          <CardBody className="space-y-3">
            <CodeBlock code={PAYLOAD_EXAMPLE} label="example payload" caption="POST body" />
            <Alert tone="neutral">
              Every request carries an HMAC signature computed with the endpoint's signing secret.
              Verify it before you trust the body — otherwise anyone who learns your URL can create
              leads in your CRM.
            </Alert>
          </CardBody>
        </Card>
      </Section>

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
            We stop sending events to {deleting?.url} immediately, and its delivery history is
            deleted with it. Anything downstream that depends on these events — a CRM sync, a Slack
            alert, a Zap — stops working, silently, at the far end. If you only want to stop it for
            now, pause it instead.
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
