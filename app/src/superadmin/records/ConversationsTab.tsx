import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  DefinitionList,
  EmptyState,
  Input,
  SearchField,
  SegmentedControl,
  Section,
  Select,
  Skeleton,
  Stack,
  Toolbar,
  buttonClass,
  formatDateTime,
  type Column,
} from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { PLATFORM_ROOT } from '../nav';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, includesText, usePagedRows } from '../recordList';
import { SESSION_STATUS_TONES, isFetchableSessionId, type SessionDetail, type SessionRow } from './types';

const VIEWS = [
  { value: 'all', label: 'All conversations' },
  { value: 'queue', label: 'Live queue' },
];

function statusBadge(status: string) {
  return <Badge tone={SESSION_STATUS_TONES[status] ?? 'neutral'}>{status}</Badge>;
}

/**
 * Links, not `onRowClick`.
 *
 * The row-activation control stretches a pseudo-element across the whole row,
 * which would sit on top of the account link in the fourth cell and swallow it.
 * Two real links keep both destinations reachable, by pointer and by keyboard.
 */
function sessionColumns(): Column<SessionRow>[] {
  return [
    {
      key: 'id',
      header: 'Conversation',
      pinned: true,
      sortable: true,
      render: (row) => (
        <Link
          className="font-mono text-xs font-medium text-accent-600 underline-offset-2 hover:underline"
          to={`${PLATFORM_ROOT}/records/sessions/${encodeURIComponent(row.id)}`}
        >
          {row.id}
        </Link>
      ),
    },
    { key: 'status', header: 'Status', sortable: true, render: (row) => statusBadge(row.status) },
    { key: 'bot_name', header: 'Chatbot', sortable: true, render: (row) => row.bot_name ?? '—' },
    {
      key: 'client_name',
      header: 'Account',
      sortable: true,
      render: (row) =>
        row.client_id ? (
          <Link
            className="text-accent-600 underline-offset-2 hover:underline"
            to={`${PLATFORM_ROOT}/customers/${row.client_id}`}
          >
            {row.client_name ?? `#${row.client_id}`}
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'rating',
      header: 'Rating',
      align: 'right',
      sortable: true,
      render: (row) => (row.rating == null ? '—' : `${row.rating}/5`),
    },
    {
      key: 'created_at',
      header: 'Started',
      sortable: true,
      secondary: true,
      render: (row) => <span className="text-text-secondary">{formatDateTime(row.created_at)}</span>,
    },
  ];
}

const SESSION_COMPARATORS = {
  id: byText((row: SessionRow) => row.id),
  status: byText((row: SessionRow) => row.status),
  bot_name: byText((row: SessionRow) => row.bot_name),
  client_name: byText((row: SessionRow) => row.client_name),
  rating: byNumber((row: SessionRow) => row.rating),
  created_at: byDate((row: SessionRow) => row.created_at),
};

const MISSING_FIELDS_NOTE =
  'Visitor name, visitor email and last activity are returned as null for every conversation: the handler reads three attributes that are not columns on the session (the real one is last_active_at). They are not shown here rather than shown as a column of dashes.';

export function ConversationsTab() {
  const url = useUrlState();
  const view = url.get('view', 'all');

  return (
    <Stack>
      <SegmentedControl
        label="Conversation view"
        value={view}
        onChange={(next) => url.set({ view: next, q: null, status: null, client_id: null })}
        items={VIEWS}
      />
      {view === 'queue' ? <LiveQueueList /> : <SessionsList />}
    </Stack>
  );
}

function SessionsList() {
  const url = useUrlState();
  const query = url.get('q');
  const status = url.get('status');
  const clientId = url.get('client_id');
  // `status` and `client_id` are real server-side filters, so they are sent
  // rather than applied here — which also means they narrow what the 500-row cap
  // truncates, instead of narrowing an already-truncated page.
  const list = usePlatformList<SessionRow>('/sessions', {
    params: { status, client_id: clientId },
  });

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.id, row.bot_name, row.client_name], query),
    comparators: SESSION_COMPARATORS,
  });

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search conversations"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Conversation id, chatbot or account"
          />
        </div>
        <div className="w-44">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => url.set({ status: event.target.value })}
            options={[
              { value: '', label: 'Any status' },
              { value: 'bot', label: 'Bot only' },
              { value: 'waiting', label: 'Waiting' },
              { value: 'live', label: 'Live' },
              { value: 'closed', label: 'Closed' },
            ]}
          />
        </div>
        <div className="w-40">
          <Input
            aria-label="Filter by account id"
            inputMode="numeric"
            value={clientId}
            onChange={(event) => url.set({ client_id: event.target.value.replace(/\D/g, '') })}
            placeholder="Account id"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Conversations across every chatbot"
        columns={sessionColumns()}
        paged={paged}
        rowKey={(row) => row.id}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note={`Status and account are filtered by the server; the search box filters the returned rows here. ${MISSING_FIELDS_NOTE}`}
        empty={
          <EmptyState
            compact
            title={query || status || clientId ? 'Nothing matched' : 'No conversations'}
            description={
              query || status || clientId
                ? 'No conversation matches this filter. Clear it to see the newest 500.'
                : 'No visitor has opened a chat on any embedded widget.'
            }
          />
        }
      />
    </div>
  );
}

function LiveQueueList() {
  const url = useUrlState();
  const query = url.get('q');
  const list = usePlatformList<SessionRow>('/live/queue');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.id, row.bot_name, row.client_name], query),
    comparators: SESSION_COMPARATORS,
  });

  const waiting = list.items.filter((row) => row.status === 'waiting').length;

  return (
    <div className="flex flex-col gap-4">
      {waiting > 0 ? (
        <Alert tone="warning" title={`${waiting} visitor${waiting === 1 ? ' is' : 's are'} waiting`}>
          These conversations have asked for a person and have not been picked up. The endpoint
          returns no wait time, so how long they have been waiting is not readable from here — the
          start time below is the closest the API offers.
        </Alert>
      ) : null}
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search the live queue"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Conversation id, chatbot or account"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Conversations waiting for, or with, a person"
        columns={sessionColumns()}
        paged={paged}
        rowKey={(row) => row.id}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={100}
        note={`Waiting and live conversations only, newest first, capped at 100 with no filter of any kind. ${MISSING_FIELDS_NOTE}`}
        empty={
          <EmptyState
            compact
            title={query ? 'Nothing matched' : 'Nobody is waiting'}
            description={
              query
                ? 'No queued conversation matches this search.'
                : 'No visitor on any workspace is waiting for a person or talking to one right now.'
            }
          />
        }
      />
    </div>
  );
}

const ROLE_TONE: Record<string, 'neutral' | 'success' | 'plan'> = {
  user: 'neutral',
  bot: 'success',
  operator: 'plan',
  system: 'neutral',
};

/** One conversation and its transcript. */
export function SessionDetailPage() {
  const { sessionId = '' } = useParams();
  const fetchable = isFetchableSessionId(sessionId);
  const record = usePlatformResource<SessionDetail>(
    fetchable ? `/sessions/${encodeURIComponent(sessionId)}` : null,
  );
  const detail = record.data;

  return (
    <PlatformPage
      eyebrow="Conversation"
      title={sessionId || 'Conversation'}
      description={detail ? `${detail.messages.length} messages.` : undefined}
      forbidden={record.forbidden}
      error={record.error && !detail ? record.error : null}
      onRetry={record.reload}
      actions={
        <Link to={`${PLATFORM_ROOT}/records?tab=conversations`} className={buttonClass('ghost', 'sm')}>
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          All conversations
        </Link>
      }
    >
      {!fetchable ? (
        <Alert tone="danger" title="The API cannot return this conversation">
          Conversation ids are UUID strings, but the detail endpoint declares its path parameter as an
          integer, so it rejects this id with a 422 before its handler runs. Nothing was requested.
          The conversation itself is intact — only this endpoint cannot address it, and the fix is a
          one-word change on the server.
        </Alert>
      ) : record.loading && !detail ? (
        <Stack>
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </Stack>
      ) : !detail ? (
        <EmptyState
          title="No such conversation"
          description="The id in the address does not match a conversation. It may have been deleted with its chatbot."
        />
      ) : (
        <Stack>
          <Section title="Conversation">
            <Card>
              <CardBody>
                <DefinitionList
                  columns={2}
                  items={[
                    { label: 'Status', value: statusBadge(detail.session.status) },
                    { label: 'Chatbot', value: detail.session.bot_name ?? '—' },
                    {
                      label: 'Account',
                      value: detail.session.client_id ? (
                        <Link
                          className="text-accent-600 underline-offset-2 hover:underline"
                          to={`${PLATFORM_ROOT}/customers/${detail.session.client_id}`}
                        >
                          {detail.session.client_name ?? `#${detail.session.client_id}`}
                        </Link>
                      ) : null,
                    },
                    {
                      label: 'Started',
                      value: <span className="figure">{formatDateTime(detail.session.created_at)}</span>,
                    },
                    {
                      label: 'Visitor rating',
                      value: detail.session.rating == null ? null : `${detail.session.rating} / 5`,
                    },
                  ]}
                />
              </CardBody>
            </Card>
          </Section>

          <Section title="Transcript" description="Oldest first, as the visitor read it.">
            <Card>
              {detail.messages.length === 0 ? (
                <EmptyState
                  compact
                  title="No messages"
                  description="The conversation was opened but nothing was ever said in it."
                />
              ) : (
                <CardBody>
                  <ol className="flex flex-col gap-3">
                    {detail.messages.map((message) => (
                      <li key={message.id} className="rounded-md border border-border px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={ROLE_TONE[message.role] ?? 'neutral'}>{message.role}</Badge>
                          <span className="figure text-2xs text-text-tertiary">
                            {formatDateTime(message.created_at)}
                          </span>
                          {message.trace_id ? (
                            <span className="font-mono text-2xs text-text-tertiary">
                              trace {message.trace_id}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-prose text-text-primary">
                          {message.content}
                        </p>
                      </li>
                    ))}
                  </ol>
                </CardBody>
              )}
            </Card>
          </Section>
        </Stack>
      )}
    </PlatformPage>
  );
}
