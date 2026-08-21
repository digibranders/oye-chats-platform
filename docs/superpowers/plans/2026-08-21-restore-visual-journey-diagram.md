# Restore Visual Journey Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring back the visual Sankey-style journey flow diagram, its pan/zoom expand-to-fullscreen view, and the outcomes donut chart from `development`, without reintroducing the WCAG violations that got them cut — and restore a "Journey" entry in the left sidebar.

**Architecture:** Port the pure layout math (trie build + Sankey layout + curve/stroke functions) from `development`'s `UserJourneyFlow.tsx` into a standalone, unit-tested module with zero rendering code. Build a new accessible `ZoomPanCanvas` primitive in `src/ui` (keyboard pan/zoom, not just mouse) since the design-system mandate forbids a feature inventing its own visual primitive. Render the diagram's nodes as real `<button>` elements with `aria-label`s (not `<div onClick>` with no role), inside `foreignObject`, reachable by Tab. Add the diagram as a **view toggle** next to the existing `JourneyFlow.tsx` list view rather than replacing it — the list view is already fully accessible and already shipped; the diagram becomes an equally-accessible second way to see the same data, and if anything about the new keyboard/ARIA work turns out incomplete, the list view is still there as a working fallback with zero regression risk. Port the outcomes donut as a new sibling panel, this time with a real text alternative (the old one was `aria-hidden="true"` on the entire SVG with no fallback — screen reader users got nothing). Restore the sidebar nav entry as a direct link to the existing `/analytics/journey` route, not a second copy of the page — that avoids reintroducing the double-mount/30-requests-on-load bug the current branch's data layer (`useJourneyData.ts`) was built specifically to fix, per `REBUILD.md:149`.

**Tech Stack:** React 19, TypeScript, hand-rolled SVG (no charting library, matching the codebase's existing pattern), Vitest + Testing Library, `@base-ui/react` (already the primitive foundation for `Dialog`).

**Source of truth for ported code:** `origin/development` at commit `a56d05380d72821cb6ad76fd15f73bac1d848e55`. Every `git show` command below is pinned to this SHA so the port is reproducible even if `development` moves. Original file: `app/src/features/analytics/UserJourneyFlow.tsx` (2011 lines) and `app/src/features/analytics/JourneyOutcomes.tsx` (400 lines) at that SHA.

---

## Task 1: Port the trie/layout math as a pure, tested module

The old file mixed rendering and layout math in one 2011-line component. Pulling the math into its own file with no JSX means it can be unit tested directly (no DOM, no rendering) and reused by both the card view and the fullscreen modal view without duplicating logic.

**Files:**
- Create: `app/src/features/analytics/journeyTrie.ts`
- Test: `app/src/features/analytics/journeyTrie.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// app/src/features/analytics/journeyTrie.test.ts
import { describe, expect, it } from 'vitest';
import { buildTrie, curve, layoutTrie, pruneToMaxLeaves, strokeFor } from './journeyTrie';

describe('buildTrie', () => {
  it('merges a shared prefix into one node with a summed session count', () => {
    const root = buildTrie([
      { paths: ['/pricing', '/docs'], sessions: 3 },
      { paths: ['/pricing', '/contact'], sessions: 2 },
    ]);
    const pricing = root.children.get('/pricing');
    expect(pricing?.sessions).toBe(5);
    expect(pricing?.children.size).toBe(2);
  });

  it('records seqIndex on every node walked, including the root', () => {
    const root = buildTrie([{ paths: ['/a'], sessions: 1 }]);
    expect(root.seqIndices.has(0)).toBe(true);
    expect(root.children.get('/a')?.seqIndices.has(0)).toBe(true);
  });
});

describe('pruneToMaxLeaves', () => {
  it('drops the lowest-count leaf and folds its sessions into the parent', () => {
    const root = buildTrie([
      { paths: ['/a'], sessions: 10 },
      { paths: ['/b'], sessions: 1 },
      { paths: ['/c'], sessions: 5 },
    ]);
    pruneToMaxLeaves(root, 2);
    expect(root.children.has('/b')).toBe(false);
    expect(root.children.size).toBe(2);
  });

  it('breaks ties by dropping the deepest leaf first', () => {
    const root = buildTrie([
      { paths: ['/a', '/a/1'], sessions: 1 },
      { paths: ['/b'], sessions: 1 },
    ]);
    pruneToMaxLeaves(root, 1);
    const survivor = [...root.children.values()][0];
    expect(survivor.path).toBe('/b');
  });
});

describe('layoutTrie', () => {
  it('places single-child chains at increasing x with root-column nodes at xStart', () => {
    const root = buildTrie([{ paths: ['/a', '/a/b'], sessions: 4 }]);
    const { nodes } = layoutTrie(root, 'pre', 0, 400, 0);
    const a = nodes.find((n) => n.path === '/a')!;
    const ab = nodes.find((n) => n.path === '/a/b')!;
    expect(a.x).toBeLessThan(ab.x);
    expect(a.depth).toBe(0);
    expect(ab.depth).toBe(1);
  });

  it('centers a fork node between its children', () => {
    const root = buildTrie([
      { paths: ['/a', '/a/x'], sessions: 1 },
      { paths: ['/a', '/a/y'], sessions: 1 },
    ]);
    const { nodes } = layoutTrie(root, 'pre', 0, 400, 0);
    const a = nodes.find((n) => n.path === '/a')!;
    const x = nodes.find((n) => n.path === '/a/x')!;
    const y = nodes.find((n) => n.path === '/a/y')!;
    expect(a.y + 32).toBeCloseTo((x.y + 32 + y.y + 32) / 2, 0);
  });

  it('builds one edge per parent-child pair, skipping the invisible root', () => {
    const root = buildTrie([{ paths: ['/a', '/a/b'], sessions: 1 }]);
    const { edges } = layoutTrie(root, 'pre', 0, 400, 0);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromNodeId).toContain('/a');
    expect(edges[0].toNodeId).toContain('/a/b');
  });
});

describe('strokeFor', () => {
  it('returns 0 for a non-positive value', () => {
    expect(strokeFor(0, [1, 2, 3])).toBe(0);
  });

  it('linearly interpolates between MIN_STROKE and MAX_STROKE', () => {
    expect(strokeFor(1, [1, 5])).toBeCloseTo(1.5, 5);
    expect(strokeFor(5, [1, 5])).toBeCloseTo(4, 5);
  });

  it('returns the stroke midpoint when every value is equal', () => {
    expect(strokeFor(3, [3, 3, 3])).toBeCloseTo(2.75, 5);
  });
});

describe('curve', () => {
  it('produces a cubic bezier with horizontal-tangent control points at the midpoint x', () => {
    expect(curve(0, 10, 100, 50)).toBe('M 0 10 C 50 10, 50 50, 100 50');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/features/analytics/journeyTrie.test.ts`
Expected: FAIL with "Cannot find module './journeyTrie'"

- [ ] **Step 3: Write the module**

Port `TrieBuildNode`, `insertPath`, `pruneToMaxLeaves`, `layoutTrie`, `strokeFor`, `boostForHighlight`, `curve`, `circleEntry`, `circleExit`, `clampCard`, `displayPath` **verbatim** from `origin/development:app/src/features/analytics/UserJourneyFlow.tsx` at commit `a56d05380d72821cb6ad76fd15f73bac1d848e55`, lines 367–470 (`TrieBuildNode` + `insertPath` + `pruneToMaxLeaves`) and lines 470–660 (`layoutTrie` + `clampCard`), and lines 273–336 (`displayPath`, `strokeFor`, `boostForHighlight`, `curve`, `circleEntry`, `circleExit`). Fetch the exact source with:

```bash
git show a56d05380d72821cb6ad76fd15f73bac1d848e55:app/src/features/analytics/UserJourneyFlow.tsx | sed -n '260,660p'
```

Wrap `insertPath` in a new `buildTrie()` convenience function (the old file called `insertPath` in a loop inline inside the component; here it becomes the module's public entry point):

```ts
// app/src/features/analytics/journeyTrie.ts

/**
 * Pure layout math for the visual journey diagram, ported from
 * development's UserJourneyFlow.tsx (commit a56d0538, lines 260-660).
 * No rendering code lives here — JourneyDiagram.tsx turns this output
 * into SVG. Kept separate so the layout algorithm is unit-testable
 * without a DOM.
 */

export interface TrieBuildNode {
  id: string;
  path: string;
  sessions: number;
  depth: number;
  parent: TrieBuildNode | null;
  children: Map<string, TrieBuildNode>;
  order: number;
  seqIndices: Set<number>;
}

// [insertPath, pruneToMaxLeaves verbatim from the SHA above]

export interface JourneySequenceInput {
  paths: readonly string[];
  sessions: number;
}

/** Build a trie root from N visitor sequences. Each sequence becomes
 *  one seqIndex (its array position), used later to correlate
 *  pre-chat and post-chat nodes belonging to the same visitor. */
export function buildTrie(sequences: readonly JourneySequenceInput[]): TrieBuildNode {
  const root: TrieBuildNode = {
    id: 'root',
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

// [pruneToMaxLeaves, TrieVizNode, TrieVizEdge, TrieVisual, layoutTrie,
//  clampCard, displayPath, strokeFor, boostForHighlight, curve,
//  circleEntry, circleExit verbatim from the SHA above, with the
//  CENTER/CARD_W/CARD_H/CHAIN_* constants layoutTrie and circleEntry/
//  circleExit depend on — port those constants too, unchanged.]
```

Do not port `SOURCE_STYLES`, `TONE`, icon assignment, or anything JSX-related here — those live in `JourneyDiagram.tsx` (Task 4). This module exports only geometry and grouping.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/features/analytics/journeyTrie.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/features/analytics/journeyTrie.ts app/src/features/analytics/journeyTrie.test.ts
git commit -m "feat: port journey trie/layout math as a pure, tested module"
```

---

## Task 2: Build an accessible ZoomPanCanvas primitive

`app/CLAUDE.md`'s non-negotiable #1: a feature may not define a visual primitive; it goes into `src/ui` first, with a test for its keyboard contract and an entry in `/dev/ui`. The old `ZoomableFlowCanvas` was mouse-only (wheel zoom, click-drag pan, zero keyboard handlers) — that is the exact defect `REBUILD.md:73` cites for cutting it. This task ports the same pan/zoom math but adds a real keyboard contract: arrow keys pan, `+`/`-` zoom, `0` resets, and the canvas is a focusable, labeled region.

**Files:**
- Create: `app/src/ui/data/ZoomPanCanvas.tsx`
- Test: `app/src/ui/data/ZoomPanCanvas.test.tsx`
- Modify: `app/src/ui/index.ts` (export it)
- Modify: `app/src/dev/UiGallery.tsx` (or wherever `/dev/ui` entries live — find the existing pattern with `grep -rn "DataTable" app/src/dev/`)

- [ ] **Step 1: Write the failing test**

```tsx
// app/src/ui/data/ZoomPanCanvas.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ZoomPanCanvas } from './ZoomPanCanvas';

describe('ZoomPanCanvas', () => {
  it('is a focusable region with an accessible label', () => {
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    const region = screen.getByRole('application', { name: 'Journey diagram' });
    expect(region).toHaveAttribute('tabIndex', '0');
  });

  it('zooms in on ArrowUp/+ and out on ArrowDown/-, clamped to bounds', async () => {
    const user = userEvent.setup();
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    const region = screen.getByRole('application', { name: 'Journey diagram' });
    region.focus();
    await user.keyboard('+');
    expect(screen.getByText('110%')).toBeInTheDocument();
    for (let i = 0; i < 30; i++) await user.keyboard('+');
    expect(screen.getByText('400%')).toBeInTheDocument();
    for (let i = 0; i < 40; i++) await user.keyboard('-');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('pans on arrow keys and resets on 0', async () => {
    const user = userEvent.setup();
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    const region = screen.getByRole('application', { name: 'Journey diagram' });
    region.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await user.keyboard('0');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('exposes zoom in/out/reset as real buttons, each independently reachable by Tab', async () => {
    const user = userEvent.setup();
    render(
      <ZoomPanCanvas label="Journey diagram" viewBoxWidth={1200} viewBoxHeight={420}>
        <circle cx={50} cy={50} r={10} />
      </ZoomPanCanvas>,
    );
    await user.tab();
    expect(screen.getByRole('application', { name: 'Journey diagram' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Reset view' })).toHaveFocus();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/ui/data/ZoomPanCanvas.test.tsx`
Expected: FAIL with "Cannot find module './ZoomPanCanvas'"

- [ ] **Step 3: Write the primitive**

Base the pan/zoom math on `origin/development:app/src/features/analytics/UserJourneyFlow.tsx` lines 1843–1987 (`ZoomableFlowCanvas`, `Transform`, `IDENTITY`, `clamp`, `ZOOM_MIN`/`ZOOM_MAX`/`ZOOM_BUTTON_STEP`), fetched via:

```bash
git show a56d05380d72821cb6ad76fd15f73bac1d848e55:app/src/features/analytics/UserJourneyFlow.tsx | sed -n '1843,1988p'
```

Keep the wheel-zoom and mouse-drag behavior unchanged (it already works and isn't the accessibility problem), and add on top:

```tsx
// app/src/ui/data/ZoomPanCanvas.tsx
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { IconButton } from '../primitives/IconButton';

/**
 * A pannable, zoomable SVG viewport. Ported from a mouse-only canvas
 * in `development` (development:UserJourneyFlow.tsx#ZoomableFlowCanvas,
 * commit a56d0538) that had no keyboard path at all — the defect
 * `REBUILD.md`'s Consolidations table cites for why the journey flow
 * diagram was cut. Wheel-zoom and drag-to-pan behave the same as the
 * original; arrow keys / `+`/`-`/`0` are new, and the canvas itself is
 * a focusable `role="application"` region (an SVG viewport with its
 * own keybindings isn't a `region` or `img` — `application` is the
 * ARIA pattern for a widget that owns arrow-key navigation instead of
 * ceding it to the page).
 */

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_BUTTON_STEP = 1.2;
const KEYBOARD_PAN_STEP = 40;

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export interface ZoomPanCanvasProps {
  /** Accessible name for the canvas region, read by screen readers
   *  and used as the `role="application"` label. */
  label: string;
  viewBoxWidth: number;
  viewBoxHeight: number;
  children: ReactNode;
  className?: string;
}

export function ZoomPanCanvas({
  label,
  viewBoxWidth,
  viewBoxHeight,
  children,
  className,
}: ZoomPanCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ clientX: number; clientY: number; startTx: number; startTy: number } | null>(
    null,
  );

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

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(transform.scale * factor, anchor);
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transform.scale]);

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragRef.current = { clientX: e.clientX, clientY: e.clientY, startTx: transform.tx, startTy: transform.ty };
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowUp':
        setTransform((p) => ({ ...p, ty: p.ty + KEYBOARD_PAN_STEP }));
        e.preventDefault();
        break;
      case 'ArrowDown':
        setTransform((p) => ({ ...p, ty: p.ty - KEYBOARD_PAN_STEP }));
        e.preventDefault();
        break;
      case 'ArrowLeft':
        setTransform((p) => ({ ...p, tx: p.tx + KEYBOARD_PAN_STEP }));
        e.preventDefault();
        break;
      case 'ArrowRight':
        setTransform((p) => ({ ...p, tx: p.tx - KEYBOARD_PAN_STEP }));
        e.preventDefault();
        break;
      case '+':
      case '=':
        zoomIn();
        e.preventDefault();
        break;
      case '-':
      case '_':
        zoomOut();
        e.preventDefault();
        break;
      case '0':
        reset();
        e.preventDefault();
        break;
      default:
        break;
    }
  };

  return (
    <div className={`relative w-full overflow-hidden rounded-lg bg-bg-sunken ${className ?? ''}`}>
      <svg
        ref={svgRef}
        role="application"
        aria-label={label}
        aria-roledescription="pannable, zoomable diagram"
        tabIndex={0}
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto w-full select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring-color)]"
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onKeyDown={handleKeyDown}
      >
        <g transform={`translate(${transform.tx} ${transform.ty}) scale(${transform.scale})`}>{children}</g>
      </svg>

      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <IconButton
          size="sm"
          label="Zoom in"
          icon={Plus}
          onClick={zoomIn}
          disabled={transform.scale >= ZOOM_MAX}
        />
        <IconButton
          size="sm"
          label="Zoom out"
          icon={Minus}
          onClick={zoomOut}
          disabled={transform.scale <= ZOOM_MIN}
        />
        <IconButton size="sm" label="Reset view" icon={RotateCcw} onClick={reset} />
      </div>

      <div
        className="absolute bottom-3 right-3 rounded-md border border-border bg-bg-surface px-2 py-1 text-xs font-medium tabular-nums text-text-secondary"
        aria-live="polite"
      >
        {Math.round(transform.scale * 100)}%
      </div>
    </div>
  );
}
```

If `app/src/ui/primitives/IconButton.tsx` does not exist under that exact name, `grep -rn "export function" app/src/ui/primitives/*.tsx | grep -i icon` to find the real icon-button primitive and use its actual prop names instead of guessing — do not invent a second one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/ui/data/ZoomPanCanvas.test.tsx`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Export it and add a `/dev/ui` entry**

Add `export { ZoomPanCanvas } from './data/ZoomPanCanvas';` to `app/src/ui/index.ts` in the same section as the other `data/` exports (`DataTable`, etc — `grep -n "data/" app/src/ui/index.ts` to find the right spot). Find the existing `/dev/ui` gallery pattern with `grep -rln "DataTable" app/src/dev/` and add a `ZoomPanCanvas` entry the same way, with a small demo (a few circles/rects) so it's independently reviewable per `app/CLAUDE.md`'s non-negotiable #5 ("A component is reviewed by looking at it in `/dev/ui`, not by reading its diff").

- [ ] **Step 6: Commit**

```bash
git add app/src/ui/data/ZoomPanCanvas.tsx app/src/ui/data/ZoomPanCanvas.test.tsx app/src/ui/index.ts app/src/dev/
git commit -m "feat: add ZoomPanCanvas primitive with full keyboard support"
```

---

## Task 3: Add a full-viewport Dialog size for the expand modal

The Explore report on `app/src/ui/overlays/Dialog.tsx` found `DialogSize = 'sm'|'md'|'lg'|'xl'` with `xl` capped at `max-w-reading` (896px) — too narrow for a diagram meant to fill most of the viewport when expanded. This adds one more size rather than repurposing `xl` for two different jobs.

**Files:**
- Modify: `app/src/ui/overlays/Dialog.tsx`
- Test: `app/src/ui/overlays/Dialog.test.tsx` (extend existing file — `grep -n "size" app/src/ui/overlays/Dialog.test.tsx` to see the current size-test pattern and match it)

- [ ] **Step 1: Write the failing test**

Add to the existing size test block (match its exact structure — read the file first):

```tsx
it('renders the full size at a near-viewport width', () => {
  render(
    <Dialog open onOpenChange={() => {}} title="Full size" size="full">
      content
    </Dialog>,
  );
  expect(screen.getByRole('dialog')).toHaveClass('max-w-[calc(100vw-2rem)]');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/ui/overlays/Dialog.test.tsx`
Expected: FAIL — `size="full"` not assignable to `DialogSize`, or the class assertion fails.

- [ ] **Step 3: Add the size**

In `Dialog.tsx`, extend:

```ts
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const SIZES: Record<DialogSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-reading',
  full: 'max-w-[calc(100vw-2rem)]',
};
```

(Use the exact existing `SIZES` object found by reading the file — this shows the shape, not a guess at unread code. Add the `full` line without touching the other four.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/ui/overlays/Dialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/ui/overlays/Dialog.tsx app/src/ui/overlays/Dialog.test.tsx
git commit -m "feat: add full-viewport Dialog size for expand-to-fullscreen views"
```

---

## Task 4: Build the accessible JourneyDiagram, wired as a view toggle

This is the visual replacement for the old `UserJourneyFlow.tsx` card + modal. It renders using `journeyTrie.ts` (Task 1) inside `ZoomPanCanvas` (Task 2) for the expanded view, with a static (non-pan/zoom) card view by default — matching the old file's two-views-one-content structure. Every node is a real `<button>`, keyboard-reachable, with an `aria-label` stating the page and session count.

**Files:**
- Create: `app/src/features/analytics/JourneyDiagram.tsx`
- Test: `app/src/features/analytics/JourneyDiagram.test.tsx`
- Modify: `app/src/features/analytics/JourneyTab.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// app/src/features/analytics/JourneyDiagram.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JourneyDiagram } from './JourneyDiagram';

const sequences = {
  total_sessions: 10,
  sessions_with_pre_chat: 8,
  sequences: [
    { sequence: ['/pricing'], post_sequence: ['/docs'], post_sessions: 3, sessions: 5 },
    { sequence: ['/pricing', '/contact'], post_sequence: [], post_sessions: 0, sessions: 3 },
  ],
} as const;

function renderDiagram(onSelectOutcome = vi.fn()) {
  return render(
    <JourneyDiagram
      sequences={sequences as any}
      centerLabel="Opened Chatbot"
      centerValue={10}
      selectedOutcome={null}
      onSelectOutcome={onSelectOutcome}
    />,
  );
}

describe('JourneyDiagram', () => {
  it('renders each distinct page as a real, keyboard-focusable button with a labeled session count', async () => {
    const user = userEvent.setup();
    renderDiagram();
    const node = screen.getByRole('button', { name: /\/pricing.*5 sessions/i });
    await user.tab();
    // keep tabbing until we reach it or run out — proves it's in the tab order
    let found = document.activeElement === node;
    for (let i = 0; i < 10 && !found; i++) {
      await user.tab();
      found = document.activeElement === node;
    }
    expect(found).toBe(true);
  });

  it('activates a node with Enter, not just a click', async () => {
    const user = userEvent.setup();
    renderDiagram();
    const node = screen.getByRole('button', { name: /\/pricing.*5 sessions/i });
    node.focus();
    await user.keyboard('{Enter}');
    expect(node).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers a fullscreen expand control that is itself a real button', () => {
    renderDiagram();
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/features/analytics/JourneyDiagram.test.tsx`
Expected: FAIL with "Cannot find module './JourneyDiagram'"

- [ ] **Step 3: Write the component**

Reuse `SOURCE_STYLES`, `TONE`, `CENTER`, `CARD_W`/`CARD_H`/`CHAIN_*` constants and the `FlowCard` rendering pattern from `origin/development:app/src/features/analytics/UserJourneyFlow.tsx` lines 58–110 (palette/layout constants) and 1607–1704 (`FlowCard`), fetched via:

```bash
git show a56d05380d72821cb6ad76fd15f73bac1d848e55:app/src/features/analytics/UserJourneyFlow.tsx | sed -n '58,110p;1607,1706p'
```

Port `FlowCard` unchanged (it's presentational and has no accessibility problem — the problem was its *parent* `<foreignObject onClick>` wrapper, not the card itself). The wrapper is what changes:

```tsx
// Inside JourneyDiagram.tsx, replacing the old:
//   <foreignObject onClick={...}><FlowCard .../></foreignObject>
// with a real interactive element:

<foreignObject x={node.x} y={node.y} width={node.width} height={CARD_H}>
  <button
    type="button"
    className="h-full w-full cursor-pointer border-0 bg-transparent p-0 text-left"
    aria-label={`${node.label}, ${node.sessions} sessions`}
    aria-pressed={selectedNodeId === node.id}
    onClick={() => handleNodeSelect(node)}
  >
    <FlowCard node={node} active={selectedNodeId === node.id} tooltip={node.path} />
  </button>
</foreignObject>
```

Compose the full component: build the trie from `sequences.sequences` via `buildTrie()` + `pruneToMaxLeaves()` + `layoutTrie()` (Task 1), render nodes/edges as `<path d={curve(...)}>` connectors with `strokeFor()`/`boostForHighlight()` widths (Task 1), the chatbot circle at `CENTER` with `circleEntry`/`circleExit` anchor points (Task 1), and the card view statically (no `ZoomPanCanvas`) by default. Add an "Expand" `IconButton` (label `"Expand journey diagram"` — the test above matches `/expand/i`) that opens the `Dialog` from Task 3 at `size="full"` with the same diagram rendered a second time, this time wrapped in `ZoomPanCanvas` from Task 2 (mirrors the old file's `diagramContent` rendered twice — once static, once inside the zoomable canvas — lines 1580–1596 of the source SHA above).

`onSelectOutcome`/`selectedOutcome` wire into the existing `FilterableOutcome` filtering already used by `JourneyFlow.tsx` — a click (or Enter) on a pre-chat root node with a `startPage` should call the same `onSelectOutcome`-adjacent filtering path already present in `JourneyTab.tsx`; read `JourneyTab.tsx`'s current `selectOutcome` function before wiring this so the two views (list and diagram) drive the exact same `?outcome=` URL state rather than two independent filters.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/features/analytics/JourneyDiagram.test.tsx`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Add the view toggle in JourneyTab**

In `JourneyTab.tsx`, add a `view` state (`'list' | 'diagram'`, default `'list'` — the existing accessible view stays the default so nothing regresses for a reader who never touches the toggle) persisted the same way `outcome` is (via `useSearchParams`, so a bookmarked diagram view stays a diagram view). Render `<JourneyFlow ...>` (existing) when `view === 'list'`, `<JourneyDiagram ...>` (new) when `view === 'diagram'`, both reading the same `journey.data`/`paths` already fetched by `useJourneyData`/`useJourneyPaths` — no new network calls. Use the project's existing segmented-control primitive for the toggle (`grep -rn "SegmentedControl" app/src/ui/index.ts` to find its real export and prop names) rather than inventing a new one.

- [ ] **Step 6: Run the full analytics test suite**

Run: `cd app && npx vitest run src/features/analytics/`
Expected: PASS, no regressions in `JourneyTab`/`JourneyFlow`/existing tests.

- [ ] **Step 7: Commit**

```bash
git add app/src/features/analytics/JourneyDiagram.tsx app/src/features/analytics/JourneyDiagram.test.tsx app/src/features/analytics/JourneyTab.tsx
git commit -m "feat: add accessible visual journey diagram as a view toggle"
```

---

## Task 5: Port the outcomes donut, with a real accessible alternative

The old `JourneyOutcomes.tsx` set `aria-hidden="true"` on the entire donut SVG and provided **no fallback** — a screen reader user got nothing from this panel. This port keeps the visual (it's a legitimate, well-liked chart type) but adds what was missing: a visually-hidden data table carrying the same numbers, and per-segment `aria-label`s so the legend rows (which were already plain text, not `aria-hidden`) stay exactly as accessible as they were.

**Files:**
- Create: `app/src/features/analytics/JourneyOutcomesDonut.tsx`
- Test: `app/src/features/analytics/JourneyOutcomesDonut.test.tsx`
- Modify: `app/src/features/analytics/JourneyTab.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// app/src/features/analytics/JourneyOutcomesDonut.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JourneyOutcomesDonut } from './JourneyOutcomesDonut';

const outcomes = [
  { id: 'meeting_booked', label: 'Meeting booked', sessions: 4, share: 0.4, filterable: true },
  { id: 'kept_browsing', label: 'Kept browsing', sessions: 3, share: 0.3, filterable: false },
  { id: 'exit', label: 'Drop-off / Exit', sessions: 3, share: 0.3, filterable: false },
] as const;

describe('JourneyOutcomesDonut', () => {
  it('exposes the same numbers to screen readers as it draws visually', () => {
    render(<JourneyOutcomesDonut outcomes={outcomes as any} total={10} />);
    // The decorative SVG is hidden from the accessibility tree...
    const svg = document.querySelector('svg[aria-hidden="true"]');
    expect(svg).toBeInTheDocument();
    // ...but a real data table carries the same facts for screen readers.
    const table = screen.getByRole('table', { name: /journey outcomes/i });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Meeting booked' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '4' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/features/analytics/JourneyOutcomesDonut.test.tsx`
Expected: FAIL with "Cannot find module './JourneyOutcomesDonut'"

- [ ] **Step 3: Write the component**

Port the donut segment math verbatim from `origin/development:app/src/features/analytics/JourneyOutcomes.tsx` lines 91–108 (`DONUT_ORDER`, `DONUT_VB=160`, `DONUT_R=62`, `DONUT_STROKE=20`, `DONUT_CIRC=2πR`) and lines 284–345 (`useAnimatedProgress` count-up, per-segment `strokeDasharray`/`strokeDashoffset`), fetched via:

```bash
git show a56d05380d72821cb6ad76fd15f73bac1d848e55:app/src/features/analytics/JourneyOutcomes.tsx | sed -n '91,110p;280,350p'
```

`app/src/hooks/useAnimatedProgress.ts` — confirm it still exists on the current branch (`ls app/src/hooks/useAnimatedProgress.ts`); if it does, reuse it unchanged, if not port its ~20 lines from the same SHA.

Structure:

```tsx
export interface JourneyOutcomesDonutProps {
  outcomes: readonly JourneyOutcome[]; // from journeyModel.ts, already built by buildOutcomes()
  total: number;
}

export function JourneyOutcomesDonut({ outcomes, total }: JourneyOutcomesDonutProps) {
  // ...ported donut <svg aria-hidden="true"> unchanged from the SHA above...

  return (
    <div className="flex items-center gap-6">
      <svg aria-hidden="true" viewBox={`0 0 ${DONUT_VB} ${DONUT_VB}`} width={DONUT_PX} height={DONUT_PX}>
        {/* ...ported segments... */}
      </svg>

      {/* Visible legend, same as the original — already accessible as plain text. */}
      <ul className="space-y-1">
        {outcomes.map((o) => (
          <li key={o.id} className="flex items-center gap-2 text-sm">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: TONE_FOR[o.id] }} />
            {o.label}: {o.sessions}
          </li>
        ))}
      </ul>

      {/* New: the accessible alternative the original never had. sr-only
          keeps it out of the visual layout while giving screen readers a
          real table instead of an aria-hidden SVG and nothing else. */}
      <table className="sr-only">
        <caption>Journey outcomes</caption>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col">Sessions</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {outcomes.map((o) => (
            <tr key={o.id}>
              <td>{o.label}</td>
              <td>{o.sessions}</td>
              <td>{Math.round(o.share * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Confirm `sr-only` is a real, already-used utility class in this codebase before relying on it: `grep -rn "sr-only" app/src/ui/ | head -3`. If it isn't defined, use whatever visually-hidden-but-accessible pattern the codebase already uses elsewhere (check `app/src/ui/primitives/VisuallyHidden.tsx` first).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/features/analytics/JourneyOutcomesDonut.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire it into JourneyTab as a sibling panel**

In `JourneyTab.tsx`, add `<JourneyOutcomesDonut outcomes={journey.data.outcomes} total={summary.sessions_with_journey} />` as a new `Card` below the `JourneyPagesPanel`, matching the old `JourneyPage.tsx`'s grid-cols-2 layout (page influence left, outcomes donut right) — `origin/development:app/src/features/analytics/JourneyPage.tsx` lines shown in the Explore report, fetch with `git show a56d05380d72821cb6ad76fd15f73bac1d848e55:app/src/features/analytics/JourneyPage.tsx` if you need the exact grid classes. `journey.data.outcomes` already exists on the current branch's `useJourneyData.ts` return shape (built once via `buildOutcomes()` in `journeyModel.ts`) — no new data fetching needed here.

- [ ] **Step 6: Commit**

```bash
git add app/src/features/analytics/JourneyOutcomesDonut.tsx app/src/features/analytics/JourneyOutcomesDonut.test.tsx app/src/features/analytics/JourneyTab.tsx
git commit -m "feat: add journey outcomes donut with a real accessible alternative"
```

---

## Task 6: Restore the "Journey" sidebar nav entry

Adds the entry back as a **direct link into the existing `/analytics/journey` route** — not a second standalone route/page. `origin/development` had Journey as its own top-level route with its own lazy chunk, which is exactly the "mounts one hook three times, ~30 requests every 15 seconds" and "second lazy chunk that re-exported AnalyticsPage" problem `REBUILD.md:73` and `:149` document fixing. Linking to the tab gets the sidebar visibility back with zero risk of reintroducing that bug.

**Files:**
- Modify: `app/src/shell/nav.ts`
- Test: `app/src/shell/nav.test.ts` (extend existing — read it first for the current assertion pattern)

- [ ] **Step 1: Write the failing test**

```ts
it('lists Journey as a direct sidebar entry pointing at the Analytics tab', () => {
  const journey = WORKSPACE_NAV.find((item) => item.label === 'Journey');
  expect(journey).toBeDefined();
  expect(journey?.to).toBe('/analytics/journey');
});
```

(Match this to the real test file's existing `describe`/`it` structure and import style — read `app/src/shell/nav.test.ts` first rather than assuming this exact shape is how it's organized.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/shell/nav.test.ts`

- [ ] **Step 3: Add the entry**

In `nav.ts`, insert into `WORKSPACE_NAV` in the same position `development` used (between Leads and Analytics — confirmed by the Explore report's citation of `origin/development:app/src/shell/nav.config.ts:30`):

```ts
{ to: '/analytics/journey', label: 'Journey', icon: Compass, hint: 'Visitor journey flow' },
```

`Compass` is already imported from `lucide-react` elsewhere in this codebase (confirmed present in `JourneyPagesPanel.tsx`'s empty state and in the old `JourneyOutcomes.tsx`'s `kept_browsing` icon) — import it from `lucide-react` in `nav.ts` rather than porting the old custom `JourneyIcon.tsx` forwardRef SVG, since a stock icon already in the palette is one less bespoke asset to maintain and the old custom icon added no meaning a stock compass doesn't already carry.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/shell/nav.test.ts`

- [ ] **Step 5: Manually confirm active-state highlighting works from a nested route**

Since `/analytics/journey` is a child path of the `/analytics` route that the sidebar's own "Analytics" entry also points to, both entries can end up visually "active" at once depending on how the sidebar computes its active-match (`end` prop / exact-vs-prefix matching). Read how `WORKSPACE_NAV`'s existing entries handle this (grep `Sidebar.tsx` or wherever `WORKSPACE_NAV` is consumed for `NavLink`/`isActive` logic) and set `end: true` on either entry if needed so only one highlights at a time when the reader is on `/analytics/journey`.

- [ ] **Step 6: Commit**

```bash
git add app/src/shell/nav.ts app/src/shell/nav.test.ts
git commit -m "feat: restore Journey as a direct sidebar entry"
```

---

## Task 7: Update REBUILD.md

The Consolidations table row at `app/REBUILD.md:73` explains why the diagram, pan/zoom and sidebar entry were cut. That reasoning is now obsolete — update it to explain what changed, rather than leaving a stale "did not come back" claim next to code that brought it back.

**Files:**
- Modify: `app/REBUILD.md`

- [ ] **Step 1: Replace the Consolidations table row**

Read the current row (`app/REBUILD.md:73`) and the surrounding table structure first (`sed -n '60,80p' app/REBUILD.md`), then replace only that row's right-hand cell with something in this shape (adjust wording to fit the table's actual column format once read — do not guess the markdown table syntax, copy it from the file):

> The pan/zoom canvas and expand modal came back in `JourneyDiagram.tsx`/`ZoomPanCanvas.tsx`, this time keyboard-reachable: every node is a real `<button>` with an `aria-label`, arrow keys pan, `+`/`-`/`0` zoom, and the canvas is a focusable `role="application"` region — see `ZoomPanCanvas.tsx`'s own docstring for why `application` over `region`/`img`. It ships as a view toggle next to the original accessible list (`JourneyFlow.tsx`, still the default view), not a replacement, so nothing that shipped in the interim regresses. The outcomes donut came back too, with a real screen-reader alternative (a visually-hidden data table) the original never had — its SVG was `aria-hidden="true"` with nothing behind it. `Journey` is back in the sidebar as a direct link to `/analytics/journey`, not a second standalone route, so the "mounts one hook three times, ~30 requests every 15s" problem this table's own note (below) describes does not return.

- [ ] **Step 2: Commit**

```bash
git add app/REBUILD.md
git commit -m "docs: update REBUILD.md consolidation note now the visual diagram is back"
```

---

## Task 8: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Lint**

Run: `cd app && npm run lint`
Expected: clean.

- [ ] **Step 3: Full test suite**

Run: `cd app && npm test`
Expected: all tests pass, including every test file added in Tasks 1–6.

- [ ] **Step 4: Build**

Run: `cd app && npm run build`
Expected: clean build.

- [ ] **Step 5: Manual browser check**

Start the dev server, log in, navigate to `/analytics/journey`. Confirm: the "Journey" sidebar entry is present and navigates here; the List/Diagram toggle switches views without a network refetch (check the Network tab — no new request on toggle); in Diagram view, Tab reaches every visible node, Enter/Space activates one and it visually highlights; the Expand button opens a fullscreen dialog with working keyboard pan (arrow keys) and zoom (`+`/`-`/`0`), and Escape closes it; the outcomes donut renders with its legend, and running the page through a screen reader (or just inspecting the accessibility tree in devtools) shows the hidden data table's rows.

- [ ] **Step 6: Self-review against this plan**

Confirm every checkbox above is checked, then diff the final state against Task 7's REBUILD.md wording to make sure the shipped behavior actually matches what the doc now claims — don't leave the doc describing something the code doesn't do.
