import { useMemo, useState } from 'react';
import { Check, Mail, Trash2 } from 'lucide-react';
import {
  ABSENT,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DefinitionList,
  PaneHeader,
  Select,
  Textarea,
  buttonClass,
  formatDateTime,
  toast,
} from '../../ui';
import type { CannedResponse, OfflineMessage } from '../../types/domain';
import type { OfflineStatus } from './inboxModel';
import { useTranslation } from '../../i18n/useTranslation';

export interface MessagePaneProps {
  message: OfflineMessage;
  snippets: CannedResponse[];
  onManageSnippets: () => void;
  onStatusChange: (id: number, status: OfflineStatus) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

/** Substitute `{name}` in a saved reply with the visitor's first name. */
function applyTemplate(body: string, visitorName: string | null | undefined): string {
  const first = (visitorName ?? '').trim().split(/\s+/)[0] || 'there';
  return body.replace(/\{name\}/g, first);
}

/** The picker's last option, which opens the manager rather than inserting. */
const MANAGE_OPTION = '__manage__';

const STATUS_TONE = {
  new: 'warning',
  read: 'neutral',
  replied: 'success',
} as const;

/**
 * A message left while nobody was online.
 *
 * The honest shape for this record: there is no send-mail endpoint behind it, so
 * the reply opens in the operator's own mail client with the visitor's message
 * quoted, and the status change says exactly that. The screen this replaces
 * implied the reply was sent from here and then only changed a status field.
 */
export function MessagePane({
  message,
  snippets,
  onManageSnippets,
  onStatusChange,
  onDelete,
}: MessagePaneProps) {
  const { t } = useTranslation();
  const name = message.visitor_name?.trim() || message.visitor_email?.trim() || t('inbox.visitor') || 'Visitor';
  const status = ((message.status ?? 'new').toLowerCase() as OfflineStatus) ?? 'new';
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mailto = useMemo(() => {
    if (!message.visitor_email) return null;
    const subject = `Re: your message${message.bot_name ? ` about ${message.bot_name}` : ''}`;
    const quoted = `\n\n---\nYou wrote:\n${message.message_body ?? ''}`;
    return `mailto:${message.visitor_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
      `${reply}${quoted}`,
    )}`;
  }, [message.visitor_email, message.bot_name, message.message_body, reply]);

  async function setStatus(next: OfflineStatus): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onStatusChange(message.id, next);
    } catch (err) {
      setError(
        err instanceof Error ? `Could not update this message: ${err.message}` : t('inbox.couldNotUpdateThisMessage2') || 'Could not update this message.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={`Message from ${name}`} className="flex h-full min-h-0 flex-col bg-canvas">
      <PaneHeader
        titleAs="h2"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Avatar size="md" name={name} className="shrink-0" />
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{name}</span>
                <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
                  {status === 'new' ? t('inbox.new') || 'New' : status === 'read' ? t('inbox.read') || 'Read' : t('inbox.replied') || 'Replied'}
                </Badge>
              </span>
              <span className="figure block truncate text-2xs font-normal text-text-tertiary">
                {message.created_at ? formatDateTime(message.created_at) : t('inbox.timeUnknown') || 'Time unknown'}
                {message.bot_name ? ` · ${message.bot_name}` : ''}
              </span>
            </span>
          </span>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || status === 'replied'}
              onClick={() => void setStatus(status === 'new' ? 'read' : 'replied')}
            >
              <Check aria-hidden />
              {status === 'new' ? t('inbox.markRead') || 'Mark read' : t('inbox.markReplied') || 'Mark replied'}
            </Button>
            {/* Destructive actions are `danger` outline. As a ghost this was
                indistinguishable in weight from "Mark read" beside it. */}
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 aria-hidden />
              {t('inbox.delete') || 'Delete'}
            </Button>
          </>
        }
      />

      {error ? (
        <Alert tone="danger" live className="mx-cell mt-3">
          {error}
        </Alert>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-cell py-4">
        <div className="mx-auto max-w-reading space-y-5">
          <Card>
            <CardBody>
              <p className="whitespace-pre-wrap break-words text-prose text-text-primary">
                {message.message_body?.trim() || t('inbox.thisMessageHadNoBody') || 'This message had no body.'}
              </p>
            </CardBody>
          </Card>

          <DefinitionList
            columns={2}
            items={[
              {
                label: t('inbox.email') || 'Email',
                value: message.visitor_email ? (
                  <a
                    href={`mailto:${message.visitor_email}`}
                    className="text-accent-600 underline-offset-2 hover:underline"
                  >
                    {message.visitor_email}
                  </a>
                ) : (
                  ABSENT
                ),
              },
              { label: t('inbox.phone') || 'Phone', value: message.visitor_phone || ABSENT },
            ]}
          />

          <section aria-labelledby="reply-heading" className="space-y-2.5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              {/* `text-base`, not `text-lg`: the visitor's name above it is the
                  section this sits inside, and two headings at one rung told
                  the reader they were peers. */}
              <h3 id="reply-heading" className="text-base font-semibold text-text-primary">
                {t('inbox.reply') || 'Reply'}
              </h3>
              {/* One picker, one label. "Manage" was a second affordance for the
                  same drawer, under a second name. */}
              {snippets.length > 0 ? (
                <Select
                  size="sm"
                  label={t('inbox.savedReplies') || 'Saved replies'}
                  value=""
                  onValueChange={(chosen) => {
                    if (chosen === MANAGE_OPTION) {
                      onManageSnippets();
                      return;
                    }
                    const snippet = snippets.find((entry) => String(entry.id) === chosen);
                    if (snippet) setReply(applyTemplate(snippet.content, message.visitor_name));
                  }}
                  placeholder={t('inbox.savedReplies2') || 'Saved replies…'}
                  options={[
                    ...snippets.map((snippet) => ({
                      value: String(snippet.id),
                      label: snippet.title,
                    })),
                    { value: MANAGE_OPTION, label: t('inbox.manageSavedReplies') || 'Manage saved replies…' },
                  ]}
                />
              ) : (
                <Button size="sm" variant="ghost" onClick={onManageSnippets}>
                  {t('inbox.savedReplies') || 'Saved replies'}
                </Button>
              )}
            </div>

            <Textarea
              rows={6}
              aria-label={t('inbox.yourReply') || 'Your reply'}
              placeholder={t('inbox.writeYourReplyItOpens') || 'Write your reply. It opens in your email app with their message quoted underneath.'}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />

            {message.visitor_email ? (
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={mailto ?? '#'}
                  className={buttonClass('primary', 'sm')}
                  onClick={() => {
                    if (status !== 'replied') void setStatus('replied');
                    toast.info(t('inbox.openingYourEmailApp') || 'Opening your email app', {
                      description: t('inbox.thisMessageIsMarkedReplied') || 'This message is marked replied. Send it from your mailbox.',
                    });
                  }}
                >
                  <Mail aria-hidden />
                  {t('inbox.openInYourEmailApp') || 'Open in your email app'}
                </a>
                <p className="text-2xs text-text-tertiary">
                  {t('inbox.oyechatsDoesNotSendThis') || 'OyeChats does not send this for you — it goes from your own mailbox.'}
                </p>
              </div>
            ) : (
              <Alert tone="warning">
                {t('inbox.theyDidNotLeaveAn') || 'They did not leave an email address, so there is no way to reply to this one.'}
              </Alert>
            )}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('inbox.deleteThisMessage') || 'Delete this message?'}
        description={`The message from ${name} is removed for everyone in the workspace, and there is no copy anywhere else.`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await onDelete(message.id);
          toast.success(t('inbox.messageDeleted') || 'Message deleted');
        }}
      />
    </section>
  );
}
