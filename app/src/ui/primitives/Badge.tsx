import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * The console's status vocabulary. Five tones and no more.
 *
 * Note what is NOT here: a tone for "in progress". Crawling, training and
 * streaming are carried by motion — an indeterminate bar, a pulsing dot, the
 * animated mark — not by a colour. Giving progress its own hue meant giving it
 * the interactive blue, and a selected row that is also streaming then says two
 * different things in one colour, on the one screen (the inbox) that cannot
 * afford the ambiguity.
 *
 * "Live" and "online" are `success` with a pulsing `StatusDot`, which is what
 * every chat tool has already taught people to read.
 */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'plan';

const TONE_TINT: Record<Tone, string> = {
  neutral: 'bg-neutral-tint text-neutral',
  success: 'bg-success-tint text-success',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  plan: 'bg-plan-tint text-plan',
};

const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-neutral-fill',
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
  plan: 'bg-plan',
};

export interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  /** Adds the tone's dot. Use on states a user scans for down a column. */
  dot?: boolean;
  className?: string;
}

/**
 * A state label.
 *
 * Always carries a word. Colour is never the only signal — roughly one reader in
 * twelve cannot separate the success green from the danger red, and a column of
 * bare coloured pills tells them nothing at all.
 *
 * If a state needs more explanation than its word carries, wrap the badge in a
 * `Tooltip`. It deliberately does not accept a `title`: the native attribute is
 * unreachable by keyboard, invisible on touch, and waits a second before it
 * appears, which is why replacing 203 of them was an audit finding in the first
 * place.
 *
 * `data-tone` is read by the forced-colors rule in the token layer, which gives
 * every tinted surface a border — Windows High Contrast strips backgrounds, and
 * without it all five tones render identically.
 */
export function Badge({ tone = 'neutral', children, dot = false, className }: BadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-xs px-1.5 py-0.5',
        'text-xs font-medium',
        TONE_TINT[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} /> : null}
      {children}
    </span>
  );
}

export interface StatusDotProps {
  tone?: Tone;
  /**
   * A slow halo. Reserved for state that is genuinely live *right now* — an
   * operator online, a conversation in progress — never for "enabled". A pulse
   * that never stops stops meaning anything.
   */
  pulse?: boolean;
  /** Required: the dot is meaningless to anyone who cannot see it. */
  label: string;
  className?: string;
}

/**
 * A bare state dot, for places a full badge will not fit — an avatar corner, a
 * rail row, the head of a conversation list item.
 *
 * The label is required rather than optional because a dot with no accessible
 * name is decoration that happens to carry the most important fact on the row.
 */
export function StatusDot({ tone = 'neutral', pulse = false, label, className }: StatusDotProps) {
  return (
    <span className={cn('relative inline-flex h-2 w-2 shrink-0', className)}>
      {pulse ? (
        <span
          aria-hidden
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            // `motion-reduce` rather than leaning on the global rule: an
            // animation shortened to 0.01ms strobes instead of stopping.
            'motion-reduce:hidden',
            TONE_DOT[tone],
          )}
        />
      ) : null}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', TONE_DOT[tone])} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Work is happening: a crawl, a training run, a streaming reply.
 *
 * The brand mark is a C made of three dots — a bubble mid-typing — so the
 * product's own glyph, animating, is its progress language. This is the whole
 * reason the palette needs no "in progress" hue.
 */
export function WorkingDots({ label, className }: { label: string; className?: string }) {
  return (
    <span role="status" aria-live="polite" className={cn('inline-flex items-center gap-1', className)}>
      <span aria-hidden className="flex items-center gap-0.5">
        <span className="typing-dot h-1 w-1 rounded-full bg-text-tertiary" />
        <span className="typing-dot h-1 w-1 rounded-full bg-text-tertiary" />
        <span className="typing-dot h-1 w-1 rounded-full bg-text-tertiary" />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
