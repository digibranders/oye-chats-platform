import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom implements no layout, so it has no `scrollIntoView`. Any listbox that
// keeps its highlighted option in view calls it on mount, which would throw
// before a single assertion ran.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => {};
}

afterEach(() => {
  cleanup();
});

/**
 * jsdom implements no `ResizeObserver`, and Recharts' `ResponsiveContainer`
 * constructs one on mount — so *any* test that renders a chart threw, and every
 * surface with one was stubbing it locally, or quietly not testing its charts.
 * It belongs here, once: a browser API the environment is missing is setup, not
 * a per-suite concern.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
