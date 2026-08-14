import { type ReactElement, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Calendar,
  Compass,
  LogOut,
  Mail,
  MessageCircle,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Button, EmptyState, LockedFeatureCard, Skeleton } from '../../design-system';
import { useAnimatedProgress } from '../../hooks/useAnimatedProgress';
import { useJourneyAnalytics } from './useJourneyAnalytics';

/**
 * JourneyOutcomes — donut + legend that answers "what did visitors
 * do after opening the chatbot?" Feeds off the same
 * ``useJourneyAnalytics`` hook as UserJourneyFlow / PageInfluence,
 * so the polling + focus refetch + manual reload story is shared:
 * whenever the hook re-fetches, this panel updates too.
 *
 * Numbers come from ``data.summary`` (conversions, sessions with
 * journey) and ``data.postChat`` (sessions with post-chat activity).
 * Drop-off is the honest remainder — sessions_with_journey minus
 * everything else — clamped to zero so overlap-based double-counts
 * never make it negative.
 */

type OutcomeKey = 'meeting_booked' | 'kept_browsing' | 'handoff_requested' | 'offline_message_sent' | 'exit';

interface Outcome {
  key: OutcomeKey;
  label: string;
  icon: LucideIcon;
  /** Solid colour for the donut segment. */
  fill: string;
  /** Icon-tile colour (translucent version of `fill`). */
  tile: string;
  /** Icon foreground colour on the tile. */
  iconFg: string;
  value: number;
}

/** Palette (aligned with the flow diagram's palette for consistency). */
const OUTCOME_STYLES: Record<OutcomeKey, Omit<Outcome, 'value'>> = {
  meeting_booked: {
    key: 'meeting_booked',
    label: 'Meeting Booked',
    icon: Calendar,
    fill: '#10b981',
    tile: 'rgba(16, 185, 129, 0.14)',
    iconFg: '#34d399',
  },
  kept_browsing: {
    key: 'kept_browsing',
    label: 'Kept Browsing',
    icon: Compass,
    fill: '#3b82f6',
    tile: 'rgba(59, 130, 246, 0.14)',
    iconFg: '#60a5fa',
  },
  handoff_requested: {
    key: 'handoff_requested',
    label: 'Live Chat',
    icon: MessageCircle,
    fill: '#f97316',
    tile: 'rgba(249, 115, 22, 0.14)',
    iconFg: '#fb923c',
  },
  offline_message_sent: {
    key: 'offline_message_sent',
    label: 'Offline Message',
    icon: Mail,
    fill: '#a855f7',
    tile: 'rgba(168, 85, 247, 0.14)',
    iconFg: '#c084fc',
  },
  exit: {
    key: 'exit',
    label: 'Drop-off / Exit',
    icon: LogOut,
    fill: '#ef4444',
    tile: 'rgba(239, 68, 68, 0.14)',
    iconFg: '#f87171',
  },
};

const DONUT_ORDER: readonly OutcomeKey[] = [
  'meeting_booked',
  'kept_browsing',
  'handoff_requested',
  'offline_message_sent',
  'exit',
] as const;

// Donut geometry — SVG viewBox is 160x160; segments are drawn as
// stroke arcs on a single circle so total stroke length equals the
// circumference and each segment's stroke-dasharray carves out its
// proportional share. Shrunk from 200 → 160 for a slicker footprint
// that lines up better with PageInfluence's height.
const DONUT_VB = 160;
const DONUT_R = 62;
const DONUT_STROKE = 20;
const DONUT_CIRC = 2 * Math.PI * DONUT_R;
const DONUT_PX = 160;

export interface JourneyOutcomesProps {
  botId: number | null;
}

export function JourneyOutcomes({ botId }: JourneyOutcomesProps): ReactElement {
  const { status, data, error, refreshing, reload, lastUpdatedAt } = useJourneyAnalytics(botId);

  // Compose the outcome rows.
  const outcomes = useMemo<Outcome[]>(() => {
    if (!data) return [];
    const conversions =
      data.summary.meeting_booked + data.summary.handoff_requested + data.summary.offline_message_sent;
    const keptBrowsing = data.postChat.sessions_with_post_chat_activity;
    // Prefer the backend's `sessions_no_activity` (true drop-off — no
    // conversion AND no post-chat page). Subtracting kept-browsing +
    // conversions from the total double-counts any session that both
    // converted AND kept browsing, which reads low here.
    const dropoff =
      typeof data.summary.sessions_no_activity === 'number'
        ? data.summary.sessions_no_activity
        : Math.max(0, data.summary.sessions_with_journey - conversions - keptBrowsing);
    const values: Record<OutcomeKey, number> = {
      meeting_booked: data.summary.meeting_booked,
      kept_browsing: keptBrowsing,
      handoff_requested: data.summary.handoff_requested,
      offline_message_sent: data.summary.offline_message_sent,
      exit: dropoff,
    };
    return DONUT_ORDER.map((key) => ({ ...OUTCOME_STYLES[key], value: values[key] }));
  }, [data]);

  const total = useMemo(() => outcomes.reduce((acc, o) => acc + o.value, 0), [outcomes]);

  // ── State branching ────────────────────────────────────────────────────
  if (botId == null) {
    return (
      <PanelShell>
        <EmptyState
          icon={Compass}
          title="Pick a chatbot to see outcomes"
          description="Journey outcomes are always per-chatbot. Use the chatbot switcher above to focus this view."
        />
      </PanelShell>
    );
  }
  if (status === 'gated') {
    return (
      <PanelShell>
        <LockedFeatureCard intent="view_journeys" icon={Sparkles} />
      </PanelShell>
    );
  }
  if (status === 'loading' || status === 'idle') {
    return (
      <PanelShell>
        <Skeleton className="h-[280px]" />
      </PanelShell>
    );
  }
  if (status === 'error' || !data) {
    return (
      <PanelShell>
        <EmptyState
          icon={TriangleAlert}
          title="We couldn’t load outcomes"
          description={error ?? 'Something went wrong.'}
          action={
            <Button variant="primary" onClick={reload}>
              <RefreshCw size={16} aria-hidden="true" />
              Try again
            </Button>
          }
        />
      </PanelShell>
    );
  }
  if (total === 0) {
    return (
      <PanelShell>
        <Header lastUpdatedAt={lastUpdatedAt} refreshing={refreshing} onReload={reload} />
        <EmptyState
          icon={BarChart3}
          title="No chat sessions yet"
          description="Once visitors start opening the chatbot, their outcomes will land here."
        />
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <Header lastUpdatedAt={lastUpdatedAt} refreshing={refreshing} onReload={reload} />
      <div className="mt-3 flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-6">
        <Donut outcomes={outcomes} total={total} />
        <Legend outcomes={outcomes} />
      </div>
    </PanelShell>
  );
}

// ── Panel chrome ────────────────────────────────────────────────────────────

function PanelShell({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5">
      {children}
    </div>
  );
}

function Header({
  lastUpdatedAt,
  refreshing,
  onReload,
}: {
  lastUpdatedAt: number | null;
  refreshing: boolean;
  onReload: () => void;
}): ReactElement {
  // Rerender the label once a second so "Updated Xs ago" keeps ticking
  // between polls — matches the UserJourneyFlow panel; without the tick
  // this label froze at whatever second the last poll landed on and
  // silently disagreed with the flow panel on the same page.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const freshness = useMemo(() => {
    if (lastUpdatedAt == null) return null;
    const secs = Math.max(0, Math.round((nowTick - lastUpdatedAt) / 1_000));
    if (secs < 5) return 'Updated just now';
    if (secs < 60) return `Updated ${secs}s ago`;
    return `Updated ${Math.round(secs / 60)}m ago`;
  }, [lastUpdatedAt, nowTick]);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">
          Journey Outcomes <span className="text-[var(--ds-text-muted)]">(After Chat)</span>
        </h3>
      </div>
      <div className="flex items-center gap-2">
        {freshness && (
          <span className="tabular-nums text-[11px] text-[var(--ds-text-subtle)]">{freshness}</span>
        )}
        <button
          type="button"
          onClick={onReload}
          disabled={refreshing}
          aria-label="Refresh"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-sunken)] hover:text-[var(--ds-text)] disabled:opacity-60"
        >
          <RefreshCw
            size={14}
            className={refreshing ? 'animate-spin' : undefined}
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}

// ── Donut ───────────────────────────────────────────────────────────────────

function Donut({ outcomes, total }: { outcomes: readonly Outcome[]; total: number }): ReactElement {
  // Tally the centre "Chat Opens" figure up from 0 when the page loads (and
  // whenever it changes), matching the count-up used on the other metric tiles.
  // One continuous eased progress drives both the centre figure and the ring so
  // they move as one. Using a float (not a rounded count) keeps the arc sweep
  // buttery smooth every frame rather than stepping in whole-number jumps;
  // `Math.round` still gives the figure its odometer feel. Restarts when the
  // total changes (e.g. a data refresh).
  const progress = useAnimatedProgress(1400, total);
  const animatedTotal = Math.round(total * progress);
  // Precompute each segment's start offset + length along the donut ring.
  // reduce() gives us a pure walk that satisfies React Compiler's
  // immutability rule (a `let cursor` reassigned inside .map() trips it).
  const segments = useMemo(() => {
    const positive = outcomes.filter((o) => o.value > 0);
    return positive.reduce<Array<Outcome & { offset: number; length: number }>>(
      (acc, o) => {
        const prev = acc[acc.length - 1];
        const offset = prev ? prev.offset + prev.length : 0;
        const length = (o.value / total) * DONUT_CIRC;
        acc.push({ ...o, offset, length });
        return acc;
      },
      [],
    );
  }, [outcomes, total]);

  // Draw the ring in step with the centre count-up: as the figure tallies from
  // 0 → total, the coloured arc sweeps clockwise from 12 o'clock to its full
  // length. `usedArc` is how much of the ring the segments actually occupy, so
  // the sweep completes exactly as the number lands. Reduced-motion users get
  // `animatedTotal === total` on the first frame, so the ring renders complete.
  const usedArc = useMemo(() => segments.reduce((sum, seg) => sum + seg.length, 0), [segments]);
  const revealFront = progress * usedArc;

  return (
    <div
      className="relative flex shrink-0 items-center justify-center"
      style={{ width: DONUT_PX, height: DONUT_PX }}
    >
      <svg viewBox={`0 0 ${DONUT_VB} ${DONUT_VB}`} width={DONUT_PX} height={DONUT_PX} aria-hidden="true">
        {/* Track — the empty ring under the segments; renders a subtle
            outline even when data is sparse so the donut reads as a
            complete shape rather than floating arcs. */}
        <circle
          cx={DONUT_VB / 2}
          cy={DONUT_VB / 2}
          r={DONUT_R}
          fill="none"
          stroke="var(--ds-border)"
          strokeWidth={DONUT_STROKE}
          opacity={0.35}
        />
        {/* Rotate the group -90° so segment #1 starts at 12 o'clock. */}
        <g transform={`rotate(-90 ${DONUT_VB / 2} ${DONUT_VB / 2})`}>
          {segments.map((seg) => {
            // How much of this segment has been reached by the sweep front.
            const drawn = Math.max(0, Math.min(seg.length, revealFront - seg.offset));
            return (
              <circle
                key={seg.key}
                cx={DONUT_VB / 2}
                cy={DONUT_VB / 2}
                r={DONUT_R}
                fill="none"
                stroke={seg.fill}
                strokeWidth={DONUT_STROKE}
                strokeDasharray={`${drawn} ${DONUT_CIRC}`}
                strokeDashoffset={-seg.offset}
                strokeLinecap="butt"
              />
            );
          })}
        </g>
      </svg>
      {/* Centre label — total chat opens. Absolutely positioned so it
          sits pixel-perfect in the middle of the ring. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <p className="tabular-nums text-[18px] font-semibold leading-none text-[var(--ds-text)]">
          {animatedTotal.toLocaleString()}
        </p>
        <p className="mt-1 text-[10px] text-[var(--ds-text-muted)]">Chat Opens</p>
      </div>
    </div>
  );
}

// ── Legend ──────────────────────────────────────────────────────────────────

function Legend({ outcomes }: { outcomes: readonly Outcome[] }): ReactElement {
  return (
    <ul className="w-full min-w-0 space-y-1.5">
      {outcomes.map((o) => {
        const Icon = o.icon;
        return (
          <li key={o.key} className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {/* Small colored dot matches the donut segment tone —
                  enough to link legend ↔ chart without repainting the
                  whole icon tile in a translucent hue. */}
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: o.fill }}
              />
              <Icon
                size={14}
                strokeWidth={1.75}
                className="shrink-0 text-[var(--ds-text-muted)]"
                aria-hidden="true"
              />
              <span className="truncate text-[12.5px] font-medium text-[var(--ds-text)]">
                {o.label}
              </span>
            </div>
            <span className="shrink-0 tabular-nums text-[12.5px] font-semibold text-[var(--ds-text)]">
              {o.value.toLocaleString()}{' '}
              <span className="text-[10.5px] font-normal text-[var(--ds-text-muted)]">users</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
