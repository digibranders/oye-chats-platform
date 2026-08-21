import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CopyField,
  PropertyGrid,
  EmptyState,
  Input,
  SearchField,
  Section,
  Select,
  Skeleton,
  Stack,
  Toolbar,
  buttonClass,
  cn,
  formatDateTime,
  type Column,
} from '../../ui';
import { PlatformPage } from '../PlatformPage';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { PLATFORM_ROOT } from '../nav';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, includesText, usePagedRows } from '../recordListState';
import { SESSION_STATUS_TONES, isFetchableSessionId, type SessionDetail, type SessionRow } from './types';

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
      key: 'visitor',
      header: 'Visitor',
      sortable: true,
      render: (row) =>
        row.visitor_name || row.visitor_email ? (
          <div className="min-w-0">
            <p className="truncate font-medium text-text-primary">{row.visitor_name ?? '—'}</p>
            {row.visitor_email ? (
              <p className="truncate text-xs text-text-secondary">{row.visitor_email}</p>
            ) : null}
          </div>
        ) : (
          // Most conversations are anonymous, and that is the normal case
          // rather than missing data: a visitor only gets a name here once
          // they hand one over in the chat.
          <span className="text-text-tertiary">Anonymous</span>
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
    {
      key: 'last_activity_at',
      header: 'Last active',
      sortable: true,
      secondary: true,
      render: (row) => (
        <span className="text-text-secondary">{formatDateTime(row.last_activity_at)}</span>
      ),
    },
  ];
}

const SESSION_COMPARATORS = {
  id: byText((row: SessionRow) => row.id),
  status: byText((row: SessionRow) => row.status),
  bot_name: byText((row: SessionRow) => row.bot_name),
  client_name: byText((row: SessionRow) => row.client_name),
  visitor: byText((row: SessionRow) => row.visitor_name ?? row.visitor_email),
  rating: byNumber((row: SessionRow) => row.rating),
  created_at: byDate((row: SessionRow) => row.created_at),
  last_activity_at: byDate((row: SessionRow) => row.last_activity_at),
};

export function ConversationsTab() {
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
    filter: (row) =>
      includesText([row.id, row.bot_name, row.client_name, row.visitor_name, row.visitor_email], query),
    comparators: SESSION_COMPARATORS,
  });

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search conversations"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Conversation id, chatbot, account or visitor"
          />
        </div>
        <div className="w-48">
          <Select
            label="Filter by status"
            value={status}
            onValueChange={(value) => url.set({ status: value })}
            options={[
              { value: '', label: 'Any status' },
              { value: 'bot', label: 'Bot only' },
              { value: 'waiting', label: 'Waiting' },
              { value: 'live', label: 'Live' },
              { value: 'closed', label: 'Closed' },
            ]}
          />
        </div>
        <div className="w-48">
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
        rowNoun="conversation"
        what="conversations"
        columns={sessionColumns()}
        paged={paged}
        rowKey={(row) => row.id}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="The search box filters the rows already loaded, across id, chatbot, account and visitor."
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
    </Stack>
  );
}

export function LiveQueueTab() {
  const url = useUrlState();
  const query = url.get('q');
  const list = usePlatformList<SessionRow>('/live/queue');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) =>
      includesText([row.id, row.bot_name, row.client_name, row.visitor_name, row.visitor_email], query),
    comparators: SESSION_COMPARATORS,
  });

  const waiting = list.items.filter((row) => row.status === 'waiting').length;

  return (
    <Stack>
      {waiting > 0 ? (
        <Alert tone="warning" title={`${waiting} visitor${waiting === 1 ? ' is' : 's are'} waiting`}>
          These conversations have asked for a person and have not been picked up. The endpoint
          returns no wait time, so how long they have been waiting is not readable from here — the
          start time below is the closest the API offers.
        </Alert>
      ) : null}
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search the live queue"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Conversation id, chatbot, account or visitor"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Conversations waiting for, or with, a person"
        rowNoun="conversation"
        what="the live queue"
        columns={sessionColumns()}
        paged={paged}
        rowKey={(row) => row.id}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={100}
        note="Waiting and live conversations only, newest first, capped at 100 with no filter of any kind."
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
    </Stack>
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
  // A payload without a `session` is not a conversation, however the request
  // resolved. The handler 404s a missing id rather than serving a null session,
  // so this only fires on a shape the API should never send — but rendering a
  // page off `detail.session.status` without the check turns that into a blank
  // screen from an uncaught TypeError, which is a worse way to learn about it.
  const detail =
    record.data?.session && Array.isArray(record.data.messages) ? record.data : null;

  return (
    <PlatformPage
      eyebrow="Conversation"
      // The visitor, not the id. A 36-character opaque identifier set as a
      // proportional headline is unreadable and unscannable; the id itself is a
      // `CopyField` in the header, where it is mono and can be copied.
      // "Anonymous visitor", not "Conversation": the eyebrow above already says
      // Conversation, and the fallback made the word appear three times in the
      // top 200px — eyebrow, title, and the first section's heading.
      title={
        detail?.session.visitor_name ?? detail?.session.visitor_email ?? 'Anonymous visitor'
      }
      description={detail ? `${detail.messages.length} messages.` : undefined}
      forbidden={record.forbidden}
      error={record.error && !detail ? record.error : null}
      onRetry={record.reload}
      actions={
        <>
          {sessionId ? <CopyField compact label="Conversation id" value={sessionId} /> : null}
          <Link to={`${PLATFORM_ROOT}/records/conversations`} className={buttonClass('ghost', 'sm')}>
            <ArrowLeft aria-hidden />
            All conversations
          </Link>
        </>
      }
    >
      {!fetchable ? (
        <Alert tone="danger" title="That is not a conversation id">
          Nothing was requested — the id in the address is not a valid one. Check the link you
          followed here.
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
          <Section title="Session">
            <Card>
              <CardBody>
                <PropertyGrid
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
                      label: 'Last active',
                      value: (
                        <span className="figure">{formatDateTime(detail.session.last_activity_at)}</span>
                      ),
                    },
                    {
                      label: 'Visitor',
                      value:
                        detail.session.visitor_name ?? detail.session.visitor_email ?? 'Anonymous',
                    },
                    {
                      label: 'Visitor email',
                      value: detail.session.visitor_email,
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
                  {/* The shape of the exchange, not a stack of identical boxes:
                      the visitor's own lines sit on the sunken ground with no
                      box at all, and everything the platform said carries a
                      leading rule. Capped at a reading measure — 200-character
                      lines are what an uncapped 1,830px column produces. */}
                  <ol className="flex flex-col gap-3">
                    {detail.messages.map((message) => {
                      const visitor = message.role === 'user';
                      return (
                        <li
                          key={message.id}
                          className={cn(
                            'max-w-reading px-3 py-2.5',
                            visitor
                              ? 'rounded-md bg-surface-sunken'
                              : 'border-l-2 border-accent-500 pl-4',
                            message.role === 'operator' && 'border-plan',
                          )}
                        >
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
                      );
                    })}
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
