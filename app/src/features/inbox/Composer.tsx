import { useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Send, Zap } from 'lucide-react';
import { Button, Kbd, Spinner, Tooltip, cn, formatBytes, toast } from '../../ui';
import type { CannedResponse } from '../../types/domain';
import { useTranslation } from '../../i18n/useTranslation';

/** Anything larger is refused before the upload starts, not after it fails. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onAttach: (file: File) => Promise<void>;
  onTyping: () => void;
  snippets: CannedResponse[];
  /** Blocks sending, with the reason shown in place of the hint. */
  disabledReason?: string | null;
  placeholder?: string;
  /** Opens the snippet manager, so the operator never leaves the conversation. */
  onManageSnippets?: () => void;
}

function matchSnippets(snippets: CannedResponse[], token: string): CannedResponse[] {
  const needle = token.toLowerCase();
  return snippets
    .filter((snippet) => {
      const shortcut = (snippet.shortcut ?? '').toLowerCase().replace(/^\//, '');
      return (
        needle === '' ||
        shortcut.startsWith(needle) ||
        snippet.title.toLowerCase().includes(needle)
      );
    })
    .slice(0, 8);
}

/**
 * The message box.
 *
 * Three things it does that the console it replaces did not. Enter sends and
 * Shift+Enter breaks the line, which is what every operator's fingers already
 * expect. A `/` at the start of an empty message opens the snippet list inline,
 * with real arrow-key navigation rather than a native `select`. And the draft is
 * owned by the caller, keyed by conversation — so switching to another visitor
 * and back does not silently destroy a half-written reply, which it used to.
 *
 * There is no `sending` state. `socket.sendMessage` returns synchronously and
 * the echo lands in the transcript within a frame, so a spinner would flash for
 * a frame and never resolve into anything — the prop existed with a branch
 * behind it and no caller ever passed it. A failed send is an `Alert` above the
 * transcript, which is where the operator can act on it.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onAttach,
  onTyping,
  snippets,
  disabledReason = null,
  placeholder,
  onManageSnippets,
}: ComposerProps) {
  const { t } = useTranslation();
  // Defaulted in the body, not the signature: a default parameter is evaluated
  // before the hook runs, so `t` does not exist yet there.
  const placeholderText = placeholder === undefined ? (t('inbox.writeAReplyForA') || 'Write a reply…   /  for a saved reply') : placeholder;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // Escape closes the menu. It used to call `onChange('')`, which destroyed the
  // whole draft — in every other combobox in the console Escape closes and
  // leaves the text.
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const listId = 'composer-snippets';

  const token = value.startsWith('/') ? value.slice(1) : null;
  const matches = useMemo(
    () => (token === null ? [] : matchSnippets(snippets, token)),
    [token, snippets],
  );
  const menuOpen = token !== null && matches.length > 0 && dismissedToken !== token;

  // Keep the highlight inside the list as it narrows under the operator's typing.
  useEffect(() => {
    setHighlight((current) => (current < matches.length ? current : 0));
  }, [matches.length]);

  // Grow to the text, up to a ceiling: an unbounded textarea eventually eats the
  // transcript it is a reply to.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }, [value]);

  const disabled = Boolean(disabledReason);

  function insertSnippet(snippet: CannedResponse): void {
    onChange(snippet.content);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function submit(): void {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((current) => (current + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((current) => (current - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertSnippet(matches[highlight]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedToken(token);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  async function onFilePicked(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Reset immediately so picking the same file twice in a row still fires.
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error(t('inbox.thatFileIsTooLarge') || 'That file is too large', {
        description:
          t('inbox.theLimitIsAndThisOneIs', {
            limit: formatBytes(MAX_FILE_BYTES),
            size: formatBytes(file.size),
          }) || `The limit is ${formatBytes(MAX_FILE_BYTES)} and this one is ${formatBytes(file.size)}.`,
      });
      return;
    }
    setUploading(true);
    try {
      await onAttach(file);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="relative shrink-0 border-t border-border bg-surface px-cell py-3">
      {menuOpen ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t('inbox.savedReplies') || 'Saved replies'}
          // The system's menu rungs: `shadow-md` (`lg` is for modals and
          // drawers), `--z-overlay` (at `--z-sticky` it painted *under* any
          // sticky toolbar), and the `p-1` inset that stops an option's
          // highlight bleeding into the container's own radius.
          // rtl-ok: `left-cell`/`right-cell` share the same "cell" token, a
          // symmetric inset that matches the container's own `px-cell` below
          // — not an asymmetric anchor, so it holds under either direction.
          className="motion-pop absolute bottom-full left-cell right-cell z-[var(--z-overlay)] mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-md"
        >
          {matches.map((snippet, index) => (
            <button
              key={snippet.id}
              type="button"
              role="option"
              aria-selected={index === highlight}
              // Pointer-down, not click: a click fires after the textarea has
              // already lost focus, which closes the menu out from under it.
              onMouseDown={(event) => {
                event.preventDefault();
                insertSnippet(snippet);
              }}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-start',
                index === highlight ? 'bg-accent-50' : 'bg-surface',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-medium text-text-primary">{snippet.title}</span>
                {snippet.shortcut ? <Kbd>/{snippet.shortcut.replace(/^\//, '')}</Kbd> : null}
              </span>
              <span className="line-clamp-1 text-2xs text-text-secondary">{snippet.content}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* `rounded-md` (8), the control radius — `rounded-lg` is the card's, and
          two `rounded-sm` buttons sitting 4px inside a 10px corner is where the
          visible crescent came from. The ring is the system's one focus ring:
          `outline`, at +2, and only on keyboard focus. `:focus-within` alone
          fired on a mouse click, which no other input in the console does. */}
      <div
        className={cn(
          'flex items-end gap-1 rounded-md border border-border-strong bg-surface p-1',
          'has-[:focus-visible]:outline has-[:focus-visible]:outline-2',
          'has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-500',
        )}
      >
        <label className="sr-only" htmlFor="composer-input">
          {t('inbox.replyToThisVisitor') || 'Reply to this visitor'}
        </label>
        <textarea
          id="composer-input"
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          // The reason rides on the control it explains. `opacity-60` over the
          // whole box also dragged `border-strong` below its measured 3:1.
          placeholder={disabledReason ?? placeholderText}
          onChange={(event) => {
            onChange(event.target.value);
            onTyping();
          }}
          onKeyDown={onKeyDown}
          aria-controls={menuOpen ? listId : undefined}
          aria-expanded={menuOpen}
          className={cn(
            'min-h-control-sm flex-1 resize-none border-0 bg-transparent px-1.5 py-1',
            'text-prose text-text-primary placeholder:text-text-tertiary focus:outline-none',
          )}
        />
        <input ref={fileRef} type="file" className="hidden" onChange={onFilePicked} />
        <Tooltip content="Attach a file">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('inbox.attachAFile') || 'Attach a file'}
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <Spinner className="h-icon-md w-icon-md" /> : <Paperclip aria-hidden />}
          </Button>
        </Tooltip>
        {/* In the composer's own toolbar, beside the paperclip, rather than a
            ghost button on the footer row where it shared a line with — and
            competed against — the reason the composer was blocked. */}
        {onManageSnippets ? (
          <Tooltip content="Saved replies">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('inbox.savedReplies') || 'Saved replies'}
              onClick={onManageSnippets}
            >
              <Zap aria-hidden />
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip
          content={
            <span className="flex items-center gap-1.5">
              {t('inbox.send') || 'Send'} <Kbd>{t('inbox.enterKey') || 'Enter'}</Kbd>
            </span>
          }
        >
          <Button
            size="icon-sm"
            aria-label={t('inbox.sendReply') || 'Send reply'}
            disabled={disabled || value.trim().length === 0}
            onClick={submit}
          >
            <Send aria-hidden className="rtl:-scale-x-100" />
          </Button>
        </Tooltip>
      </div>

      {/* Only the disabled reason. The permanent "Enter sends · Shift+Enter
          starts a line · / inserts a saved reply" line was learned in a day and
          read for a year; the keys live on the send button's tooltip and in the
          placeholder now. */}
      {disabledReason ? (
        <p role="status" className="mt-1.5 text-2xs text-warning">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}
