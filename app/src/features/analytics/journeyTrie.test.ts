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
