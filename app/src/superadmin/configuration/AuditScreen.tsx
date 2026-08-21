import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  CodeBlock,
  Combobox,
  DataTable,
  PropertyGrid,
  Drawer,
  EmptyState,
  LockedState,
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
import { PAGE_SIZE } from '../recordListState';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
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

  // The actor is an exact-match server filter, so the options are the distinct
  // names in the response plus whatever is already applied.
  const actorOptions = useMemo(() => {
    const seen = new Set(
      audit.items.map((entry) => entry.actor_name).filter((name): name is string => Boolean(name)),
    );
    if (actor) seen.add(actor);
    return [...seen].sort().map((value) => ({ value, label: value }));
  }, [audit.items, actor]);

  const actionOptions: SelectOption[] = useMemo(() => {
    const seen = new Set(audit.items.map((entry) => entry.action));
    if (action) seen.add(action);
    return [
      { value: '', label: 'Every action' },
      ...[...seen].sort().map((value) => ({ value, label: value })),
    ];
  }, [audit.items, action]);

  // The console's page size, not a local one. Three screens declared their own
  // — 20, 25 and 25 — so a reader who paged through coupons, then the audit log,
  // then a webhook list met three different page lengths for no reason any of
  // them could state.
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
      <LockedState title={FORBIDDEN_TITLE} description={forbiddenDescription('the audit log')} />
    );
  }

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          {/* The actor is an exact-match server filter, so a text box was asking
              the reader to spell a colleague's name the way the log stores it. */}
          <Combobox
            size="sm"
            label="Filter by actor"
            value={actor || null}
            onValueChange={(next) => url.set({ actor: next })}
            options={actorOptions}
            placeholder="Every actor"
            clearable
          />
        </div>
        <div className="w-48">
          <Select
            size="sm"
            label="Filter by action"
            options={actionOptions}
            value={action}
            onValueChange={(value) => url.set({ action: value || null })}
          />
        </div>
        {actor || action ? (
          <Button size="sm" variant="ghost" onClick={() => url.set({ actor: null, action: null })}>
            Clear
          </Button>
        ) : null}
      </Toolbar>

      <Section
        title="Entries"
        description="Newest first, most recent 500 only. Open a row for the exact before and after."
      >
        <DataTable
          caption="Super-admin audit log"
          columns={columns}
          rows={pageRows}
          rowKey={(entry) => String(entry.id)}
          rowLabel={(entry) => `${entry.action} by ${entry.actor_name ?? 'unknown'}`}
          rowNoun="entry"
          rowNounPlural="entries"
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
            <PropertyGrid
              columns={2}
              density="compact"
              items={[
                { label: 'Actor', value: open.actor_name },
                { label: 'Actor id', value: <span className="figure">{open.actor_id}</span> },
                { label: 'Target type', value: open.target_type },
                { label: 'Target id', value: <span className="figure">{open.target_id}</span> },
                { label: 'IP', value: <span className="figure">{open.ip}</span> },
                { label: 'Entry id', value: <span className="figure">{formatNumber(open.id)}</span> },
                {
                  label: 'User agent',
                  value: open.user_agent ? (
                    <span className="figure break-words">{open.user_agent}</span>
                  ) : undefined,
                },
              ]}
            />
            <CodeBlock
              label="Before"
              code={open.before == null ? 'null' : JSON.stringify(open.before, null, 2)}
            />
            <CodeBlock
              label="After"
              code={open.after == null ? 'null' : JSON.stringify(open.after, null, 2)}
            />
          </div>
        ) : null}
      </Drawer>
    </Stack>
  );
}
