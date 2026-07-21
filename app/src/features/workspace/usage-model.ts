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

// ── Credit balance ───────────────────────────────────────────────────────────

/** The account-level credit position + this period's metered consumption. */
export interface CreditBalance {
  /** Credits granted by the plan at the start of the period. */
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
  /** When the plan bucket refills, ISO 8601. */
  readonly resetsAt: string | null;
  /** When the nearest top-up grant expires, ISO 8601. */
  readonly soonestExpiry: string | null;
  readonly aiChat: UsageBreakdownEntry;
  readonly documentUpload: UsageBreakdownEntry;
  readonly urlScan: UsageBreakdownEntry;
  /** Credits consumed this period across every metered activity. */
  readonly periodCreditsUsed: number;
}

export function parseCreditBalance(raw: unknown): CreditBalance {
  const record = asRecord(raw);
  const usage = asRecord(record.usage);

  const monthlyGrant = toNumber(record.monthly_grant);
  const planRemaining = toNumber(record.plan);
  const topupRemaining = toNumber(record.topup);
  const totalRemaining = toNumber(record.total);

  const aiChat = parseBreakdown(usage.ai_chat);
  const documentUpload = parseBreakdown(usage.document_upload);
  const urlScan = parseBreakdown(usage.url_scan);

  const planUsed = Math.max(monthlyGrant - planRemaining, 0);
  const planUsedPct = monthlyGrant > 0 ? Math.min(Math.round((planUsed / monthlyGrant) * 100), 100) : 0;

  return {
    monthlyGrant,
    planRemaining,
    topupRemaining,
    totalRemaining,
    planUsedPct,
    // Watches the combined bucket so a customer who has burned their plan but
    // still holds top-ups isn't warned needlessly (Billing.jsx:381-386).
    lowBalance: monthlyGrant > 0 && totalRemaining <= monthlyGrant * 0.2,
    resetsAt: toStringOrNull(record.resets_at),
    soonestExpiry: toStringOrNull(record.soonest_expiry),
    aiChat,
    documentUpload,
    urlScan,
    periodCreditsUsed: aiChat.creditsUsed + documentUpload.creditsUsed + urlScan.creditsUsed,
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
