import { type ComponentType, type ReactElement } from 'react';
import { cn } from '../lib/cn';

/**
 * Any component that renders like a Lucide icon: takes `size`/`className` and
 * (optionally) `strokeWidth`. Lucide icons satisfy this, and so do the filled
 * brand glyphs in `../icons/brand` (though those render as their own full tile,
 * not inside an `IconTile`).
 */
export type TileIcon = ComponentType<{
  size?: number | string;
  className?: string;
  strokeWidth?: number;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;

export type IconTileTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export type IconTileSize = 'xs' | 'sm' | 'md' | 'lg';

export interface IconTileProps {
  /** The glyph - a Lucide icon or a brand glyph. */
  icon: TileIcon;
  /** Semantic color of the glyph + hairline edge. Defaults to `neutral`. */
  tone?: IconTileTone;
  /** Footprint. Defaults to `md` (40px). */
  size?: IconTileSize;
  /** `rounded` = a soft-square key (default); `circle` = a timeline/status node. */
  shape?: 'rounded' | 'circle';
  /** Spin the glyph (loading / training states). */
  spin?: boolean;
  /** Screen-reader label. Omit for purely decorative tiles (the default). */
  srLabel?: string;
  className?: string;
}

/**
 * IconTile - the single icon-container primitive for the platform.
 *
 * It deliberately rejects the "flat pastel square with a matching-color glyph"
 * pattern (the tell-tale look of generated UI). Instead each tile is a small
 * physical *key*: a surface-matched face with a whisper of top-to-bottom
 * gradient, a hairline edge tinted by tone that catches light, and a soft
 * shadow for lift. Color lives in the **glyph and the edge**, never a saturated
 * fill - the Linear / Stripe / Vercel treatment. One primitive, used everywhere,
 * so the whole product reads as one intentional system.
 */
export function IconTile({
  icon: Icon,
  tone = 'neutral',
  size = 'md',
  shape = 'rounded',
  spin = false,
  srLabel,
  className,
}: IconTileProps): ReactElement {
  const dims = SIZES[size];
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center',
        'bg-gradient-to-b from-[var(--ds-bg-surface)] to-[var(--ds-bg-sunken)]',
        'shadow-[var(--ds-shadow-sm)] ring-1 ring-inset',
        dims.box,
        shape === 'circle' ? 'rounded-full' : dims.radius,
        TONE_RING[tone],
        TONE_TEXT[tone],
        className,
      )}
    >
      <Icon
        size={dims.icon}
        strokeWidth={1.75}
        className={cn('shrink-0', spin && 'animate-spin')}
        aria-hidden={srLabel ? undefined : true}
      />
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
    </span>
  );
}

const SIZES: Record<IconTileSize, { box: string; radius: string; icon: number }> = {
  xs: { box: 'h-6 w-6', radius: 'rounded-[7px]', icon: 13 },
  sm: { box: 'h-8 w-8', radius: 'rounded-[9px]', icon: 15 },
  md: { box: 'h-10 w-10', radius: 'rounded-[11px]', icon: 18 },
  lg: { box: 'h-12 w-12', radius: 'rounded-[13px]', icon: 22 },
};

/** Tone → hairline edge. A tinted ring at low opacity reads as a lit bevel. */
const TONE_RING: Record<IconTileTone, string> = {
  neutral: 'ring-[var(--ds-border-strong)]/60',
  accent: 'ring-[var(--ds-accent)]/30',
  success: 'ring-[var(--ds-success)]/35',
  warning: 'ring-[var(--ds-warning)]/35',
  danger: 'ring-[var(--ds-danger)]/35',
  info: 'ring-[var(--ds-info)]/35',
};

/** Tone → glyph color. The color the tile actually broadcasts. */
const TONE_TEXT: Record<IconTileTone, string> = {
  neutral: 'text-[var(--ds-text-muted)]',
  accent: 'text-[var(--ds-accent-text)]',
  success: 'text-[var(--ds-success)]',
  warning: 'text-[var(--ds-warning)]',
  danger: 'text-[var(--ds-danger)]',
  info: 'text-[var(--ds-info)]',
};
