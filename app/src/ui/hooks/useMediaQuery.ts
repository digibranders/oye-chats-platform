import { useCallback, useSyncExternalStore } from 'react';

/**
 * A CSS breakpoint, read in React.
 *
 * `useSyncExternalStore` over `matchMedia`, which is what a media query actually
 * is: an external store React does not own. The obvious alternative — state plus
 * an effect that re-syncs on subscribe — renders once with a stale answer and
 * then again with the right one, which on this surface means painting a
 * three-pane console on a phone for one frame.
 *
 * Use it only for structural decisions CSS genuinely cannot make: whether a
 * panel is a column or a drawer, for instance. Anything purely visual belongs in
 * a Tailwind breakpoint, which needs no JavaScript at all.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);
      return () => list.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  // Server snapshot: assume the query does not match, so the layout a
  // no-JavaScript render produces is the simpler one.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
