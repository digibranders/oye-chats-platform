import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  Card,
  CardBody,
  DefinitionList,
  EmptyState,
  SearchField,
  Section,
  Select,
  Skeleton,
  Stack,
  StatTile,
  Toolbar,
  buttonClass,
  formatDate,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { PLATFORM_ROOT } from '../nav';
import { RecordList } from '../RecordList';
import { byDate, byText, includesText, usePagedRows } from '../recordListState';
import type { BotDetail, BotRow } from './types';

/** Every chatbot on the platform, whoever owns it. */
export function ChatbotsTab() {
  const url = useUrlState();
  const query = url.get('q');
  const state = url.get('state');
  const list = usePlatformList<BotRow>('/bots');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) =>
      (!state || (state === 'active') === row.is_active) &&
      includesText([row.name, row.bot_key, row.client_name], query),
    comparators: {
      name: byText((row) => row.name),
      bot_key: byText((row) => row.bot_key),
      client_name: byText((row) => row.client_name),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<BotRow>[] = [
    {
      key: 'name',
      header: 'Chatbot',
      pinned: true,
      sortable: true,
      // A real link rather than `onRowClick`: this table also carries a link to
      // the owning account, and the row-activation overlay would sit on top of it.
      render: (row) => (
        <Link
          className="font-medium text-accent-600 underline-offset-2 hover:underline"
          to={`${PLATFORM_ROOT}/records/bots/${row.id}`}
        >
          {row.name || 'Untitled chatbot'}
        </Link>
      ),
    },
    {
      key: 'bot_key',
      header: 'Bot key',
      sortable: true,
      render: (row) => <span className="font-mono text-xs text-text-secondary">{row.bot_key}</span>,
    },
    {
      key: 'client_name',
      header: 'Account',
      sortable: true,
      render: (row) => (
        <Link
          className="text-accent-600 underline-offset-2 hover:underline"
          to={`${PLATFORM_ROOT}/customers/${row.client_id}`}
        >
          {row.client_name ?? `#${row.client_id}`}
        </Link>
      ),
    },
    {
      key: 'is_active',
      header: 'State',
      render: (row) =>
        row.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Disabled</Badge>,
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      secondary: true,
      render: (row) => formatDate(row.created_at),
    },
  ];

  return (
    <Stack>
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search chatbots"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Name, bot key or account"
          />
        </div>
        <div className="w-44">
          <Select
            aria-label="Filter by state"
            value={state}
            onChange={(event) => url.set({ state: event.target.value })}
            options={[
              { value: '', label: 'Any state' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Every chatbot on the platform"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        note="This endpoint returns every chatbot and accepts no parameters, so the search and the state filter are applied in this console."
        empty={
          <EmptyState
            compact
            title={query || state ? 'Nothing matched' : 'No chatbots'}
            description={
              query || state
                ? 'No chatbot matches this filter. Clear it to see them all.'
                : 'No account has created a chatbot yet.'
            }
          />
        }
      />
    </Stack>
  );
}

/**
 * One chatbot.
 *
 * A route rather than a drawer: "which bot is generating all this traffic" is a
 * question one super-admin asks another, and the answer has to be a link.
 */
export function BotDetailPage() {
  const { botId } = useParams();
  const numericId = Number(botId);
  const valid = Number.isInteger(numericId) && numericId > 0;
  const record = usePlatformResource<BotDetail>(valid ? `/bots/${numericId}` : null);
  const bot = record.data;

  return (
    <PlatformPage
      eyebrow="Chatbot"
      title={bot?.name || (record.loading ? 'Loading chatbot' : 'Chatbot')}
      description={bot ? `Owned by ${bot.client_name ?? `account #${bot.client_id}`}.` : undefined}
      forbidden={record.forbidden}
      error={!valid ? 'That is not a valid chatbot id.' : record.error && !bot ? record.error : null}
      onRetry={record.reload}
      actions={
        <Link to={`${PLATFORM_ROOT}/records?tab=chatbots`} className={buttonClass('ghost', 'sm')}>
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          All chatbots
        </Link>
      }
    >
      {record.loading && !bot ? (
        <Stack>
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </Stack>
      ) : !bot ? (
        <EmptyState
          title="No such chatbot"
          description="The id in the address does not match a chatbot on this platform. It may have been deleted with its account."
        />
      ) : (
        <Stack>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Conversations"
              value={formatNumber(bot.total_sessions)}
              period="All time"
            />
            <StatTile label="Messages" value={formatNumber(bot.total_messages)} period="All time" />
            <StatTile
              label="State"
              value={bot.is_active ? 'Active' : 'Disabled'}
              period="Right now"
              tone={bot.is_active ? 'neutral' : 'warning'}
            />
          </div>

          <Section title="Identity">
            <Card>
              <CardBody>
                <DefinitionList
                  columns={2}
                  items={[
                    { label: 'Chatbot id', value: <span className="figure">{bot.id}</span> },
                    {
                      label: 'Bot key',
                      value: <span className="font-mono text-xs">{bot.bot_key}</span>,
                    },
                    {
                      label: 'Account',
                      value: (
                        <Link
                          className="text-accent-600 underline-offset-2 hover:underline"
                          to={`${PLATFORM_ROOT}/customers/${bot.client_id}`}
                        >
                          {bot.client_name ?? `#${bot.client_id}`}
                        </Link>
                      ),
                    },
                    {
                      label: 'Created',
                      value: <span className="figure">{formatDateTime(bot.created_at)}</span>,
                    },
                  ]}
                />
              </CardBody>
            </Card>
          </Section>

          <Section
            title="Its records"
            description="This endpoint returns counts only. The lists themselves live in the tabs below, filtered where the API allows it."
          >
            <div className="flex flex-wrap gap-2">
              <Link
                to={`${PLATFORM_ROOT}/records?tab=engagement&view=offline&bot_id=${bot.id}`}
                className={buttonClass('secondary', 'sm')}
              >
                Offline messages
              </Link>
              <Link
                to={`${PLATFORM_ROOT}/records?tab=engagement&view=meetings&bot_id=${bot.id}`}
                className={buttonClass('secondary', 'sm')}
              >
                Meetings
              </Link>
              <Link
                to={`${PLATFORM_ROOT}/records?tab=audience&view=growth&bot_id=${bot.id}`}
                className={buttonClass('secondary', 'sm')}
              >
                Growth events
              </Link>
              <Link
                to={`${PLATFORM_ROOT}/records?tab=conversations&client_id=${bot.client_id}`}
                className={buttonClass('secondary', 'sm')}
              >
                Conversations for this account
              </Link>
            </div>
            <p className="mt-2 text-xs text-text-tertiary">
              Conversations, documents and crawls cannot be filtered by chatbot: those endpoints
              accept no <code className="font-mono text-xs">bot_id</code> parameter. The account
              filter above is the narrowest the API offers.
            </p>
          </Section>
        </Stack>
      )}
    </PlatformPage>
  );
}
