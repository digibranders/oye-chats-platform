import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { useFieldControlProps } from './fieldContext';

/**
 * The shared shape of every text-entry control.
 *
 * `--color-border-strong` rather than `--color-border`: the hairline that
 * separates two table rows is 1.28:1, which is correct for a divider and well
 * under the 3:1 that WCAG 2.2 SC 1.4.11 asks of a boundary that is the only
 * thing telling you a control is there. Anything the user types into or toggles
 * gets the strong edge.
 */
export const CONTROL_BASE = cn(
  'w-full min-w-0 rounded-md border bg-surface text-text-primary',
  'border-border-strong placeholder:text-text-disabled',
  'transition-colors duration-[var(--dur-fast)]',
  'hover:border-text-tertiary',
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-disabled',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:hover:border-danger',
);

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  size?: 'sm' | 'md' | 'lg';
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
}

const SIZES = {
  sm: 'h-control-sm px-2.5 text-xs',
  md: 'h-control-md px-3 text-base',
  lg: 'h-control-lg px-3.5 text-base',
} as const;

const AFFIX_PAD = {
  sm: { leading: 'pl-8', trailing: 'pr-8' },
  md: { leading: 'pl-9', trailing: 'pr-9' },
  lg: { leading: 'pl-10', trailing: 'pr-10' },
} as const;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', leading, trailing, className, ...props },
  ref,
) {
  const fieldProps = useFieldControlProps();
  const input = (
    <input
      ref={ref}
      className={cn(
        CONTROL_BASE,
        SIZES[size],
        leading && AFFIX_PAD[size].leading,
        trailing && AFFIX_PAD[size].trailing,
        className,
      )}
      {...fieldProps}
      {...props}
    />
  );

  if (!leading && !trailing) return input;

  return (
    <div className="relative flex w-full items-center">
      {leading ? (
        // `pointer-events-none` so a click on the icon still lands in the field.
        // A trailing slot is usually a real control, so it keeps its events.
        <span className="pointer-events-none absolute left-3 flex items-center text-text-tertiary">
          {leading}
        </span>
      ) : null}
      {input}
      {trailing ? (
        <span className="absolute right-2.5 flex items-center text-text-tertiary">{trailing}</span>
      ) : null}
    </div>
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Minimum visible rows. The control still grows with `resize-y`. */
  rows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { rows = 4, className, ...props },
  ref,
) {
  const fieldProps = useFieldControlProps();
  return (
    <textarea
      ref={ref}
      rows={rows}
      // Vertical resize only: horizontal dragging breaks the form's column and
      // cannot be undone without a reload.
      className={cn(CONTROL_BASE, 'resize-y px-3 py-2 text-base leading-relaxed', className)}
      {...fieldProps}
      {...props}
    />
  );
});
