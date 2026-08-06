import { type ReactElement, useMemo } from 'react';
import { BarChart3, Compass, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import { Button, EmptyState, LockedFeatureCard, Skeleton } from '../../design-system';
import { useJourneyAnalytics } from './useJourneyAnalytics';
import type { JourneyTopPageRow } from '../../services/api';

/**
 * PageInfluence — ranked list of the actual pages visitors were on
 * before opening the chatbot, ordered by their share of chatbot
 * openers. Each row shows a horizontal bar scaled to that share so
 * the eye can compare influence at a glance.
 *
 * Data comes from ``useJourneyAnalytics`` — specifically the
 * ``pre``-phase top pages (URLs the visitor saw BEFORE opening
 * chat) plus ``summary.sessions_with_journey`` as the denominator.
 * No bucketing: the raw ``path`` from the API is what renders, so
 * the list is fully dynamic per bot.
 */

// Cap the visible list. The API caller already limits to 20 rows;
// showing the top slice keeps the panel visually manageable.
const TOP_N = 6;

/** Row shape rendered by the panel. */
interface InfluenceRow {
  path: string;
  label: string;
  sessions: number;
  pct: number;
}

/**
 * Turn a raw path into a friendlier display label. `/` → "Home",
 * everything else → title-cased last non-empty segment (query/hash
 * stripped). The full path stays available as the row's subtitle
 * so nothing is hidden from the reader.
 */
function prettyLabel(path: string): string {
  const clean = path.split(/[?#]/, 1)[0];
  if (!clean || clean === '/' || clean.toLowerCase() === '/home') return 'Home';
  const segments = clean.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? clean;
  const decoded = safeDecode(last);
  return decoded
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Compose rows from the topPages.pre + summary payload, sorted desc, top N. */
function composeRows(
  rows: readonly JourneyTopPageRow[],
  sessionsWithJourney: number,
): InfluenceRow[] {
  const denom = sessionsWithJourney > 0 ? sessionsWithJourney : 1;
  return rows
    .filter((r) => r.path && r.sessions > 0)
    .map((r) => {
      const raw = (r.sessions / denom) * 100;
      // Clamp: a visitor can touch multiple pages in one session, so raw
      // share can theoretically exceed 100 for a heavily-trafficked page.
      const pct = Math.max(0, Math.min(100, Math.round(raw)));
      return { path: r.path, label: prettyLabel(r.path), sessions: r.sessions, pct };
    })
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, TOP_N);
}

/**
 * Bar tone graded by rank so the strongest sources read as confident
 * blue and the weaker ones fade toward slate. Mirrors the visual
 * weighting a reader expects from a ranked list.
 */
function toneFor(pct: number): { bar: string; track: string } {
  if (pct >= 70) return { bar: '#3b82f6', track: 'rgba(59, 130, 246, 0.14)' };
  if (pct >= 50) return { bar: '#60a5fa', track: 'rgba(96, 165, 250, 0.14)' };
  if (pct >= 35) return { bar: '#93c5fd', track: 'rgba(147, 197, 253, 0.14)' };
  return { bar: '#64748b', track: 'rgba(100, 116, 139, 0.16)' };
}

// ── UI ─────────────────────────────────────────────────────────────────────

export interface PageInfluenceProps {
  botId: number | null;
}

export function PageInfluence({ botId }: PageInfluenceProps): ReactElement {
  const { status, data, error, reload } = useJourneyAnalytics(botId);

  const rows = useMemo(
    () =>
      data ? composeRows(data.topPages.pre.rows, data.summary.sessions_with_journey) : [],
    [data],
  );

  if (botId == null) {
    return (
      <EmptyState
        icon={Compass}
        title="Pick an agent to see which pages drive chats"
        description="Page Influence is scoped per agent. Use the agent switcher above to focus this view."
      />
    );
  }
  if (status === 'gated') {
    return <LockedFeatureCard intent="view_journeys" icon={Sparkles} />;
  }
  if (status === 'loading' || status === 'idle') {
    return <Skeleton className="h-[340px]" />;
  }
  if (status === 'error' || !data) {
    return (
      <EmptyState
        icon={TriangleAlert}
        title="We couldn’t load Page Influence"
        description={error ?? 'Something went wrong.'}
        action={
          <Button variant="primary" onClick={reload}>
            <RefreshCw size={16} aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No page influence data yet"
        description="Once visitors browse your site and open the chatbot, the pages that led them here will show up."
      />
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-6">
      <div className="mb-5">
        <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">
          Page Influence{' '}
          <span className="text-[13px] font-normal text-[var(--ds-text-muted)]">
            (Leads to Chatbot)
          </span>
        </h3>
      </div>

      <ul className="flex flex-col gap-3.5">
        {rows.map((row) => {
          const tone = toneFor(row.pct);
          return (
            <li
              key={row.path}
              className="grid grid-cols-[minmax(120px,180px)_1fr_44px] items-center gap-3"
            >
              <div className="min-w-0" title={row.path}>
                <p className="truncate text-[13px] text-[var(--ds-text)]">{row.label}</p>
                <p className="truncate text-[11px] text-[var(--ds-text-muted)]">{row.path}</p>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full"
                style={{ backgroundColor: tone.track }}
                role="progressbar"
                aria-valuenow={row.pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${row.label} share of chatbot openers`}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${row.pct}%`, backgroundColor: tone.bar }}
                />
              </div>
              <span className="tabular-nums text-right text-[13px] font-medium text-[var(--ds-text)]">
                {row.pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
