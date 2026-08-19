import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  CodeBlock,
  DataTable,
  DefinitionList,
  Drawer,
  EmptyState,
  Field,
  LockedState,
  SearchField,
  Section,
  Select,
  Stack,
  Toolbar,
  formatDateTime,
  formatNumber,
  truncateId,
  type Column,
  type SelectOption,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import type { AuditEntry } from './types';

/**
 * The audit log.
 *
 * Every write in this console lands here with a before and an after, which makes
 * it the one screen that can answer "who changed the plan" — and the reason the
 * plan editor, the flags and the replays all take the trouble to be explicit
 * about what they did.
 *
 * The endpoint filters on an exact `actor` name and an exact `action` and caps
 * at the 500 most recent rows with no offset, so the console says the cap out
 * loud rather than implying it is showing everything. The action list is built
 * from what came back, because there is no endpoint that enumerates them.
 */

const PAGE_SIZE = 25;

function actionTone(action: string): 'danger' | 'warning' | 'neutral' {
  if (/delete|deactivate|revoke|refund|replay/.test(action)) return 'danger';
  if (/update|patch|rotate|impersonat/.test(action)) return 'warning';
  return 'neutral';
}

export function AuditScreen() {
  const url = useUrlState();
  const actor = url.get('actor', '');
  const action = url.get('action', '');
  const page = url.getNumber('page', 1);
  const [open, setOpen] = useState<AuditEntry | null>(null);

  const audit = usePlatformList<AuditEntry>('/audit', {
    params: { actor: actor || undefined, action: action || undefined },
  });

  const actionOptions: SelectOption[] = useMemo(() => {
    const seen = new Set(audit.items.map((entry) => entry.action));
    if (action) seen.add(action);
    return [
      { value: '', label: 'Every action' },
      ...[...seen].sort().map((value) => ({ value, label: value })),
    ];
  }, [audit.items, action]);

  const pageRows = useMemo(
    () => audit.items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [audit.items, page],
  );

  const columns: Column<AuditEntry>[] = [
    {
      key: 'created_at',
      header: 'When',
      pinned: true,
      sortable: (a, b) => a.created_at.localeCompare(b.created_at),
      render: (entry) => <span className="figure">{formatDateTime(entry.created_at)}</span>,
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (entry) => (
        <div className="min-w-0">
          <p className="font-medium text-text-primary">{entry.actor_name ?? 'Unknown'}</p>
          <p className="figure text-2xs text-text-tertiary">
            {entry.actor_id == null ? '—' : `id ${entry.actor_id}`}
          </p>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (entry) => <Badge tone={actionTone(entry.action)}>{entry.action}</Badge>,
    },
    {
      key: 'target',
      header: 'Target',
      render: (entry) => (
        <span className="figure text-xs">
          {entry.target_type ?? '—'}
          {entry.target_id == null ? '' : ` · ${truncateId(String(entry.target_id))}`}
        </span>
      ),
    },
    {
      key: 'ip',
      header: 'From',
      align: 'right',
      secondary: true,
      render: (entry) => <span className="figure text-xs">{entry.ip ?? '—'}</span>,
    },
  ];

  if (audit.forbidden) {
    return (
      <LockedState
        title="You cannot read the audit log"
        description="Your super-admin account is not permitted to load it."
      />
    );
  }

  return (
    <Stack>
      <Alert tone="neutral" title="The 500 most recent entries">
        The endpoint returns no more than that and takes no offset, so filtering narrows what you are looking
        at rather than reaching further back. Anything older is in the database and not reachable from here.
      </Alert>

      <Toolbar>
        <div className="min-w-0 flex-1">
          <SearchField
            size="sm"
            label="Filter by actor name"
            placeholder="Exact actor name…"
            value={actor}
            onValueChange={(next) => url.set({ actor: next.trim() || null })}
          />
        </div>
        <Field label="Action" hideLabel className="w-64">
          <Select
            size="sm"
            options={actionOptions}
            value={action}
            onChange={(event) => url.set({ action: event.target.value || null })}
          />
        </Field>
        {actor || action ? (
          <Button size="sm" variant="ghost" onClick={() => url.set({ actor: null, action: null })}>
            Clear
          </Button>
        ) : null}
      </Toolbar>

      <Section
        title="Entries"
        description="Newest first. Open a row for the exact before and after the write recorded."
      >
        <DataTable
          caption="Super-admin audit log"
          columns={columns}
          rows={pageRows}
          rowKey={(entry) => String(entry.id)}
          rowLabel={(entry) => `${entry.action} by ${entry.actor_name ?? 'unknown'}`}
          loading={audit.loading && audit.items.length === 0}
          error={audit.error}
          onRetry={audit.reload}
          onRowClick={setOpen}
          pageSize={PAGE_SIZE}
          page={page}
          onPageChange={(next) => url.set({ page: next })}
          rowCount={audit.items.length}
          empty={
            <EmptyState
              title={actor || action ? 'Nothing matched that filter' : 'The audit log is empty'}
              description={
                actor || action
                  ? 'The actor name and the action both have to match exactly — the endpoint does no partial matching.'
                  : 'No write has been recorded. Every mutation from this console appends here.'
              }
              action={
                actor || action ? (
                  <Button size="sm" onClick={() => url.set({ actor: null, action: null })}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </Section>

      <Drawer
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        width="lg"
        title={open?.action ?? 'Audit entry'}
        description={open ? `Recorded ${formatDateTime(open.created_at)}` : undefined}
      >
        {open ? (
          <div className="flex flex-col gap-5">
            <DefinitionList
              columns={2}
              items={[
                { label: 'Actor', value: open.actor_name ?? 'Unknown' },
                { label: 'Actor id', value: <span className="figure">{open.actor_id ?? '—'}</span> },
                { label: 'Target type', value: open.target_type ?? '—' },
                { label: 'Target id', value: <span className="figure">{open.target_id ?? '—'}</span> },
                { label: 'IP', value: <span className="figure">{open.ip ?? '—'}</span> },
                { label: 'Entry id', value: <span className="figure">{formatNumber(open.id)}</span> },
              ]}
            />
            {open.user_agent ? (
              <div>
                <p className="text-xs text-text-tertiary">User agent</p>
                <p className="figure mt-0.5 break-words text-xs text-text-primary">{open.user_agent}</p>
              </div>
            ) : null}
            <div>
              <p className="mb-1.5 text-xs text-text-tertiary">Before</p>
              <CodeBlock
                label="before"
                code={open.before == null ? 'null' : JSON.stringify(open.before, null, 2)}
              />
            </div>
            <div>
              <p className="mb-1.5 text-xs text-text-tertiary">After</p>
              <CodeBlock
                label="after"
                code={open.after == null ? 'null' : JSON.stringify(open.after, null, 2)}
              />
            </div>
          </div>
        ) : null}
      </Drawer>
    </Stack>
  );
}
