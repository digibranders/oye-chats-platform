import { useMemo } from 'react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  Combobox,
  EmptyState,
  LoadingBars,
  LockedState,
  RankedBars,
  Section,
  SegmentedControl,
  Stack,
  Toolbar,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import { RecordList } from '../RecordList';
import { byDate, byNumber, usePagedRows } from '../recordListState';
import { bpsLabel } from '../money';
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

/**
 * The distinct `{id, name}` pairs in a list, as combobox options.
 *
 * The applied value is kept even when nothing in the current response carries
 * it, so a filtered list still shows what it is filtered by.
 */
function distinctOptions(
  rows: readonly { id: number | null; name: string | null }[],
  applied: string,
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (row.id == null) continue;
    seen.set(String(row.id), row.name ?? `#${row.id}`);
  }
  if (applied && !seen.has(applied)) seen.set(applied, `#${applied}`);
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

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

  const referralsPaged = usePagedRows(referrals.items, {
    url,
    pageKey: 'rpage',
    sortKey: 'rsort',
    comparators: {
      created: byDate((row) => row.created_at),
      commission: byNumber((row) => row.commission_bps),
      discount: byNumber((row) => row.customer_discount_bps),
    },
  });

  const growthPaged = usePagedRows(growth.items, {
    url,
    pageKey: 'gpage',
    sortKey: 'gsort',
    comparators: { created: byDate((row) => row.created_at) },
  });

  // Both filters are exact-match server filters on an integer id, and nobody
  // knows one. The options are read out of the rows that came back, plus
  // whatever is already applied, which is the only source the API offers.
  const affiliateOptions = distinctOptions(
    referrals.items.map((row) => ({ id: row.affiliate_id, name: row.affiliate_name })),
    affiliateId,
  );
  const botOptions = distinctOptions(
    growth.items.map((row) => ({ id: row.bot_id, name: row.bot_name })),
    botId,
  );

  const baseline = funnel.items[0]?.value ?? 0;
  const bars = useMemo(
    () =>
      funnel.items.map((stage) => ({
        id: stage.label,
        label: stage.label,
        value: stage.value,
        display: formatNumber(stage.value),
        // The base is named on every row, and stays that way. It reads as six
        // repeats of one phrase, and it was on the list of things to compress —
        // but a bare "7%" beside "Subscribed" reads as step-to-step conversion,
        // which overstates every drop after the first. `GrowthTab.test` pins
        // this for that reason.
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
      sortable: true,
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
      sortable: true,
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
      sortable: true,
      render: (row) => <span className="figure">{bpsLabel(row.customer_discount_bps)}</span>,
    },
  ];

  const growthColumns: readonly Column<BotGrowthEventRow>[] = [
    {
      key: 'created',
      header: 'When',
      pinned: true,
      width: '12rem',
      sortable: true,
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
      header: 'Chatbot',
      render: (row) => (
        <span className="text-sm text-text-secondary">
          {row.bot_name ?? `chatbot #${row.bot_id}`}
        </span>
      ),
    },
  ];

  return (
    <Stack>
      <Section
        title="Visitor to customer"
        description="Each stage as a share of the first, counted from the session's own created date."
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
            size="panel"
            title={FORBIDDEN_TITLE}
            description={forbiddenDescription('conversion data')}
          />
        ) : (
          <Card>
            {funnel.loading && funnel.items.length === 0 ? (
              <CardBody>
                <LoadingBars rows={4} />
              </CardBody>
            ) : funnel.error ? (
              <CardBody>
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
              </CardBody>
            ) : baseline === 0 ? (
              <EmptyState
                compact
                title="No sessions in this window"
                description="Every stage is a share of sessions and there were none, so the funnel has no denominator. Widen the range."
              />
            ) : (
              <CardBody>
                <RankedBars label="Visitor to paying customer funnel" items={bars} max={baseline} />
              </CardBody>
            )}
          </Card>
        )}
      </Section>

      <Section
        title="Referral conversions"
        description="Terms as they stood when each referral converted. Later changes do not rewrite these."
      >
        <Toolbar sticky className="mb-3">
          <div className="w-48">
            <Combobox
              size="sm"
              label="Filter referral conversions by affiliate"
              value={affiliateId || null}
              onValueChange={(next) => url.set({ affiliate: next })}
              options={affiliateOptions}
              placeholder="Every affiliate"
              clearable
            />
          </div>
          {affiliateId ? (
            <Button size="sm" variant="ghost" onClick={() => url.set({ affiliate: null })}>
              Show every affiliate
            </Button>
          ) : null}
        </Toolbar>
        <RecordList
          caption="Referral conversions, newest first"
          columns={referralColumns}
          paged={referralsPaged}
          rowKey={(row) => String(row.id)}
          rowNoun="conversion"
          what="affiliate conversions"
          loading={referrals.loading}
          error={referrals.error}
          forbidden={referrals.forbidden}
          onRetry={referrals.reload}
          loaded={referrals.items.length}
          cap={SERVER_CAP}
          empty={
            <EmptyState
              title={affiliateId ? 'No conversions for that affiliate' : 'No referral conversions yet'}
              description={
                affiliateId
                  ? 'That affiliate has never had a referral convert.'
                  : 'No account has signed up through a referral code.'
              }
            />
          }
        />
      </Section>

      <Section
        title="Chatbot growth events"
        description="Demo-link distribution telemetry, newest first."
      >
        <Toolbar sticky className="mb-3">
          <div className="w-48">
            <Combobox
              size="sm"
              label="Filter growth events by chatbot"
              value={botId || null}
              onValueChange={(next) => url.set({ bot: next })}
              options={botOptions}
              placeholder="Every chatbot"
              clearable
            />
          </div>
          {botId ? (
            <Button size="sm" variant="ghost" onClick={() => url.set({ bot: null })}>
              Show every chatbot
            </Button>
          ) : null}
        </Toolbar>
        <RecordList
          caption="Chatbot growth events, newest first"
          columns={growthColumns}
          paged={growthPaged}
          rowKey={(row) => String(row.id)}
          rowNoun="event"
          what="chatbot growth telemetry"
          loading={growth.loading}
          error={growth.error}
          forbidden={growth.forbidden}
          onRetry={growth.reload}
          loaded={growth.items.length}
          cap={SERVER_CAP}
          empty={
            <EmptyState
              title={botId ? 'No events for that chatbot' : 'No growth events recorded'}
              description={
                botId
                  ? 'That chatbot has no demo-link events on record.'
                  : 'The telemetry is written when a demo link is shared or opened.'
              }
            />
          }
        />
      </Section>
    </Stack>
  );
}
