import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Mail,
  Pencil,
  Plus,
  Send,
  Trash2,
  Webhook as WebhookIcon,
  X,
} from 'lucide-react';
import {
  Button,
  DataTable,
  EmptyState,
  InsightCard,
  Input,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  cn,
  type Column,
} from '../../design-system';
import {
  createWebhook,
  deleteWebhook,
  getWebhookDeliveries,
  getWebhooks,
  testWebhook,
  updateBot,
  updateWebhook,
} from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { type Bot, type Webhook, type WebhookDelivery } from '../../types/domain';

// ── Bot integration fields ────────────────────────────────────────────────────
// The shared `Bot` shim intentionally types only the core columns. Email routing
// and meeting-booking settings live on the same row; we read them through this
// narrow view. `Bot` is structurally assignable to `Bot & BotIntegrationSettings`
// (every added key is optional), so the assertion below is safe — no `any`.

interface NotificationEmails {
  default?: string[];
  qualified_lead?: string[];
  handoff_request?: string[];
  offline_message?: string[];
}

interface BotIntegrationSettings {
  meeting_booking_enabled?: boolean;
  meeting_provider?: string | null;
  calendly_url?: string | null;
  zcal_url?: string | null;
  calcom_url?: string | null;
  reply_to_email?: string | null;
  notification_emails?: NotificationEmails | null;
  email_on_qualified?: boolean;
  email_on_handoff?: boolean;
  email_on_offline?: boolean;
  email_visitor_confirmation?: boolean;
}

type BotWithIntegrations = Bot & BotIntegrationSettings;

const readIntegrations = (bot: Bot): BotWithIntegrations => bot as BotWithIntegrations;

// ── Constants ─────────────────────────────────────────────────────────────────

const WEBHOOK_EVENTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'tier_transition', label: 'Lead qualified' },
  { value: 'lead_captured', label: 'Lead captured' },
  { value: 'handoff_requested', label: 'Handoff requested' },
  { value: 'chat_closed', label: 'Conversation closed' },
  { value: 'meeting_booked', label: 'Meeting booked' },
];

const EVENT_LABELS: Record<string, string> = Object.fromEntries(
  WEBHOOK_EVENTS.map((event) => [event.value, event.label]),
);

type MeetingUrlField = 'calendly_url' | 'zcal_url' | 'calcom_url';

const MEETING_PROVIDERS: ReadonlyArray<{
  id: string;
  name: string;
  domain: string;
  urlField: MeetingUrlField;
  placeholder: string;
}> = [
  {
    id: 'calendly',
    name: 'Calendly',
    domain: 'calendly.com',
    urlField: 'calendly_url',
    placeholder: 'https://calendly.com/you/30min',
  },
  {
    id: 'zcal',
    name: 'Zcal',
    domain: 'zcal.co',
    urlField: 'zcal_url',
    placeholder: 'https://zcal.co/you/30min',
  },
  {
    id: 'calcom',
    name: 'Cal.com',
    domain: 'cal.com',
    urlField: 'calcom_url',
    placeholder: 'https://cal.com/you/30min',
  },
];

const DEFAULT_EVENTS = ['tier_transition', 'lead_captured'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const labelClass = 'mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncateUrl(url: string, max = 72): string {
  return url.length > max ? `${url.slice(0, max)}…` : url;
}

type Feedback = { readonly tone: 'success' | 'error'; readonly message: string };
type TabKey = 'webhooks' | 'meetings' | 'email';

// ── Local Switch (accessible toggle) ──────────────────────────────────────────

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}

function Switch({ checked, onChange, disabled = false, label }: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-border-strong)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

// ── Email chip input ──────────────────────────────────────────────────────────

interface EmailChipsProps {
  id: string;
  emails: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

function EmailChips({ id, emails, onChange, placeholder }: EmailChipsProps): ReactElement {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const add = (raw: string): void => {
    const email = raw.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) {
      setError(`“${email}” is not a valid email address.`);
      return;
    }
    if (emails.includes(email)) {
      setError(`“${email}” is already added.`);
      return;
    }
    setError('');
    onChange([...emails, email]);
    setValue('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add(value);
    } else if (event.key === 'Backspace' && !value && emails.length > 0) {
      onChange(emails.slice(0, -1));
    }
  };

  return (
    <div>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2.5 py-1.5 focus-within:border-[var(--ds-accent)] focus-within:outline-none focus-within:shadow-[0_0_0_1px_var(--ds-ring)]">
        {emails.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--ds-accent-soft)] px-2 py-0.5 text-[12px] font-medium text-[var(--ds-accent-text)]"
          >
            {email}
            <button
              type="button"
              onClick={() => onChange(emails.filter((item) => item !== email))}
              aria-label={`Remove ${email}`}
              className="opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="email"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => add(value)}
          placeholder={emails.length === 0 ? placeholder : 'Add another…'}
          className="min-w-[10rem] flex-1 bg-transparent text-sm text-[var(--ds-text)] outline-none placeholder:text-[var(--ds-text-subtle)]"
        />
      </div>
      {error && <p className="mt-1 text-[12px] text-[var(--ds-danger)]">{error}</p>}
    </div>
  );
}

// ── Delivery log ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function deliveryTone(delivery: WebhookDelivery): 'success' | 'danger' | 'warning' {
  const code = delivery.status_code ?? 0;
  if (code >= 200 && code < 300) return 'success';
  if (code === 0) return 'warning';
  return 'danger';
}

const DELIVERY_COLUMNS: Column<WebhookDelivery>[] = [
  {
    key: 'event_type',
    header: 'Event',
    render: (row) => (
      <span className="font-medium text-[var(--ds-text)]">
        {EVENT_LABELS[row.event_type] ?? row.event_type}
      </span>
    ),
  },
  {
    key: 'status_code',
    header: 'Status',
    render: (row) => (
      <StatusBadge tone={deliveryTone(row)}>
        {row.status_code ? row.status_code : 'Pending'}
      </StatusBadge>
    ),
  },
  {
    key: 'attempt',
    header: 'Attempt',
    align: 'right',
    render: (row) => <span className="tabular-nums text-[var(--ds-text-muted)]">{row.attempt}</span>,
  },
  {
    key: 'created_at',
    header: 'Sent',
    render: (row) => <span className="text-[var(--ds-text-muted)]">{formatDateTime(row.created_at)}</span>,
  },
  {
    key: 'delivered_at',
    header: 'Delivered',
    render: (row) => (
      <span className="text-[var(--ds-text-muted)]">
        {row.delivered_at
          ? formatDateTime(row.delivered_at)
          : row.next_retry_at
            ? `Retry ${formatDateTime(row.next_retry_at)}`
            : 'Pending retry'}
      </span>
    ),
  },
];

interface DeliveryState {
  key: string;
  deliveries: WebhookDelivery[];
  total: number;
}

function DeliveryLog({ webhookId }: { webhookId: number }): ReactElement {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DeliveryState | { key: string; error: string } | null>(null);
  const key = `${webhookId}:${page}`;

  // First setState always follows an await → `loading` is a genuine derived
  // phase, never a synchronous write in the effect body.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await getWebhookDeliveries(webhookId, page);
        if (!active) return;
        setResult({ key, deliveries: data.deliveries ?? [], total: data.total ?? 0 });
      } catch (error) {
        if (!active) return;
        setResult({ key, error: toMessage(error, 'We couldn’t load delivery attempts.') });
      }
    })();
    return () => {
      active = false;
    };
  }, [webhookId, page, key]);

  const loading = result === null || result.key !== key;
  const error = !loading && 'error' in result ? result.error : null;
  const state = !loading && 'deliveries' in result ? result : null;
  const totalPages = state ? Math.max(1, Math.ceil(state.total / PAGE_SIZE)) : 1;

  if (loading) {
    return <Skeleton className="h-40 w-full rounded-xl" />;
  }

  if (error) {
    return (
      <p className="rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-4 py-3 text-[13px] text-[var(--ds-danger)]">
        {error}
      </p>
    );
  }

  if (!state || state.deliveries.length === 0) {
    return (
      <p className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3 text-[13px] text-[var(--ds-text-muted)]">
        No delivery attempts yet. They’ll appear here as events fire.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <DataTable
        caption="Webhook delivery attempts"
        columns={DELIVERY_COLUMNS}
        rows={state.deliveries}
        rowKey={(row) => row.id}
      />
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Webhooks panel ────────────────────────────────────────────────────────────

interface WebhooksPanelProps {
  webhooks: Webhook[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onFeedback: (feedback: Feedback) => void;
  botId: number;
}

function WebhooksPanel({
  webhooks,
  loading,
  error,
  onReload,
  onFeedback,
  botId,
}: WebhooksPanelProps): ReactElement {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [formUrl, setFormUrl] = useState('');
  const [formEvents, setFormEvents] = useState<string[]>(DEFAULT_EVENTS);
  const [submitting, setSubmitting] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const openCreate = (): void => {
    setEditing(null);
    setFormUrl('');
    setFormEvents(DEFAULT_EVENTS);
    setCreatedSecret(null);
    setFormOpen(true);
  };

  const openEdit = (webhook: Webhook): void => {
    setEditing(webhook);
    setFormUrl(webhook.url);
    setFormEvents(webhook.events.length > 0 ? webhook.events : DEFAULT_EVENTS);
    setCreatedSecret(null);
    setFormOpen(true);
  };

  const closeForm = (): void => {
    setFormOpen(false);
    setEditing(null);
    setCreatedSecret(null);
  };

  const toggleEvent = (value: string): void => {
    setFormEvents((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const url = formUrl.trim();
    if (!url || formEvents.length === 0) return;
    setSubmitting(true);
    try {
      if (editing) {
        await updateWebhook(editing.id, { url, events: formEvents });
        onFeedback({ tone: 'success', message: 'Endpoint updated.' });
        closeForm();
      } else {
        const created = await createWebhook(botId, { url, events: formEvents, is_active: true });
        setCreatedSecret(created.secret ?? '');
        onFeedback({ tone: 'success', message: 'Endpoint connected.' });
      }
      onReload();
    } catch (submitError) {
      onFeedback({ tone: 'error', message: toMessage(submitError, 'Failed to save the endpoint.') });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (webhook: Webhook, next: boolean): Promise<void> => {
    setRowBusyId(webhook.id);
    try {
      await updateWebhook(webhook.id, { is_active: next });
      onFeedback({
        tone: 'success',
        message: next ? 'Endpoint resumed.' : 'Endpoint paused.',
      });
      onReload();
    } catch (toggleError) {
      onFeedback({ tone: 'error', message: toMessage(toggleError, 'Failed to update the endpoint.') });
    } finally {
      setRowBusyId(null);
    }
  };

  const handleTest = async (webhook: Webhook): Promise<void> => {
    setRowBusyId(webhook.id);
    try {
      await testWebhook(webhook.id);
      onFeedback({ tone: 'success', message: 'Test event dispatched.' });
    } catch (testError) {
      onFeedback({ tone: 'error', message: toMessage(testError, 'Failed to send a test event.') });
    } finally {
      setRowBusyId(null);
    }
  };

  const handleDelete = async (webhook: Webhook): Promise<void> => {
    setRowBusyId(webhook.id);
    try {
      await deleteWebhook(webhook.id);
      onFeedback({ tone: 'success', message: 'Endpoint disconnected.' });
      setRemovingId(null);
      if (expandedId === webhook.id) setExpandedId(null);
      onReload();
    } catch (deleteError) {
      onFeedback({ tone: 'error', message: toMessage(deleteError, 'Failed to disconnect the endpoint.') });
    } finally {
      setRowBusyId(null);
    }
  };

  const copySecret = async (): Promise<void> => {
    if (!createdSecret) return;
    try {
      await navigator.clipboard.writeText(createdSecret);
      onFeedback({ tone: 'success', message: 'Signing secret copied.' });
    } catch {
      onFeedback({ tone: 'error', message: 'Couldn’t copy to the clipboard.' });
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Webhook endpoints"
        description="Send lead and conversation events to your CRM, Zapier, or Make in real time."
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} aria-hidden="true" />
            Add endpoint
          </Button>
        }
      />

      {/* Create / edit form (progressive disclosure). */}
      {formOpen && (
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]"
        >
          <SectionHeader
            title={editing ? 'Edit endpoint' : 'Connect an endpoint'}
            description="We’ll POST a signed JSON payload to this URL whenever a selected event happens."
          />

          {createdSecret !== null ? (
            <div className="mt-4 space-y-4">
              <div className="rounded-lg border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] p-4">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ds-warning)]">
                  <CheckCircle2 size={16} aria-hidden="true" />
                  Save this signing secret — it won’t be shown again.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md bg-[var(--ds-bg-surface)] px-3 py-2 font-mono text-[12px] text-[var(--ds-text)]">
                    {createdSecret || 'No secret returned.'}
                  </code>
                  {createdSecret && (
                    <Button type="button" variant="outline" size="sm" onClick={copySecret}>
                      <Copy size={14} aria-hidden="true" />
                      Copy
                    </Button>
                  )}
                </div>
                <p className="mt-2 text-[12px] text-[var(--ds-text-muted)]">
                  Verify the <code className="font-mono">X-OyeChats-Signature</code> header with this
                  secret to confirm each payload is genuine.
                </p>
              </div>
              <div className="flex justify-end">
                <Button type="button" onClick={closeForm}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-4">
                <label htmlFor="webhook-url" className={labelClass}>
                  Endpoint URL
                </label>
                <Input
                  id="webhook-url"
                  type="url"
                  required
                  autoFocus
                  placeholder="https://hooks.zapier.com/…"
                  value={formUrl}
                  onChange={(event) => setFormUrl(event.target.value)}
                />
              </div>

              <fieldset className="mt-4">
                <legend className={labelClass}>Events to send</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {WEBHOOK_EVENTS.map((event) => {
                    const checked = formEvents.includes(event.value);
                    return (
                      <label
                        key={event.value}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] transition-colors',
                          checked
                            ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] text-[var(--ds-text)]'
                            : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-muted)] hover:border-[var(--ds-border-strong)]',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--ds-accent)]"
                          checked={checked}
                          onChange={() => toggleEvent(event.value)}
                        />
                        {event.label}
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <div className="mt-4 flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" onClick={closeForm}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting || !formUrl.trim() || formEvents.length === 0}>
                  {submitting ? 'Saving…' : editing ? 'Save changes' : 'Connect endpoint'}
                </Button>
              </div>
            </>
          )}
        </form>
      )}

      {/* Endpoint list. */}
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : error ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load your endpoints"
          description={error}
          action={<Button onClick={onReload}>Try again</Button>}
        />
      ) : webhooks.length === 0 ? (
        <EmptyState
          icon={WebhookIcon}
          title="No endpoints connected"
          description="Add a URL to start pushing qualified leads and conversation events to your other tools."
          action={
            <Button onClick={openCreate}>
              <Plus size={16} aria-hidden="true" />
              Add endpoint
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {webhooks.map((webhook) => {
            const busy = rowBusyId === webhook.id;
            const confirming = removingId === webhook.id;
            const expanded = expandedId === webhook.id;
            return (
              <li
                key={webhook.id}
                className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-4 shadow-[var(--ds-shadow-sm)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <StatusBadge tone={webhook.is_active ? 'success' : 'neutral'} dot>
                        {webhook.is_active ? 'Active' : 'Paused'}
                      </StatusBadge>
                      <p
                        className="truncate font-mono text-[13px] font-medium text-[var(--ds-text)]"
                        title={webhook.url}
                      >
                        {truncateUrl(webhook.url)}
                      </p>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {webhook.events.map((eventType) => (
                        <span
                          key={eventType}
                          className="rounded-md bg-[var(--ds-bg-sunken)] px-2 py-0.5 text-[11px] text-[var(--ds-text-muted)]"
                        >
                          {EVENT_LABELS[eventType] ?? eventType}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={webhook.is_active}
                      disabled={busy}
                      onChange={(next) => handleToggleActive(webhook, next)}
                      label={`${webhook.is_active ? 'Pause' : 'Resume'} ${webhook.url}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Send a test event to ${webhook.url}`}
                      disabled={busy}
                      onClick={() => handleTest(webhook)}
                    >
                      <Send size={15} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${webhook.url}`}
                      disabled={busy}
                      onClick={() => openEdit(webhook)}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Disconnect ${webhook.url}`}
                      disabled={busy}
                      onClick={() => setRemovingId(webhook.id)}
                    >
                      <Trash2 size={15} aria-hidden="true" className="text-[var(--ds-danger)]" />
                    </Button>
                  </div>
                </div>

                {confirming && (
                  <div className="mt-3 flex flex-col gap-3 border-t border-[var(--ds-border)] pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[13px] text-[var(--ds-text-muted)]">
                      Disconnect this endpoint? Deliveries stop immediately and can’t be resumed.
                    </p>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setRemovingId(null)}>
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleDelete(webhook)}
                      >
                        {busy ? 'Disconnecting…' : 'Disconnect'}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="mt-3 border-t border-[var(--ds-border)] pt-3">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : webhook.id)}
                    aria-expanded={expanded}
                    aria-controls={`delivery-log-${webhook.id}`}
                    className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:text-[var(--ds-accent)]"
                  >
                    {expanded ? (
                      <ChevronDown size={15} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={15} aria-hidden="true" />
                    )}
                    Delivery log
                  </button>
                  {expanded && (
                    <div id={`delivery-log-${webhook.id}`} className="mt-3">
                      <DeliveryLog webhookId={webhook.id} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <InsightCard
        icon={WebhookIcon}
        tone="info"
        title="Connecting a CRM?"
        body="Point an endpoint at a Zapier “Catch Hook” or Make “Custom webhook” trigger, then map the payload’s contact fields onto a Create Contact / Create Lead step in HubSpot, Salesforce, or any CRM."
      />
    </div>
  );
}

// ── Meetings panel ────────────────────────────────────────────────────────────

interface BotPanelProps {
  bot: Bot;
  onSaved: () => Promise<unknown>;
  onFeedback: (feedback: Feedback) => void;
}

function MeetingsPanel({ bot, onSaved, onFeedback }: BotPanelProps): ReactElement {
  // Initialized lazily from the agent. The parent keys this panel by agent id,
  // so switching agents remounts it with fresh values — no setState-in-effect.
  const initial = readIntegrations(bot);
  const [enabled, setEnabled] = useState(!!initial.meeting_booking_enabled);
  const [provider, setProvider] = useState(initial.meeting_provider || 'calendly');
  const [urls, setUrls] = useState<Record<string, string>>(() =>
    Object.fromEntries(MEETING_PROVIDERS.map((item) => [item.id, initial[item.urlField] ?? ''])),
  );
  const [saving, setSaving] = useState(false);

  const active = MEETING_PROVIDERS.find((item) => item.id === provider) ?? MEETING_PROVIDERS[0];
  const activeUrl = urls[active.id] ?? '';

  const handleSave = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    try {
      await updateBot(bot.id, {
        meeting_booking_enabled: enabled,
        meeting_provider: enabled ? provider : null,
        ...Object.fromEntries(
          MEETING_PROVIDERS.map((item) => [item.urlField, urls[item.id] || null]),
        ),
      });
      await onSaved();
      onFeedback({ tone: 'success', message: 'Meeting booking saved.' });
    } catch (saveError) {
      onFeedback({ tone: 'error', message: toMessage(saveError, 'Failed to save meeting settings.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="max-w-3xl space-y-6">
      <SectionHeader
        title="Meeting booking"
        description="Let visitors book a call without leaving the chat. Your AI also offers this when it senses scheduling intent."
      />

      <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-[var(--ds-text)]">Enable meeting booking</p>
            <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
              Show a booking option in the widget. One provider can be active at a time.
            </p>
          </div>
          <Switch checked={enabled} onChange={setEnabled} label="Enable meeting booking" />
        </div>

        {enabled && (
          <div className="mt-5 space-y-5 border-t border-[var(--ds-border)] pt-5">
            <fieldset>
              <legend className={labelClass}>Calendar provider</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                {MEETING_PROVIDERS.map((item) => {
                  const selected = provider === item.id;
                  return (
                    <label
                      key={item.id}
                      className={cn(
                        'flex cursor-pointer flex-col gap-0.5 rounded-lg border px-4 py-3 transition-colors',
                        selected
                          ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                          : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] hover:border-[var(--ds-border-strong)]',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="meeting-provider"
                          value={item.id}
                          checked={selected}
                          onChange={() => setProvider(item.id)}
                          className="h-4 w-4 accent-[var(--ds-accent)]"
                        />
                        <span className="text-[14px] font-semibold text-[var(--ds-text)]">
                          {item.name}
                        </span>
                      </span>
                      <span className="pl-6 text-[12px] text-[var(--ds-text-subtle)]">
                        {item.domain}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <label htmlFor="meeting-url" className={labelClass}>
                {active.name} scheduling link
              </label>
              <Input
                id="meeting-url"
                type="url"
                value={activeUrl}
                onChange={(event) =>
                  setUrls((current) => ({ ...current, [active.id]: event.target.value }))
                }
                placeholder={active.placeholder}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={saving || (enabled && !activeUrl.trim())}>
          {saving ? 'Saving…' : 'Save meeting settings'}
        </Button>
      </div>
    </form>
  );
}

// ── Email panel ───────────────────────────────────────────────────────────────

interface EmailToggle {
  key: 'email_on_qualified' | 'email_on_handoff' | 'email_on_offline' | 'email_visitor_confirmation';
  title: string;
  description: string;
}

const EMAIL_TOGGLES: ReadonlyArray<EmailToggle> = [
  {
    key: 'email_on_qualified',
    title: 'Notify the team on qualified leads',
    description: 'Email your team when a visitor reaches the qualified tier.',
  },
  {
    key: 'email_on_handoff',
    title: 'Notify the team on handoff requests',
    description: 'Email your team when a visitor asks for a person.',
  },
  {
    key: 'email_on_offline',
    title: 'Notify the team on offline messages',
    description: 'Email your team when a visitor leaves a message while you’re away.',
  },
  {
    key: 'email_visitor_confirmation',
    title: 'Confirm receipt to visitors',
    description: 'Send visitors a “we got your message” email after they submit an offline message.',
  },
];

function EmailPanel({ bot, onSaved, onFeedback }: BotPanelProps): ReactElement {
  // Initialized lazily; the parent keys this panel by agent id (see MeetingsPanel).
  const initial = readIntegrations(bot);
  const notify = initial.notification_emails ?? null;
  const [replyTo, setReplyTo] = useState<string[]>(
    initial.reply_to_email ? [initial.reply_to_email] : [],
  );
  const [recipients, setRecipients] = useState<string[]>(notify?.default ?? []);
  const [toggles, setToggles] = useState<Record<EmailToggle['key'], boolean>>({
    email_on_qualified: initial.email_on_qualified ?? true,
    email_on_handoff: initial.email_on_handoff ?? true,
    email_on_offline: initial.email_on_offline ?? true,
    email_visitor_confirmation: initial.email_visitor_confirmation ?? true,
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    try {
      // Preserve any per-event overrides the legacy Email screen may have set;
      // this page only manages the default recipient list.
      const notificationEmails: NotificationEmails = { ...(notify ?? {}), default: recipients };
      await updateBot(bot.id, {
        reply_to_email: replyTo[0] ?? null,
        notification_emails: notificationEmails,
        email_on_qualified: toggles.email_on_qualified,
        email_on_handoff: toggles.email_on_handoff,
        email_on_offline: toggles.email_on_offline,
        email_visitor_confirmation: toggles.email_visitor_confirmation,
      });
      await onSaved();
      onFeedback({ tone: 'success', message: 'Email routing saved.' });
    } catch (saveError) {
      onFeedback({ tone: 'error', message: toMessage(saveError, 'Failed to save email settings.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="max-w-3xl space-y-6">
      <SectionHeader
        title="Email routing"
        description="Choose who gets notified and where visitor replies go. Emails send from notifications@oyechats.com."
      />

      <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
        <div className="space-y-5">
          <div>
            <label htmlFor="reply-to" className={labelClass}>
              Reply-to address
            </label>
            <EmailChips
              id="reply-to"
              emails={replyTo}
              onChange={(next) => setReplyTo(next.slice(-1))}
              placeholder="support@yourdomain.com"
            />
            <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">
              When a visitor replies to a notification, it goes here.
            </p>
          </div>

          <div>
            <label htmlFor="recipients" className={labelClass}>
              Team recipients
            </label>
            <EmailChips
              id="recipients"
              emails={recipients}
              onChange={setRecipients}
              placeholder="team@yourdomain.com"
            />
            <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">
              Press Enter or comma to add. These addresses receive the notifications enabled below.
            </p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-[var(--ds-border)] rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-sm)]">
        {EMAIL_TOGGLES.map((toggle) => (
          <div key={toggle.key} className="flex items-center justify-between gap-4 p-5">
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-[var(--ds-text)]">{toggle.title}</p>
              <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">{toggle.description}</p>
            </div>
            <Switch
              checked={toggles[toggle.key]}
              onChange={(next) => setToggles((current) => ({ ...current, [toggle.key]: next }))}
              label={toggle.title}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save email routing'}
        </Button>
      </div>
    </form>
  );
}

// ── Status tile ───────────────────────────────────────────────────────────────

interface StatusTileProps {
  icon: typeof WebhookIcon;
  label: string;
  value: string;
  connected: boolean;
  detail: string;
}

function StatusTile({ icon: Icon, label, value, connected, detail }: StatusTileProps): ReactElement {
  return (
    <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
      <div className="flex items-center justify-between gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
          <Icon size={18} aria-hidden="true" />
        </span>
        <StatusBadge tone={connected ? 'success' : 'neutral'} dot>
          {connected ? 'Connected' : 'Not set up'}
        </StatusBadge>
      </div>
      <p className="mt-3 text-[13px] font-medium text-[var(--ds-text-muted)]">{label}</p>
      <p className="mt-0.5 text-[18px] font-bold tracking-tight text-[var(--ds-text)]">{value}</p>
      <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">{detail}</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface WebhookResult {
  botId: number;
  webhooks?: Webhook[];
  error?: string;
}

/**
 * IntegrationsPage — the Workspace ▸ Integrations surface. One job: answer
 * "What is connected?". Shows an at-a-glance status of webhooks, meeting
 * booking, and email routing for the selected agent, then lets you manage each.
 *
 * These connections are stored per agent in the backend, so the page follows
 * the active agent from the switcher.
 */
export function IntegrationsPage(): ReactElement {
  const { selectedBot, refreshBots, loading: botsLoading } = useBotContext();
  const selectedBotId = selectedBot?.id ?? null;

  const [tab, setTab] = useState<TabKey>('webhooks');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [result, setResult] = useState<WebhookResult | null>(null);

  // Load webhooks for the selected agent. No synchronous setState in the effect
  // body — the first write always follows the await, and loading is derived
  // from whether `result` matches the current agent.
  useEffect(() => {
    if (!selectedBotId) return;
    let active = true;
    void (async () => {
      try {
        const data = await getWebhooks(selectedBotId);
        if (!active) return;
        setResult({ botId: selectedBotId, webhooks: data ?? [] });
      } catch (error) {
        if (!active) return;
        setResult({ botId: selectedBotId, error: toMessage(error, 'We couldn’t load your endpoints.') });
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedBotId, refreshToken]);

  const forCurrentBot = result !== null && result.botId === selectedBotId;
  const webhooksLoading = !!selectedBotId && !forCurrentBot;
  const webhooksError = forCurrentBot ? (result?.error ?? null) : null;
  const webhooks = useMemo(
    () => (forCurrentBot && result?.webhooks ? result.webhooks : []),
    [forCurrentBot, result],
  );

  const reloadWebhooks = (): void => setRefreshToken((token) => token + 1);

  // ── Derived connection status for the overview tiles ─────────────────────────

  const settings = selectedBot ? readIntegrations(selectedBot) : null;

  const activeWebhookCount = webhooks.filter((webhook) => webhook.is_active).length;
  const meetingConnected = !!settings?.meeting_booking_enabled;
  const meetingProviderName = settings?.meeting_provider
    ? (MEETING_PROVIDERS.find((item) => item.id === settings.meeting_provider)?.name ??
      settings.meeting_provider)
    : null;
  const recipientCount = settings?.notification_emails?.default?.length ?? 0;

  // ── Render ───────────────────────────────────────────────────────────────────

  const feedbackBanner: ReactNode = (
    <div aria-live="polite" className="empty:hidden">
      {feedback && (
        <div
          className={cn(
            'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-[13px]',
            feedback.tone === 'success'
              ? 'border-[var(--ds-success)] bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
              : 'border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
          )}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="Dismiss message"
            className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );

  // No agent selected yet.
  if (!selectedBotId) {
    return (
      <PageContainer
        title="Integrations"
        description="Connect OyeChats to your CRM, calendar, and inbox."
      >
        {botsLoading ? (
          <LoadingState />
        ) : (
          <EmptyState
            icon={WebhookIcon}
            title="Pick an agent to see its connections"
            description="Integrations are configured per agent. Choose one from the switcher to view and manage what’s connected."
          />
        )}
      </PageContainer>
    );
  }

  return (
    <PageContainer
      title="Integrations"
      description="See what’s connected to this agent — and wire up your CRM, calendar, and inbox."
    >
      {feedbackBanner}

      {/* Connection overview — answers "what is connected?" at a glance. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatusTile
          icon={WebhookIcon}
          label="Webhooks"
          value={
            webhooksLoading
              ? '—'
              : `${activeWebhookCount} active`
          }
          connected={activeWebhookCount > 0}
          detail={
            webhooks.length > 0
              ? `${webhooks.length} endpoint${webhooks.length === 1 ? '' : 's'} total`
              : 'Push events to your CRM'
          }
        />
        <StatusTile
          icon={Calendar}
          label="Meeting booking"
          value={meetingConnected ? (meetingProviderName ?? 'Enabled') : 'Off'}
          connected={meetingConnected}
          detail={meetingConnected ? 'Visitors can book in chat' : 'Let visitors book a call'}
        />
        <StatusTile
          icon={Mail}
          label="Email routing"
          value={recipientCount > 0 ? `${recipientCount} recipient${recipientCount === 1 ? '' : 's'}` : 'Default'}
          connected={recipientCount > 0}
          detail={recipientCount > 0 ? 'Team notifications on' : 'Route notifications to your team'}
        />
      </div>

      <Tabs
        ariaLabel="Integration sections"
        value={tab}
        onChange={(key) => setTab(key as TabKey)}
        tabs={[
          { key: 'webhooks', label: 'Webhooks' },
          { key: 'meetings', label: 'Meetings' },
          { key: 'email', label: 'Email' },
        ]}
      />

      {/* All panels stay mounted; only the active one is visible. Hiding
          inactive panels (rather than unmounting them) preserves unsaved edits
          when the user switches tabs, and `hidden` removes them from the
          accessibility tree and tab order. */}
      <div
        role="tabpanel"
        id="tabpanel-webhooks"
        aria-labelledby="tab-webhooks"
        tabIndex={0}
        hidden={tab !== 'webhooks'}
        className="focus-visible:outline-none"
      >
        <WebhooksPanel
          webhooks={webhooks}
          loading={webhooksLoading}
          error={webhooksError}
          onReload={reloadWebhooks}
          onFeedback={setFeedback}
          botId={selectedBotId}
        />
      </div>

      {selectedBot && (
        <div
          role="tabpanel"
          id="tabpanel-meetings"
          aria-labelledby="tab-meetings"
          tabIndex={0}
          hidden={tab !== 'meetings'}
          className="focus-visible:outline-none"
        >
          <MeetingsPanel
            key={selectedBot.id}
            bot={selectedBot}
            onSaved={refreshBots}
            onFeedback={setFeedback}
          />
        </div>
      )}

      {selectedBot && (
        <div
          role="tabpanel"
          id="tabpanel-email"
          aria-labelledby="tab-email"
          tabIndex={0}
          hidden={tab !== 'email'}
          className="focus-visible:outline-none"
        >
          <EmailPanel
            key={selectedBot.id}
            bot={selectedBot}
            onSaved={refreshBots}
            onFeedback={setFeedback}
          />
        </div>
      )}
    </PageContainer>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-9 w-64 rounded-lg" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}
