import { type AvatarType } from '../../launch-studio/customize/AvatarPicker';

/**
 * The editable "Experience" model — everything that shapes what a visitor sees
 * in the chat widget, flattened from the raw bot/client settings into a single
 * typed draft the page can diff for unsaved-changes detection.
 *
 * Persistence maps back onto the exact fields the shipped widget reads (see the
 * legacy `pages/bot-settings/{AppearanceTab,MessagesTab,PersonalityTab}.jsx`),
 * so saving here renders identically to production.
 */
export interface ExperienceDraft {
  // ── Branding ───────────────────────────────────────────────────────────────
  primaryColor: string;
  userBubbleColor: string;
  avatarType: AvatarType;
  orbColor: string;
  botLogo: string | null;

  // ── Messages (widget_messages.*) ────────────────────────────────────────────
  welcomeGreeting: string;
  welcomeSubtitle: string;
  quickActions: string[];
  suggestionsLayout: SuggestionsLayout;
  inputPlaceholder: string;

  // ── Personality (bot.*) ─────────────────────────────────────────────────────
  systemPrompt: string;
  brandTone: string;
  companyName: string;
  companyDescription: string;

  /** Widget-message keys the page doesn't edit, preserved verbatim on save. */
  extraWidgetMessages: Record<string, unknown>;
}

export type SuggestionsLayout = 'horizontal' | 'vertical';

/** Backend field-length caps, mirrored so the UI blocks over-long input pre-save. */
export const FIELD_LIMITS = {
  systemPrompt: 2000,
  brandTone: 500,
  companyName: 100,
  companyDescription: 1000,
} as const;

const DEFAULTS = {
  primaryColor: '#ba68c8',
  userBubbleColor: '#DBE9FF',
  orbColor: '',
  welcomeGreeting: 'Hi there, how can I help you today?',
  welcomeSubtitle: 'Ask me anything — I answer from your knowledge base.',
  inputPlaceholder: 'Write a message…',
} as const;

/** Keys inside `widget_messages` that this page owns (everything else is preserved). */
const MANAGED_WIDGET_MESSAGE_KEYS = new Set([
  'welcome_greeting',
  'welcome_subtitle',
  'welcome_suggestions',
  'welcome_suggestions_layout',
  'input_placeholder',
]);

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function asAvatarType(value: unknown): AvatarType {
  return value === 'orb' || value === 'mascot' || value === 'upload' ? value : 'upload';
}

function asLayout(value: unknown): SuggestionsLayout {
  return value === 'vertical' ? 'vertical' : 'horizontal';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build the editable draft from the raw settings payload returned by
 * `getClientSettings(botId)`. Unknown / missing fields fall back to sensible
 * defaults so the form is always in a valid, editable state.
 */
export function draftFromSettings(raw: Record<string, unknown>): ExperienceDraft {
  const widgetMessages = asRecord(raw.widget_messages);
  const extraWidgetMessages: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(widgetMessages)) {
    if (!MANAGED_WIDGET_MESSAGE_KEYS.has(key)) extraWidgetMessages[key] = value;
  }

  return {
    primaryColor: asNonEmptyString(raw.primary_color, DEFAULTS.primaryColor),
    userBubbleColor: asNonEmptyString(raw.user_bubble_color, DEFAULTS.userBubbleColor),
    avatarType: asAvatarType(raw.avatar_type),
    orbColor: asString(raw.orb_color, DEFAULTS.orbColor),
    botLogo: typeof raw.bot_logo === 'string' && raw.bot_logo.length > 0 ? raw.bot_logo : null,

    welcomeGreeting: asNonEmptyString(widgetMessages.welcome_greeting, DEFAULTS.welcomeGreeting),
    welcomeSubtitle: asNonEmptyString(widgetMessages.welcome_subtitle, DEFAULTS.welcomeSubtitle),
    quickActions: asStringArray(widgetMessages.welcome_suggestions),
    suggestionsLayout: asLayout(widgetMessages.welcome_suggestions_layout),
    inputPlaceholder: asNonEmptyString(widgetMessages.input_placeholder, DEFAULTS.inputPlaceholder),

    systemPrompt: asString(raw.system_prompt),
    brandTone: asString(raw.brand_tone),
    companyName: asString(raw.company_name),
    companyDescription: asString(raw.company_description),

    extraWidgetMessages,
  };
}

/**
 * Serialise the draft into the PATCH body for `updateClientSettings(_, botId)`.
 * Empty quick-action rows (kept while editing) are dropped, and `launcher_logo`
 * mirrors `bot_logo` exactly as the legacy Customize flow does.
 */
export function settingsFromDraft(draft: ExperienceDraft): Record<string, unknown> {
  const welcomeSuggestions = draft.quickActions.map((s) => s.trim()).filter((s) => s.length > 0);

  return {
    primary_color: draft.primaryColor,
    user_bubble_color: draft.userBubbleColor,
    avatar_type: draft.avatarType,
    orb_color: draft.orbColor || null,
    bot_logo: draft.botLogo,
    launcher_logo: draft.botLogo,

    widget_messages: {
      ...draft.extraWidgetMessages,
      welcome_greeting: draft.welcomeGreeting,
      welcome_subtitle: draft.welcomeSubtitle,
      welcome_suggestions: welcomeSuggestions,
      welcome_suggestions_layout: draft.suggestionsLayout,
      input_placeholder: draft.inputPlaceholder,
    },

    system_prompt: draft.systemPrompt,
    brand_tone: draft.brandTone,
    company_name: draft.companyName,
    company_description: draft.companyDescription,
  };
}

/** Structural equality used for unsaved-changes detection. */
export function draftsEqual(a: ExperienceDraft, b: ExperienceDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
