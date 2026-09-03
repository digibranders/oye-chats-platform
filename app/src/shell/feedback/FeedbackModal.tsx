import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { useLocation } from 'react-router-dom';
import {
  AlertCircle,
  Archive,
  ArrowRight,
  Bug,
  CheckCircle2,
  Clock,
  HelpCircle,
  ImagePlus,
  Inbox,
  Info,
  Lightbulb,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Alert,
  Badge,
  type BadgeTone,
  Button,
  cn,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  formatDate,
  Select,
  Skeleton,
  Tabs,
  TabPanel,
  Textarea,
} from '../../ui';
import { useFieldGroupProps } from '../../ui/primitives/fieldContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import {
  getMyFeedback,
  submitPlatformFeedback,
  uploadFeedbackAttachment,
  type PlatformFeedbackAttachment,
  type PlatformFeedbackItem,
} from '../../services/api';
// `translateNow` rather than the hook's `t` inside callbacks: the hook's
// identity changes per locale, which both breaks the compiler's memoization
// analysis and adds a dependency for no gain. The module-level function is
// stable AND resolves against the current locale when it is called.
import { t as translateNow } from '../../i18n/i18n';
import { useTranslation } from '../../i18n/useTranslation';

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

export type FeedbackTab = 'send' | 'mine';
type FeedbackTypeId = 'bug' | 'feature_request' | 'question' | 'other';
type FeedbackAreaId = 'billing' | 'bots' | 'knowledge' | 'live_chat' | 'dashboard' | 'widget' | 'other';
type FeedbackSeverityId = 'low' | 'medium' | 'high' | 'critical';

export interface FeedbackModalProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: FeedbackTab;
  /** Row id to highlight on the My-feedback tab (from the resolved-notification deep-link). */
  highlightId?: number | null;
}

/** An attachment being composed on the Send tab — local until uploaded. */
interface ComposeAttachment {
  readonly id: number;
  name: string;
  content_type: string;
  previewUrl: string;
  url: string | null;
  status: 'uploading' | 'done' | 'error';
}

const TYPES: ReadonlyArray<{ id: FeedbackTypeId; label: string; icon: LucideIcon }> = [
  { id: 'bug', label: 'Bug', icon: Bug },
  { id: 'feature_request', label: 'Feature', icon: Lightbulb },
  { id: 'question', label: 'Question', icon: HelpCircle },
  { id: 'other', label: 'Other', icon: MoreHorizontal },
];

const AREAS: ReadonlyArray<{ id: FeedbackAreaId; label: string }> = [
  { id: 'billing', label: 'Billing' },
  { id: 'bots', label: 'Chatbots' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'live_chat', label: 'Live chat' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'widget', label: 'Widget' },
  { id: 'other', label: 'Other' },
];

const SEVERITIES: ReadonlyArray<{ id: FeedbackSeverityId; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'critical', label: 'Critical' },
];

const TYPE_LABELS: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));
const AREA_LABELS: Record<string, string> = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));
const SEVERITY_LABELS: Record<string, string> = Object.fromEntries(
  SEVERITIES.map((s) => [s.id, s.label]),
);

/**
 * No `accent` tone here on purpose — `Badge`'s own vocabulary deliberately has
 * none. "In progress" is carried by the spinning `Loader2` inside the badge,
 * not by a sixth colour.
 */
// @i18n-exempt: the labels below are FALLBACKS, not the rendered copy. Every
// read of this table goes through `optionLabel('status', id, meta.label)`,
// which resolves `shell.feedback.status.<id>` first. The table is a module
// constant evaluated before any locale exists, so it cannot resolve one itself.
const STATUS_META: Record<
  PlatformFeedbackItem['status'],
  { label: string; tone: BadgeTone; icon: LucideIcon; spin?: boolean }
> = {
  open: { label: 'Open', tone: 'warning', icon: Clock },
  in_progress: { label: 'In progress', tone: 'neutral', icon: Loader2, spin: true },
  resolved: { label: 'Resolved', tone: 'success', icon: CheckCircle2 },
  closed: { label: 'Closed', tone: 'neutral', icon: Archive },
};

/**
 * A feedback option label in the reader's language.
 *
 * The tables above are module constants evaluated at import, before any locale
 * exists, so they cannot resolve a translation themselves. The `id` is the
 * stable key - it is what the API stores and what the backend filters on - and
 * it is never translated; only the label the reader sees is.
 */
function optionLabel(group: string, id: string, fallback: string): string {
  return translateNow(`shell.feedback.${group}.${id}`) || fallback;
}

const SEVERITY_TONE: Record<FeedbackSeverityId, BadgeTone> = {
  low: 'neutral',
  medium: 'neutral',
  high: 'warning',
  critical: 'danger',
};

function MetaPill({ children }: { children: ReactElement | string }): ReactElement {
  return (
    <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-2xs text-text-secondary">
      {children}
    </span>
  );
}

function AttachmentThumbs({
  attachments,
}: {
  attachments: PlatformFeedbackAttachment[] | null;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!attachments?.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((att, index) => (
        <a
          key={att.url || index}
          href={att.url}
          target="_blank"
          rel="noopener noreferrer"
          title={att.name || t('shell.attachment') || 'Attachment'}
          className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-surface-sunken"
        >
          <img src={att.url} alt={att.name || 'attachment'} className="h-full w-full object-cover" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

interface MyFeedbackListProps {
  highlightId: number | null;
}

/** The "My feedback" tab body: fetches and renders the caller's own submissions. */
function MyFeedbackList({ highlightId }: MyFeedbackListProps): ReactElement {
  const { t } = useTranslation();
  const [items, setItems] = useState<PlatformFeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const data = await getMyFeedback();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : translateNow('shell.feedbackModal.loadFailed') || 'Failed to load your feedback.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-2.5">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return <ErrorState size="panel" description={error} onRetry={() => void load()} />;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        size="panel"
        icon={Inbox}
        title={t('shell.feedbackModal.emptyTitle') || 'No feedback yet'}
        description={t('shell.onceYouSendFeedbackYoull') || 'Once you send feedback, you\'ll see its status and our response here.'}
      />
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => {
        const meta = STATUS_META[item.status];
        const StatusIcon = meta.icon;
        return (
          <li
            key={item.id}
            className={cn(
              'rounded-lg border bg-surface p-4',
              highlightId === item.id ? 'border-accent-500 shadow-[0_0_0_1px_var(--color-accent-500)]' : 'border-border',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge tone={meta.tone}>
                  <StatusIcon aria-hidden className={cn('h-icon-sm w-icon-sm', meta.spin && 'animate-spin')} />
                  {optionLabel('status', item.status, meta.label)}
                </Badge>
                {item.type ? <MetaPill>{optionLabel('type', item.type, TYPE_LABELS[item.type] ?? item.type)}</MetaPill> : null}
                {item.area ? <MetaPill>{optionLabel('area', item.area, AREA_LABELS[item.area] ?? item.area)}</MetaPill> : null}
                {item.severity ? (
                  <Badge tone={SEVERITY_TONE[item.severity]}>
                    {optionLabel('severity', item.severity, SEVERITY_LABELS[item.severity] ?? item.severity)}
                  </Badge>
                ) : null}
              </div>
              <span className="figure shrink-0 text-2xs text-text-tertiary">
                {formatDate(item.created_at)}
              </span>
            </div>

            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-text-primary">
              {item.message}
            </p>

            <AttachmentThumbs attachments={item.attachments} />

            {item.admin_response ? (
              <div className="mt-3 rounded-md border border-accent-500 bg-accent-50 p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-eyebrow text-accent-700">
                  <MessageSquare aria-hidden className="h-icon-sm w-icon-sm" />
                  {t('shell.responseFromOyechats') || 'Response from OyeChats'}
                </p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">
                  {item.admin_response}
                </p>
                {item.resolved_at ? (
                  <p className="figure mt-2 text-2xs text-text-tertiary">
                    {translateNow('shell.resolvedOn', { date: formatDate(item.resolved_at) }) ||
                      `Resolved ${formatDate(item.resolved_at)}`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Build the auto-captured diagnostic context attached to every submission. */
function buildContext(pathname: string, search: string, planName: string): Record<string, unknown> {
  return {
    page_url: `${pathname}${search}`,
    app_version: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'unknown',
    plan_tier: planName || undefined,
    user_agent: navigator.userAgent,
  };
}

/**
 * A required, initially-unselected choice of a handful of icon-and-word
 * options — what `RadioCards` is for a longer sentence and `SegmentedControl`
 * is for a filter that is always active. Neither fits a value that starts
 * `null`, so this is the console's third radiogroup, built the same way as
 * the other two: one tab stop, arrow keys inside it, and a real ARIA name it
 * takes from the surrounding `Field`.
 */
function TypePicker({
  value,
  onChange,
}: {
  value: FeedbackTypeId | null;
  onChange: (value: FeedbackTypeId) => void;
}): ReactElement {
  const group = useFieldGroupProps();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIndex = Math.max(
    TYPES.findIndex((t) => t.id === value),
    0,
  );

  function focus(index: number): void {
    const option = TYPES[index];
    if (!option) return;
    refs.current[index]?.focus();
    onChange(option.id);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focus((index + 1) % TYPES.length);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focus((index - 1 + TYPES.length) % TYPES.length);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={group['aria-labelledby']}
      aria-describedby={group['aria-describedby']}
      className="flex flex-wrap gap-2"
    >
      {TYPES.map((option, index) => {
        const Icon = option.icon;
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'flex items-center gap-2 rounded-md border px-3.5 py-2.5 text-xs font-medium transition-colors',
              selected
                ? 'border-accent-500 bg-accent-50 text-text-primary shadow-[inset_0_0_0_1px_var(--color-accent-500)]'
                : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-hover',
            )}
          >
            <Icon aria-hidden className={cn('h-icon-sm w-icon-sm', selected ? 'text-accent-600' : 'text-text-tertiary')} />
            {optionLabel('type', option.id, option.label)}
          </button>
        );
      })}
    </div>
  );
}

/** An optional, deselectable choice — click the selected pill again for "unset". */
function SeverityPicker({
  value,
  onChange,
}: {
  value: FeedbackSeverityId | null;
  onChange: (value: FeedbackSeverityId | null) => void;
}): ReactElement {
  return (
    <div className="grid grid-cols-4 gap-2">
      {SEVERITIES.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? null : option.id)}
            className={cn(
              'h-control-md rounded-md border text-center text-xs font-medium transition-colors',
              selected
                ? 'border-accent-500 bg-accent-50 text-text-primary shadow-[inset_0_0_0_1px_var(--color-accent-500)]'
                : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-hover',
            )}
          >
            {optionLabel('severity', option.id, option.label)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The admin → OyeChats product-feedback dialog. Two tabs: compose new
 * feedback (type, area, severity, message, screenshots) and track feedback
 * already sent.
 */
export function FeedbackModal({
  open,
  onClose,
  defaultTab = 'send',
  highlightId = null,
}: FeedbackModalProps): ReactElement | null {
  const { t } = useTranslation();
  const location = useLocation();
  const { planName } = useEntitlements();

  const [activeTab, setActiveTab] = useState<FeedbackTab>(defaultTab);
  const [message, setMessage] = useState('');
  const [type, setType] = useState<FeedbackTypeId | null>(null);
  const [area, setArea] = useState<FeedbackAreaId | ''>('');
  const [severity, setSeverity] = useState<FeedbackSeverityId | null>(null);
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Mirrors the latest attachments so the unmount-only cleanup effect revokes
  // whatever is actually held at unmount, not the empty mount-render array it
  // would otherwise close over — which leaked every preview URL on a
  // close-without-submit.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uidRef = useRef(0);

  const addFiles = useCallback((files: FileList | File[] | null): void => {
    const incoming = Array.from(files ?? []);
    if (incoming.length === 0) return;
    setFormError('');

    setAttachments((prev) => {
      const slots = MAX_ATTACHMENTS - prev.length;
      if (slots <= 0) {
        setFormError(
        translateNow('shell.feedback.maxAttachments', { count: MAX_ATTACHMENTS }) ||
          `You can attach up to ${MAX_ATTACHMENTS} screenshots.`,
      );
        return prev;
      }
      const accepted: ComposeAttachment[] = [];
      for (const file of incoming.slice(0, slots)) {
        if (file.size > MAX_ATTACHMENT_SIZE) {
          setFormError(translateNow('shell.feedbackModal.fileTooLarge') || 'Each file must be 10MB or smaller.');
          continue;
        }
        const id = (uidRef.current += 1);
        const entry: ComposeAttachment = {
          id,
          name: file.name,
          content_type: file.type,
          previewUrl: URL.createObjectURL(file),
          url: null,
          status: 'uploading',
        };
        accepted.push(entry);
        uploadFeedbackAttachment(file)
          .then((res) => {
            setAttachments((cur) => cur.map((a) => (a.id === id ? { ...a, url: res.url, status: 'done' } : a)));
          })
          .catch(() => {
            setAttachments((cur) => cur.map((a) => (a.id === id ? { ...a, status: 'error' } : a)));
          });
      }
      return [...prev, ...accepted];
    });
  }, []);

  const removeAttachment = useCallback((id: number): void => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Paste-anywhere: a document-level listener active only while the modal is
  // open and on the compose tab catches screenshots regardless of focus.
  useEffect(() => {
    if (!open || activeTab !== 'send') return undefined;
    const onPaste = (event: ClipboardEvent): void => {
      const imageFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
        .map(
          (file, index) =>
            new File([file], file.name || `screenshot_${Date.now()}_${index}.png`, { type: file.type }),
        );
      if (imageFiles.length > 0) {
        event.preventDefault();
        addFiles(imageFiles);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [open, activeTab, addFiles]);

  // Revokes any object URLs still held when the modal unmounts. Reads through
  // the ref so it revokes whatever attachments exist at unmount, not the
  // mount-render snapshot.
  useEffect(
    () => () => {
      attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    },
    [],
  );

  if (!open) return null;

  const uploading = attachments.some((a) => a.status === 'uploading');
  const canSubmit = message.trim().length > 0 && type !== null && !isSubmitting && !uploading;

  const resetForm = (): void => {
    attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    setMessage('');
    setType(null);
    setArea('');
    setSeverity(null);
    setAttachments([]);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit || type === null) return;
    setIsSubmitting(true);
    setFormError('');
    try {
      const doneAttachments = attachments
        .filter((a): a is ComposeAttachment & { url: string } => a.status === 'done' && a.url !== null)
        .map((a) => ({ url: a.url, name: a.name, content_type: a.content_type }));

      await submitPlatformFeedback({
        message,
        type,
        area: area || null,
        severity: type === 'bug' ? severity : null,
        context: buildContext(location.pathname, location.search, planName),
        attachments: doneAttachments,
      });
      resetForm();
      setActiveTab('mine');
    } catch (err) {
      console.error('Failed to submit feedback:', err);
      setFormError(translateNow('shell.feedbackModal.submitFailed') || 'Failed to submit feedback. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const description =
    activeTab === 'send'
      ? t('shell.feedbackModal.descSend') || "We'd love to hear your thoughts and help us improve OyeChats."
      : t('shell.feedbackModal.descMine') || 'Track the status of feedback you’ve sent and read our responses.';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('shell.feedbackTitle') || 'Feedback'}
      description={description}
      size="md"
      footer={
        activeTab === 'send' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={!canSubmit} loading={isSubmitting}>
              {uploading && !isSubmitting ? (
                t('shell.uploading') || 'Uploading…'
              ) : (
                <>
                  {t('shell.sendFeedback') || 'Send feedback'}
                  <ArrowRight aria-hidden className="h-icon-sm w-icon-sm" />
                </>
              )}
            </Button>
          </>
        ) : undefined
      }
    >
      <Tabs
        label={t('shell.feedbackTitle') || 'Feedback'}
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as FeedbackTab)}
        items={[
          { value: 'send', label: t('shell.sendFeedback') || 'Send feedback' },
          { value: 'mine', label: t('shell.myFeedback') || 'My feedback' },
        ]}
      >
        <TabPanel value="send" className="pt-5">
          <div className="space-y-5">
            <Field label={t('shell.whatTypeOfFeedbackIs') || 'What type of feedback is this?'} required>
              <TypePicker value={type} onChange={setType} />
            </Field>

            <Field label={t('shell.area') || 'Area'} optional>
              <Select
                label={t('shell.area') || 'Area'}
                value={area}
                onValueChange={(next) => setArea(next as FeedbackAreaId | '')}
                emptyOption="Not sure / unspecified"
                options={AREAS.map((option) => ({ value: option.id, label: option.label }))}
              />
            </Field>

            {type === 'bug' ? (
              <Field label={t('shell.severity') || 'Severity'} optional>
                <SeverityPicker value={severity} onChange={setSeverity} />
              </Field>
            ) : null}

            <Field label={t('shell.describeYourFeedback') || 'Describe your feedback'} required>
              <div className="overflow-hidden rounded-md border border-border-strong bg-surface transition-colors focus-within:border-accent-500 focus-within:shadow-[0_0_0_1px_var(--color-accent-500)]">
                <Textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={
                  t('shell.feedbackModal.describePlaceholder') ||
                  'What happened or what would you like to see? Paste a screenshot anywhere in this dialog to attach it.'
                }
                  className="h-32 rounded-none border-0 shadow-none focus-visible:shadow-none"
                  autoFocus
                />

                <div className="space-y-2.5 border-t border-border bg-surface-sunken px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={(event) => {
                        addFiles(event.target.files);
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                      accept="image/*"
                      multiple
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attachments.length >= MAX_ATTACHMENTS}
                      className="inline-flex h-control-sm items-center gap-1.5 rounded-md px-2.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:bg-transparent"
                      title={t('shell.attachScreenshotsOrPasteFrom') || 'Attach screenshots or paste from clipboard (max 5, 10MB each)'}
                    >
                      <ImagePlus aria-hidden className="h-icon-sm w-icon-sm" />
                      {t('shell.addScreenshot') || 'Add screenshot'}
                    </button>
                    <span className="text-2xs text-text-tertiary">{t('shell.orPasteFromClipboard') || 'or paste from clipboard'}</span>
                  </div>

                  {attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((att) => (
                        <div
                          key={att.id}
                          className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-surface-sunken"
                        >
                          <img src={att.previewUrl} alt={att.name} className="h-full w-full object-cover" />
                          {att.status === 'uploading' ? (
                            <div className="absolute inset-0 flex items-center justify-center bg-overlay">
                              <Loader2 aria-hidden className="h-icon-sm w-icon-sm animate-spin text-text-inverse" />
                            </div>
                          ) : null}
                          {att.status === 'error' ? (
                            <div
                              className="absolute inset-0 flex items-center justify-center bg-danger-tint"
                              title={t('shell.uploadFailed') || 'Upload failed'}
                            >
                              <AlertCircle aria-hidden className="h-icon-sm w-icon-sm text-danger" />
                            </div>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => removeAttachment(att.id)}
                            aria-label={`Remove ${att.name}`}
                            className="absolute end-0.5 top-0.5 rounded-full bg-ink/60 p-0.5 text-text-inverse opacity-0 transition-opacity hover:bg-danger group-hover:opacity-100"
                          >
                            <X aria-hidden className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </Field>

            {formError ? (
              <Alert tone="danger" live>
                {formError}
              </Alert>
            ) : null}

            <div className="flex items-start gap-2.5 px-0.5">
              <Info aria-hidden className="mt-0.5 h-icon-sm w-icon-sm shrink-0 text-text-tertiary" />
              <p className="text-xs leading-relaxed text-text-secondary">
                {t('shell.dontIncludePasswordsApiKeys') || 'Don\'t include passwords, API keys, or any sensitive information.'}
                <br />
                {t('shell.feedbackModal.weAttach') ||
                'We attach your current page, app version, plan, and browser to help us triage.'}
              </p>
            </div>
          </div>
        </TabPanel>

        <TabPanel value="mine" className="pt-5">
          <MyFeedbackList highlightId={highlightId} />
        </TabPanel>
      </Tabs>
    </Dialog>
  );
}
