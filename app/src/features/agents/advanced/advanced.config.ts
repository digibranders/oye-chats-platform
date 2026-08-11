import {
  type LucideIcon,
  Paperclip,
  ThumbsUp,
  ListOrdered,
  MessageCircle,
  FileText,
  Wand2,
  Timer,
  AlertTriangle,
  Wifi,
  ArrowRightLeft,
} from 'lucide-react';

/**
 * Advanced tab - configuration model + constants.
 *
 * The technical knobs surfaced here map to reused Bot fields:
 *  - `relevance_threshold`      → answering-scope strictness (RAG relevance gate)
 *  - `qualification_framework`  + `bant_config` → lead-qualification framework
 *  - `feature_flags`            → widget behaviour toggles
 *  - `widget_config`            → timing / reliability knobs (all values in ms
 *                                 except message counts)
 *
 * Shapes & defaults are lifted from the legacy references so persisted values
 * stay byte-compatible:
 *  - pages/bot-settings/AdvancedSettingsTab.jsx (widget_config defaults)
 *  - pages/bot-settings/BehaviorTab.jsx        (feature_flags defaults)
 *  - pages/Qualification.jsx                   (framework catalog + thresholds)
 */

// ── Answering scope (relevance_threshold) ────────────────────────────────────

export interface StrictnessLevel {
  readonly value: number;
  readonly label: string;
  readonly help: string;
}

/** Platform default applied when `relevance_threshold` is unset (null). */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.55;

/** Mirrors STRICTNESS_LEVELS in AdvancedSettingsTab.jsx. */
export const STRICTNESS_LEVELS: readonly StrictnessLevel[] = [
  {
    value: 0.45,
    label: 'Lenient',
    help: 'Answers more questions even when the match is weak. Best when your knowledge base still has gaps.',
  },
  {
    value: 0.55,
    label: 'Balanced',
    help: 'A sensible mix of helpfulness and staying on-topic. Recommended for most sites.',
  },
  {
    value: 0.65,
    label: 'Strict',
    help: 'Declines anything not clearly covered by your content. Best for regulated or sensitive topics.',
  },
];

/** True when a saved threshold matches a preset (tolerant of float drift). */
export function matchesLevel(threshold: number | null, level: number): boolean {
  const effective = threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  return Math.abs(effective - level) < 0.01;
}

// ── Lead qualification framework ─────────────────────────────────────────────

export interface FrameworkOption {
  readonly key: string;
  readonly label: string;
}

/** Mirrors FRAMEWORK_OPTIONS in Qualification.jsx. */
export const FRAMEWORK_OPTIONS: readonly FrameworkOption[] = [
  { key: 'bant', label: 'BANT (default)' },
  { key: 'meddic', label: 'MEDDIC' },
  { key: 'champ', label: 'CHAMP' },
  { key: 'gpctba_ci', label: 'GPCTBA/CI' },
  { key: 'custom', label: 'Custom' },
];

// ── Widget behaviour flags (feature_flags) ───────────────────────────────────

export interface FeatureFlagDef {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly icon: LucideIcon;
  readonly default: boolean;
}

/** Mirrors FEATURE_FLAGS in BehaviorTab.jsx (keys + model defaults). */
export const FEATURE_FLAGS: readonly FeatureFlagDef[] = [
  { key: 'file_sharing', label: 'File sharing', desc: 'Let visitors attach files in the chat.', icon: Paperclip, default: false },
  { key: 'post_chat_rating', label: 'Post-chat rating', desc: 'Ask visitors to rate the conversation when it ends.', icon: ThumbsUp, default: true },
  // NOTE: "Powered by" branding (show_branding) is intentionally NOT listed here.
  // It's a plan-gated control owned by Experience ▸ Branding
  // (gated on the `branding_removable` feature); an ungated toggle here would be
  // a silent no-op for plans the server forces show_branding=true on.
  { key: 'queue_position', label: 'Queue position', desc: 'Show visitors their place in the live-chat queue.', icon: ListOrdered, default: false },
  { key: 'typing_preview', label: 'Typing indicator', desc: 'Show a typing animation while the AI Chatbot or an operator replies.', icon: MessageCircle, default: true },
  { key: 'email_transcript', label: 'Email transcript', desc: 'Offer visitors an emailed copy of the conversation.', icon: FileText, default: false },
];

export const DEFAULT_FEATURE_FLAGS: Readonly<Record<string, boolean>> = Object.fromEntries(
  FEATURE_FLAGS.map((flag) => [flag.key, flag.default]),
);

// ── Timing & reliability (widget_config) ─────────────────────────────────────

/**
 * How a knob is displayed and stored:
 *  - `seconds` - stored as ms, edited in seconds (÷1000 / ×1000)
 *  - `ms`      - stored and edited in milliseconds
 *  - `count`   - a plain integer (e.g. a number of messages)
 */
export type ConfigUnit = 'seconds' | 'ms' | 'count';

export interface ConfigFieldDef {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly unit: ConfigUnit;
  /** Stored default (ms for time knobs, integer for counts). */
  readonly defaultValue: number;
  /** Step in *display* units. */
  readonly step: number;
  readonly min: number;
}

export interface ConfigGroupDef {
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly fields: readonly ConfigFieldDef[];
}

/** Grouped widget_config knobs. Defaults mirror AdvancedSettingsTab.jsx. */
export const CONFIG_GROUPS: readonly ConfigGroupDef[] = [
  {
    title: 'Welcome animation',
    description: 'Timing of the welcome screen and greeting bubble.',
    icon: Wand2,
    fields: [
      { key: 'welcome_exit_duration_ms', label: 'Welcome screen fade-out', help: 'How long the welcome screen takes to fade away.', unit: 'seconds', defaultValue: 350, step: 0.1, min: 0 },
      { key: 'greeting_delay_ms', label: 'Greeting bubble delay', help: 'Wait time before the greeting bubble appears.', unit: 'seconds', defaultValue: 3000, step: 0.1, min: 0 },
    ],
  },
  {
    title: 'Interaction timeouts',
    description: 'Limits for transient states like the typing indicator.',
    icon: Timer,
    fields: [
      { key: 'typing_timeout_ms', label: 'Typing indicator timeout', help: 'How long the typing indicator stays up before clearing.', unit: 'seconds', defaultValue: 2000, step: 0.1, min: 0 },
    ],
  },
  {
    title: 'Frustration detection',
    description: 'Notice when a visitor sends rapid messages in a row.',
    icon: AlertTriangle,
    fields: [
      { key: 'frustration_window_ms', label: 'Detection window', help: 'Time window checked for a burst of messages.', unit: 'seconds', defaultValue: 30000, step: 1, min: 0 },
      { key: 'frustration_threshold_messages', label: 'Message threshold', help: 'Messages within the window that trigger a frustration flag.', unit: 'count', defaultValue: 3, step: 1, min: 1 },
    ],
  },
  {
    title: 'Connection & reconnection',
    description: 'How the widget recovers a dropped connection.',
    icon: Wifi,
    fields: [
      { key: 'max_reconnect_attempts', label: 'Max reconnection attempts', help: 'How many times to retry before giving up.', unit: 'count', defaultValue: 15, step: 1, min: 1 },
      { key: 'max_reconnect_delay_ms', label: 'Max reconnection delay', help: 'Longest wait between retries (exponential backoff).', unit: 'seconds', defaultValue: 30000, step: 1, min: 0 },
      { key: 'heartbeat_visible_ms', label: 'Heartbeat - widget open', help: 'How often to ping the server while the widget is visible.', unit: 'seconds', defaultValue: 25000, step: 1, min: 1 },
      { key: 'heartbeat_hidden_ms', label: 'Heartbeat - widget hidden', help: 'How often to ping the server while the widget is hidden.', unit: 'seconds', defaultValue: 50000, step: 1, min: 1 },
    ],
  },
  {
    title: 'Handoff to an operator',
    description: 'Fine-tuning for the AI Chatbot-to-operator handoff form.',
    icon: ArrowRightLeft,
    fields: [
      { key: 'handoff_auto_submit_delay_ms', label: 'Auto-submit delay', help: 'Pause before auto-submitting the handoff form once every field is filled.', unit: 'ms', defaultValue: 300, step: 50, min: 0 },
    ],
  },
];

/** Flat default map derived from CONFIG_GROUPS. */
export const DEFAULT_WIDGET_CONFIG: Readonly<Record<string, number>> = Object.fromEntries(
  CONFIG_GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field.defaultValue])),
);

// ── Draft model + parsing ────────────────────────────────────────────────────

/** The editable slice of a bot's technical settings, in a normalized shape. */
export interface AdvancedDraft {
  /** null = use the platform default strictness. */
  relevanceThreshold: number | null;
  qualificationFramework: string;
  /** Opaque scoring config; only replaced when the framework changes. */
  bantConfig: Record<string, unknown> | null;
  featureFlags: Record<string, boolean>;
  widgetConfig: Record<string, number>;
  /**
   * Per-agent opt-OUT for metered Reoon email verification. Bound to the
   * `email_verification_enabled` Bot field; defaults ON. Only effective on
   * Standard / Professional plans (enforced server-side).
   */
  emailVerificationEnabled: boolean;
  /**
   * Per-agent opt-OUT for the metered IP→company lookup. Bound to the
   * `company_lookup_enabled` Bot field; defaults ON. Professional-only, and
   * charged only when a company is actually identified.
   */
  companyLookupEnabled: boolean;
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

/** Narrow the loosely-typed `getClientSettings` payload into an AdvancedDraft. */
export function parseSettings(raw: Record<string, unknown>): AdvancedDraft {
  const threshold = raw.relevance_threshold;
  const framework = raw.qualification_framework;
  return {
    relevanceThreshold: typeof threshold === 'number' ? threshold : null,
    qualificationFramework: typeof framework === 'string' && framework ? framework : 'bant',
    bantConfig: isRecord(raw.bant_config) ? raw.bant_config : null,
    featureFlags: mergeFlags(raw.feature_flags),
    widgetConfig: mergeConfig(raw.widget_config),
    // `!== false`, not `=== true`: the columns default ON, so an absent field
    // (an older API build, a partial payload) must read as ON. `=== true`
    // would silently show every agent's paid enrichment as switched off.
    emailVerificationEnabled: raw.email_verification_enabled !== false,
    companyLookupEnabled: raw.company_lookup_enabled !== false,
  };
}

/** Pull `thresholds` ({ mql, sal, sql }) out of a bant_config for display. */
export function readThresholds(config: Record<string, unknown> | null): {
  mql: number;
  sal: number;
  sql: number;
} | null {
  if (!config || !isRecord(config.thresholds)) return null;
  const t = config.thresholds;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return { mql: num(t.mql, 30), sal: num(t.sal, 55), sql: num(t.sql, 75) };
}

/** Look up a framework preset (a bant_config) from the presets payload. */
export function presetForFramework(
  presets: Record<string, unknown>,
  framework: string,
): Record<string, unknown> | null {
  const preset = presets[framework];
  return isRecord(preset) ? preset : null;
}
