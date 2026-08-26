import { type ReactElement, useMemo, useRef, useState } from 'react';
import { t as translateNow } from '../../i18n/i18n';
import { formatNumber } from '../../i18n/formatters';
import { BarChart3, Compass, Info, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import { Button, EmptyState, LockedFeatureCard, Skeleton } from '../../design-system';
import { useJourneyAnalytics } from './useJourneyAnalytics';
import type { JourneyTopPageRow } from '../../services/api';
import { useTranslation } from '../../i18n/useTranslation';
import { Trans } from '../../i18n/Trans';

/**
 * PageInfluence. Ranked list of the actual pages visitors were on
 * before opening the chatbot, ordered by their share of chatbot
 * openers. Each row shows a horizontal bar scaled to that share so
 * the eye can compare influence at a glance.
 *
 * Data comes from ``useJourneyAnalytics``. Specifically the
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
  /** Total visits. Distinguishes rows that tie on distinct visitors. */
  visits: number;
  /** Bar width as a percent of the leader's session count (0 to 100). */
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
  if (!clean || clean === '/' || clean.toLowerCase() === '/home') return translateNow('analytics.home') || 'Home';
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
 * with its parent segment so the visible list stays unambiguous.
 * Otherwise readers had to hover for the tooltip to spot the distinct
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

// Categorical palette, one hue per row, cycled by index. Same set the
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
  const { t } = useTranslation();
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
        title={t('analytics.pickAChatbotForPages') || 'Pick a chatbot to see which pages drive chats'}
        description={t('analytics.pageInfluenceIsScopedPer') || 'Page Influence is scoped per chatbot. Use the chatbot switcher above to focus this view.'}
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
        title={t('analytics.weCouldntLoadPageInfluence') || 'We couldn’t load Page Influence'}
        description={error ?? (t('analytics.somethingWentWrong') || 'Something went wrong.')}
        action={
          <Button variant="primary" onClick={reload}>
            <RefreshCw size={16} aria-hidden="true" />
            {t('analytics.tryAgain') || 'Try again'}
          </Button>
        }
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title={t('analytics.noPageInfluenceDataYet') || 'No page influence data yet'}
        description={t('analytics.onceVisitorsBrowseYourSite') || 'Once visitors browse your site and open the chatbot, the pages that led them here will show up.'}
      />
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-6">
      <div className="relative mb-5 flex items-center gap-1.5">
        <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">
          {t('analytics.pageInfluence') || 'Page Influence'}{' '}
          <span className="text-[13px] font-normal text-[var(--ds-text-muted)]">
            {t('analytics.leadsToChatbot') || '(Leads to Chatbot)'}
          </span>
        </h3>
        <PageInfluenceHelp />
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
                aria-label={`${row.label}: ${formatNumber(row.sessions)} ${visitorLabel}, ${formatNumber(row.visits)} ${visitLabel}`}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${row.barPct}%`, backgroundColor: barColor }}
                />
              </div>
              <div className="min-w-[92px] text-right">
                <p className="tabular-nums text-[13px] font-medium text-[var(--ds-text)]">
                  {formatNumber(row.sessions)} {visitorLabel}
                </p>
                <p className="tabular-nums text-[11px] text-[var(--ds-text-muted)]">
                  {formatNumber(row.visits)} {visitLabel}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * PageInfluenceHelp, a small "i" icon beside the panel title that
 * reveals a plain-language explanation ON HOVER (and on keyboard focus,
 * so it stays accessible). Written for a non-technical bot owner: no
 * analytics jargon, no talk of "sessions" or "denominators".
 *
 * The tooltip is anchored to the LEFT edge of the (relatively
 * positioned) header rather than to the icon, so its fixed 18rem width
 * always stays inside the card, the card clips overflow, and at the
 * `lg` breakpoint this panel is only half-width. The panel content is
 * non-interactive text, so opening on the icon's hover/focus (and not
 * requiring the pointer to travel onto the panel) is enough.
 *
 * Input handling covers all three modes:
 *  · Mouse. Hover in/out via mouseenter/mouseleave.
 *  · Keyboard. Focus opens, blur/Escape closes.
 *  · Touch, no hover exists, so a tap toggles via onClick. A tap also
 *    fires `focus` BEFORE `click`; without guarding, focus would open
 *    and the click would immediately toggle it back shut. `pointerRef`
 *    records that the interaction came from a pointer so the focus
 *    handler stands down and lets the click own the toggle. Keyboard
 *    focus (no preceding pointerdown) still opens normally.
 */
function PageInfluenceHelp(): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pointerRef = useRef(false);
  return (
    <>
      <button
        type="button"
        aria-label={t('analytics.whatDoesPageInfluenceMean') || 'What does Page Influence mean?'}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onPointerDown={() => {
          pointerRef.current = true;
        }}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => {
          if (!pointerRef.current) setOpen(true);
        }}
        onBlur={() => {
          pointerRef.current = false;
          setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-sunken)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-2 w-[18rem] rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-4 text-[13px] leading-relaxed text-[var(--ds-text-muted)] shadow-[var(--ds-shadow-lg)]"
        >
          <p className="mb-2 text-[13px] font-semibold text-[var(--ds-text)]">
            {t('analytics.whatIsPageInfluence') || 'What is Page Influence?'}
          </p>
          <p className="mb-2">
            {t('analytics.pageInfluenceIntro') ||
              'These are the pages people were reading right before they opened your chatbot. The higher a page sits, the more visitors it sent into a chat.'}
          </p>
          <p className="mb-2">
            {t('analytics.pageInfluenceUse') ||
              'Use it to spot which pages spark the most conversations, then make sure your best answers and offers live on those pages.'}
          </p>
          <p>
            <Trans
              k="analytics.visitorsVsVisits"
              fallback="{visitors} is how many people. {visits} is the total page views, since one person can reload or come back more than once."
              values={{
                visitors: (
                  <span className="font-medium text-[var(--ds-text)]">
                    {t('analytics.visitors') || 'Visitors'}
                  </span>
                ),
                visits: (
                  <span className="font-medium text-[var(--ds-text)]">
                    {t('analytics.visits') || 'Visits'}
                  </span>
                ),
              }}
            />
          </p>
        </div>
      )}
    </>
  );
}
