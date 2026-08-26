/**
 * Local data model for the three bot-config surfaces the Experience page owns
 * beyond the shared appearance/messages draft: live-chat handoff (#7),
 * the pre-chat lead-capture form (#10), the services answer-scope whitelist
 * and the remaining widget-copy strings (#11).
 *
 * These fields live directly on the `Bot` record (not on the client-settings
 * draft that `types.ts` manages), so they load via `getBot(botId)` and persist
 * via `updateBot(botId, …)` - each surface saving its own slice independently.
 * The `Bot` domain type is intentionally narrow, so the raw payload is read
 * here as a loose record and normalised into these strict shapes.
 *
 * Field names mirror the backend contract exactly (see `api/app/api/bot_routes.py`
 * `UpdateBotRequest` / `_bot_to_response`): `live_chat_enabled`, `waiting_message`,
 * `offline_message`, `handoff_delay_seconds`, `live_chat_queue_timeout_seconds`,
 * `live_chat_max_queue_size`, `lead_form_enabled`, `lead_form_fields`,
 * `services` (`[{name, url}]`) and the `widget_messages.*` copy keys.
 */

// ── Live chat (#7) ────────────────────────────────────────────────────────────
export interface LiveChatConfig {
  enabled: boolean;
  /** Shown while a visitor waits for an operator to accept. */
  waitingMessage: string;
  /** Top-level `bot.offline_message` - the handoff "no operators" state. */
  offlineMessage: string;
  /** Delay before the handoff form appears after the bot suggests live chat. */
  handoffDelaySeconds: number;
  /** How long a visitor waits in the queue before timing out (5 to 600s). */
  queueTimeoutSeconds: number;
  /** Max visitors allowed to wait in the live-chat queue at once (1 to 100). */
  maxQueueSize: number;
}

// ── Pre-chat lead form (#10) ──────────────────────────────────────────────────
export type LeadFieldName = 'name' | 'email' | 'phone' | 'company';

export interface LeadFormField {
  field: LeadFieldName;
  required: boolean;
}

export interface LeadFormConfig {
  enabled: boolean;
  fields: LeadFormField[];
}

// ── Services answer-scope (#11) ───────────────────────────────────────────────
export interface ServiceEntry {
  name: string;
  /** Optional per-service deep link; empty means "render as plain text". */
  url: string;
}

// ── Smart links (#11) ─────────────────────────────────────────────────────────
/**
 * Admin-defined keyword→link. Independent of {@link ServiceEntry}: it never
 * scopes what the bot may answer, it only lets the bot hyperlink the keyword to
 * the mapped page when it naturally comes up in an answer. Both fields are
 * required for a row to persist (a link with no destination is meaningless).
 */
export interface SmartLink {
  keyword: string;
  url: string;
}

// ── Remaining widget copy (#11) ───────────────────────────────────────────────
export interface WidgetCopy {
  /** `widget_messages.offline_message` - distinct from the top-level live-chat
   * `offline_message`; this is the widget's own offline-mode banner. */
  offlineMessage: string;
  liveChatLabel: string;
  greetingMessage: string;
  ratingPrompt: string;
  endChatLabel: string;
}

// ── Language (Phase 5B) ───────────────────────────────────────────────────
/**
 * The bot's visitor-facing language configuration: which languages the chatbot
 * speaks, which one it falls back to, and how a visitor's language is chosen.
 *
 * Stored in the `Bot.language_config` JSONB column and read directly by
 * Phases 1 to 4 - the widget's language selector, the AI's answer language and
 * the operator translation pipeline all gate on these keys. Nothing here
 * describes what language an OPERATOR reads chat in; that is
 * `Operator.preferred_locale`, set by each operator in Support -> Live chat.
 */
export interface LanguageConfig {
  /** Master switch. Everything else is inert while this is false. */
  enabled: boolean;
  /** BCP-47 tags the bot will hold a conversation in. */
  supportedLocales: string[];
  /** Used when a visitor's language cannot be determined. Always in the list above. */
  defaultLocale: string;
  /** Infer the visitor's language from their browser, page and first message. */
  autoDetect: boolean;
  /** Show the language selector in the widget. Meaningless below two locales. */
  allowVisitorSwitch: boolean;
  /** Translate live chat between visitors and operators. Requires `enabled`. */
  operatorTranslation: boolean;
}

/** The full editable model, split into the independently-saved slices. */
export interface BotConfigDraft {
  liveChat: LiveChatConfig;
  leadForm: LeadFormConfig;
  services: ServiceEntry[];
  answerLinks: SmartLink[];
  copy: WidgetCopy;
  language: LanguageConfig;
}

/** The slices, each with its own dirty-tracking + save. */
export type SliceKey = 'liveChat' | 'leadForm' | 'services' | 'answerLinks' | 'copy' | 'language';

/** Save state for one slice. Each card owns exactly one. */
export interface SliceStatus {
  saving: boolean;
  error: string | null;
  saved: boolean;
}

/** The resting state of a slice: nothing in flight, nothing to report. */
export const IDLE: SliceStatus = { saving: false, error: null, saved: false };

// ── Constants ─────────────────────────────────────────────────────────────────
export const LEAD_FIELD_ORDER: readonly LeadFieldName[] = ['name', 'email', 'phone', 'company'];

export const LEAD_FIELD_LABELS: Record<LeadFieldName, string> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
};

export const HANDOFF_DELAY_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Immediately' },
  { value: 2, label: 'After 2 seconds' },
  { value: 5, label: 'After 5 seconds' },
  { value: 10, label: 'After 10 seconds' },
];

/**
 * The locale a bot falls back to before anyone configures one. Matches the
 * documented default on `Bot.language_config` (see `db/models.py`), so a bot
 * nobody has touched reads the same here as it does server-side.
 */
export const DEFAULT_LOCALE = 'en-IN';

/** A brand-new, untouched language configuration. */
export const LANGUAGE_DEFAULTS: LanguageConfig = {
  enabled: false,
  supportedLocales: [DEFAULT_LOCALE],
  defaultLocale: DEFAULT_LOCALE,
  autoDetect: true,
  allowVisitorSwitch: false,
  operatorTranslation: false,
};

export const QUEUE_TIMEOUT = { min: 5, max: 600, default: 20 } as const;
export const MAX_QUEUE = { min: 1, max: 100, default: 10 } as const;

/**
 * Placeholder copy - mirrors the shipped widget's own fallbacks.
 *
 * i18n-exempt: these must stay identical to what the WIDGET renders when the
 * field is left blank. Translating the placeholder would promise the operator
 * one sentence and show their visitors another.
 */
export const COPY_PLACEHOLDERS: WidgetCopy = {
  offlineMessage: "We'll be right back! Leave a message and we'll follow up shortly.",
  liveChatLabel: 'Live chat',
  greetingMessage: 'Hi! Let us know if you have any questions.',
  ratingPrompt: 'How was your experience?',
  endChatLabel: 'End chat and return to AI',
};

// i18n-exempt: same reason as COPY_PLACEHOLDERS - this mirrors the widget's
// own fallback, which the visitor sees, not the operator.
export const LIVE_CHAT_PLACEHOLDERS = {
  waitingMessage: 'Connecting you to support…',
  offlineMessage: COPY_PLACEHOLDERS.offlineMessage,
} as const;

// ── Coercion helpers ──────────────────────────────────────────────────────────
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeLeadFields(value: unknown): LeadFormField[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<LeadFieldName>();
  const out: LeadFormField[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const field = record.field;
    if (
      (field === 'name' || field === 'email' || field === 'phone' || field === 'company') &&
      !seen.has(field)
    ) {
      seen.add(field);
      out.push({ field, required: asBoolean(record.required) });
    }
  }
  return out;
}

function normalizeServices(value: unknown): ServiceEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ServiceEntry[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      out.push({ name: item, url: '' });
      continue;
    }
    const record = asRecord(item);
    out.push({ name: asString(record.name), url: asString(record.url) });
  }
  return out;
}

/** Parse the raw `answer_links` payload into editable rows (loss-tolerant). */
function normalizeSmartLinks(value: unknown): SmartLink[] {
  if (!Array.isArray(value)) return [];
  const out: SmartLink[] = [];
  for (const item of value) {
    const record = asRecord(item);
    out.push({ keyword: asString(record.keyword), url: asString(record.url) });
  }
  return out;
}

/**
 * Build the editable draft from a raw `getBot(botId)` payload. The `Bot` domain
 * type omits these config fields, so the caller passes the response widened to a
 * loose record; every field falls back to a safe default.
 */
export function draftFromBot(raw: Record<string, unknown>): BotConfigDraft {
  const widgetMessages = asRecord(raw.widget_messages);

  return {
    liveChat: {
      enabled: asBoolean(raw.live_chat_enabled),
      waitingMessage: asString(raw.waiting_message),
      offlineMessage: asString(raw.offline_message),
      handoffDelaySeconds: asNumber(raw.handoff_delay_seconds, 0),
      queueTimeoutSeconds: asNumber(raw.live_chat_queue_timeout_seconds, QUEUE_TIMEOUT.default),
      maxQueueSize: asNumber(raw.live_chat_max_queue_size, MAX_QUEUE.default),
    },
    leadForm: {
      enabled: asBoolean(raw.lead_form_enabled),
      fields: normalizeLeadFields(raw.lead_form_fields),
    },
    services: normalizeServices(raw.services),
    answerLinks: normalizeSmartLinks(raw.answer_links),
    copy: {
      offlineMessage: asString(widgetMessages.offline_message),
      liveChatLabel: asString(widgetMessages.live_chat_label),
      greetingMessage: asString(widgetMessages.greeting_message),
      ratingPrompt: asString(widgetMessages.rating_prompt),
      endChatLabel: asString(widgetMessages.end_chat_label),
    },
    language: languageFromBot(raw.language_config),
  };
}

/** Drop blanks and repeats, preserving first-seen order. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Parse the stored `language_config` into the editable draft.
 *
 * Loss-tolerant, and deliberately NOT normalised: a legacy bot whose stored
 * default sits outside its supported list must load exactly as stored, so the
 * card can show the problem and the user's first save is what repairs it.
 * Normalisation belongs on the way out - see {@link normalizeLanguageConfig}.
 */
export function languageFromBot(value: unknown): LanguageConfig {
  const raw = asRecord(value);
  const supported = Array.isArray(raw.supported_locales)
    ? raw.supported_locales.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
    : [];
  return {
    enabled: asBoolean(raw.enabled, LANGUAGE_DEFAULTS.enabled),
    supportedLocales: supported.length > 0 ? dedupe(supported) : [...LANGUAGE_DEFAULTS.supportedLocales],
    defaultLocale:
      asString(raw.default_locale, LANGUAGE_DEFAULTS.defaultLocale) || LANGUAGE_DEFAULTS.defaultLocale,
    autoDetect: asBoolean(raw.auto_detect, LANGUAGE_DEFAULTS.autoDetect),
    allowVisitorSwitch: asBoolean(
      raw.allow_visitor_language_switch,
      LANGUAGE_DEFAULTS.allowVisitorSwitch,
    ),
    operatorTranslation: asBoolean(
      raw.operator_translation_enabled,
      LANGUAGE_DEFAULTS.operatorTranslation,
    ),
  };
}

// ── Normalizers ───────────────────────────────────────────────────────────────
// Shared by the PATCH builders (what we send) and the save handlers (what we
// commit to the baseline + visible draft), so the UI always reflects exactly
// what the server persisted - no drift between a clamped/cleaned value on the
// wire and a stale raw value on screen.

/** Clamp the numeric live-chat fields into their persisted ranges. */
export function normalizeLiveChat(config: LiveChatConfig): LiveChatConfig {
  return {
    ...config,
    queueTimeoutSeconds: clamp(config.queueTimeoutSeconds, QUEUE_TIMEOUT.min, QUEUE_TIMEOUT.max),
    maxQueueSize: clamp(config.maxQueueSize, MAX_QUEUE.min, MAX_QUEUE.max),
  };
}

/** Trim every service row and drop the blank ones the server would reject. */
export function normalizeServiceEntries(services: ServiceEntry[]): ServiceEntry[] {
  return services
    .map((s) => ({ name: s.name.trim(), url: s.url.trim() }))
    .filter((s) => s.name.length > 0);
}

/** True when a string is a well-formed http(s) URL the widget can safely link. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+/i.test(value.trim());
}

/**
 * Trim smart-link rows and drop the ones the server would reject: a row needs
 * both a keyword and a valid http(s) URL. Mirrors the backend's
 * `_normalize_answer_links` (blank/invalid dropped, first keyword wins) so the
 * committed baseline matches exactly what was persisted.
 */
export function normalizeSmartLinkEntries(links: SmartLink[]): SmartLink[] {
  const out: SmartLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const keyword = link.keyword.trim();
    const url = link.url.trim();
    if (!keyword || !isHttpUrl(url)) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ keyword, url });
  }
  return out;
}

// ── Per-slice PATCH builders ──────────────────────────────────────────────────
export function liveChatPatch(config: LiveChatConfig): Record<string, unknown> {
  const c = normalizeLiveChat(config);
  return {
    live_chat_enabled: c.enabled,
    waiting_message: c.waitingMessage,
    offline_message: c.offlineMessage,
    handoff_delay_seconds: c.handoffDelaySeconds,
    live_chat_queue_timeout_seconds: c.queueTimeoutSeconds,
    live_chat_max_queue_size: c.maxQueueSize,
  };
}

export function leadFormPatch(config: LeadFormConfig): Record<string, unknown> {
  return {
    lead_form_enabled: config.enabled,
    lead_form_fields: config.fields.map((f) => ({ field: f.field, required: f.required })),
  };
}

export function servicesPatch(services: ServiceEntry[]): Record<string, unknown> {
  const cleaned = normalizeServiceEntries(services).map((s) => ({
    name: s.name,
    url: s.url.length > 0 ? s.url : null,
  }));
  return { services: cleaned };
}

export function answerLinksPatch(links: SmartLink[]): Record<string, unknown> {
  return { answer_links: normalizeSmartLinkEntries(links) };
}

/**
 * Enforce the invariants the server also enforces, so the committed baseline
 * matches exactly what was persisted and the customer never meets a 422:
 *
 * - the default locale is always one of the supported locales;
 * - the supported list is never empty;
 * - a visitor language switcher needs two languages to switch between;
 * - operator translation cannot outlive the multilingual toggle it depends on
 *   (`bot_routes.py` returns 422 for exactly that pair).
 */
export function normalizeLanguageConfig(config: LanguageConfig): LanguageConfig {
  const supportedLocales = dedupe(config.supportedLocales);
  if (supportedLocales.length === 0) {
    supportedLocales.push(config.defaultLocale.trim() || DEFAULT_LOCALE);
  }
  const defaultLocale = supportedLocales.includes(config.defaultLocale)
    ? config.defaultLocale
    : supportedLocales[0];
  return {
    enabled: config.enabled,
    supportedLocales,
    defaultLocale,
    autoDetect: config.autoDetect,
    allowVisitorSwitch: config.allowVisitorSwitch && supportedLocales.length >= 2,
    operatorTranslation: config.operatorTranslation && config.enabled,
  };
}

export function languagePatch(config: LanguageConfig): Record<string, unknown> {
  const c = normalizeLanguageConfig(config);
  // `language_config` is shallow-merged server-side. All six keys go together
  // so the stored object stays internally consistent, rather than leaving a
  // stale key behind that the merge would faithfully preserve.
  return {
    language_config: {
      enabled: c.enabled,
      supported_locales: c.supportedLocales,
      default_locale: c.defaultLocale,
      auto_detect: c.autoDetect,
      allow_visitor_language_switch: c.allowVisitorSwitch,
      operator_translation_enabled: c.operatorTranslation,
    },
  };
}

export function copyPatch(copy: WidgetCopy): Record<string, unknown> {
  // `widget_messages` is deep-merged server-side, so this partial slice never
  // clobbers the greeting/subtitle/quick-action keys the appearance draft owns.
  return {
    widget_messages: {
      offline_message: copy.offlineMessage,
      live_chat_label: copy.liveChatLabel,
      greeting_message: copy.greetingMessage,
      rating_prompt: copy.ratingPrompt,
      end_chat_label: copy.endChatLabel,
    },
  };
}

/** Structural equality for a single slice, used for unsaved-changes detection. */
export function sliceEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
