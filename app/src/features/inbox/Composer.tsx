import { useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Send, Zap } from 'lucide-react';
import { Button, Spinner, cn, formatBytes, toast } from '../../ui';
import type { CannedResponse } from '../../types/domain';

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
  sending?: boolean;
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
 */
export function Composer({
  value,
  onChange,
  onSend,
  onAttach,
  onTyping,
  snippets,
  disabledReason = null,
  sending = false,
  placeholder = 'Write a reply…',
  onManageSnippets,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = 'composer-snippets';

  const token = value.startsWith('/') ? value.slice(1) : null;
  const matches = useMemo(
    () => (token === null ? [] : matchSnippets(snippets, token)),
    [token, snippets],
  );
  const menuOpen = token !== null && matches.length > 0;

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
    if (!text || disabled || sending) return;
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
        onChange('');
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
      toast.error('That file is too large', {
        description: `The limit is ${formatBytes(MAX_FILE_BYTES)} and this one is ${formatBytes(file.size)}.`,
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
    <div className="relative shrink-0 border-t border-border bg-surface px-4 py-3 md:px-6">
      {menuOpen ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Saved replies"
          className="motion-pop absolute bottom-full left-4 right-4 z-[var(--z-sticky)] mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg md:left-6 md:right-6"
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
                'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left',
                index === highlight ? 'bg-accent-50' : 'bg-surface',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-medium text-text-primary">{snippet.title}</span>
                {snippet.shortcut ? (
                  <span className="figure text-2xs text-text-tertiary">/{snippet.shortcut.replace(/^\//, '')}</span>
                ) : null}
              </span>
              <span className="line-clamp-1 text-2xs text-text-secondary">{snippet.content}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          'flex items-end gap-2 rounded-lg border border-border-strong bg-surface px-2 py-1.5',
          'focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-accent-500',
          disabled && 'opacity-60',
        )}
      >
        <label className="sr-only" htmlFor="composer-input">
          Reply to this visitor
        </label>
        <textarea
          id="composer-input"
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={disabled ? '' : placeholder}
          onChange={(event) => {
            onChange(event.target.value);
            onTyping();
          }}
          onKeyDown={onKeyDown}
          aria-controls={menuOpen ? listId : undefined}
          aria-expanded={menuOpen}
          className={cn(
            'min-h-[1.75rem] flex-1 resize-none border-0 bg-transparent px-1.5 py-1',
            'text-prose text-text-primary placeholder:text-text-tertiary focus:outline-none',
          )}
        />
        <input ref={fileRef} type="file" className="hidden" onChange={onFilePicked} />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Attach a file"
          disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Spinner className="h-4 w-4" /> : <Paperclip aria-hidden className="h-4 w-4" />}
        </Button>
        <Button
          size="icon-sm"
          aria-label="Send reply"
          disabled={disabled || sending || value.trim().length === 0}
          onClick={submit}
        >
          {sending ? <Spinner className="h-4 w-4" /> : <Send aria-hidden className="h-4 w-4" />}
        </Button>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-3">
        {disabledReason ? (
          <p role="status" className="text-2xs text-warning">
            {disabledReason}
          </p>
        ) : (
          <p className="text-2xs text-text-tertiary">
            Enter sends · Shift+Enter starts a line · <span className="figure">/</span> inserts a saved reply
          </p>
        )}
        {onManageSnippets ? (
          <Button size="sm" variant="ghost" onClick={onManageSnippets}>
            <Zap aria-hidden className="h-3.5 w-3.5" />
            Saved replies
          </Button>
        ) : null}
      </div>
    </div>
  );
}
