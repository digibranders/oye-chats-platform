import { type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from '../../../design-system';

/** Semantic tint for a channel's leading glyph. */
export type ChannelIconTone = 'accent' | 'success' | 'info' | 'neutral';

const iconToneStyles: Record<ChannelIconTone, string> = {
  accent: 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]',
  success: 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]',
  info: 'bg-[var(--ds-info-soft)] text-[var(--ds-info)]',
  neutral: 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]',
};

export interface ChannelCardProps {
  /** Channel glyph (Website / Meetings / WhatsApp …). */
  icon: LucideIcon;
  /** Tint of the glyph. Defaults to `accent`. */
  iconTone?: ChannelIconTone;
  /** Channel name, e.g. "Website". */
  name: string;
  /** One line on what this channel does. */
  description: string;
  /** Right-aligned status pill (usually a `<StatusBadge>`). */
  status?: ReactNode;
  /** Controls beneath the header (toggle button, links, inline errors). */
  action?: ReactNode;
  /** Expandable detail body rendered under a divider. */
  children?: ReactNode;
  className?: string;
}

/** Stable, DOM-id-safe slug derived from the channel name (used to name the landmark). */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'channel'
  );
}

/**
 * ChannelCard - one connection surface on the Channels tab. Presentational
 * only: a glyph, the channel name + description, an optional status pill, an
 * optional action row, and optional detail content. Rendered as a `<section>`
 * named by its heading via `aria-labelledby`, so each channel is a genuine
 * addressable landmark region for assistive tech.
 */
export function ChannelCard({
  icon: Icon,
  iconTone = 'accent',
  name,
  description,
  status,
  action,
  children,
  className,
}: ChannelCardProps) {
  const headingId = `channel-${slugify(name)}-title`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-sm)]',
        className,
      )}
    >
      <div className="flex items-start gap-4 p-5">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            iconToneStyles[iconTone],
          )}
          aria-hidden="true"
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id={headingId} className="text-[15px] font-semibold text-[var(--ds-text)]">
                {name}
              </h3>
              <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
                {description}
              </p>
            </div>
            {status ? <div className="shrink-0">{status}</div> : null}
          </div>
          {action ? <div className="mt-3.5">{action}</div> : null}
        </div>
      </div>
      {children ? (
        <div className="border-t border-[var(--ds-border)] p-5">{children}</div>
      ) : null}
    </section>
  );
}
