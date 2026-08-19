/**
 * Usage model - boundary parsing for the credit balance + consumption ledger.
 *
 * The reused billing endpoints (`getCreditBalance`, `getCreditHistory`) are
 * typed only as `Record<string, unknown>` in `services/api.d.ts`, and the
 * runtime shapes are loose (the history endpoint even returns a bare array in
 * some deployments and a `{ history: [...] }` envelope in others). Every field
 * this page renders is normalized here so the components downstream can stay
 * strictly typed and never reach into `unknown`.
 *
 * Business rules mirrored from the legacy Billing surface
 * (`app/src/pages/Billing.jsx`):
 *   • Credits drain plan bucket first, then top-up - so the "running low"
 *     signal watches TOTAL remaining, not the plan bucket alone
 *     (Billing.jsx:381-386).
 *   • The ledger `reason` is an accounting bucket, not a human label; a couple
 *     of buckets need disambiguation before display (Billing.jsx:116-139).
 */

// ── Safe coercion at the boundary ────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ── Consumption breakdown ────────────────────────────────────────────────────

/** A single metered activity within the current period. */
export interface UsageBreakdownEntry {
  /** Credits spent on this activity this period. */
  readonly creditsUsed: number;
  /** How many times the activity happened (chats, files, pages). */
  readonly eventCount: number;
}

function parseBreakdown(value: unknown): UsageBreakdownEntry {
  const record = asRecord(value);
  return {
    creditsUsed: toNumber(record.credits_used),
    eventCount: toNumber(record.event_count),
  };
}

/** The metered activity buckets the backend returns for each pool. */
export interface UsageBuckets {
  readonly aiChat: UsageBreakdownEntry;
  readonly documentUpload: UsageBreakdownEntry;
  readonly urlScan: UsageBreakdownEntry;
  readonly emailSend: UsageBreakdownEntry;
  /** Reoon email verification (Standard + Professional), 10 credits each. */
  readonly emailVerification: UsageBreakdownEntry;
  /** IP → company lookup / Visitor Intelligence (Professional), 10 credits each. */
  readonly companyName: UsageBreakdownEntry;
}

function parseUsageBuckets(value: unknown): UsageBuckets {
  const usage = asRecord(value);
  return {
    aiChat: parseBreakdown(usage.ai_chat),
    documentUpload: parseBreakdown(usage.document_upload),
    urlScan: parseBreakdown(usage.url_scan),
    // email_send is a metered, credit-costing activity
    // (subscription_routes.py:1693) - omitting it under-reports spend.
    emailSend: parseBreakdown(usage.email_send),
    emailVerification: parseBreakdown(usage.email_verification),
    companyName: parseBreakdown(usage.company_name),
  };
}

function addBreakdown(a: UsageBreakdownEntry, b: UsageBreakdownEntry): UsageBreakdownEntry {
  return { creditsUsed: a.creditsUsed + b.creditsUsed, eventCount: a.eventCount + b.eventCount };
}

/** Earlier of two ISO dates, skipping nulls and unparseable values. */
function earliestDate(a: string | null, b: string | null): string | null {
  const at = a ? new Date(a).getTime() : NaN;
  const bt = b ? new Date(b).getTime() : NaN;
  if (Number.isNaN(at)) return Number.isNaN(bt) ? null : b;
  if (Number.isNaN(bt)) return a;
  return at <= bt ? a : b;
}

// ── What a credit buys ───────────────────────────────────────────────────────

/**
 * The metered actions, in the order a customer thinks about them.
 *
 * `key` matches both the `costs` map and the `usage` buckets on
 * `GET /credits/balance`, so one list drives the price table and the
 * consumption breakdown and the two cannot fall out of step.
 */
export const CREDIT_ACTIONS = [
  { key: 'ai_chat', bucket: 'aiChat', label: 'AI reply', unit: 'reply' },
  { key: 'url_scan', bucket: 'urlScan', label: 'Page crawled', unit: 'page' },
  { key: 'document_upload', bucket: 'documentUpload', label: 'Document trained', unit: 'document' },
  { key: 'email_send', bucket: 'emailSend', label: 'Customer email', unit: 'email' },
  { key: 'email_verification', bucket: 'emailVerification', label: 'Email verified', unit: 'check' },
  { key: 'company_name', bucket: 'companyName', label: 'Company identified', unit: 'lookup' },
] as const;

export type CreditActionKey = (typeof CREDIT_ACTIONS)[number]['key'];
export type CreditActionBucket = (typeof CREDIT_ACTIONS)[number]['bucket'];

/**
 * Per-action credit costs as configured on the server.
 *
 * A value of `null` means the balance payload did not carry a cost for that
 * action. That is NOT the same as "free": a super-admin can remove a key, and
 * printing 0 credits beside an action that still charges is exactly the lie
 * this replaces. Callers render an em dash instead.
 */
export type CreditCosts = Readonly<Record<CreditActionKey, number | null>>;

function parseCreditCosts(value: unknown): CreditCosts {
  const record = asRecord(value);
  const out = {} as Record<CreditActionKey, number | null>;
  for (const action of CREDIT_ACTIONS) {
    const raw = record[action.key];
    const parsed = typeof raw === 'string' ? Number(raw) : raw;
    out[action.key] =
      typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return out;
}

/** "1 credit" / "3 credits" / null when the server declared no cost. */
export function formatCost(cost: number | null): string | null {
  if (cost === null) return null;
  return `${formatCredits(cost)} credit${cost === 1 ? '' : 's'}`;
}

// ── Credit balance ───────────────────────────────────────────────────────────

/**
 * One credit pool the workspace draws from: either the account pool (legacy +
 * Free bots) or a single bot that carries its own paid subscription. Both the
 * account object and each `bots[]` entry expose the same field names
 * (subscription_routes.py:1740-1758, 1795-1808), so they parse identically.
 */
interface CreditPool {
  readonly monthlyGrant: number;
  readonly planRemaining: number;
  readonly topupRemaining: number;
  readonly totalRemaining: number;
  /**
   * When the current allowance period began - the timestamp of the most recent
   * `plan_grant`. Every consumption figure on this page is scoped to it, so a
   * surface that renders one without naming this window is quoting a number
   * over an unstated period.
   */
  readonly periodStart: string | null;
  readonly resetsAt: string | null;
  readonly soonestExpiry: string | null;
  readonly usage: UsageBuckets;
}

function parsePool(record: Record<string, unknown>): CreditPool {
  return {
    monthlyGrant: toNumber(record.monthly_grant),
    planRemaining: toNumber(record.plan),
    topupRemaining: toNumber(record.topup),
    totalRemaining: toNumber(record.total),
    periodStart: toStringOrNull(record.period_start),
    resetsAt: toStringOrNull(record.resets_at),
    soonestExpiry: toStringOrNull(record.soonest_expiry),
    usage: parseUsageBuckets(record.usage),
  };
}

/** Credits consumed this period across every metered activity in one pool. */
function poolCreditsUsed(usage: UsageBuckets): number {
  return (
    usage.aiChat.creditsUsed +
    usage.documentUpload.creditsUsed +
    usage.urlScan.creditsUsed +
    usage.emailSend.creditsUsed +
    usage.emailVerification.creditsUsed +
    usage.companyName.creditsUsed
  );
}

/**
 * A single credit pool ready to render as its own card: either the shared
 * account pool (Free + legacy agents) or one agent that carries its own paid
 * subscription. Both expose the same spendable figures; a bot pool additionally
 * carries the agent's identity so its balance can be shown and topped up in
 * isolation.
 */
/** An agent's plan ceilings, keyed as the backend `plan.limits` map (-1 = unlimited). */
export type PlanLimits = Readonly<Record<string, number>>;

/** Per-agent usage counts that pair with `PlanLimits` on the Plan-limits meters. */
export interface LimitUsage {
  readonly operators: number;
  readonly documents: number;
  readonly leads: number;
}

export interface PoolCredit {
  /** `null` for the shared account pool; the bot's DB id for a per-agent pool. */
  readonly botId: number | null;
  /** Display name - the agent's name, or a generic label for the account pool. */
  readonly name: string;
  /** The agent's public bot key, when this is a per-agent pool. */
  readonly botKey: string | null;
  /** The plan the agent is on (per-agent pools only). */
  readonly planName: string | null;
  /** Credits granted by the plan at the start of the period. */
  readonly monthlyGrant: number;
  /** Plan-bucket credits still available. */
  readonly planRemaining: number;
  /** Top-up (purchased) credits still available. */
  readonly topupRemaining: number;
  /** Total spendable credits (plan + top-up); the pool stops at 0 here. */
  readonly totalRemaining: number;
  /** Share of this pool's monthly grant already consumed, 0 to 100. */
  readonly planUsedPct: number;
  /** When the allowance period began, ISO 8601. Every usage figure below is scoped to it. */
  readonly periodStart: string | null;
  /** When the plan bucket refills, ISO 8601. */
  readonly resetsAt: string | null;
  /**
   * Earliest `expires_at` across THIS pool's top-up grants, null when none
   * expire.
   *
   * `CreditPool` has always carried this and `poolCredit()` silently dropped
   * it, so per-pool surfaces had no way to tell the truth about expiry and
   * fell back to the slogan "Roll over". Printed unconditionally, directly
   * above a section stating a real expiry date. Whether top-ups expire is a
   * TERM OF SALE; any surface that mentions it needs the evidence.
   */
  readonly soonestExpiry: string | null;
  /** Credits consumed this period from this pool. */
  readonly periodCreditsUsed: number;
  /** This period's metered activity for this pool, per action bucket. */
  readonly activity: UsageBuckets;
  /** This agent's plan ceilings (per-agent pools only; `null` for the account pool). */
  readonly planLimits: PlanLimits | null;
  /** This agent's usage against those ceilings (per-agent pools only). */
  readonly limitUsage: LimitUsage | null;
}

function poolCredit(
  pool: CreditPool,
  identity: {
    botId: number | null;
    name: string;
    botKey: string | null;
    planName: string | null;
    planLimits?: PlanLimits | null;
    limitUsage?: LimitUsage | null;
  },
): PoolCredit {
  const planUsed = Math.max(pool.monthlyGrant - pool.planRemaining, 0);
  return {
    botId: identity.botId,
    name: identity.name,
    botKey: identity.botKey,
    planName: identity.planName,
    monthlyGrant: pool.monthlyGrant,
    planRemaining: pool.planRemaining,
    topupRemaining: pool.topupRemaining,
    totalRemaining: pool.totalRemaining,
    planUsedPct:
      pool.monthlyGrant > 0 ? Math.min(Math.round((planUsed / pool.monthlyGrant) * 100), 100) : 0,
    periodStart: pool.periodStart,
    resetsAt: pool.resetsAt,
    soonestExpiry: pool.soonestExpiry,
    periodCreditsUsed: poolCreditsUsed(pool.usage),
    activity: pool.usage,
    planLimits: identity.planLimits ?? null,
    limitUsage: identity.limitUsage ?? null,
  };
}

/** Coerce the backend `plan.limits` map into a numeric-valued `PlanLimits`. */
function parsePlanLimits(value: unknown): PlanLimits {
  const record = asRecord(value);
  const out: Record<string, number> = {};
  for (const key of Object.keys(record)) out[key] = toNumber(record[key]);
  return out;
}

/** Parse the per-agent `limit_usage` payload (operators / documents / leads). */
function parseLimitUsage(value: unknown): LimitUsage {
  const record = asRecord(value);
  return {
    operators: toNumber(record.operators),
    documents: toNumber(record.documents),
    leads: toNumber(record.leads),
  };
}

/**
 * The workspace-wide credit position + this period's metered consumption,
 * aggregated across the account pool and every per-bot subscription ledger.
 */
export interface CreditBalance {
  /** Credits granted by the plan(s) at the start of the period. */
  readonly monthlyGrant: number;
  /** Plan-bucket credits still available. */
  readonly planRemaining: number;
  /** Top-up (purchased) credits still available. */
  readonly topupRemaining: number;
  /** Total spendable credits (plan + top-up). The bot stops at 0 here. */
  readonly totalRemaining: number;
  /** Share of the monthly grant already consumed, 0 to 100. */
  readonly planUsedPct: number;
  /** True when total remaining has fallen to ≤20% of the monthly grant. */
  readonly lowBalance: boolean;
  /** When the allowance period began, ISO 8601 (earliest across pools). */
  readonly periodStart: string | null;
  /** When the plan bucket refills, ISO 8601 (soonest across pools). */
  readonly resetsAt: string | null;
  /** When the nearest top-up grant expires, ISO 8601 (soonest across pools). */
  readonly soonestExpiry: string | null;
  /**
   * What each metered action costs RIGHT NOW, read from `pricing_config` via the
   * balance payload. Never hard-coded: a super-admin can retune any of these,
   * and a UI quoting last quarter's numbers is telling the customer something
   * untrue about money.
   */
  readonly costs: CreditCosts;
  /** The display currency the balance endpoint resolved for this account. */
  readonly currency: string;
  readonly aiChat: UsageBreakdownEntry;
  readonly documentUpload: UsageBreakdownEntry;
  readonly urlScan: UsageBreakdownEntry;
  readonly emailSend: UsageBreakdownEntry;
  readonly emailVerification: UsageBreakdownEntry;
  readonly companyName: UsageBreakdownEntry;
  /** Credits consumed this period across every metered activity. */
  readonly periodCreditsUsed: number;
  /**
   * Per-agent credit pools - one entry per bot that carries its own paid
   * subscription (isolated balance + scoped top-up). Empty for accounts where
   * every agent draws from the shared account pool, in which case the aggregate
   * position above already tells the whole story.
   */
  readonly botCredits: PoolCredit[];
  /**
   * The shared account pool (Free + legacy agents) as its own card. Non-null
   * only when both per-agent pools exist AND at least one agent still drains the
   * account pool - so the breakdown sums to the aggregate without a redundant
   * "account" card on single-pool accounts.
   */
  readonly accountPool: PoolCredit | null;
}

/**
 * Parse the credit-balance payload into a workspace-wide position.
 *
 * The backend scopes the account-level fields to the account pool only
 * (bot_id = NULL); a bot that carries its own paid subscription keeps its
 * credits and usage in a `bots[]` ledger, so the account fields read 0 for it
 * (subscription_routes.py:1716, 1795). Presenting the account pool alone would
 * under-report - and outright contradict the consumption ledger - for any such
 * account, so we aggregate across the account pool and every per-bot ledger to
 * answer the page's single question: "what is my WORKSPACE consuming?".
 */
export function parseCreditBalance(raw: unknown): CreditBalance {
  const record = asRecord(raw);

  const accountPoolRaw = parsePool(record);
  const pools: CreditPool[] = [accountPoolRaw];
  const botsRaw = Array.isArray(record.bots) ? record.bots : [];
  const botCredits: PoolCredit[] = [];
  for (const botRaw of botsRaw) {
    const botRecord = asRecord(botRaw);
    const botPool = parsePool(botRecord);
    pools.push(botPool);
    botCredits.push(
      poolCredit(botPool, {
        botId: toNumber(botRecord.bot_id) || null,
        name: toStringOrNull(botRecord.bot_name) ?? 'Chatbot',
        botKey: toStringOrNull(botRecord.bot_key),
        planName: toStringOrNull(botRecord.plan_name),
        planLimits: parsePlanLimits(botRecord.limits),
        limitUsage: parseLimitUsage(botRecord.limit_usage),
      }),
    );
  }

  // Count of agents still drawing from the shared account pool (Free / legacy).
  // Only surface the account pool as its own card when it's genuinely shared AND
  // per-agent pools exist to break down - otherwise the aggregate hero already
  // answers the whole question.
  const accountPoolBotCount = toNumber(record.account_pool_bot_count);
  const accountPool: PoolCredit | null =
    botCredits.length > 0 && accountPoolBotCount > 0
      ? poolCredit(accountPoolRaw, {
          botId: null,
          name: 'Free & legacy chatbots',
          botKey: null,
          planName: null,
        })
      : null;

  const empty: UsageBreakdownEntry = { creditsUsed: 0, eventCount: 0 };
  const aggregate = pools.reduce(
    (acc, pool) => ({
      monthlyGrant: acc.monthlyGrant + pool.monthlyGrant,
      planRemaining: acc.planRemaining + pool.planRemaining,
      topupRemaining: acc.topupRemaining + pool.topupRemaining,
      totalRemaining: acc.totalRemaining + pool.totalRemaining,
      periodStart: earliestDate(acc.periodStart, pool.periodStart),
      resetsAt: earliestDate(acc.resetsAt, pool.resetsAt),
      soonestExpiry: earliestDate(acc.soonestExpiry, pool.soonestExpiry),
      aiChat: addBreakdown(acc.aiChat, pool.usage.aiChat),
      documentUpload: addBreakdown(acc.documentUpload, pool.usage.documentUpload),
      urlScan: addBreakdown(acc.urlScan, pool.usage.urlScan),
      emailSend: addBreakdown(acc.emailSend, pool.usage.emailSend),
      emailVerification: addBreakdown(acc.emailVerification, pool.usage.emailVerification),
      companyName: addBreakdown(acc.companyName, pool.usage.companyName),
    }),
    {
      monthlyGrant: 0,
      planRemaining: 0,
      topupRemaining: 0,
      totalRemaining: 0,
      periodStart: null as string | null,
      resetsAt: null as string | null,
      soonestExpiry: null as string | null,
      aiChat: empty,
      documentUpload: empty,
      urlScan: empty,
      emailSend: empty,
      emailVerification: empty,
      companyName: empty,
    },
  );

  const planUsed = Math.max(aggregate.monthlyGrant - aggregate.planRemaining, 0);
  const planUsedPct =
    aggregate.monthlyGrant > 0
      ? Math.min(Math.round((planUsed / aggregate.monthlyGrant) * 100), 100)
      : 0;

  return {
    monthlyGrant: aggregate.monthlyGrant,
    planRemaining: aggregate.planRemaining,
    topupRemaining: aggregate.topupRemaining,
    totalRemaining: aggregate.totalRemaining,
    planUsedPct,
    // Watches the combined bucket so a customer who has burned their plan but
    // still holds top-ups isn't warned needlessly (Billing.jsx:381-386).
    lowBalance: aggregate.monthlyGrant > 0 && aggregate.totalRemaining <= aggregate.monthlyGrant * 0.2,
    periodStart: aggregate.periodStart,
    resetsAt: aggregate.resetsAt,
    soonestExpiry: aggregate.soonestExpiry,
    costs: parseCreditCosts(record.costs),
    currency: (toStringOrNull(record.currency) ?? 'INR').toUpperCase(),
    aiChat: aggregate.aiChat,
    documentUpload: aggregate.documentUpload,
    urlScan: aggregate.urlScan,
    emailSend: aggregate.emailSend,
    emailVerification: aggregate.emailVerification,
    companyName: aggregate.companyName,
    periodCreditsUsed:
      aggregate.aiChat.creditsUsed +
      aggregate.documentUpload.creditsUsed +
      aggregate.urlScan.creditsUsed +
      aggregate.emailSend.creditsUsed +
      aggregate.emailVerification.creditsUsed +
      aggregate.companyName.creditsUsed,
    botCredits,
    accountPool,
  };
}

/**
 * Build a synthetic pool from the account-wide balance - the whole-workspace
 * position (every plan + top-up summed) presented as a single spendable pool.
 * Used as the "All agents" scope and as a last-resort fallback so a scoped
 * surface is never blank.
 */
export function aggregatePool(balance: CreditBalance): PoolCredit {
  return {
    botId: null,
    name: 'Shared credits',
    botKey: null,
    planName: null,
    monthlyGrant: balance.monthlyGrant,
    planRemaining: balance.planRemaining,
    topupRemaining: balance.topupRemaining,
    totalRemaining: balance.totalRemaining,
    planUsedPct: balance.planUsedPct,
    periodStart: balance.periodStart,
    resetsAt: balance.resetsAt,
    soonestExpiry: balance.soonestExpiry,
    periodCreditsUsed: balance.periodCreditsUsed,
    activity: {
      aiChat: balance.aiChat,
      documentUpload: balance.documentUpload,
      urlScan: balance.urlScan,
      emailSend: balance.emailSend,
      emailVerification: balance.emailVerification,
      companyName: balance.companyName,
    },
    planLimits: null,
    limitUsage: null,
  };
}

/**
 * The one honest statement this app can make about top-up expiry.
 *
 * "Top-up credits never expire" is a TERM OF SALE, true only when
 * `pricing_config.topup_expiry_months = 0`, a server-side value no endpoint
 * exposes. The only evidence the client holds is the customer's own ledger:
 * `soonestExpiry` is non-null exactly when a top-up they hold carries an
 * `expires_at` that the daily sweep will act on.
 *
 *   - a dated grant  → state the date; "forever" is false for this customer
 *   - grants, undated → "never expire" is demonstrably true for them
 *   - no grants       → no evidence, so NO CLAIM
 *
 * That last case is deliberate and costs a sentence on the sales page. An
 * unbacked guarantee at the point of sale is the defect this replaces: the
 * app promised lifetime credits while the database said 12 months, and a
 * customer could see a concrete expiry date in the hero and "never expire"
 * 400px below it on the same screen.
 *
 * Lives here rather than in one modal so every surface states the same thing.
 */
export function describeTopupExpiry(balance: CreditBalance): string | null {
  if (balance.soonestExpiry) {
    return `Your top-up credits do expire - the earliest on ${formatDate(balance.soonestExpiry)}.`;
  }
  if (balance.topupRemaining > 0) return 'Top-up credits never expire.';
  return null;
}

/**
 * The single credit pool to headline for a given scope, shared by the Usage and
 * Billing surfaces so they can never disagree. A selected agent (`botId` set)
 * resolves to its own isolated pool, falling back to the shared account pool and
 * then a synthetic aggregate when the agent still draws from the workspace
 * balance. `null` (All agents) resolves to the whole-workspace aggregate.
 */
export function resolveScopedPool(balance: CreditBalance, botId: number | null): PoolCredit {
  if (botId != null) {
    return (
      balance.botCredits.find((pool) => pool.botId === botId) ??
      balance.accountPool ??
      aggregatePool(balance)
    );
  }
  return aggregatePool(balance);
}

// ── Consumption trend ────────────────────────────────────────────────────────

/** One day in the consumption trend series (from GET /credits/daily). */
export interface TrendPoint {
  /** Calendar day, ISO `YYYY-MM-DD` (UTC). */
  readonly date: string;
  /** Credits consumed that day (metered debits only). */
  readonly creditsUsed: number;
}

/**
 * Parse the daily-consumption payload into an ascending, zero-filled series.
 * The backend already zero-fills and orders the window, so this is a thin,
 * defensive mapping that drops any malformed row.
 */
export function parseTrend(raw: unknown): TrendPoint[] {
  const record = asRecord(raw);
  const series = Array.isArray(record.series) ? record.series : [];
  return series
    .map((point): TrendPoint => {
      const row = asRecord(point);
      return { date: toStringOrNull(row.date) ?? '', creditsUsed: toNumber(row.credits_used) };
    })
    .filter((point) => point.date !== '');
}

// ── Consumption ledger ───────────────────────────────────────────────────────

/** A human-friendly semantic for how a ledger row should read. */
export type LedgerTone = 'credit' | 'debit' | 'expiry';

/** One append-only movement in the credit ledger, ready to render. */
export interface LedgerRow {
  /** Stable key for list rendering. */
  readonly id: string;
  /** When the movement was recorded, ISO 8601. */
  readonly createdAt: string | null;
  /** Raw accounting bucket (used for tone). */
  readonly reason: string;
  /** Display label resolved from the reason + note. */
  readonly label: string;
  /** Free-text detail attached to the movement, if any. */
  readonly note: string | null;
  /** Signed credit delta: positive = granted, negative = spent. */
  readonly delta: number;
  /** How the row should read semantically. */
  readonly tone: LedgerTone;
}

const REASON_LABEL: Readonly<Record<string, string>> = {
  plan_grant: 'Plan grant',
  topup: 'Top-up purchase',
  ai_chat: 'AI chat reply',
  document_upload: 'Document upload',
  url_scan: 'Page crawled',
  email_send: 'Customer email',
  manual_adjust: 'Manual adjustment',
  refund: 'Refund',
  expiry: 'Top-up expiry',
};

/**
 * Turn the accounting bucket into something a customer can read.
 * Mirrors the two disambiguations the legacy page makes (Billing.jsx:127-139):
 *   • a `topup` row noted "upgrade credit" is a proration credit, not a sale;
 *   • a negative `plan_grant` is the use-it-or-lose-it reset, not a grant.
 */
function resolveLabel(reason: string, note: string | null, delta: number): string {
  const normalizedNote = (note ?? '').toLowerCase();
  if (reason === 'topup' && normalizedNote.startsWith('upgrade credit')) {
    return 'Plan upgrade credit';
  }
  if (reason === 'plan_grant' && delta < 0) {
    return 'Plan reset';
  }
  return REASON_LABEL[reason] ?? (reason || 'Adjustment');
}

function resolveTone(reason: string, delta: number): LedgerTone {
  if (delta > 0) return 'credit';
  if (reason === 'expiry') return 'expiry';
  return 'debit';
}

function parseLedgerRow(raw: unknown, index: number): LedgerRow {
  const record = asRecord(raw);
  const reason = typeof record.reason === 'string' ? record.reason : '';
  const note = toStringOrNull(record.note);
  const delta = toNumber(record.delta);
  const rawId = record.id;
  const id =
    typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : `row-${index}`;

  return {
    id,
    createdAt: toStringOrNull(record.created_at),
    reason,
    label: resolveLabel(reason, note, delta),
    note,
    delta,
    tone: resolveTone(reason, delta),
  };
}

/**
 * Accepts either a bare array of rows or a `{ history: [...] }` envelope and
 * returns a normalized, render-ready ledger.
 */
export function parseLedger(raw: unknown): LedgerRow[] {
  let rows: unknown[] = [];
  if (Array.isArray(raw)) {
    rows = raw;
  } else {
    const inner = asRecord(raw).history;
    if (Array.isArray(inner)) rows = inner;
  }
  return rows.map(parseLedgerRow);
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatCredits(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/**
 * Dates and times come from the design system's formatters rather than local
 * copies, so an absent value is the console's em dash here as everywhere, and
 * one locale decision covers the whole app.
 */
import { formatDate, formatDateTime, formatTime } from '../../ui/lib/formatters';
export { formatDate, formatDateTime, formatTime };

// ── Periods ──────────────────────────────────────────────────────────────────

/**
 * The window a consumption figure covers, as a phrase.
 *
 * Every number on the Usage page is scoped to the current allowance period, and
 * a figure without its period is not actionable - it is the defect the whole
 * console rebuild opened with. `null` start means the ledger has no `plan_grant`
 * to anchor on (a brand-new account, or one whose grants predate the column),
 * so we say what we can rather than inventing a start date.
 */
export function formatPeriod(start: string | null, resetsAt: string | null): string {
  if (start && resetsAt) return `${formatDate(start)} to ${formatDate(resetsAt)}`;
  if (start) return `Since ${formatDate(start)}`;
  if (resetsAt) return `Until ${formatDate(resetsAt)}`;
  return 'Current period';
}

/** Read one metered bucket off a pool by its `CREDIT_ACTIONS` key. */
export function activityFor(usage: UsageBuckets, bucket: CreditActionBucket): UsageBreakdownEntry {
  return usage[bucket];
}
