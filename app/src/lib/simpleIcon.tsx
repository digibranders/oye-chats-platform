import type { ReactNode } from 'react';
import type { SimpleIcon } from 'simple-icons';

/**
 * Render a Simple Icons brand mark inline (single-path, 24×24), so brand logos
 * cost no runtime fetch and the tree-shaker keeps only the ones we name.
 *
 * A mark whose hex is near-black or near-white is a *monochrome* logo — those
 * ship a light variant for dark backgrounds, so `currentColor` is both the
 * brand-correct rendering and the only one that stays visible in both themes.
 * Coloured marks (React cyan, Calendly blue, …) keep their own hex.
 */
function brandFill(hex: string): string {
  const value = parseInt(hex, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.12 || luminance > 0.9 ? 'currentColor' : `#${hex}`;
}

export function simpleIconNode(icon: SimpleIcon, className = 'h-4 w-4 shrink-0'): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden style={{ fill: brandFill(icon.hex) }}>
      <path d={icon.path} />
    </svg>
  );
}
