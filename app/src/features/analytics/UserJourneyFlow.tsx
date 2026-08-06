import { type ReactElement, type ReactNode, useMemo } from 'react';
import {
  BookOpen,
  Bot,
  Calendar,
  Compass,
  FileText,
  HelpCircle,
  Home,
  LayoutGrid,
  LineChart,
  LogOut,
  Mail,
  Maximize2,
  MessageCircle,
  Network,
  Package,
  RefreshCw,
  Sparkles,
  Star,
  Tag,
  TriangleAlert,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  EmptyState,
  LockedFeatureCard,
  Skeleton,
} from '../../design-system';
import { useJourneyAnalytics } from './useJourneyAnalytics';

/**
 * UserJourneyFlow — a Sankey-inspired flow visualisation. Sources on
 * the left (pages the visitor saw BEFORE opening chat), the "Opened
 * Chatbot" node in the middle, outcomes on the right. Curves widen
 * with visitor volume.
 *
 * Real data comes from ``useJourneyAnalytics`` (summary + pre-phase
 * top pages). Path strings are heuristically bucketed into a small
 * fixed set of source slots — Home, Pricing, Blog, Other Pages,
 * Features, Product, FAQ, Resources — so the layout stays stable
 * even when a bot's URLs change month to month.
 */

// ── Palette ─────────────────────────────────────────────────────────────────
type ToneKey = 'green' | 'blue' | 'purple' | 'orange' | 'red' | 'yellow' | 'gray';

interface Tone {
  icon: string;
  tile: string;
  line: string;
}

const TONE: Record<ToneKey, Tone> = {
  green: { icon: '#10b981', tile: 'rgba(16, 185, 129, 0.14)', line: 'rgba(16, 185, 129, 0.55)' },
  blue: { icon: '#3b82f6', tile: 'rgba(59, 130, 246, 0.14)', line: 'rgba(59, 130, 246, 0.55)' },
  purple: { icon: '#a855f7', tile: 'rgba(168, 85, 247, 0.14)', line: 'rgba(168, 85, 247, 0.55)' },
  orange: { icon: '#f97316', tile: 'rgba(249, 115, 22, 0.14)', line: 'rgba(249, 115, 22, 0.55)' },
  red: { icon: '#ef4444', tile: 'rgba(239, 68, 68, 0.14)', line: 'rgba(239, 68, 68, 0.55)' },
  yellow: { icon: '#eab308', tile: 'rgba(234, 179, 8, 0.14)', line: 'rgba(234, 179, 8, 0.55)' },
  gray: { icon: '#94a3b8', tile: 'rgba(148, 163, 184, 0.14)', line: 'rgba(148, 163, 184, 0.55)' },
};

// ── Layout constants (SVG viewBox = 820 x 500) ──────────────────────────────
const VB_W = 820;
const VB_H = 500;
const CARD_W = 156;
const CARD_H = 64;
// Circle x is the midpoint of the horizontal gap between the middle
// source column (right edge = 210 + 156 = 366) and the destinations
// column (left edge = 620). Anything smaller than ~440 overlaps the
// FAQ/Resources cards, which was the original bug.
const CENTER = { x: 493, y: 252, r: 68 };

interface FlowNode {
  id: string;
  label: string;
  value: number;
  tone: ToneKey;
  icon: LucideIcon;
  x: number;
  y: number;
  /** Only set for destinations. */
  pct?: number;
}

interface FlowSequenceRow {
  id: string;
  sessions: number;
  /** Row's vertical centre — used to end its curve on the chatbot circle. */
  yCenter: number;
  cards: FlowNode[];
}

// Rotating (tone, icon) palette that colours the chain-row cards.
// Purely decorative — the cards are labelled by their real URL path,
// so icons don't have to match page semantics; the palette gives each
// stop in a chain visible identity.
const SOURCE_STYLES: ReadonlyArray<{ tone: ToneKey; icon: LucideIcon }> = [
  { tone: 'green', icon: Home },
  { tone: 'purple', icon: Star },
  { tone: 'blue', icon: Tag },
  { tone: 'orange', icon: Package },
  { tone: 'green', icon: FileText },
  { tone: 'red', icon: HelpCircle },
  { tone: 'gray', icon: LayoutGrid },
  { tone: 'gray', icon: BookOpen },
];

// Chain-row layout: each common pre-chat sequence renders as a row of
// chained cards flowing right into the chatbot. Card widths are set
// smaller than the destination CARD_W (156) so up to MAX_CHAIN_LEN
// cards + the gap to the chatbot circle fit inside the viewBox.
const CHAIN_CARD_W = 116;
const CHAIN_GAP = 15;
const CHAIN_START_X = 24;
const MAX_CHAIN_LEN = 3;
const MAX_SEQUENCE_ROWS = 4;
/** Evenly-distributed vertical row centres, computed once at module load. */
const SEQUENCE_ROW_CENTERS: ReadonlyArray<number> = Array.from(
  { length: MAX_SEQUENCE_ROWS },
  (_, i) => (VB_H * (i + 1)) / (MAX_SEQUENCE_ROWS + 1),
);

// Static conversion + exit destinations. Post-chat "kept browsing"
// is expanded dynamically inside the flow memo into real page rows
// pulled from data.postChat.first_hops so owners see the actual URLs
// visitors landed on after closing chat, not just an aggregate count.
const CONVERSION_DESTINATIONS = [
  { id: 'meeting_booked', label: 'Book Meeting', tone: 'green' as const, icon: Calendar },
  { id: 'handoff_requested', label: 'Live Chat', tone: 'orange' as const, icon: MessageCircle },
  { id: 'offline_message_sent', label: 'Offline Message', tone: 'purple' as const, icon: Mail },
];
const EXIT_DESTINATION = { id: 'exit', label: 'Drop-off / Exit', tone: 'gray' as const, icon: LogOut };

/** Cap on how many distinct post-chat pages we surface as destinations.
 *  Too many and the right column crowds the diagram; three is enough to
 *  see the pattern for most bots. */
const MAX_POST_CHAT_DESTINATIONS = 3;
const DEST_COLUMN_X = 620;

/** Trim a path for display on the compact source card. */
function displayPath(path: string, max: number = 22): string {
  if (path.length <= max) return path;
  // Keep the head so the domain-relative context (e.g. `/blog/`) reads.
  return `${path.slice(0, max - 1)}…`;
}

// ── Line width scaling ──────────────────────────────────────────────────────
// Reference image uses very thin curves; caps kept low so even the
// busiest source doesn't produce a chunky ribbon.
const MIN_STROKE = 1.5;
const MAX_STROKE = 4;

function strokeFor(value: number, allValues: readonly number[]): number {
  const positive = allValues.filter((v) => v > 0);
  if (value <= 0 || positive.length === 0) return 0;
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  if (max === min) return (MIN_STROKE + MAX_STROKE) / 2;
  const t = (value - min) / (max - min);
  return MIN_STROKE + t * (MAX_STROKE - MIN_STROKE);
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function cardLeft(node: FlowNode): { x: number; y: number } {
  return { x: node.x, y: node.y + CARD_H / 2 };
}
function circleEntry(index: number, count: number): { x: number; y: number } {
  const angle = -70 + (140 * index) / Math.max(count - 1, 1);
  const rad = (angle * Math.PI) / 180;
  return { x: CENTER.x - CENTER.r * Math.cos(rad), y: CENTER.y + CENTER.r * Math.sin(rad) };
}
function circleExit(index: number, count: number): { x: number; y: number } {
  const angle = -70 + (140 * index) / Math.max(count - 1, 1);
  const rad = (angle * Math.PI) / 180;
  return { x: CENTER.x + CENTER.r * Math.cos(rad), y: CENTER.y + CENTER.r * Math.sin(rad) };
}

// ── UI ─────────────────────────────────────────────────────────────────────

export interface UserJourneyFlowProps {
  botId: number | null;
}

export function UserJourneyFlow({ botId }: UserJourneyFlowProps): ReactElement {
  const { status, data, error, refreshing, reload } = useJourneyAnalytics(botId);

  // Compose the flow shape from the analytics payload.
  const flow = useMemo(() => {
    if (!data) return null;

    // Sources: real pre-chat page SEQUENCES from the DB, chained
    // together. Each row is one common ordered pattern (e.g.
    // Home → About → Contact) that visitors travelled before
    // opening chat. Sequences longer than MAX_CHAIN_LEN are clipped
    // from the head so the tail (page closest to chat_opened) stays
    // in view.
    const rawSequences = data.preChatSequences.sequences
      .filter((seq) => seq.sessions > 0 && seq.sequence.length > 0)
      .slice(0, MAX_SEQUENCE_ROWS);

    const sequenceRows: FlowSequenceRow[] = rawSequences.map((seq, rowIndex) => {
      const yCenter = SEQUENCE_ROW_CENTERS[rowIndex];
      const rowY = yCenter - CARD_H / 2;
      const clipped = seq.sequence.slice(-MAX_CHAIN_LEN);
      const cards: FlowNode[] = clipped.map((path, i) => {
        const style = SOURCE_STYLES[(rowIndex * MAX_CHAIN_LEN + i) % SOURCE_STYLES.length];
        return {
          id: `seq-${rowIndex}-${i}-${path}`,
          label: displayPath(path, 14),
          tone: style.tone,
          icon: style.icon,
          x: CHAIN_START_X + i * (CHAIN_CARD_W + CHAIN_GAP),
          y: rowY,
          value: seq.sessions,
        };
      });
      return {
        id: `row-${rowIndex}`,
        sessions: seq.sessions,
        yCenter,
        cards,
      };
    });

    // Destinations breakdown:
    //  - Three conversion slots from summary_counts (Book Meeting /
    //    Live Chat / Offline Message).
    //  - Up to MAX_POST_CHAT_DESTINATIONS ACTUAL post-chat page
    //    destinations, pulled from data.postChat.first_hops. Each row
    //    is labelled with the real URL path a visitor landed on after
    //    closing chat, so an owner sees "which page did they go to?"
    //    not just "how many kept browsing".
    //  - Drop-off / Exit — the honest remainder after conversions and
    //    all post-chat activity (whether shown or not) are subtracted.
    const conversions =
      data.summary.meeting_booked + data.summary.handoff_requested + data.summary.offline_message_sent;
    const keptBrowsingTotal = data.postChat.sessions_with_post_chat_activity;
    const dropoff = Math.max(0, data.summary.sessions_with_journey - conversions - keptBrowsingTotal);
    const centerValue = data.summary.sessions_with_journey;
    const denom = centerValue > 0 ? centerValue : 1;

    const conversionValues: Record<string, number> = {
      meeting_booked: data.summary.meeting_booked,
      handoff_requested: data.summary.handoff_requested,
      offline_message_sent: data.summary.offline_message_sent,
    };

    interface StagedDest {
      id: string;
      label: string;
      tone: ToneKey;
      icon: LucideIcon;
      value: number;
    }

    const stagedDestinations: StagedDest[] = [
      ...CONVERSION_DESTINATIONS.map((slot) => ({
        id: slot.id,
        label: slot.label,
        tone: slot.tone,
        icon: slot.icon,
        value: conversionValues[slot.id] ?? 0,
      })),
      // Real post-chat pages — top N by session count.
      ...data.postChat.first_hops.slice(0, MAX_POST_CHAT_DESTINATIONS).map((hop, i) => ({
        id: `postchat-${i}-${hop.path}`,
        label: displayPath(hop.path),
        tone: 'blue' as ToneKey,
        icon: Compass,
        value: hop.sessions,
      })),
      {
        id: EXIT_DESTINATION.id,
        label: EXIT_DESTINATION.label,
        tone: EXIT_DESTINATION.tone,
        icon: EXIT_DESTINATION.icon,
        value: dropoff,
      },
    ];

    // Only render destinations that actually happened this window. Drop
    // the zero rows and re-space the survivors evenly along the viewport
    // height so 2 destinations spread across the full column instead of
    // clumping at the top.
    const activeDests = stagedDestinations.filter((d) => d.value > 0);
    const destinations: FlowNode[] = activeDests.map((d, i, arr) => {
      const centerY = (VB_H * (i + 1)) / (arr.length + 1);
      return {
        id: d.id,
        label: d.label,
        tone: d.tone,
        icon: d.icon,
        x: DEST_COLUMN_X,
        y: centerY - CARD_H / 2,
        value: d.value,
        pct: Math.round((d.value / denom) * 100),
      };
    });

    return { sequenceRows, destinations, centerValue };
  }, [data]);

  // ── State branching ────────────────────────────────────────────────────
  if (botId == null) {
    return (
      <EmptyState
        icon={Compass}
        title="Pick an agent to see its flow"
        description="Journey flows are always per-agent. Use the agent switcher above to focus this view."
      />
    );
  }
  if (status === 'gated') {
    return <LockedFeatureCard intent="view_journeys" icon={Sparkles} />;
  }
  if (status === 'loading' || status === 'idle') {
    return <Skeleton className="h-[540px]" />;
  }
  if (status === 'error' || !flow) {
    return (
      <EmptyState
        icon={TriangleAlert}
        title="We couldn’t load the flow"
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
  if (flow.centerValue === 0) {
    return (
      <EmptyState
        icon={UserCheck}
        title="No chat sessions yet in this window"
        description="Once visitors start chatting with your agent, their journey through your pages will render here."
      />
    );
  }

  const rowSessions = flow.sequenceRows.map((r) => r.sessions);
  const destValues = flow.destinations.map((d) => d.value);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-6">
      {/* Header row */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">
            User Journey Flow (All Paths)
          </h3>
          <p className="text-[12px] text-[var(--ds-text-muted)]">
            Thicker lines represent more users
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-1.5 text-[12px] text-[var(--ds-text-muted)]">
            All users
          </span>
          <IconButton aria-label="Line chart view">
            <LineChart size={16} />
          </IconButton>
          <IconButton aria-label="Network view" active>
            <Network size={16} />
          </IconButton>
          <IconButton aria-label="Fullscreen" onClick={reload} disabled={refreshing}>
            {refreshing ? (
              <RefreshCw size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <Maximize2 size={16} />
            )}
          </IconButton>
        </div>
      </div>

      {/* Diagram */}
      <div className="relative mx-auto" style={{ maxWidth: VB_W }}>
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-auto w-full"
        >
          {/* Source rows → chatbot: for each pre-chat sequence we chain
              its cards together and then draw a final curve into the
              chatbot circle. Stroke width scales with the row's session
              count. */}
          {flow.sequenceRows.map((row, i) => {
            if (row.cards.length === 0) return null;
            const w = strokeFor(row.sessions, rowSessions);
            if (w <= 0) return null;
            const chatEnd = circleEntry(i, flow.sequenceRows.length);
            const lineTone = TONE[row.cards[row.cards.length - 1].tone].line;
            return (
              <g key={`row-${row.id}`}>
                {/* Between-card connections inside the row. */}
                {row.cards.slice(0, -1).map((card, j) => {
                  const next = row.cards[j + 1];
                  const start = { x: card.x + CHAIN_CARD_W, y: card.y + CARD_H / 2 };
                  const end = { x: next.x, y: next.y + CARD_H / 2 };
                  return (
                    <path
                      key={`chain-${row.id}-${j}`}
                      d={curve(start.x, start.y, end.x, end.y)}
                      stroke={TONE[card.tone].line}
                      strokeWidth={w}
                      fill="none"
                      strokeLinecap="round"
                      opacity={0.85}
                    />
                  );
                })}
                {/* Last card → chatbot circle. */}
                {(() => {
                  const last = row.cards[row.cards.length - 1];
                  const start = { x: last.x + CHAIN_CARD_W, y: last.y + CARD_H / 2 };
                  return (
                    <path
                      d={curve(start.x, start.y, chatEnd.x, chatEnd.y)}
                      stroke={lineTone}
                      strokeWidth={w}
                      fill="none"
                      strokeLinecap="round"
                      opacity={0.85}
                    />
                  );
                })()}
              </g>
            );
          })}

          {/* Chatbot → destinations lines */}
          {flow.destinations.map((node, i) => {
            const start = circleExit(i, flow.destinations.length);
            const end = cardLeft(node);
            const w = strokeFor(node.value, destValues);
            if (w <= 0) return null;
            return (
              <path
                key={`out-${node.id}`}
                d={curve(start.x, start.y, end.x, end.y)}
                stroke={TONE[node.tone].line}
                strokeWidth={w}
                fill="none"
                strokeLinecap="round"
                opacity={0.85}
              />
            );
          })}

          {/* Central chatbot circle — uses design-system accent so it themes correctly. */}
          <circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={CENTER.r + 8}
            fill="var(--ds-accent-soft)"
            opacity={0.55}
          />
          <circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={CENTER.r}
            fill="var(--ds-accent)"
            stroke="var(--ds-accent-hover)"
            strokeWidth={2}
          />
          <foreignObject
            x={CENTER.x - CENTER.r}
            y={CENTER.y - CENTER.r}
            width={CENTER.r * 2}
            height={CENTER.r * 2}
          >
            <div className="flex h-full w-full flex-col items-center justify-center text-center">
              <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-[var(--ds-accent-fg)]">
                <Bot size={22} strokeWidth={1.75} />
              </div>
              <p className="text-[11px] font-medium leading-tight text-[var(--ds-accent-fg)] opacity-90">
                Opened Chatbot
              </p>
              <p className="tabular-nums text-[16px] font-semibold leading-tight text-[var(--ds-accent-fg)]">
                {flow.centerValue.toLocaleString()}
              </p>
            </div>
          </foreignObject>

          {/* Chain-row cards (narrower) — every card in every row. */}
          {flow.sequenceRows.flatMap((row) =>
            row.cards.map((card) => (
              <foreignObject
                key={card.id}
                x={card.x}
                y={card.y}
                width={CHAIN_CARD_W}
                height={CARD_H}
              >
                <FlowCard node={card} />
              </foreignObject>
            )),
          )}
          {/* Destination cards (wider). */}
          {flow.destinations.map((node) => (
            <foreignObject
              key={node.id}
              x={node.x}
              y={node.y}
              width={CARD_W}
              height={CARD_H}
            >
              <FlowCard node={node} />
            </foreignObject>
          ))}
        </svg>
      </div>
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

function FlowCard({ node }: { node: FlowNode }): ReactElement {
  const Icon = node.icon;
  const tone = TONE[node.tone];
  return (
    <div className="flex h-full w-full items-center gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: tone.tile, color: tone.icon }}
      >
        <Icon size={16} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-[var(--ds-text-muted)]">{node.label}</p>
        <p className="tabular-nums text-[13px] font-semibold leading-tight text-[var(--ds-text)]">
          {node.value.toLocaleString()}
          {typeof node.pct === 'number' && node.value > 0 && (
            <span className="ml-1 text-[11px] font-normal text-[var(--ds-text-subtle)]">
              ({node.pct}%)
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

// ── Header controls ─────────────────────────────────────────────────────────

function IconButton({
  children,
  active,
  onClick,
  disabled,
  ...rest
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  'aria-label': string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        active
          ? 'flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ds-border-strong)] bg-[var(--ds-bg-sunken)] text-[var(--ds-text)] disabled:opacity-60'
          : 'flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-sunken)] hover:text-[var(--ds-text)] disabled:opacity-60'
      }
      {...rest}
    >
      {children}
    </button>
  );
}
