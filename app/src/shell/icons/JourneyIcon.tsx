import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * JourneyIcon — custom sidebar glyph for the /journey route. Renders
 * the "two circles connected by a right-angle path to a third circle"
 * shape (a compact journey/tree waypoint) matching the reference
 * screenshot. Signature mirrors LucideIcon so it drops straight into
 * `NavItem.icon` without any type widening.
 *
 * ViewBox is the 24×24 lucide standard; strokeWidth defaults to 2 and
 * every stroke honours `currentColor` so it inherits the surrounding
 * sidebar text colour (active/inactive/hover) without per-instance
 * overrides.
 */
export const JourneyIcon = forwardRef<SVGSVGElement, LucideProps>(function JourneyIcon(
  {
    color = 'currentColor',
    size = 24,
    strokeWidth = 2,
    absoluteStrokeWidth,
    ...rest
  },
  ref,
) {
  const stroke = absoluteStrokeWidth
    ? (Number(strokeWidth) * 24) / Number(size)
    : strokeWidth;
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {/* Top-left node */}
      <circle cx="6" cy="6" r="3" />
      {/* Vertical link from top-left → bottom-left */}
      <line x1="6" y1="9" x2="6" y2="15" />
      {/* Bottom-left node (smaller so it reads as a joint) */}
      <circle cx="6" cy="17" r="2" />
      {/* Horizontal link from bottom-left → right */}
      <line x1="8" y1="17" x2="15" y2="17" />
      {/* Right node */}
      <circle cx="17" cy="17" r="3" />
    </svg>
  );
});

JourneyIcon.displayName = 'JourneyIcon';
