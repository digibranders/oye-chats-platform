import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
