import { DEFAULT_PRIMARY_COLOR, DEFAULT_USER_BUBBLE_COLOR } from './widgetTheme';

/**
 * How a chatbot paints itself, and how to read that off a `Bot`.
 *
 * Its own module rather than part of `WidgetTranscript` because a file that
 * exports both components and plain functions loses fast refresh, and both
 * callers want the function without the component: the Experience page builds
 * an appearance from the draft being edited, the Leads drawer from the chatbot
 * that captured the lead.
 */

/** How a chatbot paints itself. `appearanceFromBot` builds it from a `Bot`. */
export interface WidgetAppearance {
  primaryColor: string;
  userBubbleColor: string;
  /** `upload` uses `botLogo`; `orb` uses `orbColor`; `mascot` is the glyph. */
  avatarType: 'upload' | 'orb' | 'mascot' | null;
  botLogo: string | null;
  orbColor: string | null;
}

export const DEFAULT_APPEARANCE: WidgetAppearance = {
  primaryColor: DEFAULT_PRIMARY_COLOR,
  userBubbleColor: DEFAULT_USER_BUBBLE_COLOR,
  avatarType: null,
  botLogo: null,
  orbColor: null,
};

/** The appearance fields, as the bots endpoint sends them. */
export interface AppearanceSource {
  primary_color?: string | null;
  user_bubble_color?: string | null;
  avatar_type?: string | null;
  bot_logo?: string | null;
  orb_color?: string | null;
}

/**
 * A chatbot's appearance, or the widget's defaults when it has none.
 *
 * `null` is a real input: a lead outlives the chatbot that captured it, and a
 * conversation from a deleted chatbot still has to render. The widget's own
 * fallbacks are what it renders in.
 */
export function appearanceFromBot(bot: AppearanceSource | null | undefined): WidgetAppearance {
  if (!bot) return DEFAULT_APPEARANCE;
  const avatar = bot.avatar_type;
  return {
    primaryColor: bot.primary_color || DEFAULT_PRIMARY_COLOR,
    userBubbleColor: bot.user_bubble_color || DEFAULT_USER_BUBBLE_COLOR,
    avatarType: avatar === 'upload' || avatar === 'orb' || avatar === 'mascot' ? avatar : null,
    botLogo: bot.bot_logo ?? null,
    orbColor: bot.orb_color ?? null,
  };
}
