import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * The console's status vocabulary. Five tones and no more.
 *
 * `accent` is not a sixth status: it is "in progress" — crawling, training,
 * streaming, a conversation that is live right now. Giving progress the
 * interactive hue rather than a hue of its own is what keeps the status set at
 * four and keeps badges readable at 11px.
 */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'plan';

const TONE_TINT: Record<Tone, string> = {
  neutral: 'bg-neutral-tint text-neutral',
  success: 'bg-success-tint text-success',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  accent: 'bg-accent-50 text-accent-700',
  plan: 'bg-plan-tint text-plan',
};

const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-neutral-fill',
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
  accent: 'bg-accent-500',
  plan: 'bg-plan',
};

export interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  /** Adds the tone's dot. Use on states a user scans for down a column. */
  dot?: boolean;
  /** Longer explanation, for a state whose one-word label cannot carry it. */
  title?: string;
  className?: string;
}

/**
 * A state label.
 *
 * Always carries a word. Colour is never the only signal — roughly one reader in
 * twelve cannot separate the success green from the danger red, and a column of
 * bare coloured pills tells them nothing at all.
 */
export function Badge({ tone = 'neutral', children, dot = false, title, className }: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-xs px-1.5 py-0.5',
        'text-2xs font-medium',
        TONE_TINT[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />}
      {children}
    </span>
  );
}

export interface StatusDotProps {
  tone?: Tone;
  /** Adds a slow halo. Reserved for genuinely live state, never for "enabled". */
  pulse?: boolean;
  /** Required: the dot is meaningless to anyone who cannot see it. */
  label: string;
  className?: string;
}

/**
 * A bare state dot, for places a full badge would not fit — an avatar corner, a
 * sidebar row, the head of a conversation list item.
 *
 * The label is a required prop rather than an optional one because a dot with no
 * accessible name is decoration that happens to carry the most important fact on
 * the row.
 */
export function StatusDot({ tone = 'neutral', pulse = false, label, className }: StatusDotProps) {
  return (
    <span className={cn('relative inline-flex h-2 w-2 shrink-0', className)}>
      {pulse && (
        <span
          aria-hidden
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            // `motion-reduce` rather than relying on the global rule: a ping
            // shortened to 0.01ms strobes instead of stopping.
            'motion-reduce:hidden',
            TONE_DOT[tone],
          )}
        />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', TONE_DOT[tone])} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
