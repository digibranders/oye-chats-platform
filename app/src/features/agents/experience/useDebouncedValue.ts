import { useEffect, useState } from 'react';

/**
 * A value that lags behind by `delay`, plus whether it is currently behind.
 *
 * The preview is the point of this page, so it has to move while the user
 * types — but re-rendering a full widget mock on every keystroke of a
 * thousand-character system prompt is felt on a mid-range laptop. Debouncing is
 * the fix; the second return value is what stops the debounce becoming a
 * quieter version of the bug it fixes. A preview that is 200ms behind and
 * labelled "live" is a preview that is sometimes wrong with no way to tell, so
 * the panel reads `settled` and says "updating" until it has caught up.
 */
export function useDebouncedValue<T>(value: T, delay = 200): { value: T; settled: boolean } {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (Object.is(debounced, value)) return undefined;
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay, debounced]);

  return { value: debounced, settled: Object.is(debounced, value) };
}
