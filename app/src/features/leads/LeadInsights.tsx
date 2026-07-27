/**
 * LeadInsights — source attribution + behavioural signals for a single lead.
 *
 * Restores two blocks the rebuild dropped from `LeadDetailDrawer` (the drawer
 * carried a `TODO(leads)` for source attribution and never rendered behavioural
 * signals). Both read data the backend already produces:
 *   • Source attribution — `detail.source` (UTM params, referrer, landing page,
 *     pre-chat page journey). Only present on plans with the feature, so its
 *     presence is the signal; absent → the section is omitted.
 *   • Behavioural signals — `detail.behavioral_score` (0–20 engagement, scored
 *     by `behavioral_service.py`) + `detail.behavioral.visit_count` (return
 *     visits). Always available.
 */
import { type ReactElement } from 'react';
import { Activity, Compass } from 'lucide-react';
import { StatusBadge } from '../../design-system';
import { type LeadDetail } from './useLeadDetail';

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

// ── Small presentational helpers ─────────────────────────────────────────────

function SectionTitle({ icon: Icon, children }: { icon: typeof Compass; children: string }): ReactElement {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
      <Icon size={13} aria-hidden="true" />
      {children}
    </h3>
  );
}

function AttrRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <span className="w-20 shrink-0 text-[var(--ds-text-subtle)]">{label}</span>
      <span className="break-all text-[var(--ds-text-muted)]">{value}</span>
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function SourceAttribution({ detail }: { detail: LeadDetail }): ReactElement | null {
  const source = asRecord(detail.source);
  // `source` is only attached on eligible plans — absent means "not available".
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
        <p className="rounded-xl border border-[var(--ds-border)] p-4 text-[12px] text-[var(--ds-text-subtle)]">
          Direct / Organic — no UTM tags or referrer were captured for this visitor.
        </p>
      </section>
    );
  }

  const rows = buildJourneyRows(journeyRaw);
  const visible = rows.slice(-8);
  const offset = Math.max(0, rows.length - 8);

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
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
            Journey before chat · {rows.length} {rows.length === 1 ? 'page' : 'pages'}
          </p>
          <ol className="space-y-1.5">
            {visible.map((row, idx) => (
              <li key={`${row.path}-${row.ts ?? idx}`} className="flex items-start gap-2 text-[12px]">
                <span className="shrink-0 tabular-nums text-[var(--ds-text-subtle)]">{idx + 1 + offset}.</span>
                <span className="flex-1 break-all text-[var(--ds-text-muted)]">{row.path || '—'}</span>
                {row.isLast ? (
                  <span className="shrink-0 text-[11px] italic text-[var(--ds-accent-text)]">
                    opened chat here
                  </span>
                ) : row.durationLabel ? (
                  <span className="shrink-0 tabular-nums text-[11px] text-[var(--ds-text-subtle)]">
                    {row.durationLabel}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {rows.length > 8 && (
            <p className="mt-2 text-[11px] text-[var(--ds-text-subtle)]">
              Showing the last 8 of {rows.length} pages.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function BehavioralSignals({ detail }: { detail: LeadDetail }): ReactElement | null {
  const score = detail.behavioral_score ?? 0;
  const behavioral = asRecord(detail.behavioral);
  const visitCount = Number(behavioral.visit_count) || 0;

  if (score <= 0 && visitCount <= 1) return null;

  const pct = Math.min((score / 20) * 100, 100);
  const barColor =
    score >= 15 ? 'var(--ds-success)' : score >= 8 ? 'var(--ds-info)' : 'var(--ds-warning)';

  return (
    <section className="space-y-3">
      <SectionTitle icon={Activity}>Behavioural signals</SectionTitle>
      <div className="space-y-2 rounded-xl border border-[var(--ds-border)] p-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-[var(--ds-text-muted)]">Engagement score</span>
          <span className="text-[12px] font-bold text-[var(--ds-text)]">{score}/20</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: barColor }} />
        </div>
        {visitCount > 1 && (
          <div className="flex items-center gap-2 pt-1 text-[12px]">
            <span className="text-[var(--ds-text-subtle)]">Return visitor</span>
            <span className="text-[var(--ds-text-muted)]">{visitCount} visits</span>
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
      <SourceAttribution detail={detail} />
      <BehavioralSignals detail={detail} />
    </>
  );
}
