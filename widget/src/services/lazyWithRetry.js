import { lazy } from 'react';

/**
 * Retry an async thunk with linear backoff. Exported for tests; the React-facing
 * wrapper is lazyWithRetry below.
 *
 * @param {() => Promise<T>} thunk
 * @param {{ retries?: number, delayMs?: number, sleep?: (ms:number)=>Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function retryImport(thunk, { retries = 2, delayMs = 400, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await thunk();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        // Linear backoff: 400ms, 800ms. Short enough that a visitor who just
        // clicked "talk to a human" isn't left staring, long enough to ride
        // out a momentary network/CDN blip.
        await wait(delayMs * (attempt + 1));
      }
    }
  }
  throw lastError;
}

/**
 * React.lazy with automatic retry on transient dynamic-import failures.
 *
 * A dynamic import() rejects with "Failed to fetch dynamically imported module"
 * when a chunk momentarily fails to load, a CDN blip, a brief cache race right
 * after a deploy, or a flaky visitor network. A single failure is enough for
 * React.lazy to surface the rejection to the nearest error boundary, so without
 * a retry a one-off hiccup permanently breaks the lazy subtree for that session.
 *
 * Retrying a few times with backoff self-heals the common transient case. A
 * genuinely missing chunk (e.g. a partial deploy that never uploaded the file)
 * still rejects after the final attempt. That case is caught by the surrounding
 * <ErrorBoundary>, which degrades gracefully instead of unmounting the widget.
 *
 * @param {() => Promise<{ default: React.ComponentType }>} factory dynamic import thunk
 * @param {{ retries?: number, delayMs?: number }} [opts]
 */
export function lazyWithRetry(factory, opts = {}) {
  return lazy(() => retryImport(factory, opts));
}
