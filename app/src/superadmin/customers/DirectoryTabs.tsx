import { useState } from 'react';
import { Link2Off } from 'lucide-react';
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  EmptyState,
  SearchField,
  Section,
  Select,
  Stack,
  Toolbar,
  Tooltip,
  formatDateTime,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, includesText, usePagedRows } from '../recordListState';
import type {
  ApiKeyRegistry,
  NotificationRow,
  OAuthAccountRow,
  OperatorRow,
  PushSubscriptionRow,
} from './types';

/** Every list here is filtered in the browser unless a tab says otherwise. */
const CONSOLE_FILTER_NOTE = 'Filters the rows already loaded — the endpoint accepts no search parameter.';

/* --------------------------------------------------------------- operators */

const OPERATOR_ROLE_TONE: Record<string, 'plan' | 'success' | 'neutral'> = {
  owner: 'plan',
  admin: 'success',
  operator: 'neutral',
};

export function OperatorsTab() {
  const url = useUrlState();
  const query = url.get('q');
  const role = url.get('role');
  const list = usePlatformList<OperatorRow>('/operators');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) =>
      (!role || row.role === role) &&
      includesText([row.name, row.email, row.client_name, row.role], query),
    comparators: {
      name: byText((row) => row.name),
      client_name: byText((row) => row.client_name),
      role: byText((row) => row.role),
      max_concurrent_chats: byNumber((row) => row.max_concurrent_chats),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<OperatorRow>[] = [
    {
      key: 'name',
      header: 'Operator',
      pinned: true,
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="truncate text-xs text-text-secondary">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'client_name',
      header: 'Workspace',
      sortable: true,
      render: (row) => row.client_name ?? '—',
    },
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      render: (row) => <Badge tone={OPERATOR_ROLE_TONE[row.role] ?? 'neutral'}>{row.role}</Badge>,
    },
    {
      key: 'is_active',
      header: 'State',
      render: (row) =>
        row.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Disabled</Badge>,
    },
    {
      key: 'max_concurrent_chats',
      header: 'Chat limit',
      align: 'right',
      sortable: true,
      secondary: true,
      render: (row) => formatNumber(row.max_concurrent_chats),
    },
    {
      key: 'created_at',
      header: 'Added',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search operators"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Name, email or workspace"
          />
        </div>
        <div className="w-48">
          <Select
            label="Filter by role"
            value={role}
            onValueChange={(value) => url.set({ role: value })}
            options={[
              { value: '', label: 'Every role' },
              { value: 'owner', label: 'Owner' },
              { value: 'admin', label: 'Admin' },
              { value: 'operator', label: 'Operator' },
            ]}
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Live-chat operators across every workspace"
        rowNoun="operator"
        what="the operator directory"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        note={CONSOLE_FILTER_NOTE}
        empty={
          <EmptyState
            compact
            title={query || role ? 'Nothing matched' : 'No operators'}
            description={
              query || role
                ? 'No operator on the platform matches this filter. Clear it to see the whole list.'
                : 'No workspace has invited a live-chat operator yet.'
            }
          />
        }
      />
    </Stack>
  );
}

/* ---------------------------------------------------------- oauth accounts */

export function IdentitiesTab() {
  const url = useUrlState();
  const query = url.get('q');
  const list = usePlatformList<OAuthAccountRow>('/oauth-accounts');
  const [pending, setPending] = useState<OAuthAccountRow | null>(null);

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.email, row.client_name, row.provider, row.provider_user_id], query),
    comparators: {
      email: byText((row) => row.email),
      client_name: byText((row) => row.client_name),
      provider: byText((row) => row.provider),
      last_login_at: byDate((row) => row.last_login_at),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<OAuthAccountRow>[] = [
    {
      key: 'email',
      header: 'Identity',
      pinned: true,
      sortable: true,
      render: (row) => <span className="font-medium">{row.email ?? '—'}</span>,
    },
    { key: 'provider', header: 'Provider', sortable: true, render: (row) => <Badge>{row.provider}</Badge> },
    { key: 'client_name', header: 'Account', sortable: true, render: (row) => row.client_name ?? '—' },
    {
      key: 'last_login_at',
      header: 'Last sign-in',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.last_login_at),
    },
    {
      key: 'created_at',
      header: 'Linked',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="ghost" onClick={() => setPending(row)}>
          <Link2Off aria-hidden className="h-3.5 w-3.5" />
          Unlink
        </Button>
      ),
    },
  ];

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search sign-in identities"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Email, account or provider"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="External sign-in identities linked to accounts"
        rowNoun="identity"
        rowNounPlural="identities"
        what="linked sign-in identities"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note={CONSOLE_FILTER_NOTE}
        empty={
          <EmptyState
            compact
            title={query ? 'Nothing matched' : 'No linked identities'}
            description={
              query
                ? 'No linked identity matches this search. Clear it to see the whole list.'
                : 'Nobody has signed in with an external provider such as Google.'
            }
          />
        }
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={pending ? `Unlink ${pending.provider} from ${pending.client_name ?? 'this account'}?` : 'Unlink'}
        description={
          <>
            The customer can no longer sign in with {pending?.provider ?? 'this provider'}. If they
            have never set a password, they will need a reset code before they can get back in — send
            one from the account first.
          </>
        }
        confirmLabel="Unlink identity"
        destructive
        onConfirm={async () => {
          if (!pending) return;
          await platform.remove(`/oauth-accounts/${pending.id}`);
          setPending(null);
          list.reload();
          toast.success('Identity unlinked.');
        }}
      />
    </Stack>
  );
}

/* ---------------------------------------------------------------- API keys */

export function CredentialsTab() {
  const url = useUrlState();
  const query = url.get('q');
  // `/api-keys` answers with `{clients, operators}` — an object of two arrays,
  // not a list. `toList` would find no array under any of its candidate keys and
  // hand back an empty envelope, so this is read as a single resource.
  const registry = usePlatformResource<ApiKeyRegistry>('/api-keys');
  const clientRows = registry.data?.clients ?? [];
  const operatorRows = registry.data?.operators ?? [];

  const clients = usePagedRows(clientRows, {
    url,
    pageKey: 'cpage',
    sortKey: 'csort',
    filter: (row) => includesText([row.name, row.email], query),
    comparators: {
      name: byText((row) => row.name),
      email: byText((row) => row.email),
      created_at: byDate((row) => row.created_at),
    },
  });

  const operators = usePagedRows(operatorRows, {
    url,
    pageKey: 'opage',
    sortKey: 'osort',
    filter: (row) => includesText([row.name, row.client_name], query),
    comparators: {
      name: byText((row) => row.name),
      client_name: byText((row) => row.client_name),
    },
  });

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search credentials"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Account or operator name"
          />
        </div>
      </Toolbar>

      <Section
        title="Account API keys"
        description="Rotated from the account itself."
      >
        <RecordList
          caption="Account API keys, masked"
          rowNoun="account key"
          what="the API key registry"
        columns={[
          { key: 'name', header: 'Account', pinned: true, sortable: true, render: (row) => row.name },
          { key: 'email', header: 'Email', sortable: true, render: (row) => row.email },
          {
            key: 'api_key_masked',
            header: 'Key',
            render: (row) => <span className="font-mono text-xs">{row.api_key_masked}</span>,
          },
          {
            key: 'created_at',
            header: 'Account created',
            sortable: true,
            secondary: true,
            render: (row) => formatDateTime(row.created_at),
          },
        ]}
        paged={clients}
        rowKey={(row) => `client-${row.id}`}
        loading={registry.loading}
        error={registry.error}
        forbidden={registry.forbidden}
        onRetry={registry.reload}
        loaded={clientRows.length}
        cap={200}
        note="Masked to the last four characters. The full value is never returned by the API."
        empty={
          <EmptyState compact title="No account keys" description="No account matched this search." />
        }
        />
      </Section>

      <Section
        title="Operator API keys"
        description="Not rotatable from this console."
      >
        <RecordList
          caption="Operator API keys, masked"
          rowNoun="operator key"
          what="the API key registry"
        columns={[
          { key: 'name', header: 'Operator', pinned: true, sortable: true, render: (row) => row.name },
          {
            key: 'client_name',
            header: 'Workspace',
            sortable: true,
            render: (row) => row.client_name ?? '—',
          },
          {
            key: 'api_key_masked',
            header: 'Key',
            render: (row) => <span className="font-mono text-xs">{row.api_key_masked}</span>,
          },
          {
            key: 'is_active',
            header: 'State',
            render: (row) =>
              row.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Disabled</Badge>,
          },
        ]}
        paged={operators}
        rowKey={(row) => `operator-${row.id}`}
        loading={registry.loading}
        error={registry.error}
        forbidden={registry.forbidden}
        onRetry={registry.reload}
        loaded={operatorRows.length}
        cap={200}
          empty={
            <EmptyState compact title="No operator keys" description="No operator matched this search." />
          }
        />
      </Section>
    </Stack>
  );
}

/* ------------------------------------------------------------------ devices */

export function DevicesTab() {
  const url = useUrlState();
  const query = url.get('q');
  const list = usePlatformList<PushSubscriptionRow>('/push-subscriptions');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.endpoint_masked, row.user_agent], query),
    comparators: {
      endpoint_masked: byText((row) => row.endpoint_masked),
      last_used_at: byDate((row) => row.last_used_at),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<PushSubscriptionRow>[] = [
    {
      key: 'endpoint_masked',
      header: (
        <Tooltip content="Masked — the path carries a per-device secret, and the encryption keys are never returned at all.">
          <span className="cursor-help underline decoration-dotted underline-offset-2">
            Push endpoint
          </span>
        </Tooltip>
      ),
      pinned: true,
      sortable: true,
      render: (row) => <span className="font-mono text-xs">{row.endpoint_masked}</span>,
    },
    {
      key: 'operator_id',
      header: 'Operator',
      render: (row) => (row.operator_id ? <span className="figure">#{row.operator_id}</span> : '—'),
    },
    {
      key: 'client_id',
      header: 'Account',
      render: (row) => (row.client_id ? <span className="figure">#{row.client_id}</span> : '—'),
    },
    {
      key: 'user_agent',
      header: 'Device',
      secondary: true,
      render: (row) => <span className="truncate text-xs text-text-secondary">{row.user_agent ?? '—'}</span>,
    },
    {
      key: 'last_used_at',
      header: 'Last used',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.last_used_at),
    },
  ];

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search push devices"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Endpoint host or device"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Web Push device subscriptions"
        rowNoun="device"
        what="registered devices"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        empty={
          <EmptyState
            compact
            title={query ? 'Nothing matched' : 'No registered devices'}
            description={
              query
                ? 'No push subscription matches this search.'
                : 'No operator has enabled browser notifications on a device.'
            }
          />
        }
      />
    </Stack>
  );
}

/* ------------------------------------------------------------ notifications */

export function NotificationsTab() {
  const url = useUrlState();
  const query = url.get('q');
  const type = url.get('type');
  // `type` is a real server-side filter on this endpoint, so it is sent rather
  // than applied here — which also means it is not limited by the 500-row cap.
  const list = usePlatformList<NotificationRow>('/notifications', { params: { type } });

  const types = Array.from(
    new Set([...list.items.map((row) => row.type), ...(type ? [type] : [])]),
  ).sort();

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.title, row.body, row.type], query),
    comparators: {
      title: byText((row) => row.title),
      type: byText((row) => row.type),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<NotificationRow>[] = [
    {
      key: 'title',
      header: 'Notification',
      pinned: true,
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.title}</p>
          {row.body ? <p className="truncate text-xs text-text-secondary">{row.body}</p> : null}
        </div>
      ),
    },
    { key: 'type', header: 'Type', sortable: true, render: (row) => <Badge>{row.type}</Badge> },
    {
      key: 'client_id',
      header: 'Account',
      render: (row) => (row.client_id ? <span className="figure">#{row.client_id}</span> : '—'),
    },
    {
      key: 'is_read',
      header: 'Read',
      render: (row) =>
        row.is_read ? <Badge tone="neutral">Read</Badge> : <Badge tone="warning">Unread</Badge>,
    },
    {
      key: 'created_at',
      header: 'Sent',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search notifications"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Title or body"
          />
        </div>
        <div className="w-48">
          {/* The type is an exact-match server filter, so asking the operator to
              type it verbatim was asking them to know the enum. The options are
              read out of what came back, plus whatever is already applied. */}
          <Combobox
            label="Filter by notification type"
            value={type || null}
            onValueChange={(next) => url.set({ type: next })}
            options={types.map((value) => ({ value, label: value.replace(/_/g, ' ') }))}
            placeholder="Any type"
            clearable
            size="sm"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="In-app notifications across every workspace"
        rowNoun="notification"
        what="the notification log"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="Type is matched exactly, by the server. The search box then filters the rows already loaded."
        empty={
          <EmptyState
            compact
            title={query || type ? 'Nothing matched' : 'No notifications'}
            description={
              query || type
                ? 'No notification matches this filter. A type must match exactly.'
                : 'No workspace has been sent an in-app notification.'
            }
          />
        }
      />
    </Stack>
  );
}
