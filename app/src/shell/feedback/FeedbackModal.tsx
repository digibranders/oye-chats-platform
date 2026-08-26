import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
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
  RefreshCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  cn,
  EmptyState,
  Modal,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  type StatusBadgeProps,
} from '../../design-system';
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

/** An attachment being composed on the Send tab - local until uploaded. */
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
const SEVERITY_LABELS: Record<string, string> = Object.fromEntries(SEVERITIES.map((s) => [s.id, s.label]));

const STATUS_META: Record<
  PlatformFeedbackItem['status'],
  { label: string; tone: NonNullable<StatusBadgeProps['tone']>; icon: LucideIcon; spin?: boolean }
> = {
  open: { label: 'Open', tone: 'warning', icon: Clock },
  in_progress: { label: 'In progress', tone: 'accent', icon: Loader2, spin: true },
  resolved: { label: 'Resolved', tone: 'success', icon: CheckCircle2 },
  closed: { label: 'Closed', tone: 'neutral', icon: Archive },
};

const SEVERITY_TONE: Record<FeedbackSeverityId, NonNullable<StatusBadgeProps['tone']>> = {
  low: 'neutral',
  medium: 'accent',
  high: 'warning',
  critical: 'danger',
};

/** ISO timestamp → "Jul 16, 2026", or "" if absent/invalid. */
function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function MetaPill({ children }: { children: ReactElement | string }): ReactElement {
  return (
    <span className="rounded-full bg-[var(--ds-bg-sunken)] px-2 py-0.5 text-[11px] text-[var(--ds-text-muted)]">
      {children}
    </span>
  );
}

function AttachmentThumbs({
  attachments,
}: {
  attachments: PlatformFeedbackAttachment[] | null;
}): ReactElement | null {
  if (!attachments?.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((att, index) => (
        <a
          key={att.url || index}
          href={att.url}
          target="_blank"
          rel="noopener noreferrer"
          title={att.name || 'Attachment'}
          className="relative h-16 w-16 shrink-0 overflow-hidden rounded-[var(--ds-radius-md)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]"
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
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <AlertCircle size={22} className="text-[var(--ds-danger)]" aria-hidden="true" />
        <p className="mt-3 text-sm text-[var(--ds-text-muted)]">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()} className="mt-4">
          <RefreshCw size={13} aria-hidden="true" />
          {t('settings.page.tryAgain') || 'Try again'}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title={t('shell.feedbackModal.emptyTitle') || 'No feedback yet'}
        description="Once you send feedback, you'll see its status and our response here."
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
              'rounded-[var(--ds-radius-lg)] border bg-[var(--ds-bg-surface)] p-4',
              highlightId === item.id ? 'border-[var(--ds-accent)] shadow-[0_0_0_1px_var(--ds-ring)]' : 'border-[var(--ds-border)]',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <StatusBadge tone={meta.tone}>
                  <StatusIcon size={11} className={meta.spin ? 'animate-spin' : ''} aria-hidden="true" />
                  {t(`shell.feedbackModal.statuses.${item.status}`) || meta.label}
                </StatusBadge>
                {item.type && (
                  <MetaPill>
                    {t(`shell.feedbackModal.types.${item.type}`) || TYPE_LABELS[item.type] || item.type}
                  </MetaPill>
                )}
                {item.area && (
                  <MetaPill>
                    {t(`shell.feedbackModal.areas.${item.area}`) || AREA_LABELS[item.area] || item.area}
                  </MetaPill>
                )}
                {item.severity && (
                  <StatusBadge tone={SEVERITY_TONE[item.severity]}>
                    {t(`shell.feedbackModal.severities.${item.severity}`) ||
                      SEVERITY_LABELS[item.severity] ||
                      item.severity}
                  </StatusBadge>
                )}
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-text-subtle)]">
                {formatDate(item.created_at)}
              </span>
            </div>

            <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ds-text)]">
              {item.message}
            </p>

            <AttachmentThumbs attachments={item.attachments} />

            {item.admin_response && (
              <div className="mt-3 rounded-[var(--ds-radius-md)] border border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-accent-text)]">
                  <MessageSquare size={11} aria-hidden="true" />
                  {t('shell.feedbackModal.response') || 'Response from OyeChats'}
                </p>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ds-text)]">
                  {item.admin_response}
                </p>
                {item.resolved_at && (
                  <p className="mt-2 text-[11px] tabular-nums text-[var(--ds-text-subtle)]">
                    {t('shell.feedbackModal.resolvedAt', { date: formatDate(item.resolved_at) }) ||
                      `Resolved ${formatDate(item.resolved_at)}`}
                  </p>
                )}
              </div>
            )}
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
 * FeedbackModal - the admin → OyeChats product-feedback dialog (mandate DS
 * component, built on the `Modal` primitive). Two tabs: compose new feedback
 * (type/area/severity/message/screenshots) and track the status of feedback
 * already sent. Ported 1:1 in behavior from the legacy `components/FeedbackModal.jsx`.
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
  // Mirror the latest attachments in a ref so the unmount-only cleanup effect
  // revokes the URLs actually held at unmount - not the empty mount-render
  // array it would otherwise close over (leaking every preview URL on a
  // close-without-submit).
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uidRef = useRef(0);
  const typeButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const addFiles = useCallback((files: FileList | File[] | null): void => {
    const incoming = Array.from(files ?? []);
    if (incoming.length === 0) return;
    setFormError('');

    setAttachments((prev) => {
      const slots = MAX_ATTACHMENTS - prev.length;
      if (slots <= 0) {
        setFormError(`You can attach up to ${MAX_ATTACHMENTS} screenshots.`);
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

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    addFiles(event.target.files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Paste-anywhere: a document-level listener active only while the modal is
  // open and on the compose tab catches screenshots regardless of focus.
  useEffect(() => {
    if (!open || activeTab !== 'send') return undefined;
    const onPaste = (event: ClipboardEvent): void => {
      const imageFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
        .map((file, index) => new File([file], file.name || `screenshot_${Date.now()}_${index}.png`, { type: file.type }));
      if (imageFiles.length > 0) {
        event.preventDefault();
        addFiles(imageFiles);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [open, activeTab, addFiles]);

  // Revoke any object URLs still held when the modal unmounts. Reads through
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

  const selectedTypeIndex = TYPES.findIndex((t) => t.id === type);
  const typeFocusIndex = selectedTypeIndex >= 0 ? selectedTypeIndex : 0;

  function focusType(index: number): void {
    const option = TYPES[index];
    if (!option) return;
    typeButtonRefs.current[index]?.focus();
    setType(option.id);
  }

  function handleTypeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    const count = TYPES.length;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusType((index + 1) % count);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusType((index - 1 + count) % count);
    }
  }

  const tabs = [
    { key: 'send', label: t('shell.feedbackModal.tabSend') || 'Send feedback' },
    { key: 'mine', label: t('shell.feedbackModal.tabMine') || 'My feedback' },
  ] as const;

  const description =
    activeTab === 'send'
      ? t('shell.feedbackModal.descSend') || "We'd love to hear your thoughts and help us improve OyeChats."
      : t('shell.feedbackModal.descMine') || 'Track the status of feedback you’ve sent and read our responses.';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('shell.feedbackModal.title') || 'Feedback'}
      description={description}
      size="md"
      footer={
        activeTab === 'send' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  {t('shell.feedback.sending') || 'Sending…'}
                </>
              ) : uploading ? (
                'Uploading…'
              ) : (
                <>
                  {t('shell.feedbackModal.submit') || 'Send feedback'}
                  <ArrowRight size={14} aria-hidden="true" />
                </>
              )}
            </Button>
          </>
        ) : undefined
      }
    >
      <Tabs
        tabs={tabs}
        value={activeTab}
        onChange={(key) => setActiveTab(key as FeedbackTab)}
        ariaLabel="Feedback"
        className="mb-5"
      />

      <div role="tabpanel" id={`tabpanel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'send' ? (
          <div className="space-y-5">
            {/* Type (required) */}
            <div className="space-y-2.5">
              <label className="block text-[13px] font-semibold text-[var(--ds-text)]">
                {t('shell.feedbackModal.typeQuestion') || 'What type of feedback is this?'}{' '}
                <span className="font-normal text-[var(--ds-text-subtle)]">
                  {t('shell.feedbackModal.required') || '(required)'}
                </span>
              </label>
              <div role="radiogroup" aria-label={t('shell.feedbackModal.typeLabel') || 'Feedback type'} className="flex flex-wrap gap-2">
                {TYPES.map((option, index) => {
                  const Icon = option.icon;
                  const selected = type === option.id;
                  const focusable = index === typeFocusIndex;
                  return (
                    <button
                      key={option.id}
                      ref={(node) => {
                        typeButtonRefs.current[index] = node;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={focusable ? 0 : -1}
                      onClick={() => setType(option.id)}
                      onKeyDown={(event) => handleTypeKeyDown(event, index)}
                      className={cn(
                        'flex items-center gap-2 rounded-[var(--ds-radius-lg)] border px-3.5 py-2.5 text-xs font-medium transition-colors',
                        'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                        selected
                          ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] text-[var(--ds-text)]'
                          : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)]',
                      )}
                    >
                      <Icon size={14} className={selected ? 'text-[var(--ds-accent-text)]' : 'text-[var(--ds-text-subtle)]'} aria-hidden="true" />
                      {t(`shell.feedbackModal.types.${option.id}`) || option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Area (optional) */}
            <div className="space-y-2">
              <label htmlFor="fb-area" className="block text-[13px] font-semibold text-[var(--ds-text)]">
                {t('shell.feedbackModal.area') || 'Area'}{' '}
                <span className="font-normal text-[var(--ds-text-subtle)]">
                  {t('shell.feedbackModal.optional') || '(optional)'}
                </span>
              </label>
              <Select
                id="fb-area"
                value={area}
                onChange={(next) => setArea(next as FeedbackAreaId | '')}
                placeholder={t('shell.feedbackModal.areaUnset') || 'Not sure / unspecified'}
                options={[
                  { value: '', label: 'Not sure / unspecified' },
                  ...AREAS.map((option) => ({
                    value: option.id,
                    label: t(`shell.feedbackModal.areas.${option.id}`) || option.label,
                  })),
                ]}
              />
            </div>

            {/* Severity (bug-only) */}
            {type === 'bug' && (
              <div className="space-y-2">
                <label className="block text-[13px] font-semibold text-[var(--ds-text)]">
                  {t('shell.feedbackModal.severity') || 'Severity'}{' '}
                  <span className="font-normal text-[var(--ds-text-subtle)]">
                    {t('shell.feedbackModal.optional') || '(optional)'}
                  </span>
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {SEVERITIES.map((option) => {
                    const selected = severity === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSeverity(selected ? null : option.id)}
                        className={cn(
                          'h-9 rounded-[var(--ds-radius-md)] border text-center text-[12px] font-medium transition-colors',
                          'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                          selected
                            ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] text-[var(--ds-text)]'
                            : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)]',
                        )}
                      >
                        {t(`shell.feedbackModal.severities.${option.id}`) || option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Message + attachments */}
            <div className="space-y-2">
              <label htmlFor="fb-message" className="block text-[13px] font-semibold text-[var(--ds-text)]">
                {t('shell.feedbackModal.describe') || 'Describe your feedback'}{' '}
                <span className="font-normal text-[var(--ds-text-subtle)]">
                  {t('shell.feedbackModal.required') || '(required)'}
                </span>
              </label>
              <div className="overflow-hidden rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] transition-colors focus-within:border-[var(--ds-accent)] focus-within:shadow-[0_0_0_1px_var(--ds-ring)]">
                <Textarea
                  id="fb-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={
                  t('shell.feedbackModal.describePlaceholder') ||
                  'What happened or what would you like to see? Paste a screenshot anywhere in this dialog to attach it.'
                }
                  className="h-32 rounded-none border-0 shadow-none focus-visible:shadow-none"
                  autoFocus
                />

                <div className="space-y-2.5 border-t border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      accept="image/*"
                      multiple
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attachments.length >= MAX_ATTACHMENTS}
                      className="inline-flex h-8 items-center gap-1.5 rounded-[var(--ds-radius-md)] px-2.5 text-[12px] text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] disabled:cursor-not-allowed disabled:opacity-40"
                      title={
                    t('shell.feedbackModal.attachHint') ||
                    'Attach screenshots or paste from clipboard (max 5, 10MB each)'
                  }
                    >
                      <ImagePlus size={15} aria-hidden="true" />
                      {t('shell.feedbackModal.addScreenshot') || 'Add screenshot'}
                    </button>
                    <span className="text-[11px] text-[var(--ds-text-subtle)]">or paste from clipboard</span>
                  </div>

                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((att) => (
                        <div
                          key={att.id}
                          className="group relative h-16 w-16 overflow-hidden rounded-[var(--ds-radius-md)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]"
                        >
                                          <img src={att.previewUrl} alt={att.name} className="h-full w-full object-cover" />
                          {att.status === 'uploading' && (
                            <div className="absolute inset-0 flex items-center justify-center bg-[var(--ds-overlay)]">
                              <Loader2 size={16} className="animate-spin text-white" aria-hidden="true" />
                            </div>
                          )}
                          {att.status === 'error' && (
                            <div
                              className="absolute inset-0 flex items-center justify-center bg-[var(--ds-danger-soft)]"
                              title={t('shell.feedbackModal.uploadFailed') || 'Upload failed'}
                            >
                              <AlertCircle size={16} className="text-[var(--ds-danger)]" aria-hidden="true" />
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => removeAttachment(att.id)}
                            aria-label={`Remove ${att.name}`}
                            className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity hover:bg-[var(--ds-danger)] group-hover:opacity-100"
                          >
                            <X size={11} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {formError && (
              <div className="flex items-center gap-2 rounded-[var(--ds-radius-lg)] border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] p-3 text-xs text-[var(--ds-danger)]">
                <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
                <span>{formError}</span>
              </div>
            )}

            {/* Privacy note */}
            <div className="flex items-start gap-2.5 px-0.5">
              <Info size={16} className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-[var(--ds-text-muted)]">
                {t('shell.feedbackModal.noSecrets') ||
                'Don’t include passwords, API keys, or any sensitive information.'}
                <br />
                {t('shell.feedbackModal.weAttach') ||
                'We attach your current page, app version, plan, and browser to help us triage.'}
              </p>
            </div>
          </div>
        ) : (
          <MyFeedbackList highlightId={highlightId} />
        )}
      </div>
    </Modal>
  );
}
