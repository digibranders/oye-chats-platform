import { type AvatarType } from '../../launch-studio/customize/AvatarPicker';

/**
 * The editable "Experience" model - everything that shapes what a visitor sees
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
  /** `feature_flags.show_branding` - true shows the "Powered by OyeChats"
   * footer. Only a workspace with the `branding_removable` plan feature can
   * turn this off; the backend force-sets it back to `true` on save
   * otherwise (see `bot_routes.py` `_plan_branding_removable`). */
  showBranding: boolean;

  // ── Messages (widget_messages.*) ────────────────────────────────────────────
  welcomeGreeting: string;
  welcomeSubtitle: string;
  quickActions: string[];
  suggestionsLayout: SuggestionsLayout;
  inputPlaceholder: string;

  // ── Widget identity (bot.*) ─────────────────────────────────────────────────
  /** `bot.name` - the display name shown in the widget header. The shipped
   * widget reads its header/launcher name straight from `bot.name` (see the
   * `/bots/{id}/config` response in `bot_routes.py`, which returns
   * `"bot_name": bot.name`), so this doubles as the agent name. */
  displayName: string;
  /** `bot.launcher_name` - the "Have Questions?" tooltip beside the launcher. */
  launcherName: string;

  // ── Personality (bot.*) ─────────────────────────────────────────────────────
  systemPrompt: string;
  brandTone: string;
  /** `bot.brand_tone_preset` - the active tone-preset key, `'custom'`, or null. */
  brandTonePreset: string | null;
  companyName: string;
  companyDescription: string;

  /** Widget-message keys the page doesn't edit, preserved verbatim on save. */
  extraWidgetMessages: Record<string, unknown>;
}

export type SuggestionsLayout = 'horizontal' | 'vertical';

/**
 * Field-length caps. `systemPrompt`/`brandTone`/`companyName`/`companyDescription`
 * mirror the backend `UpdateBotRequest` caps exactly; `displayName`/`launcherName`
 * have no server-side cap, so these are sensible UI guides that keep the header
 * and launcher tooltip readable.
 */
export const FIELD_LIMITS = {
  displayName: 60,
  launcherName: 40,
  systemPrompt: 2000,
  brandTone: 500,
  companyName: 100,
  companyDescription: 1000,
} as const;

const DEFAULTS = {
  primaryColor: '#ba68c8',
  userBubbleColor: '#DBE9FF',
  orbColor: '',
  launcherName: 'Have Questions?',
  welcomeGreeting: 'Hi there, how can I help you today?',
  welcomeSubtitle: 'Ask me anything - I answer from your knowledge base.',
  inputPlaceholder: 'Write a message…',
} as const;

/**
 * Keys inside `widget_messages` that the Experience page owns, so they must NOT
 * ride the appearance/messages passthrough (`extraWidgetMessages`). Two groups:
 *
 * 1. Appearance-owned - `settingsFromDraft` (this file) re-writes these on every
 *    save from the current draft.
 * 2. Copy-owned - the WidgetCopyCard (`BotConfigSection`) is their SOLE writer,
 *    persisting them via its own `copyPatch` slice. They are excluded here only
 *    so the appearance save never re-sends a stale page-load snapshot of them;
 *    the backend deep-merges `widget_messages`, so leaving them out of the
 *    appearance PATCH keeps the copy card's values intact.
 */
const MANAGED_WIDGET_MESSAGE_KEYS = new Set([
  // Appearance-owned (written by settingsFromDraft below)
  'welcome_greeting',
  'welcome_subtitle',
  'welcome_suggestions',
  'welcome_suggestions_layout',
  'input_placeholder',
  // Copy-owned (written only by BotConfigSection's WidgetCopyCard / copyPatch)
  'offline_message',
  'live_chat_label',
  'greeting_message',
  'rating_prompt',
  'end_chat_label',
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

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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
  const featureFlags = asRecord(raw.feature_flags);

  return {
    primaryColor: asNonEmptyString(raw.primary_color, DEFAULTS.primaryColor),
    userBubbleColor: asNonEmptyString(raw.user_bubble_color, DEFAULTS.userBubbleColor),
    avatarType: asAvatarType(raw.avatar_type),
    orbColor: asString(raw.orb_color, DEFAULTS.orbColor),
    botLogo: typeof raw.bot_logo === 'string' && raw.bot_logo.length > 0 ? raw.bot_logo : null,
    showBranding: asBoolean(featureFlags.show_branding, true),

    welcomeGreeting: asNonEmptyString(widgetMessages.welcome_greeting, DEFAULTS.welcomeGreeting),
    welcomeSubtitle: asNonEmptyString(widgetMessages.welcome_subtitle, DEFAULTS.welcomeSubtitle),
    quickActions: asStringArray(widgetMessages.welcome_suggestions),
    suggestionsLayout: asLayout(widgetMessages.welcome_suggestions_layout),
    inputPlaceholder: asNonEmptyString(widgetMessages.input_placeholder, DEFAULTS.inputPlaceholder),

    displayName: asString(raw.name),
    launcherName: asNonEmptyString(raw.launcher_name, DEFAULTS.launcherName),

    systemPrompt: asString(raw.system_prompt),
    brandTone: asString(raw.brand_tone),
    brandTonePreset: typeof raw.brand_tone_preset === 'string' ? raw.brand_tone_preset : null,
    companyName: asString(raw.company_name),
    companyDescription: asString(raw.company_description),

    extraWidgetMessages,
  };
}

/**
 * Serialise the draft into the PATCH body for `updateClientSettings(_, botId)`.
 * Empty quick-action rows (kept while editing) are dropped, and `launcher_logo`
 * mirrors `bot_logo` exactly as the legacy Customize flow does.
 *
 * `baseline` is the draft as loaded from the server. When it is supplied and
 * the avatar image is unchanged, `bot_logo` / `launcher_logo` are omitted so
 * the PATCH (`exclude_unset=True`) leaves the stored value alone. A crawl can
 * set the agent's avatar from the site's favicon while this editor is open,
 * and re-sending the value this page loaded before that happened writes the
 * derived avatar back off. Removing the avatar here is still a change, so it
 * is still sent — the guard is on "unchanged", not on "empty".
 */
export function settingsFromDraft(
  draft: ExperienceDraft,
  baseline?: ExperienceDraft | null,
): Record<string, unknown> {
  const avatarImageChanged = !baseline || baseline.botLogo !== draft.botLogo;
  const welcomeSuggestions = draft.quickActions.map((s) => s.trim()).filter((s) => s.length > 0);
  const displayName = draft.displayName.trim();

  return {
    // The widget header/launcher name is `bot.name`; persist it here. Guarded so
    // a momentarily-empty field can never blank the agent name server-side - the
    // editor also enforces non-empty, but this is the durable safeguard.
    ...(displayName.length > 0 ? { name: displayName } : {}),
    launcher_name: draft.launcherName,
    brand_tone_preset: draft.brandTonePreset,

    primary_color: draft.primaryColor,
    user_bubble_color: draft.userBubbleColor,
    avatar_type: draft.avatarType,
    orb_color: draft.orbColor || null,
    ...(avatarImageChanged ? { bot_logo: draft.botLogo, launcher_logo: draft.botLogo } : {}),
    // Partial-merged server-side (bot_routes.py PATCH /bots/{id}) - other
    // stored feature flags (managed on the Advanced tab) are untouched.
    feature_flags: { show_branding: draft.showBranding },

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
