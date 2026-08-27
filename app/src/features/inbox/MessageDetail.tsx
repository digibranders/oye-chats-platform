import { useMemo, useState, type ReactElement } from 'react';
import {
  Mail,
  Phone,
  Check,
  CheckCheck,
  Trash2,
  CornerUpLeft,
  MessageSquareReply,
} from 'lucide-react';
import { Button, StatusBadge, cn } from '../../design-system';
import { type CannedResponse, type OfflineMessage } from '../../types/domain';
import {
  absoluteTime,
  applyTemplate,
  buildReplyHref,
  detectSentiment,
  initials,
  sentimentBadge,
  statusBadge,
  type OfflineStatus,
} from './inboxHelpers';
import { useTranslation } from '../../i18n/useTranslation';

/** Built-in reply templates (used when the workspace has no canned responses). */
/**
 * Canned operator replies. NOT localized by the dashboard language.
 *
 * `body` is sent TO THE VISITOR. Translating it because the operator's console
 * is in Hindi would put Hindi in front of an English-speaking visitor, which is
 * the opposite of what the multilingual feature does: the visitor's language is
 * a property of their session, not of the operator's UI. `label` is chrome and
 * is resolved at the render site.
 */
// @i18n-exempt: the BODIES here are sent to the VISITOR, whose language is a
// property of their session, not of the operator's dashboard - translating them
// because the console is in Hindi would put Hindi in front of an English
// visitor. The labels are dashboard chrome and are resolved at the render site
// from `inbox.template.<label>`.
const DEFAULT_TEMPLATES: ReadonlyArray<{ label: string; body: string }> = [
  {
    label: 'Will follow up',
    body: "Hi {name},\n\nThank you for reaching out! We've received your message and will follow up with you shortly.\n\nBest regards",
  },
  {
    label: 'Sent the info',
    body: "Hi {name},\n\nThank you for your message. We've sent the information you requested - please check your inbox.\n\nBest regards",
  },
  {
    label: 'Marked resolved',
    body: "Hi {name},\n\nThank you for contacting us. Your request has been resolved. Please reach out again if there's anything else we can help with.\n\nBest regards",
  },
];

export interface MessageDetailProps {
  message: OfflineMessage;
  /** Workspace quick replies; when empty, built-in templates are shown instead. */
  cannedResponses: CannedResponse[];
  /** Persist a status change (mark read / replied). */
  onSetStatus: (status: OfflineStatus) => void;
  /** Delete this message. */
  onDelete: () => void;
  /** True while a status change is being saved. */
  savingStatus?: boolean;
  /** True while the delete request is in flight. */
  deleting?: boolean;
}

/**
 * MessageDetail - the right-hand reading pane for one offline message. Shows who
 * wrote in, their message, and the operator's next actions: mark read/replied,
 * reply by email (pre-filled with a template or workspace quick reply), or
 * delete. Opening a reply only marks the message "read" - opening a mail client
 * isn't proof an email was sent, so "replied" stays an explicit operator
 * confirmation via the "Mark as replied" button.
 */
export function MessageDetail({
  message,
  cannedResponses,
  onSetStatus,
  onDelete,
  savingStatus = false,
  deleting = false,
}: MessageDetailProps): ReactElement {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const status = statusBadge(message.status);
  const sentiment = useMemo(
    () => sentimentBadge(detectSentiment(message.message_body)),
    [message.message_body],
  );

  const name = message.visitor_name?.trim() || t('inbox.anonymousVisitor') || 'Anonymous visitor';
  const email = message.visitor_email ?? null;
  const phone = message.visitor_phone ?? null;
  const canReply = Boolean(email);

  const templates =
    cannedResponses.length > 0
      ? cannedResponses.map((c) => ({ label: c.title, body: c.content }))
      : DEFAULT_TEMPLATES;

  const isReplied = message.status === 'replied';

  function handleReply(): void {
    // Opening a mail client isn't proof an email was sent, so only advance the
    // message to "read" here. "Replied" stays an explicit operator confirmation.
    if (message.status === 'new') onSetStatus('read');
  }

  return (
    <div className="flex h-full flex-col">
      {/* Who wrote in */}
      <div className="flex items-start gap-3 border-b border-[var(--ds-border)] p-5">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[14px] font-semibold text-[var(--ds-accent-text)]"
          aria-hidden="true"
        >
          {initials(message.visitor_name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[16px] font-semibold text-[var(--ds-text)]">{name}</h2>
            <StatusBadge tone={status.tone}>
              {t(`inbox.offlineStatus.${message.status}`) || status.label}
            </StatusBadge>
            <StatusBadge tone={sentiment.tone}>
              {t(`inbox.sentiment.${detectSentiment(message.message_body)}`) || sentiment.label}
            </StatusBadge>
          </div>
          <dl className="mt-2 flex flex-col gap-1 text-[13px] text-[var(--ds-text-muted)]">
            {email && (
              <div className="flex items-center gap-2">
                <Mail size={14} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
                <dt className="sr-only">{t('inbox.email') || 'Email'}</dt>
                <dd>
                  <a
                    href={`mailto:${email}`}
                    className="underline-offset-2 hover:text-[var(--ds-text)] hover:underline"
                  >
                    {email}
                  </a>
                </dd>
              </div>
            )}
            {phone && (
              <div className="flex items-center gap-2">
                <Phone size={14} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
                <dt className="sr-only">{t('inbox.phone') || 'Phone'}</dt>
                <dd>{phone}</dd>
              </div>
            )}
          </dl>
          {message.created_at && (
            <p className="mt-1.5 text-[12px] text-[var(--ds-text-subtle)]">
              {t('inbox.receivedAt', { time: absoluteTime(message.created_at) }) ||
                `Received ${absoluteTime(message.created_at)}`}
              {message.bot_name ? ` · via ${message.bot_name}` : ''}
            </p>
          )}
        </div>
      </div>

      {/* The message */}
      <div className="flex-1 overflow-y-auto p-5">
        <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-4">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--ds-text)]">
            {message.message_body?.trim() || t('inbox.noMessageContent') || 'No message content.'}
          </p>
        </div>

        {/* Reply by email */}
        <section className="mt-6" aria-labelledby="reply-heading">
          <h3
            id="reply-heading"
            className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ds-text)]"
          >
            <MessageSquareReply
              size={15}
              aria-hidden="true"
              className="text-[var(--ds-text-subtle)]"
            />
            {cannedResponses.length > 0 ? t('inbox.replyWithAQuickResponse') || 'Reply with a quick response' : t('inbox.replyByEmail') || 'Reply by email'}
          </h3>
          {!canReply && (
            <p className="mt-1.5 text-[12px] text-[var(--ds-text-muted)]">
              {t('inbox.thisVisitorDidntLeaveAn') || 'This visitor didn’t leave an email address, so there’s no way to reply directly.'}
            </p>
          )}
          {canReply && (
            <div className="mt-3 flex flex-wrap gap-2">
              {templates.map((tpl) => {
                const href = buildReplyHref(
                  email,
                  t('inbox.reYourMessage') || 'Re: your message',
                  applyTemplate(tpl.body, message.visitor_name),
                );
                // canReply guarantees an address, so href is always present here;
                // guard defensively rather than render a dead anchor.
                if (!href) return null;
                return (
                  <a
                    key={tpl.label}
                    href={href}
                    onClick={handleReply}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-text)] transition-colors',
                      'hover:border-[var(--ds-border-strong)] hover:bg-[var(--ds-bg-hover)]',
                    )}
                  >
                    <CornerUpLeft
                      size={13}
                      aria-hidden="true"
                      className="text-[var(--ds-text-subtle)]"
                    />
                    {cannedResponses.length > 0
                      ? tpl.label
                      : t(`inbox.template.${tpl.label}`) || tpl.label}
                  </a>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--ds-border)] p-4">
        {message.status === 'new' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSetStatus('read')}
            disabled={savingStatus}
          >
            <Check size={15} aria-hidden="true" />
            {t('inbox.markAsRead') || 'Mark as read'}
          </Button>
        )}
        {!isReplied && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSetStatus('replied')}
            disabled={savingStatus}
          >
            <CheckCheck size={15} aria-hidden="true" />
            {t('inbox.markAsReplied') || 'Mark as replied'}
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {confirmingDelete ? (
            <>
              <span className="text-[12px] text-[var(--ds-text-muted)]">{t('inbox.deletePermanently') || 'Delete permanently?'}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
              >
                {t('inbox.cancel') || 'Cancel'}
              </Button>
              <Button variant="danger" size="sm" onClick={onDelete} disabled={deleting}>
                {deleting ? t('inbox.deleting') || 'Deleting…' : t('inbox.delete') || 'Delete'}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              aria-label={t('inbox.deleteMessage') || 'Delete message'}
            >
              <Trash2 size={15} aria-hidden="true" />
              {t('inbox.delete') || 'Delete'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
