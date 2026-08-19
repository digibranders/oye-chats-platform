import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Input,
  LockedState,
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
import { USD_NORMALISED_SHORT, usageLabel, usageTone, usdCents } from './money';
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
      sortable: (a, b) => (a.period_start ?? '').localeCompare(b.period_start ?? ''),
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
      sortable: (a, b) => a.ai_messages_used - b.ai_messages_used,
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
      sortable: (a, b) => a.live_chat_messages_used - b.live_chat_messages_used,
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
      sortable: (a, b) => a.url_scans_used - b.url_scans_used,
      render: (row) => <QuotaCell used={row.url_scans_used} limit={row.url_scans_limit} />,
    },
    {
      key: 'storage',
      header: 'Storage (MB)',
      align: 'right',
      width: '10rem',
      secondary: true,
      sortable: (a, b) => a.storage_used_mb - b.storage_used_mb,
      render: (row) => <QuotaCell used={row.storage_used_mb} limit={row.storage_limit_mb} />,
    },
    {
      key: 'overage',
      header: 'Overage',
      align: 'right',
      width: '11rem',
      sortable: (a, b) => a.overage_amount_cents - b.overage_amount_cents,
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
      sortable: (a, b) => a.created_at.localeCompare(b.created_at),
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
      sortable: (a, b) => a.delta - b.delta,
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
      <Toolbar>
        <Input
          size="sm"
          type="number"
          min={1}
          inputMode="numeric"
          aria-label="Filter both lists by client id"
          placeholder="Client id"
          className="w-36"
          value={clientId}
          onChange={(event) => url.set({ client: event.target.value })}
        />
        {clientId ? (
          <Button size="sm" variant="ghost" onClick={() => url.set({ client: null })}>
            Show every customer
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-text-tertiary">
          Client id is the only filter either endpoint accepts.
        </span>
      </Toolbar>

      <Section
        title="Usage against plan limits"
        description="One row per billing period, newest first. Limits are the customer's live plan limits, not the ones frozen on the record when the period opened."
      >
        {usage.items.length >= SERVER_CAP ? (
          <Alert tone="warning" className="mb-3" title="Truncated at 500 periods">
            The endpoint returns at most {SERVER_CAP} usage records and does not paginate. Filter by
            client id to see a specific account's full history.
          </Alert>
        ) : null}
        {usage.forbidden ? (
          <LockedState
            title="You cannot read usage"
            description="Your super-admin account is not permitted to read usage records. Nothing was loaded."
          />
        ) : (
          <DataTable
            caption="Usage records against plan limits, newest period first"
            columns={usageColumns}
            rows={usage.items}
            rowKey={(row) => String(row.id)}
            loading={usage.loading}
            error={usage.error}
            onRetry={usage.reload}
            pageSize={25}
            empty={
              <EmptyState
                title={clientId ? 'No usage for that client' : 'No usage recorded'}
                description={
                  clientId
                    ? 'That client id has no usage period on record. Either the id is wrong or the account has never opened a billing period.'
                    : 'No billing period has been opened for any account yet. Usage records are created when a subscription starts its first period.'
                }
              />
            }
          />
        )}
        <p className="mt-2 text-xs text-text-tertiary">
          Overage is stated in {USD_NORMALISED_SHORT.toLowerCase()} — the server passes it through
          without conversion, so it is already US dollars.
        </p>
      </Section>

      <Section
        title="Credit ledger"
        description="Every grant and deduction, newest first. Append-only: nothing here is ever edited, only added to."
      >
        {ledger.items.length >= SERVER_CAP ? (
          <Alert tone="warning" className="mb-3" title="Truncated at 500 entries">
            The endpoint returns at most {SERVER_CAP} ledger rows and does not paginate. Filter by
            client id to read one account's history in full.
          </Alert>
        ) : null}
        <Alert tone="neutral" className="mb-3" title="“Running total” is not the account balance">
          The server computes it by walking this window of history forward from zero, so it only
          equals the real balance when every entry the account has ever had fits in the {SERVER_CAP}{' '}
          rows returned. Read it as a movement trail, not as a balance.
        </Alert>
        {ledger.forbidden ? (
          <LockedState
            title="You cannot read the credit ledger"
            description="Your super-admin account is not permitted to read credit movements. Nothing was loaded."
          />
        ) : (
          <DataTable
            caption="Credit ledger entries, newest first"
            columns={ledgerColumns}
            rows={ledger.items}
            rowKey={(row) => String(row.id)}
            loading={ledger.loading}
            error={ledger.error}
            onRetry={ledger.reload}
            pageSize={25}
            empty={
              <EmptyState
                title={clientId ? 'No credit movements for that client' : 'No credit movements yet'}
                description={
                  clientId
                    ? 'That client id has no grant, deduction or expiry on record.'
                    : 'No credits have been granted or spent on this platform yet.'
                }
              />
            }
          />
        )}
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
