/**
 * Local data model for the three bot-config surfaces the Experience page owns
 * beyond the shared appearance/messages draft: live-chat handoff (#7),
 * the pre-chat lead-capture form (#10), the services answer-scope whitelist
 * and the remaining widget-copy strings (#11).
 *
 * These fields live directly on the `Bot` record (not on the client-settings
 * draft that `types.ts` manages), so they load via `getBot(botId)` and persist
 * via `updateBot(botId, …)` — each surface saving its own slice independently.
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
  /** Top-level `bot.offline_message` — the handoff "no operators" state. */
  offlineMessage: string;
  /** Delay before the handoff form appears after the bot suggests live chat. */
  handoffDelaySeconds: number;
  /** How long a visitor waits in the queue before timing out (5–600s). */
  queueTimeoutSeconds: number;
  /** Max visitors allowed to wait in the live-chat queue at once (1–100). */
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

// ── Remaining widget copy (#11) ───────────────────────────────────────────────
export interface WidgetCopy {
  /** `widget_messages.offline_message` — distinct from the top-level live-chat
   * `offline_message`; this is the widget's own offline-mode banner. */
  offlineMessage: string;
  liveChatLabel: string;
  greetingMessage: string;
  ratingPrompt: string;
  endChatLabel: string;
}

/** The full editable model, split into the four independently-saved slices. */
export interface BotConfigDraft {
  liveChat: LiveChatConfig;
  leadForm: LeadFormConfig;
  services: ServiceEntry[];
  copy: WidgetCopy;
}

/** The four slices, each with its own dirty-tracking + save. */
export type SliceKey = 'liveChat' | 'leadForm' | 'services' | 'copy';

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

export const QUEUE_TIMEOUT = { min: 5, max: 600, default: 20 } as const;
export const MAX_QUEUE = { min: 1, max: 100, default: 10 } as const;

/** Placeholder copy — mirrors the shipped widget's own fallbacks. */
export const COPY_PLACEHOLDERS: WidgetCopy = {
  offlineMessage: "We'll be right back! Leave a message and we'll follow up shortly.",
  liveChatLabel: 'Live chat',
  greetingMessage: 'Hi! Let us know if you have any questions.',
  ratingPrompt: 'How was your experience?',
  endChatLabel: 'End chat and return to AI',
};

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
    copy: {
      offlineMessage: asString(widgetMessages.offline_message),
      liveChatLabel: asString(widgetMessages.live_chat_label),
      greetingMessage: asString(widgetMessages.greeting_message),
      ratingPrompt: asString(widgetMessages.rating_prompt),
      endChatLabel: asString(widgetMessages.end_chat_label),
    },
  };
}

// ── Per-slice PATCH builders ──────────────────────────────────────────────────
export function liveChatPatch(config: LiveChatConfig): Record<string, unknown> {
  return {
    live_chat_enabled: config.enabled,
    waiting_message: config.waitingMessage,
    offline_message: config.offlineMessage,
    handoff_delay_seconds: config.handoffDelaySeconds,
    live_chat_queue_timeout_seconds: clamp(
      config.queueTimeoutSeconds,
      QUEUE_TIMEOUT.min,
      QUEUE_TIMEOUT.max,
    ),
    live_chat_max_queue_size: clamp(config.maxQueueSize, MAX_QUEUE.min, MAX_QUEUE.max),
  };
}

export function leadFormPatch(config: LeadFormConfig): Record<string, unknown> {
  return {
    lead_form_enabled: config.enabled,
    lead_form_fields: config.fields.map((f) => ({ field: f.field, required: f.required })),
  };
}

export function servicesPatch(services: ServiceEntry[]): Record<string, unknown> {
  const cleaned = services
    .map((s) => ({ name: s.name.trim(), url: s.url.trim() }))
    .filter((s) => s.name.length > 0)
    .map((s) => ({ name: s.name, url: s.url.length > 0 ? s.url : null }));
  return { services: cleaned };
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
