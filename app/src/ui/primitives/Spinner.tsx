import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** Announced to assistive tech. Set to null for a spinner inside a labelled control. */
  label?: string | null;
  className?: string;
}

const SIZES = {
  sm: 'h-icon-sm w-icon-sm',
  md: 'h-icon-md w-icon-md',
  lg: 'h-icon-lg w-icon-lg',
} as const;

/**
 * An indeterminate wait.
 *
 * Use it only for something small and bounded — a button in flight, an inline
 * revalidation. A whole page or panel that is loading uses skeletons instead: a
 * spinner in the middle of an empty rectangle tells the user to wait but not
 * what for, and it makes every load feel the same length.
 *
 * It renders one element rather than a fragment. As a fragment, `className`
 * landed on the glyph only — so a caller could not centre the pair — and the
 * `sr-only` span became a stray sibling of whatever flex row the spinner was
 * dropped into. Colour lives on the wrapper, which is what lets `Button` hand it
 * `text-current` and get a spinner in the button's own ink.
 */
export function Spinner({ size = 'md', label = 'Loading', className }: SpinnerProps) {
  return (
    <span className={cn('inline-flex shrink-0 items-center text-text-tertiary', className)}>
      <Loader2 aria-hidden className={cn('shrink-0 animate-spin', SIZES[size])} />
      {label ? (
        <span role="status" className="sr-only">
          {label}
        </span>
      ) : null}
    </span>
  );
}
