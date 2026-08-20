/**
 * The Experience surface's editable model.
 *
 * One draft, one baseline, one diff. The page this replaces held two: a
 * "client settings" draft with a page-level save bar, and a second `Bot` draft
 * with a save button per card — even though both loaded from `GET /bots/{id}`
 * and both wrote to `PATCH /bots/{id}`. That split is why the same
 * `widget_messages` map had two writers, why `types.ts` needed a
 * `MANAGED_WIDGET_MESSAGE_KEYS` set to stop one save clobbering the other's
 * fields, and why a customer could leave the page having saved three cards out
 * of five with no single thing on screen that knew it.
 *
 * The rules this file encodes:
 *
 * **The patch is a diff.** Only fields whose value actually changed are sent.
 * The server parses with `exclude_unset=True`, so an omitted field is left
 * alone — which is the correct behaviour for every field on this page and the
 * *required* behaviour for the avatar: a crawl can set the chatbot's picture
 * from the site's favicon while this editor is open, and re-sending the value
 * the page loaded before that happened writes the derived avatar straight back
 * off. Diffing makes that guarantee general rather than a special case someone
 * has to remember.
 *
 * **`widget_messages` and `feature_flags` are merged server-side** (see
 * `bot_routes.py` `update_bot`, "Merge feature_flags" / "Merge
 * widget_messages"), so sending only the sub-keys that changed preserves every
 * key this page does not own. No passthrough snapshot is needed.
 *
 * **Business hours are flat.** `{timezone, mon: {start, end} | null, …}` — the
 * exact shape `live_chat_availability_service._within_business_hours` reads,
 * and the exact shape `bot_routes.BusinessHours` accepts with `extra="forbid"`.
 * A day is closed by being `null`; there is no `enabled` flag and no `days`
 * wrapper, and sending either is a 422.
 */

import { isHexColor } from './contrast';
import { DEFAULT_PRIMARY_COLOR, DEFAULT_USER_BUBBLE_COLOR } from './widgetTheme';

// ── The four groups the page is divided into ─────────────────────────────────

export const SECTION_KEYS = ['branding', 'messages', 'voice', 'handoff'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  branding: 'Branding',
  messages: 'Messages',
  voice: 'Voice',
  handoff: 'Handoff',
};

export function isSectionKey(value: string): value is SectionKey {
  return (SECTION_KEYS as readonly string[]).includes(value);
}

// ── Value types ──────────────────────────────────────────────────────────────

export type AvatarType = 'upload' | 'orb' | 'mascot';
export type SuggestionsLayout = 'horizontal' | 'vertical';
export type LeadFieldName = 'name' | 'email' | 'phone' | 'company';

export interface LeadFormField {
  field: LeadFieldName;
  required: boolean;
}

export interface ServiceEntry {
  name: string;
  /** Optional deep link. Empty renders the service as plain text. */
  url: string;
}

export interface SmartLink {
  keyword: string;
  url: string;
}

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface DayHours {
  /** `HH:MM`, 24-hour. */
  start: string;
  end: string;
}

/** The editor's shape. `null` for a day means closed, exactly as stored. */
export interface BusinessHours {
  timezone: string;
  days: Record<DayKey, DayHours | null>;
}

// ── The draft ────────────────────────────────────────────────────────────────

export interface ExperienceDraft {
  // Branding
  primaryColor: string;
  userBubbleColor: string;
  avatarType: AvatarType;
  orbColor: string;
  botLogo: string | null;
  /** `feature_flags.show_branding`. Only a workspace with `branding_removable`
   *  may turn it off; the widget config endpoint forces it back on otherwise. */
  showBranding: boolean;

  // Messages
  displayName: string;
  launcherName: string;
  welcomeGreeting: string;
  welcomeSubtitle: string;
  quickActions: string[];
  suggestionsLayout: SuggestionsLayout;
  inputPlaceholder: string;
  greetingMessage: string;
  offlineBanner: string;
  liveChatLabel: string;
  ratingPrompt: string;
  endChatLabel: string;

  // Voice
  systemPrompt: string;
  brandTone: string;
  brandTonePreset: string | null;
  companyName: string;
  companyDescription: string;
  services: ServiceEntry[];
  smartLinks: SmartLink[];

  // Handoff
  liveChatEnabled: boolean;
  waitingMessage: string;
  handoffOfflineMessage: string;
  handoffDelaySeconds: number;
  queueTimeoutSeconds: number;
  maxQueueSize: number;
  /** `null` means always available — the server reads a null/absent schedule
   *  as 24/7 and short-circuits without checking days. */
  businessHours: BusinessHours | null;
  leadFormEnabled: boolean;
  leadFormFields: LeadFormField[];
}

export type DraftField = keyof ExperienceDraft;

/**
 * Which tab owns each field.
 *
 * Drives the per-tab "unsaved" markers and the save bar's summary, so a user
 * who edited the greeting three tabs ago is told where the unsaved work is
 * rather than only that some exists.
 */
export const FIELD_SECTION: Record<DraftField, SectionKey> = {
  primaryColor: 'branding',
  userBubbleColor: 'branding',
  avatarType: 'branding',
  orbColor: 'branding',
  botLogo: 'branding',
  showBranding: 'branding',

  displayName: 'messages',
  launcherName: 'messages',
  welcomeGreeting: 'messages',
  welcomeSubtitle: 'messages',
  quickActions: 'messages',
  suggestionsLayout: 'messages',
  inputPlaceholder: 'messages',
  greetingMessage: 'messages',
  offlineBanner: 'messages',
  liveChatLabel: 'messages',
  ratingPrompt: 'messages',
  endChatLabel: 'messages',

  systemPrompt: 'voice',
  brandTone: 'voice',
  brandTonePreset: 'voice',
  companyName: 'voice',
  companyDescription: 'voice',
  services: 'voice',
  smartLinks: 'voice',

  liveChatEnabled: 'handoff',
  waitingMessage: 'handoff',
  handoffOfflineMessage: 'handoff',
  handoffDelaySeconds: 'handoff',
  queueTimeoutSeconds: 'handoff',
  maxQueueSize: 'handoff',
  businessHours: 'handoff',
  leadFormEnabled: 'handoff',
  leadFormFields: 'handoff',
};

/**
 * Server-owned facts about the chatbot that this page reads but never edits.
 * Kept out of the draft so they can never register as an unsaved change.
 */
export interface ExperienceMeta {
  /**
   * The in-widget credit line's wording and destination.
   *
   * Read-only here. The editor for the pair lives on **Deploy**
   * (`channels/AttributionSection.tsx`), beside the snippet, because one
   * entitlement governs both halves and splitting them across two screens is
   * how a customer ends up white-labelled in the widget with an OyeChats link
   * still in their page source. This surface owns only whether the line shows
   * at all, and renders the wording so the preview is honest.
   */
  brandingText: string;
  brandingUrl: string;
  /** Who set `botLogo`: `'derived'` means a crawl took it from the site's
   *  favicon, so the picker can say where it came from rather than presenting
   *  it as a picture someone chose. */
  botLogoSource: string | null;
  /** Colours extracted from the customer's own website during the crawl. */
  recommendedColors: string[];
  /** This chatbot's own plan. Billing attaches to the bot, not the workspace. */
  planSlug: string;
  planName: string;
  botKey: string | null;
  website: string | null;
  /** Brand-tone detection needs crawled content to read. */
  trained: boolean;
}

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * Field caps.
 *
 * `systemPrompt` / `brandTone` / `companyName` / `companyDescription` /
 * `brandTonePreset` mirror `UpdateBotRequest` exactly. `displayName` and
 * `launcherName` are bounded server-side only by `Name` (200), so these are UI
 * guides that keep the widget header and the launcher tooltip on one line.
 */
export const LIMITS = {
  displayName: 60,
  launcherName: 40,
  welcomeGreeting: 120,
  welcomeSubtitle: 160,
  quickAction: 120,
  quickActions: 6,
  inputPlaceholder: 60,
  greetingMessage: 160,
  offlineBanner: 200,
  liveChatLabel: 40,
  ratingPrompt: 120,
  endChatLabel: 40,
  systemPrompt: 2000,
  brandTone: 500,
  companyName: 100,
  companyDescription: 1000,
  waitingMessage: 200,
  handoffOfflineMessage: 200,
  serviceName: 200,
  services: 50,
  keyword: 80,
  smartLinks: 50,
} as const;

export const QUEUE_TIMEOUT = { min: 5, max: 600, default: 20 } as const;
export const MAX_QUEUE = { min: 1, max: 100, default: 10 } as const;

export const HANDOFF_DELAY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '0', label: 'Immediately' },
  { value: '2', label: 'After 2 seconds' },
  { value: '5', label: 'After 5 seconds' },
  { value: '10', label: 'After 10 seconds' },
];

export const LEAD_FIELD_ORDER: readonly LeadFieldName[] = ['name', 'email', 'phone', 'company'];

export const LEAD_FIELD_LABELS: Record<LeadFieldName, string> = {
  name: 'Name',
  email: 'Email',
  phone: 'Phone',
  company: 'Company',
};

/**
 * What the widget renders when a string is left blank.
 *
 * Shown as placeholders, never written into the draft: a customer who has never
 * touched the rating prompt should keep getting the platform's wording as it
 * improves, not a copy of today's frozen into their record.
 */
export const PLACEHOLDERS = {
  launcherName: 'Have Questions?',
  welcomeGreeting: 'Hi there 👋',
  welcomeSubtitle: 'How can we help you today?',
  inputPlaceholder: 'Write a message…',
  greetingMessage: 'Hi! Let us know if you have any questions.',
  offlineBanner: "We'll be right back! Leave a message and we'll follow up shortly.",
  liveChatLabel: 'Live chat',
  ratingPrompt: 'How was your experience?',
  endChatLabel: 'End chat and return to AI',
  waitingMessage: 'Connecting you to support…',
  handoffOfflineMessage: "We'll be right back! Leave a message and we'll follow up shortly.",
  brandingText: 'Powered by OyeChats',
} as const;

// ── Coercion ─────────────────────────────────────────────────────────────────

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
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && isHexColor(value) ? value : fallback;
}

function asAvatarType(value: unknown): AvatarType {
  return value === 'orb' || value === 'mascot' || value === 'upload' ? value : 'upload';
}

function asLayout(value: unknown): SuggestionsLayout {
  return value === 'vertical' ? 'vertical' : 'horizontal';
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeOfDay(value: string): boolean {
  return TIME_PATTERN.test(value);
}

/** The viewer's own zone, which is the right default for a schedule they set. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A sensible first schedule: weekdays 09:00–17:00, weekend closed. */
export function defaultBusinessHours(timezone: string = localTimezone()): BusinessHours {
  const weekday: DayHours = { start: '09:00', end: '17:00' };
  return {
    timezone,
    days: {
      mon: { ...weekday },
      tue: { ...weekday },
      wed: { ...weekday },
      thu: { ...weekday },
      fri: { ...weekday },
      sat: null,
      sun: null,
    },
  };
}

function parseBusinessHours(value: unknown): BusinessHours | null {
  if (value === null || value === undefined) return null;
  const raw = asRecord(value);
  if (Object.keys(raw).length === 0) return null;
  const days = {} as Record<DayKey, DayHours | null>;
  let anyDay = false;
  for (const key of DAY_KEYS) {
    const day = raw[key];
    if (day === null || day === undefined) {
      days[key] = null;
      continue;
    }
    const record = asRecord(day);
    const start = asString(record.start);
    const end = asString(record.end);
    days[key] = isTimeOfDay(start) && isTimeOfDay(end) ? { start, end } : null;
    if (days[key]) anyDay = true;
  }
  const timezone = asString(raw.timezone) || localTimezone();
  // A stored object with a timezone but no readable day is still a real
  // restriction — the server reads it as "closed every day" — so it is kept
  // rather than collapsed to "always open", which would misreport availability.
  return anyDay || asString(raw.timezone) ? { timezone, days } : null;
}

function parseLeadFields(value: unknown): LeadFormField[] {
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

function parseServices(value: unknown): ServiceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return { name: item, url: '' };
    const record = asRecord(item);
    return { name: asString(record.name), url: asString(record.url) };
  });
}

function parseSmartLinks(value: unknown): SmartLink[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return { keyword: asString(record.keyword), url: asString(record.url) };
  });
}

// ── Reading the bot ──────────────────────────────────────────────────────────

/**
 * Build the editable draft from a `GET /bots/{id}` payload.
 *
 * Every field falls back to a value the form can edit, so the page is never in
 * a state where a control has nothing to bind to. Copy fields fall back to the
 * empty string rather than to the platform's wording — see `PLACEHOLDERS`.
 */
export function draftFromBot(raw: Record<string, unknown>): ExperienceDraft {
  const messages = asRecord(raw.widget_messages);
  const flags = asRecord(raw.feature_flags);

  return {
    primaryColor: asColor(raw.primary_color, DEFAULT_PRIMARY_COLOR),
    userBubbleColor: asColor(raw.user_bubble_color, DEFAULT_USER_BUBBLE_COLOR),
    avatarType: asAvatarType(raw.avatar_type),
    orbColor: asColor(raw.orb_color, ''),
    botLogo: typeof raw.bot_logo === 'string' && raw.bot_logo.length > 0 ? raw.bot_logo : null,
    showBranding: asBoolean(flags.show_branding, true),

    displayName: asString(raw.name),
    launcherName: asString(raw.launcher_name),
    welcomeGreeting: asString(messages.welcome_greeting),
    welcomeSubtitle: asString(messages.welcome_subtitle),
    quickActions: asStringArray(messages.welcome_suggestions),
    suggestionsLayout: asLayout(messages.welcome_suggestions_layout),
    inputPlaceholder: asString(messages.input_placeholder),
    greetingMessage: asString(messages.greeting_message),
    offlineBanner: asString(messages.offline_message),
    liveChatLabel: asString(messages.live_chat_label),
    ratingPrompt: asString(messages.rating_prompt),
    endChatLabel: asString(messages.end_chat_label),

    systemPrompt: asString(raw.system_prompt),
    brandTone: asString(raw.brand_tone),
    brandTonePreset: typeof raw.brand_tone_preset === 'string' ? raw.brand_tone_preset : null,
    companyName: asString(raw.company_name),
    companyDescription: asString(raw.company_description),
    services: parseServices(raw.services),
    smartLinks: parseSmartLinks(raw.answer_links),

    liveChatEnabled: asBoolean(raw.live_chat_enabled),
    waitingMessage: asString(raw.waiting_message),
    handoffOfflineMessage: asString(raw.offline_message),
    handoffDelaySeconds: asNumber(raw.handoff_delay_seconds, 0),
    queueTimeoutSeconds: asNumber(raw.live_chat_queue_timeout_seconds, QUEUE_TIMEOUT.default),
    maxQueueSize: asNumber(raw.live_chat_max_queue_size, MAX_QUEUE.default),
    businessHours: parseBusinessHours(raw.business_hours),
    leadFormEnabled: asBoolean(raw.lead_form_enabled),
    leadFormFields: parseLeadFields(raw.lead_form_fields),
  };
}

export function metaFromBot(raw: Record<string, unknown>): ExperienceMeta {
  return {
    brandingText: asString(raw.branding_text),
    brandingUrl: asString(raw.branding_url),
    botLogoSource: typeof raw.bot_logo_source === 'string' ? raw.bot_logo_source : null,
    recommendedColors: asStringArray(raw.recommended_colors).filter(isHexColor),
    planSlug: asString(raw.plan_slug, 'free'),
    planName: asString(raw.plan_name, 'Free'),
    botKey: typeof raw.bot_key === 'string' && raw.bot_key.length > 0 ? raw.bot_key : null,
    website: typeof raw.website === 'string' && raw.website.length > 0 ? raw.website : null,
    trained: typeof raw.crawl_completed_at === 'string' && raw.crawl_completed_at.length > 0,
  };
}

// ── Normalising ──────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The draft as the server will actually store it.
 *
 * Applied before the diff and committed to the baseline after a successful
 * save, so the screen always shows what was persisted rather than what was
 * typed. A queue timeout of 9000 is stored as 600 and a blank service row is
 * dropped; leaving the typed value on screen after the save invites the user to
 * "fix" a field that is already correct.
 */
export function normalizeDraft(draft: ExperienceDraft): ExperienceDraft {
  return {
    ...draft,
    displayName: draft.displayName.trim(),
    launcherName: draft.launcherName.trim(),
    quickActions: draft.quickActions.map((action) => action.trim()).filter((a) => a.length > 0),
    companyName: draft.companyName.trim(),
    services: draft.services
      .map((service) => ({ name: service.name.trim(), url: service.url.trim() }))
      .filter((service) => service.name.length > 0),
    smartLinks: normalizeSmartLinks(draft.smartLinks),
    queueTimeoutSeconds: clamp(draft.queueTimeoutSeconds, QUEUE_TIMEOUT.min, QUEUE_TIMEOUT.max),
    maxQueueSize: clamp(draft.maxQueueSize, MAX_QUEUE.min, MAX_QUEUE.max),
  };
}

/**
 * Trim smart-link rows and drop the ones the server would refuse.
 *
 * Mirrors the backend's `_normalize_answer_links`: a row needs a keyword and an
 * http(s) URL, and the first keyword wins on a duplicate. Matching it here is
 * what lets the committed baseline equal what was stored.
 */
export function normalizeSmartLinks(links: SmartLink[]): SmartLink[] {
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

/** A well-formed http(s) URL — the same shape `HttpUrlStr` accepts. */
export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    return Boolean(new URL(trimmed).hostname);
  } catch {
    return false;
  }
}

// ── Diffing ──────────────────────────────────────────────────────────────────

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fields whose value differs from the loaded record. */
export function changedFields(draft: ExperienceDraft, baseline: ExperienceDraft): DraftField[] {
  return (Object.keys(FIELD_SECTION) as DraftField[]).filter(
    (field) => !sameValue(draft[field], baseline[field]),
  );
}

/** The tabs that hold unsaved work, in tab order. */
export function changedSections(draft: ExperienceDraft, baseline: ExperienceDraft): SectionKey[] {
  const dirty = new Set(changedFields(draft, baseline).map((field) => FIELD_SECTION[field]));
  return SECTION_KEYS.filter((section) => dirty.has(section));
}

export function draftsEqual(a: ExperienceDraft, b: ExperienceDraft): boolean {
  return changedFields(a, b).length === 0;
}

/**
 * Fields whose value the *answer* depends on.
 *
 * The preview streams a real reply through `/bots/{id}/preview-chat`, which
 * reads the chatbot's **saved** record. When one of these is dirty the preview
 * is showing an answer written by the old settings, and it has to say so —
 * "live preview" over a stale reply is the page lying about the one thing it
 * exists to show.
 */
const ANSWER_FIELDS: readonly DraftField[] = [
  'systemPrompt',
  'brandTone',
  'companyName',
  'companyDescription',
  'services',
  'smartLinks',
];

export function answerIsStale(draft: ExperienceDraft, baseline: ExperienceDraft): boolean {
  return ANSWER_FIELDS.some((field) => !sameValue(draft[field], baseline[field]));
}

// ── Writing the bot ──────────────────────────────────────────────────────────

function businessHoursPayload(hours: BusinessHours | null): Record<string, unknown> | null {
  if (!hours) return null;
  const payload: Record<string, unknown> = { timezone: hours.timezone };
  for (const key of DAY_KEYS) {
    const day = hours.days[key];
    payload[key] = day ? { start: day.start, end: day.end } : null;
  }
  return payload;
}

/**
 * The `PATCH /bots/{id}` body for everything that changed, and nothing else.
 *
 * Returns `{}` when the draft matches the baseline, which the caller reads as
 * "no request to make". `widget_messages` and `feature_flags` carry only their
 * changed sub-keys because the server merges them; every other key is a
 * top-level column.
 */
export function patchFromDraft(
  draft: ExperienceDraft,
  baseline: ExperienceDraft,
): Record<string, unknown> {
  const changed = new Set(changedFields(draft, baseline));
  const patch: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  const flags: Record<string, unknown> = {};

  if (changed.has('displayName')) patch.name = draft.displayName;
  if (changed.has('launcherName')) patch.launcher_name = draft.launcherName;
  if (changed.has('primaryColor')) patch.primary_color = draft.primaryColor;
  if (changed.has('userBubbleColor')) patch.user_bubble_color = draft.userBubbleColor;
  if (changed.has('avatarType')) patch.avatar_type = draft.avatarType;
  // `orb_color` is a `HexColor` server-side, and the empty string is not one.
  if (changed.has('orbColor')) patch.orb_color = draft.orbColor || null;
  // `launcher_logo` is not sent: the handler mirrors `bot_logo` onto it.
  if (changed.has('botLogo')) patch.bot_logo = draft.botLogo;
  if (changed.has('showBranding')) flags.show_branding = draft.showBranding;

  if (changed.has('welcomeGreeting')) messages.welcome_greeting = draft.welcomeGreeting;
  if (changed.has('welcomeSubtitle')) messages.welcome_subtitle = draft.welcomeSubtitle;
  if (changed.has('quickActions')) messages.welcome_suggestions = draft.quickActions;
  if (changed.has('suggestionsLayout')) {
    messages.welcome_suggestions_layout = draft.suggestionsLayout;
  }
  if (changed.has('inputPlaceholder')) messages.input_placeholder = draft.inputPlaceholder;
  if (changed.has('greetingMessage')) messages.greeting_message = draft.greetingMessage;
  if (changed.has('offlineBanner')) messages.offline_message = draft.offlineBanner;
  if (changed.has('liveChatLabel')) messages.live_chat_label = draft.liveChatLabel;
  if (changed.has('ratingPrompt')) messages.rating_prompt = draft.ratingPrompt;
  if (changed.has('endChatLabel')) messages.end_chat_label = draft.endChatLabel;

  if (changed.has('systemPrompt')) patch.system_prompt = draft.systemPrompt;
  if (changed.has('brandTone')) patch.brand_tone = draft.brandTone;
  if (changed.has('brandTonePreset')) patch.brand_tone_preset = draft.brandTonePreset;
  if (changed.has('companyName')) patch.company_name = draft.companyName;
  if (changed.has('companyDescription')) patch.company_description = draft.companyDescription;
  if (changed.has('services')) {
    patch.services = draft.services.map((service) => ({
      name: service.name,
      url: service.url.length > 0 ? service.url : null,
    }));
  }
  if (changed.has('smartLinks')) patch.answer_links = draft.smartLinks;

  if (changed.has('liveChatEnabled')) patch.live_chat_enabled = draft.liveChatEnabled;
  if (changed.has('waitingMessage')) patch.waiting_message = draft.waitingMessage;
  // The top-level column, distinct from `widget_messages.offline_message`: this
  // one is the live-chat handoff reply, that one is the widget's own banner.
  if (changed.has('handoffOfflineMessage')) patch.offline_message = draft.handoffOfflineMessage;
  if (changed.has('handoffDelaySeconds')) patch.handoff_delay_seconds = draft.handoffDelaySeconds;
  if (changed.has('queueTimeoutSeconds')) {
    patch.live_chat_queue_timeout_seconds = draft.queueTimeoutSeconds;
  }
  if (changed.has('maxQueueSize')) patch.live_chat_max_queue_size = draft.maxQueueSize;
  if (changed.has('businessHours')) patch.business_hours = businessHoursPayload(draft.businessHours);
  if (changed.has('leadFormEnabled')) patch.lead_form_enabled = draft.leadFormEnabled;
  if (changed.has('leadFormFields')) patch.lead_form_fields = draft.leadFormFields;

  if (Object.keys(messages).length > 0) patch.widget_messages = messages;
  if (Object.keys(flags).length > 0) patch.feature_flags = flags;
  return patch;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Field-level errors, keyed by field.
 *
 * Row-based fields key by `field:index` so the message lands on the row that
 * caused it. Nothing here duplicates a `maxLength` the control already
 * enforces — an error for a state the user cannot reach is noise.
 */
export type DraftErrors = Record<string, string>;

export function validateDraft(draft: ExperienceDraft): DraftErrors {
  const errors: DraftErrors = {};

  if (draft.displayName.trim().length === 0) {
    errors.displayName = 'Give your chatbot a name — visitors see it in the widget header.';
  }
  if (!isHexColor(draft.primaryColor)) {
    errors.primaryColor = 'Enter a hex colour, for example #2B66BC.';
  }
  if (!isHexColor(draft.userBubbleColor)) {
    errors.userBubbleColor = 'Enter a hex colour, for example #DBE9FF.';
  }
  if (draft.orbColor.length > 0 && !isHexColor(draft.orbColor)) {
    errors.orbColor = 'Enter a hex colour, for example #2B66BC.';
  }

  draft.services.forEach((service, index) => {
    if (service.name.trim().length === 0 && service.url.trim().length > 0) {
      errors[`services:${index}`] = 'Name this service, or remove the link.';
    } else if (service.url.trim().length > 0 && !isHttpUrl(service.url)) {
      errors[`services:${index}`] = 'Enter a full link starting with http:// or https://';
    }
  });

  const keywords = new Set<string>();
  draft.smartLinks.forEach((link, index) => {
    const keyword = link.keyword.trim().toLowerCase();
    const url = link.url.trim();
    if (keyword.length === 0 && url.length === 0) return;
    if (keyword.length === 0) {
      errors[`smartLinks:${index}`] = 'Give this link a keyword for the chatbot to match.';
    } else if (keywords.has(keyword)) {
      errors[`smartLinks:${index}`] = `“${link.keyword.trim()}” is already mapped above.`;
    } else if (!isHttpUrl(url)) {
      errors[`smartLinks:${index}`] = 'Enter a full link starting with http:// or https://';
    }
    if (keyword.length > 0) keywords.add(keyword);
  });

  if (
    draft.queueTimeoutSeconds < QUEUE_TIMEOUT.min ||
    draft.queueTimeoutSeconds > QUEUE_TIMEOUT.max
  ) {
    errors.queueTimeoutSeconds = `Choose between ${QUEUE_TIMEOUT.min} and ${QUEUE_TIMEOUT.max} seconds.`;
  }
  if (draft.maxQueueSize < MAX_QUEUE.min || draft.maxQueueSize > MAX_QUEUE.max) {
    errors.maxQueueSize = `Choose between ${MAX_QUEUE.min} and ${MAX_QUEUE.max} visitors.`;
  }

  const hours = draft.businessHours;
  if (hours) {
    for (const key of DAY_KEYS) {
      const day = hours.days[key];
      if (!day) continue;
      if (!isTimeOfDay(day.start) || !isTimeOfDay(day.end)) {
        errors[`businessHours:${key}`] = 'Enter both times as HH:MM.';
      } else if (day.start === day.end) {
        errors[`businessHours:${key}`] =
          'Opening and closing times are the same — that day would never be open.';
      }
    }
    if (DAY_KEYS.every((key) => hours.days[key] === null)) {
      errors.businessHours =
        'Every day is closed, so the chatbot would never be available. Open a day, or turn business hours off.';
    }
  }

  return errors;
}

/** True when nothing blocks a save. */
export function isSavable(errors: DraftErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * Name the tabs holding unsaved work — "Branding and Messages".
 *
 * The save bar says *what* is pending, not only *that* something is: this page
 * has five tabs and only one is on screen, so "you have unsaved changes" would
 * leave the reader opening tabs to find it.
 */
export function summarizeSections(sections: readonly SectionKey[]): string {
  const names = sections.map((section) => SECTION_LABELS[section]);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
