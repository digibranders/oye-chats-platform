import { useMemo, useState } from 'react';
import { Bot, Compass, Maximize2 } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  EmptyState,
  Select,
  ZoomPanCanvas,
  cn,
  formatNumber,
} from '../../ui';
import type { JourneyPreChatSequencesResponse } from '../../services/api';
import { isFilterableOutcome, type FilterableOutcome } from './journeyModel';
import {
  buildTrie,
  circleEntry,
  circleExit,
  curve,
  layoutTrie,
  pruneToMaxLeaves,
  strokeFor,
  boostForHighlight,
  CARD_H,
  CENTER,
  CHAIN_START_X,
  CHAIN_END_X,
  POST_CHAIN_START_X,
  POST_CHAIN_END_X,
  VB_H_BASE,
  VB_W,
  V_MARGIN,
  type ToneKey,
  type TrieVizNode,
} from './journeyTrie';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

/** Hard ceiling on visible leaves per side. Also the fetch shape's own cap
 * (`sequences` is already limited server-side) and the "All" option's value. */
const TRIE_MAX_LEAVES = 25;
/** Default number of page flows shown before the reader asks for more. Keeping
 * it small stops the pre-chat side from overlapping on dense accounts. */
const DEFAULT_MAX_FLOWS = 5;
const flowCountOptions = () => [
  { value: '5', label: translateNow('analytics.top5') || 'Top 5' },
  { value: '10', label: translateNow('analytics.top10') || 'Top 10' },
  { value: String(TRIE_MAX_LEAVES), label: translateNow('analytics.all') || 'All' },
];

const TONE: Record<ToneKey, { icon: string; tile: string; line: string }> = {
  green: { icon: '#10b981', tile: 'rgba(16, 185, 129, 0.14)', line: 'rgba(16, 185, 129, 0.55)' },
  blue: { icon: '#3b82f6', tile: 'rgba(59, 130, 246, 0.14)', line: 'rgba(59, 130, 246, 0.55)' },
  purple: { icon: '#a855f7', tile: 'rgba(168, 85, 247, 0.14)', line: 'rgba(168, 85, 247, 0.55)' },
  orange: { icon: '#f97316', tile: 'rgba(249, 115, 22, 0.14)', line: 'rgba(249, 115, 22, 0.55)' },
  red: { icon: '#ef4444', tile: 'rgba(239, 68, 68, 0.14)', line: 'rgba(239, 68, 68, 0.55)' },
  yellow: { icon: '#eab308', tile: 'rgba(234, 179, 8, 0.14)', line: 'rgba(234, 179, 8, 0.55)' },
  gray: { icon: '#94a3b8', tile: 'rgba(148, 163, 184, 0.14)', line: 'rgba(148, 163, 184, 0.55)' },
};

/**
 * The card's corner, in viewBox units.
 *
 * 8, not the 14 of `rounded-xl`. A card is 64 units tall, so 14 was 22% of
 * its own height — a pill, not a chip — and it read as one the moment the
 * diagram was scaled up. 8 is the radius the design system gives a medium
 * CONTROL, which is what one of these is: a small, dense, clickable box.
 */
const CARD_RADIUS = 8;

/**
 * The card's chrome, drawn as real SVG rather than CSS inside the
 * `foreignObject`.
 *
 * This is the fix for a border that looked heavy and corners that looked
 * bloated. HTML inside a `foreignObject` is laid out in the SVG's own USER
 * units, so `border: 1px` and `border-radius: 14px` are 1 and 14 *viewBox*
 * units — and both are then multiplied by whatever scale the viewBox is
 * rendered at. At the card view's ~1.1 that already put the border on a
 * fractional 1.11 device pixels (so it antialiased into a soft, uneven
 * line) and the radius at 15.5px; under the zoom control it got far worse,
 * a 3px slab of border with 42px stadium corners at 3×.
 *
 * Chrome must not scale with the drawing. A `<rect>` with
 * `vector-effect="non-scaling-stroke"` is stroked in DEVICE pixels — exactly
 * one, crisp, at every zoom level — and its `rx` is applied before the
 * stroke, so the corner stays a fixed proportion of the card instead of
 * growing with it. The text stays in a `foreignObject` because that is what
 * still gives it real truncation.
 */
function CardChrome({
  node,
  active,
}: {
  node: { x: number; y: number; width: number; tone: ToneKey };
  active: boolean;
}) {
  const tone = TONE[node.tone] ?? TONE.gray;
  return (
    <>
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={CARD_H}
        rx={CARD_RADIUS}
        fill="var(--color-surface-sunken)"
        stroke={active ? 'var(--color-accent-500)' : 'var(--color-border)'}
        strokeWidth={active ? 2 : 1}
        vectorEffect="non-scaling-stroke"
      />
      {/* The branch's colour, as a real circle for the same reason as the
          border: a CSS dot would swell with the zoom. Suppressed while the
          card is selected — the accent ring already carries that state, and
          two marks in one corner read as a defect. */}
      {active ? null : (
        <circle
          cx={node.x + node.width - CARD_RADIUS}
          cy={node.y + CARD_RADIUS}
          r={2.5}
          fill={tone.icon}
        />
      )}
    </>
  );
}

/**
 * The card's text. Transparent — `CardChrome` draws everything else.
 *
 * Sized in viewBox units like the layout around it, so a label keeps its
 * proportion to the card it sits in at every zoom.
 */
function FlowCardText({
  node,
  subtitle,
  tooltip,
}: {
  node: { label: string; sessions: number; width: number; isFork?: boolean };
  subtitle?: string;
  tooltip?: string;
}) {
  const compact = node.width < 80;

  if (compact) {
    return (
      <div
        title={tooltip}
        className="flex h-full w-full flex-col items-center justify-center px-1.5 py-1"
      >
        <div className="min-w-0 max-w-full text-center">
          <p className="truncate text-2xs font-medium leading-tight text-text-secondary">
            {node.label}
          </p>
          <p className="tabular-nums text-2xs font-semibold leading-tight text-text-primary">
            {node.sessions.toLocaleString()}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div title={tooltip} className="flex h-full w-full items-center px-3">
      <div className="min-w-0 flex-1">
        {/* `pr-3` keeps a long path clear of the tone dot in the corner,
            which is no longer a sibling element reserving its own space. */}
        <p className="truncate pr-3 text-xs font-medium text-text-secondary">{node.label}</p>
        <p className="tabular-nums text-sm font-semibold leading-tight text-text-primary">
          {node.sessions.toLocaleString()}
          {subtitle && (
            <span className="ml-1 text-2xs font-normal uppercase tracking-wide text-text-tertiary">
              {subtitle}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

export interface JourneyDiagramProps {
  sequences: JourneyPreChatSequencesResponse | {
    total_sessions: number;
    sessions_with_pre_chat: number;
    sequences: Array<{
      sequence: string[];
      post_sequence?: string[];
      post_sessions?: number;
      sessions: number;
    }>;
  };
  centerLabel?: string;
  centerValue?: number;
  selectedOutcome?: FilterableOutcome | null;
  onSelectOutcome?: (outcome: FilterableOutcome | null) => void;
  className?: string;
}

export function JourneyDiagram({
  sequences,
  centerLabel,
  centerValue = 0,
  selectedOutcome,
  onSelectOutcome,
  className,
}: JourneyDiagramProps) {
  const { t } = useTranslation();
  // Defaulted in the body: a default parameter is evaluated before the hook
  // runs, so `t` does not exist in the signature yet.
  const center = centerLabel === undefined ? (t('analytics.openedChatbot') || 'Opened Chatbot') : centerLabel;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // How many page flows to render. Defaults to the top few so the pre-chat
  // side stays legible; the reader can widen it to All from the header.
  const [maxFlows, setMaxFlows] = useState<number>(DEFAULT_MAX_FLOWS);
  // Narrows the diagram to journeys that BEGAN on one page. `null` = every
  // starting page. Cleared automatically below if the picked page falls out
  // of the current data (a month switch, say) rather than silently filtering
  // to nothing with no visible reason why.
  const [startFilter, setStartFilter] = useState<string | null>(null);

  // Distinct starting pages across ALL sequences (not just the rendered top
  // few), so the picker offers every entry point a visitor took, even minor
  // ones. Summed by session count so it reads as "N visitors began here".
  const startingPages = useMemo(() => {
    const totals = new Map<string, number>();
    for (const seq of sequences?.sequences ?? []) {
      if (seq.sessions <= 0 || seq.sequence.length === 0) continue;
      const start = seq.sequence[0];
      totals.set(start, (totals.get(start) ?? 0) + seq.sessions);
    }
    return Array.from(totals.entries())
      .map(([path, sessionCount]) => ({ path, sessions: sessionCount }))
      .sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path));
  }, [sequences]);

  const effectiveStartFilter = useMemo(() => {
    if (startFilter && !startingPages.some((p) => p.path === startFilter)) return null;
    return startFilter;
  }, [startFilter, startingPages]);

  const { preViz, postViz, effVBH, centerY, preAllSessions, postAllSessions, postOrphans } =
    useMemo(() => {
      const rawSequences = (sequences?.sequences ?? []).filter(
        (s) => effectiveStartFilter == null || s.sequence[0] === effectiveStartFilter,
      );
      const preInputs = rawSequences.map((s) => ({ paths: s.sequence, sessions: s.sessions }));
      const preRoot = buildTrie(preInputs, 'pre-root');
      pruneToMaxLeaves(preRoot, maxFlows);
      const preLayout = layoutTrie(preRoot, 'pre', CHAIN_START_X, CHAIN_END_X, V_MARGIN);

      const postInputs = rawSequences
        .filter((s) => (s.post_sequence?.length ?? 0) > 0)
        .map((s) => ({
          paths: s.post_sequence ?? [],
          sessions: s.post_sessions ?? s.sessions,
        }));
      const postRoot = buildTrie(postInputs, 'post-root');
      pruneToMaxLeaves(postRoot, maxFlows);
      const postLayout = layoutTrie(postRoot, 'post', POST_CHAIN_START_X, POST_CHAIN_END_X, V_MARGIN);

      const maxH = Math.max(preLayout.height, postLayout.height);
      const effH = Math.max(VB_H_BASE, maxH + V_MARGIN * 2);
      const cY = effH / 2;

      // Post-nodes that have no incoming edge inside postViz
      const postTargetIds = new Set(postLayout.edges.map((e) => e.toNodeId));
      const orphans = postLayout.nodes.filter((n) => !postTargetIds.has(n.id));

      // The population `strokeFor` scales against must include the LEAF/ORPHAN
      // connectors, not just internal trie edges. A trie built entirely from
      // single-page journeys (every pre-sequence is one page, e.g. "/" alone)
      // has zero internal edges — every leaf sits at depth 0, directly off the
      // unrendered root — so scaling from `edges` alone left `strokeFor` with
      // an empty population, which returns 0 for every leaf connector
      // regardless of its own session count. Every leaf/orphan card then
      // rendered with no visible line into the chatbot circle at all: this is
      // the "edges are missing" bug, and it is not an edge case — it is the
      // COMMON case whenever a bot's visitors mostly open chat straight from
      // one page rather than a multi-page journey.
      const preSessions = [...preLayout.edges.map((e) => e.sessions), ...preLayout.leafAnchors.map((l) => l.sessions)];
      const postSessions = [...postLayout.edges.map((e) => e.sessions), ...orphans.map((n) => n.sessions)];

      return {
        preViz: preLayout,
        postViz: postLayout,
        effVBH: effH,
        centerY: cY,
        preAllSessions: preSessions,
        postAllSessions: postSessions,
        postOrphans: orphans,
      };
    }, [sequences, effectiveStartFilter, maxFlows]);

  const handleNodeSelect = (node: TrieVizNode) => {
    setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
    if (node.startPage && isFilterableOutcome(node.startPage) && onSelectOutcome) {
      onSelectOutcome(selectedOutcome === node.startPage ? null : node.startPage);
    }
  };

  const renderSvgContent = () => (
    <>
      {/* Pre-trie edges */}
      {preViz.edges.map((edge) => {
        const base = strokeFor(edge.sessions, preAllSessions);
        if (base <= 0) return null;
        return (
          <path
            key={edge.id}
            d={curve(edge.fromX, edge.fromY, edge.toX, edge.toY)}
            stroke={TONE[edge.tone]?.line ?? TONE.gray.line}
            strokeWidth={boostForHighlight(base, false)}
            fill="none"
            strokeLinecap="round"
            opacity={0.85}
          />
        );
      })}

      {/* Pre-trie leaf -> chatbot circle connectors */}
      {(() => {
        const sorted = [...preViz.leafAnchors].sort((a, b) => a.y - b.y);
        return sorted.map((leaf, i) => {
          const chatEnd = circleEntry(i, sorted.length, centerY);
          const base = strokeFor(leaf.sessions, preAllSessions);
          if (base <= 0) return null;
          return (
            <path
              key={`preleaf-${leaf.nodeId}`}
              d={curve(leaf.x, leaf.y, chatEnd.x, chatEnd.y)}
              stroke={TONE[leaf.tone]?.line ?? TONE.gray.line}
              strokeWidth={boostForHighlight(base, false)}
              fill="none"
              strokeLinecap="round"
              opacity={0.85}
            />
          );
        });
      })()}

      {/* Chatbot -> post-side orphans */}
      {(() => {
        const sorted = [...postOrphans].sort((a, b) => a.y - b.y);
        return sorted.map((child, i) => {
          const chatStart = circleExit(i, sorted.length, centerY);
          const base = strokeFor(child.sessions, postAllSessions) || 1.5;
          return (
            <path
              key={`postorphan-${child.id}`}
              d={curve(chatStart.x, chatStart.y, child.x, child.y + CARD_H / 2)}
              stroke={TONE[child.tone]?.line ?? TONE.gray.line}
              strokeWidth={boostForHighlight(base, false)}
              fill="none"
              strokeLinecap="round"
              opacity={0.85}
            />
          );
        });
      })()}

      {/* Post-trie edges */}
      {postViz.edges.map((edge) => {
        const base = strokeFor(edge.sessions, postAllSessions);
        if (base <= 0) return null;
        return (
          <path
            key={edge.id}
            d={curve(edge.fromX, edge.fromY, edge.toX, edge.toY)}
            stroke={TONE[edge.tone]?.line ?? TONE.gray.line}
            strokeWidth={boostForHighlight(base, false)}
            fill="none"
            strokeLinecap="round"
            opacity={0.85}
          />
        );
      })}

      {/* Chatbot center circle */}
      <circle cx={CENTER.x} cy={centerY} r={CENTER.r + 8} fill="var(--color-surface-sunken)" opacity={0.55} />
      <circle
        cx={CENTER.x}
        cy={centerY}
        r={CENTER.r}
        fill="var(--color-accent-500)"
        stroke="var(--color-accent-600)"
        strokeWidth={2}
      />
      <foreignObject
        x={CENTER.x - CENTER.r}
        y={centerY - CENTER.r}
        width={CENTER.r * 2}
        height={CENTER.r * 2}
      >
        <div className="flex h-full w-full flex-col items-center justify-center text-center text-white">
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-white/15">
            <Bot aria-hidden className="h-6 w-6" strokeWidth={1.75} />
          </div>
          <p className="text-2xs font-medium leading-tight opacity-90">{center}</p>
          <p className="tabular-nums text-base font-semibold leading-tight">
            {centerValue.toLocaleString()}
          </p>
        </div>
      </foreignObject>

      {/* Every pre- and post-node: SVG chrome, then the text and the click
          target over it. Two elements rather than one because only the SVG
          half can hold a border that does not scale — see `CardChrome`. */}
      {[...preViz.nodes, ...postViz.nodes].map((node) => (
        <g key={node.id}>
          <CardChrome node={node} active={selectedNodeId === node.id} />
          <foreignObject x={node.x} y={node.y} width={node.width} height={CARD_H}>
            <button
              type="button"
              className="h-full w-full cursor-pointer border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              aria-label={`${node.path}, ${node.sessions} ${node.sessions === 1 ? 'session' : 'sessions'}`}
              aria-pressed={selectedNodeId === node.id}
              onClick={() => handleNodeSelect(node)}
            >
              <FlowCardText
                node={node}
                tooltip={node.path}
                subtitle={node.isFork ? 'merged' : undefined}
              />
            </button>
          </foreignObject>
        </g>
      ))}
    </>
  );

  // A start-page filter is active but matched zero sequences. Say so instead
  // of rendering a diagram with an empty source column, which reads as "the
  // bot stopped tracking journeys" rather than "this filter has no data".
  const filteredToNothing = effectiveStartFilter != null && preViz.nodes.length === 0;

  const headerActions = (
    <>
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="text-xs text-text-tertiary">
          {t('analytics.flows') || 'Flows'}
        </span>
        <div className="w-24">
          <Select
            size="sm"
            label={t('analytics.pageFlowsShown') || 'Page flows shown'}
            value={String(maxFlows)}
            options={flowCountOptions()}
            onValueChange={(value) => setMaxFlows(Number(value))}
          />
        </div>
      </div>
      {startingPages.length > 1 ? (
        <div className="flex items-center gap-1.5">
          <span aria-hidden className="text-xs text-text-tertiary">
            {t('analytics.startsOn') || 'Starts on'}
          </span>
          <div className="w-36">
            <Select
              size="sm"
              label={t('analytics.filterByStartingPage') || 'Filter by starting page'}
              value={effectiveStartFilter ?? ''}
              emptyOption="Any page"
              options={startingPages.map((p) => ({
                value: p.path,
                label: `${p.path} (${formatNumber(p.sessions)})`,
              }))}
              onValueChange={(value) => {
                setStartFilter(value || null);
                setSelectedNodeId(null);
              }}
            />
          </div>
        </div>
      ) : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('analytics.expandJourneyDiagram') || 'Expand journey diagram'}
        onClick={() => setExpanded(true)}
      >
        <Maximize2 aria-hidden className="h-icon-sm w-icon-sm" />
      </Button>
    </>
  );

  return (
    <Card className={cn('relative', className)}>
      <CardHeader
        title={t('analytics.visitorJourneyDiagram') || 'Visitor journey diagram'}
        description={t('analytics.interactivePathFlowsBeforeAnd') || 'Interactive path flows before and after opening chat. Thicker curves represent more visitors. Drag to pan, scroll to zoom.'}
        actions={headerActions}
      />
      {filteredToNothing ? (
        <CardBody>
          <EmptyState
            icon={Compass}
            title={t('analytics.noJourneysMatchThisFilter') || 'No journeys match this filter'}
            description={
              translateNow('analytics.noVisitorsStartingOn', { page: effectiveStartFilter }) ||
              `No visitors starting on "${effectiveStartFilter}" were tracked in this window.`
            }
            action={
              <Button variant="secondary" size="sm" onClick={() => setStartFilter(null)}>
                {t('analytics.clearFilter') || 'Clear filter'}
              </Button>
            }
          />
        </CardBody>
      ) : (
        <CardBody flush className="p-4">
          {/* Pan + wheel/keyboard-zoom right here in the card, not only
              behind the expand button — a reader with a dense diagram
              should not have to leave the page just to spread it out.

              Sized by the viewBox's own aspect rather than a fixed height:
              `preserveAspectRatio="xMidYMid meet"` fits the WHOLE viewBox
              inside the box, so a fixed 420px against a narrow container
              letterboxed hard — at a 451px-wide card the diagram drew 158px
              tall inside a 420px well, two thirds of it empty. Matching the
              aspect means the drawing is always as large as the width
              allows and there is no dead band under it. */}
          <ZoomPanCanvas
            label={t('analytics.visitorJourneyFlowDiagram') || 'Visitor journey flow diagram'}
            viewBoxWidth={VB_W}
            viewBoxHeight={effVBH}
            className="min-h-60"
            style={{ aspectRatio: `${VB_W} / ${effVBH}` }}
          >
            {renderSvgContent()}
          </ZoomPanCanvas>
        </CardBody>
      )}

      <Dialog
        open={expanded}
        onOpenChange={setExpanded}
        title={t('analytics.visitorJourneyFlowDiagram') || 'Visitor journey flow diagram'}
        description={t('analytics.arrowKeysToPanTo') || 'Arrow keys to pan · +/- to zoom · 0 to reset view'}
        size="full"
      >
        <ZoomPanCanvas
          label={t('analytics.expandedJourneyDiagram') || 'Expanded journey diagram'}
          viewBoxWidth={VB_W}
          viewBoxHeight={effVBH}
          className="h-[calc(100vh-12rem)] min-h-[420px]"
        >
          {renderSvgContent()}
        </ZoomPanCanvas>
      </Dialog>
    </Card>
  );
}
