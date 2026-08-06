import { type ReactNode } from 'react';
import { cn, IconTile, type TileIcon } from '../../../design-system';

/** Semantic tint for a channel's leading glyph. */
export type ChannelIconTone = 'accent' | 'success' | 'info' | 'neutral';

export interface ChannelCardProps {
  /** Channel glyph (Website / Meetings / WhatsApp …) — Lucide icon or brand glyph. */
  icon: TileIcon;
  /** Tint of the glyph. Defaults to `accent`. */
  iconTone?: ChannelIconTone;
  /** Set for self-colored brand glyphs (WhatsApp / Messenger) so tone won't recolor them. */
  brand?: boolean;
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
  brand = false,
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
        {brand ? (
          <span className="inline-flex h-10 w-10 shrink-0 overflow-hidden rounded-[11px] shadow-[var(--ds-shadow-sm)] ring-1 ring-inset ring-[var(--ds-border-strong)]/30">
            <Icon size={40} aria-hidden="true" />
          </span>
        ) : (
          <IconTile icon={Icon} tone={iconTone} size="md" />
        )}
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
