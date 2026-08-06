import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const badge = cva(
  // Layout + the shared pill shell (hairline inset ring). Colour is applied
  // separately per tone so there are no conflicting utility overrides.
  'inline-flex select-none items-center whitespace-nowrap rounded-full font-medium leading-none tracking-[0.01em] ring-1 ring-inset',
  {
    variants: {
      size: {
        sm: 'gap-1.5 px-2 py-0.5 text-[10px]',
        md: 'gap-1.5 px-2.5 py-1 text-[11px]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

// The quiet default: neutral sunken fill, hairline ring, ink text. The tone is
// carried only by the dot - so no pill reads as a loud monochrome block.
const QUIET = 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text)] ring-[var(--ds-border)]';

/**
 * Per-tone pill surface. Every tone is quiet EXCEPT danger, which keeps a
 * soft-red tint so genuine alerts (past due, failed, needs attention) still
 * stand out on a busy screen instead of hiding behind a grey chip.
 */
const toneSurface: Record<BadgeTone, string> = {
  neutral: QUIET,
  accent: QUIET,
  success: QUIET,
  warning: QUIET,
  info: QUIET,
  danger:
    'bg-[var(--ds-danger-soft)] text-[var(--ds-danger)] ring-[color-mix(in_srgb,var(--ds-danger)_32%,transparent)]',
};

/** Maps a tone to the dot colour only - never to the pill fill or the text. */
const dotTone: Record<BadgeTone, string> = {
  neutral: 'text-[var(--ds-text-subtle)]',
  accent: 'text-[var(--ds-accent)]',
  success: 'text-[var(--ds-success)]',
  warning: 'text-[var(--ds-warning)]',
  danger: 'text-[var(--ds-danger)]',
  info: 'text-[var(--ds-info)]',
};

export interface StatusBadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {
  /** Semantic tone - expressed through the leading dot (danger also tints the pill). */
  tone?: BadgeTone;
  /**
   * Force the status dot on even for a neutral tone (e.g. an "Offline" pill).
   * Any non-neutral tone shows the dot automatically, so this is only needed
   * to give a neutral pill a grey dot.
   */
  dot?: boolean;
  /** Optional leading glyph (e.g. a Lucide icon). Auto-sized to the badge. */
  icon?: ReactNode;
}

/**
 * StatusBadge - the single labelled pill for the whole admin panel (mandate
 * shared component). Every pill - status, plan, role, tier, count - renders as
 * the same quiet neutral chip with colour carried by a small tone-coloured dot,
 * so dense screens stay calm. Danger is the one deliberate exception: it stays
 * tinted so real alerts read as alerts.
 */
export const StatusBadge = forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ className, tone = 'neutral', size, dot = false, icon, children, ...props }, ref) => {
    const showDot = dot || tone !== 'neutral';
    return (
      <span ref={ref} className={cn(badge({ size }), toneSurface[tone], className)} {...props}>
        {showDot && (
          <span className={cn('flex h-1.5 w-1.5 shrink-0', dotTone[tone])} aria-hidden="true">
            <span className="inline-flex h-full w-full rounded-full bg-current" />
          </span>
        )}
        {icon && (
          <span
            className="flex shrink-0 items-center [&>svg]:h-3 [&>svg]:w-3"
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        {children}
      </span>
    );
  },
);
StatusBadge.displayName = 'StatusBadge';
