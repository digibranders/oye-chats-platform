import { type CSSProperties, type ReactElement } from 'react';
import { Bot as BotIcon } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * BotAvatar - renders an AI agent's identity mark exactly as the visitor-facing
 * widget does, honouring the avatar the customer chose in Experience:
 *
 *   - `avatar_type === 'upload'` (default): the uploaded `bot_logo` image, or a
 *     robot glyph on the brand colour when no image is set.
 *   - `avatar_type === 'orb'`: a soft radial-gradient orb tinted with
 *     `orb_color` (falling back to `primary_color`). This is the lightweight
 *     admin twin of the widget's animated `PremiumOrb` - same hue, no WebGL.
 *   - `avatar_type === 'mascot'`: a robot glyph on the brand colour.
 *
 * Kept in the design system so every surface that shows an agent (grid card,
 * Overview hero, agent header) renders one identical mark instead of drifting
 * letter-initials or a generic icon.
 */

/** Fields BotAvatar reads off a Bot. Loosely typed so any Bot-shaped object fits. */
export interface BotAvatarSource {
  readonly name?: string;
  readonly avatar_type?: string | null;
  readonly bot_logo?: string | null;
  readonly orb_color?: string | null;
  readonly primary_color?: string | null;
}

export interface BotAvatarProps {
  readonly bot: BotAvatarSource;
  /** Rendered edge length in px (square container). Default 40. */
  readonly size?: number;
  /** Corner rounding. `full` = circle; otherwise a squircle that matches the
   *  surrounding card radii. Default `lg`. */
  readonly radius?: 'lg' | 'xl' | 'full';
  readonly className?: string;
}

const RADIUS_CLASS: Record<NonNullable<BotAvatarProps['radius']>, string> = {
  lg: 'rounded-lg',
  xl: 'rounded-2xl',
  full: 'rounded-full',
};

const DEFAULT_BRAND = '#6366f1';
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Accept a valid `#rgb`/`#rrggbb` hex only; otherwise fall back. Guards against
 *  malformed stored colours becoming an invalid inline style. */
function safeColor(value: string | null | undefined, fallback: string): string {
  if (typeof value === 'string' && HEX_RE.test(value.trim())) return value.trim();
  return fallback;
}

/** Treat only a real, non-"null" URL string as a usable logo. The widget stores
 *  the literal string "null" in some legacy rows, so guard against it. */
function usableLogo(botLogo: string | null | undefined): string | null {
  if (typeof botLogo !== 'string') return null;
  const trimmed = botLogo.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed;
}

export function BotAvatar({
  bot,
  size = 40,
  radius = 'lg',
  className,
}: BotAvatarProps): ReactElement {
  const dimension: CSSProperties = { width: size, height: size };
  const roundClass = RADIUS_CLASS[radius];
  const brand = safeColor(bot.primary_color, DEFAULT_BRAND);
  const avatarType = bot.avatar_type || 'upload';
  const glyphSize = Math.round(size * 0.5);

  // Orb: soft radial gradient tinted with the chosen orb colour.
  if (avatarType === 'orb') {
    const orb = safeColor(bot.orb_color, brand);
    return (
      <span
        aria-hidden="true"
        style={{
          ...dimension,
          background: `radial-gradient(circle at 38% 34%, ${orb}, ${orb}33 68%, ${orb}14 100%)`,
        }}
        className={cn('inline-block shrink-0 rounded-full', className)}
      />
    );
  }

  // Uploaded logo (default avatar type) - render the image when present.
  const logo = avatarType === 'mascot' ? null : usableLogo(bot.bot_logo);
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        style={dimension}
        className={cn('shrink-0 object-cover', roundClass, className)}
      />
    );
  }

  // Mascot, or upload with no image yet: robot glyph on the brand colour.
  return (
    <span
      aria-hidden="true"
      style={{ ...dimension, backgroundColor: brand }}
      className={cn('inline-flex shrink-0 items-center justify-center text-white', roundClass, className)}
    >
      <BotIcon size={glyphSize} />
    </span>
  );
}
