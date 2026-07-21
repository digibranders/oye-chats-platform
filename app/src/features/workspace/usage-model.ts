/**
 * Usage model — boundary parsing for the credit balance + consumption ledger.
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
 *   • Credits drain plan bucket first, then top-up — so the "running low"
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

/** The four metered activity buckets the backend returns for each pool. */
interface UsageBuckets {
  readonly aiChat: UsageBreakdownEntry;
  readonly documentUpload: UsageBreakdownEntry;
  readonly urlScan: UsageBreakdownEntry;
  readonly emailSend: UsageBreakdownEntry;
}

function parseUsageBuckets(value: unknown): UsageBuckets {
  const usage = asRecord(value);
  return {
    aiChat: parseBreakdown(usage.ai_chat),
    documentUpload: parseBreakdown(usage.document_upload),
    urlScan: parseBreakdown(usage.url_scan),
    // email_send is a metered, credit-costing activity
    // (subscription_routes.py:1693) — omitting it under-reports spend.
    emailSend: parseBreakdown(usage.email_send),
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
    resetsAt: toStringOrNull(record.resets_at),
    soonestExpiry: toStringOrNull(record.soonest_expiry),
    usage: parseUsageBuckets(record.usage),
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
  /** Share of the monthly grant already consumed, 0–100. */
  readonly planUsedPct: number;
  /** True when total remaining has fallen to ≤20% of the monthly grant. */
  readonly lowBalance: boolean;
  /** When the plan bucket refills, ISO 8601 (soonest across pools). */
  readonly resetsAt: string | null;
  /** When the nearest top-up grant expires, ISO 8601 (soonest across pools). */
  readonly soonestExpiry: string | null;
  readonly aiChat: UsageBreakdownEntry;
  readonly documentUpload: UsageBreakdownEntry;
  readonly urlScan: UsageBreakdownEntry;
  readonly emailSend: UsageBreakdownEntry;
  /** Credits consumed this period across every metered activity. */
  readonly periodCreditsUsed: number;
}

/**
 * Parse the credit-balance payload into a workspace-wide position.
 *
 * The backend scopes the account-level fields to the account pool only
 * (bot_id = NULL); a bot that carries its own paid subscription keeps its
 * credits and usage in a `bots[]` ledger, so the account fields read 0 for it
 * (subscription_routes.py:1716, 1795). Presenting the account pool alone would
 * under-report — and outright contradict the consumption ledger — for any such
 * account, so we aggregate across the account pool and every per-bot ledger to
 * answer the page's single question: "what is my WORKSPACE consuming?".
 */
export function parseCreditBalance(raw: unknown): CreditBalance {
  const record = asRecord(raw);

  const pools: CreditPool[] = [parsePool(record)];
  const bots = Array.isArray(record.bots) ? record.bots : [];
  for (const botRaw of bots) {
    pools.push(parsePool(asRecord(botRaw)));
  }

  const empty: UsageBreakdownEntry = { creditsUsed: 0, eventCount: 0 };
  const aggregate = pools.reduce(
    (acc, pool) => ({
      monthlyGrant: acc.monthlyGrant + pool.monthlyGrant,
      planRemaining: acc.planRemaining + pool.planRemaining,
      topupRemaining: acc.topupRemaining + pool.topupRemaining,
      totalRemaining: acc.totalRemaining + pool.totalRemaining,
      resetsAt: earliestDate(acc.resetsAt, pool.resetsAt),
      soonestExpiry: earliestDate(acc.soonestExpiry, pool.soonestExpiry),
      aiChat: addBreakdown(acc.aiChat, pool.usage.aiChat),
      documentUpload: addBreakdown(acc.documentUpload, pool.usage.documentUpload),
      urlScan: addBreakdown(acc.urlScan, pool.usage.urlScan),
      emailSend: addBreakdown(acc.emailSend, pool.usage.emailSend),
    }),
    {
      monthlyGrant: 0,
      planRemaining: 0,
      topupRemaining: 0,
      totalRemaining: 0,
      resetsAt: null as string | null,
      soonestExpiry: null as string | null,
      aiChat: empty,
      documentUpload: empty,
      urlScan: empty,
      emailSend: empty,
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
    resetsAt: aggregate.resetsAt,
    soonestExpiry: aggregate.soonestExpiry,
    aiChat: aggregate.aiChat,
    documentUpload: aggregate.documentUpload,
    urlScan: aggregate.urlScan,
    emailSend: aggregate.emailSend,
    periodCreditsUsed:
      aggregate.aiChat.creditsUsed +
      aggregate.documentUpload.creditsUsed +
      aggregate.urlScan.creditsUsed +
      aggregate.emailSend.creditsUsed,
  };
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

/** DD Mon YYYY — unambiguous for a primarily-Indian audience. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
