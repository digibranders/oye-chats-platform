import { type ReactElement } from 'react';
import { cn } from '../design-system';

export interface OyeChatsMarkProps {
  /** Rendered box size in px (square). */
  size?: number;
  className?: string;
}

/**
 * OyeChatsMark - the brand glyph, theme-aware.
 *
 * Two purpose-made logos (transparent background): `logo-light.png` for light
 * mode and `logo-dark.png` for dark mode. Both render, and Tailwind's
 * class-based `dark:` variant toggles which is visible, so the mark always has
 * contrast against the sidebar. Rendered `object-contain` (no invert/crop).
 */
export function OyeChatsMark({ size = 32, className = '' }: OyeChatsMarkProps): ReactElement {
  return (
    <div
      role="img"
      // i18n-exempt: the product wordmark. A brand name is identical in every
      // language, and this labels the logo rather than describing copy.
      aria-label="OyeChats"
      className={cn('relative shrink-0 overflow-hidden', className)}
      style={{ width: size, height: size }}
    >
      <img
        src="/logo-light.png?v=6"
        alt=""
        draggable={false}
        className="pointer-events-none h-full w-full select-none object-contain block dark:hidden"
      />
      <img
        src="/logo-dark.png?v=6"
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain hidden dark:block"
      />
    </div>
  );
}
