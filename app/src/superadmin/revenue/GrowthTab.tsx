import { useMemo } from 'react';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  LockedState,
  RankedBars,
  Section,
  SegmentedControl,
  Skeleton,
  Stack,
  Toolbar,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import { bpsLabel } from './money';
import type { BotGrowthEventRow, FunnelStage, ReferralConversionRow } from './types';

/**
 * Where customers come from: the product funnel, the affiliates who referred
 * them, and the demo links agents share.
 *
 * The conversion funnel's percentages are all against **stage one**, not against
 * the previous stage — that is how the server computes `pct`, and presenting
 * them as step-to-step conversion would overstate every drop after the first.
 */

/** Both event lists `.limit(500)`. */
const SERVER_CAP = 500;

/** `conversion_funnel` bounds `days` at 365. */
const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

export function GrowthTab() {
  const url = useUrlState();
  const days = RANGES.some((range) => range.value === url.get('days')) ? url.get('days') : '30';
  const affiliateId = url.get('affiliate');
  const botId = url.get('bot');

  const funnel = usePlatformList<FunnelStage>('/funnel', { key: 'stages', params: { days } });
  const referrals = usePlatformList<ReferralConversionRow>('/referral-conversions', {
    params: affiliateId ? { affiliate_id: affiliateId } : undefined,
  });
  const growth = usePlatformList<BotGrowthEventRow>('/bot-growth-events', {
    params: botId ? { bot_id: botId } : undefined,
  });

  const baseline = funnel.items[0]?.value ?? 0;
  const bars = useMemo(
    () =>
      funnel.items.map((stage) => ({
        id: stage.label,
        label: stage.label,
        value: stage.value,
        display: formatNumber(stage.value),
        meta: `${stage.pct}% of ${funnel.items[0]?.label.toLowerCase() ?? 'the first stage'}`,
      })),
    [funnel.items],
  );

  const referralColumns: readonly Column<ReferralConversionRow>[] = [
    {
      key: 'created',
      header: 'Converted',
      pinned: true,
      width: '12rem',
      sortable: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      render: (row) => <span className="figure text-sm">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: 'client',
      header: 'Customer',
      width: '14rem',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-text-primary">
            {row.client_name ?? `client #${row.client_id}`}
          </p>
          <p className="figure truncate text-2xs text-text-tertiary">client #{row.client_id}</p>
        </div>
      ),
    },
    {
      key: 'affiliate',
      header: 'Affiliate',
      width: '14rem',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-text-primary">{row.affiliate_name ?? '—'}</p>
          <p className="figure truncate text-2xs text-text-tertiary">
            {row.referral_code ?? 'no code recorded'}
          </p>
        </div>
      ),
    },
    {
      key: 'commission',
      header: 'Commission',
      align: 'right',
      width: '9rem',
      sortable: (a, b) => a.commission_bps - b.commission_bps,
      // Snapshotted at conversion time: the affiliate's terms today may differ,
      // and this is what was agreed then.
      render: (row) => <span className="figure">{bpsLabel(row.commission_bps)}</span>,
    },
    {
      key: 'discount',
      header: 'Customer discount',
      align: 'right',
      width: '11rem',
      secondary: true,
      sortable: (a, b) => a.customer_discount_bps - b.customer_discount_bps,
      render: (row) => <span className="figure">{bpsLabel(row.customer_discount_bps)}</span>,
    },
  ];

  const growthColumns: readonly Column<BotGrowthEventRow>[] = [
    {
      key: 'created',
      header: 'When',
      pinned: true,
      width: '12rem',
      sortable: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      render: (row) => <span className="figure text-sm">{formatDateTime(row.created_at)}</span>,
    },
    {
      key: 'event',
      header: 'Event',
      width: '14rem',
      render: (row) => <span className="text-sm text-text-primary">{row.event_type.replace(/_/g, ' ')}</span>,
    },
    {
      key: 'bot',
      header: 'Agent',
      render: (row) => (
        <span className="text-sm text-text-secondary">
          {row.bot_name ?? `agent #${row.bot_id}`}
        </span>
      ),
    },
  ];

  return (
    <Stack>
      <Section
        title="Visitor to customer"
        description="Each stage as a share of the first, over the trailing window. Rows are counted from the session's own created date, so a long-running conversation stays in the window it started in."
        actions={
          <SegmentedControl
            size="sm"
            label="Range"
            value={days}
            onChange={(next) => url.set({ days: next })}
            items={RANGES}
          />
        }
      >
        {funnel.forbidden ? (
          <LockedState
            title="You cannot read the funnel"
            description="Your super-admin account is not permitted to read conversion data. Nothing was loaded."
          />
        ) : (
          <Card>
            {funnel.loading && funnel.items.length === 0 ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : funnel.error ? (
              <div className="p-4">
                <Alert
                  tone="danger"
                  live
                  title="The funnel could not be loaded"
                  action={
                    <Button size="sm" variant="secondary" onClick={funnel.reload}>
                      Try again
                    </Button>
                  }
                >
                  {funnel.error}
                </Alert>
              </div>
            ) : baseline === 0 ? (
              <EmptyState
                compact
                title="No sessions in this window"
                description="Every stage is measured as a share of sessions, and there were none — so the funnel has no denominator rather than being all zeroes. Widen the range."
              />
            ) : (
              <RankedBars label="Visitor to paying customer funnel" items={bars} max={baseline} tone="ink" />
            )}
          </Card>
        )}
      </Section>

      <Section
        title="Referral conversions"
        description="Commission and discount terms as they stood at the moment each referral converted. Later changes to an affiliate's terms do not rewrite these."
      >
        <Toolbar className="mb-3">
          <Input
            size="sm"
            type="number"
            min={1}
            inputMode="numeric"
            aria-label="Filter referral conversions by affiliate id"
            placeholder="Affiliate id"
            className="w-36"
            value={affiliateId}
            onChange={(event) => url.set({ affiliate: event.target.value })}
          />
          {affiliateId ? (
            <Button size="sm" variant="ghost" onClick={() => url.set({ affiliate: null })}>
              Show every affiliate
            </Button>
          ) : null}
        </Toolbar>
        {referrals.items.length >= SERVER_CAP ? (
          <Alert tone="warning" className="mb-3" title="Truncated at 500 conversions">
            The endpoint returns at most {SERVER_CAP} rows and does not paginate. Filter by affiliate
            id to read one affiliate's history in full.
          </Alert>
        ) : null}
        {referrals.forbidden ? (
          <LockedState
            title="You cannot read referral conversions"
            description="Your super-admin account is not permitted to read affiliate conversions. Nothing was loaded."
          />
        ) : (
          <DataTable
            caption="Referral conversions, newest first"
            columns={referralColumns}
            rows={referrals.items}
            rowKey={(row) => String(row.id)}
            loading={referrals.loading}
            error={referrals.error}
            onRetry={referrals.reload}
            pageSize={25}
            empty={
              <EmptyState
                title={affiliateId ? 'No conversions for that affiliate' : 'No referral conversions yet'}
                description={
                  affiliateId
                    ? 'That affiliate id has never had a referral convert.'
                    : 'No account has signed up through a referral code. Affiliate codes exist independently of this — a code with no conversions still shows nothing here.'
                }
              />
            }
          />
        )}
      </Section>

      <Section
        title="Agent growth events"
        description="Demo-link distribution telemetry, one row per event. Newest first."
      >
        <Toolbar className="mb-3">
          <Input
            size="sm"
            type="number"
            min={1}
            inputMode="numeric"
            aria-label="Filter growth events by agent id"
            placeholder="Agent id"
            className="w-36"
            value={botId}
            onChange={(event) => url.set({ bot: event.target.value })}
          />
          {botId ? (
            <Button size="sm" variant="ghost" onClick={() => url.set({ bot: null })}>
              Show every agent
            </Button>
          ) : null}
        </Toolbar>
        {growth.items.length >= SERVER_CAP ? (
          <Alert tone="warning" className="mb-3" title="Truncated at 500 events">
            The endpoint returns at most {SERVER_CAP} rows and does not paginate. Filter by agent id
            to read one agent's events in full.
          </Alert>
        ) : null}
        {growth.forbidden ? (
          <LockedState
            title="You cannot read growth events"
            description="Your super-admin account is not permitted to read agent growth telemetry. Nothing was loaded."
          />
        ) : (
          <DataTable
            caption="Agent growth events, newest first"
            columns={growthColumns}
            rows={growth.items}
            rowKey={(row) => String(row.id)}
            loading={growth.loading}
            error={growth.error}
            onRetry={growth.reload}
            pageSize={25}
            empty={
              <EmptyState
                title={botId ? 'No events for that agent' : 'No growth events recorded'}
                description={
                  botId
                    ? 'That agent id has no demo-link events on record.'
                    : 'No agent has recorded a demo-link event. The telemetry is written when a demo link is shared or opened.'
                }
              />
            }
          />
        )}
      </Section>
    </Stack>
  );
}
