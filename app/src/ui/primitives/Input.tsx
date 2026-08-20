import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../lib/cn';
import { CONTROL_SIZE, DISABLED_CONTROL, controlClass, type ControlSize } from './controlStyles';
import { useFieldControlProps } from './fieldContext';

/**
 * The shared shape of every text-entry control.
 *
 * `--color-border-strong` rather than `--color-border`: the hairline that
 * separates two table rows is 1.28:1, which is correct for a divider and well
 * under the 3:1 that WCAG 2.2 SC 1.4.11 asks of a boundary that is the only
 * thing telling you a control is there. Anything the user types into or toggles
 * gets the strong edge.
 *
 * It carries no radius. Radius, height, padding and text size come from
 * `CONTROL_SIZE`, because a field's corner belongs to the *row* it sits in — an
 * 8px radius baked in here is what put a 6px `sm` button between two 8px `sm`
 * inputs on every table toolbar in the console.
 *
 * The hover is `enabled:`. `:hover` fires on a disabled input in every browser,
 * so a greyed, non-interactive field visibly darkened its border under the
 * pointer — a "this is clickable" lie told by the one control that is not.
 *
 * Three native-widget resets, each for a defect that only appears in a real
 * browser: Chrome and Safari draw their own clear button inside
 * `type="search"`, so a `SearchField` showed **two** X's 20px apart the moment
 * the user typed; `type="number"`'s spinner collides with a trailing slot; and
 * `type="color"`'s swatch is square-cornered inside a rounded box, which is the
 * "corners are broken" complaint in the one place a customer picks their brand
 * colour.
 */
export const CONTROL_BASE = cn(
  'w-full min-w-0 border bg-surface text-text-primary',
  'border-border-strong placeholder:text-text-disabled',
  'transition-colors duration-[var(--dur-fast)]',
  'enabled:hover:border-text-tertiary',
  DISABLED_CONTROL,
  'aria-[invalid=true]:border-danger aria-[invalid=true]:enabled:hover:border-danger',
  '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none',
  '[&::-webkit-inner-spin-button]:m-0 [&::-webkit-outer-spin-button]:m-0',
  '[&::-webkit-color-swatch]:rounded-xs [&::-webkit-color-swatch]:border-0',
  '[&::-webkit-color-swatch-wrapper]:p-0',
);

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: ControlSize;
  /**
   * An icon or short unit inside the field's leading edge.
   *
   * Named `leading`/`trailing` rather than `prefix`/`suffix` because `prefix` is
   * a real HTML attribute on every element, so a `prefix?: ReactNode` prop
   * silently conflicts with the DOM typing it is spread into.
   */
  leading?: ReactNode;
  /** A clear button, a unit, or a copy control at the trailing edge. */
  trailing?: ReactNode;
  /**
   * Adds a reveal toggle to a password field. It occupies the `trailing` slot,
   * so the two are mutually exclusive — a password field with a unit is not a
   * thing.
   *
   * Three pages and a settings card each shipped their own — two of them byte
   * identical, all of them a bare `<button>` mis-centred in a 34px control and
   * none of them reporting state. This one is 24px, vertically centred by the
   * affix row, and carries `aria-pressed`, so the toggle's own state is
   * announced rather than only its label changing.
   */
  revealable?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', leading, trailing, revealable = false, className, type = 'text', ...props },
  ref,
) {
  const fieldProps = useFieldControlProps();
  const geometry = CONTROL_SIZE[size];
  const [revealed, setRevealed] = useState(false);

  const reveal = revealable ? (
    <button
      type="button"
      aria-pressed={revealed}
      aria-label={revealed ? 'Hide password' : 'Show password'}
      onClick={() => setRevealed((shown) => !shown)}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-xs text-text-tertiary',
        'transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      {revealed ? (
        <EyeOff aria-hidden className="h-icon-sm w-icon-sm" />
      ) : (
        <Eye aria-hidden className="h-icon-sm w-icon-sm" />
      )}
    </button>
  ) : null;

  const trailingSlot = reveal ?? trailing;

  const input = (
    <input
      ref={ref}
      type={revealable && revealed ? 'text' : type}
      className={cn(
        CONTROL_BASE,
        controlClass(size),
        leading && geometry.affixPad.leading,
        trailingSlot && geometry.affixPad.trailing,
        className,
      )}
      {...fieldProps}
      {...props}
    />
  );

  if (!leading && !trailingSlot) return input;

  return (
    <div className="relative flex w-full items-center">
      {leading ? (
        // `pointer-events-none` so a click on the icon still lands in the field.
        // A trailing slot is usually a real control, so it keeps its events.
        <span
          className={cn(
            'pointer-events-none absolute flex items-center text-text-tertiary',
            geometry.affixInset.leading,
          )}
        >
          {leading}
        </span>
      ) : null}
      {input}
      {trailingSlot ? (
        // Both affixes stand on the control's own text inset, so the leading
        // glyph, the text and the trailing control's box share one column. They
        // were 12 and 10, which put a search icon and its clear button at two
        // different insets in every toolbar field in the app.
        <span
          className={cn(
            'absolute flex items-center text-text-tertiary',
            geometry.affixInset.trailing,
          )}
        >
          {trailingSlot}
        </span>
      ) : null}
    </div>
  );
});

export interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  /** Minimum visible rows. The control still grows with `resize-y`. */
  rows?: number;
  size?: 'sm' | 'md';
}

const TEXTAREA_SIZE = {
  sm: 'px-2.5 py-1.5 text-sm rounded-sm',
  md: 'px-3 py-2 text-prose rounded-md',
} as const;

/**
 * A multi-line field.
 *
 * `text-prose` (14/24), not `text-base` with `leading-relaxed`. A textarea is
 * where the system prompt and the long descriptions are written — running prose,
 * which the type scale already has a rung for — and `leading-relaxed` on
 * `text-base` renders 22.75px against the rung's own 22, so two adjacent
 * descriptions stopped sharing a baseline. At `md`, `rows={4}` is 96 + 16 + 2 =
 * 114px.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { rows = 4, size = 'md', className, ...props },
  ref,
) {
  const fieldProps = useFieldControlProps();
  return (
    <textarea
      ref={ref}
      rows={rows}
      // Vertical resize only: horizontal dragging breaks the form's column and
      // cannot be undone without a reload.
      className={cn(CONTROL_BASE, 'resize-y', TEXTAREA_SIZE[size], className)}
      {...fieldProps}
      {...props}
    />
  );
});
