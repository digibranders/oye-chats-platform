import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  Calendar,
  Compass,
  FileText,
  Filter,
  HelpCircle,
  Home,
  LayoutGrid,
  LogOut,
  Mail,
  Maximize2,
  MessageCircle,
  Package,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Star,
  ZoomIn,
  ZoomOut,
  Tag,
  TriangleAlert,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  EmptyState,
  LockedFeatureCard,
  Modal,
  Skeleton,
} from '../../design-system';
import { useJourneyAnalytics, type JourneyAnalytics } from './useJourneyAnalytics';

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

// ── Layout constants ────────────────────────────────────────────────────────
// VB_W stretched to 1200 (was 820) so each row can render the
// visitor's full journey — pre-chain → chatbot → post-chain →
// outcome column — inline, matching how the DB stores it. Card view
// still fills the container thanks to preserveAspectRatio; long
// diagrams pan/zoom inside the canvas.
//
// VB_H is the BASE height and grows dynamically per render when more
// sequence rows would otherwise cram into it. See computeEffectiveVBH()
// below.
const VB_W = 1200;
const VB_H_BASE = 420;
const CARD_W = 156;
const CARD_H = 64;
/** Minimum vertical gap between two source rows / two destination cards. */
const ROW_MIN_GAP = 22;
/** Top/bottom padding inside the SVG so cards don't kiss the frame. */
const V_MARGIN = 20;

/**
 * Grow VB_H when N rows won't fit at the ROW_MIN_GAP spacing budget
 * inside VB_H_BASE. Returns VB_H_BASE for small row counts so short
 * diagrams stay compact; grows monotonically as row count rises.
 */
function computeEffectiveVBH(rowCount: number): number {
  if (rowCount <= 1) return VB_H_BASE;
  const needed = V_MARGIN * 2 + rowCount * CARD_H + (rowCount - 1) * ROW_MIN_GAP;
  return Math.max(VB_H_BASE, needed);
}
// Chatbot sits in the middle of the widened viewport: enough breathing
// space either side for the pre-chat chain (24 → 410) on the left and
// the post-chat chain (595 → 950) on the right, before the outcome
// column (990 → 1146).
const CENTER = { x: 495, y: 210, r: 68 };

interface FlowNode {
  id: string;
  label: string;
  value: number;
  tone: ToneKey;
  icon: LucideIcon;
  x: number;
  y: number;
  /** Width of this card in viewBox units. Chain cards shrink to fit
   *  their row; destinations stay at CARD_W. */
  width: number;
  /** Only set for destinations. */
  pct?: number;
}

/**
 * Trie-based visualization: shared page prefixes render as ONE node
 * that forks into branches, instead of drawing the same page (e.g. `/`)
 * as N separate cards stacked vertically. This is a truer picture of
 * the flow — a real branching journey rather than parallel strips —
 * and matches how a Sankey should read.
 *
 * A `TrieVizNode` carries its ready-to-render geometry (x/y/width),
 * the summed sessions passing through it, and the highlight set —
 * every node id that stays lit when this node is clicked (its
 * ancestors AND descendants, i.e. the full flow the visitor took).
 */
interface TrieVizNode {
  id: string;
  path: string;
  label: string;
  /** Sum of sessions passing through this node (through its subtree). */
  sessions: number;
  /** True if this node forks into more than one child — used to hint
   *  the reader that the count aggregates several downstream branches. */
  isFork: boolean;
  tone: ToneKey;
  icon: LucideIcon;
  x: number;
  y: number;
  width: number;
  /** 0 for a root child, 1 for its child, etc. Exposed on the viz
   *  node so the render pass can identify root children reliably —
   *  parsing IDs to detect depth is fragile (a URL path could
   *  contain `>`) and this is O(1). */
  depth: number;
  /** Global indices of source sequences whose flow passes through
   *  this node. Set-membership across both pre- and post-tries is
   *  how "click a pre-node, light the corresponding post-nodes"
   *  works — two nodes are on the same flow iff they share a
   *  sequence index. */
  seqIndices: ReadonlySet<number>;
  side: 'pre' | 'post';
  /** Starting page (depth-0 ancestor path) of this node's branch. Only
   *  meaningful pre-side: clicking a pre node filters the diagram to the
   *  journeys that began on this page, mirroring an outcome click. */
  startPage?: string;
}

interface TrieVizEdge {
  id: string;
  /** Parent + child node ids — an edge is "on-flow" for a selection
   *  when BOTH endpoints are in the current highlight set. */
  fromNodeId: string;
  toNodeId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Sessions represented by this edge — the child's session sum.
   *  Wider edges = more visitors take this branch. */
  sessions: number;
  tone: ToneKey;
  side: 'pre' | 'post';
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

// Source-row layout: each row = one common pre-chat SEQUENCE. Cards
// chain right into the chatbot: page1 → page2 → ... → chatbot. Card
// width is computed per row via chainCardWidth() so a 3-page journey
// gets fat cards while an 8-page journey gets slim cards — everything
// still fits inside the source area (24 → 410px).
const CHAIN_GAP = 15;
const CHAIN_START_X = 24;
const CHAIN_END_X = 410; // just before the chatbot circle
const CHAIN_MIN_CARD_W = 44; // don't shrink below icon-plus-text
const CHAIN_MAX_CARD_W = 156; // don't grow past the destination CARD_W
const MAX_CHAIN_LEN = 8;

// Post-chat chain lives to the RIGHT of the chatbot, mirroring the
// pre-chat chain on the left. Each source row grows its own post-chain
// (up to MAX_POST_CHAIN_LEN cards) using the same row tone, so the
// visitor's full journey — pages seen, then chatbot, then pages seen
// after — reads as one continuous flow.
const POST_CHAIN_START_X = 595;
const POST_CHAIN_END_X = 950;
const MAX_POST_CHAIN_LEN = 6;
/**
 * Vertical distribution of N cards inside a viewport of height ``vbH``.
 * Returns the top-Y of each card. Uses even center-distribution when
 * there's slack, falls back to fixed-gap packing when the cards would
 * otherwise crowd each other under ROW_MIN_GAP.
 */
function distributeRows(vbH: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [vbH / 2 - CARD_H / 2];
  const evenCenterGap = vbH / (count + 1);
  if (evenCenterGap - CARD_H >= ROW_MIN_GAP) {
    // Comfortable — use even center distribution (nicer visually).
    return Array.from({ length: count }, (_, i) => (vbH * (i + 1)) / (count + 1) - CARD_H / 2);
  }
  // Tight — fall back to fixed ROW_MIN_GAP spacing, centered vertically.
  const totalH = count * CARD_H + (count - 1) * ROW_MIN_GAP;
  const startY = Math.max(V_MARGIN, (vbH - totalH) / 2);
  return Array.from({ length: count }, (_, i) => startY + i * (CARD_H + ROW_MIN_GAP));
}

// Static conversion + exit destinations. The right-side per-row
// post-chain (drawn between the chatbot and this column) is built
// from `preChatSequences.sequences[].post_sequence`; this column
// stays focused on final outcomes so the diagram doesn't conflate
// "kept browsing on the site" with "converted / dropped off".
const CONVERSION_DESTINATIONS = [
  { id: 'meeting_booked', label: 'Book Meeting', tone: 'green' as const, icon: Calendar },
  { id: 'handoff_requested', label: 'Live Chat', tone: 'orange' as const, icon: MessageCircle },
  { id: 'offline_message_sent', label: 'Offline Message', tone: 'purple' as const, icon: Mail },
];
const EXIT_DESTINATION = { id: 'exit', label: 'Drop-off / Exit', tone: 'gray' as const, icon: LogOut };

const DEST_COLUMN_X = 990;

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
/** Minimum stroke width when a line is on the currently-selected
 *  flow. Above the base MIN_STROKE so the highlighted path stays
 *  clearly readable even for a 1-visitor branch (which would
 *  otherwise render as a barely-visible 1.5px hairline). */
const HIGHLIGHT_MIN_STROKE = 3;

function strokeFor(value: number, allValues: readonly number[]): number {
  const positive = allValues.filter((v) => v > 0);
  if (value <= 0 || positive.length === 0) return 0;
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  if (max === min) return (MIN_STROKE + MAX_STROKE) / 2;
  const t = (value - min) / (max - min);
  return MIN_STROKE + t * (MAX_STROKE - MIN_STROKE);
}

/** Wrap the natural stroke width so a highlighted line never falls
 *  under HIGHLIGHT_MIN_STROKE. Called by every connector-render site
 *  when it knows the line is on-flow for the current selection. */
function boostForHighlight(base: number, highlighted: boolean): number {
  if (!highlighted) return base;
  return Math.max(base, HIGHLIGHT_MIN_STROKE);
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function cardLeft(node: FlowNode): { x: number; y: number } {
  return { x: node.x, y: node.y + CARD_H / 2 };
}
// The chatbot circle is painted on top of the source/destination lines,
// so if line endpoints sit exactly on the circle boundary the slim
// round line-caps get masked by the circle fill and the line reads as
// floating in space. Overshooting the endpoint 6px into the circle
// lets the line visibly cross the boundary before it's clipped by the
// circle — a clean visual "landing".
const CIRCLE_ANCHOR_OVERSHOOT = 6;

function circleEntry(index: number, count: number, centerY: number): { x: number; y: number } {
  const angle = -70 + (140 * index) / Math.max(count - 1, 1);
  const rad = (angle * Math.PI) / 180;
  const r = CENTER.r - CIRCLE_ANCHOR_OVERSHOOT;
  return { x: CENTER.x - r * Math.cos(rad), y: centerY + r * Math.sin(rad) };
}
function circleExit(index: number, count: number, centerY: number): { x: number; y: number } {
  const angle = -70 + (140 * index) / Math.max(count - 1, 1);
  const rad = (angle * Math.PI) / 180;
  const r = CENTER.r - CIRCLE_ANCHOR_OVERSHOOT;
  return { x: CENTER.x + r * Math.cos(rad), y: centerY + r * Math.sin(rad) };
}

// ── Trie build + layout ───────────────────────────────────────────────────
//
// Sequences arrive as N flat rows, but visitor journeys are actually a
// TREE — many visitors share early hops before diverging. Rendering the
// tree directly means a shared `/` shows once (with the summed count)
// and forks into the branches that diverged from it, matching how a
// real Sankey reads. This section builds and lays out that tree.

/** Cap the visible leaf count so the diagram doesn't explode. Matches
 *  the previous MAX_SEQUENCE_ROWS: 6 distinct end-to-end journeys max. */
const TRIE_MAX_LEAVES = 6;
/** Cap the depth we merge shared prefixes to. Trie always renders at
 *  most this many columns; deeper hops are truncated (backend already
 *  caps sequences at 8 pages, so this is a safety net not an active
 *  clip in most cases). */
const TRIE_MAX_DEPTH = 8;
/** Vertical space per leaf slot: card height + minimum gap. */
const TRIE_LEAF_H = CARD_H + ROW_MIN_GAP;

interface TrieBuildNode {
  id: string;
  path: string;
  sessions: number;
  depth: number;
  parent: TrieBuildNode | null;
  children: Map<string, TrieBuildNode>;
  /** Preserve first-seen sibling order for stable palette assignment
   *  even across re-renders and polls with tied counts. */
  order: number;
  /** Indices (into the caller's source-sequence array) of every
   *  sequence that walked through this node. Used to correlate
   *  pre- and post-tries: two nodes are on the same visitor flow
   *  iff their seqIndices sets intersect. */
  seqIndices: Set<number>;
}

/**
 * Insert an ordered list of paths (one visitor sequence) into a trie
 * rooted at ``root``, incrementing session counts and recording
 * ``seqIndex`` on every node along the walk (including root).
 * Recording on the root as well means "click the root" would light
 * every sequence — but the root is never rendered, so this is only
 * used to keep the invariant "every node passed through by seqIndex
 * contains seqIndex in its set" true even after pruning.
 */
function insertPath(
  root: TrieBuildNode,
  paths: readonly string[],
  sessions: number,
  seqIndex: number,
): void {
  let node = root;
  root.sessions += sessions;
  root.seqIndices.add(seqIndex);
  const stop = Math.min(paths.length, TRIE_MAX_DEPTH);
  for (let i = 0; i < stop; i++) {
    const path = paths[i];
    let child = node.children.get(path);
    if (!child) {
      child = {
        id: `${node.id}>${path}`,
        path,
        sessions: 0,
        depth: i,
        parent: node,
        children: new Map(),
        order: node.children.size,
        seqIndices: new Set(),
      };
      node.children.set(path, child);
    }
    child.sessions += sessions;
    child.seqIndices.add(seqIndex);
    node = child;
  }
}

/**
 * Trim the trie so at most ``maxLeaves`` distinct root-to-leaf paths
 * remain. Pruning is done by repeatedly dropping the lowest-count leaf
 * and folding its sessions back into its parent's own count (the
 * parent becomes a leaf if it loses its last child). This preserves
 * the honest "sessions through this node" invariant on survivors.
 */
function pruneToMaxLeaves(root: TrieBuildNode, maxLeaves: number): void {
  const leaves = (): TrieBuildNode[] => {
    const out: TrieBuildNode[] = [];
    const walk = (n: TrieBuildNode): void => {
      if (n.children.size === 0) {
        if (n !== root) out.push(n);
        return;
      }
      for (const c of n.children.values()) walk(c);
    };
    walk(root);
    return out;
  };
  while (true) {
    const ls = leaves();
    if (ls.length <= maxLeaves) return;
    // Drop the least-trafficked leaf; on ties, the one with the
    // longest path (deepest tail) — that's the noisiest end to remove.
    ls.sort((a, b) => a.sessions - b.sessions || b.depth - a.depth);
    const victim = ls[0];
    const parent = victim.parent;
    if (!parent) return;
    parent.children.delete(victim.path);
    // Sessions stay attributed to the parent — the visitor did pass
    // through the parent, we just no longer render the specific tail.
  }
}

interface TrieVisual {
  nodes: TrieVizNode[];
  edges: TrieVizEdge[];
  /** Ends of leaf branches — used to draw the final curves that land
   *  on the chatbot circle (pre) or emanate from it (post). Ordered
   *  top-to-bottom so `circleEntry/Exit` distributes the anchors. */
  leafAnchors: Array<{ nodeId: string; x: number; y: number; sessions: number; tone: ToneKey }>;
  /** Total vertical space consumed. Feeds computeEffectiveVBH. */
  height: number;
}

/**
 * Layout a built trie horizontally with root on the anchored side.
 * ``side='pre'`` places root-column nodes at ``xStart`` and grows
 * rightward toward ``xEnd`` (where leaves land near the chatbot).
 * ``side='post'`` mirrors — root-column nodes at ``xEnd``, growing
 * leftward toward ``xStart``… actually no: for post-chain the ROOT
 * of the trie is the "first page the visitor saw after chat", which
 * should sit LEFT (adjacent to the chatbot). So both sides layout
 * root-on-anchor-side.
 */
function layoutTrie(
  root: TrieBuildNode,
  side: 'pre' | 'post',
  xStart: number,
  xEnd: number,
  yTop: number,
): TrieVisual {
  const nodes: TrieVizNode[] = [];
  const edges: TrieVizEdge[] = [];
  const leafAnchors: TrieVisual['leafAnchors'] = [];

  // Column width: divide the horizontal band across the trie depth.
  const maxDepth = (function findMax(n: TrieBuildNode): number {
    if (n.children.size === 0) return n.depth;
    let m = n.depth;
    for (const c of n.children.values()) m = Math.max(m, findMax(c));
    return m;
  })(root);
  const cols = Math.max(1, maxDepth + 1);
  const colW = (xEnd - xStart) / cols;
  const cardW = Math.max(CHAIN_MIN_CARD_W, Math.min(CHAIN_MAX_CARD_W, colW - CHAIN_GAP));

  // Palette walk: each node's tone is its FORK branch tone.
  // Root's children start the palette; when a node has multiple
  // children, each child gets a new palette slot; single-child chains
  // inherit their parent's tone so a linear stretch reads as one path.
  const toneOf = new Map<string, ToneKey>();
  const iconOf = new Map<string, LucideIcon>();
  const paint = (n: TrieBuildNode, inheritedTone: ToneKey, inheritedIcon: LucideIcon): void => {
    toneOf.set(n.id, inheritedTone);
    iconOf.set(n.id, inheritedIcon);
    const kids = Array.from(n.children.values()).sort((a, b) => a.order - b.order);
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      // A fork resets the palette per branch; a single-child chain
      // keeps its parent's tone/icon.
      const style =
        kids.length > 1
          ? SOURCE_STYLES[(i + n.depth + 1) % SOURCE_STYLES.length]
          : { tone: inheritedTone, icon: inheritedIcon };
      paint(kid, style.tone, style.icon);
    }
  };
  const rootStyle = SOURCE_STYLES[0];
  paint(root, rootStyle.tone, rootStyle.icon);

  // Starting page of a node's branch: walk up to the depth-0 ancestor.
  // Every sequence passing through a node shares its prefix, so this is
  // the single page their journey began on — the value a pre-node click
  // filters by.
  const rootPageOf = (bn: TrieBuildNode): string => {
    let c = bn;
    while (c.parent && c.depth > 0) c = c.parent;
    return c.path;
  };

  // Recursively assign vertical positions using leaf-count weighting:
  // each subtree occupies vertical space proportional to its leaves.
  let cursorSlot = 0;
  const place = (n: TrieBuildNode): { yCenter: number } => {
    if (n.children.size === 0) {
      const y = yTop + cursorSlot * TRIE_LEAF_H;
      cursorSlot += 1;
      const yCenter = y + CARD_H / 2;
      if (n !== root) {
        // Both sides lay out root-column at xStart, growing rightward
// with depth. For pre-side that means root at left edge, leaves
// (deepest) closest to the chatbot. For post-side the root
// column now sits right next to the chatbot (short connector),
// and deeper post-hops extend rightward toward the outcomes
// column — so the whole diagram reads left-to-right in time.
const x = xStart + n.depth * colW;
        const tone = toneOf.get(n.id) ?? rootStyle.tone;
        const icon = iconOf.get(n.id) ?? rootStyle.icon;
        const cardX = clampCard(x, cardW);
        const labelMax = Math.max(6, Math.floor(cardW / 7));
        nodes.push({
          id: n.id,
          path: n.path,
          label: displayPath(n.path, labelMax),
          sessions: n.sessions,
          isFork: false,
          tone,
          icon,
          x: cardX,
          y,
          width: cardW,
          depth: n.depth,
          seqIndices: n.seqIndices,
          side,
          startPage: rootPageOf(n),
        });
        // Leaf anchor: right edge of the card (both sides). Only the
        // pre-side actually renders these anchors as chatbot
        // connectors — post-side leaves are tree tails that just end
        // where their card sits.
        const anchorX = cardX + cardW;
        leafAnchors.push({ nodeId: n.id, x: anchorX, y: yCenter, sessions: n.sessions, tone });
      }
      return { yCenter };
    }
    const kids = Array.from(n.children.values()).sort((a, b) => a.order - b.order);
    const kidCenters: number[] = [];
    for (const k of kids) kidCenters.push(place(k).yCenter);
    const yCenter = (kidCenters[0] + kidCenters[kidCenters.length - 1]) / 2;
    if (n !== root) {
      const y = yCenter - CARD_H / 2;
      // Both sides lay out root-column at xStart, growing rightward
// with depth. For pre-side that means root at left edge, leaves
// (deepest) closest to the chatbot. For post-side the root
// column now sits right next to the chatbot (short connector),
// and deeper post-hops extend rightward toward the outcomes
// column — so the whole diagram reads left-to-right in time.
const x = xStart + n.depth * colW;
      const cardX = clampCard(x, cardW);
      const labelMax = Math.max(6, Math.floor(cardW / 7));
      const tone = toneOf.get(n.id) ?? rootStyle.tone;
      const icon = iconOf.get(n.id) ?? rootStyle.icon;
      nodes.push({
        id: n.id,
        path: n.path,
        label: displayPath(n.path, labelMax),
        sessions: n.sessions,
        isFork: kids.length > 1,
        tone,
        icon,
        x: cardX,
        y,
        width: cardW,
        depth: n.depth,
        seqIndices: n.seqIndices,
        side,
        startPage: rootPageOf(n),
      });
    }
    return { yCenter };
  };
  place(root);

  // Build edges parent→child, using the stored positions.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const walkEdges = (n: TrieBuildNode): void => {
    for (const kid of n.children.values()) {
      if (n !== root) {
        const p = nodeById.get(n.id);
        const c = nodeById.get(kid.id);
        if (p && c) {
          // Both sides render left-to-right, so every edge exits
          // the parent's right side and enters the child's left side.
          const fromX = p.x + p.width;
          const fromY = p.y + CARD_H / 2;
          const toX = c.x;
          const toY = c.y + CARD_H / 2;
          edges.push({
            id: `edge-${n.id}->${kid.id}`,
            fromNodeId: n.id,
            toNodeId: kid.id,
            fromX,
            fromY,
            toX,
            toY,
            sessions: kid.sessions,
            tone: nodeById.get(kid.id)?.tone ?? rootStyle.tone,
            side,
          });
        }
      }
      walkEdges(kid);
    }
  };
  walkEdges(root);

  const height = Math.max(CARD_H, cursorSlot * TRIE_LEAF_H);
  return { nodes, edges, leafAnchors, height };
}

/** Ensure a card sits fully inside its horizontal band. */
function clampCard(x: number, w: number): number {
  return Math.max(CHAIN_START_X, Math.min(POST_CHAIN_END_X - w, x));
}

/** Join a page-path sequence into a stable comparison key. */
function sequenceKey(sequence: readonly string[]): string {
  return sequence.join('␟');
}

/**
 * Drop-off approximation. The backend attributes conversions per positive
 * outcome (Meeting / Live Chat / Offline) but does NOT attribute drop-off, so we
 * derive it: the pre-chat journeys that reached the bot from a tracked page but
 * are not present in ANY positive-outcome path set. Set subtraction is by
 * full-sequence key; a journey not matched to a conversion stays in (erring
 * toward showing it rather than hiding it). This is why clicking "Drop-off /
 * Exit" now surfaces the un-converted journeys instead of an empty diagram - the
 * old heuristic ("empty post_sequence") conflated "didn't browse further" with
 * "dropped off" and almost always matched nothing.
 */
function dropOffSequences(
  data: JourneyAnalytics,
): JourneyAnalytics['preChatSequences']['sequences'] {
  const converted = new Set<string>();
  for (const key of Object.keys(data.conversionPaths) as Array<
    keyof JourneyAnalytics['conversionPaths']
  >) {
    for (const path of data.conversionPaths[key]?.paths ?? []) {
      converted.add(sequenceKey(path.sequence));
    }
  }
  return data.preChatSequences.sequences.filter(
    (seq) => !converted.has(sequenceKey(seq.sequence)),
  );
}

// ── UI ─────────────────────────────────────────────────────────────────────

export interface UserJourneyFlowProps {
  botId: number | null;
}

export function UserJourneyFlow({ botId }: UserJourneyFlowProps): ReactElement {
  const { status, data, error, refreshing, reload, lastUpdatedAt } = useJourneyAnalytics(botId);
  const [zoomOpen, setZoomOpen] = useState(false);
  // Click a row to focus it — that row stays at full opacity, everything
  // else (other rows, destinations, chatbot circle stays visible) dims
  // so the eye can follow the visitor's full pre → chat → post path.
  // Click the same row again or the SVG background to clear.
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const otherOpacity = (): number => (selectedRowId == null ? 1 : 0.15);
  const toggleRow = (rowId: string): void =>
    setSelectedRowId((prev) => (prev === rowId ? null : rowId));
  // Filter by "starting page" — the first page of a pre-chat sequence,
  // i.e. where the visitor's journey to chat began. `null` = show all.
  // Picking a page filters the rows in the diagram to only those whose
  // pre-chain starts on it. Cleared when the agent or period changes.
  const [startFilter, setStartFilter] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  // Filter by OUTCOME — clicking a destination card (Meeting / Live
  // Chat / Offline / Drop-off) narrows the diagram to pre-chat
  // sequences that actually led to that outcome. Backend already
  // returns this attribution for the 3 conversion types via
  // `conversionPaths`; drop-off is derived client-side as sequences
  // with no post-chat activity (best available proxy — a truly
  // per-session drop-off attribution would need a new backend field).
  type OutcomeFilter =
    | 'meeting_booked'
    | 'handoff_requested'
    | 'offline_message_sent'
    | 'exit';
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter | null>(null);
  // Reset filters + selection when the agent changes. Uses the
  // "derived state during render" pattern (a prev-value shadow state)
  // instead of a `useEffect(setState, [botId])` — the latter runs an
  // extra render pass and is flagged by React Compiler as a cascading
  // render. See react.dev's "You Might Not Need an Effect" doc.
  const [prevBotId, setPrevBotId] = useState(botId);
  if (prevBotId !== botId) {
    setPrevBotId(botId);
    setStartFilter(null);
    setOutcomeFilter(null);
    setSelectedRowId(null);
  }
  // Rerender the "Updated Xs ago" label once a second so it stays honest
  // between polls. Cheap — the whole component is already re-rendering
  // on every hook update anyway.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const freshnessLabel = useMemo(() => {
    if (lastUpdatedAt == null) return null;
    const secs = Math.max(0, Math.round((nowTick - lastUpdatedAt) / 1_000));
    if (secs < 5) return 'Updated just now';
    if (secs < 60) return `Updated ${secs}s ago`;
    const mins = Math.round(secs / 60);
    return `Updated ${mins}m ago`;
  }, [lastUpdatedAt, nowTick]);

  // Distinct "starting pages" — the FIRST page of each pre-chat
  // sequence, aggregated across ALL sequences (not just the top 6
  // rendered rows) so the filter picker exposes every entry point a
  // visitor took, even minor ones. Sessions are summed per starting
  // page so the dropdown reads as "N visitors began here". When an
  // outcome filter is active, the dropdown reflects only the entry
  // pages of visitors that reached that outcome.
  const startingPages = useMemo(() => {
    if (!data) return [] as Array<{ path: string; sessions: number }>;
    const totals = new Map<string, number>();
    interface Src {
      sequence: readonly string[];
      sessions: number;
      post_sequence?: readonly string[];
    }
    let src: readonly Src[];
    if (outcomeFilter && outcomeFilter !== 'exit') {
      src = data.conversionPaths[outcomeFilter]?.paths ?? [];
    } else if (outcomeFilter === 'exit') {
      src = dropOffSequences(data);
    } else {
      src = data.preChatSequences.sequences;
    }
    for (const seq of src) {
      if (seq.sessions <= 0 || seq.sequence.length === 0) continue;
      const start = seq.sequence[0];
      totals.set(start, (totals.get(start) ?? 0) + seq.sessions);
    }
    return Array.from(totals.entries())
      .map(([path, sessions]) => ({ path, sessions }))
      .sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path));
  }, [data, outcomeFilter]);

  // If the selected filter refers to a page that no longer appears in
  // the fresh payload (e.g. the period changed or the poll dropped it),
  // treat the filter as cleared for downstream code. Derived here
  // instead of via a setState-in-effect so React Compiler doesn't
  // flag a cascading render. The stale `startFilter` state stays in
  // place until the user picks something new — cheap and invisible.
  const effectiveStartFilter = useMemo(() => {
    if (startFilter && !startingPages.some((p) => p.path === startFilter)) {
      return null;
    }
    return startFilter;
  }, [startFilter, startingPages]);

  // Compose the flow shape from the analytics payload.
  const flow = useMemo(() => {
    if (!data) return null;

    // Sources: real pre-chat page SEQUENCES from the DB, chained
    // together. Each row is one common ordered pattern (e.g.
    // Home → About → Contact) that visitors travelled before
    // opening chat. The backend already collapses adjacent-duplicate
    // paths (SPA hash refires) — we deliberately DON'T global-dedupe
    // on the client, so a genuine back-nav like /a → /b → /a stays
    // readable as three stops rather than being rewritten to /a → /b.
    // Long sequences keep their tail (backend already truncates with
    // `paths[-max_seq_len:]`) since the last stop is what the visitor
    // was on when they opened chat.
    //
    // Outcome filter swaps the sequence SOURCE: when the owner asks
    // "who ended in Live Chat?" the rows must come from
    // `conversionPaths.handoff_requested.paths`, not from the general
    // pre-chat list (which is not attributed by outcome). Rows sourced
    // this way have no `post_sequence` — the visitor went straight to
    // the outcome — so the right-of-chatbot chain is naturally empty.
    // Drop-off ('exit') has no backend attribution; approximated as
    // pre-sequences with an empty post_sequence.
    interface RawSeq {
      sequence: readonly string[];
      post_sequence?: readonly string[];
      sessions: number;
      post_sessions?: number;
    }
    let source: readonly RawSeq[];
    if (outcomeFilter && outcomeFilter !== 'exit') {
      const paths = data.conversionPaths[outcomeFilter]?.paths ?? [];
      source = paths.map((p) => ({
        sequence: p.sequence,
        sessions: p.sessions,
        post_sequence: [],
        post_sessions: 0,
      }));
    } else if (outcomeFilter === 'exit') {
      source = dropOffSequences(data);
    } else {
      source = data.preChatSequences.sequences;
    }

    // `effectiveStartFilter` narrows further to sequences that BEGIN
    // on the picked page, so an owner asking "who started on
    // /pricing and then ended in Live Chat?" sees only those journeys.
    const filteredSequences = source.filter(
      (seq) =>
        seq.sessions > 0 &&
        seq.sequence.length > 0 &&
        (effectiveStartFilter == null || seq.sequence[0] === effectiveStartFilter),
    );

    // Build the pre-chat TRIE from all filtered sequences (backend
    // already caps each at max_seq_len=8). Rendering as a tree instead
    // of parallel strips means visitors who all start on `/` see one
    // shared `/` card that forks into their divergent tails — a
    // truer flow view than N stacked homepages.
    const preRoot: TrieBuildNode = {
      id: 'pre-root',
      path: '',
      sessions: 0,
      depth: -1,
      parent: null,
      children: new Map(),
      order: 0,
      seqIndices: new Set(),
    };
    filteredSequences.forEach((seq, seqIndex) => {
      const clipped = seq.sequence.slice(-MAX_CHAIN_LEN);
      insertPath(preRoot, clipped, seq.sessions, seqIndex);
    });
    pruneToMaxLeaves(preRoot, TRIE_MAX_LEAVES);

    // Build the post-chat TRIE from the SAME filtered sequences.
    // Post-cards carry the WINNING continuation's own session count
    // (`seq.post_sessions`); when the backend didn't send that field
    // (older API) we fall back to `seq.sessions` as a soft upper
    // bound. Sequences with no post-continuation contribute nothing
    // to the post-trie — they'll route to the destinations column.
    const postRoot: TrieBuildNode = {
      id: 'post-root',
      path: '',
      sessions: 0,
      depth: -1,
      parent: null,
      children: new Map(),
      order: 0,
      seqIndices: new Set(),
    };
    // seqIndex must match the pre-trie's — that's the shared key
    // that lets us correlate "this pre-node's sequences" with
    // "this post-node's sequences" for cross-side highlighting.
    filteredSequences.forEach((seq, seqIndex) => {
      const rawPost = seq.post_sequence ?? [];
      if (rawPost.length === 0) return;
      const postClipped = rawPost.slice(-MAX_POST_CHAIN_LEN);
      const postValue =
        typeof seq.post_sessions === 'number' ? seq.post_sessions : seq.sessions;
      insertPath(postRoot, postClipped, postValue, seqIndex);
    });
    pruneToMaxLeaves(postRoot, TRIE_MAX_LEAVES);

    // Effective viewBox height grows with the number of leaf slots in
    // the widest side (pre or post). computeEffectiveVBH keeps the
    // base minimum, so short diagrams stay compact.
    const leafCountOf = (n: TrieBuildNode): number => {
      if (n.children.size === 0) return n === preRoot || n === postRoot ? 0 : 1;
      let sum = 0;
      for (const c of n.children.values()) sum += leafCountOf(c);
      return sum;
    };
    const preLeaves = leafCountOf(preRoot);
    const postLeaves = leafCountOf(postRoot);
    const effVBH = computeEffectiveVBH(Math.max(preLeaves, postLeaves, 1));
    const effCenterY = effVBH / 2;

    // Vertically centre the trie band in the viewport. Each side gets
    // its own y-offset so a lopsided tree (many pre leaves, few post)
    // still has both sides centered around the chatbot circle.
    const preHeight = Math.max(1, preLeaves) * TRIE_LEAF_H;
    const postHeight = Math.max(1, postLeaves) * TRIE_LEAF_H;
    const preTopY = Math.max(V_MARGIN, (effVBH - preHeight) / 2);
    const postTopY = Math.max(V_MARGIN, (effVBH - postHeight) / 2);

    const preViz = layoutTrie(preRoot, 'pre', CHAIN_START_X, CHAIN_END_X, preTopY);
    const postViz = layoutTrie(postRoot, 'post', POST_CHAIN_START_X, POST_CHAIN_END_X, postTopY);

    // Cross-side highlight map. For every node (pre OR post), compute
    // the union of node IDs — on EITHER side — that share at least one
    // source sequence with it. Clicking a pre-`/pricing` therefore
    // lights the post-nodes that pricing's visitors continued through,
    // and vice versa. Same-side ancestors/descendants come for free
    // because they always share seq indices with the clicked node
    // (ancestors are supersets; descendants are subsets).
    const allNodes = [...preViz.nodes, ...postViz.nodes];
    const nodesBySeq = new Map<number, string[]>();
    for (const node of allNodes) {
      for (const idx of node.seqIndices) {
        const arr = nodesBySeq.get(idx);
        if (arr) arr.push(node.id);
        else nodesBySeq.set(idx, [node.id]);
      }
    }
    const crossHighlight = new Map<string, ReadonlySet<string>>();
    for (const node of allNodes) {
      const set = new Set<string>();
      for (const idx of node.seqIndices) {
        const others = nodesBySeq.get(idx);
        if (!others) continue;
        for (const nid of others) set.add(nid);
      }
      crossHighlight.set(node.id, set);
    }

    // Destinations breakdown:
    //  - Three conversion slots from summary_counts (Book Meeting /
    //    Live Chat / Offline Message).
    //  - Drop-off / Exit — sessions that opened chat but did nothing:
    //    no conversion event AND no post-chat page. The backend now
    //    returns this count directly (`sessions_no_activity`), which
    //    avoids the previous bug where subtracting conversions +
    //    post-chat activity from total double-counted any session
    //    that both converted AND kept browsing. Older API builds
    //    without the field fall back to the subtraction; drop-off
    //    may then read low but is still clamped ≥ 0.
    const conversions =
      data.summary.meeting_booked + data.summary.handoff_requested + data.summary.offline_message_sent;
    const dropoff =
      typeof data.summary.sessions_no_activity === 'number'
        ? data.summary.sessions_no_activity
        : Math.max(
            0,
            data.summary.sessions_with_journey -
              conversions -
              data.postChat.sessions_with_post_chat_activity,
          );
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
      {
        id: EXIT_DESTINATION.id,
        label: EXIT_DESTINATION.label,
        tone: EXIT_DESTINATION.tone,
        icon: EXIT_DESTINATION.icon,
        value: dropoff,
      },
    ];

    // Only render destinations that actually happened this window. Drop
    // the zero rows and re-space the survivors along the SAME effective
    // viewBox height as sources so both columns visually align.
    const activeDests = stagedDestinations.filter((d) => d.value > 0);
    const destRowTops = distributeRows(effVBH, activeDests.length);
    const destinations: FlowNode[] = activeDests.map((d, i) => {
      return {
        id: d.id,
        label: d.label,
        tone: d.tone,
        icon: d.icon,
        x: DEST_COLUMN_X,
        y: destRowTops[i],
        width: CARD_W,
        value: d.value,
        pct: Math.round((d.value / denom) * 100),
      };
    });

    return {
      preViz,
      postViz,
      destinations,
      centerValue,
      effVBH,
      centerY: effCenterY,
      crossHighlight,
    };
  }, [data, effectiveStartFilter, outcomeFilter]);

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
  // A filter is active but matched zero rows — say so instead of
  // rendering a diagram with an empty source column (which reads as
  // "the bot is broken").
  const filterActive = effectiveStartFilter != null || outcomeFilter != null;
  if (filterActive && flow.preViz.nodes.length === 0) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-6">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">
            User Journey Flow (All Paths)
          </h3>
          <Button
            variant="secondary"
            onClick={() => {
              setStartFilter(null);
              setOutcomeFilter(null);
            }}
          >
            Clear filters
          </Button>
        </div>
        <EmptyState
          icon={Compass}
          title="No journeys match this filter"
          description={
            outcomeFilter === 'exit'
              ? `Every tracked pre-chat journey reached an outcome in this window${startFilter ? ` starting on ${startFilter}` : ''} — no drop-offs to show.`
              : outcomeFilter
                ? `No sessions ended in ${outcomeLabel(outcomeFilter)} in this window${startFilter ? ` starting on ${startFilter}` : ''}.`
                : `No sessions started on ${startFilter} in this window.`
          }
        />
      </div>
    );
  }

  // Session-count arrays for stroke-width scaling. Each side's
  // stroke arithmetic must consider BOTH internal edges AND the
  // external chatbot connectors (pre-side leaf → chatbot, post-side
  // chatbot → root-child) as one population. Otherwise, a trie
  // whose root children are all leaves (visitors with a 1-page
  // pre- or post-sequence) has zero internal edges — `strokeFor`
  // then returns 0 for the external connectors and they invisibly
  // vanish, making those nodes look disconnected from the chatbot.
  // A post-side node needs a direct chatbot connector iff it has no
  // incoming edge from another visible node — that is, either it's a
  // depth-0 root child, OR its parent was pruned away and it's now
  // effectively orphaned. Computing this from edges (not depth alone)
  // is the safety net that catches both cases.
  const postIncomingIds = new Set(flow.postViz.edges.map((e) => e.toNodeId));
  const postOrphans = flow.postViz.nodes.filter(
    (n) => n.side === 'post' && !postIncomingIds.has(n.id),
  );
  const preEdgeSessions = flow.preViz.edges.map((e) => e.sessions);
  const postEdgeSessions = flow.postViz.edges.map((e) => e.sessions);
  const preAllSessions = [
    ...preEdgeSessions,
    ...flow.preViz.leafAnchors.map((l) => l.sessions),
  ];
  const postAllSessions = [
    ...postEdgeSessions,
    ...postOrphans.map((n) => n.sessions),
  ];
  const destValues = flow.destinations.map((d) => d.value);

  // Selected NODE (not row) — clicking any trie node highlights the
  // entire visitor flow through it: same-side ancestors + descendants,
  // AND the corresponding nodes on the OTHER trie for every sequence
  // that passes through the clicked node. The cross-highlight map was
  // precomputed in the flow useMemo — this render pass just looks it up.
  const selectedHighlight: ReadonlySet<string> | null =
    selectedRowId != null ? flow.crossHighlight.get(selectedRowId) ?? null : null;
  // When a selection is active, override highlighted cards' AND
  // edges' tones to the selected node's tone. Each trie has its own
  // fork-based palette, so without an override the highlighted post-
  // nodes read as visually disconnected islands from the highlighted
  // pre-nodes even though they belong to the same visitor flow.
  // Overriding gives the highlighted flow one continuous color read.
  const selectedNode: TrieVizNode | null =
    selectedRowId != null
      ? [...flow.preViz.nodes, ...flow.postViz.nodes].find((n) => n.id === selectedRowId) ?? null
      : null;
  const flowTone: ToneKey | null = selectedNode?.tone ?? null;
  // When a selection is active, EVERY highlighted node + edge takes
  // on the selected flow's tone so the visitor's journey reads as
  // one continuous colored path. Merged nodes get the flow tone too
  // — the truthful "this count is shared" cue is the visible number
  // on the card itself (a `2` = shared). Splitting colors mid-flow
  // (base on merged, override on exclusive) made the highlighted
  // path look broken; unified color reads as intended.
  const toneFor = (nodeId: string, baseTone: ToneKey): ToneKey =>
    flowTone != null && selectedHighlight?.has(nodeId) ? flowTone : baseTone;
  const nodeVisible = (id: string): number =>
    selectedHighlight == null ? 1 : selectedHighlight.has(id) ? 1 : 0.15;
  const edgeVisible = (edge: TrieVizEdge): number => {
    if (selectedHighlight == null) return 1;
    // An edge is on-flow when BOTH its endpoints are in the highlight.
    return selectedHighlight.has(edge.fromNodeId) && selectedHighlight.has(edge.toNodeId)
      ? 1
      : 0.15;
  };
  const edgeStroke = (edge: TrieVizEdge): string => {
    // Recolor when both endpoints are highlighted — the visitor's
    // continuous path reads as one flow color end-to-end, without
    // the base-tone patches on merged edges breaking continuity.
    if (
      flowTone != null &&
      selectedHighlight != null &&
      selectedHighlight.has(edge.fromNodeId) &&
      selectedHighlight.has(edge.toNodeId)
    ) {
      return TONE[flowTone].line;
    }
    return TONE[edge.tone].line;
  };

  // Pre-side leaves land on the chatbot circle's LEFT arc, distributed
  // via circleEntry so multiple leaves don't stack on the same anchor.
  // (Post-side leaves are natural tree tails — they just end where the
  // last card sits; no additional connector needed.)
  const preLeafAnchors = flow.preViz.leafAnchors;

  // Just the SVG children (no <svg> wrapper) — the card view wraps
  // them in a plain static SVG, while the zoom Modal wraps them in a
  // ZoomableFlowCanvas that adds pan + wheel-zoom + a toolbar.
  const diagramContent = (
    <>
      {/* Pre-trie edges: parent→child curves inside the pre-chat tree. */}
      {flow.preViz.edges.map((edge) => {
        const base = strokeFor(edge.sessions, preAllSessions);
        if (base <= 0) return null;
        const isOnFlow =
          selectedHighlight != null &&
          selectedHighlight.has(edge.fromNodeId) &&
          selectedHighlight.has(edge.toNodeId);
        return (
          <path
            key={edge.id}
            d={curve(edge.fromX, edge.fromY, edge.toX, edge.toY)}
            stroke={edgeStroke(edge)}
            strokeWidth={boostForHighlight(base, isOnFlow)}
            fill="none"
            strokeLinecap="round"
            opacity={edgeVisible(edge) * 0.85}
          />
        );
      })}

      {/* Pre-trie leaf → chatbot connectors. Every leaf gets a
          connector; anchors are distributed along the chatbot's
          left arc in visual (top-to-bottom) order so the connectors
          read left-to-right without crossing themselves. */}
      {(() => {
        const sorted = [...preLeafAnchors].sort((a, b) => a.y - b.y);
        return sorted.map((leaf, i) => {
          const chatEnd = circleEntry(i, sorted.length, flow.centerY);
          const base = strokeFor(leaf.sessions, preAllSessions);
          if (base <= 0) return null;
          const isOnFlow = selectedHighlight != null && selectedHighlight.has(leaf.nodeId);
          const highlightMissing = selectedHighlight != null && !isOnFlow;
          const stroke = TONE[toneFor(leaf.nodeId, leaf.tone)].line;
          return (
            <path
              key={`preleaf-${leaf.nodeId}`}
              d={curve(leaf.x, leaf.y, chatEnd.x, chatEnd.y)}
              stroke={stroke}
              strokeWidth={boostForHighlight(base, isOnFlow)}
              fill="none"
              strokeLinecap="round"
              opacity={(highlightMissing ? 0.15 : 1) * 0.85}
            />
          );
        });
      })()}

      {/* Chatbot → post-side orphans. An "orphan" is any post-node
          that has no incoming edge from another visible node — that
          covers both true depth-0 root children AND nodes whose
          parent got pruned. Sorted top-to-bottom so `circleExit`
          distributes their anchors along the chatbot's right arc in
          the same visual order they appear. Every orphan gets a
          connector, so no post-node can ever look disconnected. */}
      {(() => {
        const sorted = [...postOrphans].sort((a, b) => a.y - b.y);
        return sorted.map((child, i) => {
          const chatStart = circleExit(i, sorted.length, flow.centerY);
          // Fallback stroke floor: even when the natural strokeFor
          // returns 0 (empty scaling population edge-case), the
          // connector for an orphan post-node MUST render — a card
          // showing sessions with no incoming line reads as broken.
          const base = strokeFor(child.sessions, postAllSessions) || MIN_STROKE;
          const isOnFlow = selectedHighlight != null && selectedHighlight.has(child.id);
          const highlightMissing = selectedHighlight != null && !isOnFlow;
          const stroke = TONE[toneFor(child.id, child.tone)].line;
          return (
            <path
              key={`postorphan-${child.id}`}
              d={curve(chatStart.x, chatStart.y, child.x, child.y + CARD_H / 2)}
              stroke={stroke}
              strokeWidth={boostForHighlight(base, isOnFlow)}
              fill="none"
              strokeLinecap="round"
              opacity={(highlightMissing ? 0.15 : 1) * 0.85}
            />
          );
        });
      })()}

      {/* Post-trie edges: parent→child curves inside the post-chat tree. */}
      {flow.postViz.edges.map((edge) => {
        const base = strokeFor(edge.sessions, postAllSessions);
        if (base <= 0) return null;
        const isOnFlow =
          selectedHighlight != null &&
          selectedHighlight.has(edge.fromNodeId) &&
          selectedHighlight.has(edge.toNodeId);
        return (
          <path
            key={edge.id}
            d={curve(edge.fromX, edge.fromY, edge.toX, edge.toY)}
            stroke={edgeStroke(edge)}
            strokeWidth={boostForHighlight(base, isOnFlow)}
            fill="none"
            strokeLinecap="round"
            opacity={edgeVisible(edge) * 0.85}
          />
        );
      })}

      {/* Chatbot → destinations lines. HIDDEN when a source row is
          selected: the line widths are scaled from GLOBAL summary
          counts, so drawing them alongside a highlighted row would
          falsely imply "this journey → these outcomes." The
          destination CARDS stay visible (dimmed) so the reader
          still sees the outcome column exists; the numbers on them
          drop the % when a row is selected — see FlowCard. */}
      {selectedRowId == null && (
        <g>
          {flow.destinations.map((node, i) => {
            const start = circleExit(i, flow.destinations.length, flow.centerY);
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
        </g>
      )}

      <circle cx={CENTER.x} cy={flow.centerY} r={CENTER.r + 8} fill="var(--ds-accent-soft)" opacity={0.55} />
      <circle
        cx={CENTER.x}
        cy={flow.centerY}
        r={CENTER.r}
        fill="var(--ds-accent)"
        stroke="var(--ds-accent-hover)"
        strokeWidth={2}
      />
      <foreignObject
        x={CENTER.x - CENTER.r}
        y={flow.centerY - CENTER.r}
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

      {/* Trie nodes — pre-side then post-side. Each card is
          individually clickable: click a shared root (like `/`) and
          the entire subtree lights up; click a leaf and just its
          root-to-leaf path lights up. Cards show summed sessions
          through that node — a shared `/` with 3 branches shows the
          total 3 visitors, not any single tail. */}
      {[...flow.preViz.nodes, ...flow.postViz.nodes].map((node) => {
        const value = node.sessions;
        const effectiveTone = toneFor(node.id, node.tone);
        return (
          <foreignObject
            key={node.id}
            x={node.x}
            y={node.y}
            width={node.width}
            height={CARD_H}
            opacity={nodeVisible(node.id)}
            style={{ cursor: 'pointer' }}
            onClick={() => {
              // Pre-chat page click = FILTER the diagram to journeys that
              // began on this page, mirroring how clicking an outcome
              // filters to journeys that ended there. This re-renders a
              // focused, non-empty view instead of the in-place highlight
              // (which, on sparse data, dimmed everything and hid the
              // outcome connectors — reading as "nothing happened").
              // Post-chat nodes keep the highlight: they have no single
              // starting page to filter by.
              if (node.side === 'pre' && node.startPage != null) {
                const page = node.startPage;
                setStartFilter((prev) => (prev === page ? null : page));
                setSelectedRowId(null);
              } else {
                toggleRow(node.id);
              }
            }}
          >
            <FlowCard
              node={{
                id: node.id,
                label: node.label,
                tone: effectiveTone,
                icon: node.icon,
                x: node.x,
                y: node.y,
                width: node.width,
                value,
              }}
              subtitle={node.isFork ? 'merged' : undefined}
              active={selectedRowId === node.id}
              tooltip={`${node.path} · ${value.toLocaleString()} ${value === 1 ? 'visitor' : 'visitors'}${node.isFork ? ' (merged across branches)' : ''}`}
            />
          </foreignObject>
        );
      })}
      {/* Destination cards — click one to filter the diagram to only
          the pre-chat journeys that led to that outcome, so the owner
          can see "who ended in Live Chat?" or "who dropped off?".
          Dim when a row is selected, and hide the % on the card in
          that mode since the % is a share of ALL sessions, not of
          the selected row. */}
      <g opacity={otherOpacity()}>
        {flow.destinations.map((node) => {
          const isActive = outcomeFilter === node.id;
          return (
            <foreignObject
              key={node.id}
              x={node.x}
              y={node.y}
              width={node.width}
              height={CARD_H}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setOutcomeFilter((prev) =>
                  prev === node.id ? null : (node.id as OutcomeFilter),
                );
                setSelectedRowId(null);
              }}
            >
              <FlowCard node={node} hidePct={selectedRowId != null} active={isActive} />
            </foreignObject>
          );
        })}
      </g>
    </>
  );

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
          {freshnessLabel && (
            <span className="tabular-nums text-[11px] text-[var(--ds-text-subtle)]">
              {freshnessLabel}
            </span>
          )}
          {startFilter && (
            <button
              type="button"
              onClick={() => setStartFilter(null)}
              className="flex items-center gap-1.5 rounded-full border border-[var(--ds-border-strong)] bg-[var(--ds-bg-sunken)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-text)] hover:bg-[var(--ds-bg-hover)]"
              aria-label={`Clear filter: journeys starting on ${startFilter}`}
              title="Clear filter"
            >
              <span className="text-[var(--ds-text-muted)]">Starts on:</span>
              <span className="max-w-[160px] truncate">{startFilter}</span>
              <span className="text-[var(--ds-text-muted)]">✕</span>
            </button>
          )}
          {outcomeFilter && (
            <button
              type="button"
              onClick={() => setOutcomeFilter(null)}
              className="flex items-center gap-1.5 rounded-full border border-[var(--ds-border-strong)] bg-[var(--ds-bg-sunken)] px-2.5 py-1 text-[11px] font-medium text-[var(--ds-text)] hover:bg-[var(--ds-bg-hover)]"
              aria-label={`Clear outcome filter: ${outcomeFilter}`}
              title="Clear outcome filter"
            >
              <span className="text-[var(--ds-text-muted)]">Ends in:</span>
              <span>{outcomeLabel(outcomeFilter)}</span>
              <span className="text-[var(--ds-text-muted)]">✕</span>
            </button>
          )}
          <IconButton
            aria-label="Refresh"
            onClick={reload}
            disabled={refreshing}
          >
            <RefreshCw
              size={16}
              className={refreshing ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
          </IconButton>
          <div className="relative">
            <IconButton
              aria-label="Filter by starting page"
              onClick={() => setFilterOpen((v) => !v)}
              active={startFilter != null || filterOpen}
            >
              <Filter size={16} />
            </IconButton>
            {filterOpen && (
              <StartingPageFilter
                pages={startingPages}
                selected={startFilter}
                onSelect={(path) => {
                  setStartFilter(path);
                  setSelectedRowId(null);
                  setFilterOpen(false);
                }}
                onClose={() => setFilterOpen(false)}
              />
            )}
          </div>
          <IconButton aria-label="Expand diagram" onClick={() => setZoomOpen(true)}>
            <Maximize2 size={16} />
          </IconButton>
        </div>
      </div>

      {/* Diagram — pan + wheel-zoom right here in the card. The SVG
          uses preserveAspectRatio="xMidYMid meet" so it scales
          proportionally to whatever width the card gives it; no
          maxWidth cap here, otherwise wide screens leave huge empty
          rails on both sides of the diagram. */}
      <div className="relative w-full">
        <ZoomableFlowCanvas vbH={flow.effVBH}>{diagramContent}</ZoomableFlowCanvas>
      </div>

      {/* Zoom modal — same diagram inside an interactive pan/zoom
          canvas so owners with dense journeys can drag around and
          zoom into individual chains. */}
      <Modal
        open={zoomOpen}
        onClose={() => setZoomOpen(false)}
        title="User Journey Flow"
        description="Drag to pan · scroll to zoom"
        size="xl"
      >
        <ZoomableFlowCanvas vbH={flow.effVBH}>{diagramContent}</ZoomableFlowCanvas>
      </Modal>
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

/** Below this width the horizontal "icon + text" layout runs out of
 *  room and the label disappears entirely. Switch to a stacked
 *  vertical layout (icon top, label + count below) so narrow chain
 *  cards still show their real page path. */
const FLOW_CARD_COMPACT_THRESHOLD = 96;

function FlowCard({
  node,
  hidePct = false,
  active = false,
  subtitle,
  tooltip,
}: {
  node: FlowNode;
  hidePct?: boolean;
  active?: boolean;
  /** Short secondary label under the value — e.g. "merged" for a
   *  trie node that aggregates several downstream branches. */
  subtitle?: string;
  /** Full text shown on hover via the native `title` attribute.
   *  Use for the untruncated page path when the visible label was
   *  clipped by displayPath(). */
  tooltip?: string;
}): ReactElement {
  const Icon = node.icon;
  const tone = TONE[node.tone];
  const compact = node.width < FLOW_CARD_COMPACT_THRESHOLD;
  const borderClass = active
    ? 'border-[var(--ds-accent)] ring-2 ring-[var(--ds-accent)]'
    : 'border-[var(--ds-border)]';

  // Design intent (Linear/Stripe-grade cards):
  // - Icon renders monochrome in --ds-text-muted; NO colored tile.
  //   The connector lines outside the card already carry the branch
  //   identity via `tone.line`, so a second colored surface behind
  //   the icon is redundant decoration.
  // - A tiny 4px colored dot in the top-right corner keeps the
  //   subtle tone cue (matches the outgoing connector) without the
  //   AI-slop translucent-tile look. Dropped when the card is
  //   active — the accent ring takes over as the visual anchor.
  const showDot = !active;
  if (compact) {
    return (
      <div
        title={tooltip}
        className={`relative flex h-full w-full flex-col items-center justify-center gap-1 rounded-xl border bg-[var(--ds-bg-sunken)] px-1.5 py-1 ${borderClass}`}
      >
        {showDot && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: tone.icon }}
          />
        )}
        <Icon
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-[var(--ds-text-muted)]"
        />
        <div className="min-w-0 max-w-full text-center">
          <p className="truncate text-[10px] font-medium leading-tight text-[var(--ds-text-muted)]">
            {node.label}
          </p>
          <p className="tabular-nums text-[11px] font-semibold leading-tight text-[var(--ds-text)]">
            {node.value.toLocaleString()}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      title={tooltip}
      className={`relative flex h-full w-full items-center gap-3 rounded-xl border bg-[var(--ds-bg-sunken)] px-3 ${borderClass}`}
    >
      {showDot && (
        <span
          aria-hidden
          className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: tone.icon }}
        />
      )}
      <Icon
        size={18}
        strokeWidth={1.75}
        className="shrink-0 text-[var(--ds-text-muted)]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-[var(--ds-text-muted)]">{node.label}</p>
        <p className="tabular-nums text-[13px] font-semibold leading-tight text-[var(--ds-text)]">
          {node.value.toLocaleString()}
          {!hidePct && typeof node.pct === 'number' && node.value > 0 && (
            <span className="ml-1 text-[11px] font-normal text-[var(--ds-text-subtle)]">
              ({node.pct}%)
            </span>
          )}
          {subtitle && (
            <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-[var(--ds-text-subtle)]">
              {subtitle}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

// ── Header controls ─────────────────────────────────────────────────────────

// Human-readable label for an outcome id. Kept in sync with
// CONVERSION_DESTINATIONS / EXIT_DESTINATION above — no auto-derivation
// because the id → label mapping is small and stable, and colocating it
// here means the chip text can be tightened without unrelated churn.
function outcomeLabel(id: string): string {
  switch (id) {
    case 'meeting_booked':
      return 'Book Meeting';
    case 'handoff_requested':
      return 'Live Chat';
    case 'offline_message_sent':
      return 'Offline Message';
    case 'exit':
      return 'Drop-off';
    default:
      return id;
  }
}

/**
 * Popover listing every distinct starting page (first stop of a
 * pre-chat sequence) with its visitor count. Click a page to filter
 * the diagram to journeys that begin there. Click "All pages" to
 * clear. Closes on outside-click via the parent's toggle state.
 */
function StartingPageFilter({
  pages,
  selected,
  onSelect,
  onClose,
}: {
  pages: ReadonlyArray<{ path: string; sessions: number }>;
  selected: string | null;
  onSelect: (path: string | null) => void;
  onClose: () => void;
}): ReactElement {
  // Close on outside click — a small effect that watches document
  // mousedown; skipped when the target is inside the popover so
  // scrolling the list doesn't close it.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-20 mt-2 w-72 overflow-hidden rounded-xl border border-[var(--ds-border-strong)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]"
    >
      <div className="border-b border-[var(--ds-border)] px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
          Filter by starting page
        </p>
      </div>
      <ul className="max-h-72 overflow-y-auto p-1">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-[var(--ds-bg-sunken)] ${
              selected == null ? 'bg-[var(--ds-bg-sunken)] font-medium text-[var(--ds-text)]' : 'text-[var(--ds-text-muted)]'
            }`}
          >
            <span>All pages</span>
            {selected == null && (
              <span className="text-[10px] uppercase text-[var(--ds-accent-fg)]">Active</span>
            )}
          </button>
        </li>
        {pages.length === 0 ? (
          <li className="px-3 py-3 text-[12px] text-[var(--ds-text-subtle)]">
            No starting pages recorded yet in this window.
          </li>
        ) : (
          pages.map((p) => {
            const isActive = selected === p.path;
            return (
              <li key={p.path}>
                <button
                  type="button"
                  onClick={() => onSelect(p.path)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-[var(--ds-bg-sunken)] ${
                    isActive ? 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text)]' : 'text-[var(--ds-text)]'
                  }`}
                  title={p.path}
                >
                  <span className="min-w-0 flex-1 truncate">{p.path}</span>
                  <span className="tabular-nums text-[11px] text-[var(--ds-text-muted)]">
                    {p.sessions.toLocaleString()}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

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

// ── Zoomable canvas ─────────────────────────────────────────────────────────

/** Pan + wheel-zoom bounds for the modal canvas. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_BUTTON_STEP = 1.2; // multiplicative, matches wheel feel

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * ZoomableFlowCanvas — wraps the diagram in an SVG with pan (click +
 * drag) and zoom (mouse wheel + toolbar buttons). Only used inside the
 * expand modal; the card overview stays static so the two views serve
 * distinct purposes.
 *
 * Wheel handling attaches via addEventListener with `passive: false` in
 * a useEffect so we can call preventDefault — React normalises wheel
 * listeners as passive by default, which would let the parent page
 * scroll every time the visitor tried to zoom.
 */
function ZoomableFlowCanvas({ children, vbH }: { children: ReactNode; vbH: number }): ReactElement {
  const svgRef = useRef<SVGSVGElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ clientX: number; clientY: number; startTx: number; startTy: number } | null>(null);

  // Zoom around a fixed viewport point (usually the mouse cursor), so
  // the pixel under the cursor stays under the cursor as we scale.
  const zoomAt = (nextScale: number, anchor?: { x: number; y: number }): void => {
    setTransform((prev) => {
      const scale = clamp(nextScale, ZOOM_MIN, ZOOM_MAX);
      if (scale === prev.scale) return prev;
      if (!anchor) return { ...prev, scale };
      const ratio = scale / prev.scale;
      return {
        scale,
        tx: anchor.x - ratio * (anchor.x - prev.tx),
        ty: anchor.y - ratio * (anchor.y - prev.ty),
      };
    });
  };

  // Native wheel listener so preventDefault actually works.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setTransform((prev) => {
        const scale = clamp(prev.scale * factor, ZOOM_MIN, ZOOM_MAX);
        if (scale === prev.scale) return prev;
        const ratio = scale / prev.scale;
        return {
          scale,
          tx: anchor.x - ratio * (anchor.x - prev.tx),
          ty: anchor.y - ratio * (anchor.y - prev.ty),
        };
      });
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, []);

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return; // primary button only
    setDragging(true);
    dragRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startTx: transform.tx,
      startTy: transform.ty,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!dragging || !drag) return;
    setTransform((prev) => ({
      ...prev,
      tx: drag.startTx + (e.clientX - drag.clientX),
      ty: drag.startTy + (e.clientY - drag.clientY),
    }));
  };

  const endDrag = (): void => {
    setDragging(false);
    dragRef.current = null;
  };

  const zoomIn = (): void => zoomAt(transform.scale * ZOOM_BUTTON_STEP);
  const zoomOut = (): void => zoomAt(transform.scale / ZOOM_BUTTON_STEP);
  const reset = (): void => setTransform(IDENTITY);

  return (
    <div className="relative w-full overflow-hidden rounded-[var(--ds-radius-md)] bg-[var(--ds-bg-sunken)]">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto w-full select-none"
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        <g transform={`translate(${transform.tx} ${transform.ty}) scale(${transform.scale})`}>
          {children}
        </g>
      </svg>

      {/* Zoom toolbar — sits on top of the canvas in the corner. */}
      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <CanvasButton onClick={zoomIn} aria-label="Zoom in" disabled={transform.scale >= ZOOM_MAX}>
          <ZoomIn size={14} />
        </CanvasButton>
        <CanvasButton onClick={zoomOut} aria-label="Zoom out" disabled={transform.scale <= ZOOM_MIN}>
          <ZoomOut size={14} />
        </CanvasButton>
        <CanvasButton onClick={reset} aria-label="Reset view">
          <RotateCcw size={14} />
        </CanvasButton>
      </div>

      {/* Zoom % readout — a subtle affordance so the user always
          knows how far they've scaled. */}
      <div className="absolute bottom-3 right-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2 py-1 text-[11px] font-medium tabular-nums text-[var(--ds-text-muted)]">
        {Math.round(transform.scale * 100)}%
      </div>
    </div>
  );
}

function CanvasButton({
  children,
  onClick,
  disabled,
  ...rest
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  'aria-label': string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)] hover:bg-[var(--ds-bg-sunken)] disabled:cursor-not-allowed disabled:opacity-40"
      {...rest}
    >
      {children}
    </button>
  );
}
