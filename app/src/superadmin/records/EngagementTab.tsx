import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Drawer,
  EmptyState,
  Input,
  SearchField,
  SegmentedControl,
  Select,
  Stack,
  Toolbar,
  formatDateTime,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, includesText, usePagedRows } from '../recordList';
import { humanise, type BantSignalRow, type LeadRow, type MeetingRow, type OfflineMessageRow } from './types';

const VIEWS = [
  { value: 'leads', label: 'Leads' },
  { value: 'offline', label: 'Offline messages' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'signals', label: 'Qualification' },
];

/** Everything a conversation produced: contacts, follow-ups and the scoring behind them. */
export function EngagementTab() {
  const url = useUrlState();
  const view = url.get('view', 'leads');

  return (
    <Stack>
      <SegmentedControl
        label="Engagement view"
        value={view}
        onChange={(next) => url.set({ view: next, q: null, status: null, dimension: null })}
        items={VIEWS}
      />
      {view === 'offline' ? (
        <OfflineMessagesList />
      ) : view === 'meetings' ? (
        <MeetingsList />
      ) : view === 'signals' ? (
        <SignalsList />
      ) : (
        <LeadsList />
      )}
    </Stack>
  );
}

function LeadsList() {
  const url = useUrlState();
  const query = url.get('q');
  const list = usePlatformList<LeadRow>('/leads');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.name, row.email, row.company, row.bot_name, row.client_name], query),
    comparators: {
      name: byText((row) => row.name),
      email: byText((row) => row.email),
      company: byText((row) => row.company),
      bot_name: byText((row) => row.bot_name),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<LeadRow>[] = [
    {
      key: 'name',
      header: 'Lead',
      pinned: true,
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name || 'Unnamed'}</p>
          <p className="truncate text-xs text-text-secondary">{row.email ?? row.phone ?? '—'}</p>
        </div>
      ),
    },
    { key: 'company', header: 'Company', sortable: true, render: (row) => row.company ?? '—' },
    { key: 'bot_name', header: 'Chatbot', sortable: true, render: (row) => row.bot_name ?? '—' },
    { key: 'client_name', header: 'Account', render: (row) => row.client_name ?? '—' },
    {
      key: 'created_at',
      header: 'Captured',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search leads"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Name, email, company or chatbot"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Leads captured across every chatbot"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="This endpoint joins leads to accounts on a column the lead table does not have, so it may fail outright on the server. If the error state below appears with a database message, that is why — it is a server-side defect, not a permissions or network problem."
        empty={
          <EmptyState
            compact
            title={query ? 'Nothing matched' : 'No leads'}
            description={
              query
                ? 'No lead matches this search.'
                : 'No visitor has left contact details on any embedded chatbot.'
            }
          />
        }
      />
    </div>
  );
}

const OFFLINE_TONES: Record<string, 'warning' | 'neutral' | 'success'> = {
  new: 'warning',
  read: 'neutral',
  replied: 'success',
};

function OfflineMessagesList() {
  const url = useUrlState();
  const query = url.get('q');
  const status = url.get('status');
  const botId = url.get('bot_id');
  // `status` and `bot_id` are server-side filters on this endpoint.
  const list = usePlatformList<OfflineMessageRow>('/offline-messages', {
    params: { status, bot_id: botId },
  });
  const [reading, setReading] = useState<OfflineMessageRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) =>
      includesText([row.visitor_name, row.visitor_email, row.message_body, row.bot_name], query),
    comparators: {
      visitor_name: byText((row) => row.visitor_name),
      bot_name: byText((row) => row.bot_name),
      status: byText((row) => row.status),
      created_at: byDate((row) => row.created_at),
    },
  });

  async function setStatus(row: OfflineMessageRow, next: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await platform.patch(`/offline-messages/${row.id}`, { status: next });
      list.reload();
      setReading(null);
      toast.success(`Marked ${next}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The status was not changed.');
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<OfflineMessageRow>[] = [
    {
      key: 'visitor_name',
      header: 'Visitor',
      pinned: true,
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.visitor_name}</p>
          <p className="truncate text-xs text-text-secondary">{row.visitor_email}</p>
        </div>
      ),
    },
    {
      key: 'message_body',
      header: 'Message',
      render: (row) => <span className="line-clamp-2 text-text-secondary">{row.message_body}</span>,
    },
    { key: 'bot_name', header: 'Chatbot', sortable: true, render: (row) => row.bot_name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => <Badge tone={OFFLINE_TONES[row.status] ?? 'neutral'}>{row.status}</Badge>,
    },
    {
      key: 'created_at',
      header: 'Received',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'actions',
      header: 'Open',
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="ghost" onClick={() => setReading(row)}>
          Read
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert tone="danger" live title="The status was not changed">
          {error}
        </Alert>
      ) : null}
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search offline messages"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Visitor, email or message"
          />
        </div>
        <div className="w-44">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => url.set({ status: event.target.value })}
            options={[
              { value: '', label: 'Any status' },
              { value: 'new', label: 'New' },
              { value: 'read', label: 'Read' },
              { value: 'replied', label: 'Replied' },
            ]}
          />
        </div>
        <div className="w-40">
          <Input
            aria-label="Filter by chatbot id"
            inputMode="numeric"
            value={botId}
            onChange={(event) => url.set({ bot_id: event.target.value.replace(/\D/g, '') })}
            placeholder="Chatbot id"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Visitor messages left while the team was offline"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="Status and chatbot are filtered by the server. Marking a message read or replied here changes it for the customer's own inbox too — this is the same record they see."
        empty={
          <EmptyState
            compact
            title={query || status || botId ? 'Nothing matched' : 'No offline messages'}
            description={
              query || status || botId
                ? 'No offline message matches this filter.'
                : 'No visitor has left a message while a team was offline.'
            }
          />
        }
      />

      <Drawer
        open={reading !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setReading(null);
        }}
        title={reading ? `Message from ${reading.visitor_name}` : 'Message'}
        description={reading?.visitor_email}
        footer={
          reading ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                loading={busy}
                disabled={reading.status === 'read'}
                onClick={() => void setStatus(reading, 'read')}
              >
                Mark read
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={reading.status === 'replied'}
                onClick={() => void setStatus(reading, 'replied')}
              >
                Mark replied
              </Button>
            </div>
          ) : null
        }
      >
        {reading ? (
          <div className="flex flex-col gap-4">
            <p className="whitespace-pre-wrap text-prose text-text-primary">{reading.message_body}</p>
            <dl className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken px-3 py-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-xs text-text-tertiary">Chatbot</dt>
                <dd>{reading.bot_name ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-xs text-text-tertiary">Account</dt>
                <dd>{reading.client_name ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-xs text-text-tertiary">Phone</dt>
                <dd>{reading.visitor_phone ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-xs text-text-tertiary">Why it fell back</dt>
                <dd>{humanise(reading.fallback_reason)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-xs text-text-tertiary">Received</dt>
                <dd className="figure">{formatDateTime(reading.created_at)}</dd>
              </div>
            </dl>
            <p className="text-xs text-text-tertiary">
              This console can change the status only. There is no super-admin endpoint that replies
              to a visitor — the reply is sent by the customer&apos;s own team from their inbox.
            </p>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function MeetingsList() {
  const url = useUrlState();
  const query = url.get('q');
  const botId = url.get('bot_id');
  const list = usePlatformList<MeetingRow>('/meeting-bookings', { params: { bot_id: botId } });

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.attendee_email, row.bot_name, row.client_name, row.status], query),
    comparators: {
      attendee_email: byText((row) => row.attendee_email),
      bot_name: byText((row) => row.bot_name),
      meeting_time: byDate((row) => row.meeting_time),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<MeetingRow>[] = [
    {
      key: 'attendee_email',
      header: 'Attendee',
      pinned: true,
      sortable: true,
      render: (row) => <span className="font-medium">{row.attendee_email ?? '—'}</span>,
    },
    {
      key: 'meeting_time',
      header: 'Meeting',
      sortable: true,
      render: (row) => <span className="figure">{formatDateTime(row.meeting_time)}</span>,
    },
    { key: 'bot_name', header: 'Chatbot', sortable: true, render: (row) => row.bot_name ?? '—' },
    { key: 'client_name', header: 'Account', render: (row) => row.client_name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (row.status ? <Badge>{humanise(row.status)}</Badge> : '—'),
    },
    {
      key: 'created_at',
      header: 'Booked',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search meetings"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Attendee, chatbot or account"
          />
        </div>
        <div className="w-40">
          <Input
            aria-label="Filter by chatbot id"
            inputMode="numeric"
            value={botId}
            onChange={(event) => url.set({ bot_id: event.target.value.replace(/\D/g, '') })}
            placeholder="Chatbot id"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Meetings booked from a conversation"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="Chatbot is filtered by the server; the search box filters the returned rows here."
        empty={
          <EmptyState
            compact
            title={query || botId ? 'Nothing matched' : 'No meetings booked'}
            description={
              query || botId
                ? 'No booking matches this filter.'
                : 'No visitor has confirmed a meeting from a chat.'
            }
          />
        }
      />
    </div>
  );
}

const DIMENSION_TONES: Record<string, 'success' | 'warning' | 'neutral'> = {
  budget: 'success',
  authority: 'warning',
  need: 'neutral',
  timeline: 'neutral',
};

function SignalsList() {
  const url = useUrlState();
  const query = url.get('q');
  const dimension = url.get('dimension');
  const sessionId = url.get('session_id');
  const list = usePlatformList<BantSignalRow>('/bant-signals', {
    params: { dimension, session_id: sessionId },
  });

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.signal_text, row.extracted_value, row.bot_name, row.client_name], query),
    comparators: {
      dimension: byText((row) => row.dimension),
      confidence: byNumber((row) => row.confidence),
      score_after: byNumber((row) => row.score_after),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<BantSignalRow>[] = [
    {
      key: 'dimension',
      header: 'Dimension',
      pinned: true,
      sortable: true,
      render: (row) => <Badge tone={DIMENSION_TONES[row.dimension] ?? 'neutral'}>{row.dimension}</Badge>,
    },
    {
      key: 'signal_text',
      header: 'Signal',
      render: (row) => (
        <div className="min-w-0">
          <p className="line-clamp-2 text-text-primary">{row.signal_text ?? '—'}</p>
          {row.extracted_value ? (
            <p className="truncate text-xs text-text-secondary">→ {row.extracted_value}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      render: (row) =>
        row.score_before == null && row.score_after == null
          ? '—'
          : `${row.score_before ?? 0} → ${row.score_after ?? 0}`,
    },
    {
      key: 'confidence',
      header: 'Confidence',
      align: 'right',
      sortable: true,
      secondary: true,
      render: (row) => (row.confidence == null ? '—' : row.confidence.toFixed(2)),
    },
    {
      key: 'source',
      header: 'Source',
      secondary: true,
      render: (row) => (row.source ? <Badge>{humanise(row.source)}</Badge> : '—'),
    },
    { key: 'bot_name', header: 'Chatbot', secondary: true, render: (row) => row.bot_name ?? '—' },
    {
      key: 'created_at',
      header: 'Extracted',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search qualification signals"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Signal text or extracted value"
          />
        </div>
        <div className="w-44">
          <Select
            aria-label="Filter by dimension"
            value={dimension}
            onChange={(event) => url.set({ dimension: event.target.value })}
            options={[
              { value: '', label: 'Any dimension' },
              { value: 'budget', label: 'Budget' },
              { value: 'authority', label: 'Authority' },
              { value: 'need', label: 'Need' },
              { value: 'timeline', label: 'Timeline' },
            ]}
          />
        </div>
        <div className="w-full max-w-xs">
          <SearchField
            label="Filter by conversation id"
            value={sessionId}
            onValueChange={(next) => url.set({ session_id: next })}
            placeholder="Exact conversation id"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Append-only BANT and MEDDIC qualification signals"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="Dimension and conversation id are filtered by the server, and the conversation id must match exactly. This log is append-only: it records what the extractor concluded, and nothing here can change a score."
        empty={
          <EmptyState
            compact
            title={query || dimension || sessionId ? 'Nothing matched' : 'No signals extracted'}
            description={
              query || dimension || sessionId
                ? 'No signal matches this filter. A conversation id must match exactly.'
                : 'No conversation has produced a qualification signal yet.'
            }
          />
        }
      />
    </div>
  );
}
