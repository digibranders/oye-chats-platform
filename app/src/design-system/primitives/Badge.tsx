import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-none',
  {
    variants: {
      tone: {
        neutral: 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]',
        accent: 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]',
        success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
        warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
        danger: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400',
        info: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface StatusBadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {
  /** Render a leading status dot in the current text color. */
  dot?: boolean;
}

/** StatusBadge — compact labelled status pill (mandate shared component). */
export const StatusBadge = forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ className, tone, dot = false, children, ...props }, ref) => (
    <span ref={ref} className={cn(badge({ tone }), className)} {...props}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  ),
);
StatusBadge.displayName = 'StatusBadge';
