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
 */
const TONE_STYLE: Record<Tone, string> = {
  neutral: 'border-border bg-surface-sunken text-text-primary border-l-[3px] border-l-ink',
  success: 'border-success/25 bg-success-tint text-success',
  warning: 'border-warning/25 bg-warning-tint text-warning',
  danger: 'border-danger/25 bg-danger-tint text-danger',
  plan: 'border-plan/25 bg-plan-tint text-plan',
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
 * consequential prose in the console its least readable.
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
  return (
    <div
      data-tone={tone}
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5',
        TONE_STYLE[tone],
        className,
      )}
    >
      <span className="mt-0.5 shrink-0">{icon ?? <Icon aria-hidden className="h-4 w-4" />}</span>
      <div className="min-w-0 flex-1 text-prose">
        {title ? <p className="font-medium">{title}</p> : null}
        <div className={cn(title && 'mt-0.5', 'text-text-secondary')}>{children}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
