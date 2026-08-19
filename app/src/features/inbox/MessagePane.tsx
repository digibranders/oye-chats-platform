import { useMemo, useState } from 'react';
import { ArrowLeft, Check, Mail, Trash2 } from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  Select,
  Textarea,
  buttonClass,
  formatDateTime,
  toast,
} from '../../ui';
import type { CannedResponse, OfflineMessage } from '../../types/domain';
import type { OfflineStatus } from './inboxModel';

export interface MessagePaneProps {
  message: OfflineMessage;
  snippets: CannedResponse[];
  onManageSnippets: () => void;
  onStatusChange: (id: number, status: OfflineStatus) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** Present only when the list is not on screen beside this pane. */
  onBack?: () => void;
}

/** Substitute `{name}` in a saved reply with the visitor's first name. */
function applyTemplate(body: string, visitorName: string | null | undefined): string {
  const first = (visitorName ?? '').trim().split(/\s+/)[0] || 'there';
  return body.replace(/\{name\}/g, first);
}

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
  onBack,
}: MessagePaneProps) {
  const name = message.visitor_name?.trim() || message.visitor_email?.trim() || 'Visitor';
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
        err instanceof Error ? `Could not update this message: ${err.message}` : 'Could not update this message.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={`Message from ${name}`} className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-3 md:px-6">
        {onBack ? (
          <Button size="icon-sm" variant="ghost" aria-label="Back to the list" onClick={onBack}>
            <ArrowLeft aria-hidden className="h-4 w-4" />
          </Button>
        ) : null}
        <Avatar size="md" name={name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-text-primary">{name}</h2>
            <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
              {status === 'new' ? 'New' : status === 'read' ? 'Read' : 'Replied'}
            </Badge>
          </div>
          <p className="figure truncate text-2xs text-text-tertiary">
            {message.created_at ? formatDateTime(message.created_at) : 'Time unknown'}
            {message.bot_name ? ` · ${message.bot_name}` : ''}
          </p>
        </div>
        <Button
          variant="ghost"
          disabled={busy || status === 'replied'}
          onClick={() => void setStatus(status === 'new' ? 'read' : 'replied')}
        >
          <Check aria-hidden className="h-4 w-4" />
          {status === 'new' ? 'Mark read' : 'Mark replied'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden className="h-4 w-4" />
          Delete
        </Button>
      </header>

      {error ? (
        <Alert tone="danger" live className="mx-4 mt-3 md:mx-6">
          {error}
        </Alert>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="max-w-reading space-y-5">
          <article className="rounded-lg border border-border bg-surface p-4">
            <p className="whitespace-pre-wrap break-words text-prose text-text-primary">
              {message.message_body?.trim() || 'This message had no body.'}
            </p>
          </article>

          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-text-tertiary">Email</dt>
              <dd className="mt-0.5 break-words text-sm text-text-primary">
                {message.visitor_email ? (
                  <a
                    href={`mailto:${message.visitor_email}`}
                    className="text-accent-600 underline-offset-2 hover:underline"
                  >
                    {message.visitor_email}
                  </a>
                ) : (
                  'Not given'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-tertiary">Phone</dt>
              <dd className="mt-0.5 text-sm text-text-primary">{message.visitor_phone || 'Not given'}</dd>
            </div>
          </dl>

          <section aria-labelledby="reply-heading" className="space-y-2.5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h3 id="reply-heading" className="text-lg font-semibold text-text-primary">
                Reply
              </h3>
              <div className="flex items-center gap-2">
                {snippets.length > 0 ? (
                  <Select
                    size="sm"
                    aria-label="Insert a saved reply"
                    value=""
                    onChange={(event) => {
                      const snippet = snippets.find((entry) => String(entry.id) === event.target.value);
                      if (snippet) setReply(applyTemplate(snippet.content, message.visitor_name));
                    }}
                    placeholder="Saved reply…"
                    options={snippets.map((snippet) => ({ value: String(snippet.id), label: snippet.title }))}
                  />
                ) : null}
                <Button size="sm" variant="ghost" onClick={onManageSnippets}>
                  Manage
                </Button>
              </div>
            </div>

            <Textarea
              rows={6}
              aria-label="Your reply"
              placeholder="Write your reply. It opens in your email app with their message quoted underneath."
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />

            {message.visitor_email ? (
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={mailto ?? '#'}
                  className={buttonClass('primary')}
                  onClick={() => {
                    if (status !== 'replied') void setStatus('replied');
                    toast.info('Opening your email app', {
                      description: 'This message is marked replied. Send it from your mailbox.',
                    });
                  }}
                >
                  <Mail aria-hidden className="h-4 w-4" />
                  Open in your email app
                </a>
                <p className="text-2xs text-text-tertiary">
                  OyeChats does not send this for you — it goes from your own mailbox.
                </p>
              </div>
            ) : (
              <Alert tone="warning">
                They did not leave an email address, so there is no way to reply to this one.
              </Alert>
            )}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this message?"
        description={`The message from ${name} is removed for everyone in the workspace, and there is no copy anywhere else.`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await onDelete(message.id);
          toast.success('Message deleted');
        }}
      />
    </section>
  );
}
