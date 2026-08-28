import { cn } from '../ui';

export interface OyeChatsMarkProps {
  /** Rendered box size in px (square). */
  size?: number;
  /**
   * Rendered on the ink rail rather than on paper.
   *
   * The mark is a solid ink `C`, so on a near-black ground the dark asset
   * disappears entirely; the light asset is the same glyph knocked out.
   */
  onInk?: boolean;
  className?: string;
}

/** The brand glyph: a `C` of three dots — a speech bubble mid-typing. */
export function OyeChatsMark({ size = 28, onInk = false, className }: OyeChatsMarkProps) {
  return (
    <img
      src={onInk ? '/logo-dark.png' : '/logo-light.png'}
      // @i18n-exempt: the product wordmark. A brand name is identical in every
      // language, and this labels the logo rather than describing copy.
      alt="OyeChats"
      width={size}
      height={size}
      draggable={false}
      className={cn('pointer-events-none shrink-0 select-none object-contain', className)}
      style={{ width: size, height: size }}
    />
  );
}
