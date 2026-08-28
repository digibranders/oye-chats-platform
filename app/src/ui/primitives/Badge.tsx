import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
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

/**
 * `Badge` alone can also be ink.
 *
 * An ink chip is not a status — it is emphasis: a count on a filter, the
 * workspace's own name beside a list of others, "you" in a roster. It is scoped
 * to this component rather than added to `Tone` because `Tone` is the status
 * vocabulary that `Alert`, `StatusDot` and every `Record<Tone, …>` in the app
 * are keyed by, and emphasis is not a status.
 */
export type BadgeTone = Tone | 'ink';

const TONE_TINT: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-tint text-neutral',
  success: 'bg-success-tint text-success',
  warning: 'bg-warning-tint text-warning',
  danger: 'bg-danger-tint text-danger',
  plan: 'bg-plan-tint text-plan',
  ink: 'bg-ink text-text-inverse',
};

const TONE_DOT: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-fill',
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
  plan: 'bg-plan',
  ink: 'bg-text-inverse',
};

/**
 * One dot size for the whole system.
 *
 * `Badge`'s dot was 6px and `StatusDot` was 8px, so the same fact rendered at
 * two sizes in one table. 6px is right against 12px text; a `StatusDot` standing
 * on its own with no label beside it can ask for `md`.
 */
const DOT = { sm: 'h-1.5 w-1.5', md: 'h-2 w-2' } as const;

export interface BadgeProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  tone?: BadgeTone;
  children: ReactNode;
  /** Adds the tone's dot. Use on states a user scans for down a column. */
  dot?: boolean;
  /** `sm` (16px) for a table cell, `md` (20px) beside a heading. */
  size?: 'sm' | 'md';
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
 * **It forwards its ref and spreads the rest of its props**, which is what makes
 * that `Tooltip` sentence true. Base UI renders a trigger by cloning its child
 * with a ref and a full set of handlers; a component that accepts neither drops
 * all of them on the floor and the clone succeeds silently. A tooltip on a badge
 * therefore never opened, at any call site, and several review items were closed
 * as "not possible" because of it.
 *
 * `data-tone` is read by the forced-colors rule in the token layer, which gives
 * every tinted surface a border — Windows High Contrast strips backgrounds, and
 * without it all five tones render identically.
 *
 * **A badge is a 4px chip, not a pill.** DESIGN.md §4 says *"Full only for
 * avatars, badges and toggles"*; the code has always shipped `rounded-xs` and
 * the code is right — a 4px chip sits properly against a 6px input in a table
 * cell, where a pill reads as marketing. §4 should read *"4 chip and badge …
 * Full only for avatars, status dots and toggles"*.
 *
 * The height is a token and the glyphs are centred by `leading-none`, not by the
 * line box: `items-center` centres an 18px line box, and Inter's cap height sits
 * above that box's centre, so the label rendered about a pixel high — visibly
 * tilted next to a dot, which *is* geometrically centred. `leading-none` is the
 * single leading utility `scale.test.ts` still allows, and this is why: it is
 * not a choice of line-height competing with the type scale, it is the reset a
 * fixed-height inline chip needs in order to have no leading at all.
 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', children, dot = false, size = 'md', className, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      data-tone={tone}
      {...rest}
      className={cn(
        // Bounded, because a badge rendering a user-supplied value — a plan
        // name, a status straight off the API — will otherwise push a table
        // column open, and `whitespace-nowrap` guarantees it.
        'inline-flex max-w-40 items-center gap-1.5 rounded-xs px-1.5',
        'text-xs font-medium leading-none',
        size === 'sm' ? 'h-4' : 'h-5',
        TONE_TINT[tone],
        className,
      )}
    >
      {dot ? (
        <span aria-hidden className={cn('shrink-0 rounded-full', DOT.sm, TONE_DOT[tone])} />
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
});

export interface StatusDotProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  tone?: Tone;
  /**
   * A slow halo. Reserved for state that is genuinely live *right now* — an
   * operator online, a conversation in progress — never for "enabled". A pulse
   * that never stops stops meaning anything.
   */
  pulse?: boolean;
  /** Required: the dot is meaningless to anyone who cannot see it. */
  label: string;
  /** `sm` (6px) beside text, `md` (8px) standing alone. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A bare state dot, for places a full badge will not fit — an avatar corner, a
 * rail row, the head of a conversation list item.
 *
 * The label is required rather than optional because a dot with no accessible
 * name is decoration that happens to carry the most important fact on the row.
 */
export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { tone = 'neutral', pulse = false, label, size = 'md', className, ...rest },
  ref,
) {
  return (
    <span ref={ref} {...rest} className={cn('relative inline-flex shrink-0', DOT[size], className)}>
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
      <span className={cn('relative inline-flex rounded-full', DOT[size], TONE_DOT[tone])} />
      <span className="sr-only">{label}</span>
    </span>
  );
});

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
