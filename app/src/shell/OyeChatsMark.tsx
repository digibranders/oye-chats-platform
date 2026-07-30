import { type ReactElement } from 'react';
import { cn } from '../design-system';

export interface OyeChatsMarkProps {
  /** Rendered box size in px (square). */
  size?: number;
  className?: string;
}

/**
 * OyeChatsMark - the original brand glyph.
 *
 * The source PNG (`/oye_final.png`) is the full lockup (icon + wordmark); we
 * scale it up and translate so only the planet+bubble glyph sits inside the
 * bounding box. `invert dark:invert-0` keeps it legible on both themes: the
 * dark-on-transparent source is inverted to light in light mode and shown
 * as-is in dark mode.
 */
export function OyeChatsMark({ size = 32, className = '' }: OyeChatsMarkProps): ReactElement {
  return (
    <div
      role="img"
      aria-label="OyeChats"
      className={cn('relative shrink-0 overflow-hidden', className)}
      style={{ width: size, height: size }}
    >
      <img
        src="/oye_final.png"
        alt=""
        draggable={false}
        className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none invert dark:invert-0"
        style={{
          width: size * 3.2,
          height: size * 3.2,
          transform: 'translate(-50%, -42%)',
        }}
      />
    </div>
  );
}
