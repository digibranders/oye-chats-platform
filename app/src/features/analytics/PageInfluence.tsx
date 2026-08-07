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
  /** Total visits — distinguishes rows that tie on distinct visitors. */
  visits: number;
  /** Bar width as a percent of the leader's session count (0–100). */
  barPct: number;
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

/** Parent-scoped label: `/blog/post-1` → "Blog / Post 1", used as a
 *  fallback so two distinct pages that pretty-label the same way
 *  (e.g. `/blog/post-1` and `/case-studies/post-1` both → "Post 1")
 *  don't render as two visually identical rows. */
function scopedLabel(path: string): string {
  const clean = path.split(/[?#]/, 1)[0];
  const segments = clean.split('/').filter(Boolean);
  if (segments.length < 2) return prettyLabel(path);
  const parent = prettyLabel('/' + segments[segments.length - 2]);
  return `${parent} / ${prettyLabel(path)}`;
}

/**
 * Compose rows from the topPages.pre payload, sorted desc, top N.
 * Bar width is scaled RELATIVE TO THE TOP ROW (leader = 100%) so the
 * chart reads as a comparative ranking of visitor counts. Ties on
 * ``sessions`` break by ``visits`` (a page a visitor reloaded more
 * often ranks slightly higher), so the ordering is deterministic and
 * matches the two numbers rendered per row.
 *
 * When two rows collapse to the same pretty label (`/blog/post-1` and
 * `/case-studies/post-1` both → "Post 1"), the loser is relabelled
 * with its parent segment so the visible list stays unambiguous —
 * otherwise readers had to hover for the tooltip to spot the distinct
 * paths.
 */
function composeRows(rows: readonly JourneyTopPageRow[]): InfluenceRow[] {
  const filtered = rows.filter((r) => r.path && r.sessions > 0);
  const top = filtered.reduce((max, r) => (r.sessions > max ? r.sessions : max), 0);
  const denom = top > 0 ? top : 1;
  const ranked = filtered
    .map((r) => ({
      path: r.path,
      label: prettyLabel(r.path),
      sessions: r.sessions,
      visits: r.visits,
      barPct: Math.round((r.sessions / denom) * 100),
    }))
    .sort((a, b) => b.sessions - a.sessions || b.visits - a.visits)
    .slice(0, TOP_N);

  // Disambiguate collisions within the visible slice only.
  const labelCounts = new Map<string, number>();
  ranked.forEach((r) => labelCounts.set(r.label, (labelCounts.get(r.label) ?? 0) + 1));
  return ranked.map((r) =>
    (labelCounts.get(r.label) ?? 0) > 1 ? { ...r, label: scopedLabel(r.path) } : r,
  );
}

// Categorical palette — one hue per row, cycled by index. Same set the
// flow diagram at the top of the page uses (blue / purple / green /
// orange / red / yellow), so the two panels read as one system. Not a
// gradient, not rank-graded, not neon.
const BAR_COLORS = [
  '#60a5fa', // blue
  '#c084fc', // purple
  '#34d399', // green
  '#fb923c', // orange
  '#f87171', // red
  '#fbbf24', // yellow
] as const;
const TRACK_COLOR = 'rgba(148, 163, 184, 0.16)';

// ── UI ─────────────────────────────────────────────────────────────────────

export interface PageInfluenceProps {
  botId: number | null;
}

export function PageInfluence({ botId }: PageInfluenceProps): ReactElement {
  const { status, data, error, reload } = useJourneyAnalytics(botId);

  const rows = useMemo(() => (data ? composeRows(data.topPages.pre.rows) : []), [data]);

  // Map each distinct visitor count to a palette hue (highest count →
  // first color, next distinct count → next color, etc.). Rows that tie
  // on visitors share the same bar color so the eye can spot ties at a
  // glance without reading the numbers.
  const colorByVisitors = useMemo(() => {
    const distinctDesc = Array.from(new Set(rows.map((r) => r.sessions))).sort(
      (a, b) => b - a,
    );
    const map = new Map<number, string>();
    distinctDesc.forEach((count, i) => {
      map.set(count, BAR_COLORS[i % BAR_COLORS.length]);
    });
    return map;
  }, [rows]);

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
          const visitorLabel = row.sessions === 1 ? 'visitor' : 'visitors';
          const visitLabel = row.visits === 1 ? 'visit' : 'visits';
          const barColor = colorByVisitors.get(row.sessions) ?? BAR_COLORS[0];
          return (
            <li
              key={row.path}
              className="grid grid-cols-[minmax(120px,180px)_1fr_auto] items-center gap-3"
            >
              <div className="min-w-0" title={row.path}>
                <p className="truncate text-[13px] text-[var(--ds-text)]">{row.label}</p>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full"
                style={{ backgroundColor: TRACK_COLOR }}
                role="progressbar"
                aria-valuenow={row.sessions}
                aria-valuemin={0}
                aria-label={`${row.label}: ${row.sessions.toLocaleString()} ${visitorLabel}, ${row.visits.toLocaleString()} ${visitLabel}`}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${row.barPct}%`, backgroundColor: barColor }}
                />
              </div>
              <div className="min-w-[92px] text-right">
                <p className="tabular-nums text-[13px] font-medium text-[var(--ds-text)]">
                  {row.sessions.toLocaleString()} {visitorLabel}
                </p>
                <p className="tabular-nums text-[11px] text-[var(--ds-text-muted)]">
                  {row.visits.toLocaleString()} {visitLabel}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
