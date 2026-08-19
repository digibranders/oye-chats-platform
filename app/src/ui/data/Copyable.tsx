import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';

/**
 * Copy-to-clipboard with honest feedback.
 *
 * `navigator.clipboard` rejects on an insecure origin, without permission, or
 * when the document is not focused. The previous app called it in eight places
 * and swallowed the failure in most of them, so the button simply never said
 * "Copied" and the user had no idea whether anything happened. This reports the
 * failure so the caller can fall back to select-the-text.
 */
export function useClipboard(resetAfter = 2000) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      if (timer.current) window.clearTimeout(timer.current);
      try {
        await navigator.clipboard.writeText(text);
        setState('copied');
      } catch {
        setState('failed');
      }
      timer.current = window.setTimeout(() => setState('idle'), resetAfter);
    },
    [resetAfter],
  );

  return { state, copy };
}

export interface CopyFieldProps {
  value: string;
  label: string;
  /** Masks the value until revealed. For API keys and signing secrets. */
  secret?: boolean;
  /** Shown instead of the value when masked. */
  maskedValue?: string;
  className?: string;
}

/** A read-only value with a copy control. Keys, bot ids, webhook URLs. */
export function CopyField({ value, label, secret = false, maskedValue, className }: CopyFieldProps) {
  const { state, copy } = useClipboard();
  const [revealed, setRevealed] = useState(!secret);
  const shown = revealed ? value : (maskedValue ?? '•'.repeat(Math.min(value.length, 32)));

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <code
        className={cn(
          'min-w-0 flex-1 truncate rounded-md border border-border bg-surface-sunken px-2.5 py-1.5',
          'font-mono text-xs text-text-primary',
        )}
      >
        {shown}
      </code>
      {secret ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? <EyeOff aria-hidden className="h-3.5 w-3.5" /> : <Eye aria-hidden className="h-3.5 w-3.5" />}
        </Button>
      ) : null}
      <Button size="icon-sm" variant="ghost" aria-label={`Copy ${label}`} onClick={() => void copy(value)}>
        {state === 'copied' ? (
          <Check aria-hidden className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy aria-hidden className="h-3.5 w-3.5" />
        )}
      </Button>
      {/* The outcome, announced. A colour change on an icon is not feedback for
          anyone who cannot see it, and a silent failure is worse than none. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'copied' ? `${label} copied` : state === 'failed' ? `Could not copy ${label}. Select the text to copy it manually.` : ''}
      </span>
    </div>
  );
}

export interface CodeBlockProps {
  code: string;
  /** A short caption, e.g. "Paste before </body>". */
  caption?: ReactNode;
  label?: string;
  className?: string;
}

/**
 * A block of code the user is meant to copy out.
 *
 * The previous app had three separate implementations of this — on the install
 * page, in onboarding, and in the widget-copy card — with different affordances
 * in each.
 */
export function CodeBlock({ code, caption, label = 'code', className }: CodeBlockProps) {
  const { state, copy } = useClipboard();

  return (
    <div className={cn('overflow-hidden rounded-md border border-border', className)}>
      {caption ? (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-sunken px-3 py-1.5">
          <span className="min-w-0 truncate text-xs text-text-secondary">{caption}</span>
        </div>
      ) : null}
      <div className="relative">
        {/* `tabIndex={0}` because a scrollable region must be reachable by
            keyboard, or its overflowing content is unreadable without a mouse. */}
        <pre
          tabIndex={0}
          className="overflow-x-auto bg-surface-sunken px-3 py-2.5 font-mono text-xs leading-relaxed text-text-primary"
        >
          <code>{code}</code>
        </pre>
        <Button
          size="sm"
          variant="secondary"
          className="absolute right-2 top-2"
          onClick={() => void copy(code)}
          iconLeft={
            state === 'copied' ? (
              <Check aria-hidden className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy aria-hidden className="h-3.5 w-3.5" />
            )
          }
        >
          {state === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'copied' ? `${label} copied` : state === 'failed' ? `Could not copy the ${label}. Select the text to copy it manually.` : ''}
      </span>
    </div>
  );
}
