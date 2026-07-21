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
        success: 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]',
        warning: 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning)]',
        danger: 'bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
        info: 'bg-[var(--ds-info-soft)] text-[var(--ds-info)]',
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
