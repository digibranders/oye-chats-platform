import {
  type LucideIcon,
  FileText,
  ListOrdered,
  MessageCircle,
  Paperclip,
  ThumbsUp,
} from 'lucide-react';

/**
 * Behaviour — the configuration model for the technical corner of a chatbot.
 *
 * Every field here maps to a real `Bot` column that `PATCH /bots/{id}` accepts:
 *
 * | Draft field | Column | Contract |
 * |---|---|---|
 * | `relevanceThreshold` | `relevance_threshold` | `float 0..1`, null = env default |
 * | `featureFlags` | `feature_flags` | shallow-merged server-side |
 * | `widgetConfig` | `widget_config` | shallow-merged server-side |
 * | `operatorTimeoutSeconds` | `operator_timeout_seconds` | `int 5..3600` |
 *
 * Deliberately absent, and why:
 *
 * - **`allowed_domains`, `domain_check_enabled` and `session_share_domain`** are
 *   owned by Deploy ▸ Access (`features/agents/channels/accessModel.ts`), beside
 *   the install status that sends people looking for them.
 *
 * - **Live chat's queue timeout, queue cap, handoff delay and on/off switch** are
 *   writable, but Experience already owns them (`features/agents/experience/botConfig.ts`).
 *   Two surfaces writing one field is the disease this rebuild exists to cure.
 * - **`show_branding`** is plan-gated and owned by Experience ▸ Branding. An
 *   ungated toggle here would be a silent no-op on every plan the server forces
 *   it true for.
 * - **`visitor_disconnect_timeout`** became writable and is owned by Settings ▸
 *   Team ▸ Routing (`features/workspace/queueSettings.ts`), beside the other
 *   three live-chat timers, for the same one-field-one-surface reason.
 * - **`is_active`** (pause / resume this chatbot) is writable and is owned by the
 *   chatbot's own actions menu, because resuming is an admission decision the
 *   server can refuse — not a form field.
 * - **Routing strategy and `operator_disconnect_timeout`** are still columns no
 *   control can move, and both are inert. See the note at the end of this file.
 */

// ── Answering scope (relevance_threshold) ────────────────────────────────────

export interface StrictnessLevel {
  readonly value: number;
  readonly label: string;
  readonly help: string;
}

/** Applied when `relevance_threshold` is null — `RELEVANCE_THRESHOLD` in config.py. */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.55;

export const STRICTNESS_LEVELS: readonly StrictnessLevel[] = [
  {
    value: 0.45,
    label: 'Lenient',
    help: 'Answers more questions even when the match is weak. Best while your knowledge base still has gaps.',
  },
  {
    value: 0.55,
    label: 'Balanced',
    help: 'A sensible mix of helpfulness and staying on topic. Right for most sites.',
  },
  {
    value: 0.65,
    label: 'Strict',
    help: 'Declines anything not clearly covered by your content. Best for regulated or sensitive topics.',
  },
];

/** True when a saved threshold matches a preset, tolerating float drift. */
export function matchesLevel(threshold: number | null, level: number): boolean {
  const effective = threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  return Math.abs(effective - level) < 0.01;
}

// ── Widget behaviour flags (feature_flags) ───────────────────────────────────

export interface FeatureFlagDef {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly icon: LucideIcon;
  readonly default: boolean;
  /** Only meaningful when live chat is on — the flag drives a live-chat UI. */
  readonly needsLiveChat?: boolean;
}

export const FEATURE_FLAGS: readonly FeatureFlagDef[] = [
  {
    key: 'file_sharing',
    label: 'File sharing',
    desc: 'Let visitors attach files in the chat.',
    icon: Paperclip,
    default: false,
  },
  {
    key: 'post_chat_rating',
    label: 'Post-chat rating',
    desc: 'Ask visitors to rate the conversation.',
    icon: ThumbsUp,
    default: true,
  },
  {
    key: 'queue_position',
    label: 'Queue position',
    desc: 'Show visitors their place in the live-chat queue while they wait for an operator.',
    icon: ListOrdered,
    default: false,
    needsLiveChat: true,
  },
  {
    key: 'typing_preview',
    label: 'Typing indicator',
    desc: 'Show a typing animation while the chatbot or an operator is replying.',
    icon: MessageCircle,
    default: true,
  },
  {
    key: 'email_transcript',
    label: 'Email transcript',
    desc: 'Offer visitors an emailed copy of the conversation.',
    icon: FileText,
    default: false,
  },
];

export const DEFAULT_FEATURE_FLAGS: Readonly<Record<string, boolean>> = Object.fromEntries(
  FEATURE_FLAGS.map((flag) => [flag.key, flag.default]),
);

/**
 * What the widget actually uses on a Free workspace.
 *
 * `get_bot_settings_public` (api/app/api/bot_routes.py:925) overrides every one
 * of these to `false` for `plan_slug == "free"`, whatever is stored. The stored
 * values are left intact and come back on upgrade, so the switches are shown in
 * their saved position with the override stated — not silently flipped, which
 * would misreport what is on the record.
 */
export const FREE_PLAN_FORCED_OFF: readonly string[] = FEATURE_FLAGS.map((flag) => flag.key);

// ── Timing & reliability (widget_config) ─────────────────────────────────────

export type ConfigUnit = 'seconds' | 'ms' | 'count';

export interface ConfigFieldDef {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly unit: ConfigUnit;
  /** Stored default — ms for time knobs, an integer for counts. */
  readonly defaultValue: number;
  /** Step in display units. */
  readonly step: number;
  /** Minimum in display units. */
  readonly min: number;
  /** Maximum in display units. Bounds a value that would break the widget. */
  readonly max: number;
}

export interface ConfigGroupDef {
  readonly title: string;
  readonly fields: readonly ConfigFieldDef[];
}

export const CONFIG_GROUPS: readonly ConfigGroupDef[] = [
  {
    title: 'Welcome animation',
    fields: [
      {
        key: 'welcome_exit_duration_ms',
        label: 'Welcome screen fade-out',
        help: 'How long the welcome screen takes to fade away.',
        unit: 'seconds',
        defaultValue: 350,
        step: 0.1,
        min: 0,
        max: 5,
      },
      {
        key: 'greeting_delay_ms',
        label: 'Greeting bubble delay',
        help: 'Wait before the greeting bubble appears beside the launcher.',
        unit: 'seconds',
        defaultValue: 3000,
        step: 0.1,
        min: 0,
        max: 60,
      },
    ],
  },
  {
    title: 'Interaction timeouts',
    fields: [
      {
        key: 'typing_timeout_ms',
        label: 'Typing indicator timeout',
        help: 'How long the typing indicator stays up before clearing itself.',
        unit: 'seconds',
        defaultValue: 2000,
        step: 0.1,
        min: 0.5,
        max: 60,
      },
    ],
  },
  {
    title: 'Frustration detection',
    fields: [
      {
        key: 'frustration_window_ms',
        label: 'Detection window',
        help: 'The window checked for a burst of messages.',
        unit: 'seconds',
        defaultValue: 30000,
        step: 1,
        min: 1,
        max: 600,
      },
      {
        key: 'frustration_threshold_messages',
        label: 'Message threshold',
        help: 'Messages inside the window that raise a frustration flag.',
        unit: 'count',
        defaultValue: 3,
        step: 1,
        min: 2,
        max: 20,
      },
    ],
  },
  {
    title: 'Connection recovery',
    fields: [
      {
        key: 'max_reconnect_attempts',
        label: 'Reconnection attempts',
        help: 'How many times to retry before giving up.',
        unit: 'count',
        defaultValue: 15,
        step: 1,
        min: 1,
        max: 100,
      },
      {
        key: 'max_reconnect_delay_ms',
        label: 'Longest retry gap',
        help: 'The ceiling on the exponential backoff between retries.',
        unit: 'seconds',
        defaultValue: 30000,
        step: 1,
        min: 1,
        max: 300,
      },
      {
        key: 'heartbeat_visible_ms',
        label: 'Heartbeat, widget open',
        help: 'How often the widget pings the server while the visitor can see it.',
        unit: 'seconds',
        defaultValue: 25000,
        step: 1,
        min: 5,
        max: 300,
      },
      {
        key: 'heartbeat_hidden_ms',
        label: 'Heartbeat, widget hidden',
        help: 'How often it pings while minimised. Longer saves the visitor’s battery.',
        unit: 'seconds',
        defaultValue: 50000,
        step: 1,
        min: 5,
        max: 600,
      },
    ],
  },
  {
    title: 'Handoff form',
    fields: [
      {
        key: 'handoff_auto_submit_delay_ms',
        label: 'Auto-submit delay',
        help: 'Pause before the handoff form submits itself once every field is filled.',
        unit: 'ms',
        defaultValue: 300,
        step: 50,
        min: 0,
        max: 5000,
      },
    ],
  },
];

export const DEFAULT_WIDGET_CONFIG: Readonly<Record<string, number>> = Object.fromEntries(
  CONFIG_GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field.defaultValue])),
);

/** Every field, flattened — for validation and for tests that walk the set. */
export const CONFIG_FIELDS: readonly ConfigFieldDef[] = CONFIG_GROUPS.flatMap(
  (group) => group.fields,
);

/** Stored value → the value shown in the field's unit. */
export function toDisplay(field: ConfigFieldDef, stored: number): number {
  if (field.unit !== 'seconds') return stored;
  // Two decimals, so 350 ms reads as 0.35 rather than 0.35000000000000003.
  return Math.round((stored / 1000) * 100) / 100;
}

/** A raw input string → the stored value, clamped into the field's bounds. */
export function toStored(field: ConfigFieldDef, raw: string): number {
  const parsed = field.unit === 'count' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return field.defaultValue;
  const display = Math.min(field.max, Math.max(field.min, parsed));
  if (field.unit === 'seconds') return Math.round(display * 1000);
  if (field.unit === 'count') return Math.round(display);
  return Math.round(display);
}

// ── Operator response window (operator_timeout_seconds) ──────────────────────

/** Mirrors `Field(None, ge=5, le=3600)` on `UpdateBotRequest`. */
export const OPERATOR_TIMEOUT = { min: 5, max: 3600, default: 120 } as const;

export function operatorTimeoutError(value: number): string | null {
  if (!Number.isInteger(value)) return 'Use a whole number of seconds.';
  if (value < OPERATOR_TIMEOUT.min || value > OPERATOR_TIMEOUT.max) {
    return `The server accepts ${OPERATOR_TIMEOUT.min} to ${OPERATOR_TIMEOUT.max} seconds. ${value} would be rejected when you save.`;
  }
  return null;
}

// ── Draft model ──────────────────────────────────────────────────────────────

export interface BehaviourDraft {
  /** null = use the platform default strictness. */
  relevanceThreshold: number | null;
  featureFlags: Record<string, boolean>;
  widgetConfig: Record<string, number>;
  /** Seconds an operator has to accept a handoff before it is re-offered. */
  operatorTimeoutSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeFlags(raw: unknown): Record<string, boolean> {
  const merged: Record<string, boolean> = { ...DEFAULT_FEATURE_FLAGS };
  if (isRecord(raw)) {
    for (const flag of FEATURE_FLAGS) {
      const stored = raw[flag.key];
      if (typeof stored === 'boolean') merged[flag.key] = stored;
    }
  }
  return merged;
}

function mergeConfig(raw: unknown): Record<string, number> {
  const merged: Record<string, number> = { ...DEFAULT_WIDGET_CONFIG };
  if (isRecord(raw)) {
    for (const key of Object.keys(DEFAULT_WIDGET_CONFIG)) {
      const stored = raw[key];
      if (typeof stored === 'number' && Number.isFinite(stored)) merged[key] = stored;
    }
  }
  return merged;
}

/** Narrow the loosely-typed `GET /bots/{id}` payload into a Behaviour draft. */
export function parseBehaviour(raw: Record<string, unknown>): BehaviourDraft {
  const threshold = raw.relevance_threshold;
  const timeout = raw.operator_timeout_seconds;
  return {
    relevanceThreshold: typeof threshold === 'number' ? threshold : null,
    featureFlags: mergeFlags(raw.feature_flags),
    widgetConfig: mergeConfig(raw.widget_config),
    operatorTimeoutSeconds:
      typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : OPERATOR_TIMEOUT.default,
  };
}

/**
 * The PATCH body for a Behaviour draft.
 *
 * A pure function rather than an inline literal in the save handler, so a test
 * can assert the whole payload. The previous page's literal lost a field to a
 * review with every test still green — and the dangerous direction of that
 * mistake is writing a wrong value, not failing to write one.
 */
export function toBehaviourPayload(draft: BehaviourDraft): Record<string, unknown> {
  return {
    relevance_threshold: draft.relevanceThreshold,
    feature_flags: draft.featureFlags,
    widget_config: draft.widgetConfig,
    operator_timeout_seconds: draft.operatorTimeoutSeconds,
  };
}

/*
 * Two `Bot` columns are stored, defaulted and never read, so there is
 * deliberately no control for either. They used to be rendered as a card on this
 * page, complete with Python `file.py:line` references and private function
 * names, which is engineering notes shipped as product — a customer's settings
 * page is not a place to publish the backend's call graph.
 *
 * - `Bot.live_chat_routing_strategy` would choose how a waiting chat picks an
 *   operator. Its only reader, `live_chat_routing_service.select_operator`, has
 *   no caller anywhere in the API; assignment is operator-pull, set when someone
 *   accepts a waiting chat.
 * - `Bot.operator_disconnect_timeout` would decide how long a dropped operator
 *   connection is held before their chats are handed back.
 *   `live_chat_service._operator_disconnect_timeout` sleeps a class constant and
 *   never reads it. The visitor-side half of the same timer does work, and is
 *   configurable under Settings ▸ Team ▸ Routing.
 *
 * Both are inert rather than merely unwritable: a control over either would
 * validate, save, echo back and change nothing.
 */
