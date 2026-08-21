import { type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, Sparkles, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import type { Tone } from '../primitives/Badge';

/**
 * The neutral tone gets an ink leading rule rather than a tint.
 *
 * `--surface-sunken` is also the toolbar, the table head and a code block, so a
 * neutral notice painted with it has no presence at all — it reads as an
 * unstyled well rather than as a notice. The rule is what makes it a message,
 * and it is why this system needs no `info` hue (which would have had to be
 * blue, colliding with the interactive accent).
 *
 * **The rule is a block, not a border.** It was `border-l-[3px]`, and CSS mitres
 * a border into the corner arc of a rounded box: on an 8px radius a 3px left
 * border tapers to a point at both ends and reads as a smudge rather than as a
 * deliberate rule. The signature element of the system's own notice was visibly
 * broken in every place it appeared. Drawn as a `::before` block inside an
 * `overflow-hidden` box, it squares off against the rounded edge cleanly.
 *
 * **The tinted tones carry no visible border.** They had `border-success/25` and
 * friends — a token at 25% over its own tint measures about 1.3:1, which is not
 * a boundary, and it is the same banned pattern as an opacity modifier on a text
 * token. The honest choices were a mid-strength tint-border token per tone,
 * which the token layer does not have, or none at all. None: the tint carries
 * the tone, the geometry stays identical to the neutral case because the border
 * is still 1px of transparent, and the `[data-tone]` rule at the bottom of
 * `tokens.css` already draws a real border in forced-colors mode, which is the
 * only place the edge is load-bearing.
 */
const TONE_STYLE: Record<Tone, string> = {
  neutral: cn(
    'border-border bg-surface-sunken text-text-primary',
    'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-ink before:content-[""]',
  ),
  success: 'border-transparent bg-success-tint text-success',
  warning: 'border-transparent bg-warning-tint text-warning',
  danger: 'border-transparent bg-danger-tint text-danger',
  plan: 'border-transparent bg-plan-tint text-plan',
};

const TONE_ICON: Record<Tone, typeof Info> = {
  neutral: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: AlertCircle,
  plan: Sparkles,
};

export interface AlertProps {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  /** A single control — Retry, Upgrade, Dismiss. Sits at the end of the row. */
  action?: ReactNode;
  /**
   * Announce the message when it appears.
   *
   * Defaults to `false`, so a page carrying three notices on load does not read
   * all three aloud before the user has reached them. Pass `true` for the
   * outcome of something the user just did — without it, a screen-reader user
   * has no way to know whether the action worked.
   */
  live?: boolean;
  icon?: ReactNode;
  className?: string;
}

/**
 * An inline message, anchored to the thing it is about.
 *
 * This is where anything the user must read in order to proceed belongs. A toast
 * confirms; an alert explains — so a failed save, a plan limit, or a degraded
 * crawl stays on the page, beside the control that produced it, until it is
 * resolved.
 *
 * The body is `text-prose`, not the smallest size in the system. An earlier
 * version set the title at 14 and the body — the part carrying "your card was
 * declined and your chatbot has stopped answering" — at 12, which made the most
 * consequential prose in the console its least readable. For the same reason the
 * body is no longer forced to `--text-secondary`: the measured table in
 * DESIGN.md §2.6 guarantees "status text on its own tint", and the body is the
 * half that most needs that guarantee. Hierarchy is weight, not colour.
 *
 * On a tinted ground the action is transparent with the tone's own edge, and
 * lifts to the surface colour on hover. A `bg-surface` button at rest on a tint
 * is a white rectangle that reads as a rendering seam — which is what the "Buy
 * credits" and "Update card" buttons looked like in the gallery.
 */
export function Alert({
  tone = 'neutral',
  title,
  children,
  action,
  live = false,
  icon,
  className,
}: AlertProps) {
  const Icon = TONE_ICON[tone];
  const actionNode = action ? (
    <div
      className={cn(
        'shrink-0',
        tone !== 'neutral' &&
          '[&_button]:border-current [&_button]:bg-transparent [&_button]:text-current [&_button]:hover:bg-surface',
      )}
    >
      {action}
    </div>
  ) : null;

  return (
    <div
      data-tone={tone}
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      className={cn(
        'relative flex items-start gap-2.5 overflow-hidden rounded-md border px-3 py-3',
        TONE_STYLE[tone],
        className,
      )}
    >
      {/* 4px, not 2: optically centring a 16px glyph in a 24px `text-prose`
          line box needs (24 − 16) / 2. */}
      <span className="mt-1 shrink-0">
        {icon ?? <Icon aria-hidden className="h-icon-md w-icon-md" />}
      </span>
      <div className="min-w-0 flex-1 text-prose">
        {title ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
              <p className="font-medium">{title}</p>
              {actionNode}
            </div>
            <div className="mt-1">{children}</div>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <div className="min-w-0 flex-1">{children}</div>
            {actionNode}
          </div>
        )}
      </div>
    </div>
  );
}
