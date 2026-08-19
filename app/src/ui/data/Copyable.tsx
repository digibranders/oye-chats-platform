import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { useClipboard } from '../hooks/useClipboard';

export interface CopyFieldProps {
  value: string;
  label: string;
  /** Masks the value until revealed. For API keys and signing secrets. */
  secret?: boolean;
  /** Shown instead of the value when masked. */
  maskedValue?: string;
  /**
   * Fired after a copy attempt, with whether it worked.
   *
   * Copying is the whole point of several surfaces — the embed snippet most of
   * all — so it is the activation event worth recording. Without this the one
   * moment that matters had to be inferred from a neighbouring button.
   */
  onCopy?: (succeeded: boolean) => void;
  className?: string;
}

/** A read-only value with a copy control. Keys, bot ids, webhook URLs. */
export function CopyField({
  value,
  label,
  secret = false,
  maskedValue,
  onCopy,
  className,
}: CopyFieldProps) {
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
      <Button size="icon-sm" variant="ghost" aria-label={`Copy ${label}`} onClick={() => void copy(value).then((ok) => onCopy?.(ok))}>
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
  /** Fired after a copy attempt, with whether it worked. See `CopyFieldProps`. */
  onCopy?: (succeeded: boolean) => void;
  className?: string;
}

/**
 * A block of code the user is meant to copy out.
 *
 * The previous app had three separate implementations of this — on the install
 * page, in onboarding, and in the widget-copy card — with different affordances
 * in each.
 */
export function CodeBlock({ code, caption, label = 'code', onCopy, className }: CodeBlockProps) {
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
          // The visible word is "Copy" on every block; the accessible name says
          // *what* is being copied, because a page with three snippets on it
          // otherwise offers a screen-reader user three identical buttons. The
          // name still begins with the visible text, so it satisfies SC 2.5.3.
          aria-label={state === 'copied' ? `Copied ${label}` : `Copy ${label}`}
          onClick={() => void copy(code).then((ok) => onCopy?.(ok))}
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
