import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  ThemeContext,
  type EventOrOrigin,
  type ResolvedTheme,
  type Theme,
} from './theme-context';

const STORAGE_KEY = 'oc_theme';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

function readStoredTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'system';
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

// The OS color-scheme preference as an external store, so `resolvedTheme` can
// be derived during render (no setState-in-effect) and still react to changes.
function subscribeSystem(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(MEDIA_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getSystemSnapshot(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

function getServerSnapshot(): ResolvedTheme {
  return 'light';
}

function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

function extractOrigin(eventOrOrigin?: EventOrOrigin): { x: number; y: number } {
  if (!eventOrOrigin) {
    // Default to top-right corner near the topbar theme toggle button
    return {
      x: typeof window !== 'undefined' ? Math.max(window.innerWidth - 80, 0) : 0,
      y: 32,
    };
  }
  if ('clientX' in eventOrOrigin) {
    return { x: eventOrOrigin.clientX, y: eventOrOrigin.clientY };
  }
  return eventOrOrigin;
}

/**
 * Theme Provider - light / dark / system with the `.dark` class strategy.
 * Includes a smooth top-right circular clip-path transition via View Transitions API
 * without folding or moving any DOM page elements.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const systemTheme = useSyncExternalStore(subscribeSystem, getSystemSnapshot, getServerSnapshot);
  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback(
    (next: Theme, eventOrOrigin?: EventOrOrigin) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, next);

      const nextResolved: ResolvedTheme = next === 'system' ? systemTheme : next;
      const origin = extractOrigin(eventOrOrigin);

      const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const isSupported =
        typeof document !== 'undefined' &&
        'startViewTransition' in document &&
        !prefersReducedMotion;

      if (!isSupported || nextResolved === resolvedTheme) {
        setThemeState(next);
        applyTheme(nextResolved);
        return;
      }

      const { x, y } = origin;
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );

      const doc = document as Document & {
        startViewTransition?: (cb: () => void) => { ready: Promise<void> };
      };

      if (doc.startViewTransition) {
        const transition = doc.startViewTransition(() => {
          setThemeState(next);
          applyTheme(nextResolved);
        });

        transition.ready.then(
          () => {
            document.documentElement.animate(
              {
                clipPath: [
                  `circle(0px at ${x}px ${y}px)`,
                  `circle(${endRadius}px at ${x}px ${y}px)`,
                ],
              },
              {
                duration: 900,
                easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
                pseudoElement: '::view-transition-new(root)',
              }
            );
          },
          () => {
            // `ready` REJECTS when a transition is skipped - which is what a
            // second toggle during the 900ms sweep does. The theme itself has
            // already been applied inside the callback above, so there is
            // nothing to recover: swallow it rather than raise an unhandled
            // rejection into Sentry on every rapid double-click.
          }
        );
      } else {
        setThemeState(next);
        applyTheme(nextResolved);
      }
    },
    [resolvedTheme, systemTheme],
  );

  const toggle = useCallback(
    (eventOrOrigin?: EventOrOrigin) => {
      setTheme(resolvedTheme === 'dark' ? 'light' : 'dark', eventOrOrigin);
    },
    [resolvedTheme, setTheme],
  );

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggle }),
    [theme, resolvedTheme, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
