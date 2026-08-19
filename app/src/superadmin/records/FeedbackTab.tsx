import { useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Drawer,
  EmptyState,
  Field,
  SearchField,
  SegmentedControl,
  Select,
  Stack,
  Textarea,
  Toolbar,
  formatDateTime,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, includesText, usePagedRows } from '../recordList';
import {
  FEEDBACK_AREAS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_TONES,
  FEEDBACK_TYPES,
  SEVERITY_TONES,
  humanise,
  type ChatFeedbackRow,
  type PlatformFeedbackRow,
} from './types';

const VIEWS = [
  { value: 'platform', label: 'Product feedback' },
  { value: 'chat', label: 'Chat ratings' },
];

/** What people told us: about the product, and about an answer a chatbot gave. */
export function FeedbackTab() {
  const url = useUrlState();
  const view = url.get('view', 'platform');

  return (
    <Stack>
      <SegmentedControl
        label="Feedback view"
        value={view}
        onChange={(next) => url.set({ view: next, q: null, status: null, type: null, area: null, severity: null })}
        items={VIEWS}
      />
      {view === 'chat' ? <ChatFeedbackList /> : <PlatformFeedbackList />}
    </Stack>
  );
}

function ChatFeedbackList() {
  const url = useUrlState();
  const query = url.get('q');
  const rating = url.get('rating');
  const list = usePlatformList<ChatFeedbackRow>('/feedback');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => {
      const ratingMatch =
        !rating || (rating === 'up' ? row.feedback > 0 : rating === 'down' ? row.feedback < 0 : true);
      return ratingMatch && includesText([row.question, row.answer, row.client_name], query);
    },
    comparators: {
      client_name: byText((row) => row.client_name),
      feedback: byNumber((row) => row.feedback),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<ChatFeedbackRow>[] = [
    {
      key: 'feedback',
      header: 'Rating',
      pinned: true,
      sortable: true,
      render: (row) =>
        row.feedback > 0 ? (
          <Badge tone="success">
            <ThumbsUp aria-hidden className="mr-1 inline h-3 w-3" />
            Helpful
          </Badge>
        ) : (
          <Badge tone="danger">
            <ThumbsDown aria-hidden className="mr-1 inline h-3 w-3" />
            Not helpful
          </Badge>
        ),
    },
    {
      key: 'question',
      header: 'Asked',
      render: (row) => <span className="line-clamp-2 text-text-primary">{row.question}</span>,
    },
    {
      key: 'answer',
      header: 'Answered',
      render: (row) => <span className="line-clamp-2 text-text-secondary">{row.answer}</span>,
    },
    { key: 'client_name', header: 'Account', sortable: true, render: (row) => row.client_name },
    { key: 'user', header: 'Visitor', secondary: true, render: (row) => row.user },
    {
      key: 'created_at',
      header: 'Rated',
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
            label="Search chat ratings"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Question, answer or account"
          />
        </div>
        <div className="w-44">
          <Select
            aria-label="Filter by rating"
            value={rating}
            onChange={(event) => url.set({ rating: event.target.value })}
            options={[
              { value: '', label: 'Any rating' },
              { value: 'up', label: 'Helpful' },
              { value: 'down', label: 'Not helpful' },
            ]}
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Visitor ratings on individual chatbot answers"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.message_id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        note="Visitors are pseudonymised per account by the server and the conversation id is stripped before the row is returned, so a rating cannot be traced back to a conversation from here. The endpoint accepts no parameters, so both filters are applied in this console."
        empty={
          <EmptyState
            compact
            title={query || rating ? 'Nothing matched' : 'No ratings'}
            description={
              query || rating
                ? 'No rated answer matches this filter.'
                : 'No visitor has rated a chatbot answer yet.'
            }
          />
        }
      />
    </div>
  );
}

const TRIAGE_NOTE =
  'Status, type, area and severity are filtered by the server. Moving a report into resolved or closed stamps you as the resolver and sends the customer an in-app notification carrying your response — so write the response before you resolve it.';

function PlatformFeedbackList() {
  const url = useUrlState();
  const query = url.get('q');
  const status = url.get('status');
  const type = url.get('type');
  const area = url.get('area');
  const severity = url.get('severity');
  const list = usePlatformList<PlatformFeedbackRow>('/platform-feedback', {
    params: { status, type, area, severity },
  });
  const [triaging, setTriaging] = useState<PlatformFeedbackRow | null>(null);

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.message, row.client_name, row.client_email], query),
    comparators: {
      client_name: byText((row) => row.client_name),
      type: byText((row) => row.type),
      area: byText((row) => row.area),
      severity: byText((row) => row.severity),
      status: byText((row) => row.status),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<PlatformFeedbackRow>[] = [
    {
      key: 'message',
      header: 'Report',
      pinned: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="line-clamp-2 font-medium">{row.message}</p>
          <p className="truncate text-xs text-text-secondary">{row.client_name}</p>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      sortable: true,
      render: (row) => (row.type ? <Badge>{humanise(row.type)}</Badge> : '—'),
    },
    {
      key: 'area',
      header: 'Area',
      sortable: true,
      secondary: true,
      render: (row) => humanise(row.area),
    },
    {
      key: 'severity',
      header: 'Severity',
      sortable: true,
      render: (row) =>
        row.severity ? (
          <Badge tone={SEVERITY_TONES[row.severity] ?? 'neutral'}>{row.severity}</Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <Badge tone={FEEDBACK_STATUS_TONES[row.status] ?? 'neutral'}>{humanise(row.status)}</Badge>
      ),
    },
    {
      key: 'created_at',
      header: 'Reported',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'actions',
      header: 'Triage',
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="ghost" onClick={() => setTriaging(row)}>
          Triage
        </Button>
      ),
    },
  ];

  const filtered = Boolean(query || status || type || area || severity);

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search product feedback"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Message, account or email"
          />
        </div>
        <div className="w-40">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => url.set({ status: event.target.value })}
            options={[
              { value: '', label: 'Any status' },
              ...FEEDBACK_STATUSES.map((value) => ({ value, label: humanise(value) })),
            ]}
          />
        </div>
        <div className="w-40">
          <Select
            aria-label="Filter by type"
            value={type}
            onChange={(event) => url.set({ type: event.target.value })}
            options={[
              { value: '', label: 'Any type' },
              ...FEEDBACK_TYPES.map((value) => ({ value, label: humanise(value) })),
            ]}
          />
        </div>
        <div className="w-40">
          <Select
            aria-label="Filter by area"
            value={area}
            onChange={(event) => url.set({ area: event.target.value })}
            options={[
              { value: '', label: 'Any area' },
              ...FEEDBACK_AREAS.map((value) => ({ value, label: humanise(value) })),
            ]}
          />
        </div>
        <div className="w-40">
          <Select
            aria-label="Filter by severity"
            value={severity}
            onChange={(event) => url.set({ severity: event.target.value })}
            options={[
              { value: '', label: 'Any severity' },
              ...FEEDBACK_SEVERITIES.map((value) => ({ value, label: value })),
            ]}
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Product feedback submitted by customers"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        note={TRIAGE_NOTE}
        empty={
          <EmptyState
            compact
            title={filtered ? 'Nothing matched' : 'No product feedback'}
            description={
              filtered
                ? 'No report matches this filter. Severity is only ever set on a bug.'
                : 'No customer has sent feedback about the product itself.'
            }
          />
        }
      />

      <TriageDrawer
        report={triaging}
        onClose={() => setTriaging(null)}
        onSaved={() => {
          setTriaging(null);
          list.reload();
        }}
      />
    </div>
  );
}

function TriageDrawer({
  report,
  onClose,
  onSaved,
}: {
  report: PlatformFeedbackRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState('open');
  const [type, setType] = useState('other');
  const [area, setArea] = useState('other');
  const [severity, setSeverity] = useState('low');
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!report) return;
    setStatus(report.status);
    setType(report.type ?? 'other');
    setArea(report.area ?? 'other');
    setSeverity(report.severity ?? 'low');
    setResponse(report.admin_response ?? '');
    setError(null);
  }, [report]);

  const resolving =
    report !== null &&
    (status === 'resolved' || status === 'closed') &&
    report.status !== 'resolved' &&
    report.status !== 'closed';

  async function save(): Promise<void> {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      await platform.patch(`/platform-feedback/${report.id}`, {
        status,
        type,
        area,
        // Severity is bug-only; the server clears it for any other type anyway.
        severity: type === 'bug' ? severity : null,
        admin_response: response.trim() || null,
      });
      toast.success('Feedback updated.');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The report was not updated.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={report !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      width="lg"
      title={report ? `Feedback from ${report.client_name}` : 'Feedback'}
      description={report?.client_email}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {resolving ? 'Save and notify the customer' : 'Save triage'}
          </Button>
        </div>
      }
    >
      {report ? (
        <div className="flex flex-col gap-4">
          {error ? (
            <Alert tone="danger" live title="The report was not updated">
              {error}
            </Alert>
          ) : null}
          {resolving ? (
            <Alert tone="warning" title="This closes the loop with the customer">
              Saving stamps you as the resolver and sends them an in-app notification containing your
              response. Reopening later clears the stamp but does not unsend the notification.
            </Alert>
          ) : null}

          <div>
            <p className="text-xs text-text-tertiary">Reported {formatDateTime(report.created_at)}</p>
            <p className="mt-1 whitespace-pre-wrap text-prose text-text-primary">{report.message}</p>
          </div>

          {report.attachments.length > 0 ? (
            <div>
              <p className="text-xs text-text-tertiary">Attachments</p>
              <ul className="mt-1 flex flex-col gap-1">
                {report.attachments.map((attachment, index) => (
                  <li key={attachment.url ?? index}>
                    {attachment.url ? (
                      <a
                        className="break-all text-sm text-accent-600 underline-offset-2 hover:underline"
                        href={attachment.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {attachment.url}
                      </a>
                    ) : (
                      <span className="text-sm text-text-tertiary">An attachment with no URL</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {report.context ? (
            <div>
              <p className="text-xs text-text-tertiary">Context the app captured</p>
              <pre className="mt-1 overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 font-mono text-xs text-text-secondary">
                {JSON.stringify(report.context, null, 2)}
              </pre>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Status">
              <Select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                options={FEEDBACK_STATUSES.map((value) => ({ value, label: humanise(value) }))}
              />
            </Field>
            <Field label="Type">
              <Select
                value={type}
                onChange={(event) => setType(event.target.value)}
                options={FEEDBACK_TYPES.map((value) => ({ value, label: humanise(value) }))}
              />
            </Field>
            <Field label="Area">
              <Select
                value={area}
                onChange={(event) => setArea(event.target.value)}
                options={FEEDBACK_AREAS.map((value) => ({ value, label: humanise(value) }))}
              />
            </Field>
            <Field
              label="Severity"
              hint="Bugs only. Re-classifying away from a bug clears it."
              disabled={type !== 'bug'}
            >
              <Select
                disabled={type !== 'bug'}
                value={severity}
                onChange={(event) => setSeverity(event.target.value)}
                options={FEEDBACK_SEVERITIES.map((value) => ({ value, label: value }))}
              />
            </Field>
          </div>

          <Field
            label="Response to the customer"
            hint="Sent with the notification when this is resolved or closed. Up to 5,000 characters."
          >
            <Textarea
              rows={4}
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              placeholder="Fixed in today's release — the export now includes cancelled invoices."
            />
          </Field>
        </div>
      ) : null}
    </Drawer>
  );
}
