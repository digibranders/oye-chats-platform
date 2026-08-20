import {
  Badge,
  Button,
  Combobox,
  EmptyState,
  Section,
  Stack,
  Toolbar,
  formatDate,
  formatDateTime,
  formatNumber,
  truncateId,
  type Column,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byNumber, usePagedRows } from '../recordListState';
import type { ClientRow } from '../customers/types';
import { usageLabel, usageTone, usdCents } from '../money';
import type { CreditLedgerRow, UsageRecordRow } from './types';

/**
 * What customers consumed, and the credit ledger underneath it.
 *
 * Both endpoints take exactly one filter — `client_id` — and cap at 500 rows,
 * so this tab offers exactly one filter and says when the cap is reached. Two
 * lists on one tab because they answer one question together: a workspace that
 * blew through its message allowance and a workspace whose credit balance is
 * draining are the same conversation.
 */

/** Both handlers `.limit(500)`. */
const SERVER_CAP = 500;

export function UsageCreditsTab() {
  const url = useUrlState();
  const clientId = url.get('client');
  const filter = clientId ? { client_id: clientId } : undefined;

  const usage = usePlatformList<UsageRecordRow>('/usage-records', { params: filter });
  const ledger = usePlatformList<CreditLedgerRow>('/credits/ledger', { params: filter });
  // Accounts, so the one filter both endpoints accept is a name rather than an
  // integer id nobody knows by heart.
  const clients = usePlatformList<ClientRow>('/clients');

  const usagePaged = usePagedRows(usage.items, {
    url,
    pageKey: 'upage',
    sortKey: 'usort',
    comparators: {
      period: byDate((row) => row.period_start),
      ai: byNumber((row) => row.ai_messages_used),
      live: byNumber((row) => row.live_chat_messages_used),
      scans: byNumber((row) => row.url_scans_used),
      storage: byNumber((row) => row.storage_used_mb),
      overage: byNumber((row) => row.overage_amount_cents),
    },
  });

  const ledgerPaged = usePagedRows(ledger.items, {
    url,
    pageKey: 'lpage',
    sortKey: 'lsort',
    comparators: {
      created: byDate((row) => row.created_at),
      delta: byNumber((row) => row.delta),
    },
  });

  const usageColumns: readonly Column<UsageRecordRow>[] = [
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
          <p className="figure truncate text-2xs text-text-tertiary">
            {row.plan_name ?? 'no active plan'} · client #{row.client_id}
          </p>
        </div>
      ),
    },
    {
      key: 'period',
      header: 'Period',
      width: '13rem',
      sortable: true,
      render: (row) => (
        <span className="figure text-sm">
          {formatDate(row.period_start)} – {formatDate(row.period_end)}
        </span>
      ),
    },
    {
      key: 'ai',
      header: 'AI messages',
      align: 'right',
      width: '11rem',
      sortable: true,
      render: (row) => (
        <QuotaCell used={row.ai_messages_used} limit={row.ai_messages_limit} />
      ),
    },
    {
      key: 'live',
      header: 'Live chat',
      align: 'right',
      width: '11rem',
      secondary: true,
      sortable: true,
      render: (row) => (
        <QuotaCell used={row.live_chat_messages_used} limit={row.live_chat_messages_limit} />
      ),
    },
    {
      key: 'scans',
      header: 'URL scans',
      align: 'right',
      width: '10rem',
      secondary: true,
      sortable: true,
      render: (row) => <QuotaCell used={row.url_scans_used} limit={row.url_scans_limit} />,
    },
    {
      key: 'storage',
      header: 'Storage (MB)',
      align: 'right',
      width: '10rem',
      secondary: true,
      sortable: true,
      render: (row) => <QuotaCell used={row.storage_used_mb} limit={row.storage_limit_mb} />,
    },
    {
      key: 'overage',
      // Real US dollars, not the normalised figure the rest of this section
      // carries: the server passes the stored amount through without converting.
      header: 'Overage (already US dollars)',
      align: 'right',
      width: '11rem',
      sortable: true,
      render: (row) =>
        row.overage_messages === 0 && row.overage_amount_cents === 0 ? (
          <span className="figure text-text-tertiary">None</span>
        ) : (
          <div>
            <p className="figure text-sm text-text-primary">{usdCents(row.overage_amount_cents)}</p>
            <p className="figure text-2xs text-text-tertiary">
              {formatNumber(row.overage_messages)} messages
            </p>
          </div>
        ),
    },
  ];

  const ledgerColumns: readonly Column<CreditLedgerRow>[] = [
    {
      key: 'created',
      header: 'When',
      pinned: true,
      width: '12rem',
      sortable: true,
      render: (row) => <span className="figure text-sm">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: 'client',
      header: 'Client',
      width: '7rem',
      render: (row) => <span className="figure text-sm">#{row.client_id}</span>,
    },
    {
      key: 'delta',
      header: 'Change',
      align: 'right',
      width: '8rem',
      sortable: true,
      render: (row) => (
        <span className={row.delta < 0 ? 'figure text-danger' : 'figure text-success'}>
          {row.delta > 0 ? '+' : ''}
          {formatNumber(row.delta)}
        </span>
      ),
    },
    {
      key: 'running',
      // NOT "balance": the server computes this by walking the returned window
      // forward from zero, so on any account with more than 500 ledger rows it
      // is not the balance and never was.
      header: 'Running total',
      align: 'right',
      width: '9rem',
      render: (row) => <span className="figure">{formatNumber(row.balance_after)}</span>,
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => <span className="text-sm text-text-secondary">{row.reason ?? '—'}</span>,
    },
    {
      key: 'grant',
      header: 'Grant',
      width: '8rem',
      secondary: true,
      render: (row) =>
        row.grant_id ? (
          <span className="figure text-sm">{truncateId(String(row.grant_id))}</span>
        ) : (
          <span className="text-text-tertiary">—</span>
        ),
    },
    {
      key: 'expires',
      header: 'Expires',
      width: '10rem',
      secondary: true,
      render: (row) =>
        row.expires_at ? (
          <span className="figure text-sm">{formatDate(row.expires_at)}</span>
        ) : (
          <span className="text-text-tertiary">Does not expire</span>
        ),
    },
  ];

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-48">
          <Combobox
            size="sm"
            label="Filter both lists by account"
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

      <Section
        title="Usage against plan limits"
        description="One row per billing period. Limits are the account's live plan limits, not the ones frozen when the period opened."
      >
        <RecordList
          caption="Usage records against plan limits, newest period first"
          columns={usageColumns}
          paged={usagePaged}
          rowKey={(row) => String(row.id)}
          rowNoun="period"
          what="usage records"
          loading={usage.loading}
          error={usage.error}
          forbidden={usage.forbidden}
          onRetry={usage.reload}
          loaded={usage.items.length}
          cap={SERVER_CAP}
          empty={
            <EmptyState
              title={clientId ? 'No usage for that client' : 'No usage recorded'}
              description={
                clientId
                  ? 'That account has never opened a billing period.'
                  : 'No billing period has been opened for any account yet.'
              }
            />
          }
        />
      </Section>

      <Section
        title="Credit ledger"
        description="Every grant and deduction, newest first. The running total is not the account balance: it walks this window forward from zero."
      >
        <RecordList
          caption="Credit ledger entries, newest first"
          columns={ledgerColumns}
          paged={ledgerPaged}
          rowKey={(row) => String(row.id)}
          rowNoun="entry"
          rowNounPlural="entries"
          what="credit movements"
          loading={ledger.loading}
          error={ledger.error}
          forbidden={ledger.forbidden}
          onRetry={ledger.reload}
          loaded={ledger.items.length}
          cap={SERVER_CAP}
          empty={
            <EmptyState
              title={clientId ? 'No credit movements for that client' : 'No credit movements yet'}
              description={
                clientId
                  ? 'That account has no grant, deduction or expiry on record.'
                  : 'No credits have been granted or spent on this platform yet.'
              }
            />
          }
        />
      </Section>
    </Stack>
  );
}

/**
 * `used / limit`, with the tone escalating as the allowance fills.
 *
 * The UNLIMITED sentinel is `-1` in the plan tables, and it is rendered as the
 * word, never as the number — a plan reading "412 / -1" is how a support call
 * starts.
 */
function QuotaCell({ used, limit }: { used: number; limit: number }) {
  const tone = usageTone(used, limit);
  const label = usageLabel(used, limit);
  if (tone === 'neutral') return <span className="figure text-sm">{label}</span>;
  return (
    <Badge tone={tone} dot>
      <span className="figure">{label}</span>
    </Badge>
  );
}
