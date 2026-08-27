/**
 * Pure layout math for the visual journey diagram, ported from
 * development's UserJourneyFlow.tsx (commit a56d0538, lines 260-660).
 * No rendering code lives here — JourneyDiagram.tsx turns this output
 * into SVG. Kept separate so the layout algorithm is unit-testable
 * without a DOM.
 */

export type ToneKey = 'green' | 'blue' | 'purple' | 'orange' | 'red' | 'yellow' | 'gray';

export interface TrieBuildNode {
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

export interface JourneySequenceInput {
  paths: readonly string[];
  sessions: number;
}

export const VB_W = 1200;
export const VB_H_BASE = 420;
export const CARD_W = 156;
export const CARD_H = 64;
export const ROW_MIN_GAP = 22;
export const V_MARGIN = 20;

export const CENTER = { x: 495, y: 210, r: 68 };
export const CIRCLE_ANCHOR_OVERSHOOT = 6;

export const CHAIN_GAP = 15;
export const CHAIN_START_X = 24;
export const CHAIN_END_X = 410;
export const CHAIN_MIN_CARD_W = 44;
export const CHAIN_MAX_CARD_W = 156;

export const POST_CHAIN_START_X = 595;
export const POST_CHAIN_END_X = 950;

export const TRIE_MAX_DEPTH = 8;
export const TRIE_LEAF_H = CARD_H + ROW_MIN_GAP;

export const MIN_STROKE = 1.5;
export const MAX_STROKE = 4;
export const HIGHLIGHT_MIN_STROKE = 3;

const SOURCE_TONES: readonly ToneKey[] = [
  'green',
  'purple',
  'blue',
  'orange',
  'green',
  'red',
  'gray',
  'gray',
];

export interface TrieVizNode {
  id: string;
  path: string;
  label: string;
  /** Sum of sessions passing through this node (through its subtree). */
  sessions: number;
  /** True if this node forks into more than one child. Used to hint
   *  the reader that the count aggregates several downstream branches. */
  isFork: boolean;
  tone: ToneKey;
  x: number;
  y: number;
  width: number;
  /** 0 for a root child, 1 for its child, etc. Exposed on the viz
   *  node so the render pass can identify root children reliably. */
  depth: number;
  /** Global indices of source sequences whose flow passes through
   *  this node. */
  seqIndices: ReadonlySet<number>;
  side: 'pre' | 'post';
  /** Starting page (depth-0 ancestor path) of this node's branch. */
  startPage?: string;
}

export interface TrieVizEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  sessions: number;
  tone: ToneKey;
  side: 'pre' | 'post';
}

export interface TrieVisual {
  nodes: TrieVizNode[];
  edges: TrieVizEdge[];
  /** Ends of leaf branches. Used to draw the final curves that land
   *  on the chatbot circle (pre) or emanate from it (post). Ordered
   *  top-to-bottom so `circleEntry/Exit` distributes the anchors. */
  leafAnchors: Array<{ nodeId: string; x: number; y: number; sessions: number; tone: ToneKey }>;
  /** Total vertical space consumed. Feeds computeEffectiveVBH. */
  height: number;
}

/**
 * Insert an ordered list of paths (one visitor sequence) into a trie
 * rooted at ``root``, incrementing session counts and recording
 * ``seqIndex`` on every node along the walk (including root).
 */
export function insertPath(
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
 * Build a trie root from N visitor sequences. Each sequence becomes one
 * seqIndex (its array position), used later to correlate pre-chat and
 * post-chat nodes belonging to the same visitor.
 *
 * `rootId` distinguishes the pre-chat trie from the post-chat one — every
 * descendant id is built as `${parent.id}>${path}` (see `insertPath`), so
 * two tries built with the SAME root id produce colliding ids the instant
 * the same page (e.g. `/`) appears as a root-level child on both sides,
 * which it very often does. `JourneyDiagram` renders both tries' nodes in
 * one combined list keyed by id, so a collision there is not cosmetic:
 * React drops or misattributes one of the two colliding `<foreignObject>`s,
 * which reads as a card silently missing its connector line.
 */
export function buildTrie(
  sequences: readonly JourneySequenceInput[],
  rootId: string = 'root',
): TrieBuildNode {
  const root: TrieBuildNode = {
    id: rootId,
    path: '',
    sessions: 0,
    depth: -1,
    parent: null,
    children: new Map(),
    order: 0,
    seqIndices: new Set(),
  };
  sequences.forEach((seq, i) => insertPath(root, seq.paths, seq.sessions, i));
  return root;
}

/**
 * Trim the trie so at most ``maxLeaves`` distinct root-to-leaf paths
 * remain. Pruning is done by repeatedly dropping the lowest-count leaf
 * and folding its sessions back into its parent's own count (the
 * parent becomes a leaf if it loses its last child). This preserves
 * the honest "sessions through this node" invariant on survivors.
 */
export function pruneToMaxLeaves(root: TrieBuildNode, maxLeaves: number): void {
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
    // longest path (deepest tail). That's the noisiest end to remove.
    ls.sort((a, b) => a.sessions - b.sessions || b.depth - a.depth);
    const victim = ls[0];
    const parent = victim.parent;
    if (!parent) return;
    parent.children.delete(victim.path);
    // Sessions stay attributed to the parent, the visitor did pass
    // through the parent, we just no longer render the specific tail.
  }
}

/** Trim a path for display on the compact source card. */
export function displayPath(path: string, max: number = 22): string {
  if (path.length <= max) return path;
  // Keep the head so the domain-relative context (e.g. `/blog/`) reads.
  return `${path.slice(0, max - 1)}…`;
}

/** Ensure a card sits fully inside its horizontal band. */
export function clampCard(x: number, w: number): number {
  return Math.max(CHAIN_START_X, Math.min(POST_CHAIN_END_X - w, x));
}

export function strokeFor(value: number, allValues: readonly number[]): number {
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
export function boostForHighlight(base: number, highlighted: boolean): number {
  if (!highlighted) return base;
  return Math.max(base, HIGHLIGHT_MIN_STROKE);
}

export function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function circleEntry(index: number, count: number, centerY: number): { x: number; y: number } {
  const angle = -70 + (140 * index) / Math.max(count - 1, 1);
  const rad = (angle * Math.PI) / 180;
  const r = CENTER.r - CIRCLE_ANCHOR_OVERSHOOT;
  return { x: CENTER.x - r * Math.cos(rad), y: centerY + r * Math.sin(rad) };
}

export function circleExit(index: number, count: number, centerY: number): { x: number; y: number } {
  const angle = -70 + (140 * index) / Math.max(count - 1, 1);
  const rad = (angle * Math.PI) / 180;
  const r = CENTER.r - CIRCLE_ANCHOR_OVERSHOOT;
  return { x: CENTER.x + r * Math.cos(rad), y: centerY + r * Math.sin(rad) };
}

/**
 * Layout a built trie horizontally with root on the anchored side.
 * ``side='pre'`` places root-column nodes at ``xStart`` and grows
 * rightward toward ``xEnd`` (where leaves land near the chatbot).
 * ``side='post'`` mirrors.
 */
export function layoutTrie(
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
  const toneOf = new Map<string, ToneKey>();
  const paint = (n: TrieBuildNode, inheritedTone: ToneKey): void => {
    toneOf.set(n.id, inheritedTone);
    const kids = Array.from(n.children.values()).sort((a, b) => a.order - b.order);
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      const tone =
        kids.length > 1
          ? SOURCE_TONES[(i + n.depth + 1) % SOURCE_TONES.length]
          : inheritedTone;
      paint(kid, tone);
    }
  };
  const rootTone = SOURCE_TONES[0];
  paint(root, rootTone);

  // Starting page of a node's branch: walk up to the depth-0 ancestor.
  const rootPageOf = (bn: TrieBuildNode): string => {
    let c = bn;
    while (c.parent && c.depth > 0) c = c.parent;
    return c.path;
  };

  // Recursively assign vertical positions using leaf-count weighting:
  let cursorSlot = 0;
  const place = (n: TrieBuildNode): { yCenter: number } => {
    if (n.children.size === 0) {
      const y = yTop + cursorSlot * TRIE_LEAF_H;
      cursorSlot += 1;
      const yCenter = y + CARD_H / 2;
      if (n !== root) {
        const x = xStart + n.depth * colW;
        const tone = toneOf.get(n.id) ?? rootTone;
        const cardX = clampCard(x, cardW);
        const labelMax = Math.max(6, Math.floor(cardW / 7));
        nodes.push({
          id: n.id,
          path: n.path,
          label: displayPath(n.path, labelMax),
          sessions: n.sessions,
          isFork: false,
          tone,
          x: cardX,
          y,
          width: cardW,
          depth: n.depth,
          seqIndices: n.seqIndices,
          side,
          startPage: rootPageOf(n),
        });
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
      const x = xStart + n.depth * colW;
      const cardX = clampCard(x, cardW);
      const labelMax = Math.max(6, Math.floor(cardW / 7));
      const tone = toneOf.get(n.id) ?? rootTone;
      nodes.push({
        id: n.id,
        path: n.path,
        label: displayPath(n.path, labelMax),
        sessions: n.sessions,
        isFork: kids.length > 1,
        tone,
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
            tone: nodeById.get(kid.id)?.tone ?? rootTone,
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
