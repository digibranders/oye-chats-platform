import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** Input — the standard single-line text field. */
export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-10 w-full rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 text-sm text-[var(--ds-text)] outline-none transition-colors',
      'placeholder:text-[var(--ds-text-subtle)] focus-visible:border-[var(--ds-accent)] focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-soft)]',
      'disabled:cursor-not-allowed disabled:opacity-60',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
