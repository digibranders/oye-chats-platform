/**
 * LeadInsights - source attribution + behavioural signals for a single lead.
 *
 * Restores two blocks the rebuild dropped from `LeadDetailDrawer` (the drawer
 * carried a `TODO(leads)` for source attribution and never rendered behavioural
 * signals). Both read data the backend already produces:
 *   • Source attribution - `detail.source` (UTM params, referrer, landing page,
 *     pre-chat page journey). Only present on plans with the feature, so its
 *     presence is the signal; absent → the section is omitted.
 *   • Behavioural signals - `detail.behavioral.visit_count` (return visits) plus
 *     a plain-language engagement tier derived from `detail.behavioral_score`
 *     (0 to 20, scored by `behavioral_service.py`). The raw score is intentionally
 *     NOT shown as a number: it already feeds the headline 0 to 100 qualification
 *     score, so a second numeric scale in the same drawer competes with that
 *     verdict. We surface it qualitatively (Low/Medium/High) instead.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Activity, Compass, Maximize2, Receipt } from 'lucide-react';
import { Modal, StatusBadge, cn } from '../../design-system';
import { type LeadDetail } from './useLeadDetail';

const CURRENCY_SYMBOL: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  AED: 'د.إ',
};

function formatMoney(currency: string, value: number): string {
  const symbol = CURRENCY_SYMBOL[currency] ?? currency;
  const rounded = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  return `${symbol}${rounded.toLocaleString()}`;
}

interface QuotationLineItem {
  service_id: string;
  name: string;
  unit_label: string;
  price_per_unit: number;
  quantity: number;
  subtotal: number;
  answers: { question_id: string; question_text: string; answer: string }[];
}

interface QuotationSummary {
  status: 'idle' | 'selecting' | 'answering' | 'quoting' | 'complete' | 'skipped';
  currency: string;
  line_items: QuotationLineItem[];
  total: number;
  activated_at: string | null;
  completed_at: string | null;
}

const QUOTATION_STATUS_TONE: Record<QuotationSummary['status'], 'success' | 'warning' | 'neutral' | 'info'> = {
  complete: 'success',
  quoting: 'info',
  selecting: 'info',
  answering: 'info',
  skipped: 'warning',
  idle: 'neutral',
};

const QUOTATION_STATUS_LABEL: Record<QuotationSummary['status'], string> = {
  complete: 'Quote accepted',
  quoting: 'Quote pending',
  selecting: 'Selecting services',
  answering: 'Answering questions',
  skipped: 'Skipped by visitor',
  idle: 'Not started',
};

/**
 * QuotationSummarySection - itemised view of what the visitor built through
 * the quotation flow. Renders nothing when the session never activated it.
 * Line items include per-service question answers so operators land on the
 * call with the visitor's stated scope in front of them.
 */
function QuotationSummarySection({ detail }: { detail: LeadDetail }): ReactElement | null {
  const quotation = (detail as unknown as { quotation?: QuotationSummary }).quotation ?? null;
  const hasQuote = Boolean(quotation && quotation.line_items && quotation.line_items.length > 0);
  const explicitlyEnded = quotation && (quotation.status === 'skipped' || quotation.status === 'complete');
  if (!quotation || (!hasQuote && !explicitlyEnded)) return null;

  const tone = QUOTATION_STATUS_TONE[quotation.status] ?? 'neutral';
  const label = QUOTATION_STATUS_LABEL[quotation.status] ?? quotation.status;

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-2">
        <h4 className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text)]">
          <Receipt size={14} aria-hidden="true" className="text-[var(--ds-accent)]" />
          Quotation
        </h4>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </header>

      {hasQuote ? (
        <>
          <ul className="divide-y divide-[var(--ds-border)] rounded-md border border-[var(--ds-border)]">
            {quotation.line_items.map((line) => (
              <li key={line.service_id} className="space-y-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">{line.name}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--ds-text-subtle)]">
                      {line.quantity} × {formatMoney(quotation.currency, line.price_per_unit)} / {line.unit_label}
                    </p>
                  </div>
                  <p className="shrink-0 text-[13px] font-semibold text-[var(--ds-text)]">
                    {formatMoney(quotation.currency, line.subtotal)}
                  </p>
                </div>
                {line.answers.length > 0 && (
                  <dl className="space-y-1 rounded bg-[var(--ds-bg-sunken)] p-2">
                    {line.answers.map((a) => (
                      <div key={a.question_id} className="flex gap-2 text-[11px]">
                        <dt className="min-w-0 shrink-0 text-[var(--ds-text-subtle)]">{a.question_text}</dt>
                        <dd className="min-w-0 flex-1 truncate text-[var(--ds-text)]">{a.answer || '—'}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between rounded-md bg-[var(--ds-bg-sunken)] px-3 py-2">
            <span className="text-[11px] uppercase tracking-wider text-[var(--ds-text-subtle)]">
              Estimated total
            </span>
            <span className="text-[15px] font-semibold text-[var(--ds-text)]">
              {formatMoney(quotation.currency, quotation.total)}
            </span>
          </div>
        </>
      ) : (
        <p className="rounded-md border border-dashed border-[var(--ds-border)] p-3 text-[12px] text-[var(--ds-text-subtle)]">
          The visitor {quotation.status === 'skipped' ? 'skipped the quotation flow' : 'started but did not complete a quote'}.
        </p>
      )}
    </section>
  );
}

// ── Safe readers over the loosely-typed `source` / `behavioral` JSON ─────────

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Format a dwell time in seconds compactly ("45s", "2m 15s", "1h 5m"). */
function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 24 * 60 * 60) return null;
  if (seconds < 1) return '< 1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds - m * 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds - h * 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

interface JourneyRow {
  path: string;
  ts: string | null;
  durationLabel: string | null;
  isLast: boolean;
}

/** Derive each page's dwell time from the delta to the next entry's timestamp. */
function buildJourneyRows(journey: unknown[]): JourneyRow[] {
  return journey.map((raw, idx) => {
    const entry = asRecord(raw);
    const next = asRecord(journey[idx + 1]);
    let durationLabel: string | null = null;
    const start = asString(entry.ts);
    const end = asString(next.ts);
    if (start && end) {
      const s = Date.parse(start);
      const e = Date.parse(end);
      if (Number.isFinite(s) && Number.isFinite(e)) durationLabel = formatDuration((e - s) / 1000);
    }
    return {
      path: asString(entry.path) ?? '',
      ts: asString(entry.ts),
      durationLabel,
      isLast: idx === journey.length - 1,
    };
  });
}

interface JourneyGroup {
  key: string;
  label: string;
  items: Array<{ row: JourneyRow; index: number }>;
}

/** A friendly day bucket for a journey timestamp ("Today" / "Yesterday" / date). */
function dayBucket(ts: string | null): { key: string; label: string } {
  if (!ts) return { key: 'unknown', label: 'Unknown date' };
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return { key: 'unknown', label: 'Unknown date' };
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const label = sameDay(d, today)
    ? 'Today'
    : sameDay(d, yesterday)
      ? 'Yesterday'
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return { key, label };
}

/** Bucket chronological journey rows into consecutive same-day groups. */
function groupJourneyByDay(rows: JourneyRow[]): JourneyGroup[] {
  return rows.reduce<JourneyGroup[]>((acc, row, index) => {
    const { key, label } = dayBucket(row.ts);
    const last = acc[acc.length - 1];
    if (last && last.key === key) {
      last.items.push({ row, index });
    } else {
      acc.push({ key, label, items: [{ row, index }] });
    }
    return acc;
  }, []);
}

/**
 * JourneyList - the visitor's pre-chat page journey, bucketed by day and
 * vertically scrollable. Shared between the inline drawer card and the maximised
 * modal; `maxHeightClass` sets the scroll area's height in each, and
 * `autoScrollToEnd` jumps to the most recent pages (where the chat opened) on
 * mount so the compact inline view still leads with the payoff.
 */
function JourneyList({
  rows,
  maxHeightClass,
  autoScrollToEnd = false,
}: {
  rows: JourneyRow[];
  maxHeightClass: string;
  autoScrollToEnd?: boolean;
}): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScrollToEnd && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [autoScrollToEnd, rows.length]);

  const groups = groupJourneyByDay(rows);

  return (
    <div ref={scrollRef} className={cn('overflow-y-auto pr-1', maxHeightClass)}>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={`${group.key}-${group.items[0]?.index ?? 0}`}>
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="text-[11px] font-semibold text-[var(--ds-text)]">{group.label}</span>
              <span className="text-[10.5px] text-[var(--ds-text-subtle)]">
                {group.items.length} {group.items.length === 1 ? 'page' : 'pages'}
              </span>
            </div>
            <ol className="space-y-1.5">
              {group.items.map(({ row, index }) => (
                <li
                  key={`${row.path}-${row.ts ?? index}`}
                  className="flex items-start gap-2 text-[12px]"
                >
                  <span className="w-9 shrink-0 tabular-nums text-[var(--ds-text-muted)]">
                    {index + 1}.
                  </span>
                  <span className="flex-1 break-all text-[var(--ds-text)]">{row.path || '-'}</span>
                  {row.isLast ? (
                    <span className="shrink-0 text-[11px] italic text-[var(--ds-accent-text)]">
                      opened chat here
                    </span>
                  ) : row.durationLabel ? (
                    <span className="shrink-0 tabular-nums text-[11px] text-[var(--ds-text-muted)]">
                      {row.durationLabel}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────

function SectionTitle({ icon: Icon, children }: { icon: typeof Compass; children: string }): ReactElement {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-muted)]">
      <Icon size={13} aria-hidden="true" />
      {children}
    </h3>
  );
}

function AttrRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <span className="w-20 shrink-0 text-[var(--ds-text-muted)]">{label}</span>
      <span className="break-all text-[var(--ds-text)]">{value}</span>
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function SourceAttribution({ detail }: { detail: LeadDetail }): ReactElement | null {
  const [journeyOpen, setJourneyOpen] = useState(false);
  const source = asRecord(detail.source);
  // `source` is only attached on eligible plans - absent means "not available".
  if (Object.keys(source).length === 0) return null;

  const utm = asRecord(source.utm_params);
  const utmSource = asString(utm.utm_source);
  const utmCampaign = asString(utm.utm_campaign);
  const utmMedium = asString(utm.utm_medium);
  const adDetail = asString(utm.utm_content) ?? asString(utm.utm_term);
  const referrer = asString(source.referrer);
  const landing = asString(source.landing_page);
  const journeyRaw = Array.isArray(source.journey) ? source.journey : [];

  const hasAttribution = Boolean(
    utmSource || utmMedium || utmCampaign || referrer || landing || journeyRaw.length > 0,
  );

  if (!hasAttribution) {
    return (
      <section className="space-y-3">
        <SectionTitle icon={Compass}>Source</SectionTitle>
        <p className="rounded-xl border border-[var(--ds-border)] p-4 text-[12px] text-[var(--ds-text-muted)]">
          Direct / Organic - no UTM tags or referrer were captured for this visitor.
        </p>
      </section>
    );
  }

  const rows = buildJourneyRows(journeyRaw);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle icon={Compass}>Source</SectionTitle>
        {utmSource && (
          <StatusBadge tone="info" className="capitalize">
            {utmSource}
          </StatusBadge>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-[var(--ds-border)] p-4">
        {utmCampaign && <AttrRow label="Campaign" value={utmCampaign} />}
        {utmMedium && <AttrRow label="Medium" value={utmMedium} />}
        {adDetail && <AttrRow label="Ad detail" value={adDetail} />}
        {referrer && <AttrRow label="Referrer" value={truncate(referrer)} />}
        {landing && <AttrRow label="Landed on" value={truncate(landing)} />}
      </div>

      {rows.length > 0 && (
        <div className="rounded-xl border border-[var(--ds-border)] p-4">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-muted)]">
              Journey before chat · {rows.length} {rows.length === 1 ? 'page' : 'pages'}
            </p>
            <button
              type="button"
              onClick={() => setJourneyOpen(true)}
              aria-label="Maximise journey"
              title="Maximise journey"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <Maximize2 size={14} aria-hidden="true" />
            </button>
          </div>
          <JourneyList rows={rows} maxHeightClass="max-h-64" autoScrollToEnd />
        </div>
      )}

      {journeyOpen && (
        <Modal
          open
          onClose={() => setJourneyOpen(false)}
          title="Journey before chat"
          description={`${rows.length} ${rows.length === 1 ? 'page' : 'pages'} visited before this visitor opened the chat`}
          size="lg"
        >
          <JourneyList rows={rows} maxHeightClass="max-h-[65vh]" />
        </Modal>
      )}
    </section>
  );
}

/** Map the raw 0 to 20 engagement score to a plain-language tier + badge tone. */
function engagementTier(score: number): { label: string; tone: 'success' | 'info' | 'neutral' } {
  if (score >= 15) return { label: 'High engagement', tone: 'success' };
  if (score >= 8) return { label: 'Medium engagement', tone: 'info' };
  return { label: 'Low engagement', tone: 'neutral' };
}

function BehavioralSignals({ detail }: { detail: LeadDetail }): ReactElement | null {
  const score = detail.behavioral_score ?? 0;
  const behavioral = asRecord(detail.behavioral);
  const visitCount = Number(behavioral.visit_count) || 0;

  if (score <= 0 && visitCount <= 1) return null;

  // Only qualify engagement when there's actually a score; a return visitor
  // with no engagement data still gets their visit count shown.
  const tier = score > 0 ? engagementTier(score) : null;

  return (
    <section className="space-y-3">
      <SectionTitle icon={Activity}>Behavioural signals</SectionTitle>
      <div className="space-y-2.5 rounded-xl border border-[var(--ds-border)] p-4">
        {tier && (
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-[var(--ds-text)]">Engagement</span>
            <StatusBadge tone={tier.tone}>{tier.label}</StatusBadge>
          </div>
        )}
        {visitCount > 1 && (
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-[var(--ds-text)]">Return visitor</span>
            <span className="text-[var(--ds-text)]">{visitCount} visits</span>
          </div>
        )}
      </div>
    </section>
  );
}

/** Renders whichever insight sections have data; nothing if neither does. */
export function LeadInsights({ detail }: { detail: LeadDetail }): ReactElement {
  return (
    <>
      <QuotationSummarySection detail={detail} />
      <SourceAttribution detail={detail} />
      <BehavioralSignals detail={detail} />
    </>
  );
}
