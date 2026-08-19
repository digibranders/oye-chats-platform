import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** Announced to assistive tech. Set to null for a spinner inside a labelled control. */
  label?: string | null;
  className?: string;
}

const SIZES = { sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-6 w-6' } as const;

/**
 * An indeterminate wait.
 *
 * Use it only for something small and bounded — a button in flight, an inline
 * revalidation. A whole page or panel that is loading uses skeletons instead: a
 * spinner in the middle of an empty rectangle tells the user to wait but not
 * what for, and it makes every load feel the same length.
 */
export function Spinner({ size = 'md', label = 'Loading', className }: SpinnerProps) {
  return (
    <>
      <Loader2
        aria-hidden
        className={cn('shrink-0 animate-spin text-text-tertiary', SIZES[size], className)}
      />
      {label ? (
        <span role="status" className="sr-only">
          {label}
        </span>
      ) : null}
    </>
  );
}
