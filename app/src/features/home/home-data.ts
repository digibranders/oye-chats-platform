/**
 * Home - pure data + business logic layer (no React, no UI).
 *
 * The Home page answers "How is my business doing today?" across ALL agents
 * (not one bot). The legacy Dashboard (`pages/Dashboard.jsx`) is scoped to a
 * single `selectedBot`; here we aggregate the same per-bot endpoints into one
 * workspace-wide view. Everything in this module is a pure function so it can be
 * unit-tested and kept free of fabricated data - we only surface numbers the API
 * actually returned.
 */
import type { Bot, TopQuestion } from '../../types/domain';
import type { FeedbackItem } from '../feedback/types';
import { t as translateNow } from '../../i18n/i18n';

// ── Primitive coercion helpers ───────────────────────────────────────────────

/** Coerce an unknown API value to a finite number, defaulting to 0. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Coerce an unknown API value to a trimmed non-empty string, else null. */
export function toText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Return the first finite number found across `keys` on `source`. Lets us read
 * the same figure under either of the server's synonym fields (e.g. the lead
 * tier appears as `hot` OR `sal` depending on the qualification framework).
 */
export function pickNumber(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): number {
  if (!source) return 0;
  for (const key of keys) {
    if (key in source) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return 0;
}

/** Sum the finite numbers found at each of `keys` on `source` (missing → 0). */
export function sumNumbers(
  source: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): number {
  if (!source) return 0;
  return keys.reduce((acc, key) => acc + toNumber(source[key]), 0);
}

// ── Agent health ─────────────────────────────────────────────────────────────

export type HealthTone = 'success' | 'warning' | 'danger' | 'info';

export interface AgentHealth {
  /** Short, jargon-free status shown on the badge. */
  label: string;
  tone: HealthTone;
  /** True when the agent can't yet do its job (untrained / failed training). */
  needsAttention: boolean;
}

/**
 * Derive an agent's operational health from the reused Bot fields. Mirrors the
 * real lifecycle: train → deploy → live.
 */
export function deriveAgentHealth(bot: Bot): AgentHealth {
  const trained = isTrained(bot);
  const installed = Boolean(bot.widget_installed_at);

  // Trained-state first (same rule as agent-health.ts): a failed
  // `last_crawl_status` only describes the last ATTEMPT, so it must not
  // override what the agent currently knows. Checking it first made a single
  // failed recrawl report a fully-trained live agent as "Needs attention".
  if (!trained) {
    if (bot.last_crawl_status === 'failed') {
      return { label: translateNow('home.needsAttention') || 'Needs attention', tone: 'danger', needsAttention: true };
    }
    return { label: translateNow('home.notTrainedYet') || 'Not trained yet', tone: 'warning', needsAttention: true };
  }
  if (!installed) {
    return { label: translateNow('home.readyToDeploy') || 'Ready to deploy', tone: 'info', needsAttention: false };
  }
  return { label: 'Live', tone: 'success', needsAttention: false };
}

/** An agent counts as trained once it has indexed knowledge or a finished crawl. */
export function isTrained(bot: Bot): boolean {
  return (bot.indexed_chunk_count ?? 0) > 0 || Boolean(bot.crawl_completed_at);
}

// ── Aggregated view models ───────────────────────────────────────────────────

export interface AgentSummary {
  bot: Bot;
  health: AgentHealth;
  trained: boolean;
  installed: boolean;
  crawlFailed: boolean;
  conversations: number;
  messages: number;
  /** Qualified leads (MQL + SAL + SQL) captured by this agent. */
  leads: number;
  hotLeads: number;
  /** Answer success rate for this agent, as a percentage (0 to 100). */
  successRate: number;
  /** Active operators assigned to this agent (per-bot seat usage). */
  operators: number;
  /** Distinct knowledge documents/sources ingested for this agent. */
  documents: number;
}

export interface HomeTotals {
  conversations: number;
  messages: number;
  /** Qualified leads (MQL + SAL + SQL) across all agents. */
  leads: number;
  hotLeads: number;
  /** Conversation-weighted answer success rate across all agents (0 to 100). */
  successRate: number;
}

export type ActivityKind = 'positive-feedback' | 'negative-feedback' | 'message';

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  title: string;
  meta: string | null;
  /** Epoch millis for sorting. */
  at: number;
  /** Original ISO timestamp for display. */
  iso: string;
}

export interface HomeData {
  agents: AgentSummary[];
  totals: HomeTotals;
  topQuestions: TopQuestion[];
  activity: ActivityEntry[];
  /** Unread / new visitor messages waiting in the inbox. */
  unreadMessages: number;
}

// ── Per-agent stat parsing ───────────────────────────────────────────────────

// Qualified leads = every tier above "unqualified" (MQL + SAL + SQL). The
// lead-stats endpoint's `total` counts ALL chat sessions, which is identical to
// getDashboardStats' conversation count - so we surface qualified leads instead
// to keep this KPI honest and non-redundant with "Conversations".
const LEAD_QUALIFIED_KEYS = ['mql', 'sal', 'sql'] as const;
const LEAD_HOT_KEYS = ['hot', 'sal'] as const;

export interface AgentStatsInput {
  bot: Bot;
  /** Result of getDashboardStats(bot.id); null if the call failed. */
  stats: Record<string, unknown> | null;
  /** Result of getLeadStats(bot.id); null if the call failed. */
  leads: Record<string, unknown> | null;
  /** Active operators bound to this bot, tallied from the workspace roster. */
  operators: number;
}

/** Build one agent's summary row from its raw stats payloads. */
export function summarizeAgent(input: AgentStatsInput): AgentSummary {
  const { bot, stats, leads, operators } = input;
  const trained = isTrained(bot);
  return {
    bot,
    health: deriveAgentHealth(bot),
    trained,
    installed: Boolean(bot.widget_installed_at),
    crawlFailed: bot.last_crawl_status === 'failed',
    conversations: toNumber(stats?.total_conversations),
    messages: toNumber(stats?.total_messages),
    leads: sumNumbers(leads, LEAD_QUALIFIED_KEYS),
    hotLeads: pickNumber(leads, LEAD_HOT_KEYS),
    successRate: toNumber(stats?.success_rate),
    operators,
    documents: toNumber(stats?.total_documents),
  };
}

/** Roll up per-agent summaries into workspace totals. */
export function aggregateTotals(agents: AgentSummary[]): HomeTotals {
  const totals: HomeTotals = {
    conversations: 0,
    messages: 0,
    leads: 0,
    hotLeads: 0,
    successRate: 0,
  };

  let weightedRate = 0;
  let rateWeight = 0;
  let rateSampleSum = 0;
  let rateSampleCount = 0;

  agents.forEach((agent) => {
    totals.conversations += agent.conversations;
    totals.messages += agent.messages;
    totals.leads += agent.leads;
    totals.hotLeads += agent.hotLeads;

    if (agent.conversations > 0) {
      weightedRate += agent.successRate * agent.conversations;
      rateWeight += agent.conversations;
    }
    if (agent.successRate > 0) {
      rateSampleSum += agent.successRate;
      rateSampleCount += 1;
    }
  });

  // Prefer a conversation-weighted rate; fall back to a simple mean so a
  // workspace with reported rates but no counted conversations still shows one.
  if (rateWeight > 0) {
    totals.successRate = weightedRate / rateWeight;
  } else if (rateSampleCount > 0) {
    totals.successRate = rateSampleSum / rateSampleCount;
  }

  return totals;
}

// ── Top questions (cross-agent merge) ────────────────────────────────────────

/**
 * Merge each agent's top-questions into one workspace ranking, summing counts
 * for questions asked across multiple agents. Case-insensitive on the key,
 * first-seen casing wins for display.
 */
export function mergeTopQuestions(perAgent: readonly TopQuestion[][], limit = 6): TopQuestion[] {
  const byKey = new Map<string, TopQuestion>();

  perAgent.forEach((list) => {
    list.forEach((row) => {
      const question = toText(row.question);
      if (!question) return;
      const key = question.toLowerCase();
      const existing = byKey.get(key);
      const count = toNumber(row.count);
      if (existing) {
        existing.count += count;
      } else {
        byKey.set(key, { question, count });
      }
    });
  });

  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

// ── Activity feed ────────────────────────────────────────────────────────────

export interface FeedbackBucket {
  botName: string;
  items: FeedbackItem[];
}

export interface OfflineActivityInput {
  visitorName: string | null;
  message: string | null;
  botName: string | null;
  createdAt: string | null;
}

/** Parse a raw millis value from an ISO/date-like string, or null. */
function millisOf(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Build the recent-activity feed by interleaving answer feedback (per agent)
 * and new inbox messages (workspace-wide), newest first.
 */
export function buildActivity(
  feedback: readonly FeedbackBucket[],
  offline: readonly OfflineActivityInput[],
  limit = 8,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  feedback.forEach((bucket) => {
    bucket.items.forEach((item, index) => {
      const iso = toText(item.created_at);
      const at = millisOf(iso);
      if (at === null || iso === null) return;
      const positive = toNumber(item.feedback) === 1;
      const question = toText(item.question);
      entries.push({
        id: `feedback-${bucket.botName}-${index}-${at}`,
        kind: positive ? 'positive-feedback' : 'negative-feedback',
        title: positive ? translateNow('home.answerMarkedHelpful') || 'Answer marked helpful' : translateNow('home.answerMarkedUnhelpful') || 'Answer marked unhelpful',
        meta: question ? `“${question}” · ${bucket.botName}` : bucket.botName,
        at,
        iso,
      });
    });
  });

  offline.forEach((msg, index) => {
    const at = millisOf(msg.createdAt);
    if (at === null || msg.createdAt === null) return;
    const who = msg.visitorName ?? 'A visitor';
    const meta = msg.message ?? msg.botName;
    entries.push({
      id: `message-${index}-${at}`,
      kind: 'message',
      title: translateNow('home.newMessageFrom', { who }) || `New message from ${who}`,
      meta: meta ?? null,
      at,
      iso: msg.createdAt,
    });
  });

  return entries.sort((a, b) => b.at - a.at).slice(0, limit);
}

// ── Presentation-neutral formatting ──────────────────────────────────────────

/** Time-of-day greeting for the page header. */
export function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return translateNow('home.goodMorning') || 'Good morning';
  if (hour < 18) return translateNow('home.goodAfternoon') || 'Good afternoon';
  return translateNow('home.goodEvening') || 'Good evening';
}

/**
 * First name for the header salutation, e.g. "Gaurav Sharma" → "Gaurav".
 *
 * The greeting addresses a PERSON, so it must never fall back to the workspace
 * / company name - "Good afternoon, Fynix 👋" is worse than no name at all.
 * Returns `''` for anything unusable (missing, blank, whitespace-only), which
 * the header renders as a plain "Good afternoon 👋".
 *
 * A single-word name is returned unchanged; a mononym is a real name, not an
 * error. Extra internal whitespace is tolerated.
 */
export function firstName(fullName: string | null | undefined): string {
  const trimmed = fullName?.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

/** Long-form date, e.g. "Monday, July 21". */
export function formatToday(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Compact relative time for activity rows: "just now", "5m ago", "3h ago",
 * "2d ago", then an absolute short date beyond a week. Empty string if invalid.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, now - then);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
