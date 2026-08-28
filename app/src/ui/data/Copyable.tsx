import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { useClipboard } from '../hooks/useClipboard';
import { useTranslation } from '../../i18n/useTranslation';

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
  /** `h-control-sm` (28), so the field fits a table cell or a dense row. */
  compact?: boolean;
  className?: string;
}

/**
 * A read-only value with a copy control. Keys, bot ids, webhook URLs.
 *
 * One box, with the controls inside it. They used to sit *outside* — a code chip
 * and then two loose ghost buttons on the same flex row — which had three
 * consequences worth writing down: the field's right edge landed ~60px short of
 * every other child of the same card, so a card holding a key field above a code
 * block had two different right edges; the chip was 30px tall beside 28px
 * buttons, a mismatch `items-center` hid as a 1px offset at each end; and the
 * boundary was `--color-border` (1.28:1), a decorative hairline standing in for
 * what is functionally a control group. It is `--color-border-strong` now, which
 * is what DESIGN.md §2.1 asks of any boundary that is the only thing telling you
 * a control is there.
 */
export function CopyField({
  value,
  label,
  secret = false,
  maskedValue,
  onCopy,
  compact = false,
  className,
}: CopyFieldProps) {
  const { state, copy } = useClipboard();
  const [revealed, setRevealed] = useState(!secret);
  const shown = revealed ? value : (maskedValue ?? '•'.repeat(Math.min(value.length, 32)));

  /**
   * The buttons have to be a rung SMALLER than the box that holds them.
   *
   * Everything here is `box-sizing: border-box`, so a `compact` field's
   * `h-control-sm` (28) is 26px of content once its own 1px border is taken
   * out — and `icon-sm` is `h-control-sm`, a full 28. The buttons were
   * therefore 1px taller than the space they sat in, and `ghost`'s hover fill
   * is opaque, so hovering either of them painted over the field's top and
   * bottom border: the outline appeared to break exactly where the pointer
   * was. `overflow-hidden` would have hidden it rather than fixed it, and
   * would have squared off the buttons' own corners doing so.
   *
   * `icon-xs` is 24, which leaves a pixel of ground above and below inside a
   * compact field, and it keeps a 24px target through `HIT_AREA` — the hit box
   * grows by a pseudo-element that paints nothing, so it cannot cover the
   * border either. The default field is 34 (32 of content) and has always had
   * room for a 28.
   */
  const controlSize = compact ? 'icon-xs' : 'icon-sm';

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 rounded-md border border-border-strong bg-surface-sunken pr-0.5',
        compact ? 'h-control-sm pl-2' : 'h-control-md pl-2.5',
        className,
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">{shown}</code>
      {secret ? (
        <Button
          size={controlSize}
          variant="ghost"
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? (
            <EyeOff aria-hidden className="h-icon-sm w-icon-sm" />
          ) : (
            <Eye aria-hidden className="h-icon-sm w-icon-sm" />
          )}
        </Button>
      ) : null}
      <Button
        size={controlSize}
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={() => void copy(value).then((ok) => onCopy?.(ok))}
      >
        {state === 'copied' ? (
          <Check aria-hidden className="h-icon-sm w-icon-sm text-success" />
        ) : (
          <Copy aria-hidden className="h-icon-sm w-icon-sm" />
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
 *
 * The copy button lives in the bar above the code, not floating over it. It used
 * to be absolutely positioned at the code's top-right, so the first line of
 * every snippet ran underneath it — and the embed snippet, the single most
 * important string in this product, is one long line whose first ~90px was
 * therefore hidden behind the word "Copy". The bar already existed for the
 * caption and rendered a `justify-between` flex with one child in it.
 */
export function CodeBlock({ code, caption, label = 'code', onCopy, className }: CodeBlockProps) {
  const { t } = useTranslation();
  const { state, copy } = useClipboard();

  return (
    <div className={cn('overflow-hidden rounded-md border border-border', className)}>
      {/* `pr-1.5`, not `pr-1`. The focus ring is 2px at a 2px offset, so a
          focused control needs 4px of clearance — and this bar sits inside an
          `overflow-hidden` box, which clips at the padding edge. At 4px the
          Copy button's ring fitted with nothing to spare, and it sits in the
          rounded top-right corner where the clip closes in sooner than the
          straight edge. 6px gives it room. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-sunken py-1 pl-3 pr-1.5">
        <span className="min-w-0 truncate text-xs text-text-secondary">{caption}</span>
        <Button
          size="sm"
          variant="ghost"
          // The visible word is "Copy" on every block; the accessible name says
          // *what* is being copied, because a page with three snippets on it
          // otherwise offers a screen-reader user three identical buttons. The
          // name still begins with the visible text, so it satisfies SC 2.5.3.
          aria-label={state === 'copied' ? `Copied ${label}` : `Copy ${label}`}
          onClick={() => void copy(code).then((ok) => onCopy?.(ok))}
          iconLeft={
            state === 'copied' ? (
              <Check aria-hidden className="h-icon-sm w-icon-sm text-success" />
            ) : (
              <Copy aria-hidden className="h-icon-sm w-icon-sm" />
            )
          }
        >
          {state === 'copied' ? t('ds.copied') || 'Copied' : t('ds.copy') || 'Copy'}
        </Button>
      </div>
      {/* `tabIndex={0}` because a scrollable region must be reachable by
          keyboard, or its overflowing content is unreadable without a mouse. */}
      <pre
        tabIndex={0}
        className="overflow-x-auto bg-surface-sunken px-3 py-2.5 font-mono text-xs text-text-primary"
      >
        <code>{code}</code>
      </pre>
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'copied' ? `${label} copied` : state === 'failed' ? `Could not copy the ${label}. Select the text to copy it manually.` : ''}
      </span>
    </div>
  );
}
