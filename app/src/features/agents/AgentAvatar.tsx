import { Bot as BotIcon } from 'lucide-react';
import { Avatar, cn, type AvatarSize } from '../../ui';
import { isHexColor } from './experience/contrast';

/**
 * A chatbot's identity mark, rendered the way its own visitors see it.
 *
 * The console used to draw a chatbot as letter-initials tinted from its name,
 * which meant every surface showed a mark the customer never chose and which
 * matched nothing in their widget. Worse, it was the same shape for all of
 * them: a workspace with six chatbots got six coloured squares, and the reader
 * had to read the label every time to tell which was which — the exact job an
 * avatar exists to save them.
 *
 * This honours the choice made in Experience, and the three cases are three
 * genuinely different marks:
 *
 * - `upload` (the default) renders the uploaded logo, and falls back to the
 *   glyph below when there is not one yet.
 * - `orb` renders the same hue as the widget's animated orb, as a flat radial
 *   gradient. No WebGL: this is a 24px square in a table cell.
 * - `mascot` renders the glyph on the brand colour, ignoring any stale upload.
 *
 * It lives beside the chatbot feature rather than in `src/ui` because it knows
 * what an `avatar_type` is. A visual primitive that has to be taught the
 * product's data model is not a primitive.
 */

/** The fields this reads off a chatbot. Loose, so any chatbot-shaped row fits. */
export interface AgentAvatarSource {
  readonly name?: string | null;
  readonly avatar_type?: string | null;
  readonly bot_logo?: string | null;
  readonly orb_color?: string | null;
  readonly primary_color?: string | null;
}

export interface AgentAvatarProps {
  agent: AgentAvatarSource;
  size?: AvatarSize;
  className?: string;
}

const BOX: Record<AvatarSize, string> = {
  xs: 'h-5 w-5',
  sm: 'h-6 w-6',
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
};

const ROUND: Record<AvatarSize, string> = {
  xs: 'rounded-xs',
  sm: 'rounded-xs',
  md: 'rounded-sm',
  lg: 'rounded-md',
};

const GLYPH: Record<AvatarSize, number> = { xs: 12, sm: 14, md: 18, lg: 22 };

const DEFAULT_BRAND = '#2B66BC';

function safeColor(value: string | null | undefined, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return isHexColor(trimmed) ? trimmed : fallback;
}

/**
 * Only a real URL counts as a logo.
 *
 * Legacy rows store the literal four characters `null`, which is a truthy
 * string and rendered as a broken image on every surface that trusted it.
 */
function usableLogo(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return !trimmed || trimmed === 'null' ? null : trimmed;
}

export function AgentAvatar({ agent, size = 'sm', className }: AgentAvatarProps) {
  const brand = safeColor(agent.primary_color, DEFAULT_BRAND);
  const type = agent.avatar_type || 'upload';

  if (type === 'orb') {
    const orb = safeColor(agent.orb_color, brand);
    return (
      <span
        aria-hidden
        style={{
          background: `radial-gradient(circle at 38% 34%, ${orb}, ${orb}33 68%, ${orb}14 100%)`,
        }}
        className={cn('inline-block shrink-0 rounded-full', BOX[size], className)}
      />
    );
  }

  const logo = type === 'mascot' ? null : usableLogo(agent.bot_logo);
  if (logo) {
    // `Avatar` rather than a bare `<img>`: it already handles the load-failure
    // fallback without a flash of initials behind a good image.
    return (
      <Avatar
        name={agent.name ?? 'Chatbot'}
        src={logo}
        size={size}
        shape="rounded"
        className={className}
      />
    );
  }

  return (
    <span
      aria-hidden
      style={{ backgroundColor: brand }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-text-inverse',
        BOX[size],
        ROUND[size],
        className,
      )}
    >
      <BotIcon size={GLYPH[size]} />
    </span>
  );
}
