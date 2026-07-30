import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ThemeContext, type ResolvedTheme, type Theme } from './theme-context';

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

/**
 * Theme Provider - light / dark / system with the `.dark` class strategy.
 * `resolvedTheme` is derived from the chosen preference and the OS store, and
 * synced to the document in a single effect (an external-system write, not a
 * state update).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const systemTheme = useSyncExternalStore(subscribeSystem, getSystemSnapshot, getServerSnapshot);
  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme;

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggle }),
    [theme, resolvedTheme, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
