import { useMemo, useState } from 'react';
import { Bot, Maximize2 } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  ZoomPanCanvas,
  cn,
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

const TONE: Record<ToneKey, { icon: string; tile: string; line: string }> = {
  green: { icon: '#10b981', tile: 'rgba(16, 185, 129, 0.14)', line: 'rgba(16, 185, 129, 0.55)' },
  blue: { icon: '#3b82f6', tile: 'rgba(59, 130, 246, 0.14)', line: 'rgba(59, 130, 246, 0.55)' },
  purple: { icon: '#a855f7', tile: 'rgba(168, 85, 247, 0.14)', line: 'rgba(168, 85, 247, 0.55)' },
  orange: { icon: '#f97316', tile: 'rgba(249, 115, 22, 0.14)', line: 'rgba(249, 115, 22, 0.55)' },
  red: { icon: '#ef4444', tile: 'rgba(239, 68, 68, 0.14)', line: 'rgba(239, 68, 68, 0.55)' },
  yellow: { icon: '#eab308', tile: 'rgba(234, 179, 8, 0.14)', line: 'rgba(234, 179, 8, 0.55)' },
  gray: { icon: '#94a3b8', tile: 'rgba(148, 163, 184, 0.14)', line: 'rgba(148, 163, 184, 0.55)' },
};

function FlowCard({
  node,
  active = false,
  subtitle,
  tooltip,
}: {
  node: { label: string; sessions: number; width: number; tone: ToneKey; isFork?: boolean };
  active?: boolean;
  subtitle?: string;
  tooltip?: string;
}) {
  const tone = TONE[node.tone] ?? TONE.gray;
  const compact = node.width < 80;
  const borderClass = active
    ? 'border-accent ring-2 ring-accent'
    : 'border-border';
  const showDot = !active;

  if (compact) {
    return (
      <div
        title={tooltip}
        className={cn(
          'relative flex h-full w-full flex-col items-center justify-center gap-1 rounded-xl border bg-surface-sunken px-1.5 py-1',
          borderClass,
        )}
      >
        {showDot && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: tone.icon }}
          />
        )}
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
    <div
      title={tooltip}
      className={cn(
        'relative flex h-full w-full items-center gap-3 rounded-xl border bg-surface-sunken px-3',
        borderClass,
      )}
    >
      {showDot && (
        <span
          aria-hidden
          className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: tone.icon }}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-text-secondary">{node.label}</p>
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
  centerLabel = 'Opened Chatbot',
  centerValue = 0,
  selectedOutcome,
  onSelectOutcome,
  className,
}: JourneyDiagramProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const { preViz, postViz, effVBH, centerY, preAllSessions, postAllSessions, postOrphans } =
    useMemo(() => {
      const rawSequences = sequences?.sequences ?? [];
      const preInputs = rawSequences.map((s) => ({ paths: s.sequence, sessions: s.sessions }));
      const preRoot = buildTrie(preInputs);
      pruneToMaxLeaves(preRoot, 25);
      const preLayout = layoutTrie(preRoot, 'pre', CHAIN_START_X, CHAIN_END_X, V_MARGIN);

      const postInputs = rawSequences
        .filter((s) => (s.post_sequence?.length ?? 0) > 0)
        .map((s) => ({
          paths: s.post_sequence ?? [],
          sessions: s.post_sessions ?? s.sessions,
        }));
      const postRoot = buildTrie(postInputs);
      pruneToMaxLeaves(postRoot, 25);
      const postLayout = layoutTrie(postRoot, 'post', POST_CHAIN_START_X, POST_CHAIN_END_X, V_MARGIN);

      const maxH = Math.max(preLayout.height, postLayout.height);
      const effH = Math.max(VB_H_BASE, maxH + V_MARGIN * 2);
      const cY = effH / 2;

      const preSessions = preLayout.edges.map((e) => e.sessions);
      const postSessions = postLayout.edges.map((e) => e.sessions);

      // Post-nodes that have no incoming edge inside postViz
      const postTargetIds = new Set(postLayout.edges.map((e) => e.toNodeId));
      const orphans = postLayout.nodes.filter((n) => !postTargetIds.has(n.id));

      return {
        preViz: preLayout,
        postViz: postLayout,
        effVBH: effH,
        centerY: cY,
        preAllSessions: preSessions,
        postAllSessions: postSessions,
        postOrphans: orphans,
      };
    }, [sequences]);

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
        fill="var(--color-accent)"
        stroke="var(--color-accent-hover)"
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
          <p className="text-2xs font-medium leading-tight opacity-90">{centerLabel}</p>
          <p className="tabular-nums text-base font-semibold leading-tight">
            {centerValue.toLocaleString()}
          </p>
        </div>
      </foreignObject>

      {/* All pre and post nodes as accessible buttons inside foreignObject */}
      {[...preViz.nodes, ...postViz.nodes].map((node) => (
        <foreignObject
          key={node.id}
          x={node.x}
          y={node.y}
          width={node.width}
          height={CARD_H}
        >
          <button
            type="button"
            className="h-full w-full cursor-pointer rounded-xl border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={`${node.path}, ${node.sessions} ${node.sessions === 1 ? 'session' : 'sessions'}`}
            aria-pressed={selectedNodeId === node.id}
            onClick={() => handleNodeSelect(node)}
          >
            <FlowCard
              node={node}
              active={selectedNodeId === node.id}
              tooltip={node.path}
              subtitle={node.isFork ? 'merged' : undefined}
            />
          </button>
        </foreignObject>
      ))}
    </>
  );

  return (
    <Card className={cn('relative', className)}>
      <CardHeader
        title="Visitor journey diagram"
        description="Interactive path flows before and after opening chat. Thicker curves represent more visitors."
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Expand journey diagram"
            onClick={() => setExpanded(true)}
          >
            <Maximize2 aria-hidden className="h-icon-sm w-icon-sm" />
          </Button>
        }
      />
      <CardBody flush className="overflow-x-auto p-4">
        <svg
          role="img"
          aria-label="Visitor journey flow diagram"
          viewBox={`0 0 ${VB_W} ${effVBH}`}
          className="block h-auto w-full min-w-[700px] select-none"
        >
          {renderSvgContent()}
        </svg>
      </CardBody>

      <Dialog
        open={expanded}
        onOpenChange={setExpanded}
        title="Visitor journey flow diagram"
        description="Arrow keys to pan · +/- to zoom · 0 to reset view"
        size="full"
      >
        <ZoomPanCanvas
          label="Expanded journey diagram"
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
